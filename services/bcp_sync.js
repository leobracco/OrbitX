// services/bcp_sync.js — Guarda como lluvia_registro la lluvia de las estaciones
// BCP que sigue cada org (doc "bcp_config" en la base de la org).
//
// La página solo trae la lluvia "del día" (parcial) y acumulados. Dos pasos:
//  · parcial: la lluvia de hoy se va actualizando en cada corrida (se queda con el máximo).
//  · cierre: cuando el acumulado mensual avanza un día, la diferencia contra el
//    snapshot anterior es la lluvia exacta del día cerrado (incluye lo que llovió
//    después de la última consulta). El cierre pisa al parcial y queda fijo.
// El snapshot y los últimos cierres viven en el doc global "bcp_estado", así una
// org que se suscribe hoy también recibe el cierre de ayer.
const db  = require("./couchdb");
const bcp = require("./bcp");

const ESTADO_ID = "bcp_estado";
const CONFIG_ID = "bcp_config";

function diaAnterior(fecha) {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function slugLote(lote) {
  return lote ? "_" + lote.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "";
}

async function leerEstado() {
  try { return await db.getDB("global").get(ESTADO_ID); }
  catch (e) {
    if (e.statusCode === 404) return { _id: ESTADO_ID, tipo: "bcp_estado", snap: {}, cierres: {} };
    throw e;
  }
}

// Avanza el snapshot mensual de cada estación y devuelve el estado actualizado.
function calcularCierres(estado, lista) {
  const snap    = { ...(estado.snap || {}) };
  const cierres = { ...(estado.cierres || {}) };
  for (const e of lista) {
    if (!e.activa || e.pp_mes == null || !e.pp_mes_hasta) continue;
    // Solo si la estación reportó después del día cerrado (si no, el acumulado está incompleto).
    if (!e.ult_fecha || e.ult_fecha <= e.pp_mes_hasta) continue;

    const prev = snap[e.sitio];
    const cur  = { mes_hasta: e.pp_mes_hasta, mes_mm: e.pp_mes };
    if (prev && prev.mes_hasta === cur.mes_hasta) continue;

    let mm = null;
    if (cur.mes_hasta.endsWith("-01")) mm = cur.mes_mm;
    else if (prev && prev.mes_hasta === diaAnterior(cur.mes_hasta)) mm = cur.mes_mm - prev.mes_mm;

    if (mm != null && mm > -0.05) cierres[e.sitio] = { fecha: cur.mes_hasta, mm: Math.max(0, Math.round(mm * 10) / 10) };
    else if (mm != null) console.warn(`[BCP] ${e.nombre}: el acumulado mensual bajó (${prev.mes_mm} → ${cur.mes_mm}), sin cierre`);
    snap[e.sitio] = cur;
  }
  return { ...estado, snap, cierres, updated_at: Date.now() };
}

// Registros a escribir para una estación: el cierre (si hay) + el parcial de hoy.
function registrosDe(e, cierre, hoy) {
  const out = [];
  if (cierre) out.push({ fecha: cierre.fecha, mm: cierre.mm, cerrado: true });
  // Parcial solo si el dato es de hoy o de ayer (una estación colgada no debe
  // seguir escribiendo su último "del día" para siempre).
  if (e.pp_dia > 0 && e.ult_fecha && e.ult_fecha >= diaAnterior(hoy) &&
      !(cierre && cierre.fecha === e.ult_fecha))
    out.push({ fecha: e.ult_fecha, mm: e.pp_dia, cerrado: false });
  return out;
}

async function aplicarOrg(slug, porSitio, cierres, hoy) {
  const edb = db.getDB(slug);
  let cfg;
  try { cfg = await edb.get(CONFIG_ID); }
  catch (e) { if (e.statusCode === 404) return 0; throw e; }

  const plan = [];
  for (const sub of cfg.estaciones || []) {
    const e = porSitio[sub.sitio];
    if (!e) continue;
    for (const r of registrosDe(e, cierres[sub.sitio], hoy)) {
      plan.push({ ...r, sub, e, _id: `lluvia_bcp_${sub.sitio}${slugLote(sub.lote)}_${r.fecha}` });
    }
  }
  if (!plan.length) return 0;

  const existentes = {};
  const f = await edb.fetch({ keys: plan.map(p => p._id) });
  f.rows.forEach(r => { if (r.doc) existentes[r.id] = r.doc; });

  const now  = Date.now();
  const docs = [];
  for (const p of plan) {
    const ex = existentes[p._id];
    if (p.cerrado) {
      if (ex && ex.cerrado && ex.mm === p.mm) continue;
      if (p.mm === 0) {
        // Día cerrado sin lluvia: si había un parcial > 0, se borra.
        if (ex) docs.push({ _id: ex._id, _rev: ex._rev, _deleted: true });
        continue;
      }
    } else {
      if (ex && (ex.cerrado || ex.mm >= p.mm)) continue;
    }
    docs.push({
      _id:          p._id,
      ...(ex ? { _rev: ex._rev } : {}),
      tipo:         "lluvia_registro",
      fecha:        p.fecha,
      mm:           Math.round(p.mm * 10) / 10,
      lote:         p.sub.lote || null,
      nota:         `BCP · ${p.e.nombre}${p.cerrado ? "" : " (parcial)"}`,
      fuente:       "bcp",
      bcp_sitio:    p.sub.sitio,
      bcp_estacion: p.e.nombre,
      cerrado:      p.cerrado,
      ts:           new Date(p.fecha).getTime() || now,
      updated_at:   now,
    });
  }
  if (!docs.length) return 0;
  const r = await edb.bulk({ docs });
  return r.filter(x => x.ok).length;
}

// Corrida completa (cron): una descarga, avanza cierres y aplica a todas las orgs.
async function sincronizar() {
  const lista  = await bcp.estaciones({ fresco: true });
  const hoy    = bcp.hoyArgentina();
  const gdb    = db.getDB("global");
  const estado = calcularCierres(await leerEstado(), lista);
  await gdb.insert(estado);

  const porSitio = Object.fromEntries(lista.map(e => [e.sitio, e]));
  let total = 0;
  for (const o of await db.getEstablecimientos()) {
    try { total += await aplicarOrg(o.slug, porSitio, estado.cierres, hoy); }
    catch (err) { console.warn(`[BCP] ${o.slug}:`, err.message); }
  }
  if (total) console.log(`[BCP] ✓ ${total} registros de lluvia actualizados`);
  return total;
}

// Solo una org (al suscribirse): usa los cierres ya calculados, no avanza el snapshot.
async function sincronizarOrg(slug) {
  const lista  = await bcp.estaciones();
  const estado = await leerEstado();
  const porSitio = Object.fromEntries(lista.map(e => [e.sitio, e]));
  return aplicarOrg(slug, porSitio, estado.cierres || {}, bcp.hoyArgentina());
}

async function leerConfig(slug) {
  try { return await db.getDB(slug).get(CONFIG_ID); }
  catch (e) {
    if (e.statusCode === 404) return { _id: CONFIG_ID, tipo: "bcp_config", estaciones: [] };
    throw e;
  }
}

async function guardarConfig(slug, cfg) {
  return db.getDB(slug).insert({ ...cfg, updated_at: Date.now() });
}

module.exports = { sincronizar, sincronizarOrg, leerConfig, guardarConfig, calcularCierres, registrosDe };
