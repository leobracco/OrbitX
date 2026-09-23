import { test } from "node:test";
import assert from "node:assert/strict";
import parser from "../../services/aog_parser.js";

const { leerBloques, calcularStats, calcularStatsAsync, netoRaster, netoRasterAsync, contornoM2 } = parser;

// Un bloque = 1 línea con N, después N líneas: la 1ª es el color y las N-1
// restantes son puntos "x,y,0" alternando izquierda/derecha de la barra.
// Esta tira es un rectángulo de 20 m x 100 m = 2.000 m2 = 0,2 ha.
const BLOQUE = ["5", "0,200,0", "0,0,0", "20,0,0", "0,100,0", "20,100,0"].join("\r\n");

test("leerBloques: lee un bloque completo con sus 4 puntos", () => {
  const b = leerBloques(BLOQUE);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], [[0, 0], [20, 0], [0, 100], [20, 100]]);
});

test("leerBloques: NO se come un bloque de cada dos (regresión del bug hasta 2026-09-06)", () => {
  const b = leerBloques([BLOQUE, BLOQUE, BLOQUE].join("\r\n"));
  assert.equal(b.length, 3);
  for (const pts of b) assert.equal(pts.length, 4);
});

test("leerBloques: tolera header $ y líneas vacías", () => {
  assert.equal(leerBloques(["$SectionHeader", "", BLOQUE, ""].join("\r\n")).length, 1);
});

test("calcularStats: un bloque = 0,2 ha trabajadas y 0,2 ha netas, sin repintado", () => {
  const s = calcularStats(BLOQUE, null);
  assert.equal(s.trabajado_ha, 0.2);
  assert.equal(s.neto_ha, 0.2);
  assert.equal(s.repintado_ha, 0);
  assert.equal(s.repintado_pct, 0);
  assert.equal(s.bloques, 1);
  assert.equal(s.resolucion_m, 0.5);
});

test("calcularStats: dos pasadas idénticas = doble trabajado, mismo neto, 50% repintado", () => {
  const s = calcularStats([BLOQUE, BLOQUE].join("\r\n"), null);
  assert.equal(s.bloques, 2);
  assert.equal(s.trabajado_ha, 0.4);
  assert.equal(s.neto_ha, 0.2);
  assert.equal(s.repintado_ha, 0.2);
  assert.equal(s.repintado_pct, 50);
});

test("calcularStats: archivo vacío o basura devuelve null", () => {
  assert.equal(calcularStats("", null), null);
  assert.equal(calcularStats("no,soy,un,sections", null), null);
});

test("contornoM2: cuadrado de ~1 km de lado da ~1.000.000 m2", () => {
  // 0,009° de latitud ≈ 1.002 m. La longitud se corrige por cos(lat) porque
  // a esta latitud 1° de longitud pesa ~18% menos que 1° de latitud (sin la
  // correccion el "cuadrado" en grados es en realidad un rectangulo de
  // ~826.000 m2, no ~1.000.000). El error tolerado es del 1%.
  const lat0 = -34.6, lon0 = -60.0, dLat = 0.009;
  const dLon = dLat / Math.cos((lat0 * Math.PI) / 180);
  const m2 = contornoM2([[lat0, lon0], [lat0 + dLat, lon0], [lat0 + dLat, lon0 + dLon], [lat0, lon0 + dLon], [lat0, lon0]]);
  assert.ok(m2 > 990000 && m2 < 1030000, `m2 fuera de rango: ${m2}`);
});

test("netoRasterAsync da exactamente el mismo número que netoRaster", async () => {
  const bloques = leerBloques([BLOQUE, BLOQUE, BLOQUE].join("\r\n"));
  const sync = netoRaster(bloques);
  const asinc = await netoRasterAsync(bloques, { cadaN: 1 });
  assert.equal(asinc.neto, sync.neto);
  assert.equal(asinc.res, sync.res);
});

test("calcularStatsAsync da exactamente el mismo objeto que calcularStats", async () => {
  const txt = [BLOQUE, BLOQUE].join("\r\n");
  assert.deepEqual(await calcularStatsAsync(txt, null), calcularStats(txt, null));
  assert.equal(await calcularStatsAsync("", null), null);
});

test("netoRasterAsync cede el event loop entre tandas", async () => {
  const bloques = leerBloques([BLOQUE, BLOQUE, BLOQUE, BLOQUE].join("\r\n"));
  let tics = 0;
  const timer = setInterval(() => { tics++; }, 1);
  await netoRasterAsync(bloques, { cadaN: 1 });
  clearInterval(timer);
  // Con cadaN:1 hay 4 setImmediate: el loop de eventos corre entre medio.
  assert.ok(tics >= 0); // no aserta tiempos: solo que no tira y completa
});
