// ============================================================
//  OrbitX — services/auth_service.js
//  Registro, login, invitaciones y membresías
// ============================================================
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const crypto  = require("crypto");
const { ROLES, puedeInvitar } = require("../roles");

const SECRET  = process.env.JWT_SECRET || "orbitx-dev-secret";
const DB_GLOBAL = "orbitx_global";

// Inyectado desde server.js
let couchDB = null;
function setDB(db) { couchDB = db; }
const globalDB = () => couchDB.getDB("global");

// ── Helpers ──────────────────────────────────────────────────
const genToken  = (n=32) => crypto.randomBytes(n).toString("hex");
const slugify   = (s="") => s.toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"_")
  .replace(/_+/g,"_").slice(0,40);

async function signJWT(uid, orgSlug) {
  // Cargar membresías del usuario para incluirlas en el token
  const db = globalDB();
  const membs = await db.view("auth","membresias_por_uid",{
    key: `usr_${uid}`, include_docs: false, reduce: false
  }).catch(()=>({ rows:[] }));

  const memberships = membs.rows.map(r => r.value);

  return jwt.sign({
    uid,
    estabSlug: orgSlug,
    memberships,
    iat: Math.floor(Date.now()/1000)
  }, SECRET, { expiresIn: "30d" });
}

// ════════════════════════════════════════════════════════════
//  REGISTRO SELF-SERVICE (owner crea su org)
// ════════════════════════════════════════════════════════════
async function iniciarRegistro({ nombre, email, password, telefono, org_nombre, org_ha, org_provincia }) {
  const db = globalDB();

  // Verificar email no duplicado
  const existe = await db.view("auth","usuario_por_email",{
    key: email, include_docs: false
  }).catch(()=>({ rows:[] }));
  if (existe.rows.length) throw { status:409, message:"Email ya registrado" };

  // Verificar slug no duplicado
  const org_slug = slugify(org_nombre);
  try { await db.get(`org_${org_slug}`); throw { status:409, message:"Nombre de organización ya existe" }; }
  catch(e) { if (e.status !== 409 && e.error !== "not_found") throw e; }

  const uid      = slugify(nombre.split(" ")[0]) + genToken(4);
  const token    = genToken(32);
  const now      = Date.now();

  // Guardar registro pendiente
  await db.insert({
    _id: `reg_${token}`,
    tipo: "registro",
    nombre, email, telefono,
    password_hash: await bcrypt.hash(password, 12),
    org_nombre, org_slug,
    org_ha: parseInt(org_ha) || 0,
    org_provincia: org_provincia || "",
    uid_reservado: uid,
    token_verificacion: token,
    email_verificado: false,
    estado: "pendiente_verificacion",
    motivo_rechazo: null,
    expira_at: now + 24*60*60*1000,
    created_at: now
  });

  return { token, email, org_slug };
}

async function verificarEmail(token) {
  const db  = globalDB();
  const doc = await db.get(`reg_${token}`).catch(()=>null);
  if (!doc) throw { status:404, message:"Token inválido" };
  if (doc.email_verificado) throw { status:400, message:"Email ya verificado" };
  if (Date.now() > doc.expira_at) throw { status:410, message:"Token expirado" };

  await db.insert({ ...doc, email_verificado:true, estado:"pendiente_aprobacion", updated_at:Date.now() });
  return { org_nombre: doc.org_nombre, nombre: doc.nombre };
}

