"use strict";
// zonificar.js — De un raster de índice (UINT8) a zonas de manejo en GeoJSON.
// Todo JS puro: no toca red, disco ni CouchDB, y por lo tanto se testea entero
// con node --test.
//
// Pipeline: cuantiles → filtro de mayoría 3x3 → relleno del nodata moteado →
// fusión de manchas chicas (hasta punto fijo) → vectorización por aristas
// (marching squares binario) →
// Douglas-Peucker sobre cadenas de borde COMPARTIDAS → UTM a lat/lon. El raster
// viene en METROS UTM, no en grados: vectorizar sobre un bbox lat/lon a -34°
// deforma la geometría, y el tractor sigue estos polígonos.
//
// ── Escala del raster de entrada (contrato con quien lo genera) ──────────────
// `datos` es UINT8 y DEBE venir cuantizado así:
//
//   DN 0        → SIN DATO (nodata). No entra en cuantiles ni en `ndvi_medio`.
//   DN 1..254   → valor físico, lineal sobre `rango`:
//                   valor = rango[0] + ((DN - 1) / 253) * (rango[1] - rango[0])
//                 con `rango` por defecto [-0.2, 1.0] (NDVI).
//   DN 255      → RESERVADO por el pipeline interno para marcar "clase sin
//                 dato" en las grillas de clases. No usar en el raster de
//                 entrada.
//
// O sea: DN = 1 + round((valor - rango[0]) / (rango[1] - rango[0]) * 253),
// recortado a 1..254. `ndvi_medio` de cada feature sale en ESCALA FÍSICA (el
// valor real, no el DN). Si el raster se cuantiza de otra forma, `ndvi_medio`
// y los cortes quedan mal — es el contrato que consume la tarea 9c.
//
// ── Qué garantiza (y qué no) `tolPx` ────────────────────────────────────────
// `tolPx` es la tolerancia de Douglas-Peucker EN PÍXELES (default 1).
//
//   · ENTRE ZONAS la partición es EXACTA, sin importar `tolPx`: el borde que
//     comparten dos zonas es una única cadena simplificada una sola vez y
//     reusada dada vuelta por la vecina, así que los dos lados tienen
//     exactamente los mismos vértices. Ni solapes ni franjas sin cubrir.
//   · CONTRA EL AFUERA (el nodata / el borde del lote) no hay vecina que
//     comparta la cadena, así que la simplificación sí corre el contorno:
//     con `tolPx = 1` un vértice puede moverse hasta ~1 píxel y el contorno
//     hasta ~media diagonal de píxel (≈ 0,71 px) respecto del borde real del
//     raster. En un lote circular de 1.000 px de diámetro eso da un sesgo de
//     superficie del orden de +0,25 %. Si hace falta el contorno al píxel
//     (p. ej. para facturar hectáreas), bajar `tolPx` a 0 — a costa de
//     muchísimos más vértices en el GeoJSON.

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

// Recorre las componentes 4-conectadas de `grid` —TODAS, incluida la del nodata
// (255)— y llama a `alTerminar(comp, clase, vecinos, tocaBorde)`:
//
//   · `comp`      índices de los píxeles de la componente.
//   · `clase`     el valor de la grilla (255 = nodata).
//   · `vecinos`   `vecinos[c]` = píxeles de la clase c (c ≠ 255) pegados a la
//                 componente. El nodata NO se cuenta como vecino: es justo eso
//                 lo que deja distinguir una isla rodeada de nodata de una
//                 mancha con vecinas reales.
//   · `tocaBorde` la componente toca el borde del raster.
//
// El `ctx` (buffers) se puede reusar entre pasadas: `fundirChicas` hace hasta 9.
function crearCtxComponentes(largo) {
  return { visto: new Uint8Array(largo), vecinos: new Uint32Array(256), pila: [] };
}

