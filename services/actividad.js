"use strict";
// actividad.js — Resumen de la operación para el Inicio (panel y app). Toma
// los archivos de cobertura de PilotX (calcularStats), equipos, lluvias y
// alertas de la org, y arma un objeto liviano. Parsear coberturas es caro:
// cache en memoria 5 min por org+temporada.
const db = require("./couchdb");
const { calcularStatsAsync, statsVigentes, parseKML, contornoM2 } = require("./aog_parser");
const { temporadaActual, rangoTemporada, esTemporadaValida } = require("./temporada");
const TZ = "America/Argentina/Buenos_Aires";
const CACHE_MS = 5 * 60 * 1000, ONLINE_MS = 2 * 60 * 1000;
const CACHE_MAX = 200;
const _cache = new Map();

// Tope 200 entradas: al superarlo se borran primero las vencidas y, si sigue
// lleno, la más vieja.
function limpiarCache() {
  if (_cache.size <= CACHE_MAX) return;
  const ahora = Date.now();
  for (const [k, v] of _cache) if (ahora - v.ts >= CACHE_MS) _cache.delete(k);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

function mesAR(ts) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date(ts)); }
const r1 = (n) => Math.round(n * 10) / 10;

function armarResumen({ temporada, rango, coberturas = [], devices = [], lluvias = [], alertas = [], ahora = Date.now() }) {
  const enRango = coberturas.filter(c => c.ts >= rango.desdeMs && c.ts <= rango.hastaMs && c.stats);
  const porLote = new Map();
  for (const c of enRango) { const prev = porLote.get(c.lote_nombre); if (!prev || c.ts > prev.ts) porLote.set(c.lote_nombre, c); }
  let trab = 0, neto = 0;
  for (const c of porLote.values()) { trab += c.stats.trabajado_ha || 0; neto += c.stats.neto_ha || 0; }
  const online = devices.filter(d => d.ultimo_visto && ahora - d.ultimo_visto < ONLINE_MS);
  const sinReportar = devices.filter(d => d.ultimo_visto && ahora - d.ultimo_visto >= ONLINE_MS)
    .map(d => ({ hostname: d.hostname || d.device_id, hace_min: Math.round((ahora - d.ultimo_visto) / 60000) }))
    .sort((a, b) => a.hace_min - b.hace_min);
  const mes = mesAR(ahora);
  const lluviasRango = lluvias.filter(l => l.fecha >= rango.desde && l.fecha <= rango.hasta);
  const ultimaLluvia = [...lluvias].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))[0] || null;
  const ultimos = [
    ...[...porLote.values()].map(c => ({ ts: c.ts, tipo: "lote", lote: c.lote_nombre, texto: `${c.lote_nombre}: ${r1(c.stats.trabajado_ha || 0)} ha trabajadas` })),
    ...lluvias.map(l => ({ ts: Date.parse(l.fecha + "T12:00:00-03:00"), tipo: "lluvia", lote: l.lote || null, texto: `${l.mm} mm${l.lote ? " en " + l.lote : ""}` })),
    ...alertas.map(a => ({ ts: a.ts_inicio || 0, tipo: "alerta", texto: a.mensaje || "Alerta" })),
    ...online.map(d => ({ ts: d.ultimo_visto, tipo: "equipo", texto: `${d.hostname || d.device_id} en línea` })),
  ].filter(e => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts).slice(0, 12);
  return {
    temporada, rango: { desde: rango.desde, hasta: rango.hasta },
    hectareas: { trabajadas: r1(trab), netas: r1(neto), repintado_pct: trab > 0 ? r1((trab - neto) / trab * 100) : 0, lotes: porLote.size },
    equipos: { total: devices.length, online: online.length, sin_reportar: sinReportar.slice(0, 5) },
    lluvia: { mes_mm: r1(lluvias.filter(l => (l.fecha || "").startsWith(mes)).reduce((s, l) => s + (Number(l.mm) || 0), 0)),
              temporada_mm: r1(lluviasRango.reduce((s, l) => s + (Number(l.mm) || 0), 0)),
              ultima: ultimaLluvia ? { fecha: ultimaLluvia.fecha, mm: ultimaLluvia.mm, lote: ultimaLluvia.lote || null } : null },
    alertas_activas: alertas.filter(a => !a.resuelta).length,
    ultimos, generado: ahora, cache: false,
  };
}

