"use strict";
// GET /api/actividad/resumen?temporada=AAAA/AA[&estab=slug] — resumen de la
// operación para el Inicio del panel y de la app móvil. Superadmin puede pedir
// otra org con ?estab=; el resto solo la suya.
const router = require("express").Router();
const { resumenActividad } = require("../services/actividad");

router.get("/resumen", async (req, res) => {
  try {
    const esSA = req.user?.rol_global === "superadmin";
    const slug = (esSA && typeof req.query.estab === "string" && req.query.estab) ? req.query.estab : req.user?.estabSlug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });
    res.json(await resumenActividad(slug, { temporada: req.query.temporada }));
  } catch (e) { console.error("[actividad]", e.message); res.status(500).json({ error: "Error interno" }); }
});
module.exports = router;
