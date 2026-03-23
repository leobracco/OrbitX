// ============================================================
//  OrbitX Cloud — routes/vistax.js
//  Recibe, almacena y sirve datos sincronizados de VistaX
//
//  POST /api/vistax/sync        — agente sube archivos
//  GET  /api/vistax/lotes       — listar lotes sincronizados
//  GET  /api/vistax/lote/:id    — detalle de un lote
//  GET  /api/vistax/geojson/:id — GeoJSON de densidad
//  GET  /api/vistax/semillas/:id — GeoJSON de semillas
//  GET  /api/vistax/perfil      — configuración de máquina activa
//  GET  /api/vistax/alertas     — logs de alertas
//  GET  /api/vistax/stats       — estadísticas del establecimiento
// ============================================================

const router = require("express").Router();
const db     = require("../services/couchdb");

function getEstabDB(slug) { return db.getDB(slug); }

async function _findAll(estabDB, selector, limit = 500) {
  try {
    const r = await estabDB.find({ selector, limit });
    return r.docs;
  } catch {
    const all = await estabDB.list({ include_docs:true });
    return all.rows.map(r => r.doc).filter(d =>
      Object.entries(selector).every(([k, v]) => d[k] === v)
    );
  }
}

async function _upsert(estabDB, id, data) {
  let rev;
  try { const e = await estabDB.get(id); rev = e._rev; } catch {}
  await estabDB.insert({ _id:id, ...(rev ? { _rev:rev } : {}), ...data });
}

