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
    res.json({ registros: await listar(estabSlug), puede_editar: puedeEditar(req) });
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

module.exports = router;