// Tope de docs que se reparsean en vivo cuando todavía no tienen stats. Sin
// tope, una org sin migrar reproduce el problema original (22,8 MB y ~2 s de
// CPU por request); con tope, el Inicio nunca queda en blanco y el resto se
// completa solo en la cola.
// Tope chico: cada doc son segundos de CPU (troceados con setImmediate, no bloquean, pero alargan el request).
const MAX_FALLBACK = 3;

// Pura: divide los docs entre los que tienen stats confiables y los que no.
function separarPorStats(docs) {
  const listos = [], faltan = [];
  for (const d of docs || []) (statsVigentes(d) ? listos : faltan).push(d);
  return { listos, faltan };
}

// El contorno del lote no sale del Sections.txt: sale del boundary. Se pide
// aparte y solo el KML (WGS84 directo, no necesita el origen del lote). Son
// unos pocos KB por lote. Antes se pasaba boundary=null y contorno_ha era
// siempre 0 en el Inicio y en el Reporte de temporada.
// Los boundary KML casi nunca cambian (un lote se dibuja una vez), pero cada
// request del Inicio y del Reporte se bajaba los 2.000 y los reparseaba. Cache
// por org, 30 min, con tope de entradas como el resto. La firma la da un find
// barato de solo _id/ts: si no cambió ni la cantidad ni el `ts` más nuevo, el
// contenido tampoco cambió y no se baja un byte de KML.
const CONTORNOS_MS = 30 * 60 * 1000;
const CONTORNOS_MAX = 200;
const _contornos = new Map();   // slug -> { ts, firma, mapa }

// Pura: "<cantidad>:<ts máximo>". Un alta, una baja o una edición mueven al
// menos uno de los dos. Sirve para invalidar sin releer los contenidos.
function firmaContornos(docs) {
  let max = 0;
  for (const d of docs || []) { const t = Number(d?.ts) || 0; if (t > max) max = t; }
  return `${(docs || []).length}:${max}`;
}

function limpiarCacheContornos(ahora = Date.now()) {
  if (_contornos.size <= CONTORNOS_MAX) return;
  for (const [k, v] of _contornos) if (ahora - v.ts >= CONTORNOS_MS) _contornos.delete(k);
  while (_contornos.size > CONTORNOS_MAX) _contornos.delete(_contornos.keys().next().value);
}

// Devuelve el mapa cacheado si la entrada está fresca Y la firma coincide.
function contornosCacheGet(slug, firma, ahora = Date.now()) {
  const hit = _contornos.get(slug);
  if (!hit) return null;
  if (ahora - hit.ts >= CONTORNOS_MS) { _contornos.delete(slug); return null; }
  if (hit.firma !== firma) return null;
  return hit.mapa;
}

function contornosCacheSet(slug, firma, mapa, ahora = Date.now()) {
  _contornos.set(slug, { ts: ahora, firma, mapa });
  limpiarCacheContornos(ahora);
}

async function cargarContornos(estabDB, slug = null) {
  const porLote = new Map();
  try {
    // Sin slug (llamada suelta) no hay clave de cache: se hace derecho el
    // camino largo, como antes.
    let firma = null;
    if (slug) {
      const meta = await estabDB.find({
        selector: { tipo: "aog_archivo", es_lote: true, subtipo: "boundary_kml" },
        fields: ["_id", "ts"],
        limit: 2000,
      });
      firma = firmaContornos(meta.docs || []);
      const cacheado = contornosCacheGet(slug, firma);
      if (cacheado) return cacheado;
    }

    const r = await estabDB.find({
      selector: { tipo: "aog_archivo", es_lote: true, subtipo: "boundary_kml" },
      fields: ["lote_nombre", "contenido"],
      limit: 2000,
    });
    for (const d of r.docs || []) {
      const ring = parseKML(d.contenido);
      if (ring && d.lote_nombre) porLote.set(d.lote_nombre, Math.round(contornoM2(ring) / 100) / 100);
    }
    if (slug && firma !== null) contornosCacheSet(slug, firma, porLote);
  } catch (e) {
    console.warn("[actividad] contornos:", e.message);
  }
  return porLote;
}

