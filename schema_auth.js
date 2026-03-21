// ============================================================
//  OrbitX — schema_auth.js
//  Documentos CouchDB para el sistema de usuarios multi-tenant
//  Todos viven en orbitx_global
// ============================================================

// ════════════════════════════════════════════════════════════
//  1. ORGANIZACIÓN  (antes "establecimiento", ahora tiene más campos)
//     _id: "org_{slug}"
// ════════════════════════════════════════════════════════════
const DOC_ORG = {
  _id: "org_la_esperanza",
  tipo: "org",
  nombre: "La Esperanza",
  slug: "la_esperanza",          // = nombre de la DB: orbitx_la_esperanza
  ha_total: 3420,
  provincia: "Córdoba",
  pais: "Argentina",
  coords_centro: { lat: -31.4167, lng: -64.1833 },
  timezone: "America/Argentina/Cordoba",

  // Plan de suscripción
  plan: "pro",                   // "free" | "pro" | "enterprise"
  plan_vence: null,              // null = activo indefinidamente
  activa: true,
  aprobada: true,                // superadmin la aprobó

  // Módulos habilitados para esta org
  modulos: ["vistax", "linex", "centrix"],

  // Límites del plan
  limites: {
    usuarios_max: 20,
    dispositivos_max: 10,
    ha_max: null                 // null = sin límite
  },

  // Owner principal
  owner_uid: "usr_leonardobv",

  created_at: 1742565600000,
  updated_at: 1742565600000
};

// ════════════════════════════════════════════════════════════
//  2. USUARIO GLOBAL
//     _id: "usr_{uid}"
//     Un usuario puede pertenecer a múltiples orgs
//     via documentos de MEMBRESÍA separados
// ════════════════════════════════════════════════════════════
const DOC_USUARIO = {
  _id: "usr_leonardobv",
  tipo: "usuario",

  // Datos personales
  nombre: "Leonardo B.",
  email: "leo@laesperanza.com.ar",
  password_hash: "$2b$12$...",
  avatar_initials: "LB",
  telefono: "+54 9 351 000 0000",

  // Rol global (solo superadmin tiene valor especial aquí)
  // Para el resto, el rol real está en su membresía de cada org
  rol_global: "owner",           // "superadmin" | "owner" | "user"

  // Verificación y estado
  email_verificado: true,
  activo: true,
  bloqueado: false,
  motivo_bloqueo: null,

  // Notificaciones
  notificaciones: {
    push_token: null,
    push_tokens: [],             // múltiples dispositivos
    alertas_criticas: true,
    resumen_diario: true,
    cierre_lote: true,
    hora_resumen: "19:00"
  },

  // Preferencias
  prefs: {
    idioma: "es",
    tema: "dark",
    org_activa: "la_esperanza"  // última org usada
  },

  // Seguridad
  ultimo_login: null,
  login_count: 0,
  reset_token: null,
  reset_token_exp: null,

  created_at: 1742565600000,
  updated_at: 1742565600000
};

// ════════════════════════════════════════════════════════════
//  3. MEMBRESÍA  — el vínculo usuario ↔ org con rol y permisos
//     _id: "memb_{uid}_{orgSlug}"
//     Permite que un agrónomo tenga roles distintos en cada campo
// ════════════════════════════════════════════════════════════
const DOC_MEMBRESIA = {
  _id: "memb_joseingenieria_la_esperanza",
  tipo: "membresia",

  uid: "usr_joseingenieria",
  orgSlug: "la_esperanza",
  rol: "agronomo",               // rol DENTRO de esta org

  // Restricciones granulares (opcional — owner las define)
  restricciones: {
    lotes_ids: null,             // null = todos los lotes, o ["lote_xxx","lote_yyy"]
    solo_lectura: false,         // override a solo lectura
    sin_agraria: false,          // sin acceso a agrarIA
    expira: null,                // null = sin vencimiento, o timestamp
    solo_modulos: null           // null = todos, o ["vistax","linex"]
  },

  // Quién la creó y cuándo
  invitado_por: "usr_leonardobv",
  invitacion_id: "inv_abc123",   // referencia a la invitación original

  activa: true,
  created_at: 1742565600000,
  updated_at: 1742565600000
};

