// routes/agraria_chat.js — agrarIA con contexto real + soporte de adjuntos
const router = require("express").Router();
const db     = require("../services/couchdb");

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL   = "claude-sonnet-4-20250514";

const SYSTEM_BASE = `Sos agrarIA, el asistente agronómico de OrbitX de Agro Parallel.
Respondés en español rioplatense. Tono directo, práctico y técnico pero accesible para productores y maquinistas.
Cuando analizás datos de siembra, sos preciso con los números y das recomendaciones concretas.
Cuando te mandan fotos del campo, cultivos, maquinaria o documentos, los analizás en detalle.
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

// ── Armar bloque de contenido para adjunto ────────────────
function adjuntoABloque(adj) {
  const { categoria, mediaType, base64, nombre } = adj;

  if (categoria === "imagen") {
    // Tipos soportados por Claude: jpeg, png, gif, webp
    const tipoImagen = mediaType.includes("png")  ? "image/png"
                     : mediaType.includes("gif")  ? "image/gif"
                     : mediaType.includes("webp") ? "image/webp"
                     : "image/jpeg";
    return {
      type:   "image",
      source: { type: "base64", media_type: tipoImagen, data: base64 },
    };
  }

  if (categoria === "pdf") {
    return {
      type:   "document",
      source: { type: "base64", media_type: "application/pdf", data: base64 },
      title:  nombre,
    };
  }

  if (categoria === "audio") {
    // Claude no procesa audio nativo — lo indicamos como contexto en texto
    return null; // se maneja aparte como texto
  }

  return null;
}

// ── Helpers de contexto ───────────────────────────────────
async function getContextoEstab(estabSlug) {
  if (!estabSlug || estabSlug === "null") return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector: { tipo:"aog_archivo", es_lote:true }, limit:500 });
      docs = r.docs;
    } catch {
      const all = await estabDB.list({ include_docs:true });
      docs = all.rows.map(r=>r.doc).filter(d=>d.tipo==="aog_archivo"&&d.es_lote);
    }
    const lotes = {};
    docs.forEach(d => {
      const n = d.lote_nombre || "?";
      if (!lotes[n]) lotes[n] = { nombre:n, archivos:[] };
      lotes[n].archivos.push(d.subtipo);
    });
    return {
      estab:       estabSlug,
      lotes_count: Object.keys(lotes).length,
      lotes:       Object.values(lotes).map(l => ({
        nombre:         l.nombre,
        tiene_sections: l.archivos.includes("sections_coverage"),
        tiene_boundary: l.archivos.includes("boundary")||l.archivos.includes("boundary_kml"),
        tiene_field:    l.archivos.includes("field_origin"),
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
      const r = await estabDB.find({ selector:{ tipo:"aog_archivo", es_lote:true, lote_nombre:loteNombre }, limit:20 });
      docs = r.docs;
    } catch {}
    const { parseLote } = require("../services/aog_parser");
    const parsed = parseLote(docs);
    return {
      nombre:         loteNombre,
      tiene_boundary: !!parsed.boundary,
      tiene_origen:   !!parsed.origen,
      pasadas:        parsed.sections?.length || 0,
      origen:         parsed.origen,
    };
  } catch { return null; }
}

async function getDatosVistaX(estabSlug, loteId) {
  if (!estabSlug || !loteId) return null;
  try {
    const estabDB = db.getDB(estabSlug);
    let docs = [];
    try {
      const r = await estabDB.find({ selector:{ tipo:"vistax_archivo", lote_id:loteId }, limit:10 });
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
    };
  } catch { return null; }
}

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/chat
//  Soporta adjuntos: imágenes (base64), PDFs, audio (texto)
// ══════════════════════════════════════════════════════════
router.post("/chat", async (req, res) => {
  const { mensaje = "", historial = [], adjuntos = [] } = req.body;

  if (!mensaje && !adjuntos.length)
    return res.status(400).json({ error: "mensaje o adjunto requerido" });

  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    const contexto  = await getContextoEstab(estabSlug);

    let system = SYSTEM_BASE;
    if (contexto) {
      system += `\n\nContexto del establecimiento "${estabSlug}":
- Lotes sincronizados: ${contexto.lotes_count}
- Lotes: ${contexto.lotes.map(l => l.nombre + (l.tiene_sections ? " (con cobertura)" : "")).join(", ")}`;
    }

    // ── Armar historial de mensajes ──
    const messages = [
      ...historial.slice(-10).map(h => ({
        role:    h.rol,
        content: h.texto,
      })),
    ];

    // ── Mensaje actual con adjuntos ──
    const contentBlocks = [];

    // Procesar adjuntos
    const audiosTexto = [];
    for (const adj of adjuntos) {
      if (adj.categoria === "audio") {
        audiosTexto.push(adj.nombre);
        continue;
      }
      const bloque = adjuntoABloque(adj);
      if (bloque) contentBlocks.push(bloque);
    }

    // Texto del mensaje
    let textoFinal = mensaje || "";
    if (audiosTexto.length) {
      textoFinal += textoFinal ? "\n\n" : "";
      textoFinal += `[El usuario adjuntó ${audiosTexto.length > 1 ? "audios" : "un audio"}: ${audiosTexto.join(", ")}. Indicale que por ahora solo podés procesar imágenes y PDFs, y que para audio puede transcribir y pegarte el texto.]`;
    }

    if (textoFinal) contentBlocks.push({ type: "text", text: textoFinal });

    // Si no hay texto pero sí imagen, agregar prompt implícito
    if (!textoFinal && contentBlocks.length) {
      contentBlocks.push({
        type: "text",
        text: "Analizá lo que te mandé y dá tu opinión agronómica."
      });
    }

    messages.push({
      role:    "user",
      content: contentBlocks.length === 1 && contentBlocks[0].type === "text"
        ? contentBlocks[0].text   // mensaje simple sin adjuntos → string (más eficiente)
        : contentBlocks,
    });

    const respuesta = await callClaude(system, messages, 800);
    res.json({ respuesta });

  } catch(e) {
    console.error("[agrarIA/chat]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/analizar-lote
// ══════════════════════════════════════════════════════════
router.post("/analizar-lote", async (req, res) => {
  const { lote_nombre } = req.body;
  if (!lote_nombre) return res.status(400).json({ error: "lote_nombre requerido" });
  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    const datos     = await getDatosLote(estabSlug, lote_nombre);
    if (!datos) return res.status(404).json({ error: "Lote no encontrado" });
    const prompt = `Analizá este lote de siembra:
