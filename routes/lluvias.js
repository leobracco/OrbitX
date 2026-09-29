// routes/lluvias.js — Lluvias: la serie de cada lote (fuentes externas en vivo,
// services/lluvia_lote.js), carga de pluviómetro, análisis agrarIA, alertas SMN,
// AgroMet INTA y pronóstico Open-Meteo.
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
//  GET /api/lluvias?lote=<nombre>&dias=<n>
//  Con lote: la lluvia del lote armada en el momento, un valor por día
//  (pluviómetro > estación a ≤ 15 km > Open-Meteo), ver services/lluvia_lote.js.
//  `registros` son los días con lluvia, igual formato que antes, así el mapa,
//  el detalle del lote y la PWA no cambian.
//  Sin lote: los registros de pluviómetro del establecimiento.
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const lote = (req.query.lote || "").trim();
    if (lote) {
      const dias = parseInt(req.query.dias, 10) || 365;
      const r = await require("../services/lluvia_lote").lluviaLote(estabSlug, lote, { dias });
      return res.json({ ...r, puede_editar: puedeEditar(req) });
    }
    const registros = (await listar(estabSlug)).filter(r => !r.fuente || r.fuente === "manual");
    res.json({ registros, puede_editar: puedeEditar(req) });
  } catch (e) {
    console.error("[lluvias]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/lluvias/lotes — lotes de la org para el selector (con o sin ubicación).
router.get("/lotes", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const nombres = new Map();
    for (const p of await require("../lib/lotes-puntos").puntosLotes(estabSlug))
      if (p.nombre) nombres.set(p.nombre.trim().toLowerCase(), p.nombre.trim());
    try {
      const r = await db.getDB(estabSlug).find({ selector: { tipo: "lote_maestro" }, fields: ["nombre"], limit: 2000 });
      for (const d of r.docs) if (d.nombre && !nombres.has(d.nombre.trim().toLowerCase())) nombres.set(d.nombre.trim().toLowerCase(), d.nombre.trim());
    } catch { /* sin lotes maestros */ }
    res.json({ lotes: [...nombres.values()].sort((a, b) => a.localeCompare(b, "es")) });
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
    // Con lote: la serie unificada del lote (un valor por día); sin lote, el pluviómetro.
    const lote = (req.body?.lote || "").trim();
    const registros = lote
      ? (await require("../services/lluvia_lote").lluviaLote(estabSlug, lote, { dias: 365 })).registros
      : (await listar(estabSlug)).filter(r => !r.fuente || r.fuente === "manual");
    if (!registros.length)
      return res.status(400).json({ error: "No hay lluvias para analizar" });

    const s = resumir(registros);
    const meses = Object.entries(s.por_mes)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-12)
      .map(([m, mm]) => `${m}: ${Math.round(mm * 10) / 10} mm`)
      .join("\n");

    const prompt = `Registros de lluvia ${lote ? `del lote "${lote}" (último año)` : `del establecimiento "${estabSlug}"`}:
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
//  ALERTAS SMN vigentes sobre los lotes de la org
// ══════════════════════════════════════════════════════════

// GET /api/lluvias/smn/alertas — sin polígonos (pesan); el cron avisa aparte.
router.get("/smn/alertas", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const r = await require("../services/smn_alertas_sync").alertasOrg(estabSlug);
    res.json({
      lotes:   r.lotes,
      alertas: r.alertas.map(({ poligonos, url, id, ...a }) => a),
      fuente:  "Servicio Meteorológico Nacional (CC BY 4.0)",
    });
  } catch (e) {
    console.error("[lluvias/smn/alertas]", e.message);
    res.status(502).json({ error: `No se pudo consultar el SMN: ${e.message}` });
  }
});

// GET /api/lluvias/agromet — último AgroMet semanal INTA resumido por agrarIA,
// con las provincias de los lotes de la org primero.
router.get("/agromet", async (req, res) => {
  const estabSlug = estabDe(req);
  if (!estabSlug) return res.status(400).json({ error: "Seleccioná un establecimiento" });
  try {
    const doc = await require("../services/agromet").ultimoResumen();
    if (!doc) return res.json({ informe: null });

    const provs = new Set();
    try {
      const zona = require("../services/zona");
      for (const p of await require("../lib/lotes-puntos").puntosLotes(estabSlug)) {
        const dep = await zona.departamento(p.lat, p.lon).catch(() => null);
        if (dep?.provincia) provs.add(dep.provincia);
      }
    } catch { /* sin lotes o sin Georef: se muestran todas */ }

    const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const mias = new Set([...provs].map(norm));
    const provincias = (doc.provincias || [])
      .filter(p => p.puntos?.length)
      .map(p => ({ ...p, propia: mias.has(norm(p.provincia)) }))
      .sort((a, b) => b.propia - a.propia);

    res.json({ informe: {
      numero: doc.numero, fecha: doc.fecha, url: doc.url, pdf: doc.pdf,
      general: doc.general, provincias,
    } });
  } catch (e) {
    console.error("[lluvias/agromet]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  INTEGRACIÓN OPEN-METEO (open-meteo.com) — pronóstico + histórico
//  Modelo grillado por lat/lon: no necesita estación cercana.
//  A diferencia de agrarIA, esto SÍ es un pronóstico real del clima.
// ══════════════════════════════════════════════════════════

const omOrg      = require("../lib/openmeteo-org");
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
  const lote = (req.query.lote || "").trim();
  if (lote) {
    const p = await require("../services/lluvia_lote").puntoLote(estabSlug, lote);
    if (p) return { lat: p.lat, lon: p.lon, origen: "lote" };
  }
  const pts = await require("../lib/lotes-puntos").puntosLotes(estabSlug);
  if (pts.length) return {
    lat: pts.reduce((a, p) => a + p.lat, 0) / pts.length,
    lon: pts.reduce((a, p) => a + p.lon, 0) / pts.length,
    origen: "centroide",
  };
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

module.exports = router;
