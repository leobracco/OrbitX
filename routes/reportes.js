"use strict";
// GET /api/reportes/temporada?temporada=AAAA/AA[&estab=slug] — reporte de
// hectáreas trabajadas por lote + lluvias de la temporada. Superadmin puede
// pedir otra org con ?estab=; el resto solo la suya.
const router = require("express").Router();
const { reporteTemporada } = require("../services/reportes");

router.get("/temporada", async (req, res) => {
  try {
    const esSA = req.user?.rol_global === "superadmin";
    const slug = (esSA && typeof req.query.estab === "string" && req.query.estab) ? req.query.estab : req.user?.estabSlug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });
    res.json(await reporteTemporada(slug, req.query.temporada));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reportes/temporada/vista — Tarea 7 agrega acá la vista HTML.

module.exports = router;
