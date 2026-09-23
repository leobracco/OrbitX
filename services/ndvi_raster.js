"use strict";
// ndvi_raster.js — Del boundary de un lote a una grilla de valores del índice,
// en metros UTM. Es el puente entre Copernicus y lib/zonificar.js.
const db = require("./couchdb");
const { decodificarPNG, extraerCanal } = require("../lib/png");
const { zonaUtmPorLon, latLonAUtm } = require("../lib/zonificar");
const indices = require("../lib/indices_satelitales");
const { parseKML, parseBoundaryTxt, parseFieldTxt } = require("./aog_parser");

// Tope duro: 1024x1024 = 1 M de píxeles ≈ 1 MB de grilla + el PNG inflado.
// A 10 m/px cubre 10 km de lado, de sobra para cualquier lote, y en un droplet
// de 1 GB con ~25 apps no hay lugar para más.
const MAX_PX = 1024;
const MIN_PX = 32;

// El nombre del lote entra en selectores Mango: lo acotamos a texto corto para
// que no llegue un objeto (`{$gt:null}` y amigos) ni una cadena de 1 MB.
function texto(v, max = 120) { return String(v ?? "").slice(0, max); }

async function unDoc(estabDB, lote, subtipo) {
  // Índice ["tipo","subtipo","lote_nombre","ts"] (Sprint 2, Tarea 1).
  const r = await estabDB.find({
    selector: { tipo: "aog_archivo", subtipo, lote_nombre: lote, ts: { $gt: 0 } },
    fields: ["contenido", "ts"],
    sort: [{ ts: "desc" }],
    limit: 1,
  }).catch(() => ({ docs: [] }));
  return (r.docs || [])[0] || null;
}

// Devuelve el boundary como [[lat,lon], ...]. Prioridad: el lote_maestro (que
// ya lo guarda en GeoJSON cuando el lote se creó desde OrbitX), después el KML
// de PilotX (WGS84 directo) y por último Boundary.txt + Field.txt.
async function boundaryDeLote(slug, loteCrudo) {
  const estabDB = db.getDB(slug);
  const lote = texto(loteCrudo);

  try {
    // Índice ["tipo","nombre"] (services/couchdb.js).
    const r = await estabDB.find({
      selector: { tipo: "lote_maestro", nombre: lote },
      fields: ["boundary_geojson"],
      limit: 1,
    });
    const g = r.docs?.[0]?.boundary_geojson;
    const anillo = g?.coordinates?.[0];
    if (Array.isArray(anillo) && anillo.length > 3) return anillo.map(([lon, lat]) => [lat, lon]);
  } catch (e) { console.warn("[ndvi_raster] lote_maestro:", e.message); }

  const kml = await unDoc(estabDB, lote, "boundary_kml");
  if (kml) { const b = parseKML(kml.contenido); if (b && b.length > 3) return b; }

  const bt = await unDoc(estabDB, lote, "boundary");
  const fo = await unDoc(estabDB, lote, "field_origin");
  if (bt && fo) {
    const b = parseBoundaryTxt(bt.contenido, parseFieldTxt(fo.contenido));
    if (b && b.length > 3) return b;
  }
  return null;
}

// Cierra el anillo y lo orienta antihorario, que es lo que acepta Sentinel Hub.
function anilloParaSH(puntosXY) {
  const ring = puntosXY.slice();
  const [x0, y0] = ring[0], [xn, yn] = ring[ring.length - 1];
  if (x0 !== xn || y0 !== yn) ring.push([x0, y0]);
  let acc = 0;
  for (let i = 0; i < ring.length - 1; i++) acc += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return acc < 0 ? ring.reverse() : ring;
}

// Del contorno [[lat,lon],…] a la grilla métrica que se le pide a Copernicus.
// Es JS puro (sin red ni disco), así que se testea entero con node --test.
//
// El bbox que sale de acá es EXACTAMENTE el que viaja en el request (ver
// boundsDeGrilla) y el que se le pasa después a zonificar(): si no fueran el
// mismo, las zonas quedan escaladas y corridas respecto de la imagen. El caso
// que lo hacía evidente es un lote chico: con MIN_PX=32 píxeles de lado, un
// lote de 100 m se pide en una ventana de 320 m, y si se declarara el bbox del
// contorno (100 m) cada zona saldría 3,2 veces más grande de lo que es.
function calcularGrilla(boundary, metrosPorPx = 10) {
  // Zona UTM por la longitud media del lote (en Argentina: 19, 20 o 21).
  const lonMedia = boundary.reduce((s, p) => s + p[1], 0) / boundary.length;
  const zona = zonaUtmPorLon(lonMedia);
  const sur = boundary[0][0] < 0;

  const xy = boundary.map(([lat, lon]) => { const u = latLonAUtm(lat, lon, zona); return [u.x, u.y]; });
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const lote = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };

  const anchoM = lote.maxX - lote.minX, altoM = lote.maxY - lote.minY;
  const escala = Math.max(1, anchoM / (MAX_PX * metrosPorPx), altoM / (MAX_PX * metrosPorPx));
  const mPx = metrosPorPx * escala;
  // ceil, no round: con round el bbox reajustado de abajo queda MÁS CHICO que
  // el contorno y se pierde una franja de hasta medio píxel del borde del lote.
  // ceil nunca pasa MAX_PX porque la escala ya garantiza anchoM/mPx <= MAX_PX.
  const ancho = Math.min(MAX_PX, Math.max(MIN_PX, Math.ceil(anchoM / mPx)));
  const alto  = Math.min(MAX_PX, Math.max(MIN_PX, Math.ceil(altoM / mPx)));

  // La ventana final mide ancho*mPx x alto*mPx y se expande CENTRADA sobre el
  // lote: así el sobrante del redondeo (y el del clamp por MIN_PX, que puede
  // ser grande) queda repartido a ambos lados en vez de correr el lote contra
  // la esquina inferior izquierda. Con esto, resX = (maxX-minX)/ancho = mPx y
  // resY = (maxY-minY)/alto = mPx, exactos.
  const cx = (lote.minX + lote.maxX) / 2, cy = (lote.minY + lote.maxY) / 2;
  const extX = ancho * mPx, extY = alto * mPx;
  const bbox = {
    minX: cx - extX / 2, maxX: cx + extX / 2,
    minY: cy - extY / 2, maxY: cy + extY / 2,
  };

  return { zona, sur, xy, bbox, lote, ancho, alto, mPx };
}

