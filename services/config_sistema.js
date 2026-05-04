// services/config_sistema.js — Configuración global persistida en CouchDB
// Las llaves se guardan como docs `cfg_<KEY>` en orbitx_global.
// Si no existe el doc, fallback a process.env[KEY].
// Hay cache en memoria para no pegarle a Couch en cada request.
"use strict";

const couch = require("./couchdb");

let cache = null;
let cacheTs = 0;
const TTL_MS = 30 * 1000;

// Llaves conocidas del sistema. Solo estas se exponen vía la API
// (otras vars de .env no se editan desde el panel).
const KEYS = [
  // Telegram admin global
  "TELEGRAM_ADMIN_BOT_TOKEN",
  "TELEGRAM_ADMIN_CHAT_ID",
  // SMTP global (verificación email + reset password)
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  // WhatsApp Cloud API defaults
  "WHATSAPP_API_VERSION",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
  // agrarIA
  "ANTHROPIC_API_KEY",
  // Auth de dispositivos
  "DEVICE_MASTER_TOKEN",
  // Copernicus / Sentinel Hub (NDVI)
  "COPERNICUS_CLIENT_ID",
  "COPERNICUS_CLIENT_SECRET",
  "COPERNICUS_INSTANCE_ID",
  // Otros
  "BASE_URL",
];

const SECRET_KEYS = new Set([
  "TELEGRAM_ADMIN_BOT_TOKEN",
  "SMTP_PASS",
  "WHATSAPP_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
  "DEVICE_MASTER_TOKEN",
  "JWT_SECRET",
  "COPERNICUS_CLIENT_SECRET",
]);

const isSecret = (key) => SECRET_KEYS.has(key);

const maskValue = (key, val) => {
  if (!val) return "";
  if (!isSecret(key)) return String(val);
  const s = String(val);
  if (s.length <= 8) return "••••";
  return s.slice(0, 4) + "•".repeat(Math.min(12, s.length - 8)) + s.slice(-4);
};

async function loadAll() {
  const result = {};
  // Default desde process.env
  for (const k of KEYS) result[k] = process.env[k] || "";

  // Sobrescribir con lo guardado en CouchDB
  try {
    const db = couch.getDB("global");
    const r  = await db.find({ selector: { tipo: "config_sistema" }, limit: 100 }).catch(() => null);
    const docs = r?.docs || [];
    for (const d of docs) {
      if (d.key && KEYS.includes(d.key)) result[d.key] = d.value || "";
    }
  } catch (e) {
    console.error("[ConfigSistema] loadAll:", e.message);
  }

  cache = result;
  cacheTs = Date.now();
  return result;
}

async function getAll() {
  if (!cache || (Date.now() - cacheTs) > TTL_MS) await loadAll();
  return { ...cache };
}

async function get(key) {
  const all = await getAll();
  return all[key] || "";
}

async function set(key, value, byUid = "system") {
  if (!KEYS.includes(key)) throw { status: 400, message: `Llave desconocida: ${key}` };
  const db = couch.getDB("global");
  const id = `cfg_${key}`;
  const now = Date.now();

  let rev;
  try { const ex = await db.get(id); rev = ex._rev; } catch {}
  await db.insert({
    _id:        id,
    ...(rev ? { _rev: rev } : {}),
    tipo:       "config_sistema",
    key,
    value:      value == null ? "" : String(value),
    updated_by: byUid,
    updated_at: now,
  });

  // Invalida cache.
  cache = null;
  return true;
}

async function unset(key, byUid = "system") {
  return set(key, "", byUid);
}

// Devuelve un objeto con todas las llaves enmascaradas + flag `_set` por llave.
async function getAllMasked() {
  const all = await getAll();
  const out = {};
  for (const k of KEYS) {
    const v = all[k] || "";
    out[k] = {
      value: maskValue(k, v),
      set:   !!v,
      secret: isSecret(k),
    };
  }
  return out;
}

module.exports = {
  KEYS,
  isSecret,
  maskValue,
  get, set, unset,
  getAll, getAllMasked,
  invalidate: () => { cache = null; },
};
