import { test } from "node:test";
import assert from "node:assert/strict";
import z from "../../lib/zonificar.js";

const {
  zonaUtmPorLon, latLonAUtm, utmALatLon,
  clasificarCuantiles, filtroMayoria, fundirChicas, limpiarNodataChico,
  marchingSquares, douglasPeucker, puntoEnAnillo, zonificar, zonificarAsync,
  marcarJunctions, simplificarAnilloCompartido, areaFirmada, puntoInterior,
} = z;

// ── Helpers compartidos ─────────────────────────────────────

// Generador congruencial lineal determinista (semilla fija, sin deps).
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Tamaños de las componentes 4-conectadas de una grilla de clases (ignora 255).
function tamanosComponentes(g, ancho, alto) {
  const visto = new Uint8Array(g.length);
  const tamanos = [];
  const pila = [];
  for (let i0 = 0; i0 < g.length; i0++) {
    if (visto[i0] || g[i0] === 255) continue;
    const clase = g[i0];
    let cuenta = 0;
    pila.length = 0; pila.push(i0); visto[i0] = 1;
    while (pila.length) {
      const i = pila.pop();
      cuenta++;
      const x = i % ancho, y = (i / ancho) | 0;
      const alrededor = [];
      if (x > 0) alrededor.push(i - 1);
      if (x < ancho - 1) alrededor.push(i + 1);
      if (y > 0) alrededor.push(i - ancho);
      if (y < alto - 1) alrededor.push(i + ancho);
      for (const j of alrededor) if (!visto[j] && g[j] === clase) { visto[j] = 1; pila.push(j); }
    }
    tamanos.push(cuenta);
  }
  return tamanos;
}

// Raster "realista": gradiente diagonal + ruido determinista, sin nodata.
function rasterRealista(ancho, alto, semilla) {
  const rand = lcg(semilla);
  const datos = new Uint8Array(ancho * alto);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const base = ((x + y) / (ancho + alto - 2)) * 220 + 15;
      const ruido = (rand() - 0.5) * 60;
      let v = Math.round(base + ruido);
      if (v < 1) v = 1; if (v > 254) v = 254;                   // nunca toca nodata (0) ni 255
      datos[y * ancho + x] = v;
    }
  }
  return datos;
}

// ¿El punto [lon, lat] cae dentro de la feature? (respeta los huecos)
function featureContiene(feature, p) {
  for (const poly of feature.geometry.coordinates) {
    if (!puntoEnAnillo(p, poly[0])) continue;
    let enHueco = false;
    for (let h = 1; h < poly.length; h++) if (puntoEnAnillo(p, poly[h])) { enHueco = true; break; }
    if (!enHueco) return true;
  }
  return false;
}

// Cuántas features cubren cada píxel del raster, con una muestra por píxel
// (offset pseudoaleatorio adentro del píxel para no caer justo sobre un
// vértice ni sobre un segmento exactamente diagonal).
//
// En vez de un point-in-polygon por muestra y por feature (65.536 x 5 x todos
// los anillos), se barre por filas: para cada feature y cada fila se calculan
// una sola vez los cruces de TODOS sus anillos con esa línea y se recorren las
// columnas con la regla par-impar. Los huecos salen gratis (van en la misma
// lista de cruces, que es justamente lo que hace par-impar).
//
// `valido` (opcional) es la grilla de clases FINAL: los píxeles que ahí quedaron
// en 255 son nodata y no tienen por qué estar cubiertos por ninguna zona; se
// cuentan aparte en `nodataCubierto`, que con `tolPx > 0` no es cero (el
// contorno contra el nodata se simplifica y puede correrse hasta ~1 px).
function coberturaPorPixel(fc, bbox, ancho, alto, zona, valido = null) {
  const dx = (bbox.maxX - bbox.minX) / ancho, dy = (bbox.maxY - bbox.minY) / alto;
  const aPixel = ([lon, lat]) => {
    const u = latLonAUtm(lat, lon, zona);
    return [(u.x - bbox.minX) / dx, (bbox.maxY - u.y) / dy];
  };
  const porFeature = fc.features.map(f => {
    const anillos = [];
    for (const poly of f.geometry.coordinates) for (const anillo of poly) anillos.push(anillo.map(aPixel));
    return anillos;
  });

  const rand = lcg(4242);
  const muestraY = new Float64Array(alto);
  for (let y = 0; y < alto; y++) muestraY[y] = y + 0.2 + rand() * 0.6;
  const muestraX = new Float64Array(ancho * alto);
  for (let i = 0; i < muestraX.length; i++) muestraX[i] = (i % ancho) + 0.2 + rand() * 0.6;

  const cuenta = new Uint8Array(ancho * alto);
  const xs = [];
  for (const anillos of porFeature) {
    for (let y = 0; y < alto; y++) {
      const sy = muestraY[y];
      xs.length = 0;
      for (const a of anillos) {
        for (let i = 0, j = a.length - 2; i < a.length - 1; j = i++) {
          const [xi, yi] = a[i], [xj, yj] = a[j];
          if ((yi > sy) !== (yj > sy)) xs.push(xi + ((sy - yi) * (xj - xi)) / (yj - yi));
        }
      }
      if (!xs.length) continue;
      xs.sort((p, q) => p - q);
      let k = 0;
      for (let x = 0; x < ancho; x++) {
        const sx = muestraX[y * ancho + x];
        while (k < xs.length && xs[k] < sx) k++;
        if (k % 2 === 1) cuenta[y * ancho + x]++;
      }
    }
  }
  let muestras = 0, sinCobertura = 0, solapados = 0, nodataCubierto = 0;
  for (let i = 0; i < cuenta.length; i++) {
    if (valido && valido[i] === 255) { if (cuenta[i] > 0) nodataCubierto++; continue; }
    muestras++;
    if (cuenta[i] === 0) sinCobertura++;
    else if (cuenta[i] > 1) solapados++;
  }
  return { muestras, sinCobertura, solapados, nodataCubierto };
}

