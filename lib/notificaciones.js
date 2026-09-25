"use strict";
// notificaciones.js — Historial de avisos por organización.
//
// Dos docs:
//  · `notificacion` (uno por aviso) en la DB de la org. Se escribe UNA sola
//    vez, apenas se dispara el evento: no se vuelve para anotar el resultado
//    de los canales (el_susto ya pesa 11,9 GB, cada rev cuesta).
//  · `notif_leidas_<uid>` (uno por usuario) con `ts_hasta` + `ids_leidas`.
//    Guardar las lecturas por usuario en vez de un array `leida_por` dentro de
//    cada notificación elimina los 409 cuando varios marcan al mismo tiempo.
const crypto = require("crypto");
const db = require("../services/couchdb");

const RETENCION_DIAS = 180;
const NIVELES = ["critico", "info", "ok"];

// ── Puras ─────────────────────────────────────────────────
// Solo rutas relativas del propio sitio (empiezan con "/" y no con "//",
// que es protocol-relative y se va a otro host). Bloquea "javascript:",
// URLs absolutas ("https://…") y cualquier cosa que no sea string. Se usa
// al armar el doc (server) y de nuevo en el front antes de pintar el href
// (defensa en profundidad).
function urlSegura(u) {
  if (typeof u !== "string") return null;
  if (!u.length || u.length > 300) return null;
  // "/\evil.com" el navegador lo lee como "//evil.com": la barra invertida también se rechaza.
  if (!u.startsWith("/") || u.startsWith("//") || u.includes("\\")) return null;
  return u;
}

function armarNotificacion(evento, data = {}, ahora = Date.now()) {
  // 8 hex chars (4 bytes) en vez de 4 base36: con miles de notis por día en
  // varias orgs, 4 chars de Math.random() colisiona más seguido de lo que
  // conviene para un _id que tiene que ser único.
  const rnd = crypto.randomBytes(4).toString("hex");
  const ev = String(evento || "aviso");
  return {
    _id:    `notif_${ahora}_${rnd}`,
    tipo:   "notificacion",
    evento: ev,
    titulo: String(data.titulo || ev).slice(0, 200),
    cuerpo: String(data.cuerpo || "").slice(0, 2000),
    nivel:  NIVELES.includes(data.nivel) ? data.nivel : (ev === "alerta_critica" ? "critico" : "info"),
    url:    urlSegura(data.url),
    ts:     ahora,
    meta:   (data.meta && typeof data.meta === "object") ? data.meta : {},
  };
}

// `ts` llega del cliente (body de "marcar leídas"). Sin techo, un reloj
// adelantado o un body armado a mano manda ts_hasta al año 3000 y deja TODO
// leído para siempre: ninguna notificación futura vuelve a contar como no
// leída. Se clampea a "ahora" y nunca baja (Math.max lo hace el llamador).
function clampTs(ts, ahora = Date.now()) {
  const n = Number(ts);
  return Math.min(Number.isFinite(n) && n > 0 ? n : ahora, ahora);
}

function estaLeida(n, lectura) {
  if (!lectura) return false;
  if ((n.ts || 0) <= (lectura.ts_hasta || 0)) return true;
  return (lectura.ids_leidas || []).includes(n._id);
}

function contarNoLeidas(items, lectura) {
  return (items || []).filter(n => !estaLeida(n, lectura)).length;
}

// Los ids marcados uno por uno dejan de hacer falta cuando `ts_hasta` los
// cubre: sin esto el doc de lectura crece para siempre.
function compactarLectura(lectura) {
  const tsHasta = lectura.ts_hasta || 0;
  const idsTs = lectura.ids_ts || {};
  const ids = (lectura.ids_leidas || []).filter(id => (idsTs[id] || Infinity) > tsHasta);
  const out = {};
  for (const id of ids) if (idsTs[id] != null) out[id] = idsTs[id];
  return { ...lectura, ids_leidas: ids, ids_ts: out };
}

// Remergea la lectura remota (lo que ya persistió otro writer) con la local
// (lo que esta request quería guardar), sin perder ninguna de las dos: el
// 409 significa que alguien escribió entre el get y el insert, y pisar su
// _rev con nuestra copia local perdería su marcado. Unión de ids, máximo de
// ts_hasta, después compacta.
function mergearLecturas(remota, local) {
  const idsLeidas = Array.from(new Set([...(remota.ids_leidas || []), ...(local.ids_leidas || [])]));
  const idsTs = { ...(remota.ids_ts || {}), ...(local.ids_ts || {}) };
  return compactarLectura({
    ...remota,
    ...local,
    _id: remota._id,
    _rev: remota._rev,
    ts_hasta: Math.max(remota.ts_hasta || 0, local.ts_hasta || 0),
    ids_leidas: idsLeidas,
    ids_ts: idsTs,
  });
}

// ── Con CouchDB ───────────────────────────────────────────
async function registrar(orgSlug, evento, data = {}) {
  const doc = armarNotificacion(evento, data);
  await db.getDB(orgSlug).insert(doc);
  return doc;
}

