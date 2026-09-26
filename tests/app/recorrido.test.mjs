// recorrido.test.mjs — Las funciones puras del modo "recorrido del día" del
// mapa. Los casos salen de lo que devuelve de verdad
// GET /api/tracking/history/:deviceId: buckets de 1 minuto mezclados con
// documentos `tracking_point` legacy (llegan desordenados), puntos posteados
// sin fix (lat/lon en 0 porque PilotX hace `parseFloat(lat)||0`) y jornadas
// de decenas de miles de puntos que no se pueden dibujar en un celular.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizarRecorrido, rangoHorario, simplificarTraza,
} from "../../app/pantallas/mapa.js";

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0); // 2026-09-25 10:00 UTC

// Genera una traza recta hacia el este: `metros` entre punto y punto.
function traza(n, metros = 2, desde = T0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({ lat: -34.6, lon: -60.9 + (i * metros) / (111320 * Math.cos(-34.6 * Math.PI / 180)), ts: desde + i * 1000 });
  }
  return pts;
}

// ── normalizarRecorrido ────────────────────────────────────────────────

test("sin recorrido devuelve lista vacía, no revienta", () => {
  assert.deepEqual(normalizarRecorrido(null), []);
  assert.deepEqual(normalizarRecorrido(undefined), []);
  assert.deepEqual(normalizarRecorrido({}), []);
  assert.deepEqual(normalizarRecorrido({ device_id: "pc-01", date: "2026-09-25", points: [], resumen: {} }), []);
  assert.deepEqual(normalizarRecorrido([]), []);
});

test("acepta la respuesta completa del endpoint o el array pelado", () => {
  const p = { lat: -34.6, lon: -60.9, ts: T0, speed: 7.5, field: "Lote 4" };
  assert.equal(normalizarRecorrido({ points: [p] }).length, 1);
  assert.equal(normalizarRecorrido([p]).length, 1);
  const [q] = normalizarRecorrido({ points: [p] });
  assert.deepEqual(q, { lat: -34.6, lon: -60.9, ts: T0, speed: 7.5, field: "Lote 4" });
});

test("descarta puntos con coordenadas inválidas o nulas", () => {
  const puntos = normalizarRecorrido({ points: [
    { lat: -34.6, lon: -60.9, ts: T0 },          // válido
    null,                                         // basura
    "no soy un punto",                            // basura
    { lat: null, lon: -60.9, ts: T0 + 1000 },     // lat nula
    { lat: -34.6, lon: undefined, ts: T0 + 2000 },// lon indefinida
    { lat: "abc", lon: -60.9, ts: T0 + 3000 },    // lat no numérica
    { lat: -34.6, lon: -60.9, ts: "ayer" },       // ts no numérico
    { lat: 0, lon: 0, ts: T0 + 4000 },            // posteado sin fix
    { lat: -95, lon: -60.9, ts: T0 + 5000 },      // fuera de rango
    { lat: -34.6, lon: 200, ts: T0 + 6000 },      // fuera de rango
    { lat: -34.61, lon: -60.91, ts: T0 + 7000 },  // válido
  ] });
  assert.equal(puntos.length, 2);
  assert.deepEqual(puntos.map(p => p.ts), [T0, T0 + 7000]);
});

test("ordena por hora: buckets y tracking_point legacy vienen mezclados", () => {
  const puntos = normalizarRecorrido({ points: [
    { lat: -34.60, lon: -60.90, ts: T0 + 3000 },
    { lat: -34.61, lon: -60.91, ts: T0 },
    { lat: -34.62, lon: -60.92, ts: T0 + 1000 },
  ] });
  assert.deepEqual(puntos.map(p => p.ts), [T0, T0 + 1000, T0 + 3000]);
});

test("speed y field faltantes quedan en valores mansos", () => {
  const [p] = normalizarRecorrido({ points: [{ lat: -34.6, lon: -60.9, ts: T0 }] });
  assert.equal(p.speed, 0);
  assert.equal(p.field, "");
});

// ── rangoHorario ───────────────────────────────────────────────────────

test("el rango horario de una lista vacía es null", () => {
  assert.equal(rangoHorario([]), null);
  assert.equal(rangoHorario(null), null);
  assert.equal(rangoHorario(undefined), null);
});

test("un solo punto: el rango arranca y termina ahí", () => {
  const r = rangoHorario([{ lat: -34.6, lon: -60.9, ts: T0 }]);
  assert.deepEqual(r, { desde: T0, hasta: T0, minutos: 0 });
});