// La grilla de clases que `zonificar` termina vectorizando, rearmada con las
// mismas funciones públicas y en el mismo orden. Sirve para saber qué píxeles
// son "válidos" (todo lo que no quedó en 255) al chequear la partición.
function grillaFinal(datos, ancho, alto, n, areaMinHa, resolucion) {
  const minPx = Math.max(1, Math.round((areaMinHa * 10000) / (resolucion * resolucion)));
  const { clases } = clasificarCuantiles(datos, n, 0);
  const g = filtroMayoria(clases, ancho, alto, n);
  return fundirChicas(limpiarNodataChico(g, ancho, alto, minPx), ancho, alto, minPx);
}

// Raster con gradiente + ruido + `pctNube` de píxeles a nodata (DN 0), que es
// como sale de `services/ndvi_raster.js` cuando la máscara de Sentinel Hub
// marca nubes sueltas. Todo determinista.
function rasterConNube(ancho, alto, semilla, pctNube, { circular = false } = {}) {
  const rand = lcg(semilla);
  const datos = new Uint8Array(ancho * alto);
  const cx = (ancho - 1) / 2, cy = (alto - 1) / 2, r = Math.min(ancho, alto) * 0.45;
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const base = ((x + y) / (ancho + alto - 2)) * 220 + 15;
      const ruido = (rand() - 0.5) * 60;
      let v = Math.round(base + ruido);
      if (v < 1) v = 1; if (v > 254) v = 254;
      const fueraDelLote = circular && Math.hypot(x - cx, y - cy) > r;
      datos[y * ancho + x] = (fueraDelLote || rand() < pctNube) ? 0 : v;
    }
  }
  return datos;
}

function contarAnillos(fc) {
  let n = 0;
  for (const f of fc.features) for (const poly of f.geometry.coordinates) n += poly.length;
  return n;
}

// Vectoriza una grilla de CLASES igual que `zonificar`, pero quedándose en
// espacio de píxeles: devuelve, por clase, la lista de {ext, huecos}.
function vectorizarClases(g, ancho, alto, nClases, tol = 1) {
  const esJ = marcarJunctions(g, ancho, alto);
  const cache = new Map();
  const porClase = [];
  for (let c = 0; c < nClases; c++) {
    const anillos = marchingSquares(g, ancho, alto, c)
      .map(a => simplificarAnilloCompartido(a, tol, esJ, ancho, alto, cache))
      .filter(Boolean);
    const conArea = anillos.map(a => ({ a, area: areaFirmada(a) }));
    const polys = conArea.filter(o => o.area > 0).sort((p, q) => p.area - q.area)
      .map(e => ({ ext: e.a, area: e.area, huecos: [] }));
    for (const h of conArea.filter(o => o.area < 0)) {
      const p = puntoInterior(h.a) || h.a[0];
      // Misma regla que `zonificar`: un exterior que cabe DENTRO del hueco no
      // puede ser su dueño. Sin esto, con islas anidadas de la misma clase el
      // hueco se le asigna a la isla interior (más chica, se prueba primero).
      let dueno = null;
      for (const q of polys) {
        if (q.area <= Math.abs(h.area)) continue;
        if (puntoEnAnillo(p, q.ext)) { dueno = q; break; }
      }
      if (dueno) dueno.huecos.push(h.a);
    }
    porClase.push(polys);
  }
  return porClase;
}

function polysContienen(polys, p) {
  for (const q of polys) {
    if (!puntoEnAnillo(p, q.ext)) continue;
    let enHueco = false;
    for (const h of q.huecos) if (puntoEnAnillo(p, h)) { enHueco = true; break; }
    if (!enHueco) return true;
  }
  return false;
}

test("zonaUtmPorLon: las zonas de la pampa húmeda", () => {
  assert.equal(zonaUtmPorLon(-60.5), 20);   // zona 20: -66 a -60
  assert.equal(zonaUtmPorLon(-64), 20);
  assert.equal(zonaUtmPorLon(-58), 21);     // zona 21: -60 a -54
  assert.equal(zonaUtmPorLon(-68), 19);
});

test("utmALatLon: en el meridiano central la longitud es exacta", () => {
  const { lat, lon } = utmALatLon(500000, 6200000, 20, true);
  assert.ok(Math.abs(lon - (-63)) < 1e-9, `lon=${lon}`);
  assert.ok(lat < -34.2 && lat > -34.5, `lat=${lat}`);
});

test("latLonAUtm ↔ utmALatLon: ida y vuelta con error submétrico", () => {
  for (const [la, lo] of [[-34.6, -60.2], [-33.1, -61.9], [-38.0, -62.5]]) {
    const u = latLonAUtm(la, lo);
    const v = utmALatLon(u.x, u.y, u.zona, true);
    assert.ok(Math.abs(v.lat - la) < 1e-7, `lat ${v.lat} vs ${la}`);
    assert.ok(Math.abs(v.lon - lo) < 1e-7, `lon ${v.lon} vs ${lo}`);
  }
});

test("clasificarCuantiles: dos mitades, un corte, sin dato = 255", () => {
  const valores = Uint8Array.from([60, 60, 200, 200, 0]);
  const { cortes, clases } = clasificarCuantiles(valores, 2, 0);
  assert.deepEqual(cortes, [60]);
  assert.deepEqual(Array.from(clases), [0, 0, 1, 1, 255]);
});

test("clasificarCuantiles: gradiente en 3 zonas reparte parejo", () => {
  const valores = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const { clases } = clasificarCuantiles(valores, 3, 0);
  const cuenta = [0, 0, 0];
  for (const c of clases) cuenta[c]++;
  assert.deepEqual(cuenta, [3, 3, 3]);
});

