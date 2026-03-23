// routes/devices.js — Registro, tokens individuales y asignación
const router = require("express").Router();
const crypto = require("crypto");
const db     = require("../services/couchdb");
const { registrarAudit } = require("../services/auth_service");

// ── Validar token individual de un dispositivo ────────────
// Cada dispositivo tiene su propio token guardado en CouchDB
// Token maestro de fallback (para compatibilidad con agentes viejos)
const MASTER_TOKEN = process.env.DEVICE_MASTER_TOKEN || "vx-device-token";

async function deviceAuth(req, res, next) {
  const deviceId = req.headers["x-device-id"];
  const token    = req.headers["x-auth-token"];

  console.log("─────────────────────────────────────────");
  console.log("[DeviceAuth] headers recibidos:");
  console.log("  x-device-id  :", JSON.stringify(deviceId));
  console.log("  x-auth-token :", JSON.stringify(token));
  console.log("  len device-id:", deviceId?.length);
  console.log("  len token    :", token?.length);

  if (!deviceId || !token)
    return res.status(401).json({ error:"X-Device-ID y X-Auth-Token requeridos" });

  try {
    const globalDB = req.app.locals.globalDB;
    let doc = await globalDB.get(`device_${deviceId}`).catch(() => null);

    console.log("[DeviceAuth] doc en CouchDB:", doc ? "encontrado" : "NO encontrado");
    if (doc) {
      console.log("  doc._id      :", doc._id);
      console.log("  doc.token    :", JSON.stringify(doc.token));
      console.log("  len doc.token:", doc.token?.length);
      console.log("  coincide     :", doc.token === token);
    }

    if (!doc) {
      // ── Auto-registro en primer heartbeat ──
      // Si manda el token maestro O si no hay ningún dispositivo registrado aún
      // → crear el doc con ese token y dejarlo pasar
      const now = Date.now();
      await globalDB.insert({
        _id:         `device_${deviceId}`,
        tipo:        "device",
        device_id:   deviceId,
        nombre:      deviceId,          // se puede renombrar desde el panel
        token,                          // el token que mandó es su token
        estab_slug:  null,
        bloqueado:   false,
        hostname:    null, platform: null, mac: null, aog_path: null,
        version:     null, ultimo_visto: null, online: false,
        auto_registrado: true,
        creado_por:  "auto",
        created_at:  now, updated_at: now,
      });
      doc = await globalDB.get(`device_${deviceId}`);
      console.log(`[Devices] Auto-registrado: ${deviceId}`);
    } else {
      // Dispositivo ya existe — validar token
      if (doc.token !== token) {
        console.log(`[DeviceAuth] MISMATCH device=${deviceId}`);
        console.log(`[DeviceAuth]   doc.token  len=${doc.token?.length} val="${doc.token}"`);
        console.log(`[DeviceAuth]   req.token  len=${token?.length}     val="${token}"`);
        // Compatibilidad: aceptar token maestro para dispositivos legacy
        if (token !== MASTER_TOKEN)
          return res.status(401).json({ error:"Token inválido. Regenerá el token desde el panel web." });
      }
    }

    if (doc.bloqueado)
      return res.status(403).json({ error:"Dispositivo bloqueado" });

    req.deviceId  = deviceId;
    req.deviceDoc = doc;
    next();
  } catch(e) {
    console.error("[deviceAuth]", e.message);
    res.status(500).json({ error:e.message });
  }
}

const uid = (req) => req.user?.uid ? `usr_${req.user.uid}` : "system";

async function upsertDevice(globalDB, id, data) {
  let rev;
  try { const e = await globalDB.get(id); rev = e._rev; } catch {}
  await globalDB.insert({ _id:id, ...(rev ? { _rev:rev } : {}), tipo:"device", ...data });
}

