// services/couchdb.js — OrbitX Cloud
const nano   = require("nano");
const crypto = require("crypto");

const URL    = process.env.COUCHDB_URL || "http://admin:password@localhost:5984";
const PREFIX = "orbitx_";
const GLOBAL = "orbitx_global";

const couch  = nano(URL);
const cache  = {};

// ── Helpers ──────────────────────────────────────────────────
const getDB = (slug) => {
  const name = slug === "global" ? GLOBAL : `${PREFIX}${slug}`;
  if (!cache[name]) cache[name] = couch.db.use(name);
  return cache[name];
};

async function ensureDB(slug) {
  const name = slug === "global" ? GLOBAL : `${PREFIX}${slug}`;
  try { await couch.db.create(name); }
  catch(e) { if (e.error !== "file_exists") throw e; }
  cache[name] = couch.db.use(name);
  return cache[name];
}

async function upsert(db, id, data) {
  const now = Date.now();
  try {
    const existing = await db.get(id);
    return db.insert({ ...existing, ...data, _rev: existing._rev, updated_at: now });
  } catch(e) {
    if (e.error === "not_found")
      return db.insert({ ...data, _id: id, created_at: now, updated_at: now });
    throw e;
  }
}

const dateSlug = () => new Date().toISOString().slice(0,10).replace(/-/g,"");

const slugify  = (s="") => s.toLowerCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]/g,"_").replace(/_+/g,"_").slice(0,40);

// ── Ping ─────────────────────────────────────────────────────
async function ping() {
  try { await couch.info(); return true; }
  catch { return false; }
}

// ── Bootstrap ────────────────────────────────────────────────
const DESIGN_DOC = {
  _id: "_design/orbitx",
  views: {
    by_tipo: {
      map: `function(doc){ if(doc.tipo) emit([doc.tipo, doc.created_at||doc.ts||0], null); }`
    },
    lotes_por_estado: {
      map: `function(doc){ if(doc.tipo==='lote') emit([doc.estado, doc.fecha_inicio], {nombre:doc.nombre,ha:doc.ha_sembradas,resumen:doc.resumen}); }`
    },
    alertas_activas: {
      map: `function(doc){ if(doc.tipo==='alerta'&&!doc.resuelta) emit([doc.nivel,doc.ts_inicio], null); }`
    },
    densidades_por_lote: {
      map: `function(doc){ if(doc.tipo==='densidad') emit([doc.lote_id,doc.ts], null); }`
    },
    pending_sync: {
      map: `function(doc){ if(doc.synced_at===null&&doc.device_id) emit([doc.device_id,doc.tipo,doc.ts||doc.created_at||0], null); }`
    },
    stats_densidad: {
      map: `function(doc){ if(doc.tipo==='densidad'){ doc.bajadas.forEach(function(b){ if(b.semillas_m>0) emit(doc.lote_id, b.semillas_m); }); } }`,
      reduce: `_stats`
    }
  }
};

async function upsertDesignDoc(db) {
  try {
    const ex = await db.get(DESIGN_DOC._id);
    await db.insert({ ...DESIGN_DOC, _rev: ex._rev });
  } catch(e) {
    if (e.error === "not_found") await db.insert(DESIGN_DOC);
  }
}

async function bootstrap() {
  await ensureDB("global");
  await upsertDesignDoc(getDB("global"));
}

async function bootstrapEstablecimiento(slug) {
  await ensureDB(slug);
  await upsertDesignDoc(getDB(slug));
  // Habilitar índice Mango
  const db = getDB(slug);
  for (const fields of [["tipo"],["tipo","lote_id"],["tipo","synced_at"],["tipo","estado"]]) {
    await db.createIndex({ index: { fields } }).catch(()=>{});
  }
}

// ── Establecimientos ─────────────────────────────────────────
async function getEstablecimientos() {
  const db = getDB("global");
  const r  = await db.find({ selector: { tipo: "establecimiento" } });
  return r.docs;
}

async function upsertEstablecimiento(data) {
  return upsert(getDB("global"), `estab_${data.slug}`, { ...data, tipo: "establecimiento" });
}

// ── Usuarios ─────────────────────────────────────────────────
async function getUsuario(uid) {
  return getDB("global").get(`usr_${uid}`);
}

async function getUsuarioPorEmail(email) {
  const db = getDB("global");
  const r  = await db.find({ selector: { tipo:"usuario", email } });
  return r.docs[0] || null;
}

async function upsertUsuario(data) {
  return upsert(getDB("global"), `usr_${data.uid}`, { ...data, tipo: "usuario" });
}

async function updatePushToken(uid, token) {
  const db  = getDB("global");
  const doc = await db.get(`usr_${uid}`);
  return db.insert({ ...doc, notificaciones: { ...doc.notificaciones, push_token: token }, updated_at: Date.now() });
}

// ── Lotes ────────────────────────────────────────────────────
async function getLotes(slug, { estado, limit=50 } = {}) {
  const db  = getDB(slug);
  const sel = { tipo: "lote" };
  if (estado) sel.estado = estado;
  const r = await db.find({ selector: sel, sort: [{ fecha_inicio: "desc" }], limit });
  return r.docs;
}

async function getLote(slug, id) { return getDB(slug).get(id); }

async function upsertLote(slug, data) {
  const id = data._id || `lote_${dateSlug()}_${slugify(data.nombre)}`;
  return upsert(getDB(slug), id, { ...data, tipo: "lote" });
}

