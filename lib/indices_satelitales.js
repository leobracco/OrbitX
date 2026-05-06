// lib/indices_satelitales.js — Catálogo de índices Sentinel-2 disponibles en OrbitX.
// Cada uno con su evalscript inline y leyenda de colores.
"use strict";

// Helper: paleta agronómica clásica rojo→amarillo→verde para vigor/clorofila.
const PALETA_AGRO = [
  { v: 0.0,  c: [0.40, 0.10, 0.10] }, // suelo / muerto
  { v: 0.2,  c: [0.75, 0.50, 0.10] },
  { v: 0.4,  c: [0.90, 0.85, 0.20] },
  { v: 0.6,  c: [0.55, 0.80, 0.25] },
  { v: 0.8,  c: [0.20, 0.55, 0.15] },
  { v: 1.0,  c: [0.05, 0.35, 0.05] },
];
const PALETA_AGUA = [
  { v: -0.5, c: [0.60, 0.30, 0.05] },
  { v: -0.1, c: [0.85, 0.65, 0.20] },
  { v:  0.1, c: [0.85, 0.85, 0.85] },
  { v:  0.3, c: [0.30, 0.65, 0.85] },
  { v:  0.6, c: [0.05, 0.30, 0.60] },
];
const PALETA_SUELO = [
  { v: -0.5, c: [0.10, 0.50, 0.10] },
  { v:  0.0, c: [0.85, 0.85, 0.50] },
  { v:  0.5, c: [0.65, 0.40, 0.15] },
  { v:  1.0, c: [0.40, 0.20, 0.05] },
];

