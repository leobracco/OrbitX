// middleware/auth.js — OrbitX · auto-contenido sin dependencias externas
const jwt = require("jsonwebtoken");
const couch = require("../services/couchdb");

const DEFAULT_SECRET = "orbitx-dev-secret-cambiar";
const DEFAULT_DEVICE = "vx-device-token";
const SECRET       = process.env.JWT_SECRET            || DEFAULT_SECRET;
const DEVICE_TOKEN = process.env.DEVICE_MASTER_TOKEN   || DEFAULT_DEVICE;

// O1 — En producción, NUNCA arrancar con los defaults: cualquiera con el
// repo puede forjar JWT/device tokens. Fallar el bootstrap es preferible
// a quedar abierto. En dev se loguea warning y se sigue.
if (process.env.NODE_ENV === "production") {
  if (SECRET === DEFAULT_SECRET) {
    console.error("[FATAL] JWT_SECRET no configurado en producción (usa env var)");
    process.exit(1);
  }
  if (DEVICE_TOKEN === DEFAULT_DEVICE) {
    console.error("[FATAL] DEVICE_MASTER_TOKEN no configurado en producción");
    process.exit(1);
  }
  if (SECRET.length < 32) {
    console.error("[FATAL] JWT_SECRET demasiado corto (<32 chars) — riesgo de brute-force");
    process.exit(1);
  }
} else {
  if (SECRET === DEFAULT_SECRET) console.warn("[WARN] JWT_SECRET con default de dev");
  if (DEVICE_TOKEN === DEFAULT_DEVICE) console.warn("[WARN] DEVICE_MASTER_TOKEN con default de dev");
}

function signToken(payload, expiresIn = "30d") {
  return jwt.sign(payload, SECRET, { expiresIn });
}

// O15 — Revocación de sesiones. Sin esto, un JWT vale 30 días aunque se
// revoque el acceso, se cambie la contraseña o se bloquee la cuenta. Contra
// el doc del usuario validamos `token_version` (se bumpea al revocar/resetear)
// + `bloqueado`/`activo`. Cache de 30s para no pegarle a CouchDB en cada
// request: la revocación propaga en ≤30s (vs 30 días antes).
const _userState = new Map(); // uid -> { tv, bloqueado, activo, missing, exp }
const USER_STATE_TTL_MS = 30_000;

async function getUserState(uid) {
  const now = Date.now();
  const cached = _userState.get(uid);
  if (cached && cached.exp > now) return cached;
  let gdb;
  try { gdb = couch.getDB("global"); } catch { return null; }
  if (!gdb) return null;
  try {
    const u = await gdb.get(`usr_${uid}`);
    const st = {
      tv:        u.token_version || 0,
      bloqueado: !!u.bloqueado,
      activo:    u.activo !== false,
      missing:   false,
      exp:       now + USER_STATE_TTL_MS,
    };
    _userState.set(uid, st);
    return st;
  } catch (e) {
    if (e.statusCode === 404 || e.error === "not_found") {
      const st = { missing: true, exp: now + USER_STATE_TTL_MS };
      _userState.set(uid, st);
      return st;
    }
    // Error transitorio de CouchDB: NO bloqueamos auth (fail-open). Devolver
    // null → el caller deja pasar el token válido sin chequear revocación.
    return null;
  }
}