test("clasificarCuantiles: todo sin dato no rompe", () => {
  const { cortes, clases } = clasificarCuantiles(Uint8Array.from([0, 0, 0]), 3, 0);
  assert.deepEqual(cortes, []);
  assert.deepEqual(Array.from(clases), [255, 255, 255]);
});

test("filtroMayoria: se come el píxel suelto", () => {
  const ancho = 5, alto = 5;
  const g = new Uint8Array(ancho * alto);       // todo clase 0
  g[2 * ancho + 2] = 1;                          // un píxel clase 1 en el medio
  const out = filtroMayoria(g, ancho, alto, 2);
  assert.equal(out[2 * ancho + 2], 0);
  let unos = 0;                                  // Uint8Array no tiene filter: se cuenta a mano
  for (const v of out) if (v === 1) unos++;
  assert.equal(unos, 0);
});

test("filtroMayoria: no toca una frontera limpia", () => {
  const ancho = 6, alto = 6;
  const g = new Uint8Array(ancho * alto);
  for (let y = 3; y < 6; y++) for (let x = 0; x < 6; x++) g[y * ancho + x] = 1;
  const out = filtroMayoria(g, ancho, alto, 2);
  assert.deepEqual(Array.from(out), Array.from(g));
});

test("fundirChicas: la mancha chica se funde con el vecino", () => {
  const ancho = 6, alto = 6;
  const g = new Uint8Array(ancho * alto);       // todo clase 0
  g[0] = 1; g[1] = 1;                            // mancha de 2 píxeles
  const out = fundirChicas(g, ancho, alto, 5);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
});

test("marchingSquares: un cuadrado de 2x2 da un anillo cerrado de 8 lados", () => {
  const ancho = 6, alto = 6;
  const g = new Uint8Array(ancho * alto);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) g[y * ancho + x] = 1;
  const anillos = marchingSquares(g, ancho, alto, 1);
  assert.equal(anillos.length, 1);
  assert.equal(anillos[0].length, 9);                       // 8 aristas + cierre
  assert.deepEqual(anillos[0][0], anillos[0][8]);
});

test("douglasPeucker: tira los puntos colineales y conserva los extremos", () => {
  const p = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 3]];
  assert.deepEqual(douglasPeucker(p, 1), [[0, 0], [3, 0], [3, 3]]);
  assert.deepEqual(douglasPeucker([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]]);
});

test("zonificar: 6x6 partido en dos mitades da 2 zonas de 0,18 ha dentro del bbox", () => {
  const ancho = 6, alto = 6;
  const datos = new Uint8Array(ancho * alto);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) datos[y * ancho + x] = y < 3 ? 60 : 200;
  const bbox = { minX: 400000, minY: 6200000, maxX: 400060, maxY: 6200060 };   // 60 x 60 m, píxel de 10 m
  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n: 2, areaMinHa: 0 });

  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 2);
  assert.equal(fc.properties.n_zonas, 2);

  for (const f of fc.features) {
    assert.equal(f.geometry.type, "MultiPolygon");
    assert.equal(f.properties.dosis, null);
    assert.equal(f.properties.unidad, null);
    assert.ok(Math.abs(f.properties.ha - 0.18) < 0.005, `ha=${f.properties.ha}`);
  }
  assert.deepEqual(fc.features.map(f => f.properties.zona), [1, 2]);
  assert.deepEqual(fc.features.map(f => f.properties.nombre), ["Zona 1", "Zona 2"]);
  // La zona de menos vigor es la 1 (cuantil más bajo).
  assert.ok(fc.features[0].properties.ndvi_medio < fc.features[1].properties.ndvi_medio);

  // Todas las coordenadas caen dentro del bbox (con 1e-4° ≈ 11 m de tolerancia).
  const esquinas = [[bbox.minX, bbox.minY], [bbox.minX, bbox.maxY], [bbox.maxX, bbox.minY], [bbox.maxX, bbox.maxY]]
    .map(([x, y]) => utmALatLon(x, y, 20, true));
  const minLon = Math.min(...esquinas.map(e => e.lon)) - 1e-4;
  const maxLon = Math.max(...esquinas.map(e => e.lon)) + 1e-4;
  const minLat = Math.min(...esquinas.map(e => e.lat)) - 1e-4;
  const maxLat = Math.max(...esquinas.map(e => e.lat)) + 1e-4;
  for (const f of fc.features)
    for (const poly of f.geometry.coordinates)
      for (const anillo of poly)
        for (const [lon, lat] of anillo) {
          assert.ok(lon >= minLon && lon <= maxLon, `lon fuera del bbox: ${lon}`);
          assert.ok(lat >= minLat && lat <= maxLat, `lat fuera del bbox: ${lat}`);
        }
});

test("zonificar: el anillo exterior queda en sentido antihorario (GeoJSON RFC 7946)", () => {
  const ancho = 4, alto = 4;
  // n mínimo permitido = 2; con un raster de un solo valor sólo se puebla la
  // clase 0, así que igual queda una única feature.
  const datos = new Uint8Array(ancho * alto).fill(120);
  const fc = zonificar({ datos, ancho, alto, bbox: { minX: 400000, minY: 6200000, maxX: 400040, maxY: 6200040 }, zona: 20, n: 2, areaMinHa: 0 });
  const anillo = fc.features[0].geometry.coordinates[0][0];
  let acc = 0;
  for (let i = 0; i < anillo.length - 1; i++)
    acc += anillo[i][0] * anillo[i + 1][1] - anillo[i + 1][0] * anillo[i][1];
  assert.ok(acc > 0, `area firmada ${acc} — el exterior tiene que ser CCW`);
});

test("zonificar: sin datos válidos devuelve una colección vacía", () => {
  const fc = zonificar({ datos: new Uint8Array(16), ancho: 4, alto: 4, bbox: { minX: 0, minY: 0, maxX: 40, maxY: 40 }, zona: 20, n: 3 });
  assert.equal(fc.features.length, 0);
});

