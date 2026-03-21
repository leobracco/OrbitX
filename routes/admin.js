// routes/admin.js  — Solo owners/admins (protegido por auth.adminOnly en server.js)
const router = require("express").Router();
const db     = require("../services/couchdb");

// GET /api/admin/stats  — resumen global de la plataforma
router.get("/stats", async (req, res) => {
  try {
    const establecimientos = await db.getEstablecimientos();
    const stats = await Promise.all(
      establecimientos.map(async (e) => {
        const [lotes, alertas] = await Promise.all([
          db.getLotes(e.slug, { limit: 999 }).catch(() => []),
          db.getAlertasActivas(e.slug).catch(() => [])
        ]);
        return {
          slug:     e.slug,
          nombre:   e.nombre,
          lotes:    lotes.length,
          alertas:  alertas.length,
          usuarios: (e.usuarios || []).length
        };
      })
    );
    res.json({ establecimientos: stats, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/establecimiento  — crear nuevo establecimiento
router.post("/establecimiento", async (req, res) => {
  try {
    const { nombre, slug, ha_total, provincia } = req.body;
    if (!nombre || !slug)
      return res.status(400).json({ error: "nombre y slug son requeridos" });

    // Crear la DB en CouchDB
    await db.bootstrapEstablecimiento(slug);

    // Guardar el documento en orbitx_global
    await db.upsertEstablecimiento({ nombre, slug, ha_total, provincia });

    console.log(`[Admin] Establecimiento creado: ${slug}`);
    res.json({ ok: true, slug, db: `orbitx_${slug}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/usuarios  — listar todos los usuarios
router.get("/usuarios", async (req, res) => {
  try {
    const globalDB = db.getDB("global");
    const result   = await globalDB.find({
      selector: { tipo: "usuario" },
      fields: ["_id", "nombre", "email", "rol", "establecimientos", "created_at"]
    });
    res.json(result.docs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/usuario/:uid  — desactivar usuario
router.delete("/usuario/:uid", async (req, res) => {
  try {
    const globalDB = db.getDB("global");
    const doc      = await globalDB.get(`usr_${req.params.uid}`);
    await globalDB.insert({ ...doc, activo: false, updated_at: Date.now() });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "Usuario no encontrado" });
  }
});

module.exports = router;
