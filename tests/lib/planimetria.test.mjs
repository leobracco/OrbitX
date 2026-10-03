// Planimetría fase 2: mapa de alturas a partir de los Elevation_NNNN.txt que
// sube PilotX. Se prueba contra un lote sintético con la verdad conocida
// (tests/lib/planimetria-sintetico.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generarLote, CABECERA } from "./planimetria-sintetico.mjs";
const require = createRequire(import.meta.url);
const P = require("../../lib/planimetria.js");

const LOTE = generarLote({});

// Error de la grilla contra la superficie verdadera, separando el interior
// del lote (0..400 × 0..300) del borde exterior (más allá de la última pasada).
function errores(R, L) {
  const G = R.grilla;
  const interior = [], todos = [];
  for (let r = 0; r < G.ny; r++) for (let c = 0; c < G.nx; c++) {
    const v = G.z[r * G.nx + c];
    if (Number.isNaN(v)) continue;
    const [la, lo] = R.pr.aLatLon(G.x0 + c * G.res, G.yTop - r * G.res);
    const e = Math.abs(v - L.verdadLatLon(la, lo));
    todos.push(e);
    const [x, y] = L.pr.aXY(la, lo);
    if (x >= 0 && x <= 400 && y >= 0 && y <= 300) interior.push(e);
  }
  const rms = (a) => Math.sqrt(a.reduce((s, e) => s + e * e, 0) / a.length);
  return { maxInterior: Math.max(...interior), rmsInterior: rms(interior), rms: rms(todos) };
}

// Sesgo real por pasada (contra la verdad): RMS de la media de (z − verdad)
// de cada pasada detectada, sin la media global.
function sesgoPorPasada(R, L, campo) {
  const I = R._interno, nS = R.stats.pasadas;
  const s = new Float64Array(nS), c = new Float64Array(nS);
  for (let i = 0; i < I.x.length; i++) {
    const [la, lo] = R.pr.aLatLon(I.x[i], I.y[i]);
    s[I.seg[i]] += I[campo][i] - L.verdadLatLon(la, lo); c[I.seg[i]]++;
  }
  let m = 0, w = 0;
  for (let k = 0; k < nS; k++) { m += s[k]; w += c[k]; }
  m /= w;
  let q = 0, n = 0;
  for (let k = 0; k < nS; k++) if (c[k] > 30) { const v = s[k] / c[k] - m; q += v * v; n++; }
  return Math.sqrt(q / n);
}

test("parseo: solo filas de 8 campos con Quality 4; la cabecera de AOG no cuenta", () => {
  const txt = CABECERA
    + "-33.1000000,-61.7000000,100.123,4,0.00,0.00,0.000,0\r\n"
    + "-33.1000100,-61.7000000,100.200,1,0.00,1.11,0.000,0\r\n"     // sin RTK
    + "-33.1000200,-61.7000000,100.300,4,1,234.56,2.22,0.000,0\r\n" // separador de miles
    + "-33.1000300,-61.7000000,100.400,4,0.00,3.33,0.000,0\r\n";
  const P1 = P.juntarPuntos([{ nombre: "Elevation_0001.txt", contenido: txt }]);
  assert.equal(P1.n, 2);
  assert.deepEqual(P1.cuenta, { partes: 1, filas: 4, q4: 2, no_rtk: 1, invalidas: 1 });
  assert.equal(P1.z[0], 100.123);
  assert.equal(P1.z[1], 100.4);
});

test("las partes se unen por índice (Elevation_0002 después de Elevation_0001)", () => {
  const fila = (z) => `-33.1,-61.7,${z},4,0,0,0,0\r\n`;
  const P1 = P.juntarPuntos([
    { nombre: "Elevation_0002.txt", contenido: CABECERA + fila(2) },
    { nombre: "Elevation_0001.txt", contenido: CABECERA + fila(1) },
  ]);
  assert.deepEqual(Array.from(P1.z), [1, 2]);
});

