"use strict";
// cobertura_stats.js — Calcula las stats de un Sections.txt FUERA del camino
// del request y las guarda en el propio doc.
//
// Por qué una cola de concurrencia 1: el droplet es 1 vCPU compartido con ~25
// apps. Rasterizar el peor archivo medido (5,35 MB en el_susto) cuesta ~1 s en
// una notebook y 3-5 s allá; dos en paralelo solo duplican el pico de memoria
// del Uint8Array de la grilla (hasta 40 MB cada uno) sin terminar antes.
const db = require("./couchdb");
const { calcularStatsAsync, statsVigentes, STATS_VER } = require("./aog_parser");

const _cola = [];            // ["slug::docId", ...] en orden de llegada
const _vistos = new Set();   // dedupe: el mismo archivo no entra dos veces
let _corriendo = false;

// Pura: agrega la clave si no estaba. Devuelve true si entró.
function agregarACola(cola, vistos, clave) {
  if (vistos.has(clave)) return false;
  vistos.add(clave);
  cola.push(clave);
  return true;
}

// Pura: las stats guardadas NO llevan contorno_ha. Al momento del sync no hay
// garantía de que el Boundary.txt del mismo lote ya haya llegado (PilotX sube
// archivo por archivo) y el contorno no depende del Sections.txt: lo calcula
// parseLote(), que sí tiene el boundary parseado.
function statsParaDoc(stats) {
  if (!stats) return null;
  const { contorno_ha, ...resto } = stats;
  return resto;
}

function encolarStats(slug, docId) {
  if (!slug || !docId) return false;
  const entro = agregarACola(_cola, _vistos, `${slug}::${docId}`);
  if (entro && !_corriendo) { _corriendo = true; setImmediate(drenar); }
  return entro;
}

async function drenar() {
  while (_cola.length) {
    const clave = _cola.shift();
    _vistos.delete(clave);
    const sep = clave.indexOf("::");
    try { await procesarUno(clave.slice(0, sep), clave.slice(sep + 2)); }
    catch (e) { console.warn("[cobertura_stats]", clave, e.message); }
  }
  _corriendo = false;
}

async function procesarUno(slug, docId) {
  const estabDB = db.getDB(slug);
  const doc = await estabDB.get(docId);
  if (doc.tipo !== "aog_archivo" || doc.subtipo !== "sections_coverage") return;
  // Sin hash_md5 no hay forma de invalidar: no cacheamos y no mentimos.
  if (!doc.hash_md5) return;
  if (statsVigentes(doc)) return;

  const stats = statsParaDoc(await calcularStatsAsync(doc.contenido || "", null));
  if (!stats) return;

  // Releer: entre el cálculo y la escritura pudo entrar otro sync del mismo
  // archivo. Si cambió, se descarta y se reencola con el contenido nuevo.
  const fresco = await estabDB.get(docId);
  if (fresco.hash_md5 !== doc.hash_md5) { encolarStats(slug, docId); return; }

  await estabDB.insert({
    ...fresco,
    stats,
    stats_hash: fresco.hash_md5,
    stats_ver:  STATS_VER,
    ts_trabajo: fresco.ts || Date.now(),
  });
  console.log(`[cobertura_stats] OK ${slug}/${fresco.lote_nombre || docId} · ${stats.trabajado_ha} ha`);
}

module.exports = { encolarStats, agregarACola, statsParaDoc, STATS_VER };