// ============================================================
//  POST /api/vistax/sync
//  El agente sube archivos de VistaX
//  Headers: X-Device-ID, X-Auth-Token, X-Estab-Slug
//  Body: { ruta_rel, nombre, subtipo, lote_id, hash_md5, tamano, contenido, ts }
// ============================================================
router.post("/sync", async (req, res) => {
  const estabSlug = req.headers["x-estab-slug"];
  const deviceId  = req.headers["x-device-id"];

  if (!estabSlug) return res.status(400).json({ error: "x-estab-slug requerido" });

  const { ruta_rel, nombre, subtipo, lote_id, hash_md5, tamano, contenido, ts } = req.body;
  if (!ruta_rel || contenido === undefined)
    return res.status(400).json({ error: "ruta_rel y contenido requeridos" });

  try {
    const estabDB = getEstabDB(estabSlug);
    const safeRel = ruta_rel.replace(/[/\\:*?"<>|]/g, "_");
    const docId   = `vistax_${estabSlug}_${safeRel}`.slice(0, 200);

    // Guardar versión histórica si el contenido cambió (solo para GeoJSON finales)
    const subtipoCritico = ["vistax_densidad", "vistax_semillas", "vistax_perfil"];
    if (subtipoCritico.includes(subtipo)) {
      try {
        const existing = await estabDB.get(docId);
        if (existing.hash_md5 && existing.hash_md5 !== hash_md5) {
          await estabDB.insert({
            _id:         `vistax_hist_${estabSlug}_${safeRel}_${existing.ts||Date.now()}`.slice(0, 220),
            tipo:        "vistax_historial",
            doc_ref:     docId,
            orgSlug:     estabSlug,
            subtipo,     lote_id,
            hash_md5:    existing.hash_md5,
            device_id:   existing.device_id,
            ts:          existing.ts || Date.now(),
            ts_guardado: Date.now(),
          }).catch(() => {});
        }
      } catch {}
    }

    await _upsert(estabDB, docId, {
      tipo:      "vistax_archivo",
      subtipo:   subtipo || "vistax_archivo",
      orgSlug:   estabSlug,
      ruta_rel,  nombre, lote_id: lote_id || null,
      hash_md5,  tamano: tamano || 0,
      contenido, device_id: deviceId,
      ts: ts || Date.now(),
    });

    console.log(`[VistaX] ✓ ${deviceId} → ${ruta_rel} (${subtipo})`);
    res.json({ ok: true });
  } catch(e) {
    console.error("[VistaX/sync]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  GET /api/vistax/lotes
//  Lista todos los lotes con su metadata
// ============================================================
router.get("/lotes", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);

    // Buscar todos los _meta.json sincronizados
    const metas = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_meta",
    });

    const lotes = metas.map(doc => {
      let meta = {};
      try { meta = JSON.parse(doc.contenido); } catch {}
      return {
        lote_id:       doc.lote_id || meta.id,
        nombre:        meta.nombre || doc.nombre,
        cultivo:       meta.cultivo || "–",
        startTs:       meta.startTs,
        endTs:         meta.endTs,
        totalSemillas: meta.totalSemillas || 0,
        duracionMin:   meta.duracionMin   || 0,
        device_id:     doc.device_id,
        ts_sync:       doc.ts,
        tiene_densidad: false,  // se completa abajo
        tiene_semillas: false,
      };
    });

    // Verificar qué lotes tienen GeoJSON disponibles
    const geojsons  = await _findAll(estabDB, { tipo:"vistax_archivo", subtipo:"vistax_densidad"  });
    const semillas  = await _findAll(estabDB, { tipo:"vistax_archivo", subtipo:"vistax_semillas"  });
    const geojsonIds = new Set(geojsons.map(d => d.lote_id).filter(Boolean));
    const semillaIds = new Set(semillas.map(d => d.lote_id).filter(Boolean));

    lotes.forEach(l => {
      l.tiene_densidad = geojsonIds.has(l.lote_id);
      l.tiene_semillas = semillaIds.has(l.lote_id);
    });

    res.json(lotes.sort((a, b) => (b.startTs || 0) - (a.startTs || 0)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/lote/:id — detalle completo
// ============================================================
router.get("/lote/:id", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      lote_id: req.params.id,
    });

    if (!docs.length) return res.status(404).json({ error: "Lote no encontrado" });

    const result = {
      lote_id:  req.params.id,
      meta:     null,
      densidad: null,
      semillas: null,
      alertas:  null,
    };

    docs.forEach(doc => {
      switch (doc.subtipo) {
        case "vistax_meta":
          try { result.meta = JSON.parse(doc.contenido); } catch {}
          break;
        case "vistax_densidad":
          result.densidad = { disponible:true, ts:doc.ts, tamano:doc.tamano, device_id:doc.device_id };
          break;
        case "vistax_semillas":
          result.semillas = { disponible:true, ts:doc.ts, tamano:doc.tamano, device_id:doc.device_id };
          break;
        case "vistax_alertas":
          try { result.alertas = JSON.parse(doc.contenido); } catch {}
          break;
      }
    });

    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/geojson/:id — GeoJSON de densidad
// ============================================================
router.get("/geojson/:id", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_densidad",
      lote_id: req.params.id,
    });

    if (!docs.length) return res.status(404).json({ error: "GeoJSON de densidad no encontrado" });

    try {
      res.json(JSON.parse(docs[0].contenido));
    } catch {
      res.status(500).json({ error: "GeoJSON inválido" });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/semillas/:id — GeoJSON de semillas
// ============================================================
router.get("/semillas/:id", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_semillas",
      lote_id: req.params.id,
    });

    if (!docs.length) return res.status(404).json({ error: "GeoJSON de semillas no encontrado" });

    try {
      res.json(JSON.parse(docs[0].contenido));
    } catch {
      res.status(500).json({ error: "GeoJSON inválido" });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/perfil — configuración de máquina activa
// ============================================================
router.get("/perfil", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_perfil",
    });

    if (!docs.length) return res.status(404).json({ error: "Sin perfiles sincronizados" });

    // El más reciente
    const ultimo = docs.sort((a, b) => b.ts - a.ts)[0];
    try {
      res.json({
        nombre:    ultimo.nombre,
        device_id: ultimo.device_id,
        ts:        ultimo.ts,
        config:    JSON.parse(ultimo.contenido),
      });
    } catch {
      res.status(500).json({ error: "Perfil inválido" });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/alertas?lote_id=... — logs de alertas
// ============================================================
router.get("/alertas", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const selector = { tipo:"vistax_archivo", subtipo:"vistax_alertas" };
    if (req.query.lote_id) selector.lote_id = req.query.lote_id;

    const docs = await _findAll(estabDB, selector);

    const alertas = [];
    docs.forEach(doc => {
      try {
        const data = JSON.parse(doc.contenido);
        if (Array.isArray(data)) alertas.push(...data);
        else alertas.push(data);
      } catch {}
    });

    res.json(alertas.sort((a, b) => (b.ts || 0) - (a.ts || 0)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/stats
// ============================================================
router.get("/stats", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, { tipo:"vistax_archivo" });

    const lotes    = new Set(docs.filter(d => d.lote_id).map(d => d.lote_id));
    const subtipos = docs.reduce((acc, d) => {
      acc[d.subtipo] = (acc[d.subtipo] || 0) + 1;
      return acc;
    }, {});

    res.json({
      total_archivos: docs.length,
      lotes_count:    lotes.size,
      tiene_perfiles: docs.some(d => d.subtipo === "vistax_perfil"),
      ultimo_sync:    docs.reduce((m, d) => d.ts > m ? d.ts : m, 0),
      subtipos,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
