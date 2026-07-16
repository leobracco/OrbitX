// routes/lluvias.js — Registro manual de lluvias por establecimiento + análisis agrarIA.
// Slice inicial: carga manual (tipo pluviómetro). La integración con fuentes
// oficiales (INA a5) se suma después sobre este mismo doc/pantalla.
const router = require("express").Router();
const crypto = require("crypto");
const db     = require("../services/couchdb");

// Roles que NO pueden cargar/borrar (solo lectura). El resto sí: es data del
// propio campo y la carga la suele hacer el operador/contratista.
const SOLO_LECTURA = ["viewer"];

function estabDe(req) {
  return req.user?.estabSlug || req.jwtUser?.estabSlug || null;
}

function puedeEditar(req) {
  const rol = req.user?.rol || req.user?.rol_global;
  return !req.user?.isDevice && !SOLO_LECTURA.includes(rol);
}

// ── Listar registros de la org (orden por fecha desc) ─────
async function listar(estabSlug) {
  const edb = db.getDB(estabSlug);
  let docs = [];
  try {
    const r = await edb.find({ selector: { tipo: "lluvia_registro" }, limit: 2000 });
    docs = r.docs;
  } catch {
    const all = await edb.list({ include_docs: true });
    docs = all.rows.map(x => x.doc).filter(d => d && d.tipo === "lluvia_registro");
  }
  // fecha es "YYYY-MM-DD": ordena bien lexicográficamente.
  return docs.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "") || (b.ts || 0) - (a.ts || 0));
}

