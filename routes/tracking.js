// routes/tracking.js — Tracking en vivo de tractores
// El agente OrbitX-Sync (o AgOpenGPS directo) envía posición/velocidad/heading.
// El panel web consulta la posición en vivo y el historial.
"use strict";

const router = require("express").Router();
const db     = require("../services/couchdb");

// O8 — Tamaño de bucket para historial. 60_000 ms = 1 doc/min/tractor.
// A 1 Hz de POST eso son 60 puntos por doc; jornada 8 h = 480 docs/día
// (vs ~28.800 con el esquema anterior). Cap defensivo de 600 puntos
// por doc para que no crezca sin techo si una pantalla bombea a 10 Hz.
const TRK_BUCKET_MS = 60_000;
const TRK_BUCKET_CAP = 600;

// ── POST /api/tracking/position ─────────────────────────────
// Recibido del tractor (device auth, sin JWT).
// Body: { lat, lon, heading, speed, field, modules:{vistax,quantix,sectionx} }
router.post("/position", async (req, res) => {
  try {
    const deviceId = req.headers["x-device-id"];
    const token    = req.headers["x-auth-token"];

    if (!deviceId || !token)
      return res.status(401).json({ error: "X-Device-ID y X-Auth-Token requeridos" });

    // Validar device.
    const globalDB = db.getDB("global");
    let deviceDoc;
    try { deviceDoc = await globalDB.get(`device_${deviceId}`); }
    catch { return res.status(401).json({ error: "Device no registrado" }); }
    if (deviceDoc.token !== token)
      return res.status(401).json({ error: "Token inválido" });

    // O28 — Slug autoritativo del doc del device (no del header).
    const slug = deviceDoc.estab_slug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento asignado" });

    const { lat, lon, heading, speed, field, modules } = req.body;
    const now  = Date.now();
    const _lat = parseFloat(lat) || 0;
    const _lon = parseFloat(lon) || 0;
    const _hdg = parseFloat(heading) || 0;
    const _spd = parseFloat(speed) || 0;
    const _fld = field || "";

    // 1. Actualizar posición live del device (upsert con retry 409 — O11).
    const liveId = `tracking_live_${deviceId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let liveDoc;
        try { liveDoc = await globalDB.get(liveId); } catch { liveDoc = { _id: liveId }; }
        await globalDB.insert({
          ...liveDoc,
          tipo:      "tracking_live",
          device_id: deviceId,
          estab_slug: slug,
          lat: _lat, lon: _lon, heading: _hdg, speed: _spd,
          field: _fld, modules: modules || {},
          ts: now, online: true,
        });
        break;
      } catch (e) {
        if ((e.statusCode === 409 || e.error === "conflict") && attempt < 2) {
          // Jitter: dos POSTs simultáneos del mismo device chocan en el mismo
          // _rev; sin backoff reintentarían en lock-step y volverían a chocar.
          await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
          continue;
        }
        throw e;
      }
    }

    // 2. O8 — Append al bucket de 1 minuto en vez de 1 doc por punto.
    //    Retry en 409 — dos POSTs simultáneos del mismo device al mismo
    //    minuto compiten por el mismo doc; ganamos el segundo round.
    const estabDB  = db.getDB(slug);
    const bucketTs = Math.floor(now / TRK_BUCKET_MS) * TRK_BUCKET_MS;
    const bucketId = `trkbk_${deviceId}_${bucketTs}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let bucket;
        try {
          bucket = await estabDB.get(bucketId);
        } catch {
          bucket = {
            _id:        bucketId,
            tipo:       "tracking_bucket",
            device_id:  deviceId,
            bucket_ts:  bucketTs,
            ts_min:     now,
            points:     [],
          };
        }
        if (!Array.isArray(bucket.points)) bucket.points = [];
        if (bucket.points.length < TRK_BUCKET_CAP) {
          bucket.points.push({ lat:_lat, lon:_lon, heading:_hdg, speed:_spd, field:_fld, ts: now });
        }
        bucket.ts_max = now;
        await estabDB.insert(bucket);
        break;
      } catch (e) {
        if ((e.statusCode === 409 || e.error === "conflict") && attempt < 2) {
          await new Promise(r => setTimeout(r, 10 + Math.random() * 40));
          continue;
        }
        throw e;
      }
    }

    // 3. Emit Socket.IO para live update.
    if (req.io) {
      req.io.to(`estab:${slug}`).emit("tracking:position", {
        device_id: deviceId,
        lat: _lat, lon: _lon, heading: _hdg, speed: _spd, field: _fld, ts: now
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

    // O25 — Antes hacíamos N gets `device_<id>` dentro del loop (N+1).
    // Con 100 tractores activos eso eran 100 viajes secuenciales a Couch.
    // Una sola llamada `_all_docs` con keys trae todo en un round-trip.
    const deviceIds = r.docs.map(d => `device_${d.device_id}`);
    const nameMap   = new Map();
    if (deviceIds.length) {
      try {
        const all = await globalDB.list({ keys: deviceIds, include_docs: true });
        for (const row of all.rows) {
          if (row.doc) nameMap.set(row.doc.device_id, row.doc.hostname || row.doc.device_id);
        }
      } catch (e) {
        console.warn("[tracking/live] batch fetch devices:", e.message);
      }
    }

    const devices = r.docs.map(doc => ({
      device_id: doc.device_id,
      nombre:    nameMap.get(doc.device_id) || doc.device_id,
      lat: doc.lat, lon: doc.lon,
      heading: doc.heading, speed: doc.speed,
      field: doc.field, modules: doc.modules,
      ts: doc.ts,
      age_sec: Math.round((Date.now() - doc.ts) / 1000)
    }));

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

    // O8 — Mezclamos buckets nuevos + tracking_point legacy. Los buckets
    // contienen points[] (60 por minuto típicamente); los legacy son 1
    // doc/punto. Tras un período de retención sin legacy podríamos
    // borrar esta rama.
    const [bucketRes, pointRes] = await Promise.all([
      estabDB.find({
        selector: {
          tipo: "tracking_bucket",
          device_id: deviceId,
          bucket_ts: { "$gte": dayStart, "$lte": dayEnd },
        },
        limit: 2000,
      }),
      estabDB.find({
        selector: {
          tipo: "tracking_point",
          device_id: deviceId,
          ts: { "$gte": dayStart, "$lte": dayEnd },
        },
        limit: 10000,
      }),
    ]);

    const allPoints = [];
    for (const b of bucketRes.docs) {
      if (Array.isArray(b.points)) {
        for (const p of b.points) {
          allPoints.push({ lat: p.lat, lon: p.lon, heading: p.heading, speed: p.speed, ts: p.ts });
        }
      }
    }
    for (const d of pointRes.docs) {
      allPoints.push({ lat: d.lat, lon: d.lon, heading: d.heading, speed: d.speed, ts: d.ts });
    }
    allPoints.sort((a, b) => a.ts - b.ts);

    res.json({
      device_id: deviceId,
      date,
      points: allPoints,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
