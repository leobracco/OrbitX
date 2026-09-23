"use strict";
// GET /api/reportes/temporada?temporada=AAAA/AA[&estab=slug] — reporte de
// hectáreas trabajadas por lote + lluvias de la temporada. Superadmin puede
// pedir otra org con ?estab=; el resto solo la suya.
const router = require("express").Router();
const { reporteTemporada } = require("../services/reportes");
const { temporadaActual, esTemporadaValida } = require("../services/temporada");
const couch = require("../services/couchdb");

// Nombre lindo de la org para la vista; si no está el doc, queda el slug.
async function nombreOrg(slug) {
  try { const o = await couch.getDB("global").get(`org_${slug}`); return o.nombre || slug; } catch { return slug; }
}

function resolverSlug(req) {
  const esSA = req.user?.rol_global === "superadmin";
  return (esSA && typeof req.query.estab === "string" && req.query.estab) ? req.query.estab : req.user?.estabSlug;
}

// Deriva la temporada "AAAA/AA" un año antes de la dada (ej: "2026/27" -> "2025/26").
function temporadaAnterior(temp) {
  const anio = Number(temp.slice(0, 4)) - 1;
  return `${anio}/${String((anio + 1) % 100).padStart(2, "0")}`;
}

router.get("/temporada", async (req, res) => {
  try {
    const slug = resolverSlug(req);
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });
    res.json(await reporteTemporada(slug, req.query.temporada));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /reportes/temporada/vista?temporada=AAAA/AA[&estab=slug] — vista HTML
// imprimible del reporte de temporada (mismo reporte que /temporada en JSON).
router.get("/temporada/vista", async (req, res) => {
  try {
    const slug = resolverSlug(req);
    if (!slug) return res.status(400).send("Sin establecimiento");
    const temp = esTemporadaValida(req.query.temporada) ? req.query.temporada : temporadaActual();
    const anterior = temporadaAnterior(temp);
    const anteanterior = temporadaAnterior(anterior);
    const temporadas = [temp, anterior, anteanterior];
    const r = await reporteTemporada(slug, temp);
    res.render("reporte-temporada", { r, org: await nombreOrg(slug), temporadas, emitido: new Date() });
  } catch (e) { res.status(500).type("text/plain").send(e.message); }
});

module.exports = router;
