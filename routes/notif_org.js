// routes/notif_org.js — Config de notificaciones por org (destinatarios + switches por evento).
"use strict";

const router = require("express").Router();
const notif  = require("../lib/notify-org");

// GET /api/notif-org — config actual de la org del usuario.
router.get("/", async (req, res) => {
  try {
    const orgSlug = req.user?.estabSlug;
    if (!orgSlug) return res.status(400).json({ error: "Sin org activa" });
    const { notificaciones } = await notif.getConfigOrg(orgSlug);
    res.json({ ok: true, notificaciones, eventos: notif.EVENTOS });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// PUT /api/notif-org — guarda config (solo owner/admin_org/superadmin).
router.put("/", async (req, res) => {
  try {
    const orgSlug = req.user?.estabSlug;
    if (!orgSlug) return res.status(400).json({ error: "Sin org activa" });

    const rol = req.user?.rol || "";
    if (!["owner", "admin_org", "superadmin"].includes(rol))
      return res.status(403).json({ error: "Solo owner o admin pueden cambiar las notificaciones" });

    const byUid = req.user?.uid ? `usr_${req.user.uid}` : "system";
    await notif.setConfigOrg(orgSlug, req.body || {}, byUid);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/notif-org/test — manda una notificación de prueba a todos los canales habilitados.
router.post("/test", async (req, res) => {
  try {
    const orgSlug = req.user?.estabSlug;
    if (!orgSlug) return res.status(400).json({ error: "Sin org activa" });
    const r = await notif.notify(orgSlug, "alerta_critica", {
      titulo: "Prueba de notificaciones",
      cuerpo: "Si recibiste este mensaje, los canales habilitados están funcionando.",
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
