// routes/agraria_chat.js — agrarIA con contexto real de datos del establecimiento
const router = require("express").Router();
const db     = require("../services/couchdb");

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL   = "claude-sonnet-4-20250514";

const SYSTEM_BASE = `Sos agrarIA, el asistente agronómico de OrbitX de Agro Parallel.
Respondés en español rioplatense. Tono directo, práctico y técnico pero accesible para productores y maquinistas.
Cuando analizás datos de siembra, sos preciso con los números y das recomendaciones concretas.
No usás markdown ni asteriscos. Máximo 6 oraciones por respuesta salvo que te pidan más detalle.`;

async function callClaude(system, messages, max_tokens = 800) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");

  const r = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API ${r.status}`);
  }

  const data = await r.json();
  return data.content?.[0]?.text?.trim() || "";
}

// ── Helpers para armar contexto ───────────────────────────
async function getContextoEstab(estabSlug) {
  if (!estabSlug || estabSlug === "null") return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector: { tipo: "aog_archivo", es_lote: true }, limit: 500 });
      docs = r.docs;
    } catch {
      const all = await estabDB.list({ include_docs: true });
      docs = all.rows.map(r => r.doc).filter(d => d.tipo === "aog_archivo" && d.es_lote);
    }

    // Agrupar por lote
    const lotes = {};
    docs.forEach(d => {
      const n = d.lote_nombre || "?";
      if (!lotes[n]) lotes[n] = { nombre: n, archivos: [] };
      lotes[n].archivos.push(d.subtipo);
    });

    return {
      estab:       estabSlug,
      lotes_count: Object.keys(lotes).length,
      lotes:       Object.values(lotes).map(l => ({
        nombre:          l.nombre,
        tiene_sections:  l.archivos.includes("sections_coverage"),
        tiene_boundary:  l.archivos.includes("boundary") || l.archivos.includes("boundary_kml"),
        tiene_field:     l.archivos.includes("field_origin"),
      })),
    };
  } catch { return null; }
}

async function getDatosLote(estabSlug, loteNombre) {
  if (!estabSlug || !loteNombre) return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector: { tipo: "aog_archivo", es_lote: true, lote_nombre: loteNombre }, limit: 20 });
      docs = r.docs;
    } catch {}

    const { parseLote } = require("../services/aog_parser");
    const parsed = parseLote(docs);

    return {
      nombre:          loteNombre,
      tiene_boundary:  !!parsed.boundary,
      tiene_origen:    !!parsed.origen,
      pasadas:         parsed.sections?.length || 0,
      origen:          parsed.origen,
    };
  } catch { return null; }
}

async function getDatosVistaX(estabSlug, loteId) {
  if (!estabSlug || !loteId) return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector: { tipo: "vistax_archivo", lote_id: loteId }, limit: 10 });
      docs = r.docs;
    } catch {}

    const meta = docs.find(d => d.subtipo === "vistax_meta");
    if (!meta) return null;

    let metaData = {};
    try { metaData = JSON.parse(meta.contenido); } catch {}

    return {
      lote_id:       loteId,
      nombre:        metaData.nombre,
      cultivo:       metaData.cultivo,
      totalSemillas: metaData.totalSemillas,
      duracionMin:   metaData.duracionMin,
      densidad_obj:  metaData.densidadObjetivo,
      startTs:       metaData.startTs,
      endTs:         metaData.endTs,
    };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/chat — chat libre con contexto
// ══════════════════════════════════════════════════════════
router.post("/chat", async (req, res) => {
  const { mensaje, historial = [] } = req.body;
  if (!mensaje) return res.status(400).json({ error: "mensaje requerido" });

  try {
    const estabSlug = req.user?.estabSlug;
    const contexto  = await getContextoEstab(estabSlug);

    let system = SYSTEM_BASE;
    if (contexto) {
      system += `\n\nContexto del establecimiento "${estabSlug}":
- Total de lotes sincronizados: ${contexto.lotes_count}
- Lotes disponibles: ${contexto.lotes.map(l => l.nombre + (l.tiene_sections ? " (con cobertura)" : "")).join(", ")}`;
    }

    // Armar historial de mensajes
    const messages = [
      ...historial.slice(-10).map(h => ({ role: h.rol, content: h.texto })),
      { role: "user", content: mensaje },
    ];

    const respuesta = await callClaude(system, messages, 600);
    res.json({ respuesta });
  } catch(e) {
    console.error("[agrarIA/chat]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/analizar-lote — análisis profundo de un lote AOG
// ══════════════════════════════════════════════════════════
router.post("/analizar-lote", async (req, res) => {
  const { lote_nombre } = req.body;
  if (!lote_nombre) return res.status(400).json({ error: "lote_nombre requerido" });

  try {
    const estabSlug = req.user?.estabSlug;
    const datos     = await getDatosLote(estabSlug, lote_nombre);
    if (!datos) return res.status(404).json({ error: "Lote no encontrado" });

    const prompt = `Analizá este lote de siembra:
Nombre: ${datos.nombre}
Establecimiento: ${estabSlug}
Tiene boundary (contorno): ${datos.tiene_boundary ? "Sí" : "No"}
Tiene origen GPS: ${datos.tiene_origen ? "Sí, en lat ${datos.origen?.lat?.toFixed(4)} lon ${datos.origen?.lon?.toFixed(4)}" : "No"}
Pasadas de siembra registradas: ${datos.pasadas}

