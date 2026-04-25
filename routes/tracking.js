// routes/tracking.js — Tracking en vivo de tractores
// El agente OrbitX-Sync (o AgOpenGPS directo) envía posición/velocidad/heading.
// El panel web consulta la posición en vivo y el historial.
"use strict";

const router = require("express").Router();
const db     = require("../services/couchdb");

// ── POST /api/tracking/position ─────────────────────────────
// Recibido del tractor (device auth, sin JWT).
// Body: { lat, lon, heading, speed, field, modules:{vistax,quantix,sectionx} }
router.post("/position", async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    const token    = req.headers["x-auth-token"];
    const estab    = req.headers["x-estab-slug"];

    if (!deviceId || !token)
      return res.status(401).json({ error: "X-Device-ID y X-Auth-Token requeridos" });

    // Validar device.
    const globalDB = db.getDB("global");
    let deviceDoc;
    try { deviceDoc = await globalDB.get(`device_${deviceId}`); }
    catch { return res.status(401).json({ error: "Device no registrado" }); }
    if (deviceDoc.token !== token)
      return res.status(401).json({ error: "Token inválido" });

    const slug = estab || deviceDoc.estab_slug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento asignado" });

    const { lat, lon, heading, speed, field, modules } = req.body;
    const now = Date.now();

    // 1. Actualizar posición live del device (upsert).
    const liveId = `tracking_live_${deviceId}`;
    let liveDoc;
    try { liveDoc = await globalDB.get(liveId); } catch { liveDoc = { _id: liveId }; }

    await globalDB.insert({
      ...liveDoc,
      tipo:      "tracking_live",
      device_id: deviceId,
      estab_slug: slug,
      lat: parseFloat(lat) || 0,
      lon: parseFloat(lon) || 0,
      heading: parseFloat(heading) || 0,
      speed:   parseFloat(speed) || 0,
      field:   field || "",
      modules: modules || {},
      ts:      now,
      online:  true
    });

    // 2. Guardar punto en historial (estab DB, un doc por posición).
    const estabDB = db.getDB(slug);
    await estabDB.insert({
      _id:       `trk_${deviceId}_${now}`,
      tipo:      "tracking_point",
      device_id: deviceId,
      lat: parseFloat(lat) || 0,
      lon: parseFloat(lon) || 0,
      heading: parseFloat(heading) || 0,
      speed:   parseFloat(speed) || 0,
      field:   field || "",
      ts:      now
    });

    // 3. Emit Socket.IO para live update.
    if (req.io) {
      req.io.to(`estab:${slug}`).emit("tracking:position", {
        device_id: deviceId,
        lat, lon, heading, speed, field, ts: now
      });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tracking/live ──────────────────────────────────
// Panel web: ver todos los tractores en vivo del estab.
router.get("/live", async (req, res) => {
  try {
    const globalDB = db.getDB("global");
    const estab = req.user?.estabSlug;
    if (!estab) return res.status(400).json({ error: "Sin estab" });

    const r = await globalDB.find({
      selector: {
        tipo: "tracking_live",
        estab_slug: estab,
        ts: { "$gt": Date.now() - 5 * 60 * 1000 } // últimos 5 min
      },
      limit: 100
    });

    // Enriquecer con nombre del device.
    const devices = [];
    for (const doc of r.docs) {
      let nombre = doc.device_id;
      try {
        const dev = await globalDB.get(`device_${doc.device_id}`);
        nombre = dev.hostname || dev.device_id;
      } catch {}
      devices.push({
        device_id: doc.device_id,
        nombre,
        lat: doc.lat, lon: doc.lon,
        heading: doc.heading, speed: doc.speed,
        field: doc.field, modules: doc.modules,
        ts: doc.ts,
        age_sec: Math.round((Date.now() - doc.ts) / 1000)
      });
    }

    res.json(devices);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/tracking/history/:deviceId ─────────────────────
// Historial de recorrido de un tractor por día.
router.get("/history/:deviceId", async (req, res) => {
  try {
    const estab = req.user?.estabSlug;
    if (!estab) return res.status(400).json({ error: "Sin estab" });

    const estabDB = db.getDB(estab);
    const { deviceId } = req.params;
    const date = req.query.date || new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Rango del día.
    const dayStart = new Date(date + "T00:00:00Z").getTime();
    const dayEnd   = new Date(date + "T23:59:59Z").getTime();

    const r = await estabDB.find({
      selector: {
        tipo: "tracking_point",
        device_id: deviceId,
        ts: { "$gte": dayStart, "$lte": dayEnd }
      },
      sort: [{ ts: "asc" }],
      limit: 10000
    });

    res.json({
      device_id: deviceId,
      date,
      points: r.docs.map(d => ({
        lat: d.lat, lon: d.lon,
        heading: d.heading, speed: d.speed,
        ts: d.ts
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
