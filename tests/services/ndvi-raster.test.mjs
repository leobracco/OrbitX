// Tests puros de la matemática de grilla de services/ndvi_raster.js.
// No tocan red ni CouchDB: calcularGrilla / crsUtm / anilloParaSH son JS puro.
import { test } from "node:test";
import assert from "node:assert/strict";
import raster from "../../services/ndvi_raster.js";

const { calcularGrilla, boundsDeGrilla, pixelAUtm, crsUtm, anilloParaSH, valoresConMascara, MAX_PX, MIN_PX } = raster;

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

// El hallazgo C2: el bbox que se declara tiene que ser EL MISMO que el que
// Copernicus renderiza. Si el request y lo que se le pasa a zonificar difieren,
// las zonas salen escaladas y corridas sobre el lote.
test("boundsDeGrilla: el bbox del request es exactamente el bbox de la grilla", () => {
  const g = calcularGrilla(LOTE, 10);
  const b = boundsDeGrilla(g);
  assert.deepEqual(b.bbox, [g.bbox.minX, g.bbox.minY, g.bbox.maxX, g.bbox.maxY]);
  assert.equal(b.properties.crs, crsUtm(g.zona, g.sur));
  assert.equal(b.geometry.type, "Polygon");
  // La resolución que implica el par (bbox, ancho/alto) es la declarada.
  assert.ok(Math.abs((b.bbox[2] - b.bbox[0]) / g.ancho - g.mPx) < 1e-9);
  assert.ok(Math.abs((b.bbox[3] - b.bbox[1]) / g.alto  - g.mPx) < 1e-9);
});

test("calcularGrilla: el píxel (ancho-1, alto-1) cae a menos de 1 px del vértice máximo", () => {
  const g = calcularGrilla(LOTE, 10);
  const [x, y] = pixelAUtm(g, g.ancho - 1, g.alto - 1);
  // Esquina "última" del raster: máximo en X, mínimo en Y (la fila 0 es la del norte).
  assert.ok(Math.abs(x - g.lote.maxX) <= g.mPx, `x=${x} vs maxX=${g.lote.maxX} (mPx=${g.mPx})`);
  assert.ok(Math.abs(y - g.lote.minY) <= g.mPx, `y=${y} vs minY=${g.lote.minY} (mPx=${g.mPx})`);
  // Y el píxel (0,0) arranca en la esquina noroeste del bbox.
  const [x0, y0] = pixelAUtm(g, 0, 0);
  assert.ok(Math.abs(x0 - g.bbox.minX) <= g.mPx);
  assert.ok(Math.abs(y0 - g.bbox.maxY) <= g.mPx);
});

test("calcularGrilla: el bbox contiene a todos los vértices proyectados", () => {
  const g = calcularGrilla(LOTE, 10);
  for (const [x, y] of g.xy) {
    assert.ok(x >= g.bbox.minX - 1e-6 && x <= g.bbox.maxX + 1e-6, `x fuera del bbox: ${x}`);
    assert.ok(y >= g.bbox.minY - 1e-6 && y <= g.bbox.maxY + 1e-6, `y fuera del bbox: ${y}`);
  }
});

