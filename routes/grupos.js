// routes/grupos.js — Gestión de grupos con permisos personalizados
const router = require("express").Router();
const db     = require("../services/couchdb");
const { registrarAudit } = require("../services/auth_service");

// ── Recursos disponibles ──────────────────────────────────
const RECURSOS = ["mapa", "vistax", "dispositivos", "alertas", "usuarios"];
const ACCIONES = ["read", "write", "admin"];

// ── Helpers ───────────────────────────────────────────────
const globalDB  = () => db.getDB("global");
const slugify   = s => s.toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_")
  .replace(/_+/g, "_").slice(0, 40);

async function getAllDocs(cdb) {
  const all = await cdb.list({ include_docs: true });
  return all.rows.map(r => r.doc).filter(d => !d._id.startsWith("_design"));
}

// ── Middleware: solo superadmin puede gestionar grupos ────
function soloAdmin(req, res, next) {
  if (req.user?.rol_global !== "superadmin")
    return res.status(403).json({ error: "Solo superadmin puede gestionar grupos" });
  next();
}

// ══════════════════════════════════════════════════════════
//  GET /api/grupos — listar todos los grupos
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const gdb = globalDB();
    let grupos = [];
    try {
      const r = await gdb.find({ selector: { tipo: "grupo" }, limit: 200 });
      grupos = r.docs;
    } catch {
      const docs = await getAllDocs(gdb);
      grupos = docs.filter(d => d.tipo === "grupo");
    }

    // Contar usuarios por grupo
    let membs = [];
    try {
      const r = await gdb.find({ selector: { tipo: "membresia_grupo", activa: true }, limit: 1000 });
      membs = r.docs;
    } catch {
      const docs = await getAllDocs(gdb);
      membs = docs.filter(d => d.tipo === "membresia_grupo" && d.activa);
    }

    const conteo = {};
    membs.forEach(m => { conteo[m.grupo_id] = (conteo[m.grupo_id] || 0) + 1; });

    res.json(grupos.map(g => ({ ...g, usuarios_count: conteo[g._id] || 0 })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/grupos/recursos — lista de recursos y acciones
// ══════════════════════════════════════════════════════════
router.get("/recursos", (req, res) => {
  res.json({ recursos: RECURSOS, acciones: ACCIONES });
});

// ══════════════════════════════════════════════════════════
//  POST /api/grupos — crear grupo
// ══════════════════════════════════════════════════════════
router.post("/", soloAdmin, async (req, res) => {
  const { nombre, descripcion, permisos, color } = req.body;
  if (!nombre) return res.status(400).json({ error: "nombre requerido" });

  try {
    const gdb   = globalDB();
    const id    = `grupo_${slugify(nombre)}_${Date.now().toString(36)}`;
    const now   = Date.now();

    // Normalizar permisos: { mapa: ['read','write'], vistax: ['read'], ... }
    const permisosNorm = {};
    RECURSOS.forEach(r => {
      const p = permisos?.[r] || [];
      permisosNorm[r] = Array.isArray(p) ? p.filter(a => ACCIONES.includes(a)) : [];
    });

    await gdb.insert({
      _id:         id,
      tipo:        "grupo",
      nombre,
      descripcion: descripcion || "",
      color:       color || "#3C9EFF",
      permisos:    permisosNorm,
      creado_por:  `usr_${req.user.uid}`,
      created_at:  now,
      updated_at:  now,
    });

    await registrarAudit(null, `usr_${req.user.uid}`, "grupo.crear", { nombre, id });
    console.log(`[Grupos] Creado: ${nombre} (${id})`);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/grupos/:id — detalle de un grupo
// ══════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  try {
    const gdb   = globalDB();
    const grupo = await gdb.get(req.params.id).catch(() => null);
    if (!grupo || grupo.tipo !== "grupo")
      return res.status(404).json({ error: "Grupo no encontrado" });

    // Traer usuarios del grupo
    let membs = [];
    try {
      const r = await gdb.find({ selector: { tipo: "membresia_grupo", grupo_id: req.params.id, activa: true }, limit: 200 });
      membs = r.docs;
    } catch {
      const docs = await getAllDocs(gdb);
      membs = docs.filter(d => d.tipo === "membresia_grupo" && d.grupo_id === req.params.id && d.activa);
    }

    // Enriquecer con datos de usuario
    const usuarios = await Promise.all(
      membs.map(async m => {
        const u = await gdb.get(m.uid).catch(() => null);
        return u ? { uid: m.uid, nombre: u.nombre, email: u.email, memb_id: m._id } : null;
      })
    );

    res.json({ ...grupo, usuarios: usuarios.filter(Boolean) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  PATCH /api/grupos/:id — editar grupo
// ══════════════════════════════════════════════════════════
router.patch("/:id", soloAdmin, async (req, res) => {
  try {
    const gdb   = globalDB();
    const grupo = await gdb.get(req.params.id).catch(() => null);
    if (!grupo || grupo.tipo !== "grupo")
      return res.status(404).json({ error: "Grupo no encontrado" });

    const { nombre, descripcion, permisos, color } = req.body;

    let permisosNorm = grupo.permisos;
    if (permisos) {
      permisosNorm = {};
      RECURSOS.forEach(r => {
        const p = permisos[r] || [];
        permisosNorm[r] = Array.isArray(p) ? p.filter(a => ACCIONES.includes(a)) : [];
      });
    }

    await gdb.insert({
      ...grupo,
      nombre:      nombre      || grupo.nombre,
      descripcion: descripcion !== undefined ? descripcion : grupo.descripcion,
      color:       color       || grupo.color,
      permisos:    permisosNorm,
      updated_at:  Date.now(),
    });

    await registrarAudit(null, `usr_${req.user.uid}`, "grupo.editar", { id: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/grupos/:id — borrar grupo
// ══════════════════════════════════════════════════════════
router.delete("/:id", soloAdmin, async (req, res) => {
  try {
    const gdb   = globalDB();
    const grupo = await gdb.get(req.params.id).catch(() => null);
    if (!grupo || grupo.tipo !== "grupo")
      return res.status(404).json({ error: "Grupo no encontrado" });

    // Desactivar todas las membresías
    let membs = [];
    try {
      const r = await gdb.find({ selector: { tipo: "membresia_grupo", grupo_id: req.params.id }, limit: 500 });
      membs = r.docs;
    } catch {}
    for (const m of membs) {
      await gdb.insert({ ...m, activa: false, updated_at: Date.now() }).catch(() => {});
    }

    await gdb.destroy(grupo._id, grupo._rev);
    await registrarAudit(null, `usr_${req.user.uid}`, "grupo.borrar", { id: req.params.id, nombre: grupo.nombre });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/grupos/:id/usuarios — agregar usuario al grupo
// ══════════════════════════════════════════════════════════
router.post("/:id/usuarios", soloAdmin, async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: "uid requerido" });

  try {
    const gdb   = globalDB();
    const grupo = await gdb.get(req.params.id).catch(() => null);
    if (!grupo || grupo.tipo !== "grupo")
      return res.status(404).json({ error: "Grupo no encontrado" });

    const user = await gdb.get(uid).catch(() => null);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // Verificar que no esté ya en el grupo
    let existing = null;
    try {
      const r = await gdb.find({ selector: { tipo: "membresia_grupo", grupo_id: req.params.id, uid }, limit: 1 });
      existing = r.docs[0] || null;
    } catch {}

    if (existing) {
      // Reactivar si estaba inactivo
      if (!existing.activa) {
        await gdb.insert({ ...existing, activa: true, updated_at: Date.now() });
        return res.json({ ok: true, reactivado: true });
      }
      return res.status(409).json({ error: "El usuario ya está en el grupo" });
    }

    const now = Date.now();
    await gdb.insert({
      _id:        `memb_grupo_${req.params.id}_${uid}_${now}`,
      tipo:       "membresia_grupo",
      grupo_id:   req.params.id,
      grupo_nombre: grupo.nombre,
      uid,
      activa:     true,
      agregado_por: `usr_${req.user.uid}`,
      created_at: now,
      updated_at: now,
    });

    await registrarAudit(null, `usr_${req.user.uid}`, "grupo.agregar_usuario", { grupo: req.params.id, uid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/grupos/:id/usuarios/:uid — quitar usuario
// ══════════════════════════════════════════════════════════
router.delete("/:id/usuarios/:uid", soloAdmin, async (req, res) => {
  try {
    const gdb = globalDB();
    let memb = null;
    try {
      const r = await gdb.find({ selector: { tipo: "membresia_grupo", grupo_id: req.params.id, uid: req.params.uid, activa: true }, limit: 1 });
      memb = r.docs[0] || null;
    } catch {}

    if (!memb) return res.status(404).json({ error: "Membresía no encontrada" });
    await gdb.insert({ ...memb, activa: false, updated_at: Date.now() });
    await registrarAudit(null, `usr_${req.user.uid}`, "grupo.quitar_usuario", { grupo: req.params.id, uid: req.params.uid });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/grupos/usuario/:uid — grupos de un usuario
// ══════════════════════════════════════════════════════════
router.get("/usuario/:uid", async (req, res) => {
  try {
    const gdb = globalDB();
    let membs = [];
    try {
      const r = await gdb.find({ selector: { tipo: "membresia_grupo", uid: req.params.uid, activa: true }, limit: 100 });
      membs = r.docs;
    } catch {
      const docs = await getAllDocs(gdb);
      membs = docs.filter(d => d.tipo === "membresia_grupo" && d.uid === req.params.uid && d.activa);
    }

    const grupos = await Promise.all(
      membs.map(m => gdb.get(m.grupo_id).catch(() => null))
    );

    res.json(grupos.filter(Boolean));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
