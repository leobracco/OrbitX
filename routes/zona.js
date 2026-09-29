// routes/zona.js — Datos zonales de los lotes de la org (departamento + rindes SAGyP).
const router = require("express").Router();

function estabDe(req) {
  return req.user?.estabSlug || req.jwtUser?.estabSlug || null;
}

// GET /api/zona/rindes — departamentos donde están los lotes y rindes por cultivo.
router.get("/rindes", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const puntos = await require("../lib/lotes-puntos").puntosLotes(estabSlug);
    if (!puntos.length) return res.json({ departamentos: [], lotes: 0 });
    const r = await require("../services/zona").rindesZona(puntos);
    res.json({ ...r, lotes: puntos.length, fuente: "Estimaciones agrícolas SAGyP · Georef IGN (datos.gob.ar)" });
  } catch (e) {
    console.error("[zona/rindes]", e.message);
    res.status(502).json({ error: `No se pudieron obtener los datos zonales: ${e.message}` });
  }
});

module.exports = router;
