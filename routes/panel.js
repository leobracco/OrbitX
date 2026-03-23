// routes/panel.js — Panel SSR con EJS
const router = require("express").Router();
const jwt    = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "orbitx-dev-secret";

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

// El usuario solo puede ver datos de su propio estab
// El superadmin ve todo
function soloMiEstab(req) {
  return req.jwtUser?.rol_global !== "superadmin";
}

// Formatea nombre de lote: "2025-06-12 13-58" → "12/06/2025 13:58"
function fmtLoteNombre(nombre) {
  if (!nombre) return "–";
  // Formato fecha AOG: "YYYY-MM-DD HH-mm"
  const m = nombre.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  return nombre;
}

function base(req, extra = {}) {
  return { user: req.jwtUser, activeNav: req.path, regBadge: 0, alertasBadge: 0, ...extra };
}

// ── Helpers de datos ─────────────────────────────────────
async function getRegBadge(db) {
  try {
    const r = await db.find({ selector:{ tipo:"registro", estado:"pendiente_aprobacion" }, limit:1 });
    return r.docs.length;
  } catch {
    const all = await db.list({ include_docs:true });
    return all.rows.filter(r => r.doc.tipo==="registro" && r.doc.estado==="pendiente_aprobacion").length;
  }
}

async function getAllDocs(db) {
  const all = await db.list({ include_docs:true });
  return all.rows.map(r => r.doc).filter(d => !d._id.startsWith("_design"));
}

// ── LOGIN ────────────────────────────────────────────────
router.get("/login", (req, res) => {
  const token = req.cookies?.orbitx_token;
  if (token) { try { jwt.verify(token, SECRET); return res.redirect("/dashboard"); } catch {} }
  res.render("login", { title:"Ingresar" });
});

router.get("/logout", (req, res) => {
  res.clearCookie("orbitx_token");
  res.redirect("/login");
});

// ── DASHBOARD ────────────────────────────────────────────
router.get(["/", "/dashboard"], requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  let stats = { usuarios:0, establecimientos:0, regPendientes:0 };
  let registros = [], usuarios = [];
  try {
    const docs = await getAllDocs(db);
    usuarios   = docs.filter(d => d.tipo==="usuario").map(({ password_hash, reset_token, ...u })=>u).slice(0,5);
    registros  = docs.filter(d => d.tipo==="registro" && d.estado==="pendiente_aprobacion").slice(0,4);
    stats = {
      usuarios:         docs.filter(d => d.tipo==="usuario" && d.activo!==false).length,
      establecimientos: docs.filter(d => d.tipo==="org").length,
      regPendientes:    registros.length,
    };
  } catch(e) { console.error("[Panel/dashboard]", e.message); }
  res.render("layout", { ...base(req, { regBadge: stats.regPendientes }), title:"Dashboard", page:"dashboard", stats, registros, usuarios });
});

// ── REGISTROS ────────────────────────────────────────────
router.get("/registros", requireAuth, requireSuperadmin, async (req, res) => {
  const db = req.app.locals.globalDB;
  let registros = [];
  try {
    const r = await db.find({ selector:{ tipo:"registro", estado:"pendiente_aprobacion" }, limit:100 });
    registros = r.docs;
  } catch {
    registros = (await getAllDocs(db)).filter(d => d.tipo==="registro" && d.estado==="pendiente_aprobacion");
  }
  res.render("layout", { ...base(req, { regBadge:registros.length }), title:"Registros pendientes", page:"registros", registros });
});

// ── USUARIOS ─────────────────────────────────────────────
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

// ── ROLES ────────────────────────────────────────────────
router.get("/roles", requireAuth, (req, res) => {
  res.render("layout", { ...base(req), title:"Roles y permisos", page:"roles" });
});