function porComponente(grid, ancho, alto, alTerminar, ctx) {
  const { visto, vecinos, pila } = ctx || crearCtxComponentes(grid.length);
  visto.fill(0);
  for (let i0 = 0; i0 < grid.length; i0++) {
    if (visto[i0]) continue;
    const clase = grid[i0];
    const comp = [];
    vecinos.fill(0);
    let tocaBorde = false;
    pila.length = 0; pila.push(i0); visto[i0] = 1;
    while (pila.length) {
      const i = pila.pop();
      comp.push(i);
      const x = i % ancho, y = (i / ancho) | 0;
      if (x === 0 || y === 0 || x === ancho - 1 || y === alto - 1) tocaBorde = true;
      if (x > 0) {
        const j = i - 1;
        if (grid[j] === clase) { if (!visto[j]) { visto[j] = 1; pila.push(j); } }
        else if (grid[j] !== 255) vecinos[grid[j]]++;
      }
      if (x < ancho - 1) {
        const j = i + 1;
        if (grid[j] === clase) { if (!visto[j]) { visto[j] = 1; pila.push(j); } }
        else if (grid[j] !== 255) vecinos[grid[j]]++;
      }
      if (y > 0) {
        const j = i - ancho;
        if (grid[j] === clase) { if (!visto[j]) { visto[j] = 1; pila.push(j); } }
        else if (grid[j] !== 255) vecinos[grid[j]]++;
      }
      if (y < alto - 1) {
        const j = i + ancho;
        if (grid[j] === clase) { if (!visto[j]) { visto[j] = 1; pila.push(j); } }
        else if (grid[j] !== 255) vecinos[grid[j]]++;
      }
    }
    alTerminar(comp, clase, vecinos, tocaBorde);
  }
}

// ── Nodata moteado ────────────────────────────────────────
// `services/ndvi_raster.js` marca como nodata (DN 0 → clase 255) todo lo que
// queda fuera del contorno del lote Y cada píxel que la máscara de Sentinel Hub
// da por nublado. Las nubes vienen MOTEADAS: píxeles sueltos desparramados por
// todo el lote. Cada uno de esos píxeles es un agujero de 1 px que la
// vectorización tiene que rodear con su propio anillo — un raster de 1024x1024
// con 5 % de nube daba 43.601 anillos, 10 MB de GeoJSON y varios segundos de
// CPU sincrónica, y el archivo resultante no le sirve a nadie en el campo.
//
// Es la contracara de las islas huérfanas de `fundirChicas`: toda componente de
// nodata por debajo de `minPixeles` que NO toque el borde del raster se rellena
// con la clase del vecino con el que comparte más borde.
//
// Lo que se CONSERVA tal cual: el nodata grande (la parte de afuera del
// boundary del lote, las nubes de verdad) y cualquier componente de nodata que
// toque el borde del raster — ahí no hay forma de distinguir un agujerito de un
// recorte del lote, así que no se inventa dato.
function limpiarNodataChico(grid, ancho, alto, minPixeles) {
  const out = Uint8Array.from(grid);
  if (!(minPixeles > 1)) return out;
  let rellenados = 0, pixeles = 0;
  porComponente(out, ancho, alto, (comp, clase, vec, tocaBorde) => {
    if (clase !== 255 || tocaBorde || comp.length >= minPixeles) return;
    let mejor = -1, mejorN = 0;
    for (let c = 0; c < 255; c++) if (vec[c] > mejorN) { mejorN = vec[c]; mejor = c; }
    if (mejor < 0) return;                       // nodata metido adentro de nodata
    for (const i of comp) out[i] = mejor;
    rellenados++; pixeles += comp.length;
  });
  if (rellenados)
    console.warn(`[zonificar] ${rellenados} hueco(s) de nodata de menos de ${minPixeles} px (${pixeles} píxeles) rellenados con la clase vecina`);
  return out;
}

// Techo de pasadas de la fusión. No es el mecanismo de corte (cada fusión baja
// el número de componentes), es un seguro contra un raster patológico.
const MAX_PASADAS_FUSION = 8;

