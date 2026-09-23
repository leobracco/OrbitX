"use strict";
// actividad.js — Resumen de la operación para el Inicio (panel y app). Toma
// los archivos de cobertura de PilotX (calcularStats), equipos, lluvias y
// alertas de la org, y arma un objeto liviano. Parsear coberturas es caro:
// cache en memoria 5 min por org+temporada.
const db = require("./couchdb");
const { calcularStats } = require("./aog_parser");
const { temporadaActual, rangoTemporada, esTemporadaValida } = require("./temporada");
const TZ = "America/Argentina/Buenos_Aires";
const CACHE_MS = 5 * 60 * 1000, ONLINE_MS = 2 * 60 * 1000;
const _cache = new Map();

function mesAR(ts) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date(ts)); }
const r1 = (n) => Math.round(n * 10) / 10;

function armarResumen({ temporada, rango, coberturas = [], maestros = [], devices = [], lluvias = [], alertas = [], ahora = Date.now() }) {
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

async function cargarCoberturas(estabDB) {
  // Solo los archivos de cobertura (uno por lote): contenido + ts. Índice ["tipo","es_lote","lote_nombre"].
  const r = await estabDB.find({ selector: { tipo: "aog_archivo", es_lote: true, subtipo: "sections_coverage" }, limit: 2000 });
  return (r.docs || []).map(d => ({ lote_nombre: d.lote_nombre, ts: d.ts || 0, stats: d.contenido ? calcularStats(d.contenido, null) : null }));
}

async function resumenActividad(slug, { temporada } = {}) {
  const temp = esTemporadaValida(temporada) ? temporada : temporadaActual();
  const key = `${slug}::${temp}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return { ...hit.data, cache: true };
  const estabDB = db.getDB(slug), globalDB = db.getDB("global");
  const [coberturas, maestros, devs, lluv, alertas] = await Promise.all([
    cargarCoberturas(estabDB),
    estabDB.find({ selector: { tipo: "lote_maestro" }, fields: ["nombre", "cultivo", "temporada"], limit: 2000 }).then(r => r.docs).catch(() => []),
    globalDB.find({ selector: { tipo: "device", estab_slug: slug }, fields: ["device_id", "hostname", "ultimo_visto"], limit: 500 }).then(r => r.docs).catch(() => []),
    estabDB.find({ selector: { tipo: "lluvia_registro" }, fields: ["fecha", "mm", "lote"], limit: 2000 }).then(r => r.docs).catch(() => []),
    db.getAlertasActivas(slug).catch(() => []),
  ]);
  const data = armarResumen({ temporada: temp, rango: rangoTemporada(temp), coberturas, maestros, devices: devs, lluvias: lluv, alertas });
  _cache.set(key, { ts: Date.now(), data });
  return data;
}

module.exports = { armarResumen, resumenActividad, ONLINE_MS };
