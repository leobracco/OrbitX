// ============================================================
//  OrbitX — roles.js
//  Modelo completo de roles y permisos
//  Agro Parallel · Multi-tenant con acceso cruzado
// ============================================================

// ════════════════════════════════════════════════════════════
//  JERARQUÍA DE ROLES
// ════════════════════════════════════════════════════════════
//
//  superadmin          → Agro Parallel (vos)
//  ├── owner           → Dueño del campo, crea la org
//  ├── admin_org       → Admin delegado por el owner
//  ├── agronomo        → Lectura + análisis, multi-org
//  ├── contratista     → Acceso a lotes asignados
//  ├── operador        → Alertas + su máquina en tiempo real
//  └── viewer          → Solo lectura, reportes
//
// ════════════════════════════════════════════════════════════

const ROLES = {
  superadmin: {
    label: "Super Admin",
    descripcion: "Agro Parallel — acceso total a la plataforma",
    nivel: 100,
    color: "#B8FF3C"
  },
  owner: {
    label: "Dueño del campo",
    descripcion: "Acceso completo a su organización",
    nivel: 80,
    color: "#3C9EFF"
  },
  admin_org: {
    label: "Admin de organización",
    descripcion: "Gestiona usuarios y config dentro de la org",
    nivel: 70,
    color: "#3CFFCF"
  },
  agronomo: {
    label: "Agrónomo asesor",
    descripcion: "Análisis, mapas y densidades. Puede trabajar en múltiples orgs",
    nivel: 50,
    color: "#A78BFA"
  },
  contratista: {
    label: "Contratista",
    descripcion: "Acceso a lotes asignados y sus dispositivos",
    nivel: 40,
    color: "#FFB03C"
  },
  operador: {
    label: "Operador / Maquinista",
    descripcion: "Alertas en tiempo real y su máquina",
    nivel: 30,
    color: "#FB923C"
  },
  viewer: {
    label: "Solo lectura",
    descripcion: "Ve reportes y datos históricos, sin editar",
    nivel: 10,
    color: "#94A3B8"
  }
};

// ════════════════════════════════════════════════════════════
//  PERMISOS POR RECURSO
//  Cada permiso: { recurso: [acciones] }
//  Acciones: "read" | "write" | "delete" | "invite" | "admin"
// ════════════════════════════════════════════════════════════
const PERMISOS = {
  superadmin: {
    orgs:          ["read","write","delete","admin"],
    usuarios:      ["read","write","delete","invite","admin"],
    establecimientos: ["read","write","delete","admin"],
    lotes:         ["read","write","delete"],
    densidades:    ["read"],
    alertas:       ["read","write","delete"],
    dispositivos:  ["read","write","delete","admin"],
    backups_aog:   ["read","write","delete"],
    agraria:       ["read"],
    audit_log:     ["read"],
    facturacion:   ["read","write","admin"],
    config_server: ["read","write","admin"]
  },
  owner: {
    orgs:          ["read","write"],
    usuarios:      ["read","write","delete","invite"],
    establecimientos: ["read","write"],
    lotes:         ["read","write","delete"],
    densidades:    ["read"],
    alertas:       ["read","write"],
    dispositivos:  ["read","write"],
    backups_aog:   ["read"],
    agraria:       ["read"],
    audit_log:     ["read"],
    facturacion:   ["read"],
    config_server: []
  },
  admin_org: {
    orgs:          ["read"],
    usuarios:      ["read","write","invite"],
    establecimientos: ["read","write"],
    lotes:         ["read","write"],
    densidades:    ["read"],
    alertas:       ["read","write"],
    dispositivos:  ["read","write"],
    backups_aog:   ["read"],
    agraria:       ["read"],
    audit_log:     ["read"],
    facturacion:   [],
    config_server: []
  },
  agronomo: {
    orgs:          ["read"],
    usuarios:      ["read"],
    establecimientos: ["read"],
    lotes:         ["read"],
    densidades:    ["read"],
    alertas:       ["read"],
    dispositivos:  ["read"],
    backups_aog:   [],
    agraria:       ["read"],
    audit_log:     [],
    facturacion:   [],
    config_server: []
  },
  contratista: {
    orgs:          ["read"],
    usuarios:      [],
    establecimientos: ["read"],
    lotes:         ["read"],      // Solo lotes asignados (filtrado por membresía)
    densidades:    ["read"],
    alertas:       ["read","write"],
    dispositivos:  ["read"],      // Solo sus dispositivos
    backups_aog:   [],
    agraria:       ["read"],
    audit_log:     [],
    facturacion:   [],
    config_server: []
  },
  operador: {
    orgs:          [],
    usuarios:      [],
    establecimientos: ["read"],
    lotes:         ["read"],      // Solo lote activo
    densidades:    ["read"],
    alertas:       ["read","write"],
    dispositivos:  ["read"],      // Solo su dispositivo
    backups_aog:   [],
    agraria:       ["read"],
    audit_log:     [],
    facturacion:   [],
    config_server: []
  },
  viewer: {
    orgs:          [],
    usuarios:      [],
    establecimientos: ["read"],
    lotes:         ["read"],
    densidades:    ["read"],
    alertas:       ["read"],
    dispositivos:  [],
    backups_aog:   [],
    agraria:       ["read"],
    audit_log:     [],
    facturacion:   [],
    config_server: []
  }
};