// ── ESTABLECIMIENTOS ─────────────────────────────────────
router.get("/establecimientos", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const isSA = req.jwtUser?.rol_global === "superadmin";
  let establecimientos = [], ownerNombre = {};
  try {
    const docs = await getAllDocs(db);
    if (isSA) {
      establecimientos = docs.filter(d => d.tipo==="org");
    } else {
      const slug = req.jwtUser?.estabSlug;
      establecimientos = docs.filter(d => d.tipo==="org" && d.slug === slug);
    }
    const owners = docs.filter(d => d.tipo==="usuario");
    owners.forEach(u => { ownerNombre[u._id] = u.nombre; });
  } catch(e) { console.error("[Panel/estab]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Establecimientos", page:"establecimientos", establecimientos, ownerNombre });
});

// ── LOTES ────────────────────────────────────────────────
router.get("/lotes", requireAuth, async (req, res) => {
  const db   = req.app.locals.globalDB;
  const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
  const isSA = req.jwtUser?.rol_global === "superadmin";
  let lotes  = [];

  try {
    // Determinar qué DBs consultar
    let slugs = [];
    if (isSA) {
      const allDBs = await nano.db.list();
      slugs = allDBs.filter(n=>n.startsWith("orbitx_")).map(n=>n.replace("orbitx_",""))
                    .filter(s => s !== "global");
    } else {
      const slug = req.jwtUser?.estabSlug;
      if (slug && slug !== "null") slugs.push(slug);
      slugs.push("unassigned");
    }

    for (const slug of [...new Set(slugs)]) {
      try {
        const estabDB = nano.db.use(`orbitx_${slug}`);
        // Buscar aog_archivo con es_lote = true y agrupar por lote_nombre
        let docs = [];
        try {
          const r = await estabDB.find({ selector:{ tipo:"aog_archivo", es_lote:true }, limit:500 });
          docs = r.docs;
        } catch {
          const all = await estabDB.list({ include_docs:true });
          docs = all.rows.map(r=>r.doc).filter(d => d.tipo==="aog_archivo" && d.es_lote);
        }

        // Agrupar por lote_nombre
        const grupos = {};
        docs.forEach(d => {
          const n = d.lote_nombre || "?";
          if (!grupos[n]) grupos[n] = { nombre:n, orgSlug:slug, archivos:[], tiene_boundary:false, tiene_sections:false, ts_ultimo:0 };
          grupos[n].archivos.push(d.subtipo);
          if (d.subtipo==="boundary"||d.subtipo==="boundary_kml") grupos[n].tiene_boundary = true;
          if (d.subtipo==="sections_coverage") grupos[n].tiene_sections = true;
          if (d.ts > grupos[n].ts_ultimo) grupos[n].ts_ultimo = d.ts;
        });
        Object.values(grupos).forEach(l => lotes.push(l));
      } catch(e) { console.error(`[Panel/lotes] ${slug}:`, e.message); }
    }
    lotes.sort((a,b) => b.ts_ultimo - a.ts_ultimo);
  } catch(e) { console.error("[Panel/lotes]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Lotes", page:"lotes", lotes, filtroEstado: null });
});