// ── Casos extra encontrados en la revisión del brief ────────

test("marchingSquares: caso ambiguo 5/10 (tablero de ajedrez) separa en dos anillos, no un ocho autointersecante", () => {
  // Dos píxeles de la misma clase que solo se tocan por una esquina en
  // diagonal: sin desambiguar, el vértice compartido tiene grado de salida 2
  // y un recorrido ingenuo (LIFO puro) los encadena en un solo anillo en
  // forma de ocho que pasa dos veces por ese vértice (polígono inválido,
  // autointersecante). Se probaron las dos diagonales posibles.
  const ancho = 5, alto = 5;

  const g1 = new Uint8Array(ancho * alto);
  g1[1 * ancho + 1] = 1;   // (1,1)
  g1[2 * ancho + 2] = 1;   // (2,2) — solo toca por la diagonal "\"
  const anillos1 = marchingSquares(g1, ancho, alto, 1);
  assert.equal(anillos1.length, 2, "diagonal \\: tienen que quedar dos anillos separados");
  for (const a of anillos1) {
    assert.equal(a.length, 5);                          // cuadrado 1x1: 4 aristas + cierre
    assert.deepEqual(a[0], a[a.length - 1]);
  }

  const g2 = new Uint8Array(ancho * alto);
  g2[1 * ancho + 2] = 1;   // (2,1)
  g2[2 * ancho + 1] = 1;   // (1,2) — diagonal "/"
  const anillos2 = marchingSquares(g2, ancho, alto, 1);
  assert.equal(anillos2.length, 2, "diagonal /: tienen que quedar dos anillos separados");
  for (const a of anillos2) {
    assert.equal(a.length, 5);
    assert.deepEqual(a[0], a[a.length - 1]);
  }
});

test("clasificarCuantiles: un valor muy repetido no deja cortes duplicados ni clases fantasma", () => {
  // 100 píxeles en 150 + 1 píxel en 200, pedido en 3 zonas: con el corte
  // original (que puede empujar el mismo valor dos veces a `cortes`) queda
  // una clase intermedia que ningún píxel puede satisfacer nunca (v > 150 y
  // v <= 150 a la vez). El fix no debe repetir el mismo valor de corte.
  const valores = new Uint8Array(101);
  for (let i = 0; i < 100; i++) valores[i] = 150;
  valores[100] = 200;
  const { cortes, clases } = clasificarCuantiles(valores, 3, 0);
  for (let i = 1; i < cortes.length; i++) assert.notEqual(cortes[i], cortes[i - 1], "no puede haber un corte repetido consecutivo");
  // Aserción real (la anterior, `cortes.length + 1 >= c + 1`, era tautológica
  // porque la clasificación nunca puede devolver c > cortes.length): con k
  // cortes tienen que quedar EXACTAMENTE k+1 clases pobladas, sin ninguna
  // clase fantasma vacía en el medio.
  const pobladas = new Set();
  for (const c of clases) if (c !== 255) pobladas.add(c);
  assert.equal(pobladas.size, cortes.length + 1, `clases pobladas ${[...pobladas].sort().join(",")} con cortes ${cortes.join(",")}`);
  for (let c = 0; c <= cortes.length; c++) assert.ok(pobladas.has(c), `la clase ${c} quedó vacía`);
});

test("zonificar: gradiente diagonal 64x64 con ruido determinista da N zonas válidas y área consistente", () => {
  // Generador congruencial lineal determinista (semilla fija, sin deps) para
  // el ruido: reproducible entre corridas.
  function lcg(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  const ancho = 64, alto = 64;
  const rand = lcg(20260923);
  const datos = new Uint8Array(ancho * alto);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const base = ((x + y) / (ancho + alto - 2)) * 220 + 15;   // gradiente diagonal ~15..235
      const ruido = (rand() - 0.5) * 16;                        // ruido determinista ±8
      let v = Math.round(base + ruido);
      if (v < 1) v = 1; if (v > 254) v = 254;                   // nunca toca nodata (0) ni 255
      datos[y * ancho + x] = v;
    }
  }

  const resolucion = 10;                                        // 10 m/píxel
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };
  const n = 4;
  const areaMinHa = 0.3;
  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n, areaMinHa });

  // Salen exactamente N zonas (el gradiente es lo bastante suave como para
  // que ninguna banda de cuantil se pierda con el ruido).
  assert.equal(fc.features.length, n);
  assert.equal(fc.properties.n_zonas, n);

  const areaTotalHa = (ancho * resolucion * alto * resolucion) / 10000;
  let sumaHa = 0;
  for (const f of fc.features) {
    assert.equal(f.geometry.type, "MultiPolygon");
    assert.ok(f.properties.ha >= areaMinHa, `zona ${f.properties.zona} con ha=${f.properties.ha} < areaMinHa=${areaMinHa}`);
    sumaHa += f.properties.ha;

    for (const poly of f.geometry.coordinates) {
      for (const anillo of poly) {
        // GeoJSON válido: anillo cerrado y con al menos 4 puntos.
        assert.ok(anillo.length >= 4, `anillo con menos de 4 puntos en zona ${f.properties.zona}`);
        assert.deepEqual(anillo[0], anillo[anillo.length - 1], `anillo no cerrado en zona ${f.properties.zona}`);
      }
    }
  }

  // La suma de las hectáreas de todas las zonas ≈ área del bbox (± 2 %).
  const diffPct = Math.abs(sumaHa - areaTotalHa) / areaTotalHa * 100;
  assert.ok(diffPct <= 2, `suma de ha ${sumaHa} vs esperado ${areaTotalHa} (${diffPct.toFixed(2)}% de diferencia)`);
});

// ── Fix post-review ─────────────────────────────────────────

