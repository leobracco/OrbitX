"use strict";
// tokens_org.js — Tokens de acceso de SOLO LECTURA por organización.
//
// Diferencia deliberada con device.token (que se guarda en claro): acá se
// guarda únicamente el sha256. El token completo se muestra UNA sola vez, al
// crearlo. Si se pierde, se revoca y se crea otro.
//
// Formato: "orbx_" + 40 caracteres base64url. El prefijo lo distingue de un
// JWT (que siempre empieza con "eyJ") de un vistazo, en un log o en un header.
const crypto = require("crypto");
const db = require("./couchdb");

const PREFIJO = "orbx_";
const CACHE_MS = 30 * 1000;
const DIAS_DEFAULT = 90;
const DIAS_MAX = 365;
const USO_MIN_MS = 60 * 1000;     // el débito de "último uso" se escribe como mucho 1 vez/min

const _cache = new Map();         // hash -> { doc, exp }
const _ultimoUso = new Map();     // _id  -> ts del último write

// Endpoints que un token de organización no toca NUNCA, ni siquiera leyendo:
// auth y administración (escalada de privilegios), config del sistema
// (credenciales globales), OTA, soporte, el propio CRUD de tokens y el puente
// CRM (que tiene su propio audience).
const RUTAS_PROHIBIDAS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/admin(\/|$)/,
  /^\/api\/config-sistema(\/|$)/,
  /^\/api\/config(\/|$)/,
  /^\/api\/grupos(\/|$)/,
  /^\/api\/ota(\/|$)/,
  /^\/api\/soporte(\/|$)/,
  /^\/api\/tokens-org(\/|$)/,
  /^\/api\/crm(\/|$)/,
];

function rutaProhibida(url) {
  const p = String(url || "").split("?")[0];
  return RUTAS_PROHIBIDAS.some(re => re.test(p));
}

function esSoloLectura(metodo) { return metodo === "GET" || metodo === "HEAD"; }

function generarToken() { return PREFIJO + crypto.randomBytes(30).toString("base64url"); }

function hashToken(tok) { return crypto.createHash("sha256").update(String(tok || "")).digest("hex"); }

function prefijoDe(tok) { return String(tok || "").slice(0, PREFIJO.length + 8); }

// Pura: no toca CouchDB ni el reloj del sistema.
function evaluarToken(doc, ahora) {
  if (!doc) return { valido: false, motivo: "no_encontrado" };
  if (doc.revocado) return { valido: false, motivo: "revocado" };
  if (doc.vence_ts && ahora > doc.vence_ts) return { valido: false, motivo: "vencido" };
  return { valido: true, motivo: null };
}

// Fail-CLOSED a propósito: si CouchDB tiene un hipo, esto tira y el middleware
// responde 503. Un token de organización es una credencial de larga vida sin
// token_version: dejarlo pasar "por las dudas" sería lo contrario de seguro.
async function buscarPorToken(tok) {
  const hash = hashToken(tok);
  const hit = _cache.get(hash);
  if (hit && hit.exp > Date.now()) return hit.doc;

  const globalDB = db.getDB("global");
  const r = await globalDB.find({
    selector: { tipo: "token_org", hash },
    fields: ["_id", "org_slug", "nombre", "prefijo", "rol", "scopes", "vence_ts", "revocado"],
    limit: 1,
  });
  const doc = (r.docs && r.docs[0]) || null;
  _cache.set(hash, { doc, exp: Date.now() + CACHE_MS });
  return doc;
}

function invalidarCache() { _cache.clear(); }

// Débito diferido: como mucho una escritura por minuto y por token. Sin esto,
// cada request de un panel que refresca cada 30 s escribe en orbitx_global.
function registrarUso(doc, ip) {
  if (!doc || !doc._id) return;
  const ahora = Date.now();
  if ((_ultimoUso.get(doc._id) || 0) + USO_MIN_MS > ahora) return;
  _ultimoUso.set(doc._id, ahora);
  const globalDB = db.getDB("global");
  globalDB.get(doc._id)
    .then(full => globalDB.insert({ ...full, ultimo_uso_ts: ahora, usos: (full.usos || 0) + 1, ultima_ip: ip || null }))
    .catch(e => console.warn("[tokens_org] uso:", e.message));
}

async function crear({ orgSlug, nombre, dias, creadoPor }) {
  if (!orgSlug) throw Object.assign(new Error("Falta la organización"), { status: 400 });
  const limpio = String(nombre || "").trim().slice(0, 80);
  if (!limpio) throw Object.assign(new Error("Poné un nombre que te diga para qué es el token"), { status: 400 });

  const d = Math.min(Math.max(Number(dias) || DIAS_DEFAULT, 1), DIAS_MAX);
  const token = generarToken();
  const ahora = Date.now();
  const doc = {
    _id:        `tokorg_${crypto.randomBytes(8).toString("hex")}`,
    tipo:       "token_org",
    org_slug:   orgSlug,
    nombre:     limpio,
    prefijo:    prefijoDe(token),
    hash:       hashToken(token),
    rol:        "viewer",
    scopes:     ["lectura"],
    vence_ts:   ahora + d * 86400000,
    revocado:   false,
    revocado_ts: null,
    revocado_por: null,
    creado_por: creadoPor || "system",
    created_at: ahora,
    updated_at: ahora,
    ultimo_uso_ts: null,
    usos: 0,
    ultima_ip: null,
  };
  await db.getDB("global").insert(doc);
  invalidarCache();
  return { doc, token };   // el token en claro sale de acá y no se guarda en ningún lado
}

async function listar(orgSlug) {
  const r = await db.getDB("global").find({
    selector: { tipo: "token_org", org_slug: orgSlug },
    fields: ["_id", "nombre", "prefijo", "vence_ts", "revocado", "created_at", "creado_por", "ultimo_uso_ts", "usos"],
    limit: 200,
  });
  return (r.docs || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

// Pura: ¿quien pide la revocación es dueño del token (misma org) o superadmin?
// Se testea sola porque acá vive la decisión de autorización del IDOR (ver
// revocar): un token de otro tipo de doc nunca es revocable por esta vía.
function puedeRevocar(doc, { orgSlug, esSuperadmin } = {}) {
  if (!doc || doc.tipo !== "token_org") return false;
  if (esSuperadmin) return true;
  return doc.org_slug === orgSlug;
}

async function revocar(id, { orgSlug, uid, esSuperadmin } = {}) {
  const globalDB = db.getDB("global");
  const doc = await globalDB.get(id);
  if (doc.tipo !== "token_org") throw Object.assign(new Error("Ese no es un token de organización"), { status: 404 });
  // Chequeo de dueño ANTES de mutar nada: sin esto, un admin de otra org podía
  // revocar un token ajeno con solo conocer el _id (IDOR).
  if (!puedeRevocar(doc, { orgSlug, esSuperadmin }))
    throw Object.assign(new Error("Ese token no es de tu organización"), { status: 403 });
  if (doc.revocado) return doc;   // ya estaba revocado: idempotente, no reescribe
  const out = { ...doc, revocado: true, revocado_ts: Date.now(), revocado_por: uid || "system", updated_at: Date.now() };
  await globalDB.insert(out);
  invalidarCache();
  return out;
}

module.exports = {
  PREFIJO, DIAS_DEFAULT, DIAS_MAX,
  generarToken, hashToken, prefijoDe, evaluarToken, esSoloLectura, rutaProhibida,
  buscarPorToken, invalidarCache, registrarUso, crear, listar, revocar, puedeRevocar,
};
