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

// ── Historial de avisos (Sprint 2) ──────────────────────────
const notis = require("../lib/notificaciones");

function orgDe(req) {
  const slug = req.user?.estabSlug;
  if (!slug) { const e = new Error("Sin org activa"); e.status = 400; throw e; }
  return slug;
}

// GET /api/notif-org/historial?limit=50&antes_de=<ts>
// Paginación por cursor sobre ts descendente (nunca skip).
router.get("/historial", async (req, res) => {
  try {
    const orgSlug = orgDe(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const items = await notis.listar(orgSlug, { limit: limit + 1, antesDe: req.query.antes_de || null });
    const hayMas = items.length > limit;
    const pagina = hayMas ? items.slice(0, limit) : items;
    const lectura = await notis.getLectura(orgSlug, req.user.uid);
    res.json({
      ok: true,
      items: pagina.map(n => ({ ...n, leida: notis.estaLeida(n, lectura) })),
      hay_mas: hayMas,
      cursor: pagina.length ? pagina[pagina.length - 1].ts : null,
      no_leidas: notis.contarNoLeidas(pagina, lectura),
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// GET /api/notif-org/no-leidas — barato, para el badge de la campanita.
// Consulta propia (solo _id/ts, sin titulo/cuerpo) vía notis.noLeidas().
router.get("/no-leidas", async (req, res) => {
  try {
    const orgSlug = orgDe(req);
    const { no_leidas, hay_mas } = await notis.noLeidas(orgSlug, req.user.uid);
    res.json({ ok: true, no_leidas, hay_mas });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/notif-org/:id/leida
router.post("/:id/leida", async (req, res) => {
  try {
    await notis.marcarUna(orgDe(req), req.user.uid, req.params.id, req.body?.ts);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/notif-org/leidas — marca todo lo anterior a `ts` (default: ahora).
router.post("/leidas", async (req, res) => {
  try {
    await notis.marcarTodas(orgDe(req), req.user.uid, req.body?.ts);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
