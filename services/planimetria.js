"use strict";
// services/planimetria.js — I/O, flags y cache de la planimetría (fase 2).
// El cálculo puro vive en lib/planimetria.js.
//
// FLAGS (apagado por defecto, las dos cosas tienen que estar prendidas):
//   1. Global: variable de entorno PLANIMETRIA_ENABLED=1 (o "true"/"si") en el
//      .env de OrbitX. Sin la variable el endpoint responde 404 y el panel no
//      muestra la pestaña "Altimetría".
//   2. Por organización: "planimetria" dentro de `modulos` del doc org_<slug>
//      en orbitx_global (el mismo array de módulos habilitados por org que ya
//      trae el schema: ["vistax","linex","centrix"]). Se prende/apaga con
//      PUT /api/admin/org/:slug/modulos/planimetria (superadmin).
//
// CACHE: el resultado serializado se guarda en un doc de la base de la org
//   _id = planimetria_<sha1(lote|params)>, tipo "planimetria_cache"
// con el hash de las partes (ids + hash_md5 + tamaño). Si PilotX sube una
// parte nueva o la última crece, cambia el hash y se recalcula en el próximo
// pedido. Además hay un LRU chico en memoria para no releer CouchDB.
//
// MEMORIA (droplet de 1 GB): los textos de las partes se bajan de a uno, se
// parsean a typed arrays y se sueltan; nunca está todo el texto junto. Los
// cálculos van en fila de a uno (concurrencia 1) y dos pedidos iguales en
// paralelo comparten el mismo cálculo.
const crypto = require("crypto");
const db = require("./couchdb");
const plani = require("../lib/planimetria");

const SUBTIPO = "elevation_points";
const SUBTIPO_LEGACY = "elevation";     // Elevation.txt entero (AOG viejo)
const MODULO = "planimetria";

// Parámetros permitidos: acotan la cantidad de docs de cache por lote.
const RES_OK = [2, 3, 4, 5, 10];
const CURVAS_OK = [0.05, 0.1, 0.2, 0.25, 0.5, 1];
const UMBRAL_OK = [0.03, 0.05, 0.1, 0.2];
// Un doc de cache más grande que esto no se guarda en CouchDB (queda solo en
// memoria): CouchDB tiene max_document_size de 8 MB por defecto.
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

// ── Flags ─────────────────────────────────────────────────────────────
function habilitadaGlobal(env = process.env) {
  return /^(1|true|si|sí|on|todas|all)$/i.test(String(env.PLANIMETRIA_ENABLED || "").trim());
}

// PLANIMETRIA_ENABLED=todas: prendida para TODAS las orgs, sin tocar el array
// `modulos` de cada una (pedido 2026-10-03: OrbitX solo muestra; el on/off que
// importa es el de la pantalla, Configuración › GPS / IMU › Elevación).
function todasLasOrgs(env = process.env) {
  return /^(todas|all)$/i.test(String(env.PLANIMETRIA_ENABLED || "").trim());
}

const _orgCache = new Map(); // slug → { on, exp }
const ORG_TTL_MS = 60_000;

async function habilitadaParaOrg(slug, { gdb = null } = {}) {
  if (!habilitadaGlobal() || !slug) return false;
  if (todasLasOrgs()) return true;
  const c = _orgCache.get(slug);
  if (c && c.exp > Date.now()) return c.on;
  let on = false;
  try {
    const org = await (gdb || db.getDB("global")).get(`org_${slug}`);
    on = Array.isArray(org.modulos) && org.modulos.includes(MODULO);
  } catch { on = false; }
  _orgCache.set(slug, { on, exp: Date.now() + ORG_TTL_MS });
  return on;
}

function olvidarOrg(slug) { _orgCache.delete(slug); }

// Pura: agrega o saca el módulo del array (sin duplicar, sin tocar los demás).
function conModulo(modulos, modulo, activo) {
  const base = Array.isArray(modulos) ? modulos.filter(m => m !== modulo) : [];
  return activo ? [...base, modulo] : base;
}

// ── Parámetros ────────────────────────────────────────────────────────
function masCercano(v, lista, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return lista.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a), lista[0]);
}

function normalizarParams(q = {}) {
  return {
    res: masCercano(q.res, RES_OK, 3),
    curvas: (q.curvas === undefined || q.curvas === "auto") ? "auto" : masCercano(q.curvas, CURVAS_OK, 0.1),
    umbral: masCercano(q.umbral, UMBRAL_OK, 0.05),
    nivelar: !(q.nivelar === "0" || q.nivelar === false),
  };
}