test("zonificar: n fuera de 2..5 (o no entero) es un error explícito", () => {
  const base = { datos: new Uint8Array(16), ancho: 4, alto: 4, bbox: { minX: 0, minY: 0, maxX: 40, maxY: 40 }, zona: 20 };
  for (const n of [0, 1, 6, 10, 2.5, "3", null]) {
    assert.throws(() => zonificar({ ...base, n }), /entre 2 y 5/, `n=${JSON.stringify(n)} tendría que tirar Error`);
  }
  // Los del rango no tiran nada.
  for (const n of [2, 3, 4, 5]) assert.doesNotThrow(() => zonificar({ ...base, n }));
});

test("douglasPeucker: 8.000 puntos en escalera no desbordan la pila", () => {
  // Una escalera rectilínea (el borde típico de un raster fragmentado) empata
  // todas las distancias; con el desempate "gana el primero" la recursión se
  // parte de a un punto por vez y la versión recursiva reventaba alrededor de
  // los 7.000 puntos. Con 8.000 ya se pasa de ese punto de quiebre, y como DP
  // es O(n²) sobre una escalera, bajar de 15.000 a 8.000 le saca ~3 s al test
  // sin perder lo que se quiere demostrar.
  const puntos = [];
  let x = 0, y = 0;
  while (puntos.length < 8000) { puntos.push([x, y]); x++; puntos.push([x, y]); y++; }
  const out = douglasPeucker(puntos.slice(0, 8000), 0.1);
  assert.equal(out.length, 8000);                         // con tol 0,1 no se tira ningún vértice
  assert.deepEqual(out[0], puntos[0]);
  assert.deepEqual(out[out.length - 1], puntos[7999]);
});

test("fundirChicas: itera hasta punto fijo y no deja componentes huérfanas", () => {
  // Cadena A → B → fondo. A (columna de 4 px, clase 1) tiene como vecino
  // mayoritario a B (dos bloques de 9 px, clase 2), y B a su vez es chica y se
  // funde al fondo. Con una sola pasada, los 4 píxeles de A quedaban pintados
  // de clase 2 y nadie los volvía a mirar: una mancha de 4 px por debajo del
  // mínimo de 12. A arranca ANTES que B en orden de barrido (fila 4 vs 5),
  // que es justo lo que dispara el bug.
  const ancho = 20, alto = 20, minPixeles = 12;
  const g = new Uint8Array(ancho * alto);                 // fondo clase 0
  for (let y = 4; y <= 7; y++) g[y * ancho + 5] = 1;      // A: 4 px
  for (let y = 5; y <= 7; y++) {
    for (const x of [2, 3, 4, 6, 7, 8]) g[y * ancho + x] = 2;   // B: 9 px de cada lado
  }

  const out = fundirChicas(g, ancho, alto, minPixeles);
  const tamanos = tamanosComponentes(out, ancho, alto);
  assert.ok(Math.min(...tamanos) >= minPixeles,
    `quedaron componentes por debajo de ${minPixeles} px: ${tamanos.filter(t => t < minPixeles).join(", ")}`);
});

test("zonificar: raster 256x256 realista no deja manchas por debajo de areaMinHa", () => {
  const ancho = 256, alto = 256, resolucion = 10;        // 10 m/píxel → 65,536 ha
  const datos = rasterRealista(ancho, alto, 20260923);
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };
  const n = 5, areaMinHa = 0.5;

  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n, areaMinHa });
  for (const f of fc.features)
    assert.ok(f.properties.ha >= areaMinHa, `zona ${f.properties.zona} con ha=${f.properties.ha}`);

  // Chequeo fuerte, sobre los píxeles: ninguna componente 4-conectada de la
  // grilla que se vectoriza puede estar por debajo del mínimo (antes del fix
  // quedaban 10 de 39 por debajo de 50 px, ocho de un solo píxel).
  const minPx = Math.round((areaMinHa * 10000) / (resolucion * resolucion));   // 50 px
  const { clases } = clasificarCuantiles(datos, n, 0);
  const g = fundirChicas(filtroMayoria(clases, ancho, alto, n), ancho, alto, minPx);
  const chicas = tamanosComponentes(g, ancho, alto).filter(t => t < minPx);
  assert.deepEqual(chicas, [], `componentes por debajo de ${minPx} px: ${chicas.join(", ")}`);
});

test("zonificar: las zonas son una partición real del lote (sin solapes ni huecos)", () => {
  // Simplificar cada zona por separado desalineaba los bordes compartidos
  // (0,37 % de superficie solapada y 0,38 % sin cobertura). Con las cadenas de
  // borde compartidas —y sin volver nunca al anillo crudo cuando todas las
  // cadenas colapsan— cada punto del lote tiene que caer en EXACTAMENTE una
  // feature, para cualquier `areaMinHa`. Se muestrea UN PUNTO POR PÍXEL
  // (65.536 muestras sobre 256x256), no uno cada tres.
  //
  // Antes de este fix, con `areaMinHa = 0` daba 601/65.536 = 0,92 % de puntos
  // en dos zonas a la vez, y 6/65.536 con 0,05.
  const ancho = 256, alto = 256, resolucion = 10;
  const datos = rasterRealista(ancho, alto, 20260924);
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };
  const areaTotalHa = (ancho * resolucion * alto * resolucion) / 10000;

  for (const areaMinHa of [0, 0.05, 0.2, 0.5]) {
    const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n: 5, areaMinHa });
    assert.ok(fc.features.length >= 2, `areaMinHa=${areaMinHa}: hacen falta al menos 2 zonas (hay ${fc.features.length})`);

    const { muestras, sinCobertura, solapados } = coberturaPorPixel(fc, bbox, ancho, alto, 20);
    assert.ok(muestras >= 65536, `areaMinHa=${areaMinHa}: muestras insuficientes (${muestras})`);
    assert.equal(sinCobertura, 0, `areaMinHa=${areaMinHa}: ${sinCobertura}/${muestras} puntos sin cobertura`);
    assert.equal(solapados, 0, `areaMinHa=${areaMinHa}: ${solapados}/${muestras} puntos en más de una zona`);

    // Ningún anillo degenerado: una cadena cerrada mandada a Douglas-Peucker
    // devolvía un "spike" de ida y vuelta por el mismo segmento (área 0).
    for (const f of fc.features) {
      for (const poly of f.geometry.coordinates) {
        for (const anillo of poly) {
          assert.ok(anillo.length >= 4, `areaMinHa=${areaMinHa}: anillo de ${anillo.length} puntos en la zona ${f.properties.zona}`);
          assert.deepEqual(anillo[0], anillo[anillo.length - 1], `areaMinHa=${areaMinHa}: anillo sin cerrar en la zona ${f.properties.zona}`);
          const m2 = Math.abs(areaFirmada(anillo.map(([lon, lat]) => { const u = latLonAUtm(lat, lon, 20); return [u.x, u.y]; })));
          assert.ok(m2 >= 1, `areaMinHa=${areaMinHa}: anillo de área ${m2.toFixed(4)} m² en la zona ${f.properties.zona}`);
        }
      }
    }

    // Y la suma de superficies sigue coincidiendo con el bbox.
    const sumaHa = fc.features.reduce((s, f) => s + f.properties.ha, 0);
    const diffPct = Math.abs(sumaHa - areaTotalHa) / areaTotalHa * 100;
    assert.ok(diffPct <= 0.5, `areaMinHa=${areaMinHa}: suma de ha ${sumaHa} vs ${areaTotalHa} (${diffPct.toFixed(3)} %)`);
  }
});

