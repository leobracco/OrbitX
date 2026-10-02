// routes/admin.js — Endpoints administrativos
// El middleware auth.adminOnly aplicado en server.js permite owner/admin_org/superadmin,
// pero los endpoints CROSS-ORG de acá deben restringirse a superadmin para no leakear data.
const router  = require("express").Router();
const db      = require("../services/couchdb");
const { soloSuperadmin } = require("../middleware/auth");
const { normalizarCuit, validarCambiosOrg } = require("../lib/org-datos");

// Orgs reales de producción: docs `org_<slug>` con tipo:"org" en orbitx_global.
// (db.getEstablecimientos() consulta el tipo legacy "establecimiento" y devuelve vacío.)
async function getOrgs() {
  const gdb = db.getDB("global");
  try {
    const r = await gdb.find({ selector: { tipo: "org" }, limit: 200 });
    return r.docs;
  } catch {
    const all = await gdb.list({ include_docs: true });
    return all.rows.map(r => r.doc).filter(d => d && d.tipo === "org");
  }
}

// GET /api/admin/orgs — lista liviana de orgs para el selector del superadmin
router.get("/orgs", soloSuperadmin, async (req, res) => {
  try {
    const orgs = await getOrgs();
    res.json(orgs
      .map(o => ({ slug: o.slug, nombre: o.nombre, activa: o.activa !== false }))
      .sort((a, b) => (a.nombre || a.slug).localeCompare(b.nombre || b.slug)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/org — crea una ORGANIZACION real (doc org_<slug>, tipo "org",
// igual que la aprobacion de registro en auth_service) + su base orbitx_<slug>.
// Lo usa el instalador LAN de pantallas (Tools/provision-server) para dar de
// alta un cliente nuevo y asignarle equipos sin pasar por el registro web.
// Solo superadmin. El owner queda el superadmin que la crea; despues se puede
// invitar al cliente desde el panel.
router.post("/org", soloSuperadmin, async (req, res) => {
  try {
    const { nombre, slug, provincia, ciudad } = req.body || {};
    let cuit = "";
    try { cuit = normalizarCuit(req.body?.cuit); }
    catch (e) { return res.status(e.status).json({ error: e.message }); }
    if (String(nombre || "").includes("�"))
      return res.status(400).json({ error: "El nombre tiene un carácter roto (�): revisá los acentos" });
    if (!nombre || !slug) return res.status(400).json({ error: "Hace falta nombre y slug" });
    if (!/^[a-z0-9_]{3,40}$/.test(slug))
      return res.status(400).json({ error: "Slug invalido: minusculas, numeros y _ (3 a 40)" });
    const gdb = db.getDB("global");
    const existe = await gdb.get(`org_${slug}`).catch(() => null);
    if (existe) return res.status(409).json({ error: `La organizacion '${slug}' ya existe` });
    const now = Date.now();
    await gdb.insert({
      _id: `org_${slug}`,
      tipo: "org",
      nombre, slug, cuit,
      ha_total: null, provincia: provincia || "", pais: "Argentina",
      ciudad: ciudad || "", lat: null, lon: null,
      plan: "pro", plan_vence: null, activa: true, aprobada: true,
      modulos: ["vistax", "linex", "centrix"],
      limites: { usuarios_max: 20, dispositivos_max: 10, ha_max: null },
      owner_uid: `usr_${req.user.uid}`,
      aprobado_por: `usr_${req.user.uid}`,
      creado_via: "admin_api",
      created_at: now, updated_at: now
    });
    await db.bootstrapEstablecimiento(slug);
    console.log(`[Admin] Org creada por API: ${slug} (${nombre})`);
    res.json({ ok: true, slug, nombre });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/admin/org/:slug — corregir nombre y/o CUIT de una org (superadmin).
router.put("/org/:slug", soloSuperadmin, async (req, res) => {
  try {
    const cambios = validarCambiosOrg(req.body || {});
    const gdb = db.getDB("global");
    const org = await gdb.get(`org_${req.params.slug}`).catch(() => null);
    if (!org) return res.status(404).json({ error: "No existe la organización" });
    Object.assign(org, cambios, { updated_at: Date.now() });
    await gdb.insert(org);
    console.log(`[Admin] Org ${req.params.slug} actualizada: ${Object.keys(cambios).join(", ")}`);
    res.json({ ok: true, slug: org.slug, nombre: org.nombre, cuit: org.cuit || "" });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/admin/stats — resumen GLOBAL de la plataforma (cross-org)
router.get("/stats", soloSuperadmin, async (req, res) => {
  try {
    const gdb  = db.getDB("global");
    const orgs = await getOrgs();
    const stats = await Promise.all(
      orgs.map(async (e) => {
        const [lotes, alertas, membs] = await Promise.all([
          db.getDB(e.slug).find({ selector: { tipo: "lote_maestro" }, fields: ["_id"], limit: 999 })
            .then(r => r.docs).catch(() => []),
          db.getAlertasActivas(e.slug).catch(() => []),
          gdb.find({ selector: { tipo: "membresia", orgSlug: e.slug, activa: true }, fields: ["_id"], limit: 500 })
            .then(r => r.docs).catch(() => [])
        ]);
        return {
          slug:     e.slug,
          nombre:   e.nombre,
          lotes:    lotes.length,
          alertas:  alertas.length,
          usuarios: membs.length
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
