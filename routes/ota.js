// routes/ota.js — Gestión de firmwares OTA.
//
// Modelo:
// - Solo SUPERADMIN sube/elimina firmwares (cuenta global Agro Parallel).
// - OWNERS de orgs ven el catálogo de versiones para los productos que tienen y disparan OTA a SUS dispositivos.
// - DEVICES consultan /pendientes con sus headers X-Device-ID / X-Auth-Token y descargan el .bin.
//
// Docs CouchDB en orbitx_global:
// - firmware_<producto>_<version>     tipo: firmware
// - ota_pendiente_<deviceId>          tipo: ota_pendiente   (cola: solo el último gana)
// - ota_log_<ts>_<deviceId>           tipo: ota_log         (historial)
"use strict";

const router = require("express").Router();
const path   = require("path");
const fs     = require("fs");
const fw     = require("../lib/firmware");
const couch  = require("../services/couchdb");
const notify = require("../lib/notify-admin");
const { soloSuperadmin } = require("../middleware/auth");

let multer;
try { multer = require("multer"); }
catch { /* sin multer no se puede subir, pero el resto sigue funcionando */ }

// Multer storage: guarda en .tmp y después firmware.guardarBin lo mueve al destino final.
const upload = multer
  ? multer({
      storage: multer.diskStorage({
        destination: (req, file, cb) => {
          const tmpDir = path.join(fw.FW_DIR, ".tmp");
          fw.ensureDir(tmpDir);
          cb(null, tmpDir);
        },
        filename: (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`),
      }),
      limits: { fileSize: 32 * 1024 * 1024 }, // 32 MB
    })
  : null;

const uid = (req) => req.user?.uid ? `usr_${req.user.uid}` : "system";
const orgsDelUsuario = (req) => (req.user?.memberships || []).map(m => m.orgSlug);

// ══════════════════════════════════════════════════════════
//  GET /api/ota/firmwares — lista catálogo de firmwares (cualquier user logueado)
//  Query: producto (opcional)
// ══════════════════════════════════════════════════════════
router.get("/firmwares", async (req, res) => {
  try {
    const db = couch.getDB("global");
    const sel = { tipo: "firmware" };
    if (req.query.producto) sel.producto = req.query.producto;

    let docs = [];
    try {
      const r = await db.find({ selector: sel, limit: 500 });
      docs = r.docs;
    } catch {
      const all = await db.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d => d.tipo === "firmware" && (!sel.producto || d.producto === sel.producto));
    }

    docs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    // No exponer rutas absolutas en disco.
    res.json(docs.map(({ _rev, ruta, ...d }) => d));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/ota/upload — Solo superadmin. Multipart con file + producto + version + changelog.
// ══════════════════════════════════════════════════════════
router.post("/upload", soloSuperadmin, (req, res, next) => {
  if (!upload) return res.status(500).json({ error: "Falta instalar multer (npm install multer)" });
  upload.single("archivo")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { producto, version, changelog } = req.body;
      if (!req.file) return res.status(400).json({ error: "Hace falta el archivo .bin" });

      const meta = await fw.guardarBin(producto, version, req.file.path);
      const db   = couch.getDB("global");
      const id   = `firmware_${producto}_${version}`;
      const now  = Date.now();

      await db.insert({
        _id:           id,
        tipo:          "firmware",
        producto,
        version,
        changelog:     changelog || "",
        hash_sha256:   meta.sha256,
        tamano_bytes:  meta.tamano,
        ruta_rel:      meta.ruta_rel,
        nombre_archivo: req.file.originalname,
        subido_por_uid: uid(req),
        ts:            now,
        created_at:    now,
      });

      // Notif a admin (no bloqueante)
      notify.notifyFirmwareSubido(
        { producto, version, hash_sha256: meta.sha256, tamano_bytes: meta.tamano, changelog, subido_por_uid: uid(req) },
        { subido_por_nombre: req.user?.nombre || uid(req) }
      ).catch(() => {});

      console.log(`[OTA] Firmware ${producto} ${version} (${(meta.tamano/1024).toFixed(1)} KB)`);
      res.json({ ok: true, producto, version, hash_sha256: meta.sha256, tamano_bytes: meta.tamano });
    } catch (e) {
      // Si falló después de mover el archivo, limpiamos.
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(e.status || 500).json({ error: e.message });
    }
  });
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/ota/firmware/:producto/:version — Solo superadmin
// ══════════════════════════════════════════════════════════
router.delete("/firmware/:producto/:version", soloSuperadmin, async (req, res) => {
  try {
    const { producto, version } = req.params;
    const db = couch.getDB("global");
    const id = `firmware_${producto}_${version}`;
    const doc = await db.get(id).catch(() => null);
    if (doc) await db.destroy(doc._id, doc._rev);
    await fw.eliminarBin(producto, version).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/ota/disparar — Owner/admin manda OTA a un dispositivo de su org.
//  Body: { device_id, producto, version }
// ══════════════════════════════════════════════════════════
router.post("/disparar", async (req, res) => {
  try {
    const { device_id, producto, version } = req.body || {};
    if (!device_id || !producto || !version)
      return res.status(400).json({ error: "Hace falta device_id, producto y version" });

    const db  = couch.getDB("global");
    const dev = await db.get(`device_${device_id}`).catch(() => null);
    if (!dev) return res.status(404).json({ error: "Dispositivo no encontrado" });

    // Pertenencia.
    const esSA = req.user?.rol_global === "superadmin";
    if (!esSA && dev.estab_slug !== req.user?.estabSlug)
      return res.status(403).json({ error: "Ese tractor no es de tu organización" });
    if (dev.bloqueado)
      return res.status(409).json({ error: "El tractor está bloqueado" });

    // Firmware existe.
    const fwDoc = await db.get(`firmware_${producto}_${version}`).catch(() => null);
    if (!fwDoc) return res.status(404).json({ error: `Firmware ${producto} ${version} no encontrado` });
    if (!fw.existeBin(producto, version))
      return res.status(409).json({ error: "El binario no está disponible en disco" });

    const id  = `ota_pendiente_${device_id}`;
    const now = Date.now();
    let rev;
    try { const ex = await db.get(id); rev = ex._rev; } catch {}
    await db.insert({
      _id:    id,
      ...(rev ? { _rev: rev } : {}),
      tipo:   "ota_pendiente",
      device_id,
      producto,
      version,
      hash_sha256:    fwDoc.hash_sha256,
      tamano_bytes:   fwDoc.tamano_bytes,
      disparado_por:  uid(req),
      disparado_at:   now,
      entregado_at:   null,
    });

    // Notificar al device por socket si hay conexión activa.
    if (req.io) req.io.to(`maquina:${device_id}`).emit("ota:nueva", { producto, version, ts: now });

    res.json({ ok: true, device_id, producto, version });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/ota/logs?device_id=&limit=
// ══════════════════════════════════════════════════════════
router.get("/logs", async (req, res) => {
  try {
    const db = couch.getDB("global");
    const sel = { tipo: "ota_log" };
    if (req.query.device_id) sel.device_id = req.query.device_id;

    let docs = [];
    try {
      const r = await db.find({ selector: sel, limit: parseInt(req.query.limit) || 100 });
      docs = r.docs;
    } catch {
      const all = await db.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d => d.tipo === "ota_log" && (!sel.device_id || d.device_id === sel.device_id));
    }

    // Filtrar por org si no es superadmin.
    const esSA = req.user?.rol_global === "superadmin";
    if (!esSA) {
      const miSlug = req.user?.estabSlug;
      docs = docs.filter(d => d.estab_slug === miSlug);
    }

    docs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  ── Endpoints para devices (auth con X-Device-ID + X-Auth-Token) ──
//  Se montan en server.js sin JWT (igual que /api/sync, /api/prescripciones/pendientes).
// ══════════════════════════════════════════════════════════

// Helper: valida headers contra doc en CouchDB.
async function autenticarDevice(req) {
  const deviceId = req.headers["x-device-id"];
  const token    = req.headers["x-auth-token"];
  if (!deviceId || !token) throw Object.assign(new Error("Auth requerida"), { status: 401 });

  const db  = couch.getDB("global");
  const dev = await db.get(`device_${deviceId}`).catch(() => null);
  if (!dev) throw Object.assign(new Error("Dispositivo no registrado"), { status: 401 });
  if (dev.token !== token) throw Object.assign(new Error("Token inválido"), { status: 401 });
  if (dev.bloqueado) throw Object.assign(new Error("Dispositivo bloqueado"), { status: 403 });
  return dev;
}

// GET /api/ota/catalogo — el agente del PC (OrbitX-Sync) pide el catálogo
// completo de firmwares disponibles para mirror local LAN. Device-auth.
// Query: producto (opcional). Devuelve la última versión + lista por producto.
router.get("/catalogo", async (req, res) => {
  try {
    await autenticarDevice(req);
    const db = couch.getDB("global");
    const sel = { tipo: "firmware" };
    if (req.query.producto) sel.producto = req.query.producto;

    let docs = [];
    try {
      const r = await db.find({ selector: sel, limit: 500 });
      docs = r.docs;
    } catch {
      const all = await db.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d =>
        d && d.tipo === "firmware" && (!sel.producto || d.producto === sel.producto));
    }

    docs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    // Solo metadata necesaria para el mirror.
    res.json(docs.map(d => ({
      producto:     d.producto,
      version:      d.version,
      hash_sha256:  d.hash_sha256,
      tamano_bytes: d.tamano_bytes,
      changelog:    d.changelog || "",
      ts:           d.ts || d.created_at || 0,
    })));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ota/pendiente — el device pregunta si tiene una OTA pendiente.
router.get("/pendiente", async (req, res) => {
  try {
    const dev = await autenticarDevice(req);
    const db  = couch.getDB("global");
    const pend = await db.get(`ota_pendiente_${dev.device_id}`).catch(() => null);
    if (!pend) return res.json({ pendiente: false });

    const base = process.env.BASE_URL || "";
    res.json({
      pendiente:   true,
      producto:    pend.producto,
      version:     pend.version,
      hash_sha256: pend.hash_sha256,
      tamano_bytes:pend.tamano_bytes,
      url:         `${base}/api/ota/firmware/${pend.producto}/${pend.version}`,
      ts:          pend.disparado_at,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ota/firmware/:producto/:version — descarga del .bin.
// Permite tanto JWT (superadmin descargando manualmente) como auth de device.
router.get("/firmware/:producto/:version", async (req, res) => {
  try {
    const tieneJWT = req.user && !req.user.isDevice;
    const tieneDev = !!req.headers["x-device-id"];
    if (!tieneJWT && !tieneDev) return res.status(401).json({ error: "Auth requerida" });
    if (tieneDev && !tieneJWT) await autenticarDevice(req);

    const { producto, version } = req.params;
    if (!fw.existeBin(producto, version))
      return res.status(404).json({ error: "Firmware no encontrado" });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${producto}-${version}.bin"`);
    fw.streamBin(producto, version).pipe(res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/ota/resultado — el device reporta cómo fue la actualización.
// Body: { producto, version, version_anterior, resultado: "ok"|"falla"|"timeout", error }
router.post("/resultado", async (req, res) => {
  try {
    const dev = await autenticarDevice(req);
    const { producto, version, version_anterior, resultado, error } = req.body || {};
    if (!producto || !version || !resultado)
      return res.status(400).json({ error: "Hace falta producto, version y resultado" });

    const db  = couch.getDB("global");
    const now = Date.now();
    const log = {
      _id:               `ota_log_${now}_${dev.device_id}`,
      tipo:              "ota_log",
      device_id:         dev.device_id,
      estab_slug:        dev.estab_slug || null,
      producto,
      version_anterior:  version_anterior || dev.version || null,
      version_nueva:     version,
      resultado,
      error:             error || null,
      ts:                now,
    };
    await db.insert(log);

    // Si fue ok, actualizamos el doc del device con la nueva version y borramos el pendiente.
    if (resultado === "ok") {
      await db.insert({ ...dev, version, ultimo_visto: now, updated_at: now });
      const pend = await db.get(`ota_pendiente_${dev.device_id}`).catch(() => null);
      if (pend) await db.destroy(pend._id, pend._rev).catch(() => {});
    }

    notify.notifyOTAResult(log).catch(() => {});

    if (req.io) req.io.to(`maquina:${dev.device_id}`).emit("ota:resultado", { producto, version, resultado, ts: now });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
