// routes/panel.js — OrbitX Panel Routes (con todos los fixes de permisos y UX)
"use strict";

const router  = require("express").Router();
const jwt     = require("jsonwebtoken");
const SECRET  = process.env.JWT_SECRET || "orbitx-dev-secret-cambiar";

// ── helpers CouchDB ───────────────────────────────────────
async function getAllDocs(db) {
  try {
    const r = await db.list({ include_docs: true });
    return r.rows.map(r => r.doc).filter(d => d && !d._id.startsWith("_"));
  } catch { return []; }
}

async function getRegBadge(db) {
  try {
    const r = await db.find({ selector:{ tipo:"registro", estado:"pendiente_aprobacion" }, limit:1 });
    if (r.docs.length) {
      const all = await db.find({ selector:{ tipo:"registro", estado:"pendiente_aprobacion" }, limit:500 });
      return all.docs.length;
    }
    return 0;
  } catch {
    const docs = await getAllDocs(db);
    return docs.filter(d => d.tipo==="registro" && d.estado==="pendiente_aprobacion").length;
  }
}

// ── Auth middleware ───────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies?.orbitx_token ||
                (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.redirect("/login");
  try {
    req.jwtUser = jwt.verify(token, SECRET);
    next();
  } catch {
    res.clearCookie("orbitx_token");
    res.redirect("/login");
  }
}

function requireSuperadmin(req, res, next) {
  if (req.jwtUser?.rol_global !== "superadmin") return res.redirect("/dashboard");
  next();
}

function requireAdmin(req, res, next) {
  const rol = req.jwtUser?.rol_global;
  if (!["superadmin","owner","admin_org"].includes(rol)) return res.redirect("/dashboard");
  next();
}

function isSA(req) { return req.jwtUser?.rol_global === "superadmin"; }
function isAdmin(req) {
  return ["superadmin","owner","admin_org"].includes(req.jwtUser?.rol_global);
}