Dá un análisis técnico del estado de la información sincronizada y qué se puede concluir de los datos disponibles. Si hay datos limitados, indicá qué información adicional sería útil.`;

    const analisis = await callClaude(SYSTEM_BASE, [{ role: "user", content: prompt }], 500);
    res.json({ analisis, datos });
  } catch(e) {
    console.error("[agrarIA/analizar-lote]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/analizar-vistax — análisis de lote VistaX
// ══════════════════════════════════════════════════════════
router.post("/analizar-vistax", async (req, res) => {
  const { lote_id } = req.body;
  if (!lote_id) return res.status(400).json({ error: "lote_id requerido" });

  try {
    const estabSlug = req.user?.estabSlug;
    const datos     = await getDatosVistaX(estabSlug, lote_id);
    if (!datos) return res.status(404).json({ error: "Lote VistaX no encontrado" });

    const durHs = datos.duracionMin ? (datos.duracionMin / 60).toFixed(1) : "desconocida";
    const semHa = datos.totalSemillas && datos.duracionMin
      ? Math.round(datos.totalSemillas / (datos.duracionMin / 60))
      : null;

    const prompt = `Analizá este lote de siembra con monitor VistaX:
Lote: ${datos.nombre || lote_id}
Cultivo: ${datos.cultivo || "no especificado"}
Semillas totales sembradas: ${datos.totalSemillas?.toLocaleString("es-AR") || "N/D"}
Duración de la siembra: ${durHs} horas
${datos.densidad_obj ? `Densidad objetivo: ${datos.densidad_obj} sem/ha` : ""}
${semHa ? `Ritmo aproximado: ${semHa} semillas por hora` : ""}

Evaluá el rendimiento de la siembra, si los datos son consistentes con una operación normal, y dá 2-3 recomendaciones concretas para el próximo lote.`;

    const analisis = await callClaude(SYSTEM_BASE, [{ role: "user", content: prompt }], 600);
    res.json({ analisis, datos });
  } catch(e) {
    console.error("[agrarIA/analizar-vistax]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/comparar-lotes — comparar dos lotes
// ══════════════════════════════════════════════════════════
router.post("/comparar-lotes", async (req, res) => {
  const { lote_a, lote_b } = req.body;
  if (!lote_a || !lote_b) return res.status(400).json({ error: "lote_a y lote_b requeridos" });

  try {
    const estabSlug = req.user?.estabSlug;
    const [datosA, datosB] = await Promise.all([
      getDatosLote(estabSlug, lote_a),
      getDatosLote(estabSlug, lote_b),
    ]);

    const prompt = `Comparé estos dos lotes de siembra:

LOTE A: ${lote_a}
- Pasadas registradas: ${datosA?.pasadas || 0}
- Tiene contorno: ${datosA?.tiene_boundary ? "Sí" : "No"}
- Tiene origen GPS: ${datosA?.tiene_origen ? "Sí" : "No"}

LOTE B: ${lote_b}
- Pasadas registradas: ${datosB?.pasadas || 0}
- Tiene contorno: ${datosB?.tiene_boundary ? "Sí" : "No"}
- Tiene origen GPS: ${datosB?.tiene_origen ? "Sí" : "No"}

Comparalos y decí cuál tiene mejor cobertura de datos y qué diferencias operativas se pueden inferir.`;

    const analisis = await callClaude(SYSTEM_BASE, [{ role: "user", content: prompt }], 500);
    res.json({ analisis, lote_a: datosA, lote_b: datosB });
  } catch(e) {
    console.error("[agrarIA/comparar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/resumen-dia — resumen del día de trabajo
// ══════════════════════════════════════════════════════════
router.post("/resumen-dia", async (req, res) => {
  try {
    const estabSlug = req.user?.estabSlug;
    if (!estabSlug) return res.status(400).json({ error: "Sin establecimiento activo" });

    const contexto = await getContextoEstab(estabSlug);
    const hoy      = new Date().toLocaleDateString("es-AR", { weekday:"long", day:"2-digit", month:"long" });

    // Buscar alertas activas
    let alertasCount = 0;
    try {
      const estabDB = db.getDB(estabSlug);
      const r = await estabDB.find({ selector: { tipo: "alerta", resuelta: { $ne: true } }, limit: 100 });
      alertasCount = r.docs.length;
    } catch {}

    const prompt = `Generá un resumen ejecutivo del día de trabajo ${hoy} para el establecimiento "${estabSlug}":
- Lotes sincronizados en total: ${contexto?.lotes_count || 0}
- Lotes con cobertura de siembra: ${contexto?.lotes.filter(l=>l.tiene_sections).length || 0}
- Alertas activas sin resolver: ${alertasCount}

El resumen debe ser útil para el dueño del campo al final del día. Máximo 4 oraciones.`;

    const resumen = await callClaude(SYSTEM_BASE, [{ role: "user", content: prompt }], 400);
    res.json({ resumen, fecha: hoy, alertas: alertasCount, lotes: contexto?.lotes_count || 0 });
  } catch(e) {
    console.error("[agrarIA/resumen-dia]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