Nombre: ${datos.nombre}
Establecimiento: ${estabSlug}
Tiene boundary: ${datos.tiene_boundary ? "Sí" : "No"}
Tiene origen GPS: ${datos.tiene_origen ? "Sí" : "No"}
Pasadas registradas: ${datos.pasadas}
Dá un análisis técnico del estado de la información sincronizada.`;
    const analisis = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 500);
    res.json({ analisis, datos });
  } catch(e) {
    console.error("[agrarIA/analizar-lote]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/analizar-vistax
// ══════════════════════════════════════════════════════════
router.post("/analizar-vistax", async (req, res) => {
  const { lote_id } = req.body;
  if (!lote_id) return res.status(400).json({ error: "lote_id requerido" });
  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    const datos     = await getDatosVistaX(estabSlug, lote_id);
    if (!datos) return res.status(404).json({ error: "Lote VistaX no encontrado" });
    const durHs = datos.duracionMin ? (datos.duracionMin/60).toFixed(1) : "desconocida";
    const prompt = `Analizá este lote con monitor VistaX:
Lote: ${datos.nombre||lote_id}
Cultivo: ${datos.cultivo||"no especificado"}
Semillas totales: ${datos.totalSemillas?.toLocaleString("es-AR")||"N/D"}
Duración: ${durHs} horas
${datos.densidad_obj?`Densidad objetivo: ${datos.densidad_obj} sem/ha`:""}
Evaluá el rendimiento y dá 2-3 recomendaciones.`;
    const analisis = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 600);
    res.json({ analisis, datos });
  } catch(e) {
    console.error("[agrarIA/analizar-vistax]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/comparar-lotes
// ══════════════════════════════════════════════════════════
router.post("/comparar-lotes", async (req, res) => {
  const { lote_a, lote_b } = req.body;
  if (!lote_a || !lote_b) return res.status(400).json({ error: "lote_a y lote_b requeridos" });
  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    const [datosA, datosB] = await Promise.all([
      getDatosLote(estabSlug, lote_a),
      getDatosLote(estabSlug, lote_b),
    ]);
    const prompt = `Comparé estos dos lotes:
LOTE A: ${lote_a} — pasadas: ${datosA?.pasadas||0}, boundary: ${datosA?.tiene_boundary?"Sí":"No"}, GPS: ${datosA?.tiene_origen?"Sí":"No"}
LOTE B: ${lote_b} — pasadas: ${datosB?.pasadas||0}, boundary: ${datosB?.tiene_boundary?"Sí":"No"}, GPS: ${datosB?.tiene_origen?"Sí":"No"}
Decí cuál tiene mejor cobertura de datos y qué diferencias operativas se pueden inferir.`;
    const analisis = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 500);
    res.json({ analisis, lote_a: datosA, lote_b: datosB });
  } catch(e) {
    console.error("[agrarIA/comparar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /api/agraria/resumen-dia
// ══════════════════════════════════════════════════════════
router.post("/resumen-dia", async (req, res) => {
  try {
    const estabSlug = req.user?.estabSlug || req.jwtUser?.estabSlug;
    if (!estabSlug) return res.status(400).json({ error: "Sin establecimiento activo" });
    const contexto = await getContextoEstab(estabSlug);
    const hoy      = new Date().toLocaleDateString("es-AR", { weekday:"long", day:"2-digit", month:"long" });
    let alertasCount = 0;
    try {
      const estabDB = db.getDB(estabSlug);
      const r = await estabDB.find({ selector:{ tipo:"alerta", resuelta:{ $ne:true } }, limit:100 });
      alertasCount = r.docs.length;
    } catch {}
    const prompt = `Resumen del día ${hoy} para "${estabSlug}":
- Lotes sincronizados: ${contexto?.lotes_count||0}
- Con cobertura: ${contexto?.lotes.filter(l=>l.tiene_sections).length||0}
- Alertas activas: ${alertasCount}
Máximo 4 oraciones, útil para el dueño del campo.`;
    const resumen = await callClaude(SYSTEM_BASE, [{ role:"user", content:prompt }], 400);
    res.json({ resumen, fecha:hoy, alertas:alertasCount, lotes:contexto?.lotes_count||0 });
  } catch(e) {
    console.error("[agrarIA/resumen-dia]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
