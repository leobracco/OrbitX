// middleware/auth.js  v2 — con memberships multi-org
const jwt  = require("jsonwebtoken");
const { puede, aplicarRestricciones } = require("../roles");

const SECRET       = process.env.JWT_SECRET || "orbitx-dev-secret";
const DEVICE_TOKEN = process.env.DEVICE_MASTER_TOKEN || "vx-device-token";

function signToken(payload, expiresIn="30d") {
  return jwt.sign(payload, SECRET, { expiresIn });
}

// ── Middleware principal ──────────────────────────────────────
async function required(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  // Dispositivos (tractores): X-Device-ID + X-Auth-Token
  if (!token && req.headers["x-device-id"]) {
    if (req.headers["x-auth-token"] !== DEVICE_TOKEN)
      return res.status(401).json({ error: "Token de dispositivo inválido" });

    req.user = {
      uid:         req.headers["x-device-id"],
      rol:         "device",
      rol_global:  "device",
      estabSlug:   req.headers["x-estab-slug"] || "unknown",
      memberships: [],
      isDevice:    true
    };
    return next();
  }

  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const payload = jwt.verify(token, SECRET);

    // El JWT incluye memberships — no hay que ir a DB en cada request
    req.user = {
      uid:         payload.uid,
      rol_global:  payload.rol_global || "user",
      estabSlug:   payload.estabSlug,
      memberships: payload.memberships || [],
      isDevice:    false,
      // Rol efectivo en la org activa
      get rol() {
        if (this.rol_global === "superadmin") return "superadmin";
        const m = this.memberships.find(m => m.orgSlug === this.estabSlug);
        return m?.rol || "viewer";
      },
      // Restricciones en la org activa
      get restricciones() {
        const m = this.memberships.find(m => m.orgSlug === this.estabSlug);
        return m?.restricciones || null;
      }
    };
    next();
  } catch(e) {
    if (e.name === "TokenExpiredError")
      return res.status(401).json({ error: "Token expirado" });
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ── Middleware de permisos ────────────────────────────────────
function requirePermiso(recurso, accion) {
  return (req, res, next) => {
    if (req.user?.isDevice) return next(); // Los devices solo van a /sync
    const rol = req.user?.rol;
    if (!rol) return res.status(401).json({ error: "No autenticado" });

    // Verificar permiso de rol
    if (!puede(rol, recurso, accion))
      return res.status(403).json({ error:"Sin permiso", detalle:`'${rol}' no puede '${accion}' en '${recurso}'` });

    // Verificar restricciones granulares de la membresía
    if (!aplicarRestricciones(req.user.restricciones, recurso, accion))
      return res.status(403).json({ error:"Acceso restringido", detalle:"Restricción de membresía activa" });

    next();
  };
}

// ── Shortcuts ─────────────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (!["superadmin","owner","admin_org"].includes(req.user?.rol))
    return res.status(403).json({ error:"Se requiere owner o admin" });
  next();
};

const soloSuperadmin = (req, res, next) => {
  if (req.user?.rol !== "superadmin")
    return res.status(403).json({ error:"Solo superadmin" });
  next();
};

// ── Socket.IO ──────────────────────────────────────────────────
function socketMiddleware(socket, next) {
  const token = socket.handshake.auth?.token ||
                socket.handshake.headers["authorization"]?.slice(7);
  if (!token) return next(new Error("Auth requerida"));
  try {
    const p = jwt.verify(token, SECRET);
    socket.user = {
      uid:       p.uid,
      rol_global: p.rol_global || "user",
      estabSlug: p.estabSlug,
      memberships: p.memberships || []
    };
    next();
  } catch { next(new Error("Token inválido")); }
}

module.exports = { required, requirePermiso, adminOnly, soloSuperadmin, socketMiddleware, signToken };