// ── Hash de las partes (sin bajar contenido) ──────────────────────────
function hashPartes(metas) {
  const h = crypto.createHash("sha1");
  h.update(`v${plani.PLANI_VER}|`);
  [...metas].sort((a, b) => (a._id < b._id ? -1 : 1))
    .forEach(m => h.update(`${m._id}:${m.hash_md5 || m._rev || ""}:${m.tamaño ?? m.tamano ?? ""};`));
  return h.digest("hex");
}

function idCache(lote, p) {
  const k = crypto.createHash("sha1").update(`${lote}|${p.res}|${p.curvas}|${p.umbral}|${p.nivelar ? 1 : 0}`).digest("hex").slice(0, 24);
  return `planimetria_${k}`;
}

// ── LRU en memoria ────────────────────────────────────────────────────
const _lru = new Map(); // clave → { hash, json }
const LRU_MAX = 6;
function lruGet(k, hash) {
  const e = _lru.get(k);
  if (!e || e.hash !== hash) return null;
  _lru.delete(k); _lru.set(k, e);
  return e.json;
}
function lruSet(k, hash, json) {
  _lru.delete(k); _lru.set(k, { hash, json });
  while (_lru.size > LRU_MAX) _lru.delete(_lru.keys().next().value);
}

// ── Cola de concurrencia 1 + dedupe ───────────────────────────────────
let _cadena = Promise.resolve();
const _enCurso = new Map();
function enFila(clave, fn) {
  if (_enCurso.has(clave)) return _enCurso.get(clave);
  const p = _cadena.then(fn, fn);
  _cadena = p.catch(() => {});
  _enCurso.set(clave, p);
  p.finally(() => _enCurso.delete(clave)).catch(() => {});
  return p;
}

// ── Lectura de datos ──────────────────────────────────────────────────
async function metasPartes(estabDB, lote) {
  const campos = ["_id", "_rev", "nombre", "ruta_rel", "hash_md5", "tamaño", "ts"];
  // Selector cubierto por el índice ["tipo","subtipo","lote_nombre","ts"].
  const sel = (subtipo) => ({ tipo: "aog_archivo", subtipo, lote_nombre: lote, ts: { $gt: 0 } });
  let r = await estabDB.find({ selector: sel(SUBTIPO), fields: campos, limit: 5000 });
  if (r.docs && r.docs.length) return { metas: r.docs, legacy: false };
  r = await estabDB.find({ selector: sel(SUBTIPO_LEGACY), fields: campos, limit: 5 });
  return { metas: r.docs || [], legacy: true };
}

// Cantidad de partes de alturas de un lote (para mostrar o no la pestaña).
async function contarPartes(estabDB, lote) {
  try { return (await metasPartes(estabDB, lote)).metas.length; } catch { return 0; }
}

// Límite del lote (lat/lon) para el % cubierto. Falla en silencio.
async function limiteLote(estabDB, lote) {
  try {
    // El subtipo va en el selector: así CouchDB NO devuelve el contenido de
    // Sections.txt ni de las partes de elevación (varios MB).
    const r = await estabDB.find({
      selector: { tipo: "aog_archivo", es_lote: true, lote_nombre: lote,
        subtipo: { $in: ["field_origin", "boundary", "boundary_kml"] } },
      fields: ["subtipo", "contenido", "ts", "lote_nombre"], limit: 10,
    });
    const docs = r.docs || [];
    if (!docs.length) return null;
    const { parseLote } = require("./aog_parser");
    const b = parseLote(docs).boundary;
    return Array.isArray(b) && b.length >= 3 ? b : null;
  } catch { return null; }
}

// ── Cálculo: en un worker_thread (default) o inline ───────────────────
// Las partes se bajan de a una y se pasan al worker apenas llegan: en el
// hilo principal nunca hay más de una parte (~300 KB) de texto viva.
// PLANIMETRIA_WORKER=0 fuerza el cálculo inline (bloquea el event loop
// mientras dura; útil solo para diagnosticar).
const WORKER_JS = require("path").join(__dirname, "..", "lib", "planimetria-worker.js");