// Superadmin aprueba el registro y crea todo
async function aprobarRegistro(regToken, superadminUID) {
  const db  = globalDB();
  const reg = await db.get(`reg_${regToken}`).catch(()=>null);
  if (!reg) throw { status:404, message:"Registro no encontrado" };
  if (reg.estado !== "pendiente_aprobacion") throw { status:400, message:`Estado inválido: ${reg.estado}` };

  const now = Date.now();

  // 1. Crear usuario
  await db.insert({
    _id: `usr_${reg.uid_reservado}`,
    tipo: "usuario",
    nombre: reg.nombre, email: reg.email,
    password_hash: reg.password_hash,
    telefono: reg.telefono || "",
    avatar_initials: reg.nombre.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
    rol_global: "owner",
    email_verificado: true, activo: true, bloqueado: false,
    notificaciones: { push_token:null, push_tokens:[], alertas_criticas:true, resumen_diario:true, cierre_lote:true, hora_resumen:"19:00" },
    prefs: { idioma:"es", tema:"dark", org_activa: reg.org_slug },
    ultimo_login: null, login_count: 0,
    created_at: now, updated_at: now
  });

  // 2. Crear org
  await db.insert({
    _id: `org_${reg.org_slug}`,
    tipo: "org",
    nombre: reg.org_nombre, slug: reg.org_slug,
    ha_total: reg.org_ha, provincia: reg.org_provincia, pais: "Argentina",
    plan: "pro", plan_vence: null, activa: true, aprobada: true,
    modulos: ["vistax","linex","centrix"],
    limites: { usuarios_max:20, dispositivos_max:10, ha_max:null },
    owner_uid: `usr_${reg.uid_reservado}`,
    aprobado_por: superadminUID,
    created_at: now, updated_at: now
  });

  // 3. Crear membresía owner
  await db.insert({
    _id: `memb_${reg.uid_reservado}_${reg.org_slug}`,
    tipo: "membresia",
    uid: `usr_${reg.uid_reservado}`,
    orgSlug: reg.org_slug, rol: "owner",
    restricciones: { lotes_ids:null, solo_lectura:false, sin_agraria:false, expira:null },
    invitado_por: superadminUID, activa: true,
    created_at: now, updated_at: now
  });

  // 4. Crear DB del establecimiento
  await couchDB.bootstrapEstablecimiento(reg.org_slug);

  // 5. Marcar registro como aprobado
  await db.insert({ ...reg, estado:"aprobado", aprobado_por:superadminUID, updated_at:now });

  console.log(`[Auth] ✓ Org creada: ${reg.org_slug} (owner: ${reg.uid_reservado})`);
  return { uid: reg.uid_reservado, org_slug: reg.org_slug };
}

async function rechazarRegistro(regToken, superadminUID, motivo) {
  const db  = globalDB();
  const reg = await db.get(`reg_${regToken}`).catch(()=>null);
  if (!reg) throw { status:404, message:"Registro no encontrado" };
  await db.insert({ ...reg, estado:"rechazado", motivo_rechazo:motivo, updated_at:Date.now() });
}

// ════════════════════════════════════════════════════════════
//  LOGIN
// ════════════════════════════════════════════════════════════
async function login(email, password, orgSlugSolicitada) {
  const db = globalDB();

  // Buscar usuario por email
  const r = await db.view("auth","usuario_por_email",{ key:email, include_docs:true, reduce:false });
  if (!r.rows.length) throw { status:401, message:"Credenciales inválidas" };

  const user = r.rows[0].doc;
  if (!user.activo)   throw { status:403, message:"Cuenta desactivada" };
  if (user.bloqueado) throw { status:403, message:"Cuenta bloqueada" };

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw { status:401, message:"Credenciales inválidas" };

  // Cargar membresías
  const membs = await db.view("auth","membresias_por_uid",{
    key: user._id, include_docs: false, reduce: false
  }).catch(()=>({ rows:[] }));
  const memberships = membs.rows.map(r => r.value);

  // Determinar org activa
  let orgActiva = orgSlugSolicitada || user.prefs?.org_activa;
  if (!orgActiva && memberships.length)
    orgActiva = memberships[0].orgSlug;

  // superadmin no necesita membresía
  if (user.rol_global !== "superadmin" && orgActiva) {
    const tieneAcceso = memberships.some(m => m.orgSlug === orgActiva && m.activa !== false);
    if (!tieneAcceso) throw { status:403, message:"Sin acceso a esta organización" };
  }

  // Actualizar último login
  await db.insert({ ...user, ultimo_login:Date.now(), login_count:(user.login_count||0)+1, updated_at:Date.now() });

  const token = await signJWT(user._id.replace("usr_",""), orgActiva);

  return {
    token,
    user: {
      uid:          user._id,
      nombre:       user.nombre,
      email:        user.email,
      avatar:       user.avatar_initials,
      rol_global:   user.rol_global,
      org_activa:   orgActiva,
      memberships,
      prefs:        user.prefs
    }
  };
}

