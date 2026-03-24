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

  const { ruta_rel, nombre, subtipo, es_lote, lote_nombre, hash_md5, contenido, ts } = req.body;
  const tamano = req.body.tamaño ?? req.body.tamano ?? 0;
  if (!ruta_rel) return res.status(400).json({ error:"ruta_rel requerido" });
  // contenido puede ser string vacío (archivo vacío es válido)

  try {
    const estabDB = getEstabDB(estabSlug);
    const safeRel = ruta_rel.replace(/[/\\:*?"<>|]/g, "_");
    const docId   = `aog_${estabSlug}_${safeRel}`.slice(0, 200);

    // Guardar versión histórica si el contenido cambió
    try {
      const existing = await estabDB.get(docId);
      if (existing.hash_md5 && existing.hash_md5 !== hash_md5) {
        const histId = `aog_hist_${estabSlug}_${safeRel}_${existing.ts||Date.now()}`.slice(0, 220);
        await estabDB.insert({
          _id:         histId,
          tipo:        "aog_historial",
          doc_ref:     docId,
          orgSlug:     estabSlug,
          ruta_rel, nombre, subtipo, es_lote, lote_nombre,
          hash_md5:    existing.hash_md5,
          tamaño:      existing.tamaño,
          contenido:   existing.contenido,
          device_id:   existing.device_id,
          ts:          existing.ts || Date.now(),
          ts_guardado: Date.now(),
        }).catch(() => {});
      }
    } catch {}

    await _upsert(estabDB, docId, {
      tipo:"aog_archivo", subtipo:subtipo||"field_file",
      orgSlug:estabSlug, ruta_rel, nombre,
      es_lote:!!es_lote, lote_nombre:lote_nombre||null,
      hash_md5, tamaño:tamano, contenido:contenido||"", device_id:deviceId,
      ts:ts||Date.now(),
    });

    console.log(`[AOG] ✓ ${deviceId} → ${ruta_rel}`);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ══════════════════════════════════════════════════
//  GET /api/aog/lotes
// ══════════════════════════════════════════════════
router.get("/lotes", async (req, res) => {
  try {
    const docs  = await _findAll(getEstabDB(req.user.estabSlug), { tipo:"aog_archivo", es_lote:true });
    const lotes = {};
    docs.forEach(d => {
      const n = d.lote_nombre||"?";
      if (!lotes[n]) lotes[n] = { nombre:n, archivos:[], tiene_boundary:false, tiene_field:false, ts_ultimo:0 };
      lotes[n].archivos.push({ subtipo:d.subtipo, nombre:d.nombre, ts:d.ts, tamaño:d.tamaño, ruta_rel:d.ruta_rel });
      if (d.subtipo==="boundary"||d.subtipo==="boundary_kml") lotes[n].tiene_boundary = true;
      if (d.subtipo==="field_origin") lotes[n].tiene_field = true;
      if (d.ts > lotes[n].ts_ultimo) lotes[n].ts_ultimo = d.ts;
    });
    res.json(Object.values(lotes).sort((a,b)=>b.ts_ultimo-a.ts_ultimo));
  } catch(e) { res.status(500).json({ error:e.message }); }
});
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
        try { const r = await globalDB.find({ selector:{tipo:"org"}, limit:200 }); orgs=r.docs; }
        catch { const all = await globalDB.list({include_docs:true}); orgs=all.rows.map(r=>r.doc).filter(d=>d&&d.tipo==="org"); }
        slugs = orgs.map(o=>o.slug);
        if (!slugs.includes("unassigned")) slugs.push("unassigned");
      }
    } else if (miSlug) { slugs = [miSlug]; }
    const lista = [];
    for (const slug of slugs) {
      try {
        const r = await nano.db.use("orbitx_"+slug).find({ selector:{tipo:"aog_archivo",es_lote:true}, fields:["lote_nombre","subtipo","ts"], limit:2000 });
        const g = {};
        r.docs.forEach(d => {
          const n = d.lote_nombre||"?";
          if (!g[n]) g[n]={nombre:n,estab_slug:slug,tiene_boundary:false,tiene_sections:false,tiene_origen:false,ts:0};
          if (d.subtipo==="boundary"||d.subtipo==="boundary_kml") g[n].tiene_boundary=true;
          if (d.subtipo==="sections_coverage") g[n].tiene_sections=true;
          if (d.subtipo==="field_origin") g[n].tiene_origen=true;
          if ((d.ts||0)>g[n].ts) g[n].ts=d.ts;
        });
        Object.values(g).forEach(l=>lista.push(l));
      } catch(e) { console.error("[lotes-mapa]",slug,e.message); }
    }
    lista.sort((a,b)=>(b.ts||0)-(a.ts||0));
    res.json(lista);
  } catch(e) { res.status(500).json({error:e.message}); }
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

// GET /api/aog/archivo?ruta=...
router.get("/archivo", async (req, res) => {
  try {
    if (!req.query.ruta) return res.status(400).json({ error:"ruta requerida" });
    const safeRel = req.query.ruta.replace(/[/\\:*?"<>|]/g, "_");
    const id      = `aog_${req.user.estabSlug}_${safeRel}`.slice(0, 200);
    const doc     = await getEstabDB(req.user.estabSlug).get(id).catch(()=>null);
    if (!doc) return res.status(404).json({ error:"No encontrado" });
    res.json({ nombre:doc.nombre, subtipo:doc.subtipo, ruta_rel:doc.ruta_rel,
               lote_nombre:doc.lote_nombre, ts:doc.ts, tamaño:doc.tamaño,
               hash_md5:doc.hash_md5, contenido:doc.contenido, device_id:doc.device_id });
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
router.get("/mapa", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const isSA    = jwtUser?.rol_global === "superadmin";
    const miSlug  = jwtUser?.estabSlug  || jwtUser?.estab_slug || null;
    const filtroEstab = req.query.estab;
    const filtroLote  = req.query.lote ? decodeURIComponent(req.query.lote) : null;

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
        let docs;
        if (filtroLote) {
          // Lazy load: solo traer docs del lote pedido
          docs = await _findAll(db.getDB(slug), {
            tipo:        "aog_archivo",
            es_lote:     true,
            lote_nombre: filtroLote,
          });
        } else {
          docs = await _findAll(db.getDB(slug), { tipo: "aog_archivo", es_lote: true });
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

    res.json(lotesParsed);
  } catch(e) {
    console.error("[AOG/mapa]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
