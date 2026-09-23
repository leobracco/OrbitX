"use strict";
// prescripciones.js — Genera zonas desde NDVI y guarda las prescripciones en
// CouchDB (hasta ahora vivían solo en el localStorage del navegador, máximo 30
// por máquina y sin backup).
//
// La generación se serializa: un raster de 1024x1024 más el PNG inflado son
// 30-50 MB de pico, y el droplet tiene 1 GB con ~25 apps. Una por vez.
const db = require("./couchdb");
const { rasterDeLote } = require("./ndvi_raster");
const { zonificar } = require("../lib/zonificar");
const { normalizarColeccion, asignarDosis, desdeLocalStorage } = require("../lib/prescripcion_schema");

const ESTADOS = ["borrador", "lista", "enviada"];
let _cadena = Promise.resolve();

// Tope de un trabajo en la cola. Un raster normal tarda segundos; 120 s es
// holgado incluso para un lote grande con Copernicus lento.
const TIMEOUT_TRABAJO_MS = 120_000;

// El nombre del lote entra en selectores Mango: lo acotamos a texto corto para
// que no llegue un objeto (`{$gt:null}` y amigos) ni una cadena de 1 MB.
function texto(v, max = 120) { return String(v ?? "").slice(0, max); }

// `local_id` viene del localStorage y ahí es un timestamp numérico, pero puede
// llegar cualquier cosa por el body. Los números se guardan y se consultan como
// números (para no romper la idempotencia de lo ya migrado en producción) y
// todo lo demás como texto corto: nunca un objeto dentro de un selector Mango.
function claveLocal(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return texto(v);
}

// Corta una promesa colgada. Sin esto, un fetch que nunca resuelve deja la
// cadena de la cola (concurrencia 1) trabada para siempre: no se genera una
// sola prescripción más hasta reiniciar el proceso.
function conTimeout(promesa, ms = TIMEOUT_TRABAJO_MS) {
  let t;
  const reloj = new Promise((_, rechazar) => {
    t = setTimeout(
      () => rechazar(Object.assign(new Error("La generación tardó demasiado y se canceló"), { status: 504 })),
      ms
    );
    if (typeof t.unref === "function") t.unref();   // que no mantenga vivo el proceso
  });
  return Promise.race([promesa, reloj]).finally(() => clearTimeout(t));
}

// Cola de concurrencia 1: cada generación espera a la anterior. El setImmediate
// saca el trabajo del tick del request — zonificar un raster grande es ~0,7 s
// de CPU sincrónica y no queremos que caiga en el medio de responder.
function enCola(fn) {
  let interna = null;
  const correr = () => {
    interna = new Promise((resolver, rechazar) => {
      setImmediate(() => { Promise.resolve().then(fn).then(resolver, rechazar); });
    });
    return conTimeout(interna);
  };
  const siguiente = _cadena.then(correr, correr);
  // El que llama recibe el race (504 si expira), pero la cola avanza recién
  // cuando termina el trabajo REAL: un trabajo que expiró sigue ocupando
  // memoria (PNG + raster) y no queremos dos de esos a la vez en 1 GB.
  const esperarReal = () => (interna || Promise.resolve()).catch(() => {});
  _cadena = siguiente.then(esperarReal, esperarReal);
  return siguiente;
}

async function generar({ slug, lote, fecha, indice = "ndvi", n = 3, areaMinHa = 0.5, dosis = null, unidad = null, sentido = "mas_donde_menos", nombre = "" }) {
  const zonas = Math.min(Math.max(Number(n) || 3, 2), 5);
  return enCola(async () => {
    const r = await rasterDeLote({ slug, lote, fecha, indice });
    const fc = zonificar({
      datos: r.datos, ancho: r.ancho, alto: r.alto, bbox: r.bbox,
      zona: r.zona, sur: r.sur, n: zonas,
      areaMinHa: Number(areaMinHa) >= 0 ? Number(areaMinHa) : 0.5,
      rango: r.rango,
    });
    if (!fc.features.length)
      throw Object.assign(new Error("Esa fecha no tiene imagen utilizable del lote (nubes o sin pasada del satélite)"), { status: 422 });

    const conDosis = asignarDosis(normalizarColeccion(fc, { nombre: nombre || lote }), { dosis, unidad, sentido });
    conDosis.properties.fuente = {
      indice: r.indice, fecha: r.fecha, metodo: "cuantiles", n_zonas: zonas,
      cortes: fc.properties.cortes, resolucion_m: r.resolucion_m, zona_utm: r.zona,
    };
    return conDosis;
  });
}

