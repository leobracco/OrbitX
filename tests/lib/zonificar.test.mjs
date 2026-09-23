import { test } from "node:test";
import assert from "node:assert/strict";
import z from "../../lib/zonificar.js";

const {
  zonaUtmPorLon, latLonAUtm, utmALatLon,
  clasificarCuantiles, filtroMayoria, fundirChicas,
  marchingSquares, douglasPeucker, puntoEnAnillo, zonificar,
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
  assert.equal(out.filter ? 0 : 0, 0);           // Uint8Array no tiene filter: se cuenta a mano
  let unos = 0;
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

test("douglasPeucker: 15.000 puntos en escalera no desbordan la pila", () => {
  // Una escalera rectilínea (el borde típico de un raster fragmentado) empata
  // todas las distancias; con el desempate "gana el primero" la recursión se
  // parte de a un punto por vez y la versión recursiva reventaba alrededor de
  // los 7.000 puntos. La versión iterativa tiene que aguantar mucho más.
  const puntos = [];
  let x = 0, y = 0;
  while (puntos.length < 15000) { puntos.push([x, y]); x++; puntos.push([x, y]); y++; }
  const out = douglasPeucker(puntos.slice(0, 15000), 0.1);
  assert.equal(out.length, 15000);                        // con tol 0,1 no se tira ningún vértice
  assert.deepEqual(out[0], puntos[0]);
  assert.deepEqual(out[out.length - 1], puntos[14999]);
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
  // borde compartidas, cada punto del lote tiene que caer en EXACTAMENTE una
  // feature.
  const ancho = 256, alto = 256, resolucion = 10;
  const datos = rasterRealista(ancho, alto, 20260924);
  const bbox = { minX: 400000, minY: 6200000, maxX: 400000 + ancho * resolucion, maxY: 6200000 + alto * resolucion };
  const n = 5, areaMinHa = 0.5;
  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n, areaMinHa });
  assert.ok(fc.features.length >= 2, `hacen falta al menos 2 zonas para que el test signifique algo (hay ${fc.features.length})`);

  const dx = (bbox.maxX - bbox.minX) / ancho, dy = (bbox.maxY - bbox.minY) / alto;
  const rand = lcg(4242);
  let muestras = 0, sinCobertura = 0, solapados = 0;
  for (let y = 0; y < alto; y += 3) {
    for (let x = 0; x < ancho; x += 3) {
      // Offset pseudoaleatorio dentro del píxel: evita caer justo sobre un
      // vértice o sobre un segmento exactamente diagonal.
      const px = x + 0.2 + rand() * 0.6, py = y + 0.2 + rand() * 0.6;
      const { lat, lon } = utmALatLon(bbox.minX + px * dx, bbox.maxY - py * dy, 20, true);
      let dentro = 0;
      for (const f of fc.features) if (featureContiene(f, [lon, lat])) dentro++;
      muestras++;
      if (dentro === 0) sinCobertura++;
      else if (dentro > 1) solapados++;
    }
  }
  assert.ok(muestras >= 5000, `muestras insuficientes: ${muestras}`);
  assert.equal(sinCobertura, 0, `${sinCobertura}/${muestras} puntos sin cobertura`);
  assert.equal(solapados, 0, `${solapados}/${muestras} puntos en más de una zona`);

  // Y la suma de superficies sigue coincidiendo con el bbox.
  const areaTotalHa = (ancho * resolucion * alto * resolucion) / 10000;
  const sumaHa = fc.features.reduce((s, f) => s + f.properties.ha, 0);
  const diffPct = Math.abs(sumaHa - areaTotalHa) / areaTotalHa * 100;
  assert.ok(diffPct <= 0.5, `suma de ha ${sumaHa} vs ${areaTotalHa} (${diffPct.toFixed(3)} %)`);
});
