// ============================================================================
// routes/rustdesk.js — OrbitX como "API server" de RustDesk (agenda de soporte).
//
// En RustDesk → Ajustes → Red → API Server: https://orbitx.agroparallel.com/rustdesk
// Se inicia sesión con el usuario de OrbitX y la agenda lista los PilotX con su
// rustdesk_id, etiquetados por establecimiento. Diseño y protocolo:
// docs/superpowers/specs/2026-10-06-agenda-rustdesk-design.md
//
// API legacy del cliente (ab_model.dart): /api/ab/personal responde 404 para que
// el cliente caiga a GET /api/ab. Agenda de SOLO LECTURA: la fuente de verdad es
// OrbitX. Errores siempre { error } (lo que el cliente sabe mostrar).
// ============================================================================
"use strict";

const router = require("express").Router();
const db = require("../services/couchdb");
const svc = require("../services/auth_service");
const { required } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rate-limit");
const { puedeUsarAgenda, orgsVisibles, armarAgenda } = require("../services/rustdesk_ab");

const limLogin = rateLimit({ windowMs: 15 * 60_000, max: 10,
  keyGenerator: (req) => `rd|${req.socket?.remoteAddress}|${String(req.body?.username || "").toLowerCase()}` });

function usuarioRustdesk(u) {
  return {
    name:         u.email,
    display_name: u.nombre || u.email,
    email:        u.email,
    note:         "",
    status:       1,
    is_admin:     u.rol_global === "superadmin",
  };
}

// Solo usuarios de OrbitX con JWT (ni devices ni tokens de org) y con rol para la agenda.
function soloAgenda(req, res, next) {
  const u = req.user;
  if (!u || u.isDevice || u.isToken) return res.status(401).json({ error: "Iniciá sesión con tu usuario de OrbitX" });
  if (!puedeUsarAgenda(u.rol_global, u.memberships))
    return res.status(403).json({ error: "Tu usuario no tiene acceso a la agenda de soporte" });
  next();
}

router.post("/api/login", limLogin, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string" || !username || !password)
    return res.status(400).json({ error: "Email y contraseña requeridos" });
  try {
    const r = await svc.login(username.trim(), password, null);
    if (!puedeUsarAgenda(r.user.rol_global, r.user.memberships))
      return res.status(403).json({ error: "Tu usuario no tiene acceso a la agenda de soporte" });
    res.json({ type: "access_token", access_token: r.token, user: usuarioRustdesk(r.user) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "No se pudo iniciar sesión" });
  }
});

router.post("/api/currentUser", required, soloAgenda, async (req, res) => {
  try {
    const u = await db.getDB("global").get(`usr_${req.user.uid}`);
    res.json(usuarioRustdesk({ ...u, rol_global: req.user.rol_global }));
  } catch {
    res.status(401).json({ error: "Usuario no encontrado" });
  }
});

router.post("/api/logout", (_req, res) => res.json({}));
router.get("/api/login-options", (_req, res) => res.json([]));

// 404 a propósito: es la señal para que el cliente use la agenda legacy.
router.post("/api/ab/personal", (_req, res) => res.status(404).json({ error: "not found" }));

router.get("/api/ab", required, soloAgenda, async (req, res) => {
  try {
    const g = db.getDB("global");
    const [rDev, rOrg] = await Promise.all([
      g.find({ selector: { tipo: "device" }, fields: ["device_id", "nombre", "hostname", "estab_slug", "rustdesk_id"], limit: 1000 }),
      g.find({ selector: { tipo: { $in: ["org", "establecimiento"] } }, fields: ["slug", "nombre"], limit: 500 }),
    ]);
    const ab = armarAgenda({
      devices:  rDev.docs || [],
      orgs:     rOrg.docs || [],
      visibles: orgsVisibles(req.user.rol_global, req.user.memberships),
    });
    res.json({ data: JSON.stringify(ab) });
  } catch (e) {
    console.error("[rustdesk/ab]", e.message);
    res.status(500).json({ error: "No se pudo armar la agenda" });
  }
});

router.post("/api/ab", required, soloAgenda, (_req, res) =>
  res.json({ error: "La agenda la administra OrbitX: los cambios se hacen en el panel (Dispositivos)" }));

// El cliente los manda solo por tener API server propio; no guardamos nada.
router.post(["/api/heartbeat", "/api/sysinfo", "/api/sysinfo_ver"], (_req, res) => res.json({}));

module.exports = router;
