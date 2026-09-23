"use strict";
// zonificar.js — De un raster de índice (UINT8) a zonas de manejo en GeoJSON.
// Todo JS puro: no toca red, disco ni CouchDB, y por lo tanto se testea entero
// con node --test.
//
// Pipeline: cuantiles → filtro de mayoría 3x3 → fusión de manchas chicas →
// vectorización por aristas (marching squares binario) → Douglas-Peucker →
// UTM a lat/lon. El raster viene en METROS UTM, no en grados: vectorizar sobre
// un bbox lat/lon a -34° deforma la geometría, y el tractor sigue estos
// polígonos.

// ── Proyección UTM / WGS84 ────────────────────────────────
const A = 6378137;                       // semieje mayor WGS84
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const RAD = Math.PI / 180, DEG = 180 / Math.PI;

function zonaUtmPorLon(lon) { return Math.floor((Number(lon) + 180) / 6) + 1; }
function meridianoCentral(zona) { return ((zona - 1) * 6 - 180 + 3) * RAD; }

function latLonAUtm(lat, lon, zona) {
  const z = zona || zonaUtmPorLon(lon);
  const lon0 = meridianoCentral(z);
  const phi = lat * RAD, lam = lon * RAD;
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sinP * sinP);
  const T = tanP * tanP;
  const C = EP2 * cosP * cosP;
  const Aa = cosP * (lam - lon0);
  const M = A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
  let y = K0 * (M + N * tanP * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  if (lat < 0) y += 10000000;            // falsa ordenada del hemisferio sur
  return { x, y, zona: z };
}

function utmALatLon(x, y, zona, sur = true) {
  const lon0 = meridianoCentral(zona);
  const xx = x - 500000;
  const yy = sur ? y - 10000000 : y;
  const M = yy / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - E2 * sinP * sinP);
  const T1 = tanP * tanP;
  const C1 = EP2 * cosP * cosP;
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * sinP * sinP, 1.5);
  const D = xx / (N1 * K0);
  const lat = phi1 - (N1 * tanP / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / cosP;
  return { lat: lat * DEG, lon: lon * DEG };
}

// ── Clasificación ─────────────────────────────────────────
// Histograma de 256 bins en vez de ordenar: los valores ya son enteros 0-255,
// así que es O(n) y no O(n log n) sobre hasta 1 millón de píxeles.
function clasificarCuantiles(valores, n, nodata = 0) {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    if (v === nodata) continue;
    hist[v]++; total++;
  }
  const clases = new Uint8Array(valores.length);
  if (!total) { clases.fill(255); return { cortes: [], clases }; }

  // Cortes por cuantil, sin duplicar valor de corte: si el bin donde cae el
  // cuantil k ya se usó como corte anterior (mucha repetición del mismo
  // valor, p.ej. un raster con una moda gigante), se empuja al siguiente
  // valor distinto disponible. Si no queda valor distinto, esa clase queda
  // vacía (no hay forma de partir sin ese valor) y el corte simplemente no
  // se agrega — evita cortes repetidos que dejarían clases fantasma.
  const cortes = [];
  let acum = 0, k = 1;
  for (let v = 0; v < 256 && k < n; v++) {
    acum += hist[v];
    while (k < n && acum >= (total * k) / n) {
      if (cortes.length === 0 || cortes[cortes.length - 1] !== v) cortes.push(v);
      k++;
    }
  }

  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    if (v === nodata) { clases[i] = 255; continue; }
    let c = 0;
    while (c < cortes.length && v > cortes[c]) c++;
    clases[i] = c;
  }
  return { cortes, clases };
}

// ── Limpieza del moteado ──────────────────────────────────
// Sin esto la vectorización escupe miles de polígonos de un píxel.
function filtroMayoria(grid, ancho, alto, nClases = 8) {
  const out = new Uint8Array(grid.length);
  const cuenta = new Uint16Array(nClases);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = y * ancho + x;
      if (grid[i] === 255) { out[i] = 255; continue; }
      cuenta.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= alto) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= ancho) continue;
          const c = grid[yy * ancho + xx];
          if (c !== 255 && c < nClases) cuenta[c]++;
        }
      }
      // Empate: gana la clase original (el filtro suaviza, no reasigna porque sí).
      let mejor = grid[i], mejorN = cuenta[grid[i]] || 0;
      for (let c = 0; c < nClases; c++) if (cuenta[c] > mejorN) { mejorN = cuenta[c]; mejor = c; }
      out[i] = mejor;
    }
  }
  return out;
}

