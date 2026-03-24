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

// ── ID canónico del lote maestro ─────────────────────────
function loteId(nombre) {
  return `lote_maestro_${nombre.replace(/[^a-zA-Z0-9\u00C0-\u024F]/g, "_").slice(0, 80)}`;
}

// ══════════════════════════════════════════════════════════
//  GET /api/lotes-maestro
//  Lista todos los lotes con resumen de capas
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const slug    = jwtUser?.estabSlug || jwtUser?.estab_slug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });

    const estabDB = getDB(slug);

    // Traer lotes maestros
    const maestros = await findAll(estabDB, { tipo: "lote_maestro" });

    // Traer lotes AOG (lote_nombre únicos)
    const aogDocs = await findAll(estabDB, { tipo: "aog_archivo", es_lote: true }, 2000);
    const aogLotes = {};
    aogDocs.forEach(d => {
      const n = d.lote_nombre || "?";
      if (!aogLotes[n]) aogLotes[n] = { tiene_boundary: false, tiene_sections: false, tiene_origen: false, ts: 0, archivos: 0 };
      if (d.subtipo === "boundary" || d.subtipo === "boundary_kml") aogLotes[n].tiene_boundary = true;
      if (d.subtipo === "sections_coverage")                         aogLotes[n].tiene_sections = true;
      if (d.subtipo === "field_origin")                              aogLotes[n].tiene_origen   = true;
      if ((d.ts || 0) > aogLotes[n].ts)                            aogLotes[n].ts = d.ts;
      aogLotes[n].archivos++;
    });

    // Traer capas externas
    const capas = await findAll(estabDB, { tipo: "lote_capa" }, 2000);
    const capasPorLote = {};
    capas.forEach(c => {
      if (!capasPorLote[c.lote_ref]) capasPorLote[c.lote_ref] = [];
      capasPorLote[c.lote_ref].push({ subtipo: c.subtipo, nombre: c.nombre, ts: c.ts });
    });

    // Traer reportes VistaX
    const vxMetas = await findAll(estabDB, { tipo: "vistax_archivo", subtipo: "vistax_meta" }, 500);
    const vxPorLote = {};
    vxMetas.forEach(v => {
      let meta = {};
      try { meta = JSON.parse(v.contenido); } catch {}
      const nombre = meta.nombre || v.lote_id;
      if (nombre) vxPorLote[nombre] = { lote_id: v.lote_id, cultivo: meta.cultivo, totalSemillas: meta.totalSemillas, ts: v.ts };
    });

    // Unificar: lotes maestros + lotes AOG sin maestro
    const resultado = [];

    // Primero los maestros (incluyen toda la info)
    const maestrosNombres = new Set(maestros.map(m => m.nombre));
    for (const m of maestros) {
      const aog  = aogLotes[m.nombre] || null;
      const caps = capasPorLote[m.nombre] || [];
      const vx   = vxPorLote[m.nombre] || null;
      resultado.push({
        _id:            m._id,
        nombre:         m.nombre,
        cultivo:        m.cultivo || vx?.cultivo || null,
        temporada:      m.temporada || null,
        ha_estimadas:   m.ha_estimadas || null,
        tags:           m.tags || [],
        notas:          m.notas || "",
        tiene_maestro:  true,
        // AOG
        aog:            aog,
        // VistaX
        vistax:         vx,
        // Capas externas
        capas:          caps,
        capas_count:    caps.length,
        ts_ultimo:      Math.max(m.updated_at || 0, aog?.ts || 0, vx?.ts || 0, ...caps.map(c => c.ts || 0)),
      });
    }

    // Lotes AOG sin maestro → aparecen igual pero sin metadata extra
    for (const [nombre, aog] of Object.entries(aogLotes)) {
      if (maestrosNombres.has(nombre)) continue;
      const vx   = vxPorLote[nombre] || null;
      const caps = capasPorLote[nombre] || [];
      resultado.push({
        _id:           loteId(nombre),
        nombre,
        cultivo:       vx?.cultivo || null,
        temporada:     null,
        ha_estimadas:  null,
        tags:          [],
        notas:         "",
        tiene_maestro: false,
        aog,
        vistax:        vx,
        capas:         caps,
        capas_count:   caps.length,
        ts_ultimo:     Math.max(aog.ts || 0, vx?.ts || 0, ...caps.map(c => c.ts || 0)),
      });
    }

    resultado.sort((a, b) => (b.ts_ultimo || 0) - (a.ts_ultimo || 0));
    res.json(resultado);

  } catch(e) {
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
          nombre:  c.nombre,
          ts:      c.ts,
          resumen: c.resumen || null,
          fuente:  c.fuente || null,
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

module.exports = router;
