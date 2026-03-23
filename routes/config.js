// routes/config.js
const router = require("express").Router();
const db     = require("../services/couchdb");

// GET /api/config/nodos
router.get("/nodos", async (req, res) => {
  try {
    const nodos = await db.getNodos(req.user.estabSlug);
    res.json(nodos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config/nodos/:uid
router.get("/nodos/:uid", async (req, res) => {
  try {
    const nodo = await db.getNodo(req.user.estabSlug, req.params.uid);
    res.json(nodo);
  } catch {
    res.status(404).json({ error: "Nodo no encontrado" });
  }
});

// PUT /api/config/nodos/:uid
router.put("/nodos/:uid", async (req, res) => {
  try {
    await db.upsertNodo(req.user.estabSlug, { ...req.body, uid: req.params.uid });
    req.io.to(`estab:${req.user.estabSlug}`).emit("config:nodo_actualizado", {
      uid: req.params.uid,
      ts: Date.now()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config/backups-aog
router.get("/backups-aog", async (req, res) => {
  try {
    const { maquina_id } = req.query;
    const backups = await db.getBackupsAOG(req.user.estabSlug, maquina_id || null);
    // No devolver el contenido base64 en el listado (muy pesado)
    const safe = backups.map(({ contenido_b64, ...rest }) => rest);
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/config/backups-aog/:id/download
router.get("/backups-aog/:id/download", async (req, res) => {
  try {
    const doc = await db.getDB(req.user.estabSlug).get(req.params.id);
    if (!doc.contenido_b64)
      return res.status(404).json({ error: "Contenido no disponible" });
    const buf = Buffer.from(doc.contenido_b64, "base64");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.archivo_nombre}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch {
    res.status(404).json({ error: "Backup no encontrado" });
  }
});

module.exports = router;