// EPSG del UTM WGS84: 327XX al sur del ecuador, 326XX al norte.
function crsUtm(zona, sur) {
  return `http://www.opengis.net/def/crs/EPSG/0/${sur ? 327 : 326}${String(zona).padStart(2, "0")}`;
}

// El `bounds` tal cual va en el body del Process API. Sentinel Hub deriva la
// extensión renderizada del `bbox` cuando está presente y usa la `geometry`
// SOLO para recortar; sin `bbox` la derivaba de la geometría y la ventana real
// no era la que declarábamos. Es una función aparte, pura, para poder testear
// que el bbox del request y el que se le pasa a zonificar son el mismo objeto.
function boundsDeGrilla({ bbox, xy, zona, sur }) {
  return {
    bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY],
    geometry: { type: "Polygon", coordinates: [anilloParaSH(xy)] },
    properties: { crs: crsUtm(zona, sur) },
  };
}

// Centro del píxel (px, py) en coordenadas UTM, con la misma convención que
// lib/zonificar.js: la fila 0 es la del norte, así que la Y baja al avanzar.
function pixelAUtm({ bbox, ancho, alto }, px, py) {
  return [
    bbox.minX + ((px + 0.5) * (bbox.maxX - bbox.minX)) / ancho,
    bbox.maxY - ((py + 0.5) * (bbox.maxY - bbox.minY)) / alto,
  ];
}

async function rasterDeLote({ slug, lote, fecha, indice = "ndvi", metrosPorPx = 10, maxCloudCoverage = 30 }) {
  const boundary = await boundaryDeLote(slug, lote);
  if (!boundary) throw Object.assign(new Error(`El lote "${lote}" no tiene contorno cargado`), { status: 404 });

  const grilla = calcularGrilla(boundary, metrosPorPx);
  const { zona, sur, bbox, ancho, alto, mPx } = grilla;

  const hasta = fecha || new Date().toISOString().slice(0, 10);
  const desde = fecha || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // require perezoso: routes/ndvi.js requiere este módulo dentro de su handler,
  // así que pedirlo arriba haría un ciclo.
  const { processAPI } = require("../routes/ndvi");
  const bounds = boundsDeGrilla(grilla);
  const png = await processAPI({
    bbox: bounds.bbox,
    geometry: bounds.geometry,
    desde, hasta, width: ancho, height: alto,
    evalscript: indices.getEvalscriptRaster(indice),
    maxCloudCoverage,
    formato: "image/png",
    crs: bounds.properties.crs,
  });

  const img = decodificarPNG(png);
  if (img.ancho !== ancho || img.alto !== alto)
    throw new Error(`Copernicus devolvió ${img.ancho}x${img.alto}, se pidió ${ancho}x${alto}`);
  if (img.canales < 2)
    throw new Error(`Copernicus devolvió ${img.canales} canal(es): se esperaban 2 (valor + máscara)`);

  // Con output {bands:2, sampleType:"UINT8"} Sentinel Hub devuelve un PNG
  // gris+alfa (color type 4): canal 0 = valor, canal 1 = máscara. La doc de
  // CDSE no lo garantiza por escrito ("PNG can only support 1 or 3 color
  // components plus an alpha channel"), así que no asumimos exactamente 2:
  // el valor es siempre el primer canal y la máscara el último (alfa), que
  // también es lo correcto si alguna vez volviera promovido a RGBA.
  const valores = extraerCanal(img, 0);
  const mascara = extraerCanal(img, img.canales - 1);
  for (let i = 0; i < valores.length; i++) if (!mascara[i]) valores[i] = 0;   // 0 = sin dato

  return {
    datos: valores, ancho, alto, bbox, zona, sur,
    rango: indices.rangoDe(indice), indice, fecha: fecha || null, boundary,
    resolucion_m: Math.round(mPx * 100) / 100,
  };
}

module.exports = { boundaryDeLote, rasterDeLote, calcularGrilla, boundsDeGrilla, pixelAUtm, crsUtm, anilloParaSH, MAX_PX, MIN_PX };