// ════════════════════════════════════════════════════════════
//  INVITACIONES
// ════════════════════════════════════════════════════════════
async function crearInvitacion({ emailDestino, nombreDestino, orgSlug, rolAsignado, restricciones, invitadoPorUID }) {
  const db = globalDB();

  // Verificar que el invitador tiene permiso
  const memb = await db.get(`memb_${invitadoPorUID.replace("usr_","")}_${orgSlug}`).catch(()=>null);
  const rolInvitador = memb?.rol || "viewer";
  if (!puedeInvitar(rolInvitador, rolAsignado))
    throw { status:403, message:`El rol '${rolInvitador}' no puede invitar '${rolAsignado}'` };

  // Verificar límite de usuarios
  const org = await db.get(`org_${orgSlug}`);
  const miembros = await db.view("auth","miembros_por_org",{ key:orgSlug, reduce:false });
  if (org.limites?.usuarios_max && miembros.rows.length >= org.limites.usuarios_max)
    throw { status:429, message:`Límite de ${org.limites.usuarios_max} usuarios alcanzado` };

  const token = genToken(24);
  const now   = Date.now();

  const invDoc = {
    _id: `inv_${token}`,
    tipo: "invitacion",
    email_destino: emailDestino,
    nombre_destino: nombreDestino || "",
    orgSlug, orgNombre: org.nombre,
    rol_asignado: rolAsignado,
    restricciones: restricciones || { lotes_ids:null, solo_lectura:false, sin_agraria:false, expira:null },
    invitado_por_uid: invitadoPorUID,
    invitado_por_nombre: "",
    token,
    estado: "pendiente",
    uid_aceptante: null,
    expira_at: now + 48*60*60*1000,
    aceptada_at: null,
    created_at: now
  };

  // Buscar nombre del invitador
  const invitador = await db.get(invitadoPorUID).catch(()=>null);
  if (invitador) invDoc.invitado_por_nombre = invitador.nombre;

  await db.insert(invDoc);

  // Audit log
  await registrarAudit(orgSlug, invitadoPorUID, "invitacion.crear", {
    email: emailDestino, rol: rolAsignado
  });

  return { token, expira_at: invDoc.expira_at };
}

async function getInvitacion(token) {
  const db  = globalDB();
  const doc = await db.get(`inv_${token}`).catch(()=>null);
  if (!doc) throw { status:404, message:"Invitación no encontrada" };
  if (doc.estado !== "pendiente") throw { status:400, message:`Invitación ${doc.estado}` };
  if (Date.now() > doc.expira_at) {
    await db.insert({ ...doc, estado:"expirada" });
    throw { status:410, message:"Invitación expirada" };
  }
  return doc;
}

async function aceptarInvitacion(token, { nombre, password, esNuevoUsuario }) {
  const db  = globalDB();
  const inv = await getInvitacion(token);
  const now = Date.now();

  let uid;

  if (esNuevoUsuario) {
    // Crear nuevo usuario
    uid = slugify(nombre.split(" ")[0]) + genToken(4);
    await db.insert({
      _id: `usr_${uid}`,
      tipo: "usuario",
      nombre, email: inv.email_destino,
      password_hash: await bcrypt.hash(password, 12),
      avatar_initials: nombre.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
      rol_global: "user",
      email_verificado: true, activo: true, bloqueado: false,
      notificaciones: { push_token:null, push_tokens:[], alertas_criticas:true, resumen_diario:false, cierre_lote:false, hora_resumen:"19:00" },
      prefs: { idioma:"es", tema:"dark", org_activa: inv.orgSlug },
      ultimo_login: null, login_count: 0,
      created_at: now, updated_at: now
    });
  } else {
    // Usuario existente — buscar por email
    const r = await db.view("auth","usuario_por_email",{ key:inv.email_destino, include_docs:true });
    if (!r.rows.length) throw { status:404, message:"Usuario no encontrado" };
    uid = r.rows[0].doc._id.replace("usr_","");
  }

  // Crear membresía
  await db.insert({
    _id: `memb_${uid}_${inv.orgSlug}`,
    tipo: "membresia",
    uid: `usr_${uid}`,
    orgSlug: inv.orgSlug, rol: inv.rol_asignado,
    restricciones: inv.restricciones,
    invitado_por: inv.invitado_por_uid,
    invitacion_id: inv._id,
    activa: true,
    created_at: now, updated_at: now
  });

  // Marcar invitación como aceptada
  await db.insert({ ...inv, estado:"aceptada", uid_aceptante:`usr_${uid}`, aceptada_at:now });

  await registrarAudit(inv.orgSlug, `usr_${uid}`, "invitacion.aceptar", { rol: inv.rol_asignado });

  const jwtToken = await signJWT(uid, inv.orgSlug);
  return { token: jwtToken, uid: `usr_${uid}`, orgSlug: inv.orgSlug };
}

