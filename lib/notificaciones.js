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
const db = require("../services/couchdb");

const RETENCION_DIAS = 180;
const NIVELES = ["critico", "info", "ok"];

// ── Puras ─────────────────────────────────────────────────
function armarNotificacion(evento, data = {}, ahora = Date.now()) {
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const ev = String(evento || "aviso");
  return {
    _id:    `notif_${ahora}_${rnd}`,
    tipo:   "notificacion",
    evento: ev,
    titulo: String(data.titulo || ev).slice(0, 200),
    cuerpo: String(data.cuerpo || "").slice(0, 2000),
    nivel:  NIVELES.includes(data.nivel) ? data.nivel : (ev === "alerta_critica" ? "critico" : "info"),
    url:    data.url || null,
    ts:     ahora,
    meta:   (data.meta && typeof data.meta === "object") ? data.meta : {},
  };
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

function idLectura(uid) { return `notif_leidas_${uid}`; }

async function getLectura(orgSlug, uid) {
  try {
    return await db.getDB(orgSlug).get(idLectura(uid));
  } catch {
    return { _id: idLectura(uid), tipo: "notif_lectura", uid, ts_hasta: 0, ids_leidas: [], ids_ts: {} };
  }
}

async function guardarLectura(orgSlug, lectura) {
  const estabDB = db.getDB(orgSlug);
  for (let intento = 0; intento < 3; intento++) {
    try {
      let rev;
      try { rev = (await estabDB.get(lectura._id))._rev; } catch {}
      await estabDB.insert({ ...compactarLectura(lectura), ...(rev ? { _rev: rev } : {}), updated_at: Date.now() });
      return;
    } catch (e) {
      if (e.statusCode !== 409 || intento === 2) throw e;
    }
  }
}

async function marcarUna(orgSlug, uid, id, ts) {
  const l = await getLectura(orgSlug, uid);
  if (!(l.ids_leidas || []).includes(id)) {
    l.ids_leidas = [...(l.ids_leidas || []), id];
    l.ids_ts = { ...(l.ids_ts || {}), [id]: Number(ts) || Date.now() };
  }
  await guardarLectura(orgSlug, l);
}

async function marcarTodas(orgSlug, uid, tsHasta) {
  const l = await getLectura(orgSlug, uid);
  l.ts_hasta = Math.max(l.ts_hasta || 0, Number(tsHasta) || Date.now());
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
  armarNotificacion, estaLeida, contarNoLeidas, compactarLectura,
  registrar, listar, getLectura, marcarUna, marcarTodas, purgar,
};
