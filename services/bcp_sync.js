// services/bcp_sync.js — Guarda la lluvia diaria de TODAS las estaciones activas
// de la Bolsa de Cereales de Bahía Blanca en la base global (doc
// "bcp_dia_<sitio>_<fecha>"). services/lluvia_lote.js la usa para cualquier
// lote a ≤ 15 km, sin que nadie tenga que "seguir" la estación.
//
// La página solo trae la lluvia "del día" (parcial) y acumulados. Dos pasos:
//  · parcial: la lluvia de hoy se va actualizando en cada corrida (se queda con el máximo).
//  · cierre: cuando el acumulado mensual avanza un día, la diferencia contra el
//    snapshot anterior es la lluvia exacta del día cerrado (incluye lo que llovió
//    después de la última consulta). El cierre pisa al parcial y queda fijo.
// Los días en 0 también se guardan: una estación que midió 0 le gana al modelo.
"use strict";

const db  = require("./couchdb");
const bcp = require("./bcp");

const ESTADO_ID = "bcp_estado";

function diaAnterior(fecha) {
  const d = new Date(fecha + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function leerEstado() {
  try { return await db.getDB("global").get(ESTADO_ID); }
  catch (e) {
    if (e.statusCode === 404) return { _id: ESTADO_ID, tipo: "bcp_estado", snap: {} };
    throw e;
  }
}

// Avanza el snapshot mensual de cada estación. Devuelve el estado nuevo y los
// cierres de esta corrida: [{ sitio, fecha, mm }].
function calcularCierres(estado, lista) {
  const snap    = { ...(estado.snap || {}) };
  const cierres = [];
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

    if (mm != null && mm > -0.05) cierres.push({ sitio: e.sitio, fecha: cur.mes_hasta, mm: Math.max(0, Math.round(mm * 10) / 10) });
    else if (mm != null) console.warn(`[BCP] ${e.nombre}: el acumulado mensual bajó (${prev.mes_mm} → ${cur.mes_mm}), sin cierre`);
    snap[e.sitio] = cur;
  }
  return { estado: { ...estado, snap, updated_at: Date.now() }, cierres };
}

// Parciales de hoy: solo estaciones que reportaron hoy o ayer (una estación
// colgada no debe seguir escribiendo su último "del día").
function parciales(lista, hoy) {
  return lista
    .filter(e => e.activa && e.pp_dia != null && e.ult_fecha && e.ult_fecha >= diaAnterior(hoy))
    .map(e => ({ sitio: e.sitio, fecha: e.ult_fecha, mm: e.pp_dia }));
}

async function sincronizar() {
  const lista = await bcp.estaciones({ fresco: true });
  const hoy   = bcp.hoyArgentina();
  const gdb   = db.getDB("global");

  const { estado, cierres } = calcularCierres(await leerEstado(), lista);
  const plan = [
    ...cierres.map(c => ({ ...c, cerrado: true })),
    ...parciales(lista, hoy).filter(p => !cierres.some(c => c.sitio === p.sitio && c.fecha === p.fecha)).map(p => ({ ...p, cerrado: false })),
  ];
  const idDe = (p) => `bcp_dia_${p.sitio}_${p.fecha}`;
  const nombre = Object.fromEntries(lista.map(e => [e.sitio, e.nombre]));

  const existentes = {};
  if (plan.length) {
    const f = await gdb.fetch({ keys: plan.map(idDe) });
    f.rows.forEach(r => { if (r.doc) existentes[r.id] = r.doc; });
  }

  const now  = Date.now();
  const docs = [];
  for (const p of plan) {
    const ex = existentes[idDe(p)];
    if (p.cerrado) {
      if (ex?.cerrado && ex.mm === p.mm) continue;
    } else if (ex && (ex.cerrado || ex.mm >= p.mm)) continue;
    docs.push({
      _id: idDe(p), ...(ex ? { _rev: ex._rev } : {}),
      tipo: "bcp_dia", sitio: p.sitio, estacion: nombre[p.sitio] || null,
      fecha: p.fecha, mm: Math.round(p.mm * 10) / 10, cerrado: p.cerrado, updated_at: now,
    });
  }
  if (docs.length) await gdb.bulk({ docs });
  await gdb.insert(estado);
  if (docs.length) console.log(`[BCP] ✓ ${docs.length} días de estaciones actualizados (${cierres.length} cierres)`);
  return docs.length;
}

module.exports = { sincronizar, calcularCierres, parciales };