function docNuevo({ slug, datos, uid }) {
  const ahora = Date.now();
  const geo = normalizarColeccion(datos.geojson || datos, { nombre: datos.nombre || "" });
  return {
    _id:         `presc_${ahora}_${Math.random().toString(36).slice(2, 6)}`,
    tipo:        "prescripcion",
    nombre:      String(datos.nombre || "Sin nombre").slice(0, 120),
    // lote_nombre se usa después como clave de selector Mango: texto o null.
    lote_nombre: (datos.lote_nombre || datos.lote) ? texto(datos.lote_nombre || datos.lote) : null,
    org_slug:    slug,
    origen:      ["manual", "ndvi", "import"].includes(datos.origen) ? datos.origen : "manual",
    estado:      ESTADOS.includes(datos.estado) ? datos.estado : "borrador",
    geojson:     geo,
    units:       datos.units || null,
    extra:       datos.extra || null,
    fuente:      datos.fuente || geo.properties?.fuente || null,
    local_id:    claveLocal(datos.local_id),
    created_at:  ahora,
    created_by:  uid || "system",
    updated_at:  ahora,
  };
}

async function guardar(slug, datos, uid) {
  const doc = docNuevo({ slug, datos, uid });
  await db.getDB(slug).insert(doc);
  return doc;
}

async function listar(slug, { lote = null, limit = 200 } = {}) {
  // Índice ["tipo","lote_nombre"] (Sprint 2, Tarea 1) cuando se filtra por lote.
  const selector = lote ? { tipo: "prescripcion", lote_nombre: texto(lote) } : { tipo: "prescripcion" };
  const r = await db.getDB(slug).find({
    selector,
    fields: ["_id", "nombre", "lote_nombre", "origen", "estado", "fuente", "local_id", "created_at", "created_by", "updated_at"],
    limit,
  });
  return (r.docs || []).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

async function obtener(slug, id) {
  let doc;
  // nano marca el 404 en `statusCode`; sin traducirlo el router respondía 500.
  try { doc = await db.getDB(slug).get(id); }
  catch (e) {
    if (e.statusCode === 404) { const err = new Error("No encontrada"); err.status = 404; throw err; }
    throw e;
  }
  if (doc.tipo !== "prescripcion") { const e = new Error("No encontrada"); e.status = 404; throw e; }
  return doc;
}

async function actualizar(slug, id, datos, uid) {
  const previo = await obtener(slug, id);
  const doc = {
    ...previo,
    nombre:      datos.nombre != null ? String(datos.nombre).slice(0, 120) : previo.nombre,
    lote_nombre: datos.lote_nombre != null ? texto(datos.lote_nombre) : previo.lote_nombre,
    estado:      ESTADOS.includes(datos.estado) ? datos.estado : previo.estado,
    geojson:     datos.geojson ? normalizarColeccion(datos.geojson, { nombre: datos.nombre || previo.nombre }) : previo.geojson,
    units:       datos.units ?? previo.units,
    updated_at:  Date.now(),
    updated_by:  uid || "system",
  };
  await db.getDB(slug).insert(doc);
  return doc;
}

async function borrar(slug, id) {
  const doc = await obtener(slug, id);
  await db.getDB(slug).destroy(doc._id, doc._rev);
  return true;
}

// ¿Ya migramos esta prescripción? Consulta dirigida por `local_id` con el
// índice ["tipo","local_id"]: el `listar({limit:500})` de antes se traía media
// base para armar un Set y, pasadas las 500, dejaba de ser idempotente.
async function yaMigrada(slug, localId) {
  const r = await db.getDB(slug).find({
    selector: { tipo: "prescripcion", local_id: localId },
    fields: ["_id"],
    limit: 1,
  }).catch(() => ({ docs: [] }));
  return !!(r.docs || []).length;
}

// Migración única de lo que haya en localStorage. Idempotente por `local_id`:
// abrir la pantalla dos veces no duplica nada.
async function migrarLocales(slug, lista, uid) {
  const vistos = new Set();   // duplicados dentro del mismo body
  let creados = 0, saltados = 0;
  for (const cruda of lista || []) {
    const conv = desdeLocalStorage(cruda);
    if (!conv) { saltados++; continue; }
    const clave = claveLocal(conv.local_id);
    if (clave != null && clave !== "") {
      if (vistos.has(clave) || await yaMigrada(slug, clave)) { saltados++; continue; }
      vistos.add(clave);
    }
    await guardar(slug, { ...conv, estado: "borrador" }, uid);
    creados++;
  }
  return { creados, saltados };
}

module.exports = { generar, guardar, listar, obtener, actualizar, borrar, migrarLocales, enCola, ESTADOS };