// ── base EJS vars ─────────────────────────────────────────
function base(req, extra = {}) {
  const rol = req.jwtUser?.rol_global || "usuario";
  return {
    user:       req.jwtUser,
    rol,
    isSA:       isSA(req),
    isAdmin:    isAdmin(req),
    regBadge:   extra.regBadge || 0,
    activeNav:  req.path,
    fmtDate:    ts => ts ? new Date(ts).toLocaleString("es-AR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : "–",
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────
// LOGIN / LOGOUT
// ─────────────────────────────────────────────────────────
router.get("/login", (req, res) => {
  const token = req.cookies?.orbitx_token;
  if (token) { try { jwt.verify(token, SECRET); return res.redirect("/dashboard"); } catch {} }
  res.render("login", { title:"Ingresar" });
});

router.get("/logout", (req, res) => {
  res.clearCookie("orbitx_token");
  res.redirect("/login");
});

// ─────────────────────────────────────────────────────────
// INVITACIÓN — landing pública para aceptar (link del mail)
// ─────────────────────────────────────────────────────────
router.get("/invitacion/:token", async (req, res) => {
  const svc   = require("../services/auth_service");
  const ROLES = require("../roles").ROLES;
  let invitacion = null, error = null;
  try {
    const inv = await svc.getInvitacion(req.params.token);
    invitacion = {
      token:        inv.token,
      orgNombre:    inv.orgNombre,
      orgSlug:      inv.orgSlug,
      rol:          inv.rol_asignado,
      rol_label:    ROLES[inv.rol_asignado]?.label || inv.rol_asignado,
      invitadoPor:  inv.invitado_por_nombre,
      emailDestino: inv.email_destino,
      expira_at:    inv.expira_at,
    };
  } catch (e) {
    error = e.message || "Invitación no válida";
  }
  res.render("invitacion", { invitacion, error });
});

// ─────────────────────────────────────────────────────────
// RESET PASSWORD — landing pública (link del mail)
// ─────────────────────────────────────────────────────────
router.get("/reset-password/:token", (req, res) => {
  res.render("reset-password", { token: req.params.token });
});

// ─────────────────────────────────────────────────────────
// DASHBOARD — filtrado por rol
// ─────────────────────────────────────────────────────────
router.get(["/", "/dashboard"], requireAuth, async (req, res) => {
  const db    = req.app.locals.globalDB;
  const SA    = isSA(req);
  const Admin = isAdmin(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;

  let stats = { usuarios:0, establecimientos:0, regPendientes:0 };
  let registros = [], usuarios = [];

  try {
    const docs = await getAllDocs(db);

    // Registros pendientes — solo superadmin
    if (SA) {
      registros = docs.filter(d => d.tipo==="registro" && d.estado==="pendiente_aprobacion").slice(0,4);
      stats.regPendientes = registros.length;
    }

    // Usuarios: superadmin ve todos, admin ve los de su estab, usuario normal: ninguno
    if (SA) {
      usuarios = docs.filter(d => d.tipo==="usuario" && d.activo!==false)
                     .map(({ password_hash, reset_token, ...u })=>u).slice(0,5);
      stats.usuarios = docs.filter(d => d.tipo==="usuario" && d.activo!==false).length;
    } else if (Admin && miSlug) {
      // Buscar usuarios del mismo estab
      const membs = docs.filter(d => d.tipo==="membresia" && d.estab_slug===miSlug);
      const uids  = new Set(membs.map(m => m.usuario_id));
      usuarios = docs.filter(d => d.tipo==="usuario" && uids.has(d._id) && d.activo!==false)
                     .map(({ password_hash, reset_token, ...u })=>u).slice(0,5);
      stats.usuarios = usuarios.length;
    } else {
      // Usuario común: no ve usuarios, solo su propio dato
      stats.usuarios = null; // null = ocultar KPI
    }

    // Establecimientos: superadmin ve todos, otros ven solo el suyo
    if (SA) {
      stats.establecimientos = docs.filter(d => d.tipo==="org").length;
    } else if (miSlug) {
      stats.establecimientos = docs.filter(d => d.tipo==="org" && d.slug===miSlug).length;
    } else {
      stats.establecimientos = null;
    }

  } catch(e) { console.error("[Panel/dashboard]", e.message); }

  const regBadge = SA ? stats.regPendientes : 0;
  res.render("layout", {
    ...base(req, { regBadge }),
    title:"Dashboard", page:"dashboard",
    stats, registros, usuarios
  });
});

// ─────────────────────────────────────────────────────────
// REGISTROS — solo superadmin
// ─────────────────────────────────────────────────────────
router.get("/registros", requireAuth, requireSuperadmin, async (req, res) => {
  const db = req.app.locals.globalDB;
  let registros = [];
  try {
    const r = await db.find({ selector:{ tipo:"registro", estado:"pendiente_aprobacion" }, limit:100 });
    registros = r.docs;
  } catch {
    registros = (await getAllDocs(db)).filter(d => d.tipo==="registro" && d.estado==="pendiente_aprobacion");
  }
  const regBadge = registros.length;
  res.render("layout", { ...base(req, { regBadge }), title:"Registros pendientes", page:"registros", registros });
});

// ─────────────────────────────────────────────────────────
// USUARIOS — solo superadmin
// ─────────────────────────────────────────────────────────
router.get("/usuarios", requireAuth, requireSuperadmin, async (req, res) => {
  const db = req.app.locals.globalDB;
  let usuarios = [];
  try {
    const r = await db.find({ selector:{ tipo:"usuario" }, limit:500 });
    usuarios = r.docs.map(({ password_hash, reset_token, ...u })=>u);
  } catch {
    usuarios = (await getAllDocs(db)).filter(d=>d.tipo==="usuario").map(({ password_hash, reset_token, ...u })=>u);
  }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Usuarios", page:"usuarios", usuarios });
});

// ─────────────────────────────────────────────────────────
// ROLES
// ─────────────────────────────────────────────────────────
router.get("/roles", requireAuth, requireAdmin, (req, res) => {
  res.render("layout", { ...base(req), title:"Roles y permisos", page:"roles" });
});

// ─────────────────────────────────────────────────────────
// GRUPOS — solo superadmin. Los grupos son globales (orbitx_global,
// sin scope por org) y solo el superadmin los gestiona (mutaciones en
// routes/grupos.js usan soloAdmin=superadmin). owner/admin_org NO deben
// ver grupos que están por encima de su alcance.
// ─────────────────────────────────────────────────────────
router.get("/grupos", requireAuth, requireSuperadmin, (req, res) => {
  res.render("layout", { ...base(req), title:"Grupos", page:"grupos" });
});

// ─────────────────────────────────────────────────────────
// FIRMWARES — gestión OTA
// owner/admin/SA pueden ver el catálogo. Solo SA sube/elimina.
// ─────────────────────────────────────────────────────────
router.get("/firmwares", requireAuth, requireAdmin, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", { ...base(req, { regBadge }), title: "Firmwares", page: "firmwares" });
});

// ─────────────────────────────────────────────────────────
// ESTABLECIMIENTOS
// superadmin: ve todos con full datos
// owner/admin: ve solo el suyo con full datos
// usuario común: redirect
// ─────────────────────────────────────────────────────────
router.get("/establecimientos", requireAuth, requireAdmin, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;

  let establecimientos = [], ownerNombre = {};
  try {
    const docs = await getAllDocs(db);

    if (SA) {
      establecimientos = docs.filter(d => d.tipo==="org");
    } else if (miSlug) {
      establecimientos = docs.filter(d => d.tipo==="org" && d.slug===miSlug);
    }

    // Mapa id→nombre para owners
    docs.filter(d => d.tipo==="usuario").forEach(u => { ownerNombre[u._id] = u.nombre || u.email; });

    // Asegurar que cada estab tenga campos completos para el modal
    establecimientos = establecimientos.map(e => ({
      _id:          e._id,
      slug:         e.slug       || "",
      nombre:       e.nombre     || "",
      rut:          e.rut        || "",
      domicilio:    e.domicilio  || "",
      localidad:    e.localidad  || "",
      provincia:    e.provincia  || "",
      pais:         e.pais       || "Argentina",
      email:        e.email      || "",
      telefono:     e.telefono   || "",
      owner_id:     e.owner_id   || "",
      activo:       e.activo !== false,
      ts_creacion:  e.ts_creacion || null,
    }));

  } catch(e) { console.error("[Panel/estab]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", {
    ...base(req, { regBadge }),
    title:"Establecimientos", page:"establecimientos",
    establecimientos, ownerNombre
  });
});

// ─────────────────────────────────────────────────────────
// LOTES
// ─────────────────────────────────────────────────────────
router.get("/lotes", requireAuth, async (req, res) => {
  const db      = req.app.locals.globalDB;
  const SA      = isSA(req);
  const miSlug  = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;
  const estado  = req.query.estado || null;
  let lotes     = [];

  try {
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    let slugs  = [];

    if (SA) {
      const orgs = (await getAllDocs(db)).filter(d => d.tipo==="org");
      slugs = orgs.map(o => o.slug);
    } else if (miSlug) {
      slugs = [miSlug];
    }

    for (const slug of slugs) {
      try {
        const estabDB = nano.db.use(`orbitx_${slug}`);
        const sel = { tipo:"lote" };
        if (estado) sel.estado = estado;
        const r = await estabDB.find({ selector:sel, limit:50, sort:[{fecha_inicio:"desc"}] });
        r.docs.forEach(l => { l.orgSlug = slug; lotes.push(l); });
      } catch {}
    }

    lotes.sort((a,b) => (b.fecha_inicio||0) - (a.fecha_inicio||0));
  } catch(e) { console.error("[Panel/lotes]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", {
    ...base(req, { regBadge }),
    title:"Lotes", page:"lotes",
    lotes, filtroEstado: estado
  });
});

// ─────────────────────────────────────────────────────────
// ALERTAS
// ─────────────────────────────────────────────────────────
router.get("/alertas", requireAuth, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;
  let alertas  = [];

  try {
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    let slugs  = [];

    if (SA) {
      const orgs = (await getAllDocs(db)).filter(d => d.tipo==="org");
      slugs = orgs.map(o => o.slug);
    } else if (miSlug) {
      slugs = [miSlug];
    }

    for (const slug of slugs) {
      try {
        const estabDB = nano.db.use(`orbitx_${slug}`);
        const r = await estabDB.find({ selector:{ tipo:"alerta", resuelta:{ $ne:true } }, limit:100 });
        r.docs.forEach(a => { a.estab_slug = slug; alertas.push(a); });
      } catch {}
    }

    alertas.sort((a,b) => (b.ts||0) - (a.ts||0));
  } catch(e) { console.error("[Panel/alertas]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Alertas activas", page:"alertas", alertas });
});

// ─────────────────────────────────────────────────────────
// DISPOSITIVOS
// superadmin: todos; owner/admin: solo el suyo; usuario: redirect
// ─────────────────────────────────────────────────────────
router.get("/dispositivos", requireAuth, requireAdmin, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;
  let dispositivos = [], establecimientos = [];
  const ahora = Date.now();

  try {
    const docs = await getAllDocs(db);

    if (SA) {
      dispositivos = docs.filter(d => d.tipo==="device");
      establecimientos = docs.filter(d => d.tipo==="org").map(e => ({ slug:e.slug, nombre:e.nombre }));
    } else if (miSlug) {
      dispositivos = docs.filter(d => d.tipo==="device" && (d.estab_slug===miSlug || !d.estab_slug));
      establecimientos = docs.filter(d => d.tipo==="org" && d.slug===miSlug).map(e => ({ slug:e.slug, nombre:e.nombre }));
    }

    dispositivos = dispositivos.map(d => ({
      ...d,
      token:  undefined,
      online: d.ultimo_visto && (ahora - d.ultimo_visto) < 2*60*1000,
    }));

  } catch(e) { console.error("[Panel/dispositivos]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Dispositivos", page:"dispositivos", dispositivos, establecimientos });
});

// ─────────────────────────────────────────────────────────
// CAMARAS — vivo, por tractor (admin de la org o superadmin)
// ─────────────────────────────────────────────────────────
router.get("/camaras", requireAuth, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;
  let dispositivos = [];
  const ahora = Date.now();

  try {
    const docs = await getAllDocs(db);
    if (SA) {
      dispositivos = docs.filter(d => d.tipo === "device");
    } else if (miSlug) {
      dispositivos = docs.filter(d => d.tipo === "device" && d.estab_slug === miSlug);
    }
    dispositivos = dispositivos
      .map(d => ({
        device_id: d.device_id,
        nombre:    d.nombre || d.device_id,
        online:    d.ultimo_visto && (ahora - d.ultimo_visto) < 2 * 60 * 1000,
        camaras:   d.camaras || [],
      }))
      .sort((a, b) => (b.online - a.online) || a.nombre.localeCompare(b.nombre));
  } catch (e) { console.error("[Panel/camaras]", e.message); }

  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", { ...base(req, { regBadge }), title: "Cámaras", page: "camaras", dispositivos });
});

// ─────────────────────────────────────────────────────────
// COUCHDB — solo superadmin
// ─────────────────────────────────────────────────────────
router.get("/couchdb", requireAuth, requireSuperadmin, async (req, res) => {
  const couchInfo = { version: "–", dbs: 0, docs: 0, url: "–", dbList: [] };
  try {
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    const info = await nano.info();
    const dbs  = await nano.db.list();
    // Solo bases del producto OrbitX. Filtramos las internas de Couch (_users,
    // _replicator, _global_changes) y cualquier otra base ajena al producto.
    const dbList = dbs.filter(n => n.startsWith("orbitx_"));
    couchInfo.version = info.version;
    couchInfo.dbs     = dbList.length;
    couchInfo.dbList  = dbList;
    couchInfo.url     = (process.env.COUCHDB_URL || "").replace(/:\/\/.*@/, "://***@") || "http://localhost:5984";
  } catch (e) { console.error("[Panel/couchdb]", e.message); }
  const regBadge = await getRegBadge(req.app.locals.globalDB).catch(() => 0);
  res.render("layout", { ...base(req, { regBadge }), title: "CouchDB", page: "couchdb", couchInfo });
});

// ─────────────────────────────────────────────────────────
// MAPA
// Solo lista de lotes por estab + lazy load al click
// ─────────────────────────────────────────────────────────
router.get("/mapa", requireAuth, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;

  let establecimientos = [];
  try {
    const docs = await getAllDocs(db);
    if (SA) {
      establecimientos = docs.filter(d => d.tipo==="org").map(e => ({ slug:e.slug, nombre:e.nombre }));
    } else if (miSlug) {
      establecimientos = docs.filter(d => d.tipo==="org" && d.slug===miSlug).map(e => ({ slug:e.slug, nombre:e.nombre }));
    }
  } catch(e) { console.error("[Panel/mapa]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  // No pasamos los lotes — el JS los carga via /api/aog/lotes (lista liviana) y /api/aog/mapa/:nombre (lazy)
  res.render("layout", {
    ...base(req, { regBadge }),
    title:"Mapa de lotes", page:"mapa",
    establecimientos, miSlug: miSlug || "",
    extraJs: "mapa-ndvi.js"
  });
});

// ─────────────────────────────────────────────────────────
// VEHÍCULOS
// Extraer nombre real del XML — no usar claves internas
// ─────────────────────────────────────────────────────────
function extraerNombreVehiculo(xmlStr, fallback) {
  if (!xmlStr) return fallback || "Vehículo sin nombre";
  try {
    // <Name>Nombre del vehículo</Name>  (caso más común en AOG)
    let m = xmlStr.match(/<Name[^>]*>\s*([^<]+)\s*<\/Name>/i);
    if (m) return m[1].trim();

    // Atributo: <Vehi... Name="..."
    m = xmlStr.match(/\bName\s*=\s*"([^"]+)"/i);
    if (m) {
      const v = m[1].trim();
      // Descartar si parece una clave interna (camelCase largo sin espacios)
      if (v.length > 2 && !/^[a-z]/.test(v) || v.includes(" ")) return v;
      // Si es camelCase sin espacios, buscar siguiente opción
    }

    // <Description>...</Description>
    m = xmlStr.match(/<Description[^>]*>\s*([^<]+)\s*<\/Description>/i);
    if (m) return m[1].trim();

    // <Vehicle Name="..."> o atributo
    m = xmlStr.match(/<Vehicle[^>]+\sname\s*=\s*"([^"]+)"/i);
    if (m) return m[1].trim();

    return fallback || "Vehículo sin nombre";
  } catch {
    return fallback || "Vehículo sin nombre";
  }
}