// Cada índice tiene un campo `formula` con bandas + expresión numérica
// que se reusa para generar evalscripts de Statistical API automáticamente.
const INDICES = {
  ndvi: {
    nombre:      "NDVI",
    descripcion: "Vigor general (verdor de la vegetación)",
    bandas:      ["B04", "B08", "dataMask"],
    rango:       [-0.2, 1.0],
    formula:     { bandas: ["B04","B08"], expr: "(s.B08 - s.B04) / (s.B08 + s.B04)" },
    leyenda: [
      { rango: "< 0",     color: "#664019", desc: "Suelo / agua" },
      { rango: "0 – 0.2", color: "#bf8019", desc: "Muy bajo" },
      { rango: "0.2 – 0.4", color: "#e6d933", desc: "Bajo" },
      { rango: "0.4 – 0.6", color: "#8ccc40", desc: "Medio" },
      { rango: "0.6 – 0.8", color: "#338c26", desc: "Alto" },
      { rango: "> 0.8",   color: "#0d590d", desc: "Máximo" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B04","B08","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const v = (s.B08 - s.B04) / (s.B08 + s.B04);
  return color(v, s.dataMask);
}
function color(v, m) {
  if (v < 0.0)  return [0.40, 0.10, 0.10, m];
  if (v < 0.2)  return [0.75, 0.50, 0.10, m];
  if (v < 0.4)  return [0.90, 0.85, 0.20, m];
  if (v < 0.6)  return [0.55, 0.80, 0.25, m];
  if (v < 0.8)  return [0.20, 0.55, 0.15, m];
  return                [0.05, 0.35, 0.05, m];
}`,
  },

  ndre: {
    nombre:      "NDRE",
    descripcion: "Nitrógeno / clorofila profunda — para fertilización variable",
    bandas:      ["B05", "B08", "dataMask"],
    rango:       [-0.1, 0.6],
    formula:     { bandas: ["B05","B08"], expr: "(s.B08 - s.B05) / (s.B08 + s.B05)" },
    leyenda: [
      { rango: "< 0.1", color: "#664019", desc: "Sin / muy poco N" },
      { rango: "0.1 – 0.2", color: "#bf8019", desc: "Bajo" },
      { rango: "0.2 – 0.3", color: "#e6d933", desc: "Medio bajo" },
      { rango: "0.3 – 0.4", color: "#8ccc40", desc: "Medio" },
      { rango: "0.4 – 0.5", color: "#338c26", desc: "Alto" },
      { rango: "> 0.5",   color: "#0d590d", desc: "Muy alto" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B05","B08","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const v = (s.B08 - s.B05) / (s.B08 + s.B05);
  if (v < 0.1)  return [0.40, 0.10, 0.10, s.dataMask];
  if (v < 0.2)  return [0.75, 0.50, 0.10, s.dataMask];
  if (v < 0.3)  return [0.90, 0.85, 0.20, s.dataMask];
  if (v < 0.4)  return [0.55, 0.80, 0.25, s.dataMask];
  if (v < 0.5)  return [0.20, 0.55, 0.15, s.dataMask];
  return               [0.05, 0.35, 0.05, s.dataMask];
}`,
  },

  ndmi: {
    nombre:      "NDMI",
    descripcion: "Humedad foliar — detecta estrés hídrico",
    bandas:      ["B08", "B11", "dataMask"],
    rango:       [-0.5, 0.6],
    formula:     { bandas: ["B08","B11"], expr: "(s.B08 - s.B11) / (s.B08 + s.B11)" },
    leyenda: [
      { rango: "< -0.2", color: "#995219", desc: "Estrés severo" },
      { rango: "-0.2 – 0.0", color: "#d9a64d", desc: "Estrés moderado" },
      { rango: "0.0 – 0.2", color: "#e6e6e6", desc: "Sin estrés" },
      { rango: "0.2 – 0.4", color: "#4d99d9", desc: "Buena humedad" },
      { rango: "> 0.4",   color: "#0d3a99", desc: "Muy húmedo" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B08","B11","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const v = (s.B08 - s.B11) / (s.B08 + s.B11);
  if (v < -0.2) return [0.60, 0.30, 0.05, s.dataMask];
  if (v <  0.0) return [0.85, 0.65, 0.20, s.dataMask];
  if (v <  0.2) return [0.90, 0.90, 0.90, s.dataMask];
  if (v <  0.4) return [0.30, 0.65, 0.85, s.dataMask];
  return              [0.05, 0.30, 0.60, s.dataMask];
}`,
  },

  evi: {
    nombre:      "EVI",
    descripcion: "Vigor sin saturar — para cultivos densos (maíz V12+, soja R5+)",
    bandas:      ["B02", "B04", "B08", "dataMask"],
    rango:       [-0.2, 1.0],
    formula:     { bandas: ["B02","B04","B08"], expr: "2.5 * (s.B08 - s.B04) / (s.B08 + 6 * s.B04 - 7.5 * s.B02 + 1)" },
    leyenda: [
      { rango: "< 0.2", color: "#664019", desc: "Bajo / suelo" },
      { rango: "0.2 – 0.4", color: "#e6d933", desc: "Medio bajo" },
      { rango: "0.4 – 0.6", color: "#8ccc40", desc: "Medio" },
      { rango: "0.6 – 0.8", color: "#338c26", desc: "Alto" },
      { rango: "> 0.8",   color: "#0d590d", desc: "Muy alto" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B02","B04","B08","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const v = 2.5 * (s.B08 - s.B04) / (s.B08 + 6 * s.B04 - 7.5 * s.B02 + 1);
  if (v < 0.2)  return [0.40, 0.10, 0.10, s.dataMask];
  if (v < 0.4)  return [0.90, 0.85, 0.20, s.dataMask];
  if (v < 0.6)  return [0.55, 0.80, 0.25, s.dataMask];
  if (v < 0.8)  return [0.20, 0.55, 0.15, s.dataMask];
  return               [0.05, 0.35, 0.05, s.dataMask];
}`,
  },

  msavi: {
    nombre:      "MSAVI",
    descripcion: "Vigor sin efecto del suelo — para cultivos chicos (V1-V4)",
    bandas:      ["B04", "B08", "dataMask"],
    rango:       [-0.2, 1.0],
    formula:     { bandas: ["B04","B08"], expr: "(2 * s.B08 + 1 - Math.sqrt((2*s.B08+1)*(2*s.B08+1) - 8*(s.B08-s.B04))) / 2" },
    leyenda: [
      { rango: "< 0.2", color: "#664019", desc: "Suelo dominante" },
      { rango: "0.2 – 0.4", color: "#e6d933", desc: "Cultivo emergiendo" },
      { rango: "0.4 – 0.6", color: "#8ccc40", desc: "Establecido" },
      { rango: "0.6 – 0.8", color: "#338c26", desc: "Buen vigor" },
      { rango: "> 0.8",   color: "#0d590d", desc: "Vigor pleno" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B04","B08","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const a = 2 * s.B08 + 1;
  const v = (a - Math.sqrt(a * a - 8 * (s.B08 - s.B04))) / 2;
  if (v < 0.2)  return [0.40, 0.10, 0.10, s.dataMask];
  if (v < 0.4)  return [0.90, 0.85, 0.20, s.dataMask];
  if (v < 0.6)  return [0.55, 0.80, 0.25, s.dataMask];
  if (v < 0.8)  return [0.20, 0.55, 0.15, s.dataMask];
  return               [0.05, 0.35, 0.05, s.dataMask];
}`,
  },

  gndvi: {
    nombre:      "GNDVI",
    descripcion: "Clorofila / verde — más sensible que NDVI a estrés temprano",
    bandas:      ["B03", "B08", "dataMask"],
    rango:       [-0.2, 1.0],
    formula:     { bandas: ["B03","B08"], expr: "(s.B08 - s.B03) / (s.B08 + s.B03)" },
    leyenda: [
      { rango: "< 0.2", color: "#664019", desc: "Bajo" },
      { rango: "0.2 – 0.4", color: "#e6d933", desc: "Medio bajo" },
      { rango: "0.4 – 0.6", color: "#8ccc40", desc: "Medio" },
      { rango: "0.6 – 0.8", color: "#338c26", desc: "Alto" },
      { rango: "> 0.8",   color: "#0d590d", desc: "Muy alto" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B03","B08","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const v = (s.B08 - s.B03) / (s.B08 + s.B03);
  if (v < 0.2)  return [0.40, 0.10, 0.10, s.dataMask];
  if (v < 0.4)  return [0.90, 0.85, 0.20, s.dataMask];
  if (v < 0.6)  return [0.55, 0.80, 0.25, s.dataMask];
  if (v < 0.8)  return [0.20, 0.55, 0.15, s.dataMask];
  return               [0.05, 0.35, 0.05, s.dataMask];
}`,
  },

  bsi: {
    nombre:      "BSI",
    descripcion: "Suelo desnudo — cobertura post-cosecha o fallas de implantación",
    bandas:      ["B02", "B04", "B08", "B11", "dataMask"],
    rango:       [-1.0, 1.0],
    formula:     { bandas: ["B02","B04","B08","B11"], expr: "((s.B11 + s.B04) - (s.B08 + s.B02)) / ((s.B11 + s.B04) + (s.B08 + s.B02))" },
    leyenda: [
      { rango: "< -0.2", color: "#0d590d", desc: "Cobertura plena" },
      { rango: "-0.2 – 0.0", color: "#8ccc40", desc: "Mucho verde" },
      { rango: "0.0 – 0.2", color: "#e6d933", desc: "Mixto" },
      { rango: "0.2 – 0.4", color: "#bf8019", desc: "Suelo dominante" },
      { rango: "> 0.4",   color: "#664019", desc: "Suelo desnudo" },
    ],
    evalscript: `//VERSION=3
function setup() { return { input: ["B02","B04","B08","B11","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const v = ((s.B11 + s.B04) - (s.B08 + s.B02)) / ((s.B11 + s.B04) + (s.B08 + s.B02));
  if (v < -0.2) return [0.05, 0.35, 0.05, s.dataMask];
  if (v <  0.0) return [0.55, 0.80, 0.25, s.dataMask];
  if (v <  0.2) return [0.90, 0.85, 0.20, s.dataMask];
  if (v <  0.4) return [0.75, 0.50, 0.10, s.dataMask];
  return              [0.40, 0.20, 0.05, s.dataMask];
}`,
  },
};

// Sumario para enviar al frontend (sin el evalscript pesado).
function catalogo() {
  return Object.entries(INDICES).map(([clave, i]) => ({
    clave,
    nombre:      i.nombre,
    descripcion: i.descripcion,
    bandas:      i.bandas,
    rango:       i.rango,
    leyenda:     i.leyenda,
  }));
}

function getEvalscript(clave) {
  const i = INDICES[clave];
  if (!i) throw Object.assign(new Error(`Índice desconocido: ${clave}`), { status: 400 });
  return i.evalscript;
}

// Genera evalscript para Statistical API a partir de la fórmula numérica.
// Formato canónico SH: output "data" con band nombrado + output "dataMask".
function getEvalscriptStats(clave) {
  const i = INDICES[clave];
  if (!i || !i.formula) throw Object.assign(new Error(`Índice sin formula stats: ${clave}`), { status: 400 });
  const bandas = [...i.formula.bandas, "dataMask"];
  return `//VERSION=3
function setup() {
  return {
    input:  [{ bands: [${bandas.map(b => `"${b}"`).join(",")}] }],
    output: [
      { id: "data",     bands: ["${clave}"], sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  return {
    data:     [${i.formula.expr}],
    dataMask: [s.dataMask]
  };
}`;
}

module.exports = { INDICES, catalogo, getEvalscript, getEvalscriptStats };
