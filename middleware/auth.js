// middleware/auth.js — JWT + roles para OrbitX
const jwt = require("jsonwebtoken");
const db  = require("../services/couchdb");

const SECRET      = process.env.JWT_SECRET || "orbitx-dev-secret-cambiar";
const DEVICE_TOKEN= process.env.DEVICE_MASTER_TOKEN || "vx-device-token";

// ── Generar token ────────────────────────────────────────────
function signToken(payload, expiresIn = "30d") {
  return jwt.sign(payload, SECRET, { expiresIn });
}

// ── Middleware: requiere JWT válido ──────────────────────────
async function required(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;

  // También aceptar X-Device-ID + X-Auth-Token para los tractores
  if (!token && req.headers["x-device-id"]) {
    if (req.headers["x-auth-token"] === DEVICE_TOKEN) {
      req.user = {
        uid:       req.headers["x-device-id"],
        rol:       "device",
        estabSlug: req.headers["x-estab-slug"] || "unknown",
        isDevice:  true
      };
      return next();
    }
    return res.status(401).json({ error: "Token de dispositivo inválido" });
  }

  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const payload = jwt.verify(token, SECRET);
    // Verificar que el usuario sigue activo en CouchDB
    const user = await db.getUsuario(payload.uid).catch(() => null);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado" });

    req.user = {
      uid:       payload.uid,
      rol:       payload.rol,
      estabSlug: payload.estabSlug,
      nombre:    user.nombre,
      isDevice:  false
    };
    next();
  } catch (e) {
    if (e.name === "TokenExpiredError")
      return res.status(401).json({ error: "Token expirado" });
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ── Middleware: solo admin/owner ─────────────────────────────
function adminOnly(req, res, next) {
  if (!["owner", "admin"].includes(req.user?.rol)) {
    return res.status(403).json({ error: "Permiso insuficiente" });
  }
  next();
}

// ── Middleware: socket.io ────────────────────────────────────
function socketMiddleware(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.headers["authorization"]?.slice(7);
  if (!token) return next(new Error("Auth requerida"));
  try {
    socket.user = jwt.verify(token, SECRET);
    next();
  } catch {
    next(new Error("Token inválido"));
  }
}

module.exports = { required, adminOnly, socketMiddleware, signToken };