router.get("/vehiculos", requireAuth, async (req, res) => {
  // Render vacío — los datos se cargan vía /api/aog/vehiculos con paginación.
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", { ...base(req, { regBadge }), title: "Vehículos", page: "vehiculos" });
});

// ─────────────────────────────────────────────────────────
// CONFIGURACIONES (antes /aog) — sin mención de AOG/AgOpenGPS
// Filtrado por estab igual que el resto
// ─────────────────────────────────────────────────────────
router.get("/configuraciones", requireAuth, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;

  let establecimientos = [], lotes = [];
  try {
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    const docs = await getAllDocs(db);

    if (SA) {
      establecimientos = docs.filter(d => d.tipo==="org");
    } else if (miSlug) {
      establecimientos = docs.filter(d => d.tipo==="org" && d.slug===miSlug);
    }

    for (const org of establecimientos) {
      try {
        const estabDB = nano.db.use(`orbitx_${org.slug}`);
        const lotesDocs = await estabDB.find({ selector:{ tipo:"aog_archivo", es_lote:true }, limit:200 });
        const porLote = {};
        lotesDocs.docs.forEach(d => {
          const n = d.lote_nombre || "?";
          if (!porLote[n]) porLote[n] = { nombre:n, archivos:[], tiene_boundary:false, tiene_sections:false, ts_ultimo:0 };
          porLote[n].archivos.push(d.subtipo);
          if (d.subtipo==="boundary"||d.subtipo==="boundary_kml") porLote[n].tiene_boundary = true;
          if (d.subtipo==="sections_coverage") porLote[n].tiene_sections = true;
          if (d.ts > porLote[n].ts_ultimo) porLote[n].ts_ultimo = d.ts;
        });
        Object.values(porLote).forEach(l => { l.orgSlug = org.slug; lotes.push(l); });
      } catch {}
    }

    lotes.sort((a,b) => (b.ts_ultimo||0) - (a.ts_ultimo||0));
  } catch(e) { console.error("[Panel/configuraciones]", e.message); }

  // Calcular stats que aog.ejs espera
  let totalArchivos = 0, tieneVehicle = false, ultimoSync = 0;
  const tiposCount = {};
  lotes.forEach(l => {
    totalArchivos += l.archivos?.length || 0;
    (l.archivos || []).forEach(t => { tiposCount[t] = (tiposCount[t]||0) + 1; });
    if ((l.archivos||[]).includes("vehicle_config")) tieneVehicle = true;
    if ((l.ts_ultimo||0) > ultimoSync) ultimoSync = l.ts_ultimo;
  });

  const stats = {
    lotes_count:    lotes.length,
    total_archivos: totalArchivos,
    tiene_vehicle:  tieneVehicle,
    ultimo_sync:    ultimoSync || null,
    tipos:          tiposCount,
  };

  // aogPath: ruta configurada en el agente (solo informativa)
  const aogPath = process.env.AOG_PATH || "C:\\Piloto AP";

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", {
    ...base(req, { regBadge }),
    title:"Configuraciones", page:"aog",
    establecimientos, lotes, stats, aogPath
  });
});

