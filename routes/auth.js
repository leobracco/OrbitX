// routes/auth.js
const router = require("express").Router();
const bcrypt = require("bcryptjs");
const db     = require("../services/couchdb");
const { signToken, required } = require("../middleware/auth");

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email y contraseña requeridos" });

    const user = await db.getUsuarioPorEmail(email);
    if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok)  return res.status(401).json({ error: "Credenciales inválidas" });

    const token = signToken({
      uid:       user._id.replace("usr_",""),
      rol:       user.rol,
      estabSlug: user.establecimientos?.[0] || "default"
    });

    res.json({
      token,
      user: {
        uid:    user._id,
        nombre: user.nombre,
        email:  user.email,
        rol:    user.rol,
        establecimientos: user.establecimientos,
        avatar_initials:  user.avatar_initials
      }
    });
  } catch (e) {
    console.error("[Auth] Login error:", e.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /api/auth/register  (solo admins pueden crear usuarios)
router.post("/register", required, async (req, res) => {
  if (!["owner","admin"].includes(req.user?.rol))
    return res.status(403).json({ error: "Sin permiso" });

  try {
    const { nombre, email, password, rol, estabSlug } = req.body;
    if (!nombre || !email || !password)
      return res.status(400).json({ error: "Datos incompletos" });

    const existing = await db.getUsuarioPorEmail(email).catch(() => null);
    if (existing) return res.status(409).json({ error: "Email ya registrado" });

    const uid  = email.split("@")[0].replace(/[^a-z0-9]/gi,"").toLowerCase() + Date.now().toString(36);
    const hash = await bcrypt.hash(password, 12);

    await db.upsertUsuario({
      uid,
      nombre,
      email,
      password_hash: hash,
      rol:           rol || "operator",
      establecimientos: [estabSlug || req.user.estabSlug],
      avatar_initials:  nombre.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
      notificaciones: { push_token:null, alertas_criticas:true, resumen_diario:true, cierre_lote:true }
    });

    res.json({ ok: true, uid });
  } catch (e) {
    console.error("[Auth] Register error:", e.message);
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /api/auth/me
router.get("/me", required, async (req, res) => {
  try {
    const user = await db.getUsuario(req.user.uid);
    const { password_hash, ...safe } = user;
    res.json(safe);
  } catch {
    res.status(404).json({ error: "Usuario no encontrado" });
  }
});

// POST /api/auth/push-token  (registrar FCM token)
router.post("/push-token", required, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token requerido" });
  await db.updatePushToken(req.user.uid, token);
  res.json({ ok: true });
});

module.exports = router;