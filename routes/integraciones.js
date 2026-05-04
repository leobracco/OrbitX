// routes/integraciones.js — Catálogo de integraciones disponibles a la org.
// Las credenciales son GLOBALES de Agro Parallel (en /config). La org solo ve
// si está activa para todos o no — no carga nada.
"use strict";

const router = require("express").Router();
const cfg    = require("../services/config_sistema");

// GET /api/integraciones — listado read-only del estado global.
router.get("/", async (req, res) => {
  try {
    const all = await cfg.getAll();

    const integraciones = [
      {
        clave:       "copernicus",
        nombre:      "Copernicus Data Space",
        descripcion: "NDVI · Sentinel-2 · provisto por Agro Parallel",
        icono:       "🛰",
        activa:      !!(all.COPERNICUS_CLIENT_ID && all.COPERNICUS_CLIENT_SECRET && all.COPERNICUS_INSTANCE_ID),
        gestion:     "global",
      },
      {
        clave:       "telegram_admin",
        nombre:      "Telegram (admin Agro Parallel)",
        descripcion: "Notificaciones internas a Agro Parallel — no afecta al cliente",
        icono:       "✈",
        activa:      !!(all.TELEGRAM_ADMIN_BOT_TOKEN && all.TELEGRAM_ADMIN_CHAT_ID),
        gestion:     "global",
      },
      {
        clave:       "smtp",
        nombre:      "Email (SMTP global)",
        descripcion: "Verificación de email + recupero de contraseña",
        icono:       "✉",
        activa:      !!(all.SMTP_HOST && all.SMTP_USER && all.SMTP_PASS),
        gestion:     "global",
      },
      {
        clave:       "whatsapp",
        nombre:      "WhatsApp Cloud API",
        descripcion: "Alertas y avisos al cliente vía WhatsApp",
        icono:       "💬",
        activa:      !!(all.WHATSAPP_PHONE_NUMBER_ID && all.WHATSAPP_ACCESS_TOKEN),
        gestion:     "global",
      },
      {
        clave:       "anthropic",
        nombre:      "agrarIA (Anthropic)",
        descripcion: "Análisis de lotes y resúmenes con Claude",
        icono:       "✦",
        activa:      !!all.ANTHROPIC_API_KEY,
        gestion:     "global",
      },
    ];

    res.json({ ok: true, integraciones });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Compat: si algún código viejo todavía consulta /copernicus, devolver el estado global.
router.get("/copernicus", async (req, res) => {
  try {
    const all = await cfg.getAll();
    const activa = !!(all.COPERNICUS_CLIENT_ID && all.COPERNICUS_CLIENT_SECRET && all.COPERNICUS_INSTANCE_ID);
    res.json({
      configurado:     activa,
      gestion:         "global",
      configurado_por: "Agro Parallel",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Endpoints de modificación quedan deprecated — devuelven 410 Gone con mensaje claro.
router.post("/copernicus", (req, res) => {
  res.status(410).json({
    error: "Las credenciales de Copernicus se gestionan de forma centralizada por Agro Parallel.",
  });
});
router.delete("/copernicus", (req, res) => {
  res.status(410).json({
    error: "Las credenciales de Copernicus se gestionan de forma centralizada por Agro Parallel.",
  });
});

// El módulo seguía exportando `decrypt` para que ndvi.js lo usara — ya no hace falta,
// pero exportamos un stub no-op por compatibilidad con código viejo.
module.exports.router  = router;
module.exports.decrypt = (s) => s;