// Redirect legacy URL
router.get("/aog", requireAuth, (req, res) => res.redirect("/configuraciones"));

// ─────────────────────────────────────────────────────────
// CONFIG — solo superadmin
// ─────────────────────────────────────────────────────────
router.get("/config", requireAuth, requireSuperadmin, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);

  const envVars = [
    "PORT","COUCHDB_URL","JWT_SECRET","DEVICE_MASTER_TOKEN","ANTHROPIC_API_KEY",
    "CORS_ORIGIN","BASE_URL","TELEGRAM_ADMIN_BOT_TOKEN","TELEGRAM_ADMIN_CHAT_ID",
    "SMTP_HOST","SMTP_USER","SMTP_PASS","WHATSAPP_API_VERSION","FIRMWARE_DIR",
  ];
  const envSet = {};
  envVars.forEach(v => { envSet[v] = !!process.env[v]; });

  const config = {
    port:      process.env.PORT || 4000,
    nodeEnv:   process.env.NODE_ENV || "development",
    corsOrigin:process.env.CORS_ORIGIN || "*",
    couchUrl:  (process.env.COUCHDB_URL || "").replace(/:\/\/.*@/, "://***@") || "http://localhost:5984",
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    envSet,
  };

  res.render("layout", {
    ...base(req, { regBadge }),
    title: "Configuración del sistema",
    page:  "config",
    config,
  });
});

