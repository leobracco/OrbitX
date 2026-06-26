// ============================================================
//  OrbitX — services/auth_service.js  v2
//  Usa db.find() (Mango) en vez de vistas CouchDB
//  Más robusto: no depende de que las vistas estén indexadas
// ============================================================
const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const crypto = require("crypto");
const { ROLES, puedeInvitar } = require("../roles");
const notifyAdmin = require("../lib/notify-admin");
const emailLib    = require("../lib/email");

const SECRET = process.env.JWT_SECRET || "orbitx-dev-secret-cambiar";

let couchDB = null;
function setDB(db) {
  couchDB = db;
  // Asegurar índices Mango al conectar
  ensureIndexes().catch(e => console.warn("[Auth] Índices:", e.message));
}
const globalDB = () => couchDB.getDB("global");

// ── Índices Mango (se crean automáticamente si no existen) ───
async function ensureIndexes() {
  const db = globalDB();
  const indexes = [
    { fields: ["tipo"] },
    { fields: ["tipo", "email"] },
    { fields: ["tipo", "estado"] },
    { fields: ["tipo", "orgSlug"] },
    { fields: ["tipo", "uid"] },
    { fields: ["tipo", "reset_token"] },
  ];
  for (const idx of indexes) {
    await db.createIndex({ index: idx }).catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────
const genToken = (n = 32) => crypto.randomBytes(n).toString("hex");
const slugify  = (s = "") => s.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]/g, "_").replace(/_+/g, "_").slice(0, 40);

async function findUser(db, email) {
  // O3b — chokepoint: rechazar email no-string evita inyección de operadores
  // Mango (ej. {"$gt":""}) desde cualquier caller (login, reset).
  if (typeof email !== "string" || !email) return null;
  // Intentar primero con find()
  try {
    const r = await db.find({ selector: { tipo: "usuario", email }, limit: 1 });
    if (r.docs.length) return r.docs[0];
  } catch {}

  // Fallback: listar todos y filtrar (más lento pero infalible)
  try {
    const all = await db.list({ include_docs: true });
    return all.rows
      .map(r => r.doc)
      .find(d => d.tipo === "usuario" && d.email === email) || null;
  } catch { return null; }
}

async function signJWT(uid, orgSlug, memberships = []) {
  // O15 — leemos el doc una vez para rol_global + token_version (tv). `tv` va
  // en el payload y el middleware lo compara contra el doc para revocar.
  let rol_global = "user", tv = 0;
  try {
    const doc = await globalDB().get(`usr_${uid}`);
    rol_global = doc.rol_global || "user";
    tv = doc.token_version || 0;
  } catch {}
  return jwt.sign({
    uid,
    estabSlug:   orgSlug,
    memberships,
    rol_global,
    tv,
    iat: Math.floor(Date.now() / 1000)
  }, SECRET, { expiresIn: "30d" });
}

