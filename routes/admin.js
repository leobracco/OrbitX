// routes/admin.js — Endpoints administrativos
// El middleware auth.adminOnly aplicado en server.js permite owner/admin_org/superadmin,
// pero los endpoints CROSS-ORG de acá deben restringirse a superadmin para no leakear data.
const router  = require("express").Router();
const db      = require("../services/couchdb");
const { soloSuperadmin } = require("../middleware/auth");

// GET /api/admin/stats — resumen GLOBAL de la plataforma (cross-org)
router.get("/stats", soloSuperadmin, async (req, res) => {
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

// POST /api/admin/establecimiento — crear nueva org. Solo superadmin.
router.post("/establecimiento", soloSuperadmin, async (req, res) => {
  try {
    const { nombre, slug, ha_total, provincia } = req.body;
    if (!nombre || !slug)
      return res.status(400).json({ error: "Hace falta nombre y slug" });

    await db.bootstrapEstablecimiento(slug);
    await db.upsertEstablecimiento({ nombre, slug, ha_total, provincia });

    console.log(`[Admin] Establecimiento creado: ${slug}`);
    res.json({ ok: true, slug, db: `orbitx_${slug}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/usuarios — listado de TODOS los usuarios. Solo superadmin.
// Para listar usuarios de tu propia org usá /api/auth/equipo.
router.get("/usuarios", soloSuperadmin, async (req, res) => {
  try {
    const gdb = db.getDB("global");
    let docs = [];
    try {
      const r = await gdb.find({ selector: { tipo: "usuario" }, limit: 500 });
      docs = r.docs;
    } catch {
      const all = await gdb.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d => d.tipo === "usuario");
    }
    res.json(docs.map(({ password_hash, reset_token, reset_token_exp, ...safe }) => safe));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/usuario/:uid — desactivar usuario a nivel plataforma. Solo superadmin.
router.delete("/usuario/:uid", soloSuperadmin, async (req, res) => {
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