// ══════════════════════════════════════════════════════════
//  GET /api/lluvias — listar registros del establecimiento activo
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    let registros = await listar(estabSlug);
    // ?lote=<nombre> → solo los registros de ese lote (para el detalle del lote).
    const lote = (req.query.lote || "").trim();
    if (lote) registros = registros.filter(r => (r.lote || "") === lote);
    res.json({ registros, puede_editar: puedeEditar(req) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/lluvias — crear registro manual
// ══════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  if (!puedeEditar(req)) return res.status(403).json({ error: "Sin permiso para cargar lluvias" });

  const { fecha, mm, lote, nota } = req.body;
  const mmNum = Number(mm);
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha))
    return res.status(400).json({ error: "fecha inválida (YYYY-MM-DD)" });
  if (!Number.isFinite(mmNum) || mmNum < 0 || mmNum > 1000)
    return res.status(400).json({ error: "mm inválidos (0–1000)" });

  try {
    const edb = db.getDB(estabSlug);
    const now = Date.now();
    const _id = `lluvia_${fecha}_${crypto.randomBytes(3).toString("hex")}`;
    await edb.insert({
      _id,
      tipo:       "lluvia_registro",
      fecha,
      mm:         Math.round(mmNum * 10) / 10,
      lote:       (lote || "").trim() || null,
      nota:       (nota || "").trim() || "",
      fuente:     "manual",
      creado_por: req.user?.uid ? `usr_${req.user.uid}` : null,
      ts:         new Date(fecha).getTime() || now,
      created_at: now,
      updated_at: now,
    });
    res.json({ ok: true, id: _id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/lluvias/:id — borrar un registro
// ══════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  if (!puedeEditar(req)) return res.status(403).json({ error: "Sin permiso" });
  try {
    const edb = db.getDB(estabSlug);
    const doc = await edb.get(req.params.id).catch(() => null);
    if (!doc || doc.tipo !== "lluvia_registro")
      return res.status(404).json({ error: "Registro no encontrado" });
    await edb.destroy(doc._id, doc._rev);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  POST /api/lluvias/analizar — resumen + interpretación agrarIA
// ══════════════════════════════════════════════════════════
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL   = "claude-sonnet-4-6";
const SYSTEM  = `Sos agrarIA, el asistente agronómico de OrbitX de Agro Parallel.
Respondés en español rioplatense. Tono directo, práctico, campero. Sin markdown ni asteriscos.
Analizás registros de lluvia cargados por el productor. Sé honesto: no pronosticás el clima futuro,
solo interpretás lo que efectivamente llovió y sacás conclusiones útiles para la campaña.`;

async function callClaude(system, prompt, max_tokens = 500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");
  const r = await fetch(API_URL, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API ${r.status}`);
  }
  const data = await r.json();
  return data.content?.[0]?.text?.trim() || "";
}

// Agrega mm por mes (YYYY-MM) y calcula métricas simples.
function resumir(registros) {
  const porMes = {};
  let total = 0, ultima = null;
  for (const r of registros) {
    const mm = Number(r.mm) || 0;
    total += mm;
    const mes = (r.fecha || "").slice(0, 7);
    if (mes) porMes[mes] = (porMes[mes] || 0) + mm;
    if (!ultima || (r.fecha || "") > ultima.fecha) ultima = r;
  }
  const hoy = new Date();
  const mesActual = hoy.toISOString().slice(0, 7);
  const diasSinLluvia = ultima?.fecha
    ? Math.max(0, Math.round((hoy - new Date(ultima.fecha)) / 86400000))
    : null;
  return {
    total_mm:        Math.round(total * 10) / 10,
    registros:       registros.length,
    mes_actual_mm:   Math.round((porMes[mesActual] || 0) * 10) / 10,
    dias_sin_lluvia: diasSinLluvia,
    ultima:          ultima ? { fecha: ultima.fecha, mm: ultima.mm } : null,
    por_mes:         porMes,
  };
}

router.post("/analizar", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const registros = await listar(estabSlug);
    if (!registros.length)
      return res.status(400).json({ error: "No hay lluvias cargadas para analizar" });

    const s = resumir(registros);
    const meses = Object.entries(s.por_mes)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([m, mm]) => `${m}: ${Math.round(mm * 10) / 10} mm`)
      .join("\n");

    const prompt = `Registros de lluvia del establecimiento "${estabSlug}":
Total acumulado histórico cargado: ${s.total_mm} mm en ${s.registros} registros.
Acumulado del mes actual: ${s.mes_actual_mm} mm.
Última lluvia: ${s.ultima ? `${s.ultima.fecha} (${s.ultima.mm} mm)` : "sin datos"}.
Días desde la última lluvia: ${s.dias_sin_lluvia ?? "N/D"}.

Acumulado por mes (últimos 12 con datos):
${meses}

Interpretá estos números para el productor: cómo viene la humedad, si hay rachas secas o excesos,
y 2-3 recomendaciones concretas para el manejo (siembra, humedad de suelo, riesgo). Máximo 6 oraciones.`;

    const analisis = await callClaude(SYSTEM, prompt, 500);
    res.json({ analisis, resumen: s });
  } catch (e) {
    console.error("[lluvias/analizar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  INTEGRACIÓN INA (alerta.ina.gob.ar) — histórico de lluvias
// ══════════════════════════════════════════════════════════

// Centroide aproximado del establecimiento: promedio de los orígenes (Field.txt)
// de los lotes AOG sincronizados. Sirve para buscar la estación INA más cercana.
async function ubicacionEstab(estabSlug) {
  const edb = db.getDB(estabSlug);
  let docs = [];
  try {
    const r = await edb.find({ selector: { tipo: "aog_archivo", subtipo: "field_origin" }, limit: 300 });
    docs = r.docs;
  } catch {
    const all = await edb.list({ include_docs: true });
    docs = all.rows.map(x => x.doc).filter(d => d && d.tipo === "aog_archivo" && d.subtipo === "field_origin");
  }
  const { parseFieldTxt } = require("../services/aog_parser");
  const pts = [];
  for (const d of docs) {
    const o = parseFieldTxt(d.contenido);
    if (o) pts.push({ ...o, nombre: d.lote_nombre || d.nombre || null });
  }
  if (!pts.length) return null;
  return {
    lat:    pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    lon:    pts.reduce((a, p) => a + p.lon, 0) / pts.length,
    lotes:  pts.length,
    puntos: pts.map(p => ({ nombre: p.nombre, lat: p.lat, lon: p.lon })),
  };
}

// GET /api/lluvias/ina/ubicacion — centroide de los lotes de la org.
router.get("/ina/ubicacion", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    res.json({ ubicacion: await ubicacionEstab(estabSlug) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/lluvias/ina/estaciones?lat=&lon=&q= — estaciones cercanas o por texto.
router.get("/ina/estaciones", async (req, res) => {
  try {
    const ina = require("../services/ina");
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const q   = (req.query.q || "").trim();
    if (!q && !(Number.isFinite(lat) && Number.isFinite(lon)))
      return res.status(400).json({ error: "Indicá lat/lon o un texto de búsqueda" });
    const estaciones = await ina.buscarEstaciones({ lat, lon, q, limit: 8 });
    res.json({ estaciones });
  } catch (e) {
    console.error("[lluvias/ina/estaciones]", e.message);
    res.status(502).json({ error: `No se pudo consultar el INA: ${e.message}` });
  }
});

// POST /api/lluvias/ina/importar { sitecode, desde, hasta }
// Trae la serie diaria y guarda los días con lluvia como lluvia_registro
// (fuente:"ina"), con _id determinista para evitar duplicados al re-importar.
router.post("/ina/importar", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  if (!puedeEditar(req)) return res.status(403).json({ error: "Sin permiso para importar" });

  const sitecode = parseInt(req.body.sitecode, 10);
  const { desde, hasta } = req.body;
  if (!sitecode || !/^\d{4}-\d{2}-\d{2}$/.test(desde || "") || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || ""))
    return res.status(400).json({ error: "sitecode, desde y hasta (YYYY-MM-DD) requeridos" });
  if (desde > hasta) return res.status(400).json({ error: "El rango de fechas está invertido" });

  try {
    const ina    = require("../services/ina");
    const est     = (await ina.estaciones())[sitecode] || null;
    const serie   = await ina.datosPrecip(sitecode, desde, hasta);
    const lluvias = serie.filter(x => x.mm > 0);
    if (!lluvias.length)
      return res.json({ ok: true, importados: 0, estacion: est?.nombre || String(sitecode), mensaje: "Sin lluvias en el rango" });

    const edb = db.getDB(estabSlug);
    const now = Date.now();
    const ids = lluvias.map(x => `lluvia_ina_${sitecode}_${x.fecha}`);

    // Traer los _rev existentes para que re-importar actualice (idempotente).
    const revs = {};
    try {
      const f = await edb.fetch({ keys: ids });
      f.rows.forEach(r => { if (r.doc) revs[r.id] = r.doc._rev; });
    } catch {}

    const docs = lluvias.map(x => {
      const _id = `lluvia_ina_${sitecode}_${x.fecha}`;
      return {
        _id,
        ...(revs[_id] ? { _rev: revs[_id] } : {}),
        tipo:         "lluvia_registro",
        fecha:        x.fecha,
        mm:           Math.round(x.mm * 10) / 10,
        lote:         null,
        nota:         `INA · ${est?.nombre || sitecode}`,
        fuente:       "ina",
        ina_sitecode: sitecode,
        ina_estacion: est?.nombre || null,
        ts:           new Date(x.fecha).getTime() || now,
        updated_at:   now,
      };
    });

    const r   = await edb.bulk({ docs });
    const okc = r.filter(x => x.ok).length;
    console.log(`[Lluvias/INA] ${estabSlug}: ${okc}/${docs.length} días de ${est?.nombre || sitecode}`);
    res.json({ ok: true, importados: okc, dias_con_lluvia: lluvias.length, estacion: est?.nombre || String(sitecode) });
  } catch (e) {
    console.error("[lluvias/ina/importar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  INTEGRACIÓN OPEN-METEO (open-meteo.com) — pronóstico + histórico
//  Modelo grillado por lat/lon: no necesita estación cercana.
//  A diferencia de agrarIA, esto SÍ es un pronóstico real del clima.
// ══════════════════════════════════════════════════════════

const omOrg = require("../lib/openmeteo-org");
const ROLES_CONFIG_OM = ["owner", "admin_org", "superadmin"];

// GET /api/lluvias/openmeteo/config — estado de la API key de la org (enmascarada).
router.get("/openmeteo/config", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const c   = await omOrg.getConfig(estabSlug);
    const rol = req.user?.rol || req.user?.rol_global;
    res.json({
      set:          !!c.apikey,
      apikey_mask:  omOrg.mask(c.apikey),
      updated_at:   c.updated_at,
      puede_editar: ROLES_CONFIG_OM.includes(rol),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/lluvias/openmeteo/config { apikey } — guardar/borrar la key (owner/admin).
router.put("/openmeteo/config", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  const rol = req.user?.rol || req.user?.rol_global;
  if (!ROLES_CONFIG_OM.includes(rol))
    return res.status(403).json({ error: "Solo owner o admin pueden configurar Open-Meteo" });
  try {
    const byUid = req.user?.uid ? `usr_${req.user.uid}` : "system";
    await omOrg.setApiKey(estabSlug, req.body?.apikey || "", byUid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resuelve lat/lon del request; si faltan, usa el centroide de la org.
async function resolverPunto(req, estabSlug) {
  const lat = parseFloat(req.query.lat ?? req.body?.lat);
  const lon = parseFloat(req.query.lon ?? req.body?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, origen: "punto" };
  const u = await ubicacionEstab(estabSlug);
  if (u) return { lat: u.lat, lon: u.lon, origen: "centroide" };
  return null;
}

// GET /api/lluvias/openmeteo/pronostico?lat=&lon=&dias=
// Días pasados (7) + pronóstico (hasta 16). Sin lat/lon usa el centroide.
router.get("/openmeteo/pronostico", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const p = await resolverPunto(req, estabSlug);
    if (!p) return res.status(400).json({ error: "No hay lotes con ubicación; indicá lat/lon" });
    const om   = require("../services/openmeteo");
    const key  = await omOrg.getApiKey(estabSlug);
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 10, 1), 16);
    const dias_serie = await om.pronostico(p.lat, p.lon, { dias, pastDays: 7, apiKey: key });
    const futuro = dias_serie.filter(d => d.futuro);
    const total_pronostico = Math.round(futuro.reduce((a, d) => a + d.mm, 0) * 10) / 10;
    res.json({ ok: true, punto: p, dias: dias_serie, total_pronostico, plan: key ? "pago" : "gratuito" });
  } catch (e) {
    console.error("[lluvias/openmeteo/pronostico]", e.message);
    res.status(502).json({ error: `No se pudo consultar Open-Meteo: ${e.message}` });
  }
});

// POST /api/lluvias/openmeteo/importar { lat, lon, desde, hasta, lote? }
// Trae la serie histórica y guarda los días con lluvia como lluvia_registro
// (fuente:"openmeteo"), con _id determinista por lat/lon/fecha (idempotente).
router.post("/openmeteo/importar", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  if (!puedeEditar(req)) return res.status(403).json({ error: "Sin permiso para importar" });

  const { desde, hasta, lote } = req.body;
  const p = await resolverPunto(req, estabSlug);
  if (!p) return res.status(400).json({ error: "Indicá lat/lon o cargá lotes con ubicación" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || "") || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || ""))
    return res.status(400).json({ error: "desde y hasta (YYYY-MM-DD) requeridos" });
  if (desde > hasta) return res.status(400).json({ error: "El rango de fechas está invertido" });

  try {
    const om      = require("../services/openmeteo");
    const key     = await omOrg.getApiKey(estabSlug);
    const serie   = await om.historico(p.lat, p.lon, desde, hasta, key);
    const lluvias = serie.filter(x => x.mm > 0);
    if (!lluvias.length)
      return res.json({ ok: true, importados: 0, mensaje: "Sin lluvias en el rango" });

    const edb  = db.getDB(estabSlug);
    const now  = Date.now();
    const clave = `${p.lat.toFixed(3)}_${p.lon.toFixed(3)}`;
    const ids  = lluvias.map(x => `lluvia_om_${clave}_${x.fecha}`);

    const revs = {};
    try {
      const f = await edb.fetch({ keys: ids });
      f.rows.forEach(r => { if (r.doc) revs[r.id] = r.doc._rev; });
    } catch {}

    const docs = lluvias.map(x => {
      const _id = `lluvia_om_${clave}_${x.fecha}`;
      return {
        _id,
        ...(revs[_id] ? { _rev: revs[_id] } : {}),
        tipo:       "lluvia_registro",
        fecha:      x.fecha,
        mm:         Math.round(x.mm * 10) / 10,
        lote:       (lote || "").trim() || null,
        nota:       "Open-Meteo (histórico)",
        fuente:     "openmeteo",
        om_lat:     Math.round(p.lat * 1000) / 1000,
        om_lon:     Math.round(p.lon * 1000) / 1000,
        ts:         new Date(x.fecha).getTime() || now,
        updated_at: now,
      };
    });

    const r   = await edb.bulk({ docs });
    const okc = r.filter(x => x.ok).length;
    console.log(`[Lluvias/OpenMeteo] ${estabSlug}: ${okc}/${docs.length} días @ ${clave}`);
    res.json({ ok: true, importados: okc, dias_con_lluvia: lluvias.length });
  } catch (e) {
    console.error("[lluvias/openmeteo/importar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