test("calcularGrilla: un lote chico se expande a MIN_PX centrado, no corrido", () => {
  // ~100 x 100 m: a 10 m/px son 10 px de lado, muy por debajo de MIN_PX=32.
  const chico = [
    [-33.9000, -60.6000],
    [-33.9000, -60.59892],
    [-33.90090, -60.59892],
    [-33.90090, -60.6000],
  ];
  const g = calcularGrilla(chico, 10);
  assert.equal(g.ancho, MIN_PX);
  assert.equal(g.alto, MIN_PX);
  // La ventana declarada mide 32 px * 10 m = 320 m, no los ~100 m del contorno.
  assert.ok(Math.abs((g.bbox.maxX - g.bbox.minX) - MIN_PX * g.mPx) < 1e-9);
  assert.ok(Math.abs((g.bbox.maxY - g.bbox.minY) - MIN_PX * g.mPx) < 1e-9);
  // Y el lote queda centrado: mismo margen de cada lado.
  assert.ok(Math.abs((g.lote.minX - g.bbox.minX) - (g.bbox.maxX - g.lote.maxX)) < 1e-6);
  assert.ok(Math.abs((g.lote.minY - g.bbox.minY) - (g.bbox.maxY - g.lote.maxY)) < 1e-6);
  // Y es el mismo bbox que viaja en el request.
  assert.deepEqual(boundsDeGrilla(g).bbox, [g.bbox.minX, g.bbox.minY, g.bbox.maxX, g.bbox.maxY]);
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

// ── Revisión final de la Pieza 1 ─────────────────────────────

// C3. El tope de píxeles bajó de 1024 a 512: con nubes moteadas, un raster de
// 1024x1024 llegaba a decenas de miles de anillos y más de 10 s de CPU
// sincrónica por prescripción. A 10 m/px, 512 px siguen cubriendo 5,1 km de
// lado; un lote más grande se pide a menos resolución, como siempre.
test("MAX_PX: a 10 m/px la ventana cubre más de 5 km de lado", () => {
  assert.equal(MAX_PX, 512);
  assert.ok(MAX_PX * 10 >= 5000, `${MAX_PX} px a 10 m/px cubren ${MAX_PX * 10} m`);
  // Un lote de 4 km entra entero sin aflojar la resolución.
  const cuatroKm = [
    [-33.9000, -60.6000],
    [-33.9000, -60.5570],
    [-33.9360, -60.5570],
    [-33.9360, -60.6000],
  ];
  const g = calcularGrilla(cuatroKm, 10);
  assert.equal(g.mPx, 10, `la resolución no debería aflojarse para 4 km (quedó en ${g.mPx})`);
  assert.ok(g.ancho <= MAX_PX && g.alto <= MAX_PX, `${g.ancho}x${g.alto}`);
});

// Minor: el hemisferio se tomaba del PRIMER vértice. Un contorno a caballo del
// ecuador salía proyectado con la falsa ordenada equivocada (10.000 km de
// error) y en silencio.
test("calcularGrilla: un contorno que cruza el ecuador es un error explícito", () => {
  const aCaballo = [
    [-0.01, -60.00],
    [-0.01, -59.99],
    [0.01, -59.99],
    [0.01, -60.00],
  ];
  assert.throws(() => calcularGrilla(aCaballo, 10), /ecuador/);
  // Los que no lo cruzan siguen andando, de los dos lados.
  assert.equal(calcularGrilla([[-0.02, -60], [-0.02, -59.99], [-0.01, -59.99], [-0.01, -60]], 10).sur, true);
  assert.equal(calcularGrilla([[0.01, -60], [0.01, -59.99], [0.02, -59.99], [0.02, -60]], 10).sur, false);
});

// I16. Un PNG RGB (3 canales) pasaba el filtro viejo (`canales < 2`) y terminaba
// usando el canal AZUL como máscara de dato válido: donde el azul diera 0 se
// tiraba dato bueno, y donde diera != 0 se tomaba por válido un píxel nublado.
test("valoresConMascara: solo acepta gris+alfa (2) o RGBA (4)", () => {
  const img = (canales, datos) => ({ ancho: datos.length / canales, alto: 1, canales, datos: Uint8Array.from(datos) });
  assert.throws(() => valoresConMascara(img(1, [10, 20])), /1 canal/);
  assert.throws(() => valoresConMascara(img(3, [10, 20, 0, 40, 50, 7])), /3 canal/);
  assert.throws(() => valoresConMascara(img(3, [10, 20, 0])), /gris\+alfa \(2\) o RGBA \(4\)/);
});

test("valoresConMascara: el valor sale del primer canal y la máscara del último", () => {
  // gris + alfa: el segundo píxel está enmascarado (alfa 0) → DN 0 = sin dato.
  const gris = { ancho: 3, alto: 1, canales: 2, datos: Uint8Array.from([100, 255, 200, 0, 150, 255]) };
  assert.deepEqual(Array.from(valoresConMascara(gris)), [100, 0, 150]);
  // RGBA: mismo criterio, el alfa es el canal 3 (no el azul, que acá vale 0).
  const rgba = { ancho: 2, alto: 1, canales: 4, datos: Uint8Array.from([120, 9, 0, 255, 200, 9, 0, 0]) };
  assert.deepEqual(Array.from(valoresConMascara(rgba)), [120, 0]);
});