// ─────────────────────────────────────────────────────────
// VISTAX
// ─────────────────────────────────────────────────────────
router.get("/vistax", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"VistaX — Siembra", page:"vistax", stats:{} });
});

// Viewer dedicado de mapas SHP por sesión (sincronizados desde AOG).
// Distinto de /vistax (que muestra densidad GeoJSON del lote completo).
router.get("/vistax-mapas", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"VistaX — Mapas de sesión", page:"vistax-mapas" });
});

// ─────────────────────────────────────────────────────────
// agrarIA
// ─────────────────────────────────────────────────────────
router.get("/agraria", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"agrarIA", page:"agraria" });
});

// ─────────────────────────────────────────────────────────
// PRESCRIPCIONES
// ─────────────────────────────────────────────────────────
router.get("/prescripciones", requireAuth, async (req, res) => {
  const db     = req.app.locals.globalDB;
  const SA     = isSA(req);
  const miSlug = req.jwtUser?.estabSlug || req.jwtUser?.estab_slug || null;
  const nano   = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
  let establecimientos = [];
  try {
    const docs = await getAllDocs(db);
    if (SA) {
      establecimientos = docs.filter(d => d.tipo==="org");
    } else if (miSlug) {
      establecimientos = docs.filter(d => d.tipo==="org" && d.slug===miSlug);
    }
  } catch(e) { console.error("[Panel/prescripciones]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Prescripciones", page:"prescripciones", establecimientos });
});

// ─────────────────────────────────────────────────────────
// INTEGRACIONES
// ─────────────────────────────────────────────────────────
router.get("/integraciones", requireAuth, requireAdmin, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", {
    ...base(req, { regBadge }),
    title:     "Integraciones",
    page:      "integraciones",
    activeNav: "/integraciones",
  });
});
// ─────────────────────────────────────────────────────────
// TRACKING — Mapa de tractores en vivo + historial
// ─────────────────────────────────────────────────────────
router.get("/tracking", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", {
    ...base(req, { regBadge }),
    title:   "Tracking",
    page:    "tracking",
    extraJs: "tracking-mapa.js",
  });
});

module.exports = router;
