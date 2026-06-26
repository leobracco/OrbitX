// routes/auth.js — endpoints de autenticación
const router  = require("express").Router();
const svc     = require("../services/auth_service");
const { required, adminOnly, soloSuperadmin, requirePermiso } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rate-limit");
const { ROLES, rolesQuePuedeAsignar } = require("../roles");

// O14 — anti fuerza-bruta. Login/reset por IP+email; registro por IP.
const limLogin    = rateLimit({ windowMs: 15 * 60_000, max: 10,
  keyGenerator: (req) => `${req.socket?.remoteAddress}|${String(req.body?.email || "").toLowerCase()}` });
const limReset    = rateLimit({ windowMs: 15 * 60_000, max: 5,
  keyGenerator: (req) => `${req.socket?.remoteAddress}|${String(req.body?.email || "").toLowerCase()}` });
const limRegistro = rateLimit({ windowMs: 60 * 60_000, max: 10 });

// ── Registro self-service ────────────────────────────────────
router.post("/registro", limRegistro, async (req, res) => {
  try {
    const meta = {
      ip:         req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      user_agent: req.headers["user-agent"] || null,
    };
    await svc.iniciarRegistro(req.body, meta);
    res.json({ ok:true, mensaje:"Tu solicitud está siendo revisada por Agro Parallel" });
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
    const docs = await svc.getRegistrosPendientes();
    res.json(docs);
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
router.post("/login", limLogin, async (req, res) => {
  try {
    const { email, password, org } = req.body;
    // O3b — validar tipo: sin esto, `email:{"$gt":""}` se cuela como operador
    // Mango en findUser y matchea el primer usuario (enumeración / targeting).
    if (typeof email !== "string" || typeof password !== "string" || !email || !password)
      return res.status(400).json({ error:"Email y contraseña requeridos" });
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
    if (typeof orgSlug !== "string" || !orgSlug)
      return res.status(400).json({ error:"orgSlug requerido" });
    const r = await svc.cambiarOrg(req.user.uid, orgSlug);
    res.json(r);
  } catch(e) { res.status(e.status||500).json({ error:e.message }); }
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
router.post("/reset-password", limReset, async (req, res) => {
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
    const meta = {
      ip:         req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
      user_agent: req.headers["user-agent"] || null,
    };
    const r = await svc.aceptarInvitacion(req.params.token, req.body, meta);
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
