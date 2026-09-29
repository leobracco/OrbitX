// services/agromet.js — Informe AgroMet semanal del INTA (sale los miércoles).
// Es un PDF nacional de ~24 páginas sin datos estructurados: se baja una vez,
// agrarIA lo resume por provincia y el resultado queda en el doc global
// "agromet_<numero>". Cada org ve el resumen de las provincias de sus lotes.
// Las URLs del sitio cambiaron varias veces: siempre se parte del listado.
"use strict";

const db = require("./couchdb");

const URL_LISTADO = "https://www.argentina.gob.ar/informacion-agroclimatica/agromet-semanal";
const API         = "https://api.anthropic.com/v1/messages";
// Con solo el texto (~7-10k tokens) sale ~USD 0,04 por informe. Haiku cuesta
// la mitad pero resume más escueto; con el PDF entero llegó a invertir un dato.
const MODELO      = "claude-sonnet-5";
const MAX_PDF     = 40 * 1024 * 1024; // resguardo de RAM en el droplet (los informes pesan ~7 MB)

// Provincias agrícolas que se resumen siempre (un solo llamado por informe).
const PROVINCIAS = [
  "Buenos Aires", "Córdoba", "Santa Fe", "Entre Ríos", "La Pampa", "San Luis",
  "Santiago del Estero", "Chaco", "Salta", "Tucumán",
];

async function get(url, tipo = "text") {
  const r = await fetch(url, {
    headers: { "User-Agent": "OrbitX/1.0 (Agro Parallel)" },
    signal:  AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`AgroMet ${url.split("/").pop()}: HTTP ${r.status}`);
  return tipo === "buffer" ? Buffer.from(await r.arrayBuffer()) : r.text();
}

// [{ numero, fecha:"YYYY-MM-DD", url }] del más nuevo al más viejo.
async function listarInformes() {
  const html = await get(URL_LISTADO);
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>\s*Agromet\s+(\d{2})\/(\d{2})\/(\d{4})\s+N\.?\s*(\d+)/gi)) {
    out.push({ numero: parseInt(m[5], 10), fecha: `${m[4]}-${m[3]}-${m[2]}`, url: m[1] });
  }
  if (!out.length) throw new Error("AgroMet: el listado no trae informes (¿cambió la página?)");
  return out.sort((a, b) => b.numero - a.numero);
}

// La página del informe tiene el PDF; a veces el listado ya apunta al PDF.
async function urlPdf(inf) {
  if (/\.pdf$/i.test(inf.url)) return inf.url;
  const html = await get(inf.url);
  const m = /href="([^"]+\.pdf)"/i.exec(html);
  if (!m) throw new Error(`AgroMet N.${inf.numero}: la página no tiene PDF`);
  return m[1];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["general", "provincias"],
  properties: {
    general: { type: "string" },
    provincias: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["provincia", "puntos"],
        properties: {
          provincia: { type: "string" },
          puntos:    { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const SYSTEM = `Sos agrarIA, el asistente agronómico de OrbitX (Agro Parallel). Resumís el informe
AgroMet semanal del INTA para productores y contratistas. Español rioplatense, directo y práctico,
sin markdown. Usá solo lo que dice el informe: si una provincia no aparece o no hay nada relevante
para ella, devolvé sus puntos vacíos en vez de inventar.`;

// Solo el texto: mandado como PDF, cada página cuenta también como imagen
// (~45k tokens contra ~6k). Los mapas del informe están descriptos en el texto.
async function textoDePdf(buf) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  if (!text || text.length < 2000) throw new Error("AgroMet: el PDF no trae texto extraíble");
  return text;
}

async function resumir(texto, inf, modelo = MODELO) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY no configurada");

  const r = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         key,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model:      modelo,
      max_tokens: 8000,
      output_config: {
        ...(modelo.includes("haiku") ? {} : { effort: "low" }),
        format: { type: "json_schema", schema: SCHEMA },
      },
      system:     SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `<informe>\n${texto}\n</informe>` },
          { type: "text", text:
`Informe AgroMet N.${inf.numero} del ${inf.fecha}.
En "general": 2 o 3 oraciones con lo principal a nivel país (lluvias de la semana, agua en el suelo, temperaturas/heladas, perspectiva).
En "provincias": una entrada por cada una de estas provincias, en este orden: ${PROVINCIAS.join(", ")}.
Para cada una, 3 a 6 puntos cortos y concretos: lluvia observada, estado del agua en el suelo, heladas o calor, estado de cultivos y labores, y la perspectiva para los próximos días.` },
        ],
      }],
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`agrarIA ${r.status}: ${d.error?.message || "error"}`);
  if (d.stop_reason === "refusal") throw new Error("agrarIA rechazó el pedido");
  if (d.stop_reason === "max_tokens") throw new Error("agrarIA: respuesta cortada por max_tokens");
  const txt = (d.content || []).find(b => b.type === "text")?.text;
  if (!txt) throw new Error("agrarIA: respuesta sin texto");
  return { ...JSON.parse(txt), modelo: d.model, tokens: d.usage };
}

// Cron: si hay un informe nuevo, lo baja, lo resume y lo guarda. Idempotente.
async function sincronizar() {
  const [ultimo] = await listarInformes();
  const gdb = db.getDB("global");
  const id  = `agromet_${ultimo.numero}`;
  try { await gdb.get(id); return null; }       // ya procesado
  catch (e) { if (e.statusCode !== 404) throw e; }

  const pdfUrl = await urlPdf(ultimo);
  const pdf    = await get(pdfUrl, "buffer");
  if (pdf.length > MAX_PDF) throw new Error(`AgroMet N.${ultimo.numero}: PDF de ${Math.round(pdf.length / 1e6)} MB, supera el límite`);

  const resumen = await resumir(await textoDePdf(pdf), ultimo);
  const doc = {
    _id: id, tipo: "agromet",
    numero: ultimo.numero, fecha: ultimo.fecha, url: ultimo.url, pdf: pdfUrl,
    general: resumen.general,
    provincias: resumen.provincias,
    modelo: resumen.modelo,
    creado: Date.now(),
  };
  await gdb.insert(doc);
  console.log(`[AgroMet] ✓ N.${ultimo.numero} (${ultimo.fecha}) resumido · ${resumen.tokens?.input_tokens || "?"} tokens de entrada`);
  return doc;
}

async function ultimoResumen() {
  const r = await db.getDB("global").find({
    selector: { tipo: "agromet" }, sort: [{ numero: "desc" }], limit: 1,
  }).catch(async () => {
    // Sin índice por número: se trae todo (son pocos docs, uno por semana).
    const t = await db.getDB("global").find({ selector: { tipo: "agromet" }, limit: 200 });
    return { docs: t.docs.sort((a, b) => b.numero - a.numero) };
  });
  return r.docs[0] || null;
}

module.exports = { listarInformes, urlPdf, textoDePdf, resumir, sincronizar, ultimoResumen, PROVINCIAS };
