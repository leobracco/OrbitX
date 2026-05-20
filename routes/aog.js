// routes/aog.js — API AgOpenGPS: recepción, historial y restauración
const router  = require("express").Router();
const db      = require("../services/couchdb");
const { parseLote } = require("../services/aog_parser");
const { parseVehicleXML, formatearVehiculo } = require("../services/aog_vehicle_parser");

function getEstabDB(slug) { return db.getDB(slug); }

async function _findAll(estabDB, selector, limit = 1000) {
  try {
    const r = await estabDB.find({ selector, limit });
    return r.docs;
  } catch {
    const all = await estabDB.list({ include_docs:true });
    return all.rows.map(r=>r.doc).filter(d =>
      Object.entries(selector).every(([k,v]) => d[k] === v)
    );
  }
}

async function _upsert(estabDB, id, data) {
  let rev;
  try { const e = await estabDB.get(id); rev = e._rev; } catch {}
  await estabDB.insert({ _id:id, ...(rev?{_rev:rev}:{}), ...data });
}

// ══════════════════════════════════════════════════════════
//  GET /api/aog/vehiculos?slug=&limit=&skip=&q=
//  Lista paginada de configuraciones de vehículo (XML).
//  Devuelve solo metadata + grupos parseados; el XML crudo se pide aparte.
// ══════════════════════════════════════════════════════════
function extraerNombreVehiculo(xmlStr, fallback) {
  if (!xmlStr) return fallback || "Vehículo sin nombre";
  try {
    let m = xmlStr.match(/<Name[^>]*>\s*([^<]+)\s*<\/Name>/i);
    if (m) return m[1].trim();
    m = xmlStr.match(/\bName\s*=\s*"([^"]+)"/i);
    if (m) {
      const v = m[1].trim();
      if (v.length > 2 && (!/^[a-z]/.test(v) || v.includes(" "))) return v;
    }
    m = xmlStr.match(/<Description[^>]*>\s*([^<]+)\s*<\/Description>/i);
    if (m) return m[1].trim();
    return fallback || "Vehículo sin nombre";
  } catch { return fallback || "Vehículo sin nombre"; }
}

