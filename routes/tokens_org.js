"use strict";
// routes/tokens_org.js — Alta, listado y revocación de tokens de lectura de la
// organización. Se monta con auth.required + auth.adminOnly: solo owner,
// admin_org o superadmin administran tokens de su org.
const router = require("express").Router();
const tokens = require("../services/tokens_org");

function orgDe(req) {
  const slug = req.user?.estabSlug;
  if (!slug) { const e = new Error("Sin organización activa"); e.status = 400; throw e; }
  return slug;
}

// GET /api/tokens-org — lista (nunca devuelve el token ni el hash).
router.get("/", async (req, res) => {
  try {
    res.json({ ok: true, tokens: await tokens.listar(orgDe(req)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/tokens-org — crea y devuelve el token en claro UNA sola vez.
router.post("/", async (req, res) => {
  try {
    const { nombre, dias } = req.body || {};
    const { doc, token } = await tokens.crear({
      orgSlug: orgDe(req),
      nombre,
      dias,
      creadoPor: req.user?.uid || "system",
    });
    res.json({
      ok: true,
      token,                                  // se muestra una vez y no vuelve nunca más
      aviso: "Copiá el token ahora: no se puede volver a ver.",
      doc: { _id: doc._id, nombre: doc.nombre, prefijo: doc.prefijo, vence_ts: doc.vence_ts },
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/tokens-org/:id/revocar
router.post("/:id/revocar", async (req, res) => {
  try {
    const slug = orgDe(req);
    const doc = await tokens.revocar(req.params.id, req.user?.uid);
    if (doc.org_slug !== slug && req.user?.rol_global !== "superadmin")
      return res.status(403).json({ error: "Ese token no es de tu organización" });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