// ════════════════════════════════════════════════════════════
//  4. INVITACIÓN
//     _id: "inv_{token}"
//     Token de 48hs para registrarse o unirse a una org
// ════════════════════════════════════════════════════════════
const DOC_INVITACION = {
  _id: "inv_a3f8c2e1d9b7",
  tipo: "invitacion",

  // A quién va dirigida
  email_destino: "jose@ingenieria.com",
  nombre_destino: "José García",  // opcional

  // Qué org y qué rol se le asignará al aceptar
  orgSlug: "la_esperanza",
  orgNombre: "La Esperanza",
  rol_asignado: "agronomo",

  // Restricciones pre-configuradas por el owner
  restricciones: {
    lotes_ids: null,
    expira: null,
    solo_lectura: false
  },

  // Quien invitó
  invitado_por_uid: "usr_leonardobv",
  invitado_por_nombre: "Leonardo B.",

  // Estado
  token: "a3f8c2e1d9b7...",      // 48 chars hex, único
  estado: "pendiente",           // "pendiente" | "aceptada" | "rechazada" | "expirada"
  uid_aceptante: null,           // se llena cuando acepta

  // Tiempos
  expira_at: 1742738400000,      // 48hs desde creación
  aceptada_at: null,
  created_at: 1742565600000
};

// ════════════════════════════════════════════════════════════
//  5. REGISTRO PENDIENTE (self-service del owner)
//     _id: "reg_{token}"
// ════════════════════════════════════════════════════════════
const DOC_REGISTRO = {
  _id: "reg_b5d2a9c4e1f3",
  tipo: "registro",

  // Datos del futuro owner
  nombre: "Marcelo Rodríguez",
  email: "marcelo@elpomar.com",
  password_hash: "$2b$12$...",
  telefono: "+54 9 261 000 0000",

  // Datos del campo que quiere crear
  org_nombre: "El Pomar",
  org_slug: "el_pomar",
  org_ha: 1800,
  org_provincia: "Mendoza",

  // Token de verificación de email
  token_verificacion: "b5d2a9c4e1f3...",
  email_verificado: false,

  // Estado (superadmin aprueba o rechaza)
  estado: "pendiente_verificacion", // "pendiente_verificacion" | "pendiente_aprobacion" | "aprobado" | "rechazado"
  motivo_rechazo: null,

  expira_at: 1742652000000,      // 24hs para verificar email
  created_at: 1742565600000
};

// ════════════════════════════════════════════════════════════
//  6. AUDIT LOG
//     _id: "audit_{ts}_{uid}"
//     Registra acciones importantes para el owner
// ════════════════════════════════════════════════════════════
const DOC_AUDIT = {
  _id: "audit_1742565600000_leonardobv",
  tipo: "audit",
  orgSlug: "la_esperanza",

  uid: "usr_leonardobv",
  nombre_usuario: "Leonardo B.",
  rol: "owner",

  accion: "lote.cerrar",        // recurso.accion
  detalle: { loteId: "lote_20250321_arroyo_seco", ha: 120 },
  ip: "190.191.192.193",
  user_agent: "Mozilla/5.0...",

  ts: 1742565600000
};

// ════════════════════════════════════════════════════════════
//  DESIGN DOC — vistas para auth
// ════════════════════════════════════════════════════════════
const DESIGN_AUTH = {
  _id: "_design/auth",
  views: {
    // Usuarios por email (para login)
    usuario_por_email: {
      map: `function(doc){
        if(doc.tipo==='usuario' && doc.email)
          emit(doc.email, {uid:doc._id, nombre:doc.nombre, rol_global:doc.rol_global, activo:doc.activo});
      }`
    },
    // Membresías de un usuario (para cargar sus orgs al login)
    membresias_por_uid: {
      map: `function(doc){
        if(doc.tipo==='membresia' && doc.activa)
          emit(doc.uid, {orgSlug:doc.orgSlug, rol:doc.rol, restricciones:doc.restricciones});
      }`
    },
    // Miembros de una org (para el panel del owner)
    miembros_por_org: {
      map: `function(doc){
        if(doc.tipo==='membresia' && doc.activa)
          emit(doc.orgSlug, {uid:doc.uid, rol:doc.rol});
      }`
    },
    // Invitaciones pendientes por org
    invitaciones_pendientes: {
      map: `function(doc){
        if(doc.tipo==='invitacion' && doc.estado==='pendiente')
          emit(doc.orgSlug, {email:doc.email_destino, rol:doc.rol_asignado, expira:doc.expira_at});
      }`
    },
    // Registros pendientes de aprobación (para superadmin)
    registros_pendientes: {
      map: `function(doc){
        if(doc.tipo==='registro' && doc.estado==='pendiente_aprobacion')
          emit(doc.created_at, {nombre:doc.nombre, email:doc.email, org:doc.org_nombre});
      }`
    },
    // Audit log por org
    audit_por_org: {
      map: `function(doc){
        if(doc.tipo==='audit')
          emit([doc.orgSlug, doc.ts], {uid:doc.uid, accion:doc.accion, detalle:doc.detalle});
      }`
    }
  }
};

module.exports = {
  DOC_ORG, DOC_USUARIO, DOC_MEMBRESIA,
  DOC_INVITACION, DOC_REGISTRO, DOC_AUDIT,
  DESIGN_AUTH
};