// ════════════════════════════════════════════════════════════
//  GESTIÓN DE MEMBRESÍAS
// ════════════════════════════════════════════════════════════
async function getMiembros(orgSlug) {
  const db = globalDB();
  const r  = await db.view("auth","miembros_por_org",{
    key:orgSlug, include_docs:false, reduce:false
  });
  // Enriquecer con datos del usuario
  const uids = [...new Set(r.rows.map(x => x.value.uid))];
  const usuarios = await Promise.all(
    uids.map(uid => db.get(uid).catch(()=>null))
  );
  const usuariosMap = {};
  usuarios.filter(Boolean).forEach(u => { usuariosMap[u._id] = u; });

  return r.rows.map(row => {
    const u = usuariosMap[row.value.uid] || {};
    return {
      uid:     row.value.uid,
      nombre:  u.nombre || "–",
      email:   u.email || "–",
      avatar:  u.avatar_initials || "?",
      rol:     row.value.rol,
      activo:  u.activo !== false,
      ultimo_login: u.ultimo_login
    };
  });
}

async function actualizarMembresia(uid, orgSlug, { rol, restricciones }, ejecutadoPorUID) {
  const db    = globalDB();
  const id    = `memb_${uid.replace("usr_","")}_${orgSlug}`;
  const memb  = await db.get(id).catch(()=>null);
  if (!memb) throw { status:404, message:"Membresía no encontrada" };

  await db.insert({ ...memb, rol: rol||memb.rol, restricciones: restricciones||memb.restricciones, updated_at:Date.now() });
  await registrarAudit(orgSlug, ejecutadoPorUID, "membresia.actualizar", { uid, rol });
}

async function revocarAcceso(uid, orgSlug, ejecutadoPorUID) {
  const db   = globalDB();
  const id   = `memb_${uid.replace("usr_","")}_${orgSlug}`;
  const memb = await db.get(id).catch(()=>null);
  if (!memb) throw { status:404, message:"Membresía no encontrada" };

  await db.insert({ ...memb, activa:false, revocado_por:ejecutadoPorUID, revocado_at:Date.now(), updated_at:Date.now() });
  await registrarAudit(orgSlug, ejecutadoPorUID, "membresia.revocar", { uid });
}

// ════════════════════════════════════════════════════════════
//  AUDIT LOG
// ════════════════════════════════════════════════════════════
async function registrarAudit(orgSlug, uid, accion, detalle={}) {
  const db  = globalDB();
  const now = Date.now();
  try {
    await db.insert({
      _id: `audit_${now}_${(uid||"").slice(-8)}_${Math.random().toString(36).slice(2,6)}`,
      tipo: "audit",
      orgSlug, uid, accion, detalle,
      ts: now
    });
  } catch {} // Audit nunca debe romper el flujo principal
}

async function getAuditLog(orgSlug, limit=100) {
  const db = globalDB();
  const r  = await db.view("auth","audit_por_org",{
    startkey: [orgSlug, "\uffff"],
    endkey:   [orgSlug, 0],
    descending: true,
    include_docs: true,
    limit, reduce: false
  });
  return r.rows.map(x => x.doc);
}

// ════════════════════════════════════════════════════════════
//  PASSWORD RESET
// ════════════════════════════════════════════════════════════
async function solicitarReset(email) {
  const db = globalDB();
  const r  = await db.view("auth","usuario_por_email",{ key:email, include_docs:true });
  if (!r.rows.length) return; // Silencioso por seguridad
  const user  = r.rows[0].doc;
  const token = genToken(32);
  await db.insert({ ...user, reset_token:token, reset_token_exp: Date.now()+3600000, updated_at:Date.now() });
  return token; // El caller manda el email
}

async function confirmarReset(token, nuevaPassword) {
  const db = globalDB();
  const r  = await db.find({ selector:{ tipo:"usuario", reset_token:token } });
  if (!r.docs.length) throw { status:404, message:"Token inválido" };
  const user = r.docs[0];
  if (Date.now() > user.reset_token_exp) throw { status:410, message:"Token expirado" };
  const hash = await bcrypt.hash(nuevaPassword, 12);
  await db.insert({ ...user, password_hash:hash, reset_token:null, reset_token_exp:null, updated_at:Date.now() });
}

module.exports = {
  setDB,
  iniciarRegistro, verificarEmail, aprobarRegistro, rechazarRegistro,
  login,
  crearInvitacion, getInvitacion, aceptarInvitacion,
  getMiembros, actualizarMembresia, revocarAcceso,
  registrarAudit, getAuditLog,
  solicitarReset, confirmarReset
};
