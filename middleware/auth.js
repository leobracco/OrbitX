// middleware/auth.js — OrbitX · auto-contenido sin dependencias externas
const jwt = require("jsonwebtoken");

const SECRET       = process.env.JWT_SECRET            || "orbitx-dev-secret-cambiar";
const DEVICE_TOKEN = process.env.DEVICE_MASTER_TOKEN   || "vx-device-token";

function signToken(payload, expiresIn = "30d") {
  return jwt.sign(payload, SECRET, { expiresIn });
}

async function required(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token && req.headers["x-device-id"]) {
    if (req.headers["x-auth-token"] !== DEVICE_TOKEN)
      return res.status(401).json({ error: "Token de dispositivo inválido" });
    req.user = { uid: req.headers["x-device-id"], rol: "device", rol_global: "device",
                 estabSlug: req.headers["x-estab-slug"] || "unknown", memberships: [], isDevice: true };
    return next();
  }

  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const payload = jwt.verify(token, SECRET);
    req.user = {
      uid: payload.uid, rol_global: payload.rol_global || payload.rol || "user",
      estabSlug: payload.estabSlug, memberships: payload.memberships || [], isDevice: false,
      get rol() {
        if (this.rol_global === "superadmin") return "superadmin";
        const m = (this.memberships || []).find(m => m.orgSlug === this.estabSlug);
        return m?.rol || this.rol_global || "viewer";
      }
    };
    next();
  } catch (e) {
    if (e.name === "TokenExpiredError") return res.status(401).json({ error: "Token expirado" });
    return res.status(401).json({ error: "Token inválido" });
  }
}

function adminOnly(req, res, next) {
  const rol = req.user?.rol || req.user?.rol_global;
  if (!["superadmin","owner","admin_org"].includes(rol))
    return res.status(403).json({ error: "Permiso insuficiente" });
  next();
}

function soloSuperadmin(req, res, next) {
  if (!["superadmin"].includes(req.user?.rol || req.user?.rol_global))
    return res.status(403).json({ error: "Solo superadmin" });
  next();
}

const PERMS = {
  superadmin: { usuarios:["r","w","d","i"], lotes:["r","w","d"], alertas:["r","w","d"], dispositivos:["r","w","d"], audit_log:["r"] },
  owner:      { usuarios:["r","w","d","i"], lotes:["r","w","d"], alertas:["r","w"],     dispositivos:["r","w"],     audit_log:["r"] },
  admin_org:  { usuarios:["r","w","i"],     lotes:["r","w"],     alertas:["r","w"],     dispositivos:["r","w"],     audit_log:["r"] },
  agronomo:   { usuarios:[],               lotes:["r"],          alertas:["r"],         dispositivos:["r"],         audit_log:[] },
  contratista:{ usuarios:[],               lotes:["r"],          alertas:["r","w"],     dispositivos:["r"],         audit_log:[] },
  operador:   { usuarios:[],               lotes:["r"],          alertas:["r","w"],     dispositivos:["r"],         audit_log:[] },
  viewer:     { usuarios:[],               lotes:["r"],          alertas:["r"],         dispositivos:[],            audit_log:[] },
};
const AM = { read:"r", write:"w", delete:"d", invite:"i" };

function requirePermiso(recurso, accion) {
  return (req, res, next) => {
    if (req.user?.isDevice) return next();
    const rol = req.user?.rol || "viewer";
    const a   = AM[accion] || accion;
    if (!(PERMS[rol]?.[recurso] || []).includes(a))
      return res.status(403).json({ error:"Sin permiso", detalle:`'${rol}' no puede '${accion}' en '${recurso}'` });
    next();
  };
}

function socketMiddleware(socket, next) {
  const token = socket.handshake.auth?.token || (socket.handshake.headers["authorization"]||"").slice(7);
  if (!token) return next(new Error("Auth requerida"));
  try {
    const p = jwt.verify(token, SECRET);
    socket.user = { uid:p.uid, rol_global:p.rol_global||"user", estabSlug:p.estabSlug, memberships:p.memberships||[] };
    next();
  } catch { next(new Error("Token inválido")); }
}

module.exports = { required, adminOnly, soloSuperadmin, requirePermiso, socketMiddleware, signToken };
