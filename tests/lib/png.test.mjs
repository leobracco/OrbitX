import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import png from "../../lib/png.js";

const { decodificarPNG, extraerCanal } = png;

// ── Codificador mínimo, solo para las fixtures ───────────────
const TABLA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLA[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length, 0);
  const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([largo, cuerpo, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Aplica el filtro hacia adelante (lo inverso de lo que hace el decoder).
function filtrar(tipo, fila, prev, bpp) {
  const out = Buffer.alloc(fila.length);
  for (let i = 0; i < fila.length; i++) {
    const a = i >= bpp ? fila[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    if (tipo === 0) v = fila[i];
    else if (tipo === 1) v = fila[i] - a;
    else if (tipo === 2) v = fila[i] - b;
    else if (tipo === 3) v = fila[i] - ((a + b) >> 1);
    else v = fila[i] - paeth(a, b, c);
    out[i] = v & 0xFF;
  }
  return out;
}

function armarPNG({ ancho, alto, colorType, canales, pixeles, filtros, bits = 8, entrelazado = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = bits; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = entrelazado;

  const paso = ancho * canales;
  const filas = [];
  let prev = Buffer.alloc(paso);
  for (let y = 0; y < alto; y++) {
    const fila = Buffer.from(pixeles.slice(y * paso, (y + 1) * paso));
    const t = filtros[y % filtros.length];
    filas.push(Buffer.concat([Buffer.from([t]), filtrar(t, fila, prev, canales)]));
    prev = fila;
  }
  const idat = zlib.deflateSync(Buffer.concat(filas));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Tests ────────────────────────────────────────────────────
test("gris 8 bits, filtro None: devuelve los píxeles tal cual", () => {
  const pixeles = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 10, 20, 30, 40]);
  const buf = armarPNG({ ancho: 4, alto: 3, colorType: 0, canales: 1, pixeles, filtros: [0] });
  const r = decodificarPNG(buf);
  assert.equal(r.ancho, 4);
  assert.equal(r.alto, 3);
  assert.equal(r.canales, 1);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

test("RGB 8 bits con los cinco filtros rotando por fila", () => {
  const ancho = 5, alto = 5, canales = 3;
  const pixeles = new Uint8Array(ancho * alto * canales);
  for (let i = 0; i < pixeles.length; i++) pixeles[i] = (i * 37) % 256;
  const buf = armarPNG({ ancho, alto, colorType: 2, canales, pixeles, filtros: [0, 1, 2, 3, 4] });
  const r = decodificarPNG(buf);
  assert.equal(r.canales, 3);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

test("gris + alfa (color type 4): el formato que devuelve Sentinel Hub con 2 bandas", () => {
  // [valor, dataMask] por píxel: 0 = sin dato.
  const pixeles = Uint8Array.from([100, 255, 0, 0, 200, 255, 150, 255]);
  const buf = armarPNG({ ancho: 2, alto: 2, colorType: 4, canales: 2, pixeles, filtros: [4] });
  const r = decodificarPNG(buf);
  assert.equal(r.canales, 2);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
  assert.deepEqual(Array.from(extraerCanal(r, 0)), [100, 0, 200, 150]);
  assert.deepEqual(Array.from(extraerCanal(r, 1)), [255, 0, 255, 255]);
});

test("RGBA (color type 6) con filtro Paeth", () => {
  const ancho = 3, alto = 2, canales = 4;
  const pixeles = new Uint8Array(ancho * alto * canales);
  for (let i = 0; i < pixeles.length; i++) pixeles[i] = (255 - i * 11) & 0xFF;
  const r = decodificarPNG(armarPNG({ ancho, alto, colorType: 6, canales, pixeles, filtros: [4] }));
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

test("falla ruidosamente ante lo que no soporta", () => {
  const base = { ancho: 2, alto: 1, colorType: 0, canales: 1, pixeles: Uint8Array.from([1, 2]), filtros: [0] };
  assert.throws(() => decodificarPNG(Buffer.from("no soy un png")), /firma/i);
  assert.throws(() => decodificarPNG(armarPNG({ ...base, bits: 16 })), /bit depth/i);
  assert.throws(() => decodificarPNG(armarPNG({ ...base, entrelazado: 1 })), /entrelazado/i);
  assert.throws(() => decodificarPNG(armarPNG({ ...base, colorType: 3 })), /color type/i);
});

test("extraerCanal fuera de rango tira", () => {
  const r = decodificarPNG(armarPNG({ ancho: 2, alto: 1, colorType: 0, canales: 1, pixeles: Uint8Array.from([7, 8]), filtros: [0] }));
  assert.throws(() => extraerCanal(r, 1), /canal/i);
});

// Copernicus/Sentinel Hub puede partir el stream deflate en varios chunks
// IDAT (según el buffer interno del encoder); el decoder tiene que
// concatenarlos antes de inflar, no tratar cada uno como un stream propio.
test("PNG con el IDAT partido en varios chunks se decodifica igual", () => {
  const ancho = 4, alto = 3, canales = 1;
  const pixeles = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 10, 20, 30, 40]);
  const paso = ancho * canales;
  const filas = [];
  let prev = Buffer.alloc(paso);
  for (let y = 0; y < alto; y++) {
    const fila = Buffer.from(pixeles.slice(y * paso, (y + 1) * paso));
    filas.push(Buffer.concat([Buffer.from([0]), fila])); // filtro None
    prev = fila;
  }
  const idatCompleto = zlib.deflateSync(Buffer.concat(filas));
  const mitad = Math.ceil(idatCompleto.length / 2);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idatCompleto.subarray(0, mitad)),
    chunk("IDAT", idatCompleto.subarray(mitad)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  const r = decodificarPNG(buf);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

// El inflate está topeado a alto * (1 + ancho * canales), que es el tamaño
// exacto de un PNG no entrelazado de 8 bits. Sin ese tope, un IDAT chico que
// infla a cientos de MB se descomprime entero antes de que el decoder pueda
// darse cuenta (en un droplet de 1 GB con ~25 apps eso es un OOM).
test("un IDAT que infla más de lo que el IHDR declara se corta", () => {
  const ancho = 8, alto = 8, canales = 1;
  const paso = ancho * canales;
  // Declaramos 8x8 (72 bytes inflados) pero mandamos un stream de 1 MB de ceros.
  const inflado = Buffer.alloc(1024 * 1024, 0);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(inflado)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

  assert.ok(inflado.length > alto * (1 + paso), "la fixture tiene que exceder el tope");
  assert.throws(() => decodificarPNG(buf));
});

// El PNG legítimo, que infla exactamente al tamaño declarado, tiene que pasar:
// un tope mal calculado (off-by-one en el byte de filtro por fila) rompería
// todos los rasters de Copernicus.
test("un PNG del tamaño exacto declarado no lo corta el tope del inflate", () => {
  const ancho = 37, alto = 19, canales = 2;   // impares a propósito
  const pixeles = new Uint8Array(ancho * alto * canales);
  for (let i = 0; i < pixeles.length; i++) pixeles[i] = (i * 13) % 256;
  const r = decodificarPNG(armarPNG({ ancho, alto, colorType: 4, canales, pixeles, filtros: [0, 1, 2, 3, 4] }));
  assert.equal(r.ancho, ancho);
  assert.equal(r.alto, alto);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});
