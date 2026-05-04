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

  if (!deviceId || !token)
    return res.status(401).json({ error: "X-Device-ID y X-Auth-Token requeridos" });

  try {
    const globalDB = req.app.locals.globalDB;
    let doc = await globalDB.get(`device_${deviceId}`).catch(() => null);

    if (!doc) {
      // Auto-registro SOLO si vino con el MASTER_TOKEN.
      // Sin master token, un dispositivo desconocido no se auto-registra:
      // primero hay que crearlo desde el panel para evitar que cualquiera
      // se registre con un token arbitrario.
      if (token !== MASTER_TOKEN)
        return res.status(401).json({ error: "Dispositivo no registrado" });

      const now = Date.now();
      await globalDB.insert({
        _id:         `device_${deviceId}`,
        tipo:        "device",
        device_id:   deviceId,
        nombre:      deviceId,
        token,                          // queda con el master token, regenerar desde panel
        estab_slug:  null,
        bloqueado:   false,
        hostname:    null, platform: null, mac: null, aog_path: null,
        version:     null, ultimo_visto: null, online: false,
        auto_registrado: true,
        creado_por:  "auto",
        created_at:  now, updated_at: now,
      });
      doc = await globalDB.get(`device_${deviceId}`);
      console.log(`[Devices] Auto-registrado con master token: ${deviceId}`);
    } else if (doc.token !== token) {
      // Dispositivo existe pero el token no coincide.
      // Aceptamos master token solo si el doc todavía no tiene token propio (legacy).
      const tieneTokenPropio = doc.token && doc.token !== MASTER_TOKEN;
      if (tieneTokenPropio || token !== MASTER_TOKEN)
        return res.status(401).json({ error: "Token inválido. Regenerá el token desde el panel." });
    }

    if (doc.bloqueado)
      return res.status(403).json({ error: "Dispositivo bloqueado" });

    req.deviceId  = deviceId;
    req.deviceDoc = doc;
    next();
  } catch (e) {
    console.error("[deviceAuth]", e.message);
    res.status(500).json({ error: e.message });
  }
}

const uid = (req) => req.user?.uid ? `usr_${req.user.uid}` : "system";

// Pertenencia: superadmin pasa siempre, otros solo si el device está en su org.
function puedeTocarDevice(req, doc) {
  if (!doc) return false;
  if (req.user?.rol_global === "superadmin") return true;
  return !!req.user?.estabSlug && doc.estab_slug === req.user.estabSlug;
}

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
//  GET /api/devices  — superadmin ve todo, otros ven solo los de su org
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    const esSA     = req.user?.rol_global === "superadmin";
    const miSlug   = req.user?.estabSlug;

    let docs = [];
    try {
      const r = await globalDB.find({ selector: { tipo: "device" }, limit: 500 });
      docs = r.docs;
    } catch {
      const all = await globalDB.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d => d.tipo === "device");
    }

    if (!esSA) {
      // Sin org activa, no devolver nada.
      if (!miSlug) return res.json([]);
      // Mostrar solo dispositivos asignados a la org del usuario.
      // Los sin asignar (estab_slug=null) NO se muestran a non-superadmin
      // para no leakear tractores de otras orgs en proceso de alta.
      docs = docs.filter(d => d.estab_slug === miSlug);
    }

    const ahora = Date.now();
    res.json(docs.map(d => ({
      ...d,
      token: undefined,
      online: d.ultimo_visto && (ahora - d.ultimo_visto) < 2 * 60 * 1000,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/nuevo  — crear dispositivo + generar token
//  Lo hace el operador desde el panel antes de instalar el agente.
//  Si NO es superadmin, el device queda automáticamente asignado a su org.
// ══════════════════════════════════════════════════════════
router.post("/nuevo", async (req, res) => {
  const { nombre, device_id_personalizado } = req.body;
  if (!nombre) return res.status(400).json({ error: "Hace falta el nombre" });

  const esSA   = req.user?.rol_global === "superadmin";
  const miSlug = req.user?.estabSlug;
  if (!esSA && !miSlug)
    return res.status(403).json({ error: "Necesitás una org activa para crear un dispositivo" });

  try {
    const globalDB = req.app.locals.globalDB;

    const device_id = device_id_personalizado?.trim() ||
      "VX-" + crypto.randomBytes(6).toString("hex").toUpperCase();

    const existing = await globalDB.get(`device_${device_id}`).catch(() => null);
    if (existing) return res.status(409).json({ error: `El ID '${device_id}' ya existe` });

    const token = crypto.randomBytes(32).toString("hex");
    const now   = Date.now();

    // Owners/admins siempre crean dentro de su org. Solo SA puede crear sin asignar.
    const estab_slug = esSA ? null : miSlug;

    await globalDB.insert({
      _id:         `device_${device_id}`,
      tipo:        "device",
      device_id,
      nombre,
      token,
      estab_slug,
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
    if (!doc) return res.status(404).json({ error: "Dispositivo no encontrado" });
    if (!puedeTocarDevice(req, doc))
      return res.status(403).json({ error: "Este dispositivo no es de tu organización" });

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
  if (!estab_slug) return res.status(400).json({ error: "Hace falta el slug del establecimiento" });

  const esSA   = req.user?.rol_global === "superadmin";
  const miSlug = req.user?.estabSlug;
  // Solo SA puede asignar a una org distinta a la suya.
  if (!esSA && estab_slug !== miSlug)
    return res.status(403).json({ error: "Solo podés asignar a tu propia organización" });

  try {
    const globalDB = req.app.locals.globalDB;
    const org      = await globalDB.get(`org_${estab_slug}`).catch(() => null);
    if (!org) return res.status(404).json({ error: `Establecimiento '${estab_slug}' no encontrado` });

    const id  = `device_${req.params.deviceId}`;
    const doc = await globalDB.get(id).catch(() => null);
    if (!doc) return res.status(404).json({ error: "Dispositivo no encontrado" });
    // Si no soy SA, el device tiene que ser mío o estar sin asignar.
    if (!esSA && doc.estab_slug && doc.estab_slug !== miSlug)
      return res.status(403).json({ error: "Este dispositivo no es de tu organización" });

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
  if (!req.body.nombre) return res.status(400).json({ error: "Hace falta el nombre nuevo" });
  try {
    const globalDB = req.app.locals.globalDB;
    const doc      = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error: "Dispositivo no encontrado" });
    if (!puedeTocarDevice(req, doc))
      return res.status(403).json({ error: "Este dispositivo no es de tu organización" });
    await globalDB.insert({ ...doc, nombre: req.body.nombre, updated_at: Date.now() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/devices/:deviceId/bloquear
// ══════════════════════════════════════════════════════════
router.post("/:deviceId/bloquear", async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    const doc      = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error: "Dispositivo no encontrado" });
    if (!puedeTocarDevice(req, doc))
      return res.status(403).json({ error: "Este dispositivo no es de tu organización" });
    const bloqueado = req.body.bloqueado !== false;
    await globalDB.insert({ ...doc, bloqueado, updated_at: Date.now() });
    res.json({ ok: true, bloqueado });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    if (!doc) return res.status(404).json({ error: "Dispositivo no encontrado" });
    if (!puedeTocarDevice(req, doc))
      return res.status(403).json({ error: "Este dispositivo no es de tu organización" });
    await globalDB.destroy(doc._id, doc._rev);
    await registrarAudit(doc.estab_slug, uid(req), "device.borrar", { device_id: req.params.deviceId });
    console.log(`[Devices] Borrado: ${req.params.deviceId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
