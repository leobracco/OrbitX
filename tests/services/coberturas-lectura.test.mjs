import { test } from "node:test";
import assert from "node:assert/strict";
import actividad from "../../services/actividad.js";
import parser from "../../services/aog_parser.js";

const { separarPorStats } = actividad;
const { parseLote, STATS_VER, calcularStats } = parser;

const BLOQUE = ["5", "0,200,0", "0,0,0", "20,0,0", "0,100,0", "20,100,0"].join("\r\n");

test("separarPorStats: separa los docs con stats vigentes de los que hay que calcular", () => {
  const docs = [
    { _id: "a", stats: { neto_ha: 1 }, stats_ver: STATS_VER, stats_hash: "h1", hash_md5: "h1" },
    { _id: "b", hash_md5: "h2" },                                                   // nunca calculado
    { _id: "c", stats: { neto_ha: 2 }, stats_ver: STATS_VER, stats_hash: "viejo", hash_md5: "nuevo" }, // desactualizado
    { _id: "d", stats: { neto_ha: 3 }, stats_ver: STATS_VER - 1, stats_hash: "h4", hash_md5: "h4" },   // version vieja
  ];
  const { listos, faltan } = separarPorStats(docs);
  assert.deepEqual(listos.map(d => d._id), ["a"]);
  assert.deepEqual(faltan.map(d => d._id), ["b", "c", "d"]);
});

test("separarPorStats: lista vacía no rompe", () => {
  const { listos, faltan } = separarPorStats([]);
  assert.deepEqual(listos, []);
  assert.deepEqual(faltan, []);
});

test("parseLote: usa las stats guardadas en el doc y no reparsea", () => {
  const guardadas = { trabajado_ha: 99, neto_ha: 98, repintado_ha: 1, repintado_pct: 1, bloques: 7, resolucion_m: 0.5 };
  const docs = [{
    lote_nombre: "cid 1", subtipo: "sections_coverage", ts: 10,
    contenido: BLOQUE, hash_md5: "h", stats_hash: "h", stats_ver: STATS_VER, stats: guardadas,
  }];
  const r = parseLote(docs);
  assert.equal(r.stats.trabajado_ha, 99);   // no es 0.2 → no reparseó
  assert.equal(r.stats.bloques, 7);
  assert.equal(r.stats.contorno_ha, 0);     // sin boundary, contorno 0
});

test("parseLote: si las stats no están vigentes, las recalcula del contenido", () => {
  const docs = [{
    lote_nombre: "cid 1", subtipo: "sections_coverage", ts: 10,
    contenido: BLOQUE, hash_md5: "nuevo", stats_hash: "viejo", stats_ver: STATS_VER,
    stats: { trabajado_ha: 99 },
  }];
  assert.equal(parseLote(docs).stats.trabajado_ha, calcularStats(BLOQUE, null).trabajado_ha);
});

test("parseLote: el contorno se calcula siempre del boundary, aunque las stats vengan del doc", () => {
  // Cuadrado de ~1 km de lado → ~100 ha de contorno. La longitud se corrige
  // por cos(lat) (mismo criterio que el test de contornoM2 en
  // aog_parser.test.mjs): sin la corrección el "cuadrado" en grados es en
  // realidad un rectángulo de ~82,6 ha, no ~100.
  const lat0 = -34.6, lon0 = -60.0, dLat = 0.009;
  const dLon = dLat / Math.cos((lat0 * Math.PI) / 180);
  const kml = `<coordinates>${[[lon0, lat0], [lon0, lat0 + dLat], [lon0 + dLon, lat0 + dLat], [lon0 + dLon, lat0], [lon0, lat0]]
    .map(([lo, la]) => `${lo},${la},0`).join(" ")}</coordinates>`;
  const docs = [
    { lote_nombre: "cid 1", subtipo: "boundary_kml", ts: 9, contenido: kml },
    { lote_nombre: "cid 1", subtipo: "sections_coverage", ts: 10, contenido: BLOQUE,
      hash_md5: "h", stats_hash: "h", stats_ver: STATS_VER,
      stats: { trabajado_ha: 5, neto_ha: 5, repintado_ha: 0, repintado_pct: 0, bloques: 1, resolucion_m: 0.5 } },
  ];
  const r = parseLote(docs);
  assert.equal(r.stats.trabajado_ha, 5);
  assert.ok(r.stats.contorno_ha > 95 && r.stats.contorno_ha < 105, `contorno_ha=${r.stats.contorno_ha}`);
});
