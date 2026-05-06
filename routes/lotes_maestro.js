// routes/lotes_maestro.js
// Lotes maestros: contenedor principal de toda la info por lote
// Cada lote tiene capas: AOG, VistaX, QuantiX, archivos externos
"use strict";

const router = require("express").Router();
const db     = require("../services/couchdb");

function getDB(slug) { return db.getDB(slug); }

async function findAll(estabDB, selector, limit = 1000) {
  try {
    const r = await estabDB.find({ selector, limit });
    return r.docs;
  } catch {
    const all = await estabDB.list({ include_docs: true });
    return all.rows.map(r => r.doc).filter(d =>
      Object.entries(selector).every(([k, v]) => d[k] === v)
    );
  }
}

async function upsert(estabDB, id, data) {
  let rev;
  try { const e = await estabDB.get(id); rev = e._rev; } catch {}
  await estabDB.insert({ _id: id, ...(rev ? { _rev: rev } : {}), ...data });
}

// ── Cache en memoria con TTL ─────────────────────────────
// CouchDB es remoto (~400ms latencia base). Sin cache, una request a /lotes
// hace 3 calls = 1.5-3s. Con cache de 60s, navegación es instantánea.
const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // key → { data, ts }

function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { _cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }
function cacheInvalidate(slug) {
  for (const key of _cache.keys()) if (key.startsWith(`${slug}::`)) _cache.delete(key);
}

// ── ID canónico del lote maestro ─────────────────────────
function loteId(nombre) {
  return `lote_maestro_${nombre.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, "_").slice(0, 80)}`;
}

