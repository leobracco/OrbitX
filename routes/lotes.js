// routes/lotes.js — standalone, sin exports secundarios
const router  = require("express").Router();
const db      = require("../services/couchdb");
const agraria = require("../services/agraria");

// GET /api/lotes
router.get("/", async (req, res) => {
  try {
    const { estado, limit } = req.query;
    const lotes = await db.getLotes(req.user.estabSlug, {
      estado: estado || null,
      limit:  parseInt(limit) || 50
    });
    res.json(lotes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lotes/:id
router.get("/:id", async (req, res) => {
  try {
    const lote = await db.getLote(req.user.estabSlug, req.params.id);
    res.json(lote);
  } catch { res.status(404).json({ error: "Lote no encontrado" }); }
});

// GET /api/lotes/:id/densidades
router.get("/:id/densidades", async (req, res) => {
  try {
    const { limit } = req.query;
    const densidades = await db.getDensidadesPorLote(
      req.user.estabSlug, req.params.id, parseInt(limit) || 2000
    );
    res.json(densidades);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lotes/:id/analisis  — agrarIA
router.get("/:id/analisis", async (req, res) => {
  try {
    const resumen  = await db.getResumenLote(req.user.estabSlug, req.params.id);
    if (!resumen) return res.status(404).json({ error: "Lote no encontrado" });
    const analisis = await agraria.analizarLote(resumen);
    res.json({ resumen, analisis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