// ── ALERTAS ──────────────────────────────────────────────
router.get("/alertas", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  let alertas = [];
  try {
    const isSA = req.jwtUser?.rol_global === "superadmin";
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    let orgs = [];
    if (isSA) {
      orgs = (await getAllDocs(db)).filter(d => d.tipo==="org");
    } else {
      const slug = req.jwtUser?.estabSlug;
      if (slug && slug !== "null") {
        const doc = await db.get(`org_${slug}`).catch(()=>null);
        if (doc) orgs = [doc];
      }
    }
    for (const org of orgs) {
      try {
        const estabDB = nano.db.use(`orbitx_${org.slug}`);
        const r = await estabDB.find({ selector:{ tipo:"alerta", resuelta:{ "$ne":true } }, limit:100 });
        r.docs.forEach(a => { a.orgSlug = org.slug; alertas.push(a); });
      } catch {}
    }
    alertas.sort((a,b) => (b.ts_inicio||b.ts||0) - (a.ts_inicio||a.ts||0));
  } catch(e) { console.error("[Panel/alertas]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge, alertasBadge: alertas.length }), title:"Alertas activas", page:"alertas", alertas });
});

// ── DISPOSITIVOS ─────────────────────────────────────────
router.get("/dispositivos", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  let dispositivos = [], establecimientos = [];
  try {
    const docs   = await getAllDocs(db);
    const ahora  = Date.now();
    const isSA   = req.jwtUser?.rol_global === "superadmin";
    const miSlug = req.jwtUser?.estabSlug;
    dispositivos = docs
      .filter(d => d.tipo === "device" && (isSA || d.estab_slug === miSlug || !d.estab_slug))
      .map(d => ({ ...d, token:undefined, online: d.ultimo_visto && (ahora - d.ultimo_visto) < 2*60*1000 }));
    // Establecimientos: superadmin ve todos, owner solo el suyo
    establecimientos = isSA
      ? docs.filter(d => d.tipo === "org").map(e => ({ slug:e.slug, nombre:e.nombre }))
      : docs.filter(d => d.tipo === "org" && d.slug === miSlug).map(e => ({ slug:e.slug, nombre:e.nombre }));
  } catch(e) { console.error("[Panel/dispositivos]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Dispositivos", page:"dispositivos", dispositivos, establecimientos });
});

// ── COUCHDB ──────────────────────────────────────────────
router.get("/couchdb", requireAuth, requireSuperadmin, async (req, res) => {
  const couchInfo = { version:"–", dbs:0, docs:0, url:"–", dbList:[] };
  try {
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    const info  = await nano.info();
    const dbs   = await nano.db.list();
    couchInfo.version = info.version;
    couchInfo.dbs     = dbs.length;
    couchInfo.dbList  = dbs;
    couchInfo.url     = (process.env.COUCHDB_URL || "").replace(/:\/\/.*@/, "://***@") || "http://localhost:5984";
    // Contar docs totales
    let total = 0;
    for (const name of dbs.filter(n => n.startsWith("orbitx_"))) {
      try { const i = await nano.db.get(name); total += i.doc_count||0; } catch {}
    }
    couchInfo.docs = total.toLocaleString("es-AR");
  } catch(e) { console.error("[Panel/couchdb]", e.message); }
  res.render("layout", { ...base(req), title:"CouchDB", page:"couchdb", couchInfo });
});

// ── VEHICULOS ────────────────────────────────────────────────
router.get("/vehiculos", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const { parseVehicleXML, formatearVehiculo, extraerNombreVehiculo } = require("../services/aog_vehicle_parser");
  let vehiculos = [], vehiculosRaw = [];

  try {
    const nano   = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    const isSA   = req.jwtUser?.rol_global === "superadmin";
    let slugs = [];
    if (isSA) {
      const allDBs = await nano.db.list();
      slugs = allDBs.filter(n => n.startsWith("orbitx_")).map(n => n.replace("orbitx_",""));
    } else {
      const slug = req.jwtUser?.estabSlug;
      if (slug && slug !== "null") slugs.push(slug);
      slugs.push("unassigned");
    }

    for (const slug of slugs) {
      try {
        const estabDB = nano.db.use(`orbitx_${slug}`);
        let docs = [];
        try {
          const r = await estabDB.find({ selector:{ tipo:"aog_archivo", subtipo:"vehicle_config" }, limit:20 });
          docs = r.docs;
        } catch {
          const all = await estabDB.list({ include_docs:true });
          docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="aog_archivo"&&d.subtipo==="vehicle_config");
        }
        docs.forEach(d => {
          const raw    = parseVehicleXML(d.contenido);
          const grupos = formatearVehiculo(raw);
          vehiculos.push({ nombre:extraerNombreVehiculo(raw, d.nombre), nombre_archivo:d.nombre, device_id:d.device_id, estab_slug:slug, ts:d.ts, grupos, ruta_rel:d.ruta_rel });
          vehiculosRaw.push({ nombre_archivo:d.nombre, ruta_rel:d.ruta_rel||"" });
        });
      } catch {}
    }
  } catch(e) { console.error("[Panel/vehiculos]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Vehículos", page:"vehiculos", vehiculos, vehiculosRaw });
});

