// lib/notify-admin.js — Notificaciones a Telegram del admin global de Agro Parallel
// Token y chat_id en .env: TELEGRAM_ADMIN_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID
//
// Diseño:
// - Funciones por evento (notifyNewUser, notifyNewOrg, notifyOTAResult, etc.).
// - El caller hace .catch(...) — nunca esperar a que termine ni romper el flujo si falla.
// - Mensaje en MarkdownV2. Helper escapeMd() escapa los caracteres reservados.
"use strict";

const cfg = require("../services/config_sistema");

// Caracteres reservados en MarkdownV2 (ver docs Telegram Bot API).
const MD2_ESCAPE = /[_*\[\]()~`>#+\-=|{}.!\\]/g;
const escapeMd = (s) => String(s ?? "").replace(MD2_ESCAPE, "\\$&");

const fmtAR = (ts) => {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Cordoba",
    day:   "2-digit",
    month: "2-digit",
    year:  "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
};

async function sendTelegram(text, opts = {}) {
  const TG_TOKEN = opts.token   || await cfg.get("TELEGRAM_ADMIN_BOT_TOKEN");
  const TG_CHAT  = opts.chat_id || await cfg.get("TELEGRAM_ADMIN_CHAT_ID");

  if (!TG_TOKEN || !TG_CHAT) {
    if (process.env.NODE_ENV !== "production")
      console.warn("[Notify] Telegram admin sin configurar — andá a /config para cargarlo");
    return { ok: false, error: "Telegram admin sin configurar" };
  }

  try {
    const fetchFn = typeof fetch === "function"
      ? fetch
      : (await import("node-fetch")).default;

    const r = await fetchFn(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000), // O5 — sin timeout, Telegram colgado bloquea el caller
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:    TG_CHAT,
        text,
        parse_mode: opts.parse_mode || "MarkdownV2",
        disable_web_page_preview: true,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || body.ok === false) {
      const desc = body.description || `HTTP ${r.status}`;
      console.error(`[Notify] Telegram falló: ${desc}`);
      return { ok: false, error: desc };
    }
    return { ok: true, message_id: body.result?.message_id };
  } catch (e) {
    console.error("[Notify] Telegram error:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── Eventos ─────────────────────────────────────────────────

function notifyNewUser(user, meta = {}) {
  const lines = [
    "🌱 *Agro Parallel — Nuevo usuario en OrbitX*",
    "",
    `*Nombre:* ${escapeMd(user.nombre || "—")}`,
    `*Email:* ${escapeMd(user.email || "—")}`,
    `*Teléfono:* ${escapeMd(user.telefono || "—")}`,
    `*Organización:* ${escapeMd(meta.org_nombre || user.org_nombre || (meta.via_invitacion ? "vía invitación" : "Registro directo"))}`,
    `*Vía:* ${escapeMd(meta.via_invitacion ? "Invitación" : "Registro self\\-service")}`,
    `*Estado:* ${escapeMd(meta.estado || "pendiente de aprobación")}`,
    "",
    `🕒 ${escapeMd(fmtAR(Date.now()))}`,
    `🌐 ${escapeMd(meta.ip || "—")}`,
    `🧭 ${escapeMd((meta.user_agent || "—").slice(0, 80))}`,
  ];
  return sendTelegram(lines.join("\n"));
}

function notifyNewOrg(org, meta = {}) {
  const lines = [
    "🏞 *Agro Parallel — Nueva organización aprobada*",
    "",
    `*Nombre:* ${escapeMd(org.nombre || "—")}`,
    `*Slug:* \`${escapeMd(org.slug || "—")}\``,
    `*Hectáreas:* ${escapeMd(org.ha_total || "—")}`,
    `*Provincia:* ${escapeMd(org.provincia || "—")}`,
    `*Owner:* ${escapeMd(meta.owner_nombre || org.owner_uid || "—")}`,
    "",
    `🕒 ${escapeMd(fmtAR(Date.now()))}`,
  ];
  return sendTelegram(lines.join("\n"));
}

function notifyFirmwareSubido(fw, meta = {}) {
  const lines = [
    "📦 *Agro Parallel — Firmware subido*",
    "",
    `*Producto:* ${escapeMd(fw.producto || "—")}`,
    `*Versión:* \`${escapeMd(fw.version || "—")}\``,
    `*SHA256:* \`${escapeMd((fw.hash_sha256 || "").slice(0, 16))}…\``,
    `*Tamaño:* ${escapeMd(((fw.tamano_bytes || 0) / 1024).toFixed(1))} KB`,
    `*Subido por:* ${escapeMd(meta.subido_por_nombre || fw.subido_por_uid || "—")}`,
    `*Changelog:* ${escapeMd((fw.changelog || "").slice(0, 200))}`,
    "",
    `🕒 ${escapeMd(fmtAR(Date.now()))}`,
  ];
  return sendTelegram(lines.join("\n"));
}

function notifyOTAResult(log, meta = {}) {
  const icon = log.resultado === "ok" ? "✅" : log.resultado === "timeout" ? "⌛" : "❌";
  const lines = [
    `${icon} *Agro Parallel — OTA ${escapeMd(log.resultado || "desconocido")}*`,
    "",
    `*Dispositivo:* \`${escapeMd(log.device_id || "—")}\``,
    `*Producto:* ${escapeMd(log.producto || "—")}`,
    `*Versión:* ${escapeMd(log.version_anterior || "?")} → ${escapeMd(log.version_nueva || "?")}`,
    `*Disparado por:* ${escapeMd(meta.disparado_por_nombre || log.disparado_por_uid || "—")}`,
    log.error ? `*Error:* ${escapeMd(log.error.slice(0, 200))}` : "",
    "",
    `🕒 ${escapeMd(fmtAR(log.ts || Date.now()))}`,
  ].filter(Boolean);
  return sendTelegram(lines.join("\n"));
}

function notifyLoginSospechoso(user, meta = {}) {
  const lines = [
    "🚨 *Agro Parallel — Login sospechoso*",
    "",
    `*Usuario:* ${escapeMd(user.email || user.uid || "—")}`,
    `*Motivo:* ${escapeMd(meta.motivo || "—")}`,
    `*IP:* ${escapeMd(meta.ip || "—")}`,
    `*UA:* ${escapeMd((meta.user_agent || "—").slice(0, 80))}`,
    "",
    `🕒 ${escapeMd(fmtAR(Date.now()))}`,
  ];
  return sendTelegram(lines.join("\n"));
}

// Genérica para cualquier alerta del sistema (caída de nodo, etc.).
function notifyEvento(titulo, datos = {}) {
  const lines = [
    `⚠️ *Agro Parallel — ${escapeMd(titulo)}*`,
    "",
    ...Object.entries(datos).map(([k, v]) => `*${escapeMd(k)}:* ${escapeMd(v)}`),
    "",
    `🕒 ${escapeMd(fmtAR(Date.now()))}`,
  ];
  return sendTelegram(lines.join("\n"));
}

module.exports = {
  notifyNewUser,
  notifyNewOrg,
  notifyFirmwareSubido,
  notifyOTAResult,
  notifyLoginSospechoso,
  notifyEvento,
  // Por si querés mandar texto plano:
  sendTelegram,
  escapeMd,
};
