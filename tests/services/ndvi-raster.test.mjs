// Tests puros de la matemática de grilla de services/ndvi_raster.js.
// No tocan red ni CouchDB: calcularGrilla / crsUtm / anilloParaSH son JS puro.
import { test } from "node:test";
import assert from "node:assert/strict";
import raster from "../../services/ndvi_raster.js";

const { calcularGrilla, crsUtm, anilloParaSH, MAX_PX } = raster;

// Lote rectangular de ~1010 x 620 m cerca de Pergamino (zona UTM 20 sur).
const LOTE = [
  [-33.9000, -60.6000],
  [-33.9000, -60.5892],
  [-33.9054, -60.5892],
  [-33.9054, -60.6000],
];

test("calcularGrilla: zona UTM y hemisferio del lote", () => {
  const g = calcularGrilla(LOTE, 10);
  assert.equal(g.zona, 20);
  assert.equal(g.sur, true);
});

test("calcularGrilla: a 10 m/px el bbox mide ancho*10 x alto*10 metros", () => {
  const g = calcularGrilla(LOTE, 10);
  assert.equal(g.mPx, 10);
  // ~1010 x 620 m del contorno de arriba.
  assert.ok(g.ancho >= 99 && g.ancho <= 103, `ancho inesperado: ${g.ancho}`);
  assert.ok(g.alto >= 60 && g.alto <= 64, `alto inesperado: ${g.alto}`);
  // El bbox se reajusta al tamaño final: píxeles exactamente cuadrados.
  assert.equal(Math.round(g.bbox.maxX - g.bbox.minX), g.ancho * g.mPx);
  assert.equal(Math.round(g.bbox.maxY - g.bbox.minY), g.alto * g.mPx);
});

test("calcularGrilla: un lote enorme se recorta al tope de píxeles bajando la resolución", () => {
  // ~55 km de lado: a 10 m/px serían 5500 px, muy por encima de MAX_PX.
  const gigante = [
    [-33.50, -61.00],
    [-33.50, -60.40],
    [-34.00, -60.40],
    [-34.00, -61.00],
  ];
  const g = calcularGrilla(gigante, 10);
  assert.ok(g.ancho <= MAX_PX && g.alto <= MAX_PX, `${g.ancho}x${g.alto} supera ${MAX_PX}`);
  assert.ok(g.mPx > 10, `la resolución debería aflojarse, quedó en ${g.mPx}`);
  assert.equal(Math.max(g.ancho, g.alto), MAX_PX);
});

test("calcularGrilla: el bbox contiene a todos los vértices proyectados", () => {
  const g = calcularGrilla(LOTE, 10);
  for (const [x, y] of g.xy) {
    assert.ok(x >= g.bbox.minX - 1e-6 && x <= g.bbox.maxX + 1e-6, `x fuera del bbox: ${x}`);
    assert.ok(y >= g.bbox.minY - 1e-6 && y <= g.bbox.maxY + 1e-6, `y fuera del bbox: ${y}`);
  }
});

test("crsUtm: EPSG 327XX al sur y 326XX al norte", () => {
  assert.equal(crsUtm(20, true), "http://www.opengis.net/def/crs/EPSG/0/32720");
  assert.equal(crsUtm(21, true), "http://www.opengis.net/def/crs/EPSG/0/32721");
  assert.equal(crsUtm(20, false), "http://www.opengis.net/def/crs/EPSG/0/32620");
  // La zona de un dígito se rellena con cero.
  assert.equal(crsUtm(7, true), "http://www.opengis.net/def/crs/EPSG/0/32707");
});

test("anilloParaSH: cierra el anillo y lo deja antihorario", () => {
  // Horario y abierto.
  const horario = [[0, 0], [0, 10], [10, 10], [10, 0]];
  const r = anilloParaSH(horario);
  assert.deepEqual(r[0], r[r.length - 1], "el anillo tiene que cerrar");
  let acc = 0;
  for (let i = 0; i < r.length - 1; i++) acc += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  assert.ok(acc > 0, "debería quedar antihorario (área firmada positiva)");
});

test("anilloParaSH: un anillo ya antihorario y cerrado no se altera", () => {
  const ccw = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  assert.deepEqual(anilloParaSH(ccw), ccw);
});