// O15 — incrementa token_version → invalida TODOS los JWT vigentes del usuario
// (revocación de acceso, reset de contraseña). Retry 409 + tolera not_found.
async function bumpTokenVersion(uid) {
  const db = globalDB();
  const id = `usr_${String(uid).replace(/^usr_/, "")}`;
  let lastErr;
  for (let intento = 0; intento < 3; intento++) {
    try {
      const u = await db.get(id);
      await db.insert({ ...u, token_version: (u.token_version || 0) + 1, updated_at: Date.now() });
      return;
    } catch (e) {
      if (e.statusCode === 404 || e.error === "not_found") return;
      if ((e.statusCode === 409 || e.error === "conflict") && intento < 2) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error("bumpTokenVersion: conflict tras 3 reintentos");
}

async function getRolGlobal(uid) {
  try {
    const db  = globalDB();
    const doc = await db.get(`usr_${uid}`);
    return doc.rol_global || "user";
  } catch { return "user"; }
}

async function getMemberships(uid) {
  const db = globalDB();
  try {
    const r = await db.find({
      selector: { tipo: "membresia", uid: `usr_${uid}`, activa: true },
      limit: 50
    });
    return r.docs.map(d => ({
      orgSlug:       d.orgSlug,
      rol:           d.rol,
      restricciones: d.restricciones || null
    }));
  } catch {
    // Fallback: list
    const all = await db.list({ include_docs: true });
    return all.rows.map(r => r.doc)
      .filter(d => d.tipo === "membresia" && d.uid === `usr_${uid}` && d.activa)
      .map(d => ({ orgSlug: d.orgSlug, rol: d.rol, restricciones: d.restricciones || null }));
  }
}

// ════════════════════════════════════════════════════════════
//  REGISTRO SELF-SERVICE
// ════════════════════════════════════════════════════════════
async function iniciarRegistro({ nombre, email, password, telefono, org_nombre, org_ha, org_provincia, org_ciudad, org_lat, org_lon }, meta = {}) {
  const req_ciudad = org_ciudad || "";
  const req_lat = parseFloat(org_lat) || null;
  const req_lon = parseFloat(org_lon) || null;
  const db = globalDB();

  // Verificar email duplicado
  const existe = await findUser(db, email);
  if (existe) throw { status: 409, message: "Email ya registrado" };

  // Verificar que no haya registro pendiente con ese email
  try {
    const r = await db.find({ selector: { tipo: "registro", email }, limit: 1 });
    if (r.docs.length) throw { status: 409, message: "Ya existe una solicitud de registro con ese email" };
  } catch (e) { if (e.status === 409) throw e; }

  const org_slug = slugify(org_nombre);
  const uid      = slugify(nombre.split(" ")[0]) + genToken(4);
  const token    = genToken(32);
  const now      = Date.now();

  await db.insert({
    _id:               `reg_${token}`,
    tipo:              "registro",
    nombre, email, telefono: telefono || "",
    password_hash:     await bcrypt.hash(password, 12),
    org_nombre, org_slug,
    org_ha:            parseInt(org_ha) || 0,
    org_provincia:     org_provincia || "",
    org_ciudad:        req_ciudad || "",
    org_lat:           req_lat || null,
    org_lon:           req_lon || null,
    uid_reservado:     uid,
    token_verificacion: token,
    email_verificado:  false,
    // Sin SMTP: auto-aprobar verificación de email pero esperar aprobación manual
    estado:            "pendiente_aprobacion",
    motivo_rechazo:    null,
    expira_at:         now + 7 * 24 * 60 * 60 * 1000, // 7 días
    created_at:        now
  });

  console.log(`[Auth] Registro pendiente: ${email} → ${org_nombre}`);

  // Notificar al admin global por Telegram (no bloqueante).
  notifyAdmin.notifyNewUser(
    { nombre, email, telefono, org_nombre },
    {
      ip:         meta.ip || null,
      user_agent: meta.user_agent || null,
      estado:     "pendiente de aprobación",
      via_invitacion: false,
    }
  ).catch(e => console.error("[Auth] notifyNewUser:", e.message));

  // Mail al usuario: "recibimos tu solicitud" (no bloqueante).
  emailLib.enviarRegistroRecibido({ nombre, email, org_nombre })
    .catch(e => console.error("[Auth] enviarRegistroRecibido:", e.message));

  return { token, email, org_slug };
}

async function verificarEmail(token) {
  const db  = globalDB();
  const doc = await db.get(`reg_${token}`).catch(() => null);
  if (!doc) throw { status: 404, message: "Token inválido" };
  if (Date.now() > doc.expira_at) throw { status: 410, message: "Token expirado" };
  await db.insert({ ...doc, email_verificado: true, estado: "pendiente_aprobacion", updated_at: Date.now() });
  return { org_nombre: doc.org_nombre, nombre: doc.nombre };
}

// Superadmin aprueba → crea usuario + org + membresía + DB
async function aprobarRegistro(regToken, superadminUID) {
  const db  = globalDB();
  const reg = await db.get(`reg_${regToken}`).catch(() => null);
  if (!reg) throw { status: 404, message: "Registro no encontrado" };
  if (!["pendiente_aprobacion", "pendiente_verificacion"].includes(reg.estado))
    throw { status: 400, message: `Estado inválido: ${reg.estado}` };

  const now = Date.now();

  // 1. Usuario
  await db.insert({
    _id: `usr_${reg.uid_reservado}`,
    tipo: "usuario",
    nombre: reg.nombre, email: reg.email,
    password_hash: reg.password_hash,
    telefono: reg.telefono || "",
    avatar_initials: reg.nombre.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
    rol_global: "owner",
    email_verificado: true, activo: true, bloqueado: false,
    notificaciones: { push_token: null, push_tokens: [], alertas_criticas: true, resumen_diario: true, cierre_lote: true, hora_resumen: "19:00" },
    prefs: { idioma: "es", tema: "dark", org_activa: reg.org_slug },
    ultimo_login: null, login_count: 0,
    created_at: now, updated_at: now
  });

  // 2. Org
  await db.insert({
    _id: `org_${reg.org_slug}`,
    tipo: "org",
    nombre: reg.org_nombre, slug: reg.org_slug,
    ha_total: reg.org_ha, provincia: reg.org_provincia, pais: "Argentina",
    ciudad: reg.org_ciudad || "", lat: reg.org_lat || null, lon: reg.org_lon || null,
    plan: "pro", plan_vence: null, activa: true, aprobada: true,
    modulos: ["vistax", "linex", "centrix"],
    limites: { usuarios_max: 20, dispositivos_max: 10, ha_max: null },
    owner_uid: `usr_${reg.uid_reservado}`,
    aprobado_por: superadminUID,
    created_at: now, updated_at: now
  });

  // 3. Membresía owner
  await db.insert({
    _id: `memb_${reg.uid_reservado}_${reg.org_slug}`,
    tipo: "membresia",
    uid: `usr_${reg.uid_reservado}`,
    orgSlug: reg.org_slug, rol: "owner",
    restricciones: { lotes_ids: null, solo_lectura: false, sin_agraria: false, expira: null },
    invitado_por: superadminUID, activa: true,
    created_at: now, updated_at: now
  });

  // 4. DB del establecimiento
  await couchDB.bootstrapEstablecimiento(reg.org_slug);

  // 5. Marcar registro aprobado
  await db.insert({ ...reg, estado: "aprobado", aprobado_por: superadminUID, updated_at: now });

  console.log(`[Auth] ✓ Aprobado: ${reg.org_slug} (owner: ${reg.uid_reservado})`);

  // Mail al usuario: cuenta activa.
  emailLib.enviarRegistroAprobado(
    { nombre: reg.nombre, email: reg.email },
    { nombre: reg.org_nombre, slug: reg.org_slug },
  ).catch(e => console.error("[Auth] enviarRegistroAprobado:", e.message));

  // Telegram al admin: nueva org aprobada.
  notifyAdmin.notifyNewOrg(
    { nombre: reg.org_nombre, slug: reg.org_slug, ha_total: reg.org_ha, provincia: reg.org_provincia, owner_uid: `usr_${reg.uid_reservado}` },
    { owner_nombre: reg.nombre },
  ).catch(() => {});

  return { uid: reg.uid_reservado, org_slug: reg.org_slug };
}

async function rechazarRegistro(regToken, superadminUID, motivo) {
  const db  = globalDB();
  const reg = await db.get(`reg_${regToken}`).catch(() => null);
  if (!reg) throw { status: 404, message: "Registro no encontrado" };
  await db.insert({ ...reg, estado: "rechazado", motivo_rechazo: motivo, updated_at: Date.now() });

  emailLib.enviarRegistroRechazado(
    { nombre: reg.nombre, email: reg.email, org_nombre: reg.org_nombre },
    motivo,
  ).catch(e => console.error("[Auth] enviarRegistroRechazado:", e.message));
}

// ════════════════════════════════════════════════════════════
//  LOGIN — usa find() directo, no vistas
// ════════════════════════════════════════════════════════════
async function login(email, password, orgSlugSolicitada) {
  const db   = globalDB();
  const user = await findUser(db, email);

  if (!user)          throw { status: 401, message: "Credenciales inválidas" };
  if (!user.activo)   throw { status: 403, message: "Cuenta desactivada" };
  if (user.bloqueado) throw { status: 403, message: "Cuenta bloqueada" };

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw { status: 401, message: "Credenciales inválidas" };

  // Cargar membresías
  const uid         = user._id.replace("usr_", "");
  const memberships = await getMemberships(uid);

  // Determinar org activa
  let orgActiva = orgSlugSolicitada || user.prefs?.org_activa;
  if (!orgActiva && memberships.length) orgActiva = memberships[0].orgSlug;

  // Superadmin puede loguearse sin org
  if (user.rol_global !== "superadmin" && orgActiva) {
    const tieneAcceso = memberships.some(m => m.orgSlug === orgActiva);
    if (!tieneAcceso && memberships.length > 0) orgActiva = memberships[0].orgSlug;
  }

  // Actualizar último login
  await db.insert({ ...user, ultimo_login: Date.now(), login_count: (user.login_count || 0) + 1, updated_at: Date.now() });

  const token = await signJWT(uid, orgActiva, memberships);

  return {
    token,
    user: {
      uid:         user._id,
      nombre:      user.nombre,
      email:       user.email,
      avatar:      user.avatar_initials,
      rol_global:  user.rol_global,
      org_activa:  orgActiva,
      memberships,
      prefs:       user.prefs
    }
  };
}

// ════════════════════════════════════════════════════════════
//  CAMBIAR ORG ACTIVA — reemite JWT
//  O4 — Antes el route hacía jwt.verify+sign copiando `memberships` del
//  token viejo (válidas hasta 30d aunque se revocara el acceso) y con un
//  default de SECRET distinto al del middleware. Acá re-derivamos
//  memberships desde DB (getMemberships solo trae activas) y firmamos con
//  el mismo signJWT que login → fuente única de verdad.
// ════════════════════════════════════════════════════════════
async function cambiarOrg(uid, orgSlug) {
  const memberships = await getMemberships(uid);
  const rolGlobal   = await getRolGlobal(uid);
  const tieneAcceso = memberships.some(m => m.orgSlug === orgSlug);
  if (!tieneAcceso && rolGlobal !== "superadmin")
    throw { status: 403, message: "Sin acceso a esa organización" };
  const token = await signJWT(uid, orgSlug, memberships);
  return { token, orgSlug };
}

// ════════════════════════════════════════════════════════════
//  INVITACIONES
// ════════════════════════════════════════════════════════════
async function crearInvitacion({ emailDestino, nombreDestino, orgSlug, rolAsignado, restricciones, invitadoPorUID }) {
  const db = globalDB();

  const memb         = await db.get(`memb_${invitadoPorUID.replace("usr_","")}_${orgSlug}`).catch(() => null);
  const rolInvitador = memb?.rol || "viewer";
  if (!puedeInvitar(rolInvitador, rolAsignado))
    throw { status: 403, message: `El rol '${rolInvitador}' no puede invitar '${rolAsignado}'` };

  const token = genToken(24);
  const now   = Date.now();
  let orgNombre = orgSlug;
  try { const org = await db.get(`org_${orgSlug}`); orgNombre = org.nombre; } catch {}
  let invitadorNombre = "";
  try { const inv = await db.get(invitadoPorUID); invitadorNombre = inv.nombre; } catch {}

  const expira_at = now + 48 * 60 * 60 * 1000;
  await db.insert({
    _id: `inv_${token}`,
    tipo: "invitacion",
    email_destino: emailDestino,
    nombre_destino: nombreDestino || "",
    orgSlug, orgNombre,
    rol_asignado: rolAsignado,
    restricciones: restricciones || { lotes_ids: null, solo_lectura: false, sin_agraria: false, expira: null },
    invitado_por_uid: invitadoPorUID,
    invitado_por_nombre: invitadorNombre,
    token, estado: "pendiente", uid_aceptante: null,
    expira_at,
    aceptada_at: null, created_at: now
  });

  await registrarAudit(orgSlug, invitadoPorUID, "invitacion.crear", { email: emailDestino, rol: rolAsignado });

  // Mail al invitado.
  emailLib.enviarInvitacion({
    email_destino:        emailDestino,
    orgNombre,
    rol_asignado:         rolAsignado,
    invitado_por_nombre:  invitadorNombre,
    token,
    expira_at,
  }).catch(e => console.error("[Auth] enviarInvitacion:", e.message));

  return { token, expira_at };
}

async function getInvitacion(token) {
  const db  = globalDB();
  const doc = await db.get(`inv_${token}`).catch(() => null);
  if (!doc) throw { status: 404, message: "Invitación no encontrada" };
  if (doc.estado !== "pendiente") throw { status: 400, message: `Invitación ${doc.estado}` };
  if (Date.now() > doc.expira_at) {
    await db.insert({ ...doc, estado: "expirada" });
    throw { status: 410, message: "Invitación expirada" };
  }
  return doc;
}

async function aceptarInvitacion(token, { nombre, password, esNuevoUsuario }, meta = {}) {
  const db  = globalDB();
  const inv = await getInvitacion(token);
  const now = Date.now();
  let uid;

  if (esNuevoUsuario !== false) {
    uid = slugify((nombre || "user").split(" ")[0]) + genToken(4);
    await db.insert({
      _id: `usr_${uid}`,
      tipo: "usuario",
      nombre: nombre || inv.email_destino,
      email: inv.email_destino,
      password_hash: await bcrypt.hash(password, 12),
      avatar_initials: (nombre || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(),
      rol_global: "user",
      email_verificado: true, activo: true, bloqueado: false,
      notificaciones: { push_token: null, push_tokens: [], alertas_criticas: true, resumen_diario: false, cierre_lote: false, hora_resumen: "19:00" },
      prefs: { idioma: "es", tema: "dark", org_activa: inv.orgSlug },
      ultimo_login: null, login_count: 0,
      created_at: now, updated_at: now
    });
  } else {
    const user = await findUser(db, inv.email_destino);
    if (!user) throw { status: 404, message: "Usuario no encontrado" };
    uid = user._id.replace("usr_", "");
  }

  await db.insert({
    _id: `memb_${uid}_${inv.orgSlug}`,
    tipo: "membresia",
    uid: `usr_${uid}`, orgSlug: inv.orgSlug, rol: inv.rol_asignado,
    restricciones: inv.restricciones,
    invitado_por: inv.invitado_por_uid, invitacion_id: inv._id,
    activa: true, created_at: now, updated_at: now
  });

  await db.insert({ ...inv, estado: "aceptada", uid_aceptante: `usr_${uid}`, aceptada_at: now });
  await registrarAudit(inv.orgSlug, `usr_${uid}`, "invitacion.aceptar", { rol: inv.rol_asignado });

  // Notificar al admin solo si es un usuario realmente nuevo en la plataforma.
  if (esNuevoUsuario !== false) {
    notifyAdmin.notifyNewUser(
      { nombre: nombre || inv.email_destino, email: inv.email_destino, org_nombre: inv.orgNombre },
      {
        ip:         meta.ip || null,
        user_agent: meta.user_agent || null,
        estado:     `activo · rol ${inv.rol_asignado}`,
        via_invitacion: true,
        org_nombre: inv.orgNombre,
      }
    ).catch(e => console.error("[Auth] notifyNewUser invit:", e.message));
  }

  const memberships = await getMemberships(uid);
  const jwtToken    = await signJWT(uid, inv.orgSlug, memberships);
  return { token: jwtToken, uid: `usr_${uid}`, orgSlug: inv.orgSlug };
}

// ════════════════════════════════════════════════════════════
//  GESTIÓN DE MEMBRESÍAS
// ════════════════════════════════════════════════════════════
async function getMiembros(orgSlug) {
  const db = globalDB();
  let membs = [];
  try {
    const r = await db.find({ selector: { tipo: "membresia", orgSlug, activa: true }, limit: 100 });
    membs = r.docs;
  } catch {
    const all = await db.list({ include_docs: true });
    membs = all.rows.map(r => r.doc).filter(d => d.tipo === "membresia" && d.orgSlug === orgSlug && d.activa);
  }

  const usuarios = await Promise.all(
    membs.map(m => db.get(m.uid).catch(() => null))
  );

  return membs.map((m, i) => {
    const u = usuarios[i] || {};
    return {
      uid:          m.uid,
      nombre:       u.nombre || "–",
      email:        u.email  || "–",
      avatar:       u.avatar_initials || "?",
      rol:          m.rol,
      activo:       u.activo !== false,
      ultimo_login: u.ultimo_login,
      restricciones: m.restricciones
    };
  });
}

async function actualizarMembresia(uid, orgSlug, { rol, restricciones }, ejecutadoPorUID) {
  const db   = globalDB();
  const id   = `memb_${uid.replace("usr_","")}_${orgSlug}`;
  const memb = await db.get(id).catch(() => null);
  if (!memb) throw { status: 404, message: "Membresía no encontrada" };
  await db.insert({ ...memb, rol: rol || memb.rol, restricciones: restricciones || memb.restricciones, updated_at: Date.now() });
  await registrarAudit(orgSlug, ejecutadoPorUID, "membresia.actualizar", { uid, rol });
}

async function revocarAcceso(uid, orgSlug, ejecutadoPorUID) {
  const db   = globalDB();
  const id   = `memb_${uid.replace("usr_","")}_${orgSlug}`;
  const memb = await db.get(id).catch(() => null);
  if (!memb) throw { status: 404, message: "Membresía no encontrada" };
  await db.insert({ ...memb, activa: false, revocado_por: ejecutadoPorUID, revocado_at: Date.now(), updated_at: Date.now() });
  // O15 — matar los JWT vigentes del usuario: sin esto seguía operando en la
  // org revocada (con memberships embebidas) hasta que el token expirara (30d).
  await bumpTokenVersion(uid).catch(e => console.warn("[Auth] bumpTokenVersion revoke:", e.message));
  await registrarAudit(orgSlug, ejecutadoPorUID, "membresia.revocar", { uid });
}

// ════════════════════════════════════════════════════════════
//  AUDIT LOG
// ════════════════════════════════════════════════════════════
async function registrarAudit(orgSlug, uid, accion, detalle = {}) {
  try {
    const db  = globalDB();
    const now = Date.now();
    await db.insert({
      _id: `audit_${now}_${Math.random().toString(36).slice(2, 7)}`,
      tipo: "audit", orgSlug, uid, accion, detalle, ts: now
    });
  } catch {} // No romper el flujo principal
}

async function getAuditLog(orgSlug, limit = 100) {
  const db = globalDB();
  try {
    const r = await db.find({
      selector: { tipo: "audit", orgSlug },
      sort: [{ ts: "desc" }],
      limit
    });
    return r.docs;
  } catch {
    const all = await db.list({ include_docs: true });
    return all.rows.map(r => r.doc)
      .filter(d => d.tipo === "audit" && d.orgSlug === orgSlug)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
  }
}

// ════════════════════════════════════════════════════════════
//  PASSWORD RESET
// ════════════════════════════════════════════════════════════
async function solicitarReset(email) {
  const db   = globalDB();
  const user = await findUser(db, email);
  if (!user) return; // Silencioso por seguridad (no revelar si el mail existe).
  const token = genToken(32);
  await db.insert({ ...user, reset_token: token, reset_token_exp: Date.now() + 3600000, updated_at: Date.now() });
  // O13 — NO loguear el token (permite tomar la cuenta a cualquiera con
  // acceso a logs). El token viaja solo por el mail al usuario.
  console.log(`[Auth] Reset solicitado para ${email}`);

  emailLib.enviarResetPassword({ nombre: user.nombre, email: user.email }, token)
    .catch(e => console.error("[Auth] enviarResetPassword:", e.message));

  return token;
}

async function confirmarReset(token, nuevaPassword) {
  const db = globalDB();
  let user = null;
  try {
    const r = await db.find({ selector: { tipo: "usuario", reset_token: token }, limit: 1 });
    user = r.docs[0] || null;
  } catch {
    const all = await db.list({ include_docs: true });
    user = all.rows.map(r => r.doc).find(d => d.tipo === "usuario" && d.reset_token === token) || null;
  }
  if (!user)                            throw { status: 404, message: "Token inválido" };
  if (Date.now() > user.reset_token_exp) throw { status: 410, message: "Token expirado" };
  if (typeof nuevaPassword !== "string" || nuevaPassword.length < 8)
    throw { status: 400, message: "La contraseña debe tener al menos 8 caracteres" };
  const hash = await bcrypt.hash(nuevaPassword, 12);
  // O15 — al cambiar la contraseña, invalidar sesiones existentes (por si el
  // reset lo gatilló un compromiso de cuenta).
  await db.insert({ ...user, password_hash: hash, reset_token: null, reset_token_exp: null, token_version: (user.token_version || 0) + 1, updated_at: Date.now() });
}

// ── Listar registros pendientes ───────────────────────────
async function getRegistrosPendientes() {
  const db = globalDB();
  try {
    const r = await db.find({
      selector: { tipo: "registro", estado: "pendiente_aprobacion" },
      sort: [{ created_at: "desc" }], limit: 100
    });
    return r.docs;
  } catch {
    const all = await db.list({ include_docs: true });
    return all.rows.map(r => r.doc)
      .filter(d => d.tipo === "registro" && d.estado === "pendiente_aprobacion")
      .sort((a, b) => b.created_at - a.created_at);
  }
}

module.exports = {
  setDB, ensureIndexes,
  iniciarRegistro, verificarEmail, aprobarRegistro, rechazarRegistro, getRegistrosPendientes,
  login, cambiarOrg,
  crearInvitacion, getInvitacion, aceptarInvitacion,
  getMiembros, actualizarMembresia, revocarAcceso,
  registrarAudit, getAuditLog,
  solicitarReset, confirmarReset
};
