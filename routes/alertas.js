// routes/alertas.js
const router  = require("express").Router();
const db      = require("../services/couchdb");

// GET /api/alertas  — listar alertas activas del establecimiento
router.get("/", async (req, res) => {
  try {
    const alertas = await db.getAlertasActivas(req.user.estabSlug);
    res.json(alertas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/alertas/historial
router.get("/historial", async (req, res) => {
  try {
    const { limit } = req.query;
    const result = await db.getDB(req.user.estabSlug).find({
      selector: { tipo: "alerta" },
      sort: [{ ts_inicio: "desc" }],
      limit: parseInt(limit) || 100
    });
    res.json(result.docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/alertas/:id/resolver
router.patch("/:id/resolver", async (req, res) => {
  try {
    await db.resolverAlerta(req.user.estabSlug, req.params.id, req.user.uid);
    req.io.to(`estab:${req.user.estabSlug}`).emit("alerta:resuelta", {
      alertaId: req.params.id,
      uid: req.user.uid,
      ts: Date.now()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