// ── PRESCRIPCIONES ───────────────────────────────────────────
router.get("/prescripciones", requireAuth, async (req, res) => {
  const db   = req.app.locals.globalDB;
  const isSA = req.jwtUser?.rol_global === "superadmin";
  const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");

  let establecimientos = [];

  try {
    if (isSA) {
      const docs = await getAllDocs(db);
      establecimientos = docs.filter(d => d.tipo==="org").map(e => ({ slug:e.slug, nombre:e.nombre }));
    } else {
      const slug = req.jwtUser?.estabSlug;
      if (slug) {
        const doc = await db.get(`org_${slug}`).catch(()=>null);
        if (doc) establecimientos = [{ slug:doc.slug, nombre:doc.nombre }];
      }
    }

    // Buscar datos de QuantiX sincronizados en CouchDB
    const slugs = isSA
      ? (await nano.db.list()).filter(n=>n.startsWith("orbitx_")).map(n=>n.replace("orbitx_",""))
      : [req.jwtUser?.estabSlug, "unassigned"].filter(Boolean);

    for (const slug of [...new Set(slugs)]) {
      try {
        const estabDB = nano.db.use(`orbitx_${slug}`);
        let docs = [];
        try {
          const r = await estabDB.find({ selector:{ tipo:"aog_archivo", subtipo:{ "$in":["quantix_config","quantix_mapa","quantix_implemento","quantix_flowx"] } }, limit:50 });
          docs = r.docs;
        } catch {
          const all = await estabDB.list({ include_docs:true });
          docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="aog_archivo"&&d.subtipo?.startsWith("quantix_"));
        }
        docs.forEach(d => {
          try {
            const parsed = JSON.parse(d.contenido||"{}");
            if (d.subtipo === "quantix_config"   && !quantixData.config)      quantixData.config = parsed;
            if (d.subtipo === "quantix_mapa"     && !quantixData.mapa)        quantixData.mapa   = parsed;
            if (d.subtipo === "quantix_flowx"    && !quantixData.flowx)       quantixData.flowx  = parsed;
            if (d.subtipo === "quantix_implemento") quantixData.implementos.push({ nombre:d.nombre, ...parsed });
          } catch {}
        });
      } catch {}
    }
  } catch(e) { console.error("[Panel/prescripciones]", e.message); }

  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Prescripciones", page:"prescripciones", establecimientos });
});

// ── MAPA ─────────────────────────────────────────────────────
router.get("/mapa", requireAuth, async (req, res) => {
  const db  = req.app.locals.globalDB;
  const isSA = req.jwtUser?.rol_global === "superadmin";
  let establecimientos = [];
  try {
    if (isSA) {
      const docs = await getAllDocs(db);
      establecimientos = docs.filter(d => d.tipo==="org").map(e => ({ slug:e.slug, nombre:e.nombre }));
    } else {
      // Usuario normal: solo ve su propio estab
      const slug = req.jwtUser?.estabSlug;
      if (slug) {
        const doc = await db.get(`org_${slug}`).catch(()=>null);
        if (doc) establecimientos = [{ slug:doc.slug, nombre:doc.nombre }];
      }
    }
  } catch {}
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Mapa de lotes", page:"mapa", establecimientos });
});

