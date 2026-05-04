// lib/whatsapp.js — Cliente WhatsApp Cloud API oficial (Meta).
// Cada org puede tener sus credenciales en /integraciones; estas son las defaults globales.
"use strict";

const cfg = require("../services/config_sistema");

const fetchFn = async () => (typeof fetch === "function"
  ? fetch
  : (await import("node-fetch")).default);

// Manda un mensaje de texto plano (solo válido si el usuario destino mandó algo en las
// últimas 24hs — fuera de esa ventana hace falta una plantilla pre-aprobada).
async function sendText({ to, body, creds }) {
  const phoneId = creds?.phone_number_id || await cfg.get("WHATSAPP_PHONE_NUMBER_ID");
  const token   = creds?.access_token    || await cfg.get("WHATSAPP_ACCESS_TOKEN");
  const version = creds?.api_version     || await cfg.get("WHATSAPP_API_VERSION") || "v20.0";

  if (!phoneId || !token)
    return { ok: false, error: "WhatsApp sin configurar (phone_number_id / access_token)" };
  if (!to)
    return { ok: false, error: "Falta el número de destino (formato E.164, ej: 5493510000000)" };

  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  const f   = await fetchFn();
  try {
    const r = await f(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to:                String(to).replace(/[^\d]/g, ""),
        type:              "text",
        text:              { body: String(body || "").slice(0, 4096) },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `HTTP ${r.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, message_id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Plantilla pre-aprobada (cuando el destino está fuera de la ventana de 24hs).
async function sendTemplate({ to, template, language = "es_AR", components = [], creds }) {
  const phoneId = creds?.phone_number_id || await cfg.get("WHATSAPP_PHONE_NUMBER_ID");
  const token   = creds?.access_token    || await cfg.get("WHATSAPP_ACCESS_TOKEN");
  const version = creds?.api_version     || await cfg.get("WHATSAPP_API_VERSION") || "v20.0";

  if (!phoneId || !token)
    return { ok: false, error: "WhatsApp sin configurar" };

  const url = `https://graph.facebook.com/${version}/${phoneId}/messages`;
  const f   = await fetchFn();
  try {
    const r = await f(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to:                String(to).replace(/[^\d]/g, ""),
        type:              "template",
        template: {
          name:     template,
          language: { code: language },
          components,
        },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = data?.error?.message || `HTTP ${r.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, message_id: data?.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendText, sendTemplate };