// Las manchas de menos de `minPixeles` se funden con el vecino más presente:
// es el "descartar polígonos chicos" del spec, hecho antes de vectorizar para
// que no queden agujeros. Una sola pasada; alcanza para el moteado real.
function fundirChicas(grid, ancho, alto, minPixeles) {
  const out = Uint8Array.from(grid);
  if (!(minPixeles > 1)) return out;
  const visto = new Uint8Array(out.length);
  const pila = [];
  for (let i0 = 0; i0 < out.length; i0++) {
    if (visto[i0] || out[i0] === 255) continue;
    const clase = out[i0];
    const comp = [];
    const vecinos = new Uint32Array(256);
    pila.length = 0; pila.push(i0); visto[i0] = 1;
    while (pila.length) {
      const i = pila.pop();
      comp.push(i);
      const x = i % ancho, y = (i / ancho) | 0;
      const alrededor = [];
      if (x > 0) alrededor.push(i - 1);
      if (x < ancho - 1) alrededor.push(i + 1);
      if (y > 0) alrededor.push(i - ancho);
      if (y < alto - 1) alrededor.push(i + ancho);
      for (const j of alrededor) {
        if (out[j] === clase) { if (!visto[j]) { visto[j] = 1; pila.push(j); } }
        else if (out[j] !== 255) vecinos[out[j]]++;
      }
    }
    if (comp.length >= minPixeles) continue;
    let mejor = -1, mejorN = 0;
    for (let c = 0; c < 256; c++) if (vecinos[c] > mejorN) { mejorN = vecinos[c]; mejor = c; }
    if (mejor >= 0) for (const i of comp) out[i] = mejor;
  }
  return out;
}