// ── AOG ─────────────────────────────────────────────────────
router.get("/aog", requireAuth, async (req, res) => {
  const nano     = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
  const isSA     = req.jwtUser?.rol_global === "superadmin";
  let stats = { total_archivos:0, lotes_count:0, lotes:[], ultimo_sync:0, tiene_vehicle:false, tipos:{} };
  let lotes = [];

  try {
    // Siempre buscar en todas las DBs orbitx_ (superadmin ve todo, otros también por ahora)
    const allDBs = await nano.db.list();
    let slugs = allDBs.filter(n=>n.startsWith("orbitx_")).map(n=>n.replace("orbitx_",""));
    console.log("[Panel/aog] slugs:", slugs);
    console.log("[Panel/aog] rol_global:", req.jwtUser?.rol_global, "isSA:", isSA);

    const lotesMap = {};
    for (const slug of [...new Set(slugs)]) {
      try {
        const estabDB = nano.db.use(`orbitx_${slug}`);
        let docs = [];
        try {
          const r = await estabDB.find({ selector:{ tipo:"aog_archivo" }, limit:2000 });
          docs = r.docs;
        } catch {
          const all = await estabDB.list({ include_docs:true });
          docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="aog_archivo");
        }
        docs.forEach(d => {
          // es_lote puede ser true, "true", 1, o el doc puede tener lote_nombre sin es_lote
          const esLote = d.es_lote === true || d.es_lote === 1 || d.es_lote === "true" || 
                         (d.lote_nombre && d.ruta_rel?.toLowerCase().startsWith("fields/"));
          if (esLote) {
            const n = `${slug}::${d.lote_nombre||"?"}`;
            if (!lotesMap[n]) lotesMap[n] = { nombre:d.lote_nombre||"?", estab:slug, archivos:[], tiene_boundary:false, tiene_field:false, ts_ultimo:0 };
            lotesMap[n].archivos.push({ tipo:d.subtipo, nombre:d.nombre, ts:d.ts });
            if (d.subtipo==="boundary"||d.subtipo==="boundary_kml") lotesMap[n].tiene_boundary = true;
            if (d.subtipo==="field_origin") lotesMap[n].tiene_field = true;
            if (d.ts > lotesMap[n].ts_ultimo) lotesMap[n].ts_ultimo = d.ts;
          }
          if (d.ts > stats.ultimo_sync) stats.ultimo_sync = d.ts;
          stats.tipos[d.subtipo] = (stats.tipos[d.subtipo]||0)+1;
          stats.total_archivos++;
        });
      } catch(e) { console.error(`[Panel/aog] ${slug}:`, e.message); }
    }
    lotes = Object.values(lotesMap).sort((a,b)=>b.ts_ultimo-a.ts_ultimo);
    stats.lotes_count   = lotes.length;
    stats.lotes         = lotes.map(l=>l.nombre);
    stats.tiene_vehicle = stats.tipos["vehicle_config"] > 0;
  } catch(e) { console.error("[Panel/aog]", e.message); }

  const aogPath  = process.env.AOG_PATH || "C:/Piloto AP";
  const regBadge = await getRegBadge(req.app.locals.globalDB).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Piloto AP", page:"aog", stats, lotes, aogPath, fmtLoteNombre });
});

// ── CONFIG ───────────────────────────────────────────────
router.get("/config", requireAuth, (req, res) => {
  const envVars = ["PORT","COUCHDB_URL","JWT_SECRET","DEVICE_MASTER_TOKEN","ANTHROPIC_API_KEY","CORS_ORIGIN","BASE_URL"];
  const envSet  = {};
  envVars.forEach(v => { envSet[v] = !!process.env[v]; });
  const isSA = req.jwtUser?.rol_global === "superadmin";
  const config = {
    port:           process.env.PORT || 4000,
    nodeEnv:        process.env.NODE_ENV || "production",
    corsOrigin:     process.env.CORS_ORIGIN || "*",
    // Solo superadmin ve la URL de CouchDB y vars sensibles
    couchUrl:       isSA ? (process.env.COUCHDB_URL || "").replace(/:\/\/.*@/, "://***@") : "***",
    hasAnthropicKey:!!process.env.ANTHROPIC_API_KEY,
    envSet:         isSA ? envSet : {},
    isSA,
  };
  res.render("layout", { ...base(req), title:"Configuración", page:"config", config });
});

module.exports = router;