router.get("/vehiculos", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const SA      = jwtUser?.rol_global === "superadmin";
    const miSlug  = jwtUser?.estabSlug || jwtUser?.estab_slug || null;

    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const skip  = Math.max(parseInt(req.query.skip)  || 0, 0);
    const q     = (req.query.q || "").trim().toLowerCase();
    const slugFiltro = req.query.slug || null;

    // Slugs a recorrer.
    let slugs = [];
    if (slugFiltro) {
      // Solo SA puede pedir un slug específico distinto al suyo.
      if (!SA && slugFiltro !== miSlug)
        return res.status(403).json({ error: "Sin acceso a esa organización" });
      slugs = [slugFiltro];
    } else if (SA) {
      // Listar todas las DBs orbitx_*.
      try {
        const nano   = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
        const allDBs = await nano.db.list();
        slugs = allDBs.filter(n => n.startsWith("orbitx_") && n !== "orbitx_global").map(n => n.replace("orbitx_", ""));
      } catch {}
    } else if (miSlug) {
      slugs = [miSlug];
    }

    // Traer metadata mínima de cada DB (sin el contenido XML).
    let items = [];
    for (const slug of slugs) {
      try {
        const estabDB = db.getDB(slug);
        const r = await estabDB.find({
          selector: { tipo: "aog_archivo", subtipo: "vehicle_config" },
          fields:   ["_id", "nombre", "device_id", "ts", "ruta_rel"],
          limit:    200,
        });
        r.docs.forEach(d => items.push({
          _id:            d._id,
          nombre_archivo: d.nombre,
          device_id:      d.device_id,
          estab_slug:     slug,
          ts:             d.ts,
          ruta_rel:       d.ruta_rel,
        }));
      } catch (e) { /* db sin docs, ignorar */ }
    }

    // Filtro y orden.
    if (q) {
      items = items.filter(v =>
        (v.nombre_archivo || "").toLowerCase().includes(q) ||
        (v.device_id      || "").toLowerCase().includes(q) ||
        (v.estab_slug     || "").toLowerCase().includes(q)
      );
    }
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const total = items.length;
    const pagina = items.slice(skip, skip + limit);

    // Para los items de la página, traer el XML y parsear (es lo costoso).
    const detalle = await Promise.all(pagina.map(async (it) => {
      try {
        const estabDB = db.getDB(it.estab_slug);
        const doc     = await estabDB.get(it._id);
        const raw     = parseVehicleXML(doc.contenido);
        const grupos  = formatearVehiculo(raw) || [];
        return {
          ...it,
          nombre: extraerNombreVehiculo(doc.contenido, doc.nombre?.replace(/\.xml$/i, "")),
          grupos,
        };
      } catch { return { ...it, nombre: it.nombre_archivo, grupos: [] }; }
    }));

    res.json({ items: detalle, total, limit, skip });
  } catch (e) {
    console.error("[aog/vehiculos]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════
//  POST /api/aog/sync  — agente del tractor sube archivo
// ══════════════════════════════════════════════════
const { deviceAuth } = require("./devices");

router.post("/sync", deviceAuth, async (req, res) => {
  const deviceId = req.deviceId;

  // Si no hay estab asignado todavía, guardar en "unassigned"
  const estabSlug = (req.headers["x-estab-slug"] && req.headers["x-estab-slug"] !== "unassigned")
    ? req.headers["x-estab-slug"]
    : "unassigned";

  const { ruta_rel, nombre, subtipo, es_lote, lote_nombre, hash_md5, contenido, contenido_base64, ts } = req.body;
  const tamano = req.body.tamaño ?? req.body.tamano ?? 0;
  if (!ruta_rel) return res.status(400).json({ error:"ruta_rel requerido" });
  // contenido puede ser string vacío (archivo vacío es válido).
  // Si vino contenido_base64 (.shp/.shx/.dbf, etc.) lo guardamos en un campo
  // dedicado y NO tocamos `contenido` para que parsers existentes (vehicle/lote)
  // sigan funcionando con strings UTF-8.
  const esBinario = typeof contenido_base64 === "string" && contenido_base64.length > 0;

  try {
    const estabDB = getEstabDB(estabSlug);
    const safeRel = ruta_rel.replace(/[/\\:*?"<>|]/g, "_");
    const docId   = `aog_${estabSlug}_${safeRel}`.slice(0, 200);

    // Guardar versión histórica si el contenido cambió
    try {
      const existing = await estabDB.get(docId);
      if (existing.hash_md5 && existing.hash_md5 !== hash_md5) {
        const histId = `aog_hist_${estabSlug}_${safeRel}_${existing.ts||Date.now()}`.slice(0, 220);
        const histDoc = {
          _id:         histId,
          tipo:        "aog_historial",
          doc_ref:     docId,
          orgSlug:     estabSlug,
          ruta_rel, nombre, subtipo, es_lote, lote_nombre,
          hash_md5:    existing.hash_md5,
          tamaño:      existing.tamaño,
          device_id:   existing.device_id,
          ts:          existing.ts || Date.now(),
          ts_guardado: Date.now(),
        };
        // Preservar la modalidad de la versión anterior (texto vs binario).
        if (typeof existing.contenido_base64 === "string") histDoc.contenido_base64 = existing.contenido_base64;
        else histDoc.contenido = existing.contenido;
        await estabDB.insert(histDoc).catch(() => {});
      }
    } catch {}

    const docNuevo = {
      tipo:"aog_archivo", subtipo:subtipo||"field_file",
      orgSlug:estabSlug, ruta_rel, nombre,
      es_lote:!!es_lote, lote_nombre:lote_nombre||null,
      hash_md5, tamaño:tamano, device_id:deviceId,
      ts:ts||Date.now(),
    };
    if (esBinario) docNuevo.contenido_base64 = contenido_base64;
    else docNuevo.contenido = contenido || "";

    await _upsert(estabDB, docId, docNuevo);

    console.log(`[AOG] ✓ ${deviceId} → ${ruta_rel}${esBinario ? " [bin "+contenido_base64.length+"b64]" : ""}`);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  GET /api/aog/lotes
// ══════════════════════════════════════════════════
router.get("/lotes", async (req, res) => {
  try {
    const slug = req.user.estabSlug;
    await db.ensureDesignOnOrg(slug);
    const estabDB = getEstabDB(slug);

    // Vista nativa: agrupa por lote_nombre. Súper rápida.
    let lotes = {};
    try {
      const r = await estabDB.view("orbitx", "lotes_aog_por_nombre", { reduce: false });
      (r.rows || []).forEach(row => {
        const n = row.key || "?";
        if (!lotes[n]) lotes[n] = { nombre: n, archivos: [], tiene_boundary: false, tiene_field: false, ts_ultimo: 0 };
        const subtipo = row.value?.subtipo;
        const ts = row.value?.ts || 0;
        lotes[n].archivos.push({ subtipo, ts });
        if (subtipo === "boundary" || subtipo === "boundary_kml") lotes[n].tiene_boundary = true;
        if (subtipo === "field_origin")                            lotes[n].tiene_field = true;
        if (ts > lotes[n].ts_ultimo) lotes[n].ts_ultimo = ts;
      });
    } catch (e) {
      // Fallback Mango si la vista todavía no está construida.
      console.warn("[aog/lotes] view fallback:", e.message);
      const docs = await _findAll(estabDB, { tipo: "aog_archivo", es_lote: true });
      docs.forEach(d => {
        const n = d.lote_nombre || "?";
        if (!lotes[n]) lotes[n] = { nombre: n, archivos: [], tiene_boundary: false, tiene_field: false, ts_ultimo: 0 };
        lotes[n].archivos.push({ subtipo: d.subtipo, nombre: d.nombre, ts: d.ts, tamaño: d.tamaño, ruta_rel: d.ruta_rel });
        if (d.subtipo === "boundary" || d.subtipo === "boundary_kml") lotes[n].tiene_boundary = true;
        if (d.subtipo === "field_origin")                              lotes[n].tiene_field = true;
        if (d.ts > lotes[n].ts_ultimo) lotes[n].ts_ultimo = d.ts;
      });
    }
    res.json(Object.values(lotes).sort((a, b) => b.ts_ultimo - a.ts_ultimo));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Subtipos de archivo AOG que pertenecen a un lote (independientemente
// de si el flag es_lote está seteado en el doc).
const SUBTIPOS_LOTE = new Set([
  "boundary", "boundary_kml", "field_origin",
  "sections_coverage", "headland", "ab_lines", "contour",
]);

// Extrae el nombre del lote de una ruta tipo "Fields/MiLote/Boundary.txt"
// (también acepta "Field/" en singular y separadores Windows).
function extraerLoteDeRuta(rutaRel) {
  if (!rutaRel) return null;
  const m = String(rutaRel).match(/(?:^|[\\/])(?:Fields?)[\\/]+([^\\/]+)[\\/]/i);
  return m ? m[1] : null;
}

// Decide si un doc aog_archivo es de un lote y, si lo es, qué nombre.
function clasificarLote(d) {
  const sub = d.subtipo || "";
  const esLote = !!d.es_lote || SUBTIPOS_LOTE.has(sub);
  if (!esLote) return null;
  const nombre = d.lote_nombre || extraerLoteDeRuta(d.ruta_rel) || null;
  if (!nombre) return null;
  return { nombre, subtipo: sub, ts: d.ts || 0 };
}

router.get("/lotes-mapa", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const isSA    = jwtUser?.rol_global === "superadmin";
    const miSlug  = jwtUser?.estabSlug  || jwtUser?.estab_slug || null;
    const filtro  = req.query.estab;
    const nano    = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");

    let slugs = [];
    if (isSA) {
      if (filtro) { slugs = [filtro]; }
      else {
        const globalDB = req.app.locals.globalDB;
        let orgs = [];
        try { const r = await globalDB.find({ selector: { tipo: "org" }, limit: 200 }); orgs = r.docs; }
        catch { const all = await globalDB.list({ include_docs: true }); orgs = all.rows.map(r => r.doc).filter(d => d && d.tipo === "org"); }
        slugs = orgs.map(o => o.slug);
        if (!slugs.includes("unassigned")) slugs.push("unassigned");
      }
    } else if (miSlug) {
      slugs = [miSlug];
    }

    const lista = [];
    for (const slug of slugs) {
      try {
        await db.ensureDesignOnOrg(slug);
        const estabDB = nano.db.use("orbitx_" + slug);

        // Vista nativa: emite (lote_nombre, {subtipo, ts}). Reduce false para todas las filas.
        const g = {};
        try {
          const r = await estabDB.view("orbitx", "lotes_aog_por_nombre", { reduce: false });
          (r.rows || []).forEach(row => {
            const n = row.key;
            if (!n) return;
            if (!g[n]) g[n] = { nombre: n, estab_slug: slug, tiene_boundary: false, tiene_sections: false, tiene_origen: false, ts: 0 };
            const subtipo = row.value?.subtipo;
            const ts = row.value?.ts || 0;
            if (subtipo === "boundary" || subtipo === "boundary_kml") g[n].tiene_boundary = true;
            if (subtipo === "sections_coverage")                       g[n].tiene_sections = true;
            if (subtipo === "field_origin")                            g[n].tiene_origen   = true;
            if (ts > g[n].ts) g[n].ts = ts;
          });
        } catch (e) {
          // Fallback: full scan con clasificación robusta.
          console.warn("[lotes-mapa] view fallback:", slug, e.message);
          const fb = await estabDB.find({
            selector: { tipo: "aog_archivo" },
            fields:   ["lote_nombre", "subtipo", "ts", "es_lote", "ruta_rel"],
            limit:    3000,
          });
          fb.docs.forEach(d => {
            const cls = clasificarLote(d);
            if (!cls) return;
            if (!g[cls.nombre]) g[cls.nombre] = { nombre: cls.nombre, estab_slug: slug, tiene_boundary: false, tiene_sections: false, tiene_origen: false, ts: 0 };
            if (cls.subtipo === "boundary" || cls.subtipo === "boundary_kml") g[cls.nombre].tiene_boundary = true;
            if (cls.subtipo === "sections_coverage")                           g[cls.nombre].tiene_sections = true;
            if (cls.subtipo === "field_origin")                                g[cls.nombre].tiene_origen   = true;
            if (cls.ts > g[cls.nombre].ts) g[cls.nombre].ts = cls.ts;
          });
        }
        Object.values(g).forEach(l => lista.push(l));
      } catch (e) { console.error("[lotes-mapa]", slug, e.message); }
    }
    lista.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    res.json(lista);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// GET /api/aog/lotes/:nombre
router.get("/lotes/:nombre", async (req, res) => {
  try {
    const nombre = decodeURIComponent(req.params.nombre);
    const docs   = await _findAll(getEstabDB(req.user.estabSlug), { tipo:"aog_archivo", es_lote:true, lote_nombre:nombre });
    if (!docs.length) return res.status(404).json({ error:"Lote no encontrado" });
    const r = { nombre, origen:null, boundary:null, headland:null, sections:null, ab_lines:[], kml:null, otros:[] };
    docs.forEach(d => {
      const item = { nombre:d.nombre, ts:d.ts, tamaño:d.tamaño, ruta_rel:d.ruta_rel, subtipo:d.subtipo, device_id:d.device_id };
      switch(d.subtipo) {
        case "field_origin":      r.origen   = item; break;
        case "boundary":          r.boundary = item; break;
        case "headland":          r.headland = item; break;
        case "sections_coverage": r.sections = item; break;
        case "boundary_kml":      r.kml      = item; break;
        case "ab_line":case "ab_curve":case "contour":
        case "track_lines":       r.ab_lines.push(item); break;
        case "isoxml_task":       r.isoxml = (r.isoxml||[]).concat(item); break;
        default: r.otros.push(item);
      }
    });
    res.json(r);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/aog/vistax-sesiones
// Lista las sesiones VistaX sincronizadas (NDJSON + shapefile puntos + heatmap),
// agrupadas por timestamp del nombre del archivo (vistax_<ts>...).
// Cada sesión devuelve los ruta_rel de sus componentes para que el viewer
// los baje uno por uno via /api/aog/archivo.
router.get("/vistax-sesiones", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    // Subtipos generados por OrbitXSync.EnqueueAOGFiles:
    //   "vistax_log" → NDJSON con telemetría
    //   "vistax_shp" → .shp/.shx/.dbf/.prj (binarios + .prj texto)
    const ndjson = await _findAll(estabDB, { tipo: "aog_archivo", subtipo: "vistax_log" });
    const shp    = await _findAll(estabDB, { tipo: "aog_archivo", subtipo: "vistax_shp" });
    const all = ndjson.concat(shp);

    // Extrae timestamp del nombre: vistax_<ts>(...).<ext>
    // ts es un número largo en ms (Date.now al cerrar el VistaXFieldLogger).
    const sesiones = {};
    for (const d of all) {
      const n = d.nombre || "";
      const m = n.match(/^vistax_(\d+)/i);
      if (!m) continue;
      const ts = m[1];
      const isHeatmap = /heatmap/i.test(n);
      const ext = (n.match(/\.([a-z0-9]+)$/i) || [,""])[1].toLowerCase();
      if (!sesiones[ts]) sesiones[ts] = { ts, fecha: parseInt(ts, 10), lote: d.lote_nombre || null,
                                          ndjson: null, puntos: {}, heatmap: {}, device_id: d.device_id };
      const slot = isHeatmap ? sesiones[ts].heatmap : sesiones[ts].puntos;
      if (ext === "ndjson") sesiones[ts].ndjson = d.ruta_rel;
      else slot[ext] = d.ruta_rel;
    }
    // Sólo sesiones con .shp de puntos (lo mínimo viable para render).
    const out = Object.values(sesiones)
      .filter(s => s.puntos && s.puntos.shp)
      .sort((a, b) => b.fecha - a.fecha);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/aog/archivo?ruta=...
router.get("/archivo", async (req, res) => {
  try {
    if (!req.query.ruta) return res.status(400).json({ error:"ruta requerida" });
    const safeRel = req.query.ruta.replace(/[/\\:*?"<>|]/g, "_");
    const id      = `aog_${req.user.estabSlug}_${safeRel}`.slice(0, 200);
    const doc     = await getEstabDB(req.user.estabSlug).get(id).catch(()=>null);
    if (!doc) return res.status(404).json({ error:"No encontrado" });
    const out = { nombre:doc.nombre, subtipo:doc.subtipo, ruta_rel:doc.ruta_rel,
                  lote_nombre:doc.lote_nombre, ts:doc.ts, tamaño:doc.tamaño,
                  hash_md5:doc.hash_md5, device_id:doc.device_id };
    // Texto o binario: enviamos uno u otro (nunca ambos). El cliente decodea
    // Base64 si recibe contenido_base64.
    if (typeof doc.contenido_base64 === "string") out.contenido_base64 = doc.contenido_base64;
    else out.contenido = doc.contenido;
    res.json(out);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  GET /api/aog/historial?ruta=... — versiones de un archivo
// ══════════════════════════════════════════════════
router.get("/historial", async (req, res) => {
  try {
    if (!req.query.ruta) return res.status(400).json({ error:"ruta requerida" });
    const safeRel = req.query.ruta.replace(/[/\\:*?"<>|]/g, "_");
    const docRef  = `aog_${req.user.estabSlug}_${safeRel}`.slice(0, 200);
    const docs    = await _findAll(getEstabDB(req.user.estabSlug), { tipo:"aog_historial", doc_ref:docRef });
    res.json(docs.sort((a,b)=>b.ts-a.ts).map(({ contenido, ...s })=>s));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/aog/historial/:id/contenido
router.get("/historial/:id/contenido", async (req, res) => {
  try {
    const doc = await getEstabDB(req.user.estabSlug).get(req.params.id).catch(()=>null);
    if (!doc||doc.tipo!=="aog_historial") return res.status(404).json({ error:"No encontrado" });
    res.json({ _id:doc._id, nombre:doc.nombre, ts:doc.ts, device_id:doc.device_id, contenido:doc.contenido });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  POST /api/aog/historial/:id/restaurar
//  Pisa el archivo actual → el agente lo descarga
// ══════════════════════════════════════════════════
router.post("/historial/:id/restaurar", async (req, res) => {
  try {
    const estabDB = getEstabDB(req.user.estabSlug);
    const hist    = await estabDB.get(req.params.id).catch(()=>null);
    if (!hist||hist.tipo!=="aog_historial") return res.status(404).json({ error:"Versión no encontrada" });

    const now = Date.now();

    // Snapshot del estado actual antes de pisar
    try {
      const current = await estabDB.get(hist.doc_ref);
      await estabDB.insert({
        _id:       `aog_hist_${hist.orgSlug}_${hist.ruta_rel.replace(/[/\\:*?"<>|]/g,"_")}_pre_${now}`.slice(0,220),
        tipo:      "aog_historial",
        doc_ref:   hist.doc_ref,
        orgSlug:   hist.orgSlug,
        ruta_rel:  hist.ruta_rel, nombre:hist.nombre, subtipo:hist.subtipo,
        es_lote:   hist.es_lote, lote_nombre:hist.lote_nombre,
        hash_md5:  current.hash_md5, tamaño:current.tamaño, contenido:current.contenido,
        device_id: current.device_id, ts:current.ts, ts_guardado:now,
      }).catch(()=>{});
    } catch {}

    // Pisar con el contenido histórico
    await _upsert(estabDB, hist.doc_ref, {
      tipo:"aog_archivo", subtipo:hist.subtipo, orgSlug:hist.orgSlug,
      ruta_rel:hist.ruta_rel, nombre:hist.nombre,
      es_lote:hist.es_lote, lote_nombre:hist.lote_nombre,
      hash_md5:hist.hash_md5, tamaño:hist.tamaño, contenido:hist.contenido,
      device_id:hist.device_id, ts:hist.ts,
      ts_restaurado:now, restaurado_desde:req.params.id,
    });

    // Marcar para descarga por el agente
    await estabDB.insert({
      _id:       `aog_descarga_${hist.orgSlug}_${now}`,
      tipo:      "aog_descarga_pendiente",
      ruta_rel:  hist.ruta_rel, nombre:hist.nombre, contenido:hist.contenido,
      entregado: false, ts:now,
    }).catch(()=>{});

    const fecha = new Date(hist.ts).toLocaleString("es-AR");
    console.log(`[AOG] Restaurado: ${hist.ruta_rel} → ${fecha}`);
    res.json({ ok:true, mensaje:`${hist.nombre} restaurado a versión del ${fecha}` });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  GET /api/aog/pendientes-descarga  — agente consulta
// ══════════════════════════════════════════════════
router.get("/pendientes-descarga", async (req, res) => {
  const slug = req.headers["x-estab-slug"] || req.user?.estabSlug;
  try {
    const docs = await _findAll(getEstabDB(slug), { tipo:"aog_descarga_pendiente", entregado:false });
    res.json(docs.map(d=>({ id:d._id, ruta_rel:d.ruta_rel, nombre:d.nombre, ts:d.ts })));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/aog/pendientes-descarga/:id/contenido
router.get("/pendientes-descarga/:id/contenido", async (req, res) => {
  const slug = req.headers["x-estab-slug"] || req.user?.estabSlug;
  try {
    const estabDB = getEstabDB(slug);
    const doc     = await estabDB.get(req.params.id).catch(()=>null);
    if (!doc) return res.status(404).json({ error:"No encontrado" });
    await estabDB.insert({ ...doc, entregado:true, ts_entregado:Date.now() });
    res.json({ ruta_rel:doc.ruta_rel, nombre:doc.nombre, contenido:doc.contenido });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/aog/vehicle
router.get("/vehicle", async (req, res) => {
  try {
    const docs = await _findAll(getEstabDB(req.user.estabSlug), { tipo:"aog_archivo", subtipo:"vehicle_config" });
    if (!docs.length) return res.status(404).json({ error:"No hay vehicle.xml" });
    const d = docs[0];
    res.json({ nombre:d.nombre, ts:d.ts, device_id:d.device_id, contenido:d.contenido });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// GET /api/aog/stats
router.get("/stats", async (req, res) => {
  try {
    const docs  = await _findAll(getEstabDB(req.user.estabSlug), { tipo:"aog_archivo" });
    const lotes = new Set(docs.filter(d=>d.es_lote).map(d=>d.lote_nombre));
    res.json({
      total_archivos: docs.length,
      lotes_count:    lotes.size,
      lotes:          [...lotes],
      ultimo_sync:    docs.reduce((m,d)=>d.ts>m?d.ts:m, 0),
      tiene_vehicle:  docs.some(d=>d.subtipo==="vehicle_config"),
      tipos: docs.reduce((a,d)=>{ a[d.subtipo]=(a[d.subtipo]||0)+1; return a; }, {}),
    });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  GET /api/aog/vehiculos  — todos los vehículos sincronizados
// ══════════════════════════════════════════════════
router.get("/vehiculos", async (req, res) => {
  try {
    const slugs = [];
    if (req.user?.rol_global === "superadmin") {
      // Buscar en todas las DBs
      const nano   = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
      const allDBs = await nano.db.list();
      allDBs.filter(n => n.startsWith("orbitx_")).forEach(n => slugs.push(n.replace("orbitx_","")));
    } else if (req.user?.estabSlug) {
      slugs.push(req.user.estabSlug);
    }
    slugs.push("unassigned");

    const vehiculos = [];
    for (const slug of [...new Set(slugs)]) {
      try {
        const docs = await _findAll(db.getDB(slug), { tipo:"aog_archivo", subtipo:"vehicle_config" });
        docs.forEach(d => {
          const raw      = parseVehicleXML(d.contenido);
          const grupos   = formatearVehiculo(raw);
          vehiculos.push({
            _id:        d._id,
            nombre:     raw?.name || raw?.Name || d.nombre,
            nombre_archivo: d.nombre,
            device_id:  d.device_id,
            estab_slug: slug,
            ts:         d.ts,
            grupos,
          });
        });
      } catch {}
    }
    res.json(vehiculos);
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  GET /api/aog/mapa  — todos los lotes con polígonos parseados
//  Para el panel de mapa
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
//  GET /api/aog/mapa
//  Devuelve lotes con polígonos parseados (boundary + sections + origen).
//  
//  ?lote=NOMBRE  → solo ese lote (lazy load desde el buscador del mapa)
//  ?estab=SLUG   → filtrar por establecimiento
//  Sin parámetros → todos los lotes del usuario (o todos para SA)
// ══════════════════════════════════════════════════════════
// Cache en memoria para mapas (60s).
const _mapaCache = new Map();
const MAPA_TTL_MS = 60 * 1000;
function mapaCacheGet(k) {
  const e = _mapaCache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > MAPA_TTL_MS) { _mapaCache.delete(k); return null; }
  return e.data;
}
function mapaCacheSet(k, data) { _mapaCache.set(k, { data, ts: Date.now() }); }

router.get("/mapa", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const isSA    = jwtUser?.rol_global === "superadmin";
    const miSlug  = jwtUser?.estabSlug  || jwtUser?.estab_slug || null;
    const filtroEstab = req.query.estab;
    const filtroLote  = req.query.lote ? decodeURIComponent(req.query.lote) : null;

    // Cache key — incluye filtros y user para no leakear entre orgs.
    const cacheKey = `${miSlug || "sa"}::${filtroEstab || ""}::${filtroLote || ""}`;
    const cached = mapaCacheGet(cacheKey);
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(cached);
    }

    // Armar lista de slugs
    const slugs = [];
    if (filtroEstab) {
      slugs.push(filtroEstab);
    } else if (isSA) {
      try {
        const nano   = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");
        const allDBs = await nano.db.list();
        allDBs.filter(n => n.startsWith("orbitx_")).forEach(n => slugs.push(n.replace("orbitx_", "")));
      } catch {}
    } else if (miSlug) {
      slugs.push(miSlug);
    }

    if (!slugs.includes("unassigned")) slugs.push("unassigned");

    const lotesParsed = [];

    for (const slug of slugs) {
      try {
        await db.ensureDesignOnOrg(slug);
        const estabDB = db.getDB(slug);
        let docs = [];

        if (filtroLote) {
          // Lazy load: usar vista nativa con key=lote → solo trae los docs
          // de ese lote (5-10 archivos), sin scan de toda la DB.
          try {
            const r = await estabDB.view("orbitx", "lotes_aog_por_nombre", {
              key: filtroLote,
              reduce: false,
              include_docs: true,
            });
            docs = (r.rows || []).map(row => row.doc).filter(Boolean);
          } catch (e) {
            console.warn("[aog/mapa] view fallback (lote):", e.message);
          }

          // Fallback si la vista no encontró nada (archivos sin lote_nombre).
          if (!docs.length) {
            const todos = await _findAll(estabDB, { tipo: "aog_archivo" });
            docs = todos.filter(d => {
              const cls = clasificarLote(d);
              return cls && cls.nombre === filtroLote;
            });
          }
          docs = docs.map(d => ({ ...d, lote_nombre: d.lote_nombre || extraerLoteDeRuta(d.ruta_rel), es_lote: true }));

        } else {
          // Sin filtro: usar vista para obtener lista de nombres + flags rápido,
          // pero igual necesitamos contenido para parsear → fallback Mango.
          const todos = await _findAll(estabDB, { tipo: "aog_archivo" });
          docs = todos.filter(d => clasificarLote(d) !== null)
                       .map(d => ({ ...d, lote_nombre: d.lote_nombre || extraerLoteDeRuta(d.ruta_rel), es_lote: true }));
        }

        // Agrupar por lote_nombre
        const grupos = {};
        docs.forEach(d => {
          const n = d.lote_nombre || "?";
          grupos[n] = grupos[n] || [];
          grupos[n].push(d);
        });

        for (const [nombre, loteDocs] of Object.entries(grupos)) {
          const parsed = parseLote(loteDocs);
          console.log(`[AOG/mapa] "${nombre}": boundary=${!!parsed.boundary} origen=${!!parsed.origen} sections=${parsed.sections?.length||0}`);
          if (parsed.boundary || parsed.origen) {
            lotesParsed.push({ ...parsed, estab_slug: slug });
          }
        }
      } catch(e) {
        console.error(`[AOG/mapa] ${slug}:`, e.message);
      }
    }

    mapaCacheSet(cacheKey, lotesParsed);
    res.set("X-Cache", "MISS");
    res.json(lotesParsed);
  } catch(e) {
    console.error("[AOG/mapa]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
