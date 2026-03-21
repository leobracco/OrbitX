// routes/auth.js — endpoints de autenticación
const router  = require("express").Router();
const svc     = require("../services/auth_service");
const { required, adminOnly, soloSuperadmin, requirePermiso } = require("../middleware/auth");
const { ROLES, rolesQuePuedeAsignar } = require("../roles");

// ── Registro self-service ────────────────────────────────────
router.post("/registro", async (req, res) => {
  try {
    await svc.iniciarRegistro(req.body);
    res.json({ ok:true, mensaje:"Revisá tu email para verificar tu cuenta" });
  } catch(e) { res.status(e.status||500).json({ error: e.message||"Error interno" }); }
});

router.get("/verificar/:token", async (req, res) => {
  try {
    const r = await svc.verificarEmail(req.params.token);
    res.json({ ok:true, org: r.org_nombre });
  } catch(e) { res.status(e.status||500).json({ error: e.message }); }
});

// ── Superadmin ───────────────────────────────────────────────
router.get("/registros-pendientes", required, soloSuperadmin, async (req, res) => {
  try {
    const db = req.app.locals.globalDB;
    const r  = await db.view("auth","registros_pendientes",{ include_docs:true, reduce:false, descending:true });
    res.json(r.rows.map(x=>x.doc));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post("/aprobar/:token", required, soloSuperadmin, async (req, res) => {
  try {
    const r = await svc.aprobarRegistro(req.params.token, req.user.uid);
    res.json({ ok:true, ...r });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.post("/rechazar/:token", required, soloSuperadmin, async (req, res) => {
  try {
    await svc.rechazarRegistro(req.params.token, req.user.uid, req.body.motivo||"");
    res.json({ ok:true });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

// ── Login ────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password, org } = req.body;
    if (!email||!password) return res.status(400).json({ error:"Email y contraseña requeridos" });
    const r = await svc.login(email, password, org||null);
    res.json(r);
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.get("/me", required, async (req, res) => {
  try {
    const db   = req.app.locals.globalDB;
    const user = await db.get(`usr_${req.user.uid}`);
    const { password_hash, reset_token, ...safe } = user;
    safe.memberships  = req.user.memberships;
    safe.rol_efectivo = req.user.rol;
    res.json(safe);
  } catch { res.status(404).json({ error:"Usuario no encontrado" }); }
});

router.post("/cambiar-org", required, async (req, res) => {
  try {
    const { orgSlug } = req.body;
    const tieneAcceso = req.user.memberships.some(m => m.orgSlug === orgSlug);
    if (!tieneAcceso && req.user.rol !== "superadmin")
      return res.status(403).json({ error:"Sin acceso a esa organización" });
    const jwt     = require("jsonwebtoken");
    const SECRET  = process.env.JWT_SECRET || "orbitx-dev-secret";
    const payload = jwt.verify(req.headers.authorization.slice(7), SECRET);
    const token   = jwt.sign({ ...payload, estabSlug:orgSlug }, SECRET, { expiresIn:"30d" });
    res.json({ token, orgSlug });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

router.post("/push-token", required, async (req, res) => {
  try {
    const db     = req.app.locals.globalDB;
    const user   = await db.get(`usr_${req.user.uid}`);
    const tokens = [...new Set([...(user.notificaciones?.push_tokens||[]), req.body.token])].slice(-5);
    await db.insert({ ...user, notificaciones:{...user.notificaciones, push_token:req.body.token, push_tokens:tokens}, updated_at:Date.now() });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Password reset ────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  try { await svc.solicitarReset(req.body.email); } catch {}
  res.json({ ok:true, mensaje:"Si el email existe, recibirás un link" });
});

router.post("/reset-password/:token", async (req, res) => {
  try {
    await svc.confirmarReset(req.params.token, req.body.password);
    res.json({ ok:true });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

// ── Invitaciones ─────────────────────────────────────────────
router.post("/invitar", required, requirePermiso("usuarios","invite"), async (req, res) => {
  try {
    const { email, nombre, rol, restricciones } = req.body;
    if (!email||!rol) return res.status(400).json({ error:"email y rol requeridos" });
    if (!ROLES[rol])  return res.status(400).json({ error:`Rol inválido: ${rol}` });
    const r = await svc.crearInvitacion({
      emailDestino:email, nombreDestino:nombre||"",
      orgSlug:req.user.estabSlug, rolAsignado:rol,
      restricciones:restricciones||null, invitadoPorUID:`usr_${req.user.uid}`
    });
    const link = `${process.env.BASE_URL||"http://localhost:4000"}/invitacion/${r.token}`;
    res.json({ ok:true, link, expira_at:r.expira_at });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.get("/invitacion/:token", async (req, res) => {
  try {
    const inv = await svc.getInvitacion(req.params.token);
    res.json({ orgNombre:inv.orgNombre, orgSlug:inv.orgSlug, rol:inv.rol_asignado,
               rol_label:ROLES[inv.rol_asignado]?.label, invitadoPor:inv.invitado_por_nombre,
               emailDestino:inv.email_destino, expira_at:inv.expira_at });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.post("/invitacion/:token/aceptar", async (req, res) => {
  try {
    const r = await svc.aceptarInvitacion(req.params.token, req.body);
    res.json(r);
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.get("/invitaciones-pendientes", required, requirePermiso("usuarios","invite"), async (req, res) => {
  try {
    const db = req.app.locals.globalDB;
    const r  = await db.view("auth","invitaciones_pendientes",{ key:req.user.estabSlug, include_docs:true, reduce:false });
    res.json(r.rows.map(x=>x.doc).map(({token,...s})=>s));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Equipo ───────────────────────────────────────────────────
router.get("/equipo", required, requirePermiso("usuarios","read"), async (req, res) => {
  try { res.json(await svc.getMiembros(req.user.estabSlug)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

router.patch("/equipo/:uid", required, requirePermiso("usuarios","write"), async (req, res) => {
  try {
    await svc.actualizarMembresia(req.params.uid, req.user.estabSlug, req.body, `usr_${req.user.uid}`);
    res.json({ ok:true });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.delete("/equipo/:uid", required, requirePermiso("usuarios","delete"), async (req, res) => {
  try {
    await svc.revocarAcceso(req.params.uid, req.user.estabSlug, `usr_${req.user.uid}`);
    res.json({ ok:true });
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
});

router.get("/roles-disponibles", required, (req, res) => {
  res.json(rolesQuePuedeAsignar(req.user.rol));
});

router.get("/audit", required, requirePermiso("audit_log","read"), async (req, res) => {
  try { res.json(await svc.getAuditLog(req.user.estabSlug, parseInt(req.query.limit)||100)); }
  catch(e) { res.status(500).json({ error:e.message }); }
});

module.exports = router;