// ══════════════════════════════════════════════════════════
//  POST /api/devices/heartbeat  — agente llama esto al arrancar
// ══════════════════════════════════════════════════════════
router.post("/heartbeat", deviceAuth, async (req, res) => {
  const globalDB  = req.app.locals.globalDB;
  const { hostname, platform, mac, aog_path, version } = req.body;
  const now       = Date.now();
  const doc       = req.deviceDoc;

  await upsertDevice(globalDB, `device_${req.deviceId}`, {
    ...doc,
    hostname:     hostname || doc.hostname,
    platform:     platform || doc.platform,
    mac:          mac      || doc.mac,
    aog_path:     aog_path || doc.aog_path,
    version:      version  || "1.0.0",
    ultimo_visto: now,
    online:       true,
  });

  res.json({
    ok:          true,
    device_id:   req.deviceId,
    estab_slug:  doc.estab_slug || null,
    asignado:    !!doc.estab_slug,
    nombre:      doc.nombre || req.deviceId,
  });
});

// ══════════════════════════════════════════════════════════
//  GET /api/devices  — listar todos (requiere JWT via server.js)
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    let docs = [];
    try {
      const r = await globalDB.find({ selector:{ tipo:"device" }, limit:200 });
      docs = r.docs;
    } catch {
      const all = await globalDB.list({ include_docs:true });
      docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="device");
    }
    const ahora = Date.now();
    res.json(docs.map(d => ({
      ...d,
      token: undefined,          // nunca exponer el token en el listado
      online: d.ultimo_visto && (ahora - d.ultimo_visto) < 2*60*1000,
    })));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/nuevo  — crear dispositivo + generar token
