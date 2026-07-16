// lib/openmeteo-org.js — API key de Open-Meteo por org (cada cliente la suya).
// Se guarda como campo `openmeteo` en el doc `org_<slug>` de orbitx_global,
// igual que las notificaciones. Si no hay key, se usa el tier gratuito.
"use strict";

const couch = require("../services/couchdb");

async function getConfig(orgSlug) {
  const db  = couch.getDB("global");
  const org = await db.get(`org_${orgSlug}`).catch(() => null);
  const om  = (org && org.openmeteo) || {};
  return { apikey: om.apikey || "", updated_at: om.updated_at || null };
}

async function getApiKey(orgSlug) {
  const { apikey } = await getConfig(orgSlug);
  return apikey || "";
}

async function setApiKey(orgSlug, apikey, byUid = "system") {
  const db = couch.getDB("global");
  // Retry por conflicto de _rev (dos admins guardando a la vez).
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const org = await db.get(`org_${orgSlug}`);
      await db.insert({
        ...org,
        openmeteo:  { apikey: (apikey || "").trim(), updated_by: byUid, updated_at: Date.now() },
        updated_at: Date.now(),
      });
      return;
    } catch (e) {
      if ((e.statusCode === 409 || e.error === "conflict") && i < 2) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error("setApiKey: conflict tras 3 reintentos");
}

// Enmascara la key para mostrarla sin exponerla entera.
function mask(k) {
  if (!k) return "";
  const s = String(k);
  if (s.length <= 8) return "••••";
  return s.slice(0, 4) + "•".repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}

module.exports = { getConfig, getApiKey, setApiKey, mask };