async function cerrarLote(slug, id, resumen) {
  const doc = await getDB(slug).get(id);
  return getDB(slug).insert({ ...doc, estado:"completado", fecha_fin:Date.now(), resumen, updated_at:Date.now() });
}

async function getResumenLote(slug, id) {
  const lote   = await getLote(slug, id).catch(()=>null);
  if (!lote) return null;
  const alertas = await getDB(slug).find({ selector:{tipo:"alerta",lote_id:id}, fields:["_id"] });
  const durMin  = lote.fecha_fin ? Math.round((lote.fecha_fin-lote.fecha_inicio)/60000) : 0;
  return { ...lote, alertas_count: alertas.docs.length, dur_min: durMin };
}

async function getResumenDiario(slug) {
  const hoy    = new Date(); hoy.setHours(0,0,0,0);
  const lotes  = await getLotes(slug, { limit: 999 });
  const hoyLots= lotes.filter(l => l.fecha_inicio >= hoy.getTime());
  const alertas= await getAlertasActivas(slug);
  return { slug, lotes_hoy: hoyLots.length, alertas_activas: alertas.length, fecha: hoy.toISOString() };
}

// ── Densidades ────────────────────────────────────────────────
async function insertDensidadesBatch(slug, docs) {
  const db       = getDB(slug);
  const prepared = docs.map(d => ({
    ...d,
    _id: d._id || `dens_${d.lote_id}_${d.ts}_${Math.random().toString(36).slice(2,6)}`,
    tipo: "densidad",
    synced_at: Date.now()
  }));
  return db.bulk({ docs: prepared });
}

async function getDensidadesPorLote(slug, loteId, limit=2000) {
  const r = await getDB(slug).view("orbitx","densidades_por_lote",{
    startkey:[loteId,0], endkey:[loteId,"\uffff"],
    include_docs:true, limit, reduce:false
  });
  return r.rows.map(x=>x.doc);
}

// ── Alertas ──────────────────────────────────────────────────
async function insertAlerta(slug, data) {
  const id = `alert_${Date.now()}_${data.bajada_id||0}`;
  return upsert(getDB(slug), id, { ...data, tipo:"alerta", synced_at:Date.now() });
}

async function getAlertasActivas(slug) {
  const r = await getDB(slug).view("orbitx","alertas_activas",{
    include_docs:true, reduce:false, descending:true, limit:200
  });
  return r.rows.map(x=>x.doc);
}

async function resolverAlerta(slug, id, uid) {
  const doc = await getDB(slug).get(id);
  return getDB(slug).insert({ ...doc, resuelta:true, ts_fin:Date.now(), resolucion_uid:uid });
}

// ── Nodos ────────────────────────────────────────────────────
async function getNodo(slug, uid)   { return getDB(slug).get(`nodo_${uid}`); }
async function upsertNodo(slug, d)  { return upsert(getDB(slug),`nodo_${d.uid}`,{...d,tipo:"nodo"}); }
async function getNodos(slug) {
  const r = await getDB(slug).find({ selector:{tipo:"nodo"} });
  return r.docs;
}

// ── Backups AOG ───────────────────────────────────────────────
async function saveBackupAOG(slug, data) {
  const ts = new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
  const id = `aog_backup_${data.maquina_id}_${ts}`;
  return upsert(getDB(slug), id, { ...data, tipo:"aog_backup", ts:Date.now(), synced_at:Date.now() });
}

async function getBackupsAOG(slug, maquinaId) {
  const sel = { tipo:"aog_backup" };
  if (maquinaId) sel.maquina_id = maquinaId;
  const r = await getDB(slug).find({ selector:sel, sort:[{ts:"desc"}], limit:50 });
  return r.docs;
}

// ── Sync batch ────────────────────────────────────────────────
async function procesarBatchSync(slug, payload, deviceId) {
  const r = { ok:0, errores:0, detalle:[] };
  const densidades = payload.filter(d=>d.tipo==="densidad");
  const resto      = payload.filter(d=>d.tipo!=="densidad");

  if (densidades.length) {
    try { await insertDensidadesBatch(slug,densidades); r.ok+=densidades.length; }
    catch(e) { r.errores+=densidades.length; r.detalle.push({tipo:"densidad",error:e.message}); }
  }

  for (const doc of resto) {
    try {
      const h = { lote:()=>upsertLote(slug,{...doc,synced_at:Date.now()}), alerta:()=>insertAlerta(slug,doc), nodo:()=>upsertNodo(slug,doc), aog_backup:()=>saveBackupAOG(slug,doc) };
      if (h[doc.tipo]) { await h[doc.tipo](); r.ok++; }
    } catch(e) { r.errores++; r.detalle.push({id:doc._id,tipo:doc.tipo,error:e.message}); }
  }
  return r;
}

async function countPendingSync(slug) {
  try {
    const r = await getDB(slug).view("orbitx","pending_sync",{reduce:false,limit:0});
    return r.total_rows;
  } catch { return 0; }
}

module.exports = {
  ping, bootstrap, bootstrapEstablecimiento,
  getDB, getEstablecimientos, upsertEstablecimiento,
  getUsuario, getUsuarioPorEmail, upsertUsuario, updatePushToken,
  getLotes, getLote, upsertLote, cerrarLote, getResumenLote, getResumenDiario,
  insertDensidadesBatch, getDensidadesPorLote,
  insertAlerta, getAlertasActivas, resolverAlerta,
  getNodo, upsertNodo, getNodos,
  saveBackupAOG, getBackupsAOG,
  procesarBatchSync, countPendingSync
};
