"use strict";
// reportes.js — Reporte de temporada por establecimiento: hectáreas trabajadas
// por lote (última cobertura del rango), lluvia acumulada y totales. Une
// lote_maestro (catálogo/planificado) con las coberturas reales de PilotX.
const db = require("./couchdb");
const { rangoTemporada, temporadaActual, esTemporadaValida } = require("./temporada");
const { cargarCoberturas } = require("./actividad");

const r1 = (n) => Math.round(n * 10) / 10;

// Cache en memoria 5 min por slug::temporada, mismo patrón que resumenActividad
// en actividad.js. Tope 200 entradas: al superarlo se borran primero las
// vencidas y, si sigue lleno, la más vieja.
const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const _cache = new Map();

function limpiarCache() {
  if (_cache.size <= CACHE_MAX) return;
  const ahora = Date.now();
  for (const [k, v] of _cache) if (ahora - v.ts >= CACHE_MS) _cache.delete(k);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

// agregarTemporada — pura: no toca CouchDB. Recibe los datos ya cargados y
// arma el reporte por lote + totales.
function agregarTemporada({ temporada, rango, maestros = [], coberturas = [], lluvias = [] }) {
  // Una cobertura por lote dentro del rango: gana el ts más nuevo.
  const enRango = coberturas.filter(c => c.ts >= rango.desdeMs && c.ts <= rango.hastaMs && c.stats);
  const porLote = new Map();
  for (const c of enRango) {
    const prev = porLote.get(c.lote_nombre);
    if (!prev || c.ts > prev.ts) porLote.set(c.lote_nombre, c);
  }

  const lluviaPorLote = (nombre) =>
    r1(lluvias
      .filter(l => l.lote === nombre && l.fecha >= rango.desde && l.fecha <= rango.hasta)
      .reduce((s, l) => s + (Number(l.mm) || 0), 0));

  const nombres = new Set([...maestros.map(m => m.nombre), ...porLote.keys()]);

  const lotes = [...nombres].map((nombre) => {
    const maestro = maestros.find(m => m.nombre === nombre) || null;
    const cobertura = porLote.get(nombre) || null;
    const stats = cobertura?.stats || null;
    return {
      nombre,
      cultivo: maestro?.cultivo ?? null,
      temporada: maestro?.temporada ?? null,
      ha_estimadas: maestro?.ha_estimadas ?? null,
      trabajado_ha: stats ? r1(stats.trabajado_ha || 0) : null,
      neto_ha: stats ? r1(stats.neto_ha || 0) : null,
      repintado_ha: stats ? r1(stats.repintado_ha || 0) : null,
      repintado_pct: stats ? r1(stats.repintado_pct || 0) : null,
      contorno_ha: stats && stats.contorno_ha ? r1(stats.contorno_ha) : null,
      bloques: stats ? stats.bloques || 0 : null,
      ultimo_ts: cobertura ? cobertura.ts : null,
      lluvia_mm: lluviaPorLote(nombre),
    };
  });

  // Orden por trabajado_ha desc; los sin cobertura (null) al final.
  lotes.sort((a, b) => {
    if (a.trabajado_ha == null && b.trabajado_ha == null) return 0;
    if (a.trabajado_ha == null) return 1;
    if (b.trabajado_ha == null) return -1;
    return b.trabajado_ha - a.trabajado_ha;
  });

  const lluviaTotal = lluvias
    .filter(l => l.fecha >= rango.desde && l.fecha <= rango.hasta)
    .reduce((s, l) => s + (Number(l.mm) || 0), 0);

  const totales = {
    lotes: lotes.length,
    trabajado_ha: r1(lotes.reduce((s, l) => s + (l.trabajado_ha || 0), 0)),
    neto_ha: r1(lotes.reduce((s, l) => s + (l.neto_ha || 0), 0)),
    repintado_ha: r1(lotes.reduce((s, l) => s + (l.repintado_ha || 0), 0)),
    lluvia_mm: r1(lluviaTotal),
  };

  return { temporada, rango: { desde: rango.desde, hasta: rango.hasta }, lotes, totales };
}

async function reporteTemporada(slug, temporada) {
  const temp = esTemporadaValida(temporada) ? temporada : temporadaActual();
  const key = `${slug}::${temp}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  const rango = rangoTemporada(temp);
  const estabDB = db.getDB(slug);
  const [maestrosAll, coberturas, lluvias] = await Promise.all([
    estabDB
      .find({ selector: { tipo: "lote_maestro" }, fields: ["nombre", "cultivo", "temporada", "ha_estimadas"], limit: 2000 })
      .then(r => r.docs)
      .catch(e => { console.warn("[reportes] consulta lote_maestro falló:", e.message); return []; }),
    cargarCoberturas(estabDB, slug),
    estabDB
      .find({ selector: { tipo: "lluvia_registro", fecha: { $gte: rango.desde, $lte: rango.hasta } }, fields: ["fecha", "mm", "lote"], limit: 2000 })
      .then(r => r.docs)
      .catch(e => { console.warn("[reportes] consulta lluvia_registro falló:", e.message); return []; }),
  ]);
  const maestros = maestrosAll.filter(m => !m.temporada || m.temporada === temp);
  const data = agregarTemporada({ temporada: temp, rango, maestros, coberturas, lluvias });
  _cache.set(key, { ts: Date.now(), data });
  limpiarCache();
  return data;
}

module.exports = { agregarTemporada, reporteTemporada };
