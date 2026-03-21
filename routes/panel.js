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
  let establecimientos = [], ownerNombre = {};
  try {
    const docs = await getAllDocs(db);
    establecimientos = docs.filter(d => d.tipo==="org");
    const owners = docs.filter(d => d.tipo==="usuario");
    owners.forEach(u => { ownerNombre[u._id] = u.nombre; });
  } catch(e) { console.error("[Panel/estab]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Establecimientos", page:"establecimientos", establecimientos, ownerNombre });
});

// ── LOTES ────────────────────────────────────────────────
router.get("/lotes", requireAuth, async (req, res) => {
  const db        = req.app.locals.globalDB;
  const estado    = req.query.estado || null;
  let lotes = [];
  try {
    // Buscar lotes en todas las DBs de establecimientos
    const orgs = (await getAllDocs(db)).filter(d => d.tipo==="org");
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    for (const org of orgs) {
      try {
        const estabDB = nano.db.use(`orbitx_${org.slug}`);
        const sel = { tipo:"lote" };
        if (estado) sel.estado = estado;
        const r = await estabDB.find({ selector:sel, limit:50, sort:[{fecha_inicio:"desc"}] });
        r.docs.forEach(l => { l.orgSlug = org.slug; l.orgNombre = org.nombre; lotes.push(l); });
      } catch {}
    }
    lotes.sort((a,b) => (b.fecha_inicio||0) - (a.fecha_inicio||0));
  } catch(e) { console.error("[Panel/lotes]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Lotes", page:"lotes", lotes, filtroEstado: estado });
});

// ── ALERTAS ──────────────────────────────────────────────
router.get("/alertas", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  let alertas = [];
  try {
    const orgs = (await getAllDocs(db)).filter(d => d.tipo==="org");
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
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
  let dispositivos = [];
  try {
    const orgs = (await getAllDocs(db)).filter(d => d.tipo==="org");
    const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    for (const org of orgs) {
      try {
        const estabDB = nano.db.use(`orbitx_${org.slug}`);
        const r = await estabDB.find({ selector:{ tipo:"nodo" }, limit:50 });
        r.docs.forEach(d => { d.orgSlug = org.slug; d.estab_nombre = org.nombre; dispositivos.push(d); });
      } catch {}
    }
  } catch(e) { console.error("[Panel/dispositivos]", e.message); }
  const regBadge = await getRegBadge(db).catch(()=>0);
  res.render("layout", { ...base(req, { regBadge }), title:"Dispositivos", page:"dispositivos", dispositivos });
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

// ── CONFIG ───────────────────────────────────────────────
router.get("/config", requireAuth, (req, res) => {
  const envVars = ["PORT","COUCHDB_URL","JWT_SECRET","DEVICE_MASTER_TOKEN","ANTHROPIC_API_KEY","CORS_ORIGIN","BASE_URL"];
  const envSet  = {};
  envVars.forEach(v => { envSet[v] = !!process.env[v]; });
  const config = {
    port:           process.env.PORT || 4000,
    nodeEnv:        process.env.NODE_ENV || "production",
    corsOrigin:     process.env.CORS_ORIGIN || "*",
    couchUrl:       (process.env.COUCHDB_URL || "").replace(/:\/\/.*@/, "://***@"),
    hasAnthropicKey:!!process.env.ANTHROPIC_API_KEY,
    envSet,
  };
  res.render("layout", { ...base(req), title:"Configuración", page:"config", config });
});

module.exports = router;
