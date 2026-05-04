// routes/prescripciones_api.js — API de prescripciones (envío cloud → tractor)
"use strict";

const router = require("express").Router();
const db     = require("../services/couchdb");

// ── POST /api/prescripciones/enviar ─────────────────────────
// Desde el panel web, enviar prescripción a un tractor.
// Body: { device_id, nombre, contenido (GeoJSON string), producto }
router.post("/enviar", async (req, res) => {
  try {
    const { device_id, nombre, contenido, producto } = req.body;
    const estab = req.user?.estabSlug;
    if (!estab) return res.status(400).json({ error: "Necesitás una org activa" });
    if (!device_id || !contenido)
      return res.status(400).json({ error: "Hace falta device_id y contenido" });

    // Verificar que el dispositivo destino pertenezca a la org del usuario.
    // Sin esto, un usuario podría mandar prescripciones a tractores de otra org.
    const globalDB = db.getDB("global");
    const dev = await globalDB.get(`device_${device_id}`).catch(() => null);
    if (!dev) return res.status(404).json({ error: "Dispositivo no encontrado" });
    const esSA = req.user?.rol_global === "superadmin";
    if (!esSA && dev.estab_slug !== estab)
      return res.status(403).json({ error: "Ese tractor no es de tu organización" });
    if (dev.bloqueado)
      return res.status(409).json({ error: "El tractor está bloqueado" });

    const estabDB = db.getDB(estab);
    const now = Date.now();

    // Crear documento de descarga pendiente (lo busca OrbitX-Sync/AgOpenGPS).
    await estabDB.insert({
      _id:       `prescripcion_${device_id}_${now}`,
      tipo:      "aog_descarga_pendiente",
      ruta_rel:  `quantix/prescripciones/${nombre || "prescripcion"}.geojson`,
      nombre:    nombre || "prescripcion",
      subtipo:   "prescripcion",
      producto:  producto || "quantix",
      contenido,
      device_id,
      entregado: false,
      ts:        now
    });

    // Notificar por Socket.IO.
    if (req.io)
      req.io.to(`maquina:${device_id}`).emit("prescripcion:nueva", { nombre, ts: now });

    res.json({ ok: true, mensaje: "Prescripción enviada a " + device_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/prescripciones/pendientes ──────────────────────
// El tractor consulta si tiene prescripciones pendientes.
router.get("/pendientes", async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    const token    = req.headers["x-auth-token"];

    if (!deviceId || !token)
      return res.status(401).json({ error: "Auth requerida" });

    const globalDB = db.getDB("global");
    let dev;
    try { dev = await globalDB.get(`device_${deviceId}`); }
    catch { return res.status(401).json({ error: "Dispositivo no registrado" }); }
    if (dev.token !== token)
      return res.status(401).json({ error: "Token inválido" });
    if (dev.bloqueado)
      return res.status(403).json({ error: "Dispositivo bloqueado" });

    // Slug autoritativo del doc — no confiar en el header del cliente.
    const slug = dev.estab_slug;
    if (!slug) return res.json([]);

    const estabDB = db.getDB(slug);
    const r = await estabDB.find({
      selector: {
        tipo: "aog_descarga_pendiente",
        device_id: deviceId,
        entregado: false
      },
      limit: 50
    });

    res.json(r.docs.map(d => ({
      id: d._id,
      nombre: d.nombre,
      ruta_rel: d.ruta_rel,
      subtipo: d.subtipo,
      producto: d.producto,
      ts: d.ts
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/prescripciones/pendientes/:id/contenido ────────
// Descargar el contenido de una prescripción.
router.get("/pendientes/:id/contenido", async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    const token    = req.headers["x-auth-token"];

    if (!deviceId || !token)
      return res.status(401).json({ error: "Auth requerida" });

    const globalDB = db.getDB("global");
    let dev;
    try { dev = await globalDB.get(`device_${deviceId}`); }
    catch { return res.status(401).json({ error: "Dispositivo no registrado" }); }
    if (dev.token !== token)
      return res.status(401).json({ error: "Token inválido" });
    if (dev.bloqueado)
      return res.status(403).json({ error: "Dispositivo bloqueado" });

    const slug = dev.estab_slug;
    if (!slug) return res.status(404).json({ error: "Dispositivo sin establecimiento" });
    const estabDB = db.getDB(slug);
    const doc = await estabDB.get(req.params.id);

    if (doc.device_id !== deviceId)
      return res.status(403).json({ error: "No autorizado" });

    // Marcar como entregado.
    await estabDB.insert({ ...doc, entregado: true, entregado_at: Date.now() });

    res.json({
      nombre: doc.nombre,
      ruta_rel: doc.ruta_rel,
      contenido: doc.contenido,
      producto: doc.producto
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/prescripciones/tractores ──────────────────────
// Lista los dispositivos asignados al establecimiento del usuario.
router.get("/tractores", async (req, res) => {
  try {
    const estab = req.user?.estabSlug;
    if (!estab) return res.json([]);

    const globalDB = db.getDB("global");
    let docs = [];
    try {
      const r = await globalDB.find({ selector: { tipo: "device" }, limit: 200 });
      docs = r.docs;
    } catch {
      const all = await globalDB.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d => d.tipo === "device");
    }

    const ahora = Date.now();
    const tractores = docs
      .filter(d => d.estab_slug === estab && !d.bloqueado)
      .map(d => ({
        device_id: d.device_id,
        nombre:    d.nombre || d.device_id,
        online:    d.ultimo_visto && (ahora - d.ultimo_visto) < 2 * 60 * 1000,
      }));

    res.json(tractores);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