async function required(req, res, next) {
  const header = req.headers["authorization"] || "";
  // Aceptamos token en header (Bearer), cookie (SSR) o query ?token=... (descargas en nueva tab).
  const token  = header.startsWith("Bearer ")
    ? header.slice(7)
    : (req.cookies?.orbitx_token || req.query?.token || null);

  // Sprint 2: tokens de org
  // Va ANTES de la rama de device para que un orbx_ nunca caiga en el camino
  // del master token. Se acepta SOLO por el header Authorization: por ?token=
  // la credencial queda en los logs de nginx, en el historial del browser y en
  // el Referer, y un token de org es de larga vida y sin token_version.
  const bearerRaw = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearerRaw.startsWith("orbx_")) {
    const tokSrv = require("../services/tokens_org");
    if (!tokSrv.esSoloLectura(req.method))
      return res.status(403).json({ error: "Los tokens de organización son de solo lectura" });
    if (tokSrv.rutaProhibida(req.originalUrl))
      return res.status(403).json({ error: "Ese endpoint no está disponible para tokens de organización" });

    let docTok;
    try { docTok = await tokSrv.buscarPorToken(bearerRaw); }
    catch (e) {
      // Fail-CLOSED, al revés que el chequeo de revocación de JWT: si no
      // podemos verificar, no pasa.
      console.error("[auth.required/token-org]", e.message);
      return res.status(503).json({ error: "No se pudo validar el token, probá de nuevo en un momento" });
    }

    const ev = tokSrv.evaluarToken(docTok, Date.now());
    if (!ev.valido) {
      if (ev.motivo === "revocado") return res.status(403).json({ error: "Token revocado" });
      if (ev.motivo === "vencido")  return res.status(401).json({ error: "Token vencido" });
      return res.status(401).json({ error: "Token de organización inválido" });
    }

    tokSrv.registrarUso(docTok, req.ip);
    req.user = {
      uid:         `tok_${docTok._id}`,
      rol:         "viewer",
      rol_global:  "viewer",
      estabSlug:   docTok.org_slug,
      memberships: [{ orgSlug: docTok.org_slug, rol: "viewer" }],
      isDevice:    false,
      isToken:     true,
      scopes:      docTok.scopes || ["lectura"],
    };
    return next();
  }
  if (token && String(token).startsWith("orbx_"))
    return res.status(401).json({ error: "El token de organización solo se acepta por el header Authorization" });
  // fin Sprint 2: tokens de org

  if (!token && req.headers["x-device-id"]) {
    const deviceId = req.headers["x-device-id"];
    const sentTok  = req.headers["x-auth-token"];
    if (!sentTok)
      return res.status(401).json({ error: "Token de dispositivo requerido" });

    // Validar contra el doc del device en CouchDB (si existe).
    // Si no existe, solo aceptamos el master token legacy.
    let estabSlug = "unknown";
    try {
      const globalDB = req.app.locals.globalDB;
      if (globalDB) {
        const doc = await globalDB.get(`device_${deviceId}`).catch(() => null);
        if (doc) {
          if (doc.bloqueado)
            return res.status(403).json({ error: "Dispositivo bloqueado" });
          // Token propio o, si todavía está con master, master token.
          const tokenOk = doc.token === sentTok || (sentTok === DEVICE_TOKEN && (!doc.token || doc.token === DEVICE_TOKEN));
          if (!tokenOk)
            return res.status(401).json({ error: "Token de dispositivo inválido" });
          // estab_slug autoritativo del doc, no del header.
          estabSlug = doc.estab_slug || "unknown";
        } else {
          // Device no registrado: solo master token, queda con estab "unknown".
          if (sentTok !== DEVICE_TOKEN)
            return res.status(401).json({ error: "Dispositivo no registrado" });
        }
      } else if (sentTok !== DEVICE_TOKEN) {
        return res.status(401).json({ error: "Token de dispositivo inválido" });
      }
    } catch (e) {
      console.error("[auth.required/device]", e.message);
      return res.status(500).json({ error: "Error validando dispositivo" });
    }

    req.user = {
      uid:        deviceId,
      rol:        "device",
      rol_global: "device",
      estabSlug,
      memberships: [],
      isDevice:    true,
    };
    return next();
  }

  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const payload = jwt.verify(token, SECRET);
    // O15 — chequeo de revocación. `st === null` = error transitorio de DB →
    // fail-open (no tumbar auth por un hipo de Couch).
    const st = await getUserState(payload.uid);
    if (st) {
      if (st.missing)   return res.status(401).json({ error: "Usuario no encontrado" });
      if (st.bloqueado) return res.status(403).json({ error: "Cuenta bloqueada" });
      if (!st.activo)   return res.status(403).json({ error: "Cuenta desactivada" });
      if ((payload.tv || 0) !== st.tv)
        return res.status(401).json({ error: "Sesión revocada, iniciá sesión de nuevo" });
    }
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

// Sprint 2: recurso "prescripciones" — el agrónomo genera y edita prescripciones
// (antes el router exigía lotes:write, que el agrónomo no tiene).
const PERMS = {
  superadmin: { usuarios:["r","w","d","i"], lotes:["r","w","d"], alertas:["r","w","d"], dispositivos:["r","w","d"], audit_log:["r"], prescripciones:["r","w","d"] },
  owner:      { usuarios:["r","w","d","i"], lotes:["r","w","d"], alertas:["r","w"],     dispositivos:["r","w"],     audit_log:["r"], prescripciones:["r","w","d"] },
  admin_org:  { usuarios:["r","w","i"],     lotes:["r","w"],     alertas:["r","w"],     dispositivos:["r","w"],     audit_log:["r"], prescripciones:["r","w","d"] },
  agronomo:   { usuarios:[],               lotes:["r"],          alertas:["r"],         dispositivos:["r"],         audit_log:[],    prescripciones:["r","w"] },
  contratista:{ usuarios:[],               lotes:["r"],          alertas:["r","w"],     dispositivos:["r"],         audit_log:[],    prescripciones:["r"] },
  operador:   { usuarios:[],               lotes:["r"],          alertas:["r","w"],     dispositivos:["r"],         audit_log:[],    prescripciones:["r"] },
  member:     { usuarios:[],               lotes:["r"],          alertas:["r"],         dispositivos:["r"],         audit_log:[],    prescripciones:["r"] },
  viewer:     { usuarios:[],               lotes:["r"],          alertas:["r"],         dispositivos:[],            audit_log:[],    prescripciones:["r"] },
};
const AM = { read:"r", write:"w", delete:"d", invite:"i" };

function requirePermiso(recurso, accion) {
  return (req, res, next) => {
    // Sprint 2: tokens de org · requirePermiso
    // Un token de organización solo lee. El guard va acá además del chequeo de
    // método en `required` porque requirePermiso es el único punto por donde
    // pasan los endpoints con permisos finos.
    if (req.user?.isToken && accion !== "read" && accion !== "r") {
      return res.status(403).json({ error: "Sin permiso", detalle: "los tokens de organización son de solo lectura" });
    }
    // fin Sprint 2: tokens de org · requirePermiso
    // O3 — Devices NUNCA pueden cruzar requirePermiso. Antes había un
    // bypass `if (isDevice) return next()` que daba a cualquier device
    // token acceso a /api/auth/invitar, /api/auth/equipo (CRUD usuarios)
    // y /api/auth/audit (audit log). Privilege escalation total.
    // Si un endpoint necesita ser device-friendly, NO usar requirePermiso
    // — usar auth.required y validar dev.estab_slug a mano.
    if (req.user?.isDevice) {
      return res.status(403).json({ error:"Sin permiso", detalle:"endpoint no disponible para devices" });
    }
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