// Paginación por cursor sobre `ts` descendente — nunca por `skip`.
// Índice ["tipo","ts"], ya existente en ESTAB_INDEX_FIELDS.
async function listar(orgSlug, { limit = 50, antesDe = null } = {}) {
  const selector = antesDe
    ? { tipo: "notificacion", ts: { $lt: Number(antesDe) } }
    : { tipo: "notificacion", ts: { $gt: 0 } };
  const r = await db.getDB(orgSlug).find({
    selector,
    fields: ["_id", "evento", "titulo", "cuerpo", "nivel", "url", "ts", "meta"],
    sort: [{ ts: "desc" }],
    limit: Math.min(Number(limit) || 50, 200),
  });
  return r.docs || [];
}

// Consulta liviana para el badge: solo `_id`/`ts` (nada de `titulo`/`cuerpo`),
// mismo selector+índice que `listar()`, limit acotado. `noLeidas()` la usa
// junto con la `contarNoLeidas` pura de arriba para no bajar el cuerpo de
// cada notificación solo para contar cuántas faltan leer.
async function listarMeta(orgSlug, { limit = 100 } = {}) {
  const r = await db.getDB(orgSlug).find({
    selector: { tipo: "notificacion", ts: { $gt: 0 } },
    fields: ["_id", "ts"],
    sort: [{ ts: "desc" }],
    limit: Math.min(Number(limit) || 100, 200),
  });
  return r.docs || [];
}

async function noLeidas(orgSlug, uid, { limit = 100 } = {}) {
  const tope = Math.min(Number(limit) || 100, 200);
  const [items, lectura] = await Promise.all([
    listarMeta(orgSlug, { limit: tope + 1 }),
    getLectura(orgSlug, uid),
  ]);
  const hayMas = items.length > tope;
  const pagina = hayMas ? items.slice(0, tope) : items;
  return { no_leidas: contarNoLeidas(pagina, lectura), hay_mas: hayMas };
}

function idLectura(uid) { return `notif_leidas_${uid}`; }

async function getLectura(orgSlug, uid) {
  try {
    return await db.getDB(orgSlug).get(idLectura(uid));
  } catch (e) {
    // Solo el 404 (doc todavía no existe) devuelve la lectura vacía. Cualquier
    // otro error (red, timeout, permisos) se relanza: pisar el historial del
    // usuario con un doc vacío por un error transitorio sería peor que fallar.
    if (e.statusCode === 404 || e.error === "not_found") {
      return { _id: idLectura(uid), tipo: "notif_lectura", uid, ts_hasta: 0, ids_leidas: [], ids_ts: {} };
    }
    throw e;
  }
}

async function guardarLectura(orgSlug, lectura) {
  const estabDB = db.getDB(orgSlug);
  let actual = lectura;
  for (let intento = 0; intento < 2; intento++) {
    try {
      let rev;
      try { rev = (await estabDB.get(actual._id))._rev; } catch {}
      await estabDB.insert({ ...compactarLectura(actual), ...(rev ? { _rev: rev } : {}), updated_at: Date.now() });
      return;
    } catch (e) {
      if (e.statusCode !== 409 || intento === 1) throw e;
      // Lost update: entre el get y el insert otro writer ya persistió su
      // marcado. Releer el doc remoto completo y remergear (no solo el
      // _rev) antes del único reintento, para no pisar lo que escribió.
      const remota = await estabDB.get(actual._id);
      actual = mergearLecturas(remota, lectura);
    }
  }
}

async function marcarUna(orgSlug, uid, id, ts) {
  const l = await getLectura(orgSlug, uid);
  if (!(l.ids_leidas || []).includes(id)) {
    l.ids_leidas = [...(l.ids_leidas || []), id];
    l.ids_ts = { ...(l.ids_ts || {}), [id]: clampTs(ts) };
  }
  await guardarLectura(orgSlug, l);
}

async function marcarTodas(orgSlug, uid, tsHasta) {
  const l = await getLectura(orgSlug, uid);
  l.ts_hasta = Math.max(l.ts_hasta || 0, clampTs(tsHasta));
  await guardarLectura(orgSlug, l);
}

// Retención: sin purga, una org acumula avisos para siempre.
async function purgar(orgSlug, dias = RETENCION_DIAS) {
  const corte = Date.now() - dias * 86400000;
  const r = await db.getDB(orgSlug).find({
    selector: { tipo: "notificacion", ts: { $lt: corte } },
    fields: ["_id", "_rev"],
    limit: 500,
  });
  const docs = (r.docs || []).map(d => ({ ...d, _deleted: true }));
  if (!docs.length) return 0;
  await db.getDB(orgSlug).bulk({ docs });
  return docs.length;
}

module.exports = {
  RETENCION_DIAS,
  armarNotificacion, urlSegura, clampTs, estaLeida, contarNoLeidas, compactarLectura, mergearLecturas,
  registrar, listar, listarMeta, getLectura, marcarUna, marcarTodas, noLeidas, purgar,
};