// ══════════════════════════════════════════════════════════
//  GET /api/lotes-maestro?limit=50&skip=0&q=&lite=1
//  Lista lotes con resumen de capas. Paginado y con búsqueda server-side.
//  - lite=1 → solo nombre + cultivo + ts_ultimo (sin parsear AOG/vistax/capas).
//  - Sin lite → comportamiento completo (más pesado).
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const tStart = Date.now();
  const timings = {};
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip  = Math.max(parseInt(req.query.skip)  || 0, 0);
    const q     = (req.query.q || "").trim().toLowerCase();
    const lite  = req.query.lite === "1" || req.query.lite === "true";

    // Cache hit: respuesta instantánea sin tocar CouchDB.
    const cacheKey = `${slug}::lotes::${limit}::${skip}::${q}::${lite}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      res.set("X-Cache", "HIT");
      res.set("X-Cache-Age", String(Math.floor((Date.now() - cached._ts) / 1000) + "s"));
      return res.json({ ...cached, _cached: true });
    }

    // Asegurar que el design doc esté cargado en esta org (idempotente, cacheado).
    await db.ensureDesignOnOrg(slug);

    const estabDB = getDB(slug);

    // Índices Mango como fallback si las vistas todavía no están indexadas.
    estabDB.createIndex({ index: { fields: ["tipo", "updated_at"] } }).catch(() => {});
    estabDB.createIndex({ index: { fields: ["tipo", "es_lote", "lote_nombre"] } }).catch(() => {});

    let lista = [];
    let total = 0;

    if (q) {
      // Modo búsqueda: necesitamos todos los nombres para filtrar. Más caro.
      const t0 = Date.now();
      const maestros = await findAll(estabDB, { tipo: "lote_maestro" }, 2000);
      timings.maestros_full = Date.now() - t0;

      const t1 = Date.now();
      let aogDocsLight = [];
      try {
        const r = await estabDB.find({
          selector: { tipo: "aog_archivo", es_lote: true },
          fields:   ["lote_nombre", "subtipo", "ts"],
          limit:    2000,
        });
        aogDocsLight = r.docs;
      } catch {}
      timings.aog_full = Date.now() - t1;

      const aogLotes = {};
      aogDocsLight.forEach(d => {
        const n = d.lote_nombre || "?";
        if (!aogLotes[n]) aogLotes[n] = { tiene_boundary: false, tiene_sections: false, tiene_origen: false, ts: 0, archivos: 0 };
        if (d.subtipo === "boundary" || d.subtipo === "boundary_kml") aogLotes[n].tiene_boundary = true;
        if (d.subtipo === "sections_coverage")                         aogLotes[n].tiene_sections = true;
        if (d.subtipo === "field_origin")                              aogLotes[n].tiene_origen   = true;
        if ((d.ts || 0) > aogLotes[n].ts)                              aogLotes[n].ts = d.ts;
        aogLotes[n].archivos++;
      });

      const nombresMaestros = new Set(maestros.map(m => m.nombre));
      const todos = new Set([...nombresMaestros, ...Object.keys(aogLotes)]);
      lista = [...todos].map(nombre => {
        const m = maestros.find(x => x.nombre === nombre);
        const aog = aogLotes[nombre] || null;
        return { nombre, m, aog, tsUltimo: Math.max(m?.updated_at || 0, aog?.ts || 0) };
      }).filter(it =>
        it.nombre.toLowerCase().includes(q) ||
        (it.m?.cultivo || "").toLowerCase().includes(q) ||
        (it.m?.tags || []).some(t => String(t).toLowerCase().includes(q))
      );
      lista.sort((a, b) => b.tsUltimo - a.tsUltimo);
      total = lista.length;

    } else {
      // Modo sin búsqueda: usar VISTAS NATIVAS de CouchDB.
      // 1) Lotes maestros ordenados por fecha desc, paginación nativa.
      const t0 = Date.now();
      let docsMaestros = [];
      try {
        const r = await estabDB.view("orbitx", "lotes_maestros_por_fecha", {
          descending: true,
          limit, skip,
          include_docs: false,
          reduce: false,
        });
        docsMaestros = (r.rows || []).map(row => ({
          _id:          row.id,
          nombre:       row.value.nombre,
          cultivo:      row.value.cultivo,
          temporada:    row.value.temporada,
          ha_estimadas: row.value.ha_estimadas,
          ha_calculadas:row.value.ha_calculadas,
          tags:         row.value.tags,
          origen:       row.value.origen,
          updated_at:   row.value.updated_at,
        }));
      } catch (e) {
        // Fallback Mango si la vista no está construida todavía.
        console.warn("[lotes-maestro] view fallback:", e.message);
        try {
          const r = await estabDB.find({
            selector: { tipo: "lote_maestro", updated_at: { $gte: 0 } },
            sort:     [{ updated_at: "desc" }],
            limit, skip,
          });
          docsMaestros = r.docs;
        } catch {
          const fb = await findAll(estabDB, { tipo: "lote_maestro" }, 2000);
          fb.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
          docsMaestros = fb.slice(skip, skip + limit);
        }
      }
      timings.maestros = Date.now() - t0;

      lista = docsMaestros.map(m => ({
        nombre: m.nombre,
        m,
        aog:   null,
        tsUltimo: m.updated_at || 0,
      }));

      // 2) Sumar lotes AOG sin maestro SOLO en la primera página, con vista group:1.
      if (skip === 0) {
        const t1 = Date.now();
        let nombresAOG = [];
        try {
          const r = await estabDB.view("orbitx", "lotes_aog_por_nombre", {
            group_level: 1,
          });
          nombresAOG = (r.rows || []).map(row => row.key).filter(Boolean);
        } catch (e) {
          console.warn("[lotes-maestro] view AOG fallback:", e.message);
        }
        timings.aog_unicos = Date.now() - t1;

        // 3) Para los lotes de la página + los AOG-sin-maestro, traer flags por vista.
        const yaMaestros = new Set(lista.map(x => x.nombre));
        const aogSinMaestro = nombresAOG.filter(n => !yaMaestros.has(n)).slice(0, 100);
        const todosNombres = [...lista.map(x => x.nombre), ...aogSinMaestro];

        if (todosNombres.length) {
          const t2 = Date.now();
          try {
            const r = await estabDB.view("orbitx", "lotes_aog_por_nombre", {
              keys: todosNombres,
              reduce: false,
            });
            const flags = {};
            (r.rows || []).forEach(row => {
              const n = row.key;
              const subtipo = row.value?.subtipo;
              const ts      = row.value?.ts || 0;
              if (!flags[n]) flags[n] = { tiene_boundary: false, tiene_sections: false, tiene_origen: false, ts: 0, archivos: 0 };
              if (subtipo === "boundary" || subtipo === "boundary_kml") flags[n].tiene_boundary = true;
              if (subtipo === "sections_coverage")                       flags[n].tiene_sections = true;
              if (subtipo === "field_origin")                            flags[n].tiene_origen   = true;
              if (ts > flags[n].ts) flags[n].ts = ts;
              flags[n].archivos++;
            });

            // Asignar flags a la lista.
            lista.forEach(it => { if (flags[it.nombre]) it.aog = flags[it.nombre]; });

            // Sumar lotes AOG sin maestro.
            for (const nombre of aogSinMaestro) {
              const aog = flags[nombre];
              if (aog) lista.push({ nombre, m: null, aog, tsUltimo: aog.ts || 0 });
            }
            lista.sort((a, b) => b.tsUltimo - a.tsUltimo);
          } catch (e) { console.warn("[lotes-maestro] view flags:", e.message); }
          timings.aog_flags = Date.now() - t2;
        }
      }

      total = null;  // se usa hayMas
    }

    const hayMas = q
      ? (skip + limit < lista.length)
      : (lista.length >= limit); // si vino lleno, asumimos que hay más
    const pagina = q ? lista.slice(skip, skip + limit) : lista.slice(0, limit);

    timings.total = Date.now() - tStart;

    // Modo lite: armar el resultado solo con maestro + aog (sin parsear capas/vistax).
    if (lite) {
      const resultado = pagina.map(({ nombre, m, aog, tsUltimo }) => ({
        _id:           m?._id || loteId(nombre),
        nombre,
        cultivo:       m?.cultivo || null,
        temporada:     m?.temporada || null,
        ha_estimadas:  m?.ha_estimadas || null,
        tags:          m?.tags || [],
        tiene_maestro: !!m,
        aog,
        ts_ultimo:     tsUltimo,
      }));
      const payload = { items: resultado, total, limit, skip, hayMas, timings, _ts: Date.now() };
      cacheSet(cacheKey, payload);
      res.set("X-Cache", "MISS");
      return res.json(payload);
    }

    // Modo completo: solo para los lotes de la página, traemos vistax + capas.
    const nombresPagina = pagina.map(p => p.nombre);

    // Capas externas — solo de los lotes de esta página.
    let capas = [];
    try {
      const r = await estabDB.find({
        selector: { tipo: "lote_capa", lote_ref: { $in: nombresPagina } },
        limit:    2000,
      });
      capas = r.docs;
    } catch {
      const all = await findAll(estabDB, { tipo: "lote_capa" }, 5000);
      capas = all.filter(c => nombresPagina.includes(c.lote_ref));
    }
    const capasPorLote = {};
    capas.forEach(c => {
      if (!capasPorLote[c.lote_ref]) capasPorLote[c.lote_ref] = [];
      capasPorLote[c.lote_ref].push({ subtipo: c.subtipo, nombre: c.nombre, ts: c.ts });
    });

    // Reportes VistaX — solo los meta y filtrados por la página.
    let vxMetas = [];
    try {
      const r = await estabDB.find({
        selector: { tipo: "vistax_archivo", subtipo: "vistax_meta" },
        fields:   ["contenido", "lote_id", "ts"],
        limit:    1000,
      });
      vxMetas = r.docs;
    } catch {
      vxMetas = await findAll(estabDB, { tipo: "vistax_archivo", subtipo: "vistax_meta" }, 1000);
    }
    const vxPorLote = {};
    vxMetas.forEach(v => {
      let meta = {};
      try { meta = JSON.parse(v.contenido || "{}"); } catch {}
      const nombre = meta.nombre || v.lote_id;
      if (nombre && nombresPagina.includes(nombre)) {
        vxPorLote[nombre] = { lote_id: v.lote_id, cultivo: meta.cultivo, totalSemillas: meta.totalSemillas, ts: v.ts };
      }
    });

    const resultado = pagina.map(({ nombre, m, aog, tsUltimo }) => {
      const caps = capasPorLote[nombre] || [];
      const vx   = vxPorLote[nombre]    || null;
      return {
        _id:           m?._id || loteId(nombre),
        nombre,
        cultivo:       m?.cultivo || vx?.cultivo || null,
        temporada:     m?.temporada || null,
        ha_estimadas:  m?.ha_estimadas || null,
        tags:          m?.tags || [],
        notas:         m?.notas || "",
        tiene_maestro: !!m,
        aog,
        vistax:        vx,
        capas:         caps,
        capas_count:   caps.length,
        ts_ultimo:     Math.max(tsUltimo, vx?.ts || 0, ...caps.map(c => c.ts || 0)),
      };
    });

    const payload = { items: resultado, total, limit, skip, hayMas, timings, _ts: Date.now() };
    cacheSet(cacheKey, payload);
    res.set("X-Cache", "MISS");
    res.json(payload);

  } catch (e) {
    console.error("[lotes-maestro/list]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/lotes-maestro/:nombre/contexto
//  Contexto completo del lote para agrarIA
// ══════════════════════════════════════════════════════════
router.get("/:nombre/contexto", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    const nombre  = decodeURIComponent(req.params.nombre);
    const estabDB = getDB(slug);

    const contexto = { nombre, estab: slug, capas: {} };

    // 1. Metadata maestro
    try {
      const m = await estabDB.get(loteId(nombre));
      contexto.cultivo     = m.cultivo;
      contexto.temporada   = m.temporada;
      contexto.ha_estimadas = m.ha_estimadas;
      contexto.tags        = m.tags;
      contexto.notas       = m.notas;
    } catch {}

    // 2. AOG — boundary, sections, origen
    const aogDocs = await findAll(estabDB, { tipo: "aog_archivo", es_lote: true, lote_nombre: nombre });
    if (aogDocs.length) {
      const { parseLote } = require("../services/aog_parser");
      const parsed = parseLote(aogDocs);
      contexto.capas.aog = {
        tiene_boundary:  !!parsed.boundary,
        tiene_sections:  !!parsed.sections,
        pasadas:         parsed.sections?.length || 0,
        tiene_origen:    !!parsed.origen,
        origen:          parsed.origen,
        archivos:        aogDocs.map(d => ({ subtipo: d.subtipo, nombre: d.nombre, ts: d.ts })),
      };
    }

    // 3. VistaX — metas de todos los reportes del lote
    const vxDocs = await findAll(estabDB, { tipo: "vistax_archivo" }, 500);
    const vxDelLote = vxDocs.filter(d => {
      let meta = {};
      try { meta = JSON.parse(d.contenido || "{}"); } catch {}
      return meta.nombre === nombre || d.lote_id === nombre;
    });
    if (vxDelLote.length) {
      const metas = vxDelLote.filter(d => d.subtipo === "vistax_meta").map(d => {
        let m = {};
        try { m = JSON.parse(d.contenido); } catch {}
        return m;
      });
      contexto.capas.vistax = {
        reportes:        metas.length,
        cultivo:         metas[0]?.cultivo,
        semillas_total:  metas.reduce((s, m) => s + (m.totalSemillas || 0), 0),
        duracion_min:    metas.reduce((s, m) => s + (m.duracionMin || 0), 0),
        densidad_obj:    metas[0]?.densidadObjetivo,
        tiene_densidad:  vxDelLote.some(d => d.subtipo === "vistax_densidad"),
        tiene_semillas:  vxDelLote.some(d => d.subtipo === "vistax_semillas"),
        tiene_alertas:   vxDelLote.some(d => d.subtipo === "vistax_alertas"),
      };
    }

    // 4. Capas externas (NDVI, lluvias, QuantiX, archivos subidos)
    const capas = await findAll(estabDB, { tipo: "lote_capa", lote_ref: nombre });
    if (capas.length) {
      const porSubtipo = {};
      capas.forEach(c => {
        if (!porSubtipo[c.subtipo]) porSubtipo[c.subtipo] = [];
        porSubtipo[c.subtipo].push({
          _id:             c._id,
          nombre:          c.nombre,
          ts:              c.ts,
          resumen:         c.resumen         || null,
          fuente:          c.fuente          || null,
          // Contenido para dibujar en el mapa
          contenido_texto: c.contenido_texto || null,
          base64:          c.base64          || null,
          mediaType:       c.mediaType       || null,
        });
      });
      contexto.capas.externas = porSubtipo;
    }

    res.json(contexto);
  } catch(e) {
    console.error("[lotes-maestro/contexto]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/lotes-maestro/:nombre
//  Crear o actualizar metadata del lote maestro
// ══════════════════════════════════════════════════════════
router.put("/:nombre", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    const nombre  = decodeURIComponent(req.params.nombre);
    const { cultivo, temporada, ha_estimadas, tags, notas } = req.body;

    const estabDB = getDB(slug);
    const now     = Date.now();
    const id      = loteId(nombre);

    let existing = {};
    try { existing = await estabDB.get(id); } catch {}

    await upsert(estabDB, id, {
      ...existing,
      tipo:         "lote_maestro",
      nombre,
      estab_slug:   slug,
      cultivo:      cultivo      ?? existing.cultivo      ?? null,
      temporada:    temporada    ?? existing.temporada    ?? null,
      ha_estimadas: ha_estimadas ?? existing.ha_estimadas ?? null,
      tags:         tags         ?? existing.tags         ?? [],
      notas:        notas        ?? existing.notas        ?? "",
      created_at:   existing.created_at || now,
      updated_at:   now,
    });

    res.json({ ok: true, id });
  } catch(e) {
    console.error("[lotes-maestro/put]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/lotes-maestro/:nombre/capa
//  Agregar una capa externa al lote (NDVI, lluvia, QuantiX, etc.)
//  Body: { subtipo, nombre, fuente, resumen, contenido_texto, base64, mediaType }
// ══════════════════════════════════════════════════════════
router.post("/:nombre/capa", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    const loteRef = decodeURIComponent(req.params.nombre);
    const {
      subtipo, nombre, fuente,
      resumen, contenido_texto,
      base64, mediaType,
    } = req.body;

    if (!subtipo || !nombre) return res.status(400).json({ error: "subtipo y nombre requeridos" });

    const estabDB = getDB(slug);
    const now     = Date.now();
    const id      = `lote_capa_${slug}_${loteRef}_${subtipo}_${now}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 220);

    await estabDB.insert({
      _id:             id,
      tipo:            "lote_capa",
      lote_ref:        loteRef,
      estab_slug:      slug,
      subtipo,          // ndvi | lluvia | quantix | imagen | pdf | csv | shapefile | nota | otro
      nombre,
      fuente:          fuente || "manual",   // manual | quantix | drone | smn | usuario
      resumen:         resumen || null,       // texto breve auto-generado o ingresado
      contenido_texto: contenido_texto || null,
      base64:          base64 || null,
      mediaType:       mediaType || null,
      ts:              now,
      subido_por:      `usr_${jwtUser?.uid || "?"}`,
    });

    console.log(`[lotes-maestro] Capa "${subtipo}" → lote "${loteRef}"`);
    res.json({ ok: true, id });
  } catch(e) {
    console.error("[lotes-maestro/capa]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/lotes-maestro/:nombre/capa/:capaId
// ══════════════════════════════════════════════════════════
router.delete("/:nombre/capa/:capaId", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    const estabDB = getDB(slug);
    const doc     = await estabDB.get(req.params.capaId).catch(() => null);
    if (!doc) return res.status(404).json({ error: "Capa no encontrada" });
    await estabDB.destroy(doc._id, doc._rev);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════
//  GET /api/lotes-maestro/:nombre/debug-capas
//  Diagnóstico: muestra exactamente qué hay en CouchDB para las capas
// ══════════════════════════════════════════════════════════
router.get("/:nombre/debug-capas", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    const nombre  = decodeURIComponent(req.params.nombre);
    const estabDB = getDB(slug);

    const capas = await findAll(estabDB, { tipo: "lote_capa", lote_ref: nombre });

    res.json({
      slug,
      lote_ref: nombre,
      total: capas.length,
      capas: capas.map(c => ({
        _id:                    c._id,
        nombre:                 c.nombre,
        subtipo:                c.subtipo,
        fuente:                 c.fuente,
        tiene_contenido_texto:  !!c.contenido_texto,
        len_contenido_texto:    c.contenido_texto?.length || 0,
        tiene_base64:           !!c.base64,
        len_base64:             c.base64?.length || 0,
        mediaType:              c.mediaType || null,
        ts:                     c.ts,
      }))
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/lotes-maestro/crear
//  Crea un lote nuevo con boundary y lo encola para descarga al device.
//  Body: { nombre, boundary: [[lat,lon],...], device_id?, cultivo?, temporada?, ha_estimadas?, tags?, notas? }
//
//  Genera Field.txt + Boundary.txt + boundary.kml en formato AOG y los
//  guarda como aog_archivo + aog_descarga_pendiente. El agente OrbitX-Sync
//  los baja vía /api/aog/pendientes-descarga y los pone en Fields/<nombre>/.
// ══════════════════════════════════════════════════════════
router.post("/crear", async (req, res) => {
  try {
    const aogWriter = require("../lib/aog_writer");
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });

    const { nombre, boundary, device_id, cultivo, temporada, ha_estimadas, tags, notas, origen } = req.body || {};
    if (!nombre || typeof nombre !== "string" || nombre.length < 2)
      return res.status(400).json({ error: "Pasá un nombre válido (mínimo 2 caracteres)" });
    if (!Array.isArray(boundary) || boundary.length < 3)
      return res.status(400).json({ error: "El boundary necesita al menos 3 puntos" });

    // Validar puntos.
    const ring = boundary.map(p => {
      if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") return [p[0], p[1]];
      if (p && typeof p.lat === "number" && typeof p.lon === "number") return [p.lat, p.lon];
      if (p && typeof p.lat === "number" && typeof p.lng === "number") return [p.lat, p.lng];
      throw new Error("Punto inválido en boundary");
    });

    // Origen: si no lo pasan, usamos el centroide.
    const orig = origen && typeof origen.lat === "number" && typeof origen.lon === "number"
      ? origen
      : aogWriter.centroide(ring);

    const ha = aogWriter.calcularHectareas(ring);

    const fieldTxt    = aogWriter.generarFieldTxt({ nombre, origen: orig });
    const boundaryTxt = aogWriter.generarBoundaryTxt({ rings: [ring] });
    const kml         = aogWriter.generarKML({ nombre, ring });

    const estabDB = getDB(slug);
    const now     = Date.now();
    const safeRel = nombre.replace(/[\\/:*?"<>|]/g, "_");

    // 1) Doc lote_maestro.
    await upsert(estabDB, loteId(nombre), {
      tipo:         "lote_maestro",
      nombre,
      cultivo:      cultivo || null,
      temporada:    temporada || null,
      ha_estimadas: ha_estimadas != null ? ha_estimadas : Number(ha.toFixed(2)),
      ha_calculadas: Number(ha.toFixed(2)),
      tags:         Array.isArray(tags) ? tags : [],
      notas:        notas || "",
      origen:       orig,
      boundary_geojson: { type: "Polygon", coordinates: [ring.map(([lat, lon]) => [lon, lat]).concat([[ring[0][1], ring[0][0]]])] },
      creado_desde: "orbitx",
      creado_por:   jwtUser?.uid ? `usr_${jwtUser.uid}` : "system",
      created_at:   now,
      updated_at:   now,
    });

    // 2) Docs aog_archivo (fuente de verdad cloud).
    const archivos = [
      { subtipo: "field_origin",  ruta_rel: `Fields/${safeRel}/Field.txt`,    nombre: "Field.txt",    contenido: fieldTxt },
      { subtipo: "boundary",      ruta_rel: `Fields/${safeRel}/Boundary.txt`, nombre: "Boundary.txt", contenido: boundaryTxt },
      { subtipo: "boundary_kml",  ruta_rel: `Fields/${safeRel}/boundary.kml`, nombre: "boundary.kml", contenido: kml },
    ];

    for (const a of archivos) {
      const docId = `aog_${slug}_${a.ruta_rel.replace(/[/\\:*?"<>|]/g, "_")}`.slice(0, 200);
      await upsert(estabDB, docId, {
        tipo:        "aog_archivo",
        ruta_rel:    a.ruta_rel,
        nombre:      a.nombre,
        subtipo:     a.subtipo,
        es_lote:     true,
        lote_nombre: nombre,
        contenido:   a.contenido,
        tamano:      Buffer.byteLength(a.contenido, "utf8"),
        ts:          now,
        creado_desde: "orbitx",
        synced_at:   null,
      });
    }

    // 3) Encolar descarga al device si fue indicado.
    let encolados = 0;
    if (device_id) {
      // Validar que el device pertenezca a la org del usuario.
      const globalDB = db.getDB("global");
      const dev = await globalDB.get(`device_${device_id}`).catch(() => null);
      const esSA = jwtUser?.rol_global === "superadmin";
      if (!dev) return res.status(404).json({ error: "Dispositivo no encontrado" });
      if (!esSA && dev.estab_slug !== slug)
        return res.status(403).json({ error: "Ese tractor no es de tu organización" });

      for (const a of archivos) {
        await estabDB.insert({
          _id:       `aog_descarga_${slug}_${now}_${a.subtipo}`,
          tipo:      "aog_descarga_pendiente",
          ruta_rel:  a.ruta_rel,
          nombre:    a.nombre,
          subtipo:   a.subtipo,
          contenido: a.contenido,
          device_id,
          entregado: false,
          ts:        now,
          origen_creacion: "lote_creado_orbitx",
          lote_nombre: nombre,
        });
        encolados++;
      }

      // Notif por socket si está conectado.
      if (req.io) req.io.to(`maquina:${device_id}`).emit("lote:nuevo", { nombre, ts: now });
    }

    cacheInvalidate(slug);
    res.json({
      ok:           true,
      lote:         nombre,
      ha_calculadas: Number(ha.toFixed(2)),
      origen:       orig,
      archivos:     archivos.length,
      encolados,
      device_id:    device_id || null,
    });
  } catch (e) {
    console.error("[lotes-maestro/crear]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;


// ══════════════════════════════════════════════════════════
//  POST /api/lotes-maestro/shp-to-geojson
//  Convierte SHP (UTM o WGS84) → GeoJSON para el mapa
//  Body: { shp: base64, shx: base64, dbf: base64, prj: string }
// ══════════════════════════════════════════════════════════
router.post("/shp-to-geojson", async (req, res) => {
  try {
    const { shp: shpB64, shx: shxB64, dbf: dbfB64, prj: prjText } = req.body;
    if (!shpB64) return res.status(400).json({ error: "shp requerido" });

    const shp = Buffer.from(shpB64, "base64");
    const shx = shxB64 ? Buffer.from(shxB64, "base64") : null;
    const dbf = dbfB64 ? Buffer.from(dbfB64, "base64") : null;

    // ── Detectar proyección desde PRJ ────────────────────
    let isUTM     = false;
    let utmZone   = 20;
    let isSouthern = true;

    if (prjText) {
      isUTM     = /UTM/i.test(prjText);
      const zm  = prjText.match(/Zone_(\d+)/i);
      if (zm)   utmZone = parseInt(zm[1]);
      isSouthern = /south/i.test(prjText) || /[_\s]S["\s,]/i.test(prjText);
    } else {
      // Sin PRJ: detectar por bbox (si X > 1000 → UTM)
      const bboxX = shp.readDoubleBE ? 0 : (() => {
        const buf = Buffer.from(shp.buffer || shp);
        let v = 0;
        try { v = buf.readDoubleBE ? buf.readDoubleBE(36) : 0; } catch {}
        return v;
      })();
      const bboxXmin = shp.readDoubleLE(36);
      isUTM = Math.abs(bboxXmin) > 1000;
    }

    // ── Parser UTM → WGS84 ───────────────────────────────
    function utmToWGS84(easting, northing) {
      if (isSouthern) northing -= 10000000.0;
      const x  = easting - 500000.0;
      const k0 = 0.9996, a = 6378137.0, e2 = 0.00669438;
      const M  = northing / k0;
      const mu = M / (a * (1 - e2/4 - 3*e2**2/64 - 5*e2**3/256));
      const e1 = (1 - Math.sqrt(1-e2)) / (1 + Math.sqrt(1-e2));
      const fp = mu
        + (3*e1/2  - 27*e1**3/32)  * Math.sin(2*mu)
        + (21*e1**2/16 - 55*e1**4/32) * Math.sin(4*mu)
        + 151*e1**3/96 * Math.sin(6*mu)
        + 1097*e1**4/512 * Math.sin(8*mu);
      const C1  = e2/(1-e2) * Math.cos(fp)**2;
      const T1  = Math.tan(fp)**2;
      const N1  = a / Math.sqrt(1 - e2*Math.sin(fp)**2);
      const R1  = a * (1-e2) / (1 - e2*Math.sin(fp)**2)**1.5;
      const D   = x / (N1*k0);
      const lat = fp - (N1*Math.tan(fp)/R1) * (
        D**2/2 - (5+3*T1+10*C1-4*C1**2-9*e2/(1-e2)) * D**4/24
        + (61+90*T1+298*C1+45*T1**2-252*e2/(1-e2)-3*C1**2) * D**6/720
      );
      const lon0 = ((utmZone-1)*6 - 180 + 3) * Math.PI/180;
      const lon  = lon0 + (
        D - (1+2*T1+C1)*D**3/6
        + (5-2*C1+28*T1-3*C1**2+8*e2/(1-e2)+24*T1**2)*D**5/120
      ) / Math.cos(fp);
      return [
        Math.round(lon * 1e7) / 1e7,
        Math.round(lat * 1e7) / 1e7,
      ];
    }

    // ── Leer DBF ─────────────────────────────────────────
    let dbfFields   = [];
    let dbfRecords  = [];
    let dbfHdrSize  = 0;
    let dbfRecSize  = 0;
    let dbfNumRec   = 0;

    if (dbf) {
      dbfNumRec  = dbf.readUInt32LE(4);
      dbfHdrSize = dbf.readUInt16LE(8);
      dbfRecSize = dbf.readUInt16LE(10);
      let pos = 32;
      while (pos < dbfHdrSize - 1 && dbf[pos] !== 0x0D) {
        const name = dbf.slice(pos, pos+11).toString("ascii").replace(/\0/g,"").trim();
        const type = String.fromCharCode(dbf[pos+11]);
        const len  = dbf[pos+16];
        dbfFields.push({ name, type, len });
        pos += 32;
      }
      for (let i = 0; i < Math.min(dbfNumRec, 100000); i++) {
        const rec  = dbf.slice(dbfHdrSize + i*dbfRecSize, dbfHdrSize + (i+1)*dbfRecSize);
        if (!rec.length || rec[0] === 0x2A) { dbfRecords.push(null); continue; }
        const obj  = {};
        let offset = 1;
        for (const f of dbfFields) {
          const raw = rec.slice(offset, offset+f.len).toString("latin1").trim();
          obj[f.name] = (f.type === "N" || f.type === "F") ? (parseFloat(raw) || 0) : raw;
          offset += f.len;
        }
        dbfRecords.push(obj);
      }
    }

    // ── Leer SHX para offsets ────────────────────────────
    const nRec = shx ? (shx.readInt32BE(24)*2 - 100) / 8 : 0;
    const shapeType = shp.readInt32LE(32);

    // ── Leer SHP y generar features ──────────────────────
    const features = [];

    for (let i = 0; i < nRec; i++) {
      if (!shx) break;
      const recOff = shx.readInt32BE(100 + i*8) * 2;
      const stype  = shp.readInt32LE(recOff + 8);
      if (stype === 0) continue;

      const props  = dbfRecords[i] || {};

      // ── Point / PointZ / PointM ──────────────────────
      if (stype === 1 || stype === 11 || stype === 21) {
        const x = shp.readDoubleLE(recOff + 12);
        const y = shp.readDoubleLE(recOff + 20);
        const [lon, lat] = isUTM ? utmToWGS84(x, y) : [
          Math.round(x*1e7)/1e7, Math.round(y*1e7)/1e7
        ];
        features.push({ type:"Feature", geometry:{ type:"Point", coordinates:[lon, lat] }, properties:props });
        continue;
      }

      // ── Polygon / PolygonZ / PolygonM ────────────────
      if (stype === 5 || stype === 15 || stype === 25) {
        const nParts  = shp.readInt32LE(recOff + 44);
        const nPoints = shp.readInt32LE(recOff + 48);
        const partsOff = Array.from({ length: nParts }, (_, pi) =>
          shp.readInt32LE(recOff + 52 + pi*4)
        );
        const ptsStart = recOff + 52 + nParts*4;
        const rings = [];
        for (let pi = 0; pi < nParts; pi++) {
          const from = partsOff[pi];
          const to   = pi < nParts-1 ? partsOff[pi+1] : nPoints;
          const ring = [];
          for (let k = from; k < to; k++) {
            const x = shp.readDoubleLE(ptsStart + k*16);
            const y = shp.readDoubleLE(ptsStart + k*16 + 8);
            ring.push(isUTM ? utmToWGS84(x, y) : [Math.round(x*1e7)/1e7, Math.round(y*1e7)/1e7]);
          }
          rings.push(ring);
        }
        features.push({ type:"Feature", geometry:{ type:"Polygon", coordinates:rings }, properties:props });
        continue;
      }

      // ── Polyline / PolylineZ / PolylineM ─────────────
      if (stype === 3 || stype === 13 || stype === 23) {
        const nParts  = shp.readInt32LE(recOff + 44);
        const nPoints = shp.readInt32LE(recOff + 48);
        const partsOff = Array.from({ length: nParts }, (_, pi) =>
          shp.readInt32LE(recOff + 52 + pi*4)
        );
        const ptsStart = recOff + 52 + nParts*4;
        const lines = [];
        for (let pi = 0; pi < nParts; pi++) {
          const from = partsOff[pi];
          const to   = pi < nParts-1 ? partsOff[pi+1] : nPoints;
          const line = [];
          for (let k = from; k < to; k++) {
            const x = shp.readDoubleLE(ptsStart + k*16);
            const y = shp.readDoubleLE(ptsStart + k*16 + 8);
            line.push(isUTM ? utmToWGS84(x, y) : [Math.round(x*1e7)/1e7, Math.round(y*1e7)/1e7]);
          }
          lines.push(line);
        }
        const geomType = nParts === 1 ? "LineString" : "MultiLineString";
        const coords   = nParts === 1 ? lines[0] : lines;
        features.push({ type:"Feature", geometry:{ type:geomType, coordinates:coords }, properties:props });
        continue;
      }
    }

    console.log(`[shp-to-geojson] ${features.length} features, isUTM=${isUTM}, zone=${utmZone}${isSouthern?"S":"N"}`);

    res.json({
      type:     "FeatureCollection",
      features,
      _meta: {
        total:    features.length,
        isUTM,
        utmZone,
        isSouthern,
        shapeType,
      },
    });

  } catch(e) {
    console.error("[shp-to-geojson]", e.message);
    res.status(500).json({ error: e.message });
  }
});