test("el rango horario toma el primero y el último punto del día", () => {
  const r = rangoHorario(traza(3, 2, T0).concat([{ lat: -34.6, lon: -60.9, ts: T0 + 8 * 3600 * 1000 }]));
  assert.equal(r.desde, T0);
  assert.equal(r.hasta, T0 + 8 * 3600 * 1000);
  assert.equal(r.minutos, 480);
});

test("el rango no depende del orden ni se cae con un ts roto", () => {
  const r = rangoHorario([
    { ts: T0 + 60000 }, { ts: null }, { ts: T0 }, { ts: "x" }, { ts: T0 + 30000 },
  ]);
  assert.deepEqual(r, { desde: T0, hasta: T0 + 60000, minutos: 1 });
  assert.equal(rangoHorario([{ ts: null }, { ts: "x" }]), null);
});

// ── simplificarTraza ───────────────────────────────────────────────────

test("simplificar una lista vacía o de un punto la deja igual", () => {
  assert.deepEqual(simplificarTraza([]), []);
  assert.deepEqual(simplificarTraza(null), []);
  assert.deepEqual(simplificarTraza(undefined), []);
  const uno = [{ lat: -34.6, lon: -60.9, ts: T0 }];
  assert.deepEqual(simplificarTraza(uno), uno);
  const dos = traza(2);
  assert.deepEqual(simplificarTraza(dos), dos);
});

test("la simplificación conserva siempre el primero y el último punto", () => {
  const origen = traza(5000, 2); // jornada típica a 1 Hz y ~7 km/h
  const simple = simplificarTraza(origen);
  assert.equal(simple[0], origen[0]);
  assert.equal(simple[simple.length - 1], origen[origen.length - 1]);
});

test("descarta los puntos que caen a menos del umbral", () => {
  // 3 m entre puntos y umbral de 8 m → se conserva 1 de cada 3 (9 m).
  const origen = traza(301, 3);
  const simple = simplificarTraza(origen, 8);
  assert.ok(simple.length < origen.length / 2, `quedaron ${simple.length} de ${origen.length}`);
  assert.ok(simple.length > 90, `quedaron ${simple.length}, se comió la traza`);
  // Ningún par consecutivo intermedio queda a menos de 8 m (el último sí
  // puede: se conserva sí o sí). Tolerancia por el redondeo de las lon.
  for (let i = 1; i < simple.length - 1; i++) {
    const dx = (simple[i].lon - simple[i - 1].lon) * 111320 * Math.cos(-34.6 * Math.PI / 180);
    assert.ok(Math.abs(dx) >= 8 - 0.01, `punto ${i} a ${Math.abs(dx).toFixed(2)} m`);
  }
});

test("la máquina parada colapsa a un punto y no infla la traza", () => {
  // 600 posteos sin moverse (carga de semilla) + un tramo real.
  const quieto = [];
  for (let i = 0; i < 600; i++) quieto.push({ lat: -34.6, lon: -60.9, ts: T0 + i * 1000 });
  const simple = simplificarTraza(quieto);
  assert.equal(simple.length, 2); // el primero y el último, nada en el medio
});

test("el techo duro limita los vértices aunque la jornada sea enorme", () => {
  // 30.000 puntos separados 50 m: el filtro por distancia no saca ninguno,
  // así que tiene que entrar a jugar el diezmado.
  const origen = traza(30000, 50);
  const simple = simplificarTraza(origen, 8, 2000);
  assert.ok(simple.length <= 2001, `quedaron ${simple.length} vértices`);
  assert.equal(simple[0], origen[0]);
  assert.equal(simple[simple.length - 1], origen[origen.length - 1]);
});

test("puntos rotos que se filtraron mal no rompen la simplificación", () => {
  const origen = [
    { lat: -34.6, lon: -60.9, ts: T0 },
    { lat: null, lon: null, ts: T0 + 1000 },
    { lat: -34.7, lon: -61.0, ts: T0 + 2000 },
  ];
  const simple = simplificarTraza(origen);
  assert.equal(simple[0], origen[0]);
  assert.equal(simple[simple.length - 1], origen[origen.length - 1]);
  assert.ok(!simple.includes(origen[1])); // el punto nulo no se dibuja
});

test("normalizar + simplificar encadenados dan algo dibujable", () => {
  const resp = { device_id: "pc-01", date: "2026-09-25", points: traza(20000, 2), resumen: { km_total: 40 } };
  const puntos = simplificarTraza(normalizarRecorrido(resp));
  assert.ok(puntos.length > 1 && puntos.length <= 2001, `quedaron ${puntos.length}`);
  assert.equal(puntos[0].ts, T0);
  assert.equal(puntos[puntos.length - 1].ts, T0 + 19999 * 1000);
});