async function calcularInline(edb, metas, opts, meta) {
  const acc = plani.crearAcumulador();
  for (const m of metas) {
    const d = await edb.get(m._id).catch(() => null);
    if (d && typeof d.contenido === "string") acc.agregar(d.contenido);
  }
  return plani.serializar(plani.calcularDesdePuntos(acc.resultado(), opts), meta);
}

async function calcular(edb, metas, opts, meta) {
  if (process.env.PLANIMETRIA_WORKER === "0") return calcularInline(edb, metas, opts, meta);
  let w;
  try {
    const { Worker } = require("worker_threads");
    // Tope de heap del worker: si un lote monstruoso no entra, falla el
    // cálculo (500) en vez de empujar a OrbitX entero al límite de PM2.
    w = new Worker(WORKER_JS, { resourceLimits: { maxOldGenerationSizeMb: 384 } });
  } catch (e) {
    console.warn("[planimetria] sin worker_threads, calculo inline:", e.message);
    return calcularInline(edb, metas, opts, meta);
  }
  const resultado = new Promise((resolve, reject) => {
    w.once("message", (m) => (m && m.ok ? resolve(m.S) : reject(new Error((m && m.error) || "falló el cálculo"))));
    w.once("error", reject);
    w.once("exit", (code) => reject(new Error(`el worker de planimetría terminó (código ${code})`)));
  });
  resultado.catch(() => {});   // el rechazo se consume abajo
  try {
    for (const m of metas) {
      const d = await edb.get(m._id).catch(() => null);
      if (d && typeof d.contenido === "string") w.postMessage({ tipo: "parte", texto: d.contenido });
    }
    w.postMessage({ tipo: "calcular", opts, meta });
    return await resultado;
  } finally {
    w.terminate().catch(() => {});
  }
}

// ── API principal ─────────────────────────────────────────────────────
// Devuelve { estado, json } con estado: "ok" | "sin_datos".
// json es el resultado serializado (lib/planimetria.serializar) + meta.
async function obtener(slug, lote, query = {}, { estabDB = null, fresco = false } = {}) {
  const p = normalizarParams(query);
  const edb = estabDB || db.getDB(slug);
  const { metas, legacy } = await metasPartes(edb, lote);
  if (!metas.length) return { estado: "sin_datos", json: { ok: false, sin_datos: true, motivo: "Este lote todavía no tiene alturas registradas" } };

  const hash = hashPartes(metas);
  const cid = idCache(lote, p);
  const clave = `${slug}::${cid}`;

  if (!fresco) {
    const m = lruGet(clave, hash);
    if (m) return { estado: "ok", json: { ...m, desde_cache: "memoria" } };
    const doc = await edb.get(cid).catch(() => null);
    if (doc && doc.hash_partes === hash && doc.ver === plani.PLANI_VER && doc.resultado) {
      lruSet(clave, hash, doc.resultado);
      return { estado: "ok", json: { ...doc.resultado, desde_cache: "couchdb" } };
    }
  }

  const json = await enFila(clave + "::" + hash, async () => {
    const limite = await limiteLote(edb, lote);
    const opts = { res: p.res, intervalo: p.curvas, umbralBajo: p.umbral, nivelar: p.nivelar, limite };
    const meta = { lote, hash, partes: metas.length, legacy, calculado_ts: Date.now() };
    const S = await calcular(edb, metas, opts, meta);
    lruSet(clave, hash, S);
    // Guardar cache (si no es gigante). Un 409 no importa: otro lo guardó.
    try {
      const tam = Buffer.byteLength(JSON.stringify(S));
      if (tam <= MAX_CACHE_BYTES) {
        const prev = await edb.get(cid).catch(() => null);
        await edb.insert({
          _id: cid, ...(prev ? { _rev: prev._rev } : {}),
          tipo: "planimetria_cache", lote_nombre: lote, params: p,
          hash_partes: hash, ver: plani.PLANI_VER, ts: Date.now(), bytes: tam,
          resultado: S,
        });
      }
    } catch (e) { console.warn("[planimetria] no se pudo guardar el cache:", e.message); }
    console.log(`[planimetria] ${slug}/${lote} · ${S.stats?.puntos_usados ?? 0} pts · ${S.stats?.ms ?? "?"} ms`);
    return S;
  });
  return { estado: "ok", json: { ...json, desde_cache: false } };
}

module.exports = {
  MODULO, habilitadaGlobal, habilitadaParaOrg, olvidarOrg, conModulo,
  normalizarParams, hashPartes, idCache, obtener, contarPartes,
};