async function cargarCoberturas(estabDB, slug = null) {
  // Solo metadata + stats: sin `contenido`. Índice ["tipo","subtipo","es_lote"].
  const r = await estabDB.find({
    selector: { tipo: "aog_archivo", es_lote: true, subtipo: "sections_coverage" },
    fields: ["_id", "lote_nombre", "ts", "ts_trabajo", "stats", "stats_ver", "stats_hash", "hash_md5"],
    limit: 2000,
  });
  const { listos, faltan } = separarPorStats(r.docs || []);
  const contornos = await cargarContornos(estabDB, slug);
  const conContorno = (nombre, stats) => ({ ...stats, contorno_ha: contornos.get(nombre) ?? 0 });

  const out = listos.map(d => ({
    lote_nombre: d.lote_nombre,
    ts: d.ts_trabajo || d.ts || 0,
    stats: conContorno(d.lote_nombre, d.stats),
  }));

  // Fallback acotado: bajar el contenido SOLO de unos pocos y calcular en vivo.
  for (const d of faltan.slice(0, MAX_FALLBACK)) {
    try {
      const full = await estabDB.get(d._id);
      const st = await calcularStatsAsync(full.contenido || "", null); // troceado: no bloquea el event loop
      if (st) out.push({ lote_nombre: full.lote_nombre, ts: full.ts || 0, stats: conContorno(full.lote_nombre, st) });
    } catch (e) {
      console.warn("[actividad] fallback stats:", d._id, e.message);
    }
  }

  // El resto se calcula en la cola y queda listo para la próxima.
  if (slug && faltan.length) {
    try {
      const { encolarStats } = require("./cobertura_stats");
      for (const d of faltan) encolarStats(slug, d._id);
    } catch (e) { console.warn("[actividad] encolarStats:", e.message); }
  }
  return out;
}

async function resumenActividad(slug, { temporada } = {}) {
  const temp = esTemporadaValida(temporada) ? temporada : temporadaActual();
  const key = `${slug}::${temp}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return { ...hit.data, cache: true };
  const estabDB = db.getDB(slug), globalDB = db.getDB("global");
  const [coberturas, devs, lluv, alertas] = await Promise.all([
    cargarCoberturas(estabDB, slug),
    globalDB.find({ selector: { tipo: "device", estab_slug: slug }, fields: ["device_id", "hostname", "ultimo_visto"], limit: 500 }).then(r => r.docs).catch(e => { console.warn("[actividad] consulta secundaria falló:", e.message); return []; }),
    estabDB.find({ selector: { tipo: "lluvia_registro" }, fields: ["fecha", "mm", "lote"], limit: 2000 }).then(r => r.docs).catch(e => { console.warn("[actividad] consulta secundaria falló:", e.message); return []; }),
    db.getAlertasActivas(slug).catch(e => { console.warn("[actividad] consulta secundaria falló:", e.message); return []; }),
  ]);
  const data = armarResumen({ temporada: temp, rango: rangoTemporada(temp), coberturas, devices: devs, lluvias: lluv, alertas });
  _cache.set(key, { ts: Date.now(), data });
  limpiarCache();
  return data;
}

module.exports = {
  armarResumen, resumenActividad, cargarCoberturas, separarPorStats, ONLINE_MS,
  // Expuestas para los tests puros del cache de contornos (sin CouchDB).
  firmaContornos, contornosCacheGet, contornosCacheSet, CONTORNOS_MS, CONTORNOS_MAX,
};