// ── Fix post-review 2 ───────────────────────────────────────

test("zonificar: cuando todas las cadenas de un anillo colapsan, el anillo se descarta (no vuelve al contorno crudo)", () => {
  // Reproducción mínima 9x9: un ajedrez 0/1 de 2x2 pegado a la esquina de la
  // clase 0, con la clase 2 en su propio bloque. Los anillos de un solo píxel
  // del ajedrez tienen TODAS sus cadenas entre junctions, y todas colapsan a
  // sus dos extremos al simplificar. Devolviendo el contorno crudo (lo que
  // hacía `salida.length >= 4 ? salida : anillo.slice()`), esos píxeles
  // quedaban dentro de la zona 0 Y de la zona 1 a la vez.
  const ancho = 9, alto = 9;
  const g = new Uint8Array(ancho * alto).fill(1);                     // clase 1 alrededor
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) g[y * ancho + x] = 0;      // esquina 4x4
  for (let y = 6; y <= 8; y++) for (let x = 6; x <= 8; x++) g[y * ancho + x] = 2;    // bloque clase 2
  for (let y = 4; y <= 5; y++) for (let x = 4; x <= 5; x++) g[y * ancho + x] = (x + y) % 2 === 0 ? 0 : 1;

  const porClase = vectorizarClases(g, ancho, alto, 3);
  const malos = [];
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      let dentro = 0;
      for (const polys of porClase) if (polysContienen(polys, [x + 0.5, y + 0.5])) dentro++;
      if (dentro !== 1) malos.push(`(${x},${y}) en ${dentro} zonas`);
    }
  }
  assert.deepEqual(malos, [], `cada centro de píxel tiene que caer en exactamente una zona: ${malos.join("; ")}`);
});

test("fundirChicas: la isla rodeada de nodata se descarta en vez de sobrevivir bajo el mínimo", () => {
  // `services/ndvi_raster.js` enmascara lo que queda fuera del boundary y las
  // nubes como nodata, así que aparecen islitas sin ningún 4-vecino de otra
  // clase: no hay a quién fundirlas y antes sobrevivían por debajo del mínimo.
  const ancho = 12, alto = 12;
  const g = new Uint8Array(ancho * alto).fill(255);        // todo nodata
  for (const [x, y] of [[1, 1], [2, 1], [1, 2]]) g[y * ancho + x] = 0;   // isla de 3 px
  let bloque = 0;
  for (let y = 5; y < 10 && bloque < 50; y++)                            // bloque de 50 px
    for (let x = 1; x < 11 && bloque < 50; x++) { g[y * ancho + x] = 1; bloque++; }
  assert.equal(bloque, 50);

  const out = fundirChicas(g, ancho, alto, 20);
  for (const [x, y] of [[1, 1], [2, 1], [1, 2]])
    assert.equal(out[y * ancho + x], 255, `el píxel (${x},${y}) de la isla tendría que haber pasado a nodata`);
  assert.deepEqual(tamanosComponentes(out, ancho, alto), [50], "tiene que quedar una sola componente, la del bloque");

  // Y por la vía pública: una sola feature.
  const datos = new Uint8Array(ancho * alto);
  for (let i = 0; i < g.length; i++) datos[i] = g[i] === 255 ? 0 : (g[i] === 0 ? 40 : 200);
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * 10, maxY: 6200000 + alto * 10 };
  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n: 2, areaMinHa: 0.2 });   // 0,2 ha = 20 px
  assert.equal(fc.features.length, 1, `tendría que quedar una sola feature (quedaron ${fc.features.length})`);
});

