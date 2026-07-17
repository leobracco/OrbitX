// routes/agraria_estado.js — Estado del establecimiento para AgrarIA local (device-auth)
// Endpoint de SOLO LECTURA pensado para el asistente AgrarIA que corre en la PC
// del usuario. Los GET existentes (/api/devices, /api/tracking/live) exigen JWT
// de panel; este usa deviceAuth igual que heartbeat/tracking/position.
"use strict";

const router = require("express").Router();
const db     = require("../services/couchdb");
const { deviceAuth } = require("./devices");

router.get("/", deviceAuth, async (req, res) => {
  try {
    const estab = req.deviceDoc.estab_slug;
    if (!estab) return res.status(400).json({ error: "Device sin establecimiento asignado" });

    const globalDB = db.getDB("global");

    // Dispositivos del establecimiento.
    const rDev = await globalDB.find({
      selector: { tipo: "device", estab_slug: estab },
      fields:   ["device_id", "nombre", "hostname", "online", "ultimo_visto", "version"],
      limit:    100,
    });

    const nameMap = new Map(rDev.docs.map(d => [d.device_id, d.hostname || d.nombre || d.device_id]));

    // Posiciones live (últimos 5 min), mismo criterio que /api/tracking/live.
    const rTrk = await globalDB.find({
      selector: {
        tipo: "tracking_live",
        estab_slug: estab,
        ts: { "$gt": Date.now() - 5 * 60 * 1000 },
      },
      limit: 100,
    });

    res.json({
      estab,
      dispositivos: rDev.docs.map(d => ({
        device_id:    d.device_id,
        nombre:       d.hostname || d.nombre || d.device_id,
        online:       !!d.online,
        ultimo_visto: d.ultimo_visto || null,
        version:      d.version || null,
      })),
      posiciones: rTrk.docs.map(doc => ({
        device_id: doc.device_id,
        nombre:    nameMap.get(doc.device_id) || doc.device_id,
        lat: doc.lat, lon: doc.lon,
        heading: doc.heading, speed: doc.speed,
        field: doc.field || "",
        ts: doc.ts,
        age_sec: Math.round((Date.now() - doc.ts) / 1000),
      })),
    });
  } catch (e) {
    console.error("[agraria/estado]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