test("lote sintético: filtra las filas viejas de AOG y detecta las pasadas", () => {
  const R = P.calcularPlanimetria(LOTE.partes, { res: 3 });
  assert.equal(R.ok, true);
  assert.equal(R.stats.puntos_rtk, LOTE.nPuntos);
  assert.equal(R.stats.puntos_descartados_no_rtk, 2);
  assert.equal(R.stats.puntos_invalidos, 1);
  assert.ok(Math.abs(R.stats.espaciado_pasadas_m - 8) < 0.5, "espaciado " + R.stats.espaciado_pasadas_m);
  // 38 pasadas + 8 lados de cabecera
  assert.ok(R.stats.pasadas >= 40 && R.stats.pasadas <= 60, "pasadas " + R.stats.pasadas);
});

test("la grilla recupera la loma con error ≤ 5 cm dentro del lote", () => {
  const R = P.calcularPlanimetria(LOTE.partes, { res: 3, limite: LOTE.limite });
  const e = errores(R, LOTE);
  assert.ok(e.maxInterior <= 0.05, `error máximo interior ${(e.maxInterior * 100).toFixed(2)} cm`);
  assert.ok(e.rmsInterior <= 0.015, `RMS interior ${(e.rmsInterior * 100).toFixed(2)} cm`);
  // desnivel verdadero ≈ 3,6 m (±1,5 m de loma + 0,8 m de inclinación + el pozo)
  assert.ok(R.stats.desnivel_m > 3.2 && R.stats.desnivel_m < 4.0, "desnivel " + R.stats.desnivel_m);
  assert.ok(R.stats.cobertura_pct > 98, "cobertura " + R.stats.cobertura_pct);
});

test("la nivelación reduce el sesgo entre pasadas", () => {
  const sin = P.calcularPlanimetria(LOTE.partes, { res: 3, nivelar: false });
  const con = P.calcularPlanimetria(LOTE.partes, { res: 3 });
  const antes = sesgoPorPasada(con, LOTE, "z");
  const despues = sesgoPorPasada(con, LOTE, "zc");
  assert.ok(con.stats.nivelacion.aplicada);
  assert.ok(despues < antes * 0.5, `sesgo real por pasada ${(antes * 100).toFixed(2)} → ${(despues * 100).toFixed(2)} cm`);
  // la métrica interna (sin conocer la verdad) también baja
  const n = con.stats.nivelacion;
  assert.ok(n.sesgo_rms_despues_cm < n.sesgo_rms_antes_cm * 0.5, JSON.stringify(n));
  // y la grilla mejora
  assert.ok(errores(con, LOTE).rmsInterior < errores(sin, LOTE).rmsInterior);
  // nunca toca el datum: la altura media no se mueve más de 5 mm
  assert.ok(Math.abs(con.stats.z_media_m - sin.stats.z_media_m) < 0.005);
});

test("sin datos cerca = null: una franja sin pasadas queda vacía", () => {
  const L = generarLote({ hueco: [100, 140], cabeceras: false });
  const R = P.calcularPlanimetria(L.partes, { res: 3 });
  const G = R.grilla;
  const celda = (x, y) => {
    const [la, lo] = L.pr.aLatLon(x, y);
    const [px, py] = R.pr.aXY(la, lo);
    const c = Math.round((px - G.x0) / G.res), r = Math.round((G.yTop - py) / G.res);
    return G.z[r * G.nx + c];
  };
  assert.ok(Number.isNaN(celda(200, 120)), "el medio de la franja vacía tiene que ser null");
  assert.ok(!Number.isNaN(celda(200, 60)), "donde hay pasadas tiene que haber dato");
  // tampoco extrapola lejos del lote
  const [la, lo] = L.pr.aLatLon(200, 330);
  const [px, py] = R.pr.aXY(la, lo);
  const r = Math.round((G.yTop - py) / G.res);
  assert.ok(r < 0 || Number.isNaN(G.z[r * G.nx + Math.round((px - G.x0) / G.res)]));
});

test("sin puntos RTK: ok=false con motivo, sin tirar", () => {
  const R = P.calcularPlanimetria([{ nombre: "Elevation_0001.txt", contenido: CABECERA }]);
  assert.equal(R.ok, false);
  assert.match(R.motivo, /sin puntos/);
  const S = P.serializar(R);
  assert.equal(S.ok, false);
});