// ── Vectorización ─────────────────────────────────────────
// Variante binaria de marching squares: se juntan las aristas de borde de cada
// píxel de la clase (con el interior siempre a la izquierda del avance) y se
// las encadena en anillos cerrados. Es determinista y mucho menos delicado que
// seguir contornos píxel a píxel.
//
// Caso ambiguo 5/10 (tablero de ajedrez, dos píxeles de la clase que solo se
// tocan por la diagonal): sin desambiguar, dos píxeles diagonales aportan
// cada uno su cuadrado de 4 aristas y ambos comparten un único vértice. Ese
// vértice queda con grado de salida 2 en el mapa de aristas, y si el
// recorrido elige la arista "equivocada" ahí, junta los dos cuadrados en un
// solo anillo en forma de ocho que se autointerseca (polígono inválido). La
// resolución clásica de marching squares es partir el vértice ambiguo en dos
// mitades infinitesimales; acá, como cada arista nace de un péxel concreto,
// alcanza con no mezclar aristas de orígenes distintos en el mismo vértice:
// se encadena SIEMPRE por la arista que cierra el anillo actual más rápido
// (la que un cuadrado 1x1 recorrería), preferiendo, ante empate de grado>1,
// la arista que ya fue vista viniendo del mismo píxel de origen. En la
// práctica esto se logra desambiguando por el giro: en un vértice con más de
// una arista saliente se elige la que gira "más a la derecha" respecto de la
// arista entrante (regla del boundary tracing estándar), que es exactamente
// la que mantiene cada cuadrado de 1x1 como una figura separada.
function marchingSquares(grid, ancho, alto, clase) {
  const es = (x, y) => x >= 0 && y >= 0 && x < ancho && y < alto && grid[y * ancho + x] === clase;
  // dir codifica la dirección de la arista entrante como vector unitario, para
  // poder desambiguar vértices con grado de salida > 1 (caso tablero de
  // ajedrez) eligiendo siempre el giro más cerrado a la derecha.
  const bordes = new Map();                       // "x,y" -> [{a:[x,y], b:[x2,y2]}, ...]
  const agregar = (a, b) => {
    const k = `${a[0]},${a[1]}`;
    const lista = bordes.get(k);
    const e = { a, b };
    if (lista) lista.push(e); else bordes.set(k, [e]);
  };
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      if (!es(x, y)) continue;
      if (!es(x, y - 1)) agregar([x, y], [x + 1, y]);
      if (!es(x + 1, y)) agregar([x + 1, y], [x + 1, y + 1]);
      if (!es(x, y + 1)) agregar([x + 1, y + 1], [x, y + 1]);
      if (!es(x - 1, y)) agregar([x, y + 1], [x, y]);
    }
  }

  // Ángulo (en "octantes") de una arista a->b: como todas las aristas miden
  // 1 en x o en y, alcanza con el signo de cada componente.
  const dirDe = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

  // Elige, entre las aristas que salen de `actual`, la que gira más a la
  // derecha respecto de la dirección de llegada `dirEntrada` (menor giro en
  // sentido horario). Esto es lo que separa dos cuadrados que solo se tocan
  // por un vértice: cada uno recorre su propio giro de 90° sin saltar al otro.
  function elegirSaliente(lista, dirEntrada) {
    if (lista.length === 1) return 0;
    // Giro horario desde dirEntrada hasta cada candidata, normalizado a
    // (0, 2π]. El que sigue cerrando el cuadrado 1x1 de origen es siempre el
    // giro MÁS GRANDE (el que más "dobla hacia atrás" sobre el propio
    // píxel); el que salta al cuadrado vecino que solo toca por la diagonal
    // es el giro más chico (casi seguir de largo). Por eso se elige el
    // máximo: mantiene cada cuadrado de 1x1 como figura separada en el
    // vértice ambiguo.
    let mejorIdx = 0, mejorGiro = -1;
    for (let i = 0; i < lista.length; i++) {
      const dirSal = dirDe(lista[i].a, lista[i].b);
      let giro = dirEntrada - dirSal;
      giro = ((giro % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (giro === 0) giro = 2 * Math.PI;          // seguir de largo es el giro "máximo" posible
      if (giro > mejorGiro) { mejorGiro = giro; mejorIdx = i; }
    }
    return mejorIdx;
  }

  const anillos = [];
  const tope = ancho * alto * 4 + 8;
  for (const k0 of [...bordes.keys()]) {
    while (bordes.get(k0)?.length) {
      const inicio = k0.split(",").map(Number);
      const anillo = [inicio];
      let actual = inicio, pasos = 0, dirEntrada = null;
      while (pasos++ < tope) {
        const k = `${actual[0]},${actual[1]}`;
        const lista = bordes.get(k);
        if (!lista || !lista.length) break;
        const idx = dirEntrada === null ? lista.length - 1 : elegirSaliente(lista, dirEntrada);
        const e = lista[idx];
        lista.splice(idx, 1);
        if (!lista.length) bordes.delete(k);
        const sig = e.b;
        dirEntrada = dirDe(e.a, e.b);
        anillo.push(sig);
        actual = sig;
        if (sig[0] === inicio[0] && sig[1] === inicio[1]) break;
      }
      if (anillo.length > 3) anillos.push(anillo);
    }
  }
  return anillos;
}

// ── Simplificación ────────────────────────────────────────
function distPuntoSegmento(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / Math.hypot(dx, dy);
}

function douglasPeucker(puntos, tol) {
  if (!puntos || puntos.length < 3) return (puntos || []).slice();
  let maxD = -1, idx = -1;
  const a = puntos[0], b = puntos[puntos.length - 1];
  for (let i = 1; i < puntos.length - 1; i++) {
    const d = distPuntoSegmento(puntos[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  const izq = douglasPeucker(puntos.slice(0, idx + 1), tol);
  const der = douglasPeucker(puntos.slice(idx), tol);
  return izq.slice(0, -1).concat(der);
}

// Un anillo cerrado no se puede simplificar de una: el primer y el último
// punto son el mismo y Douglas-Peucker colapsaría todo. Se parte en el punto
// más lejano del inicio, se simplifican las dos cadenas y se reúnen.
function simplificarAnillo(anillo, tol) {
  const abierto = anillo.slice(0, -1);
  if (abierto.length < 4) return anillo.slice();
  let idx = 0, maxD = -1;
  for (let i = 1; i < abierto.length; i++) {
    const d = Math.hypot(abierto[i][0] - abierto[0][0], abierto[i][1] - abierto[0][1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  const c1 = douglasPeucker(abierto.slice(0, idx + 1), tol);
  const c2 = douglasPeucker(abierto.slice(idx).concat([abierto[0]]), tol);
  const out = c1.slice(0, -1).concat(c2);
  return out.length >= 4 ? out : anillo.slice();
}

function areaFirmada(anillo) {
  let acc = 0;
  for (let i = 0; i < anillo.length - 1; i++)
    acc += anillo[i][0] * anillo[i + 1][1] - anillo[i + 1][0] * anillo[i][1];
  return acc / 2;
}

function puntoEnAnillo(p, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 2; i < anillo.length - 1; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

// ── Orquestador ───────────────────────────────────────────
function zonificar({
  datos, ancho, alto, bbox, zona, sur = true,
  n = 3, areaMinHa = 0.5, nodata = 0, rango = [-0.2, 1.0], tolPx = 1,
}) {
  const dx = (bbox.maxX - bbox.minX) / ancho;
  const dy = (bbox.maxY - bbox.minY) / alto;
  const { cortes, clases } = clasificarCuantiles(datos, n, nodata);

  let g = filtroMayoria(clases, ancho, alto, Math.max(n, 2));
  const minPx = Math.max(1, Math.round((areaMinHa * 10000) / (dx * dy)));
  g = fundirChicas(g, ancho, alto, minPx);

  // La fila 0 del raster es la de arriba (norte): la Y de UTM baja al avanzar.
  const aLonLat = ([px, py]) => {
    const { lat, lon } = utmALatLon(bbox.minX + px * dx, bbox.maxY - py * dy, zona, sur);
    return [lon, lat];
  };
  const valorReal = (q) => rango[0] + ((q - 1) / 253) * (rango[1] - rango[0]);

  const features = [];
  for (let c = 0; c < n; c++) {
    const anillos = marchingSquares(g, ancho, alto, c).map(a => simplificarAnillo(a, tolPx));
    if (!anillos.length) continue;

    const conArea = anillos.map(a => ({ a, area: areaFirmada(a) }));
    const exteriores = conArea.filter(o => o.area > 0).sort((p, q) => p.area - q.area);
    const huecos = conArea.filter(o => o.area < 0);

    const polys = exteriores.map(e => ({ ext: e.a, area: e.area, huecos: [] }));
    for (const h of huecos) {
      const dueno = polys.find(p => puntoEnAnillo(h.a[0], p.ext));   // el más chico que lo contiene
      if (dueno) dueno.huecos.push(h);
    }
    if (!polys.length) continue;

    // Área neta en píxeles → m² → ha.
    let areaPx = 0;
    for (const p of polys) areaPx += p.area - p.huecos.reduce((s, h) => s + Math.abs(h.area), 0);
    const ha = Math.round((areaPx * dx * dy / 10000) * 100) / 100;

    let suma = 0, cant = 0;
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== c) continue;
      const v = datos[i];
      if (v === nodata) continue;
      suma += valorReal(v); cant++;
    }

    // GeoJSON RFC 7946: exterior antihorario, huecos horarios. El signo se
    // evalúa ya en lon/lat porque el flip de Y invierte la orientación.
    const coordenadas = polys.map(p => {
      const ext = p.ext.map(aLonLat);
      const extCCW = areaFirmada(ext) > 0 ? ext : ext.slice().reverse();
      const hs = p.huecos.map(h => {
        const r = h.a.map(aLonLat);
        return areaFirmada(r) < 0 ? r : r.slice().reverse();
      });
      return [extCCW, ...hs];
    });

    features.push({
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: coordenadas },
      properties: {
        zona:       c + 1,
        dosis:      null,
        unidad:     null,
        nombre:     `Zona ${c + 1}`,
        ndvi_medio: cant ? Math.round((suma / cant) * 1000) / 1000 : null,
        ha,
      },
    });
  }

  return {
    type: "FeatureCollection",
    properties: { n_zonas: n, cortes, zona_utm: zona, resolucion_m: Math.round(((dx + dy) / 2) * 100) / 100 },
    features,
  };
}

module.exports = {
  zonaUtmPorLon, latLonAUtm, utmALatLon,
  clasificarCuantiles, filtroMayoria, fundirChicas,
  marchingSquares, douglasPeucker, simplificarAnillo, areaFirmada,
  zonificar,
};