test("simplificarAnilloCompartido: una cadena cerrada no colapsa a un spike de área 0", () => {
  // Grilla 7x7: bloque 3x3 de clase 1 y un píxel de clase 2 pegado a su
  // esquina por la diagonal. El vértice (2,2) toca tres clases, así que es la
  // ÚNICA junction del anillo del píxel: su cadena sale y vuelve al mismo
  // vértice (primer punto === último). Mandada a `douglasPeucker` tal cual, DP
  // se queda sólo con el vértice más lejano y devuelve [P, Q, P]: un spike de
  // área 0 que después se descarta, y el píxel de clase 2 desaparece del mapa
  // (y el hueco de la clase 0 queda con 9 px en vez de 10, desalineado del
  // borde real). Yendo por `simplificarAnillo`, el anillo se conserva.
  const ancho = 7, alto = 7;
  const g = new Uint8Array(ancho * alto);                             // clase 0 de fondo
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) g[y * ancho + x] = 1;
  g[1 * ancho + 1] = 2;

  const porClase = vectorizarClases(g, ancho, alto, 3);
  assert.equal(porClase[2].length, 1, "el píxel de clase 2 tiene que sobrevivir como polígono");
  assert.equal(Math.abs(areaFirmada(porClase[2][0].ext)), 1, "y con área 1 px², no 0");

  // Cada centro de píxel cae en exactamente una clase, y en la que le toca.
  const malos = [];
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const dentro = [];
      for (let c = 0; c < 3; c++) if (polysContienen(porClase[c], [x + 0.5, y + 0.5])) dentro.push(c);
      if (dentro.length !== 1 || dentro[0] !== g[y * ancho + x]) malos.push(`(${x},${y}) esperaba ${g[y * ancho + x]} y dio [${dentro}]`);
    }
  }
  assert.deepEqual(malos, [], malos.join("; "));
});

test("puntoInterior: no cae sobre una arista cuando el vértice de yMin tiene verticales de los dos lados", () => {
  // Las dos aristas pegadas a (935,475) son verticales en x=935, así que la
  // línea de barrido entre 475 y 478 las corta a las dos en el MISMO x:
  // xs[0] === xs[1] y el punto medio queda justo sobre el borde, no adentro.
  const a = [[935, 478], [935, 475], [935, 483], [945, 483], [945, 478], [935, 478]];
  const p = puntoInterior(a);
  assert.ok(p, "tiene que encontrar un punto interior");
  assert.ok(puntoEnAnillo(p, a), `el punto ${JSON.stringify(p)} cayó sobre el borde, no adentro`);
});

// ── Revisión final de la Pieza 1 ────────────────────────────

test("limpiarNodataChico: tapa el moteado de nubes y respeta el nodata grande y el del borde", () => {
  // 20x20 de clase 0 con: un píxel suelto de nodata en el medio (nube), un
  // bloque grande de nodata (nube de verdad) y una franja de nodata pegada al
  // borde izquierdo (lo que queda fuera del contorno del lote).
  const ancho = 20, alto = 20, minPixeles = 10;
  const g = new Uint8Array(ancho * alto);                      // todo clase 0
  g[10 * ancho + 10] = 255;                                    // nube de 1 px
  for (let y = 3; y <= 7; y++) for (let x = 12; x <= 17; x++) g[y * ancho + x] = 255;   // 30 px
  for (let y = 0; y < alto; y++) g[y * ancho] = 255;           // franja contra el borde

  const out = limpiarNodataChico(g, ancho, alto, minPixeles);
  assert.equal(out[10 * ancho + 10], 0, "el píxel suelto de nube se rellena con la clase vecina");
  assert.equal(out[5 * ancho + 14], 255, "el nodata grande se conserva");
  assert.equal(out[5 * ancho], 255, "el nodata que toca el borde se conserva");

  // Con dos clases alrededor, gana la que comparte más borde con el hueco.
  const h = new Uint8Array(ancho * alto);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) h[y * ancho + x] = x < 10 ? 0 : 1;
  h[10 * ancho + 12] = 255;                                    // hueco rodeado de clase 1
  assert.equal(limpiarNodataChico(h, ancho, alto, minPixeles)[10 * ancho + 12], 1);
});

test("zonificar: 512x512 con 5 % de nube no explota en anillos ni en tamaño", () => {
  // C3. `services/ndvi_raster.js` manda a nodata cada píxel que la máscara de
  // Sentinel Hub da por nublado, y las nubes vienen moteadas: cada píxel suelto
  // era un agujero de 1 px con su propio anillo. Medido sobre este mismo raster
  // con el código anterior: 8.721 anillos, 2,52 MB de GeoJSON y 1.346 ms (y el
  // mismo raster a 1024x1024 daba 34.365 anillos, 10,2 MB y 12,9 s de CPU
  // sincrónica, con el event loop bloqueado todo ese rato).
  const ancho = 512, alto = 512, resolucion = 10, n = 5, areaMinHa = 0.5;
  const datos = rasterConNube(ancho, alto, 20260925, 0.05);
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };

  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n, areaMinHa });
  const anillos = contarAnillos(fc);
  const mb = JSON.stringify(fc).length / 1048576;
  assert.ok(anillos < 2000, `quedaron ${anillos} anillos`);
  assert.ok(mb < 1.5, `el GeoJSON pesa ${mb.toFixed(2)} MB`);

  // Y sobre los píxeles VÁLIDOS (los que no quedaron en nodata) la partición
  // sigue siendo exacta: ni uno sin cubrir, ni uno en dos zonas.
  const g = grillaFinal(datos, ancho, alto, n, areaMinHa, resolucion);
  const { muestras, sinCobertura, solapados } = coberturaPorPixel(fc, bbox, ancho, alto, 20, g);
  assert.ok(muestras > 250000, `muestras válidas insuficientes (${muestras})`);
  assert.equal(sinCobertura, 0, `${sinCobertura}/${muestras} píxeles válidos sin cobertura`);
  assert.equal(solapados, 0, `${solapados}/${muestras} píxeles válidos en más de una zona`);
});