//  Lo hace el operador desde el panel antes de instalar el agente
// ══════════════════════════════════════════════════════════
router.post("/nuevo", async (req, res) => {
  const { nombre, device_id_personalizado } = req.body;
  if (!nombre) return res.status(400).json({ error:"nombre requerido" });

  try {
    const globalDB = req.app.locals.globalDB;

    // Generar device_id si no se especificó uno personalizado
    const device_id = device_id_personalizado?.trim() ||
      "VX-" + crypto.randomBytes(6).toString("hex").toUpperCase();

    // Verificar que no exista ya
    const existing = await globalDB.get(`device_${device_id}`).catch(() => null);
    if (existing) return res.status(409).json({ error:`El ID '${device_id}' ya existe` });

    // Generar token seguro de 32 bytes
    const token = crypto.randomBytes(32).toString("hex");
    const now   = Date.now();

    await globalDB.insert({
      _id:         `device_${device_id}`,
      tipo:        "device",
      device_id,
      nombre,
      token,                    // token único para este dispositivo
      estab_slug:  null,
      bloqueado:   false,
      hostname:    null,
      platform:    null,
      mac:         null,
      aog_path:    null,
      version:     null,
      ultimo_visto: null,
      online:      false,
      creado_por:  uid(req),
      created_at:  now,
      updated_at:  now,
    });

    await registrarAudit(null, uid(req), "device.crear", { device_id, nombre });

    console.log(`[Devices] Nuevo dispositivo: ${device_id} (${nombre})`);

    // Devolver el token UNA SOLA VEZ — el operador lo copia al .env del tractor
    res.json({
      ok:        true,
      device_id,
      nombre,
      token,                    // única vez que se expone
      env_snippet: `SERVER_URL=${process.env.BASE_URL || "http://TU_IP:4000"}\nDEVICE_TOKEN=${token}\nAOG_PATH=C:\\AgOpenGPS`,
    });
  } catch(e) {
    console.error("[Devices/nuevo]", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/:deviceId/regenerar-token
//  Si el token se comprometió o hay que reinstalar el agente
// ══════════════════════════════════════════════════════════
router.post("/:deviceId/regenerar-token", async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    const doc      = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error:"Dispositivo no encontrado" });

    const token = crypto.randomBytes(32).toString("hex");
    await globalDB.insert({ ...doc, token, updated_at:Date.now() });

    await registrarAudit(doc.estab_slug, uid(req), "device.regenerar_token", { device_id:req.params.deviceId });

    res.json({
      ok:        true,
      device_id: req.params.deviceId,
      token,
      env_snippet: `SERVER_URL=${process.env.BASE_URL || "http://TU_IP:4000"}\nDEVICE_TOKEN=${token}\nAOG_PATH=C:\\AgOpenGPS`,
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/:deviceId/asignar
// ══════════════════════════════════════════════════════════
router.post("/:deviceId/asignar", async (req, res) => {
  const { estab_slug, nombre } = req.body;
  if (!estab_slug) return res.status(400).json({ error:"estab_slug requerido" });
  try {
    const globalDB = req.app.locals.globalDB;
    const org      = await globalDB.get(`org_${estab_slug}`).catch(() => null);
    if (!org) return res.status(404).json({ error:`Establecimiento '${estab_slug}' no encontrado` });

    const id  = `device_${req.params.deviceId}`;
    const doc = await globalDB.get(id).catch(() => null);
    if (!doc) return res.status(404).json({ error:"Dispositivo no encontrado" });

    await globalDB.insert({
      ...doc,
      estab_slug,
      nombre:       nombre || doc.nombre,
      asignado_por: uid(req),
      asignado_at:  Date.now(),
      updated_at:   Date.now(),
    });

    await _migrarUnassigned(req.params.deviceId, estab_slug);
    await registrarAudit(estab_slug, uid(req), "device.asignar", { device_id:req.params.deviceId, estab_slug });

    console.log(`[Devices] ${req.params.deviceId} → ${estab_slug}`);
    res.json({ ok:true, device_id:req.params.deviceId, estab_slug });
  } catch(e) {
    console.error("[Devices/asignar]", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/:deviceId/renombrar
// ══════════════════════════════════════════════════════════
router.post("/:deviceId/renombrar", async (req, res) => {
  if (!req.body.nombre) return res.status(400).json({ error:"nombre requerido" });
  try {
    const globalDB = req.app.locals.globalDB;
    const doc      = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error:"Dispositivo no encontrado" });
    await globalDB.insert({ ...doc, nombre:req.body.nombre, updated_at:Date.now() });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/:deviceId/bloquear
// ══════════════════════════════════════════════════════════
router.post("/:deviceId/bloquear", async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    const doc      = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error:"Dispositivo no encontrado" });
    const bloqueado = req.body.bloqueado !== false; // default: bloquear
    await globalDB.insert({ ...doc, bloqueado, updated_at:Date.now() });
    res.json({ ok:true, bloqueado });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── Migrar datos sin asignar ──────────────────────────────
async function _migrarUnassigned(deviceId, estabSlug) {
  try {
    const nano    = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
    const srcDB   = nano.db.use("orbitx_unassigned");
    const dstDB   = nano.db.use(`orbitx_${estabSlug}`);
    let docs = [];
    try {
      const r = await srcDB.find({ selector:{ tipo:"aog_archivo", device_id:deviceId }, limit:500 });
      docs = r.docs;
    } catch {
      const all = await srcDB.list({ include_docs:true });
      docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="aog_archivo"&&d.device_id===deviceId);
    }
    if (!docs.length) return;
    console.log(`[Devices] Migrando ${docs.length} docs → ${estabSlug}`);
    for (const doc of docs) {
      const { _id, _rev, ...data } = doc;
      const newId = _id.replace("aog_unassigned_", `aog_${estabSlug}_`);
      let rev; try { const e = await dstDB.get(newId); rev = e._rev; } catch {}
      await dstDB.insert({ _id:newId, ...(rev?{_rev:rev}:{}), ...data, orgSlug:estabSlug }).catch(()=>{});
    }
    console.log(`[Devices] Migración ok: ${docs.length} docs → ${estabSlug}`);
  } catch(e) { console.error("[Devices/_migrar]", e.message); }
}

module.exports = { router, deviceAuth };

// ══════════════════════════════════════════════════════════
//  DELETE /api/devices/:deviceId  — borrar dispositivo
// ══════════════════════════════════════════════════════════
router.delete("/:deviceId", async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    const doc      = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error:"Dispositivo no encontrado" });
    await globalDB.destroy(doc._id, doc._rev);
    await registrarAudit(doc.estab_slug, uid(req), "device.borrar", { device_id:req.params.deviceId });
    console.log(`[Devices] Borrado: ${req.params.deviceId}`);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});