// ════════════════════════════════════════════════════════════
//  FUNCIONES DE VERIFICACIÓN
// ════════════════════════════════════════════════════════════

/**
 * Verifica si un rol tiene permiso sobre un recurso+acción
 * @param {string} rol
 * @param {string} recurso
 * @param {string} accion
 */
function puede(rol, recurso, accion) {
  const perms = PERMISOS[rol];
  if (!perms) return false;
  return (perms[recurso] || []).includes(accion);
}

/**
 * Middleware Express: requiere permiso específico
 * req.user debe tener { rol, memberships: [{orgSlug, rol, restricciones}] }
 */
function requirePermiso(recurso, accion) {
  return (req, res, next) => {
    const { rol, estabSlug, memberships } = req.user;

    // superadmin siempre pasa
    if (rol === "superadmin") return next();

    // Buscar la membresía activa para el estab en cuestión
    const membership = (memberships || []).find(m => m.orgSlug === estabSlug);
    const rolEfectivo = membership?.rol || rol;

    if (!puede(rolEfectivo, recurso, accion)) {
      return res.status(403).json({
        error: "Sin permiso",
        detalle: `El rol '${rolEfectivo}' no puede '${accion}' en '${recurso}'`
      });
    }
    next();
  };
}

/**
 * Middleware: solo superadmin
 */
function soloSuperadmin(req, res, next) {
  if (req.user?.rol !== "superadmin")
    return res.status(403).json({ error: "Solo superadmin" });
  next();
}

/**
 * Middleware: owner o admin_org de la org activa
 */
function soloOwnerOAdmin(req, res, next) {
  const { rol, estabSlug, memberships } = req.user;
  if (rol === "superadmin") return next();
  const m = (memberships || []).find(m => m.orgSlug === estabSlug);
  if (["owner","admin_org"].includes(m?.rol))
    return next();
  return res.status(403).json({ error: "Se requiere owner o admin_org" });
}

/**
 * ¿Puede este rol ser invitado por el rol invitador?
 * Un owner puede invitar cualquier rol < superadmin
 * Un admin_org puede invitar agronomo, contratista, operador, viewer
 */
function puedeInvitar(rolInvitador, rolInvitado) {
  const nivel = (r) => ROLES[r]?.nivel || 0;
  if (rolInvitador === "superadmin") return true;
  if (rolInvitador === "owner")      return nivel(rolInvitado) < nivel("owner");
  if (rolInvitador === "admin_org")  return nivel(rolInvitado) < nivel("admin_org");
  return false;
}

// ════════════════════════════════════════════════════════════
//  RESTRICCIONES GRANULARES (dentro de una membresía)
//  El owner puede limitar aún más a un usuario específico
// ════════════════════════════════════════════════════════════
//
//  Ejemplo de restricciones en el doc de membresía:
//  {
//    lotes_ids: ["lote_xxx", "lote_yyy"],  // solo esos lotes
//    solo_lectura: true,                    // override a read-only
//    sin_agraria: true,                     // sin acceso a agrarIA
//    expira: 1742565600000                  // acceso temporal
//  }

function aplicarRestricciones(restricciones, recurso, accion) {
  if (!restricciones) return true;

  // Override total a solo lectura
  if (restricciones.solo_lectura && accion !== "read") return false;

  // Sin acceso a agrarIA
  if (restricciones.sin_agraria && recurso === "agraria") return false;

  // Acceso vencido
  if (restricciones.expira && Date.now() > restricciones.expira) return false;

  return true;
}

// ════════════════════════════════════════════════════════════
//  ROLES QUE PUEDE ASIGNAR CADA ROL
// ════════════════════════════════════════════════════════════
function rolesQuePuedeAsignar(rolInvitador) {
  return Object.entries(ROLES)
    .filter(([rol]) => puedeInvitar(rolInvitador, rol))
    .map(([rol, info]) => ({ rol, ...info }));
}

module.exports = {
  ROLES, PERMISOS,
  puede, requirePermiso, soloSuperadmin, soloOwnerOAdmin,
  puedeInvitar, rolesQuePuedeAsignar, aplicarRestricciones
};