// Las manchas de menos de `minPixeles` se funden con el vecino más presente:
// es el "descartar polígonos chicos" del spec, hecho antes de vectorizar para
// que no queden agujeros.
//
// ITERA HASTA PUNTO FIJO. Con una sola pasada quedaban huérfanos: si la
// componente A (chica) se funde al vecino B y después B también resulta chica
// y se funde a C, los píxeles de A ya fueron marcados como vistos, no se
// re-evalúan, y quedan como una mancha propia por debajo del mínimo (en un
// raster 256x256 realista con n=5 y 0,5 ha quedaban 10 manchas de 39 por
// debajo del mínimo, ocho de un solo píxel). Recomputando las componentes en
// cada pasada el problema desaparece. Termina siempre: cada fusión baja en al
// menos uno el número de componentes (una componente entera se repinta y se
// pega a alguna vecina), así que el `iter < 8` es sólo un techo de seguridad.
//
// ISLAS HUÉRFANAS: una componente chica puede no tener NINGÚN 4-vecino de otra
// clase — está rodeada de nodata o del borde del raster. Es el caso real de
// `services/ndvi_raster.js`, que enmascara todo lo que queda fuera del boundary
// del lote y las nubes como nodata: quedan islitas de 0,03 ha que antes
// sobrevivían por debajo del mínimo porque no había a quién fundirlas. Ahora se
// descartan (pasan a nodata) y se avisa una vez por corrida con el conteo. La
// excepción es que sea la ÚNICA componente del raster: ahí se conserva
// (descartarla dejaría el lote vacío) y se loguea.
//
// La búsqueda de huérfanas corre RECIÉN AL CONVERGER, no dentro del bucle: en
// una pasada donde ya hubo fusiones, una componente puede quedar pegada a otra
// que se repintó de su misma clase y que ya está marcada como vista, y entonces
// no se le cuenta ningún vecino de otra clase aunque los tenga. Sobre la grilla
// estable eso no pasa y "sin vecino de otra clase" sí significa "isla".
function fundirChicas(grid, ancho, alto, minPixeles) {
  const out = Uint8Array.from(grid);
  if (!(minPixeles > 1)) return out;
  const ctx = crearCtxComponentes(out.length);

  let iter = 0, huboCambios;
  do {
    huboCambios = false;
    porComponente(out, ancho, alto, (comp, clase, vec) => {
      if (clase === 255 || comp.length >= minPixeles) return;
      let mejor = -1, mejorN = 0;
      for (let c = 0; c < 255; c++) if (vec[c] > mejorN) { mejorN = vec[c]; mejor = c; }
      if (mejor >= 0 && mejor !== clase) {
        for (const i of comp) out[i] = mejor;
        huboCambios = true;
      }
    }, ctx);
    iter++;
  } while (huboCambios && iter < MAX_PASADAS_FUSION);
  // Salir por el techo con cambios pendientes no debería pasar nunca, pero si
  // pasa hay que enterarse: quedan manchas por debajo del mínimo sin aviso.
  if (huboCambios)
    console.warn(`[zonificar] fundirChicas cortó por el techo de ${MAX_PASADAS_FUSION} pasadas con cambios todavía pendientes: pueden quedar manchas por debajo de ${minPixeles} px`);

  // Grilla ya estable: lo que siga chico y sin vecino de otra clase es una isla.
  const huerfanas = [];
  let componentes = 0;
  porComponente(out, ancho, alto, (comp, clase, vec) => {
    if (clase === 255) return;
    componentes++;
    if (comp.length >= minPixeles) return;
    for (let c = 0; c < 255; c++) if (vec[c] > 0) return;      // tiene con quién fundirse
    huerfanas.push(comp);
  }, ctx);
  if (huerfanas.length) {
    // Si el raster no tiene NADA más que islas huérfanas, se salva la más
    // grande: descartarlas todas dejaría el lote vacío.
    let salvada = -1;
    if (componentes === huerfanas.length) {
      salvada = 0;
      for (let k = 1; k < huerfanas.length; k++) if (huerfanas[k].length > huerfanas[salvada].length) salvada = k;
    }
    let descartadas = 0;
    for (let k = 0; k < huerfanas.length; k++) {
      if (k === salvada) continue;
      for (const i of huerfanas[k]) out[i] = 255;
      descartadas++;
    }
    if (descartadas)
      console.warn(`[zonificar] ${descartadas} isla(s) por debajo del mínimo de ${minPixeles} px y sin vecino de otra clase (rodeadas de nodata): se descartan`);
    if (salvada >= 0)
      console.warn(`[zonificar] el raster no tiene ninguna componente que llegue al mínimo de ${minPixeles} px: se conserva la más grande (${huerfanas[salvada].length} px) para no dejar el lote vacío`);
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
// mitades infinitesimales; acá, como cada arista nace de un píxel concreto,
// alcanza con no mezclar aristas de orígenes distintos en el mismo vértice:
// se encadena SIEMPRE por la arista que cierra el anillo actual más rápido
// (la que un cuadrado 1x1 recorrería). En la práctica esto se logra
// desambiguando por el giro: en un vértice con más de una arista saliente se
// elige la que gira "más a la derecha" respecto de la arista entrante (regla
// del boundary tracing estándar), que es exactamente la que mantiene cada
// cuadrado de 1x1 como una figura separada.
//
// Los vértices se indexan con un entero `vy * (ancho + 1) + vx` en vez de una
// clave string "x,y": sobre un raster de 1024x1024 eso saca del camino un par
// de millones de strings temporales.
function marchingSquares(grid, ancho, alto, clase) {
  const anchoV = ancho + 1;
  const es = (x, y) => x >= 0 && y >= 0 && x < ancho && y < alto && grid[y * ancho + x] === clase;
  const bordes = new Map();                       // vértice (entero) -> [{a, b}, ...]
  const agregar = (a, b) => {
    const k = a[1] * anchoV + a[0];
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

  // Ángulo de una arista a->b: como todas miden 1 en x o en y, el atan2 sólo
  // se usa en los vértices ambiguos (grado de salida > 1), que son pocos.
  const dirDe = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

  // Elige, entre las aristas que salen de `actual`, la que gira más a la
  // derecha respecto de la dirección de llegada `dirEntrada`. Esto es lo que
  // separa dos cuadrados que solo se tocan por un vértice: cada uno recorre su
  // propio giro de 90° sin saltar al otro.
  function elegirSaliente(lista, dirEntrada) {
    if (lista.length === 1) return 0;
    // Giro horario desde dirEntrada hasta cada candidata, normalizado a
    // (0, 2π]. El que sigue cerrando el cuadrado 1x1 de origen es siempre el
    // giro MÁS GRANDE (el que más "dobla hacia atrás" sobre el propio píxel);
    // el que salta al cuadrado vecino que solo toca por la diagonal es el giro
    // más chico (casi seguir de largo). Por eso se elige el máximo.
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
      const inicio = [k0 % anchoV, (k0 / anchoV) | 0];
      const anillo = [inicio];
      let actual = inicio, pasos = 0, dirEntrada = null;
      while (pasos++ < tope) {
        const k = actual[1] * anchoV + actual[0];
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

// Douglas-Peucker ITERATIVO (pila explícita de pares [ini, fin]). La versión
// recursiva desbordaba la pila de Node alrededor de los 7.000 puntos, y un
// borde de lote fragmentado los pasa de largo.
function douglasPeucker(puntos, tol) {
  if (!puntos || puntos.length < 3) return (puntos || []).slice();
  const n = puntos.length;
  const mantener = new Uint8Array(n);
  mantener[0] = 1; mantener[n - 1] = 1;
  const pila = [0, n - 1];
  while (pila.length) {
    const fin = pila.pop(), ini = pila.pop();
    if (fin - ini < 2) continue;
    const a = puntos[ini], b = puntos[fin];
    let maxD = -1, idx = -1;
    for (let i = ini + 1; i < fin; i++) {
      const d = distPuntoSegmento(puntos[i], a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { mantener[idx] = 1; pila.push(ini, idx, idx, fin); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (mantener[i]) out.push(puntos[i]);
  return out;
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

// ── Bordes compartidos entre zonas ────────────────────────
// Simplificar cada anillo por separado rompe la partición: el mismo borde
// físico entre la zona A y la zona B se simplifica dos veces, con puntos de
// partida distintos, y queda con vértices distintos de cada lado (en un raster
// realista daba 0,37 % de superficie solapada y 0,38 % sin cobertura — el
// tractor pisando dos veces o dejando una franja sin aplicar).
//
// La solución es simplificar cada CADENA de borde una sola vez y reusarla:
//   1. Se marcan los vértices "junction" de la grilla: las esquinas donde se
//      tocan 3 o más clases distintas (contando el afuera del raster como una
//      clase más) o donde dos clases se alternan en diagonal (grado 4).
//   2. Cada anillo se parte en cadenas en esos vértices. Entre dos junctions
//      consecutivas la cadena es exactamente la misma secuencia de puntos para
//      las dos zonas que la comparten (una al derecho y la otra al revés).
//   3. Cada cadena se orienta de forma canónica (la de las dos orientaciones
//      cuya secuencia de puntos es lexicográficamente menor), se simplifica una
//      vez y se cachea. La zona vecina recibe exactamente la misma cadena dada
//      vuelta → mismos vértices de los dos lados, sin solapes ni huecos.
//
// La clave de caché es la primera arista DIRIGIDA de la cadena canónica: una
// arista dirigida pertenece a una sola cadena en todo el raster (cada arista
// del borde aparece una vez por cada lado, con direcciones opuestas), así que
// no hay colisiones y no hace falta serializar la secuencia entera.

// Marca las esquinas de la grilla donde no se puede cortar "a ojo": ahí es
// donde las cadenas de borde tienen que empezar y terminar.
function marcarJunctions(g, ancho, alto) {
  const anchoV = ancho + 1;
  const esJ = new Uint8Array(anchoV * (alto + 1));
  const AFUERA = 256;
  const clsEn = (x, y) => (x < 0 || y < 0 || x >= ancho || y >= alto) ? AFUERA : g[y * ancho + x];
  for (let vy = 0; vy <= alto; vy++) {
    for (let vx = 0; vx <= ancho; vx++) {
      const a = clsEn(vx - 1, vy - 1), b = clsEn(vx, vy - 1);
      const c = clsEn(vx - 1, vy), d = clsEn(vx, vy);
      let distintas = 1;
      if (b !== a) distintas++;
      if (c !== a && c !== b) distintas++;
      if (d !== a && d !== b && d !== c) distintas++;
      // Diagonal alternada (a=d, b=c, a≠b): grado 4, el pellizco clásico.
      if (distintas >= 3 || (a === d && b === c && a !== b)) esJ[vy * anchoV + vx] = 1;
    }
  }
  return esJ;
}

function cmpPunto(p, q) {
  if (p[0] !== q[0]) return p[0] < q[0] ? -1 : 1;
  if (p[1] !== q[1]) return p[1] < q[1] ? -1 : 1;
  return 0;
}

// ¿La cadena dada vuelta es lexicográficamente menor que la cadena?
function reversaEsMenor(cad) {
  const n = cad.length;
  for (let i = 0; i < n; i++) {
    const r = cmpPunto(cad[n - 1 - i], cad[i]);
    if (r !== 0) return r < 0;
  }
  return false;                                  // palíndromo: da igual
}

function cmpSecuencia(p, q) {
  const n = Math.min(p.length, q.length);
  for (let i = 0; i < n; i++) {
    const r = cmpPunto(p[i], q[i]);
    if (r !== 0) return r;
  }
  return p.length - q.length;
}

function claveArista(p, q, anchoV, totalV) {
  return (p[1] * anchoV + p[0]) * totalV + (q[1] * anchoV + q[0]);
}

// Simplifica una cadena usando (o llenando) la caché compartida.
//
// Si la cadena es CERRADA (primer punto === último — pasa cuando el anillo
// tiene una sola junction y la cadena da toda la vuelta) no se la puede mandar
// a `douglasPeucker` directo: con los dos extremos en el mismo punto, DP
// conserva únicamente el vértice más lejano y devuelve un "spike" de área 0.
// Esas van por `simplificarAnillo`, igual que la rama sin junctions.
function simplificarCadena(cad, tol, cache, anchoV, totalV) {
  const invertida = reversaEsMenor(cad);
  const canon = invertida ? cad.slice().reverse() : cad;
  const cerrada = cmpPunto(canon[0], canon[canon.length - 1]) === 0;
  const clave = claveArista(canon[0], canon[1], anchoV, totalV);
  let s = cache.get(clave);
  if (!s) { s = cerrada ? simplificarAnillo(canon, tol) : douglasPeucker(canon, tol); cache.set(clave, s); }
  return invertida ? s.slice().reverse() : s;
}

// Simplifica un anillo cerrado partiéndolo en cadenas compartidas.
//
// Devuelve `null` cuando el anillo simplificado DEGENERA (menos de 4 puntos o
// área ~0). Lo que NO puede hacer es volver al anillo crudo: si todas las
// cadenas de este anillo colapsaron a sus extremos, la zona vecina ya está
// usando esas mismas cadenas colapsadas desde la caché, así que devolver el
// contorno sin simplificar deja las dos zonas pisándose (en un 256x256 daba
// entre 1,2 % y 2,2 % de superficie solapada con `areaMinHa = 0`). Descartarlo
// es lo correcto: el espacio que ocupaba ya quedó cubierto por la vecina.
function simplificarAnilloCompartido(anillo, tol, esJ, ancho, alto, cache) {
  const anchoV = ancho + 1, totalV = anchoV * (alto + 1);
  const abierto = anillo.slice(0, -1);
  const nv = abierto.length;
  if (nv < 4) return null;

  const idxJ = [];
  for (let i = 0; i < nv; i++) if (esJ[abierto[i][1] * anchoV + abierto[i][0]]) idxJ.push(i);

  if (!idxJ.length) {
    // Anillo sin junctions: es un borde cerrado entre exactamente dos clases
    // (o contra el afuera). Se canoniza rotando al vértice lexicográficamente
    // menor —que acá es único, porque un vértice repetido sería un pellizco y
    // por lo tanto una junction— y eligiendo la orientación menor.
    let m = 0;
    for (let i = 1; i < nv; i++) if (cmpPunto(abierto[i], abierto[m]) < 0) m = i;
    const rot = abierto.slice(m).concat(abierto.slice(0, m));
    const inv = [rot[0]].concat(rot.slice(1).reverse());
    const invertida = cmpSecuencia(inv, rot) < 0;
    const canon = invertida ? inv : rot;
    const clave = claveArista(canon[0], canon[1], anchoV, totalV);
    let s = cache.get(clave);
    if (!s) { s = simplificarAnillo(canon.concat([canon[0]]), tol); cache.set(clave, s); }
    return noDegenerado(invertida ? s.slice().reverse() : s.slice());
  }

  const salida = [];
  for (let k = 0; k < idxJ.length; k++) {
    const desde = idxJ[k], hasta = idxJ[(k + 1) % idxJ.length];
    const cad = [abierto[desde]];
    let i = desde;
    do { i = (i + 1) % nv; cad.push(abierto[i]); } while (i !== hasta);
    const s = simplificarCadena(cad, tol, cache, anchoV, totalV);
    for (let j = salida.length ? 1 : 0; j < s.length; j++) salida.push(s[j]);
  }
  return noDegenerado(salida);
}

// Un anillo de menos de 4 puntos, o de área ~0 (un "spike" de ida y vuelta por
// el mismo segmento), no es un polígono: se descarta.
function noDegenerado(anillo) {
  if (!anillo || anillo.length < 4) return null;
  return Math.abs(areaFirmada(anillo)) > 1e-9 ? anillo : null;
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

function bboxAnillo(anillo) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < anillo.length; i++) {
    const [x, y] = anillo[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// Un punto ESTRICTAMENTE interior al anillo. No sirve usar un vértice del
// borde (como hacía la asignación de huecos anterior con `h.a[0]`): un vértice
// está sobre el borde y, después de Douglas-Peucker, puede caer del lado de
// afuera del exterior que lo contiene. Como todos los vértices tienen
// coordenadas enteras (esquinas de píxel), una línea de barrido a mitad de
// camino entre dos "y" distintas no pasa por ningún vértice, y el punto medio
// del primer tramo CON ANCHO queda adentro sí o sí.
//
// Ojo con los tramos de ancho 0: si el vértice de yMin tiene una arista
// vertical de cada lado (p. ej. …[935,478],[935,475],[935,483]… — las dos
// cruzan la línea de barrido en x=935), `xs[0] === xs[1]` y el punto medio cae
// JUSTO SOBRE el borde, no adentro. Por eso se saltean los tramos de ancho 0 y,
// si en esa fila no queda ninguno, se prueba con la siguiente.
function puntoInterior(anillo) {
  const ys = [];
  for (let i = 0; i < anillo.length - 1; i++) ys.push(anillo[i][1]);
  ys.sort((a, b) => a - b);
  for (let t = 0; t + 1 < ys.length; t++) {
    if (ys[t + 1] === ys[t]) continue;                 // mismo valor: no hay franja
    const y = (ys[t] + ys[t + 1]) / 2;
    const xs = [];
    for (let i = 0, j = anillo.length - 2; i < anillo.length - 1; j = i++) {
      const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
      if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) * (xj - xi)) / (yj - yi));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    // Los tramos interiores (regla par-impar) son [xs[0],xs[1]], [xs[2],xs[3]]…
    for (let k = 0; k + 1 < xs.length; k += 2)
      if (xs[k + 1] - xs[k] > 0) return [(xs[k] + xs[k + 1]) / 2, y];
  }
  return null;
}

// ── Orquestador ───────────────────────────────────────────
// El trabajo está partido en tres para poder ofrecer la MISMA zonificación en
// versión sincrónica (`zonificar`, la que usan los tests y cualquier llamador
// que no pueda esperar) y en versión que cede el event loop (`zonificarAsync`,
// la que usa el servidor). Es un solo camino de código: `zonificarAsync` es
// `zonificar` con un `await` entre clase y clase.
function prepararZonificar({
  datos, ancho, alto, bbox, zona, sur = true,
  n = 3, areaMinHa = 0.5, nodata = 0, rango = [-0.2, 1.0], tolPx = 1,
}) {
  if (!Number.isInteger(n) || n < 2 || n > 5)
    throw new Error(`zonificar: "n" tiene que ser un entero entre 2 y 5 (llegó ${JSON.stringify(n)})`);
  if (!Number.isInteger(ancho) || ancho <= 0 || !Number.isInteger(alto) || alto <= 0)
    throw new Error(`zonificar: "ancho" y "alto" tienen que ser enteros positivos (llegaron ${JSON.stringify(ancho)}x${JSON.stringify(alto)})`);
  if (!datos || datos.length !== ancho * alto)
    throw new Error(`zonificar: "datos" tiene ${datos ? datos.length : 0} píxeles y la grilla declarada es ${ancho}x${alto} (${ancho * alto})`);
  if (!bbox || !(bbox.maxX > bbox.minX) || !(bbox.maxY > bbox.minY))
    throw new Error(`zonificar: el bbox tiene que tener ancho y alto positivos (llegó ${JSON.stringify(bbox)})`);

  const dx = (bbox.maxX - bbox.minX) / ancho;
  const dy = (bbox.maxY - bbox.minY) / alto;
  const { cortes, clases } = clasificarCuantiles(datos, n, nodata);

  let g = filtroMayoria(clases, ancho, alto, n);
  const minPx = Math.max(1, Math.round((areaMinHa * 10000) / (dx * dy)));
  // Primero se tapa el nodata moteado (nubes sueltas) y recién después se
  // funden las manchas chicas: al revés, la fusión trabaja sobre una grilla
  // agujereada y la vectorización termina rodeando cada píxel de nube.
  g = limpiarNodataChico(g, ancho, alto, minPx);
  g = fundirChicas(g, ancho, alto, minPx);

  // La fila 0 del raster es la de arriba (norte): la Y de UTM baja al avanzar.
  const aLonLat = ([px, py]) => {
    const { lat, lon } = utmALatLon(bbox.minX + px * dx, bbox.maxY - py * dy, zona, sur);
    return [lon, lat];
  };
  const valorReal = (q) => rango[0] + ((q - 1) / 253) * (rango[1] - rango[0]);

  // Junctions + caché de cadenas: compartidas por TODAS las clases, que es
  // justamente el punto (el borde entre dos zonas se simplifica una sola vez).
  const esJ = marcarJunctions(g, ancho, alto);

  return {
    datos, g, ancho, alto, bbox, zona, dx, dy, n, nodata, tolPx, cortes,
    esJ, cacheCadenas: new Map(), aLonLat, valorReal,
  };
}

// Vectoriza UNA clase y devuelve su Feature (o `null` si quedó vacía).
function featureDeClase(ctx, c) {
  const { datos, g, ancho, alto, dx, dy, nodata, tolPx, esJ, cacheCadenas, aLonLat, valorReal } = ctx;
  {
    // Los anillos que degeneran al simplificar vuelven `null` y se descartan:
    // su superficie es ~0 y el espacio ya lo cubre la zona vecina.
    const anillos = marchingSquares(g, ancho, alto, c)
      .map(a => simplificarAnilloCompartido(a, tolPx, esJ, ancho, alto, cacheCadenas))
      .filter(Boolean);
    if (!anillos.length) return null;

    const conArea = anillos.map(a => ({ a, area: areaFirmada(a) }));
    const exteriores = conArea.filter(o => o.area > 0).sort((p, q) => p.area - q.area);
    const huecos = conArea.filter(o => o.area < 0);

    const polys = exteriores.map(e => ({ ext: e.a, area: e.area, bb: bboxAnillo(e.a), huecos: [] }));
    for (const h of huecos) {
      // Punto interior del hueco + descarte por bbox: sin esto, un raster
      // 1024x1024 fragmentado se iba a un minuto sólo en asignar huecos.
      const p = puntoInterior(h.a) || h.a[0];
      let dueno = null;
      for (const q of polys) {                       // ordenados por área: el primero que contiene es el más chico
        // Islas ANIDADAS de la misma clase: A exterior, hueco B adentro, e isla
        // A de vuelta adentro de B. El punto interior del hueco puede caer
        // dentro de la isla interior, que se prueba primero por ser más chica, y
        // el hueco terminaba asignado a ella en vez de al exterior que lo
        // contiene de verdad. Un anillo que cabe DENTRO del hueco no puede ser
        // su dueño: el dueño lo contiene, así que su área es mayor.
        if (q.area <= Math.abs(h.area)) continue;
        const bb = q.bb;
        if (p[0] < bb[0] || p[0] > bb[2] || p[1] < bb[1] || p[1] > bb[3]) continue;
        if (puntoEnAnillo(p, q.ext)) { dueno = q; break; }
      }
      if (dueno) dueno.huecos.push(h);
      else console.warn(`[zonificar] hueco sin exterior contenedor en la zona ${c + 1} (área ${Math.abs(h.area).toFixed(2)} px²): se descarta del cálculo de superficie`);
    }
    if (!polys.length) return null;

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

    return {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: coordenadas },
      properties: {
        zona:       c + 1,
        dosis:      null,
        unidad:     null,
        nombre:     `Zona ${c + 1}`,
        // En escala física (ver contrato de cuantización arriba), no en DN.
        ndvi_medio: cant ? Math.round((suma / cant) * 1000) / 1000 : null,
        ha,
      },
    };
  }
}

function coleccionDe(ctx, features) {
  return {
    type: "FeatureCollection",
    properties: {
      n_zonas: ctx.n, cortes: ctx.cortes, zona_utm: ctx.zona,
      resolucion_m: Math.round(((ctx.dx + ctx.dy) / 2) * 100) / 100,
    },
    features,
  };
}

function zonificar(opciones) {
  const ctx = prepararZonificar(opciones);
  const features = [];
  for (let c = 0; c < ctx.n; c++) {
    const f = featureDeClase(ctx, c);
    if (f) features.push(f);
  }
  return coleccionDe(ctx, features);
}

// Devuelve el control al event loop: `setImmediate` (macrotask), no una promesa
// resuelta (microtask), que correría en el mismo tick y no soltaría nada.
const ceder = () => new Promise(resolver => setImmediate(resolver));

// Igual que `zonificar`, pero cediendo el event loop entre clase y clase. Un
// raster grande es varios segundos de CPU sincrónica: mientras corre, el
// proceso Node no atiende NADA (ni siquiera el timeout de 120 s de la cola de
// `services/prescripciones.js`, que por eso nunca llegaba a dispararse). Es la
// que tiene que usar el servidor; `zonificar` queda para los tests y para
// cualquier llamador que necesite el resultado sin ceder.
async function zonificarAsync(opciones) {
  const ctx = prepararZonificar(opciones);
  const features = [];
  for (let c = 0; c < ctx.n; c++) {
    await ceder();
    const f = featureDeClase(ctx, c);
    if (f) features.push(f);
  }
  return coleccionDe(ctx, features);
}

module.exports = {
  zonaUtmPorLon, latLonAUtm, utmALatLon,
  clasificarCuantiles, filtroMayoria, fundirChicas, limpiarNodataChico,
  marchingSquares, douglasPeucker, simplificarAnillo, areaFirmada,
  marcarJunctions, simplificarAnilloCompartido, puntoInterior, puntoEnAnillo,
  zonificar, zonificarAsync,
};
