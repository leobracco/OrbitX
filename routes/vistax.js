// ============================================================
//  OrbitX Cloud — routes/vistax.js  v2
//  Recibe, almacena y sirve datos sincronizados de VistaX
// ============================================================

const router = require("express").Router();
const db     = require("../services/couchdb");
const { deviceAuth } = require("./devices");

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
//  Normalización de subtipos
//  El agente puede enviar distintos subtipos según el archivo.
//  Los normalizamos a los que usa el servidor internamente.
//
//  Agente envía:           Servidor usa:
//  vistax_implemento    →  vistax_perfil
//  vistax_lote_geojson  →  vistax_densidad
//  vistax_semillas      →  vistax_semillas  (sin cambio)
//  vistax_lote_json     →  vistax_meta
//  vistax_settings      →  vistax_settings  (sin cambio)
//  vistax_file          →  vistax_archivo
// ============================================================
const SUBTIPO_MAP = {
  "vistax_implemento":   "vistax_perfil",
  "vistax_lote_geojson": "vistax_densidad",
  "vistax_lote_json":    "vistax_meta",
  "vistax_file":         "vistax_archivo",
};

function normalizarSubtipo(subtipo) {
  return SUBTIPO_MAP[subtipo] || subtipo || "vistax_archivo";
}

// ============================================================
//  Extraer lote_id del nombre del archivo
//  Ejemplo: "lote_1774445764100.geojson" → "lote_1774445764100"
//           "lote_1774445764100_semillas.geojson" → "lote_1774445764100"
//           "lote_1774445764100_meta.json" → "lote_1774445764100"
// ============================================================
function extraerLoteId(nombre, lote_id_recibido) {
  if (lote_id_recibido) return lote_id_recibido;
  const match = (nombre || "").match(/^(lote_\d+)/);
  return match ? match[1] : null;
}

// ============================================================
//  POST /api/vistax/sync
//  Llamado por el agente con X-Auth-Token (deviceAuth igual que AOG)
// ============================================================
router.post("/sync", deviceAuth, async (req, res) => {
  const estabSlug = req.headers["x-estab-slug"];
  const deviceId  = req.headers["x-device-id"];

  if (!estabSlug || estabSlug === "unassigned")
    return res.status(400).json({ error: "x-estab-slug requerido" });

  const { ruta_rel, nombre, subtipo, lote_id, hash_md5, tamano, contenido, ts } = req.body;
  if (!ruta_rel || contenido === undefined)
    return res.status(400).json({ error: "ruta_rel y contenido requeridos" });

  try {
    const estabDB     = getEstabDB(estabSlug);
    const subtipoNorm = normalizarSubtipo(subtipo);
    const loteId      = extraerLoteId(nombre, lote_id);
    const safeRel     = ruta_rel.replace(/[/\\:*?"<>|]/g, "_");
    const docId       = `vistax_${estabSlug}_${safeRel}`.slice(0, 200);

    // Guardar versión histórica si el contenido cambió (solo GeoJSON finales)
    const subtipoCritico = ["vistax_densidad", "vistax_semillas", "vistax_perfil"];
    if (subtipoCritico.includes(subtipoNorm)) {
      try {
        const existing = await estabDB.get(docId);
        if (existing.hash_md5 && existing.hash_md5 !== hash_md5) {
          await estabDB.insert({
            _id:         `vistax_hist_${estabSlug}_${safeRel}_${existing.ts||Date.now()}`.slice(0, 220),
            tipo:        "vistax_historial",
            doc_ref:     docId,
            orgSlug:     estabSlug,
            subtipo:     subtipoNorm,
            lote_id:     loteId,
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
      subtipo:   subtipoNorm,
      orgSlug:   estabSlug,
      ruta_rel,
      nombre,
      lote_id:   loteId,
      hash_md5,
      tamano:    tamano || 0,
      contenido,
      device_id: deviceId,
      ts:        ts || Date.now(),
    });

    console.log(`[VistaX] ✓ ${deviceId} → ${ruta_rel} (${subtipo} → ${subtipoNorm})`);
    res.json({ ok: true });
  } catch(e) {
    console.error("[VistaX/sync]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  GET /api/vistax/lotes
// ============================================================
router.get("/lotes", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);

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
        tiene_densidad: false,
        tiene_semillas: false,
      };
    });

    const geojsons = await _findAll(estabDB, { tipo:"vistax_archivo", subtipo:"vistax_densidad" });
    const semillas = await _findAll(estabDB, { tipo:"vistax_archivo", subtipo:"vistax_semillas" });
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
//  GET /api/vistax/lote/:id
// ============================================================
router.get("/lote/:id", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      lote_id: req.params.id,
    });

    if (!docs.length) return res.status(404).json({ error: "Lote no encontrado" });

    const result = { lote_id:req.params.id, meta:null, densidad:null, semillas:null, alertas:null };

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
//  GET /api/vistax/geojson/:id
// ============================================================
router.get("/geojson/:id", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_densidad",
      lote_id: req.params.id,
    });

    if (!docs.length) return res.status(404).json({ error: "GeoJSON no encontrado" });
    try { res.json(JSON.parse(docs[0].contenido)); }
    catch { res.status(500).json({ error: "GeoJSON inválido" }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/semillas/:id
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
    try { res.json(JSON.parse(docs[0].contenido)); }
    catch { res.status(500).json({ error: "GeoJSON inválido" }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/perfil
// ============================================================
router.get("/perfil", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_perfil",
    });

    if (!docs.length) return res.status(404).json({ error: "Sin perfiles sincronizados" });

    const ultimo = docs.sort((a, b) => b.ts - a.ts)[0];
    try {
      res.json({
        nombre:    ultimo.nombre,
        device_id: ultimo.device_id,
        ts:        ultimo.ts,
        config:    JSON.parse(ultimo.contenido),
      });
    } catch { res.status(500).json({ error: "Perfil inválido" }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/perfiles — todos los perfiles de sembradoras
// ============================================================
router.get("/perfiles", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const docs    = await _findAll(estabDB, {
      tipo:    "vistax_archivo",
      subtipo: "vistax_perfil",
    });

    const perfiles = docs.map(doc => {
      let config = {};
      try { config = JSON.parse(doc.contenido); } catch {}
      return {
        id:        config.id || doc.nombre.replace(".json",""),
        nombre:    config.nombre || doc.nombre,
        surcos:    config.mapeo_sensores?.length || 0,
        device_id: doc.device_id,
        ts:        doc.ts,
      };
    });

    res.json(perfiles.sort((a, b) => b.ts - a.ts));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  GET /api/vistax/alertas
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

    const lotes   = new Set(docs.filter(d => d.lote_id).map(d => d.lote_id));
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