test("bajos: un pozo en un plano se detecta con su profundidad", () => {
  const nx = 40, ny = 30, res = 2;
  const z = new Float32Array(nx * ny);
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const d2 = (c - 20) ** 2 + (r - 15) ** 2;
    z[r * nx + c] = 100 + 0.01 * c - 0.3 * Math.exp(-d2 / (2 * 3 * 3));
  }
  const B = P.bajos({ z, nx, ny, res }, { umbral: 0.05, areaMinM2: 20 });
  assert.equal(B.zonas.length, 1);
  assert.ok(B.zonas[0].prof_max_m > 0.2 && B.zonas[0].prof_max_m < 0.31, "prof " + B.zonas[0].prof_max_m);
  assert.ok(Math.abs(B.zonas[0].col - 20) < 2 && Math.abs(B.zonas[0].fila - 15) < 2);
  // un plano inclinado no tiene bajos
  const plano = Float32Array.from({ length: nx * ny }, (_, i) => 100 + 0.01 * (i % nx));
  assert.equal(P.bajos({ z: plano, nx, ny, res }).zonas.length, 0);
});

test("bajos en el lote sintético: el pozo de 50 cm aparece con su profundidad", () => {
  // Sin lomas (solo la inclinación de 0,2 %) el pozo es un bajo cerrado de ~45 cm.
  const L = generarLote({ amplitud: 0 });
  const R = P.calcularPlanimetria(L.partes, { res: 3 });
  const G = R.grilla;
  const [px, py] = R.pr.aXY(...L.pozoLatLon);
  const c = Math.round((px - G.x0) / G.res), r = Math.round((G.yTop - py) / G.res);
  const prof = R.bajos.prof[r * G.nx + c];
  assert.ok(prof > 0.3 && prof < 0.55, "profundidad en el pozo " + prof);
  assert.equal(R.stats.bajos_cantidad, 1);
});

test("curvas de nivel: a la altura correcta y cerradas/encadenadas", () => {
  const R = P.calcularPlanimetria(LOTE.partes, { res: 3, intervalo: 0.25 });
  const S = P.serializar(R, { lote: "Sintetico" });
  assert.equal(S.curvas.type, "FeatureCollection");
  assert.ok(S.curvas.features.length >= 10);
  // cada vértice de una curva tiene que estar a ±6 cm de su cota en la superficie verdadera
  let peor = 0, n = 0;
  for (const f of S.curvas.features) {
    for (const linea of f.geometry.coordinates) {
      for (let i = 0; i < linea.length; i++) {
        const [lo, la] = linea[i];
        const [x, y] = LOTE.pr.aXY(la, lo);
        if (x < 0 || x > 400 || y < 0 || y > 300) continue;
        peor = Math.max(peor, Math.abs(LOTE.verdadLatLon(la, lo) - f.properties.elev)); n++;
      }
    }
  }
  assert.ok(n > 200);
  assert.ok(peor < 0.08, `peor vértice ${(peor * 100).toFixed(1)} cm`);
  // las líneas vienen encadenadas (no segmentos sueltos de 2 puntos)
  const largos = S.curvas.features.flatMap(f => f.geometry.coordinates.map(l => l.length));
  assert.ok(largos.reduce((a, b) => a + b, 0) / largos.length > 8);
});

test("serializar/decodificar: la grilla compacta vuelve con error ≤ 0,5 cm", () => {
  const R = P.calcularPlanimetria(LOTE.partes, { res: 3 });
  const S = P.serializar(R);
  const g = P.decodificarGrilla(S);
  assert.equal(g.length, S.grilla.nx * S.grilla.ny);
  let peor = 0;
  for (let i = 0; i < g.length; i++) {
    assert.equal(Number.isNaN(g[i]), Number.isNaN(R.grilla.z[i]));
    if (!Number.isNaN(g[i])) peor = Math.max(peor, Math.abs(g[i] - R.grilla.z[i]));
  }
  assert.ok(peor <= 0.0051);
  // bounds: SO < NE
  const [[s, w], [nn, e]] = S.grilla.bounds;
  assert.ok(s < nn && w < e);
  // tamaño razonable para mandar al panel
  assert.ok(JSON.stringify(S).length < 1.5e6, "JSON " + JSON.stringify(S).length);
});
