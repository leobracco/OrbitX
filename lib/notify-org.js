// lib/notify-org.js — Envío de notificaciones a una org según sus preferencias.
// La org NO tiene credenciales propias (SMTP/Telegram/WhatsApp): los senders son globales.
// Lo que sí guarda la org es: a quién mandar (chat_id, número, mails) y qué eventos quiere recibir.
//
// Doc CouchDB: campo `notificaciones` en `org_<slug>`:
//   notificaciones: {
//     telegram: { enabled: true,  chat_ids: ["1234..."] },
//     whatsapp: { enabled: false, numeros:  ["5493510000000"] },
//     email:    { enabled: true,  to:       ["op@campo.com"] },
//     eventos: {
//       alerta_critica:  { telegram, whatsapp, email },
//       fin_tarea:       { ... },
//       nodo_caido:      { ... },
//       reporte_diario:  { ... },
//       invitacion:      { ... },   // ya cubierto por el flujo de auth
//       firmware_listo:  { ... },
//     }
//   }
"use strict";

const couch  = require("../services/couchdb");
const tg     = require("./notify-admin");        // sendTelegram con override de creds
const wa     = require("./whatsapp");
const smtp   = require("./smtp");
const cfg    = require("../services/config_sistema");

const EVENTOS = [
  { clave: "alerta_critica",  nombre: "Alerta crítica",     descripcion: "Falla de bajada, presión fuera de rango, etc." },
  { clave: "fin_tarea",       nombre: "Fin de tarea",       descripcion: "Cuando se completa una siembra o pulverización" },
  { clave: "nodo_caido",      nombre: "Nodo caído",         descripcion: "Un dispositivo dejó de reportar por más de N minutos" },
  { clave: "reporte_diario",  nombre: "Reporte diario",     descripcion: "Resumen agronómico generado por agrarIA a las 19hs" },
  { clave: "firmware_listo",  nombre: "Nuevo firmware",     descripcion: "Hay una versión nueva disponible para tus dispositivos" },
];

const DEFAULT_NOTIF = {
  telegram: { enabled: false, chat_ids: [] },
  whatsapp: { enabled: false, numeros: [] },
  email:    { enabled: false, to: [] },
  eventos:  EVENTOS.reduce((acc, e) => {
    acc[e.clave] = { telegram: true, whatsapp: true, email: true };
    return acc;
  }, {}),
};

async function getConfigOrg(orgSlug) {
  const db = couch.getDB("global");
  const org = await db.get(`org_${orgSlug}`).catch(() => null);
  if (!org) throw Object.assign(new Error("Org no encontrada"), { status: 404 });
  return { org, notificaciones: org.notificaciones || JSON.parse(JSON.stringify(DEFAULT_NOTIF)) };
}

async function setConfigOrg(orgSlug, notif, byUid = "system") {
  const db = couch.getDB("global");
  const saneada = sanearNotif(notif);
  // O11d — retry 409: dos admins guardando config a la vez perdían uno de
  // los cambios con un 500. Releemos el _rev fresco en cada intento.
  let lastErr;
  for (let intento = 0; intento < 3; intento++) {
    try {
      const org = await db.get(`org_${orgSlug}`);
      await db.insert({
        ...org,
        notificaciones:        saneada,
        notificaciones_updated_by: byUid,
        notificaciones_updated_at: Date.now(),
        updated_at:            Date.now(),
      });
      return;
    } catch (e) {
      if ((e.statusCode === 409 || e.error === "conflict") && intento < 2) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error("setConfigOrg: conflict tras 3 reintentos");
}

// Permite payloads parciales y los completa con defaults.
function sanearNotif(input = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_NOTIF));
  for (const canal of ["telegram", "whatsapp", "email"]) {
    if (input[canal]) {
      out[canal].enabled = !!input[canal].enabled;
      const lista = canal === "telegram" ? "chat_ids" : canal === "whatsapp" ? "numeros" : "to";
      out[canal][lista] = (input[canal][lista] || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 10);
    }
  }
  if (input.eventos) {
    for (const e of EVENTOS) {
      if (input.eventos[e.clave]) {
        out.eventos[e.clave] = {
          telegram: !!input.eventos[e.clave].telegram,
          whatsapp: !!input.eventos[e.clave].whatsapp,
          email:    !!input.eventos[e.clave].email,
        };
      }
    }
  }
  return out;
}

// Envío principal: notify(orgSlug, "alerta_critica", { titulo, cuerpo, ... })
async function notify(orgSlug, evento, data = {}) {
  let conf;
  try { conf = (await getConfigOrg(orgSlug)).notificaciones; }
  catch { return { ok: false, error: "Org sin config" }; }

  const cfgEvt = conf.eventos?.[evento] || { telegram: true, whatsapp: true, email: true };
  const titulo = data.titulo || evento;
  const cuerpo = data.cuerpo || "";

  const tareas = [];

  // Telegram (canal habilitado + evento habilitado).
  if (conf.telegram?.enabled && cfgEvt.telegram && (conf.telegram.chat_ids || []).length) {
    const tgToken = await cfg.get("TELEGRAM_ADMIN_BOT_TOKEN");
    if (tgToken) {
      const text = `🌱 *${tg.escapeMd(titulo)}*\n\n${tg.escapeMd(cuerpo)}`;
      for (const chat_id of conf.telegram.chat_ids) {
        tareas.push(tg.sendTelegram(text, { token: tgToken, chat_id }).catch(e => ({ ok: false, error: e.message })));
      }
    }
  }

  // WhatsApp.
  if (conf.whatsapp?.enabled && cfgEvt.whatsapp && (conf.whatsapp.numeros || []).length) {
    for (const numero of conf.whatsapp.numeros) {
      tareas.push(wa.sendText({ to: numero, body: `${titulo}\n\n${cuerpo}` }).catch(e => ({ ok: false, error: e.message })));
    }
  }

  // Email.
  if (conf.email?.enabled && cfgEvt.email && (conf.email.to || []).length) {
    const html = `<div style="font-family:Inter,sans-serif;background:#1A1F25;color:#E6E6E6;padding:24px;border-radius:10px">
                    <h2 style="color:#A4BA3E;margin:0 0 12px 0">${escapeHtml(titulo)}</h2>
                    <pre style="background:#232830;padding:14px;border-radius:8px;white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(cuerpo)}</pre>
                  </div>`;
    for (const to of conf.email.to) {
      tareas.push(smtp.sendMail({
        to, subject: `[OrbitX] ${titulo}`, text: `${titulo}\n\n${cuerpo}`, html,
      }).catch(e => ({ ok: false, error: e.message })));
    }
  }

  const res = await Promise.all(tareas);
  const ok  = res.filter(r => r.ok).length;
  return { ok: ok > 0, total: res.length, enviados: ok, fallos: res.length - ok };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

module.exports = { EVENTOS, DEFAULT_NOTIF, getConfigOrg, setConfigOrg, sanearNotif, notify };
