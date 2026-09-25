"use strict";
// png.js — Decoder PNG mínimo con zlib nativo. Existe para leer los rasters
// UINT8 que devuelve el Process API de Copernicus sin sumar dependencias
// (sharp trae libvips nativo; pngjs/jimp son deps nuevas para algo que zlib
// ya resuelve).
//
// Soporta lo único que puede llegar de Sentinel Hub: 8 bits por canal, sin
// entrelazado, color type 0 (gris), 2 (RGB), 4 (gris+alfa — el de 2 bandas
// que usamos) y 6 (RGBA). Cualquier otra cosa TIRA: una prescripción mal
// decodificada es peligrosa en el campo, un error no.
const zlib = require("zlib");

const FIRMA = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const CANALES_POR_TIPO = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Límite de tamaño razonable. `services/ndvi_raster.js` nunca pide más de
// MAX_PX x MAX_PX (512), así que 1024x1024 deja margen de sobra y acota el
// inflado a ~4 MB en el peor caso (RGBA). Con el tope viejo de 4096x4096 un
// PNG hostil podía inflar 64 MB ANTES de que nadie chequeara las dimensiones,
// y esto corre en un droplet de 1 GB con ~25 apps.
const MAX_PIXELES = 1024 * 1024;

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Invierte el filtro de una fila. `out` se escribe in-place y es el `prev` de
// la fila siguiente. `bpp` son los bytes por píxel completo (= canales, ya
// que solo soportamos 8 bits por muestra).
function desfiltrar(tipo, fila, out, prev, bpp) {
  for (let i = 0; i < fila.length; i++) {
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    switch (tipo) {
      case 0: v = fila[i]; break;                       // None
      case 1: v = fila[i] + a; break;                   // Sub
      case 2: v = fila[i] + b; break;                   // Up
      case 3: v = fila[i] + ((a + b) >> 1); break;      // Average
      case 4: v = fila[i] + paeth(a, b, c); break;      // Paeth
      default: throw new Error(`PNG inválido: tipo de filtro ${tipo}`);
    }
    out[i] = v & 0xFF;
  }
}

// `anchoEsperado` / `altoEsperado` (opcionales) se chequean contra el IHDR
// ANTES de inflar nada: quien pidió la imagen sabe de qué tamaño la pidió, y
// verificarlo después de descomprimir significa pagar los megabytes primero.
function decodificarPNG(buffer, { anchoEsperado = null, altoEsperado = null } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8) throw new Error("PNG inválido: buffer demasiado corto");
  for (let i = 0; i < 8; i++)
    if (buf[i] !== FIRMA[i]) throw new Error("PNG inválido: firma incorrecta");

  let pos = 8, ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const largo = buf.readUInt32BE(pos);
    // El largo declarado tiene que entrar en lo que queda del buffer. Sin este
    // chequeo, un largo inventado deja un `datos` más corto de lo que dice y el
    // readUInt32BE del IHDR tira un RangeError pelado en vez de "PNG inválido".
    if (largo > buf.length - pos - 12)
      throw new Error(`PNG inválido: el chunk declara ${largo} bytes y no entran en el buffer`);
    const tipo  = buf.toString("ascii", pos + 4, pos + 8);
    const datos = buf.subarray(pos + 8, pos + 8 + largo);
    // El CRC de cada chunk (los 4 bytes que saltamos con "+ 4" acá abajo) NO
    // se verifica: el origen es siempre nuestro propio fetch a Copernicus por
    // HTTPS, y si el chunk viniera corrupto igual falla más abajo (inflateSync
    // tira, o el largo de datos no cierra). Si algún día este decoder lee PNG
    // de una fuente no confiable, hay que sumar la verificación de CRC32.
    pos += 12 + largo;                        // largo(4) + tipo(4) + datos + crc(4)
    if (tipo === "IHDR") {
      if (largo < 13) throw new Error("PNG inválido: IHDR corto");
      ihdr = {
        ancho:       datos.readUInt32BE(0),
        alto:        datos.readUInt32BE(4),
        bits:        datos[8],
        colorType:   datos[9],
        compresion:  datos[10],
        filtro:      datos[11],
        entrelazado: datos[12],
      };
    } else if (tipo === "IDAT") {
      idat.push(Buffer.from(datos));
    } else if (tipo === "IEND") {
      break;
    }
  }

  if (!ihdr) throw new Error("PNG inválido: falta el chunk IHDR");
  if (ihdr.bits !== 8) throw new Error(`PNG no soportado: bit depth ${ihdr.bits} (solo 8)`);
  if (ihdr.entrelazado !== 0) throw new Error("PNG no soportado: entrelazado Adam7");
  if (ihdr.compresion !== 0 || ihdr.filtro !== 0) throw new Error("PNG no soportado: compresión o filtro no estándar");
  const canales = CANALES_POR_TIPO[ihdr.colorType];
  if (!canales) throw new Error(`PNG no soportado: color type ${ihdr.colorType} (0, 2, 4 o 6)`);
  if (!idat.length) throw new Error("PNG inválido: sin datos IDAT");
  if (!ihdr.ancho || !ihdr.alto) throw new Error("PNG inválido: dimensiones en cero");
  if (ihdr.ancho * ihdr.alto > MAX_PIXELES)
    throw new Error(`PNG demasiado grande: ${ihdr.ancho}x${ihdr.alto} supera el límite de ${MAX_PIXELES} píxeles`);
  if ((anchoEsperado != null && ihdr.ancho !== anchoEsperado) || (altoEsperado != null && ihdr.alto !== altoEsperado))
    throw new Error(`PNG de ${ihdr.ancho}x${ihdr.alto}: se esperaba ${anchoEsperado}x${altoEsperado}`);

  const { ancho, alto } = ihdr;
  const paso = ancho * canales;
  // Tope de salida del inflate: un PNG chico puede inflar a gigabytes (zip
  // bomb) y este proceso corre en un droplet de 1 GB. El tamaño exacto de un
  // PNG no entrelazado es alto * (1 byte de filtro + ancho * canales), así que
  // cualquier cosa por encima de eso ya es basura y conviene cortarla temprano.
  const crudo = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: alto * (1 + paso) });
  if (crudo.length < (paso + 1) * alto)
    throw new Error(`PNG inválido: IDAT incompleto (${crudo.length} bytes, se esperaban ${(paso + 1) * alto})`);

  const datos = new Uint8Array(paso * alto);
  let prev = new Uint8Array(paso);
  for (let y = 0; y < alto; y++) {
    const off  = y * (paso + 1);
    const fila = crudo.subarray(off + 1, off + 1 + paso);
    const out  = datos.subarray(y * paso, (y + 1) * paso);
    desfiltrar(crudo[off], fila, out, prev, canales);
    prev = out;
  }
  return { ancho, alto, canales, datos };
}

// Saca un plano de ancho*alto del entrelazado por píxel.
function extraerCanal(png, c) {
  if (!png || c < 0 || c >= png.canales) throw new Error(`canal ${c} fuera de rango (canales: ${png?.canales})`);
  const out = new Uint8Array(png.ancho * png.alto);
  for (let i = 0, j = c; i < out.length; i++, j += png.canales) out[i] = png.datos[j];
  return out;
}

module.exports = { decodificarPNG, extraerCanal };