test("zonificar: partición exacta con máscara circular del lote + nubes", () => {
  // El caso real: fuera del contorno del lote todo es nodata (y toca el borde
  // del raster, así que se conserva) más nubes moteadas adentro. Se chequea con
  // tolPx = 0 porque contra el nodata NO hay zona vecina que comparta la cadena:
  // con tolPx = 1 el contorno se simplifica y puede correrse hasta ~1 px (es lo
  // que documenta la cabecera del módulo). Los solapes, en cambio, no se
  // perdonan con ningún tolPx.
  const ancho = 128, alto = 128, resolucion = 10, n = 4, areaMinHa = 0.2;
  const datos = rasterConNube(ancho, alto, 20260926, 0.05, { circular: true });
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };
  const g = grillaFinal(datos, ancho, alto, n, areaMinHa, resolucion);

  const exacta = zonificar({ datos, ancho, alto, bbox, zona: 20, n, areaMinHa, tolPx: 0 });
  const r0 = coberturaPorPixel(exacta, bbox, ancho, alto, 20, g);
  assert.ok(r0.muestras > 9000, `muestras válidas insuficientes (${r0.muestras})`);
  assert.equal(r0.sinCobertura, 0, `${r0.sinCobertura}/${r0.muestras} píxeles válidos sin cobertura`);
  assert.equal(r0.solapados, 0, `${r0.solapados}/${r0.muestras} píxeles válidos en más de una zona`);
  assert.equal(r0.nodataCubierto, 0, "con tolPx 0 ninguna zona puede pisar el nodata");

  const suave = zonificar({ datos, ancho, alto, bbox, zona: 20, n, areaMinHa });
  const r1 = coberturaPorPixel(suave, bbox, ancho, alto, 20, g);
  assert.equal(r1.solapados, 0, `${r1.solapados}/${r1.muestras} píxeles en más de una zona con tolPx 1`);
  assert.ok(r1.sinCobertura / r1.muestras < 0.01, `tolPx 1 corrió el contorno demasiado: ${r1.sinCobertura}/${r1.muestras}`);
});

test("asignación de huecos: islas anidadas de la misma clase — el hueco va al exterior que lo contiene", () => {
  // I13. Anillos concéntricos: clase 0 de fondo, anillo de clase 1, e isla de
  // clase 0 de vuelta adentro. El hueco de la clase 0 (el que dibuja el borde
  // exterior del anillo) mide 13x13 = 169 px² y su punto interior es el centro
  // (10,5 ; 10,5), que cae DENTRO de la isla interior de 7x7 = 49 px². Como los
  // exteriores se prueban de menor a mayor área, la isla se probaba primero y se
  // quedaba con el hueco: la isla se vaciaba entera (su exterior de 49 con un
  // hueco de 169 encima) y el exterior grande se quedaba sin hueco, pisando todo
  // el anillo de la clase 1. Medido con el código anterior: 120 de 441 centros
  // de píxel mal cubiertos (los 120 del anillo, en dos zonas a la vez).
  const ancho = 21, alto = 21;
  const g = new Uint8Array(ancho * alto);                                             // fondo clase 0
  for (let y = 4; y <= 16; y++) for (let x = 4; x <= 16; x++) g[y * ancho + x] = 1;   // anillo clase 1
  for (let y = 7; y <= 13; y++) for (let x = 7; x <= 13; x++) g[y * ancho + x] = 0;   // isla clase 0

  const porClase = vectorizarClases(g, ancho, alto, 2);
  const malos = [];
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const dentro = [];
      for (let c = 0; c < 2; c++) if (polysContienen(porClase[c], [x + 0.5, y + 0.5])) dentro.push(c);
      if (dentro.length !== 1 || dentro[0] !== g[y * ancho + x]) malos.push(`(${x},${y}) esperaba ${g[y * ancho + x]} y dio [${dentro}]`);
    }
  }
  assert.deepEqual(malos, [], `${malos.length} píxeles mal cubiertos: ${malos.slice(0, 5).join("; ")}`);

  // Y el hueco quedó colgado del exterior grande, no de la isla.
  const [isla, marco] = porClase[0];
  assert.equal(isla.huecos.length, 0, "la isla interior no tiene que tener huecos");
  assert.equal(marco.huecos.length, 1, "el hueco es del exterior que lo contiene");
});

test("zonificar: valida que datos y bbox sean coherentes con la grilla", () => {
  const bbox = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
  assert.throws(() => zonificar({ datos: new Uint8Array(15), ancho: 4, alto: 4, bbox, zona: 20, n: 2 }), /15 píxeles/);
  assert.throws(() => zonificar({ datos: null, ancho: 4, alto: 4, bbox, zona: 20, n: 2 }), /datos/);
  assert.throws(() => zonificar({ datos: new Uint8Array(16), ancho: 0, alto: 4, bbox, zona: 20, n: 2 }), /enteros positivos/);
  assert.throws(() => zonificar({ datos: new Uint8Array(16), ancho: 4, alto: 4, bbox: { minX: 0, minY: 0, maxX: 0, maxY: 40 }, zona: 20, n: 2 }), /bbox/);
  assert.throws(() => zonificar({ datos: new Uint8Array(16), ancho: 4, alto: 4, bbox: { minX: 0, minY: 40, maxX: 40, maxY: 0 }, zona: 20, n: 2 }), /bbox/);
  assert.doesNotThrow(() => zonificar({ datos: new Uint8Array(16), ancho: 4, alto: 4, bbox, zona: 20, n: 2 }));
});

test("zonificarAsync: mismo resultado que la sincrónica, cediendo el event loop", async () => {
  const ancho = 64, alto = 64, resolucion = 10;
  const datos = rasterConNube(ancho, alto, 20260927, 0.03);
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };
  const args = { datos, ancho, alto, bbox, zona: 20, n: 4, areaMinHa: 0.2 };

  // Un `setImmediate` encolado ANTES de arrancar tiene que haber corrido cuando
  // la zonificación termina. Si el trabajo fuera sincrónico (o si el `await`
  // fuera sólo un microtask), la promesa resolvería antes que la fase de check
  // y esta bandera seguiría en false.
  let cedio = false;
  setImmediate(() => { cedio = true; });
  const salida = await zonificarAsync(args);

  assert.ok(cedio, "zonificarAsync tiene que soltar el event loop mientras trabaja");
  assert.deepEqual(salida, zonificar(args));
});
