"use strict";
// Reglas puras del pairing por código (sin Express ni CouchDB) para poder
// testearlas. routes/devices.js mantiene el Map en memoria y las usa.
const crypto = require("crypto");

const PAIRING_TTL_MS = 10 * 60 * 1000;
// Sin I/O/0/1/L: se confunden en la fuente de la pantalla del tractor.
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function validPairCode(c) {
  if (typeof c !== "string") return false;
  c = c.toUpperCase();
  if (c.length !== 6) return false;
  for (const ch of c) if (!PAIR_ALPHABET.includes(ch)) return false;
  return true;
}

function hashSecret(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

// Quién puede reclamar un código y a qué org va.
// - origen "instalador": solo superadmin, y la org es obligatoria.
// - sin origen (menú de PilotX): igual que siempre.
function decidirClaim({ intent, user, estabBody }) {
  const esSA = user?.rol_global === "superadmin";
  if (intent?.origen === "instalador") {
    if (!esSA) return { ok: false, status: 403, error: "Las pantallas del instalador las aprueba solo Agro Parallel." };
    if (!estabBody) return { ok: false, status: 400, error: "Elegí la organización." };
    return { ok: true, estab_slug: estabBody };
  }
  const estab_slug = esSA ? (estabBody || user?.estabSlug || null) : user?.estabSlug;
  if (!estab_slug) return { ok: false, status: 403, error: "Necesitás una org activa para vincular un tractor." };
  return { ok: true, estab_slug };
}

const str = (v, n) => (v == null ? null : String(v).slice(0, n));

// El resumen lo manda un endpoint público: lista blanca y tamaños acotados.
function limpiarResumen(r) {
  if (!r || typeof r !== "object") return null;
  const adaptadores = Array.isArray(r.adaptadores) ? r.adaptadores.slice(0, 8).map(a => ({
    nombre:   str(a?.nombre, 60),
    tipo:     str(a?.tipo, 20),
    ip:       str(a?.ip, 45),
    internet: !!a?.internet,
  })) : [];
  return {
    hostname:             str(r.hostname, 60),
    windows:              str(r.windows, 80),
    instalacion_anterior: !!r.instalacion_anterior,
    lotes:                Number.isFinite(r.lotes) ? Math.max(0, Math.min(100000, Math.trunc(r.lotes))) : 0,
    adaptadores,
  };
}

function listarPendientes(map, now) {
  const out = [];
  for (const [code, p] of map) {
    if (p.origen !== "instalador" || p.claimed) continue;
    const edad = now - p.ts;
    if (edad > PAIRING_TTL_MS) continue;
    out.push({ code, device_id: p.device_id, hostname: p.hostname || null, version: p.version || null,
               resumen: p.resumen || null, ts: p.ts, expira_en_ms: PAIRING_TTL_MS - edad });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

module.exports = { PAIRING_TTL_MS, PAIR_ALPHABET, validPairCode, hashSecret, decidirClaim, limpiarResumen, listarPendientes };
