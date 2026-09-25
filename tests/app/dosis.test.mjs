// dosis.test.mjs — Pintado del recorrido por la dosis real de QuantiX.
//
// El dato es el `qx` que viaja con cada punto de GET /api/tracking/history:
// un registro por motor con lo que pidió PilotX (`obj`) contra lo que contó el
// sensor (`real`), más `seccion_on` y la unidad. El contrato exacto está en
// normalizarQx (routes/tracking.js).
//
// Lo que se prueba acá es la decisión: con qué color queda un punto que tiene
// 24 motores, cómo se agrupan los puntos en tramos para no dibujar mil
// polilíneas, y que el día sin dosificación —el caso de HOY en producción,
// donde ningún equipo manda `qx`— salga por el camino manso.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clasificarDosis, agruparTramos, resumenDosis, ESTADOS_DOSIS,
  simplificarTraza, normalizarRecorrido,
} from "../../app/pantallas/mapa.js";
import { UMBRAL_DESVIO } from "../../app/pantallas/equipos.js";

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);

// Un motor tal como lo devuelve el server: todos los campos presentes.
function motor(over = {}) {
  return {
    uid: "QX-A", id: 1, pps_obj: 100, pps_real: 100,
    obj: 6, real: 6, unidad: "sem_m", pwm: 1800, carga_pct: 40,
    seccion_on: true, cortes: [], ...over,
  };
}
// Un punto del recorrido; `qx` sólo si se lo pasan (igual que el server).
function punto(i = 0, qx = null) {
  const p = { lat: -34.6, lon: -60.9 + i * 0.001, ts: T0 + i * 1000, speed: 7, field: "Lote 4" };
  if (qx) p.qx = qx;
  return p;
}

// ── clasificarDosis: un punto, varios motores ──────────────────────────

test("un punto sin qx no tiene dato de dosificación (el caso de hoy)", () => {
  for (const p of [undefined, null, {}, punto(0), { qx: [] }, { qx: "no soy una lista" }]) {
    assert.equal(clasificarDosis(p).estado, "sin_dato");
  }
});

test("qx con basura adentro no revienta ni inventa un estado", () => {
  assert.equal(clasificarDosis({ qx: [null, "x", 7] }).estado, "sin_dato");
});

test("todos los motores en objetivo pintan verde", () => {
  const c = clasificarDosis(punto(0, [motor(), motor({ id: 2 }), motor({ id: 3, real: 6.3 })]));
  assert.equal(c.estado, "ok");
  assert.equal(c.total, 3);
  assert.equal(c.abiertos, 3);
  assert.equal(c.cerrados, 0);
});

test("EL CRITERIO: manda el peor motor, no el promedio", () => {
  // 23 surcos clavados en el objetivo y uno que no tira nada. El promedio se
  // movería 4% (verde) y el bache desaparecería del mapa; el peor motor lo
  // pinta rojo, que es para lo que se mira este mapa.
  const motores = [];
  for (let i = 1; i <= 23; i++) motores.push(motor({ id: i }));
  motores.push(motor({ id: 24, real: 0 }));
  const c = clasificarDosis(punto(0, motores));
  assert.equal(c.estado, "critico");
  assert.equal(c.peor.id, 24);
});

test("un solo motor pasado de rosca alcanza para el ámbar", () => {
  const c = clasificarDosis(punto(0, [motor(), motor({ id: 2, real: 6 * (1 + UMBRAL_DESVIO) })]));
  assert.equal(c.estado, "desviado");
  assert.equal(c.peor.id, 2);
  assert.ok(Math.abs(c.desvio - UMBRAL_DESVIO) < 1e-9);
});

test("justo abajo del umbral todavía es objetivo (mismo criterio que Equipos)", () => {
  const c = clasificarDosis(punto(0, [motor({ real: 6 * (1 + UMBRAL_DESVIO / 2) })]));
  assert.equal(c.estado, "ok");
});

test("a igual severidad gana el motor que más se despegó", () => {
  const c = clasificarDosis(punto(0, [
    motor({ id: 1, real: 6 * 0.85 }),  // 15% abajo
    motor({ id: 2, real: 6 * 1.40 }),  // 40% arriba
    motor({ id: 3, real: 6 * 0.88 }),  // 12% abajo
  ]));
  assert.equal(c.estado, "desviado");
  assert.equal(c.peor.id, 2);
});

test("rojo le gana a ámbar aunque el ámbar esté más desviado en valor", () => {
  const c = clasificarDosis(punto(0, [
    motor({ id: 1, real: 6 * 3 }),   // 200% arriba, pero sigue dosificando
    motor({ id: 2, real: 0 }),       // no tira nada: esto es lo grave
  ]));
  assert.equal(c.estado, "critico");
  assert.equal(c.peor.id, 2);
});

test("sección cerrada: no sembraba, no es un problema", () => {
  const c = clasificarDosis(punto(0, [
    motor({ id: 1, seccion_on: false, real: 0 }),
    motor({ id: 2, seccion_on: false, real: 0 }),
  ]));
  assert.equal(c.estado, "cerrado");
  assert.equal(c.cerrados, 2);
  assert.equal(c.abiertos, 0);
  assert.equal(c.peor, null);
});

test("los motores cerrados no arrastran el color: manda el que sí sembraba", () => {
  const c = clasificarDosis(punto(0, [
    motor({ id: 1, seccion_on: false, real: 0 }), // apagado a propósito
    motor({ id: 2 }),                              // en objetivo
  ]));
  assert.equal(c.estado, "ok");
  assert.equal(c.cerrados, 1);
  assert.equal(c.abiertos, 1);
});

test("objetivo en cero: no hay contra qué comparar, queda neutro", () => {
  // Sección abierta y dosis sin cargar en la pantalla. Ni verde (no se sabe)
  // ni rojo (el motor no tiene la culpa): gris.
  assert.equal(clasificarDosis(punto(0, [motor({ obj: 0, real: 0 })])).estado, "sin_dato");
  assert.equal(clasificarDosis(punto(0, [motor({ obj: 0, real: 5 })])).estado, "sin_dato");
  // Y con objetivo en cero en TODOS no se puede decir "no sembraba": eso
  // sería inventar que las secciones estaban cerradas.
  const c = clasificarDosis(punto(0, [motor({ obj: 0 }), motor({ id: 2, seccion_on: false })]));
  assert.equal(c.estado, "sin_dato");
});

test("objetivo cargado y el sensor en cero es la alarma roja", () => {
  const c = clasificarDosis(punto(0, [motor({ real: 0 })]));
  assert.equal(c.estado, "critico");
  assert.equal(c.desvio, -1);
});

test("el umbral se puede apretar y el estado acompaña", () => {
  const p = punto(0, [motor({ real: 6 * 1.05 })]); // 5% arriba
  assert.equal(clasificarDosis(p).estado, "ok");
  assert.equal(clasificarDosis(p, 0.02).estado, "desviado");
});

// ── agruparTramos ──────────────────────────────────────────────────────

test("agrupar una lista vacía da cero tramos", () => {
  assert.deepEqual(agruparTramos([]), []);
  assert.deepEqual(agruparTramos(null), []);
  assert.deepEqual(agruparTramos(undefined), []);
});

test("un solo punto es un solo tramo de un punto", () => {
  const tramos = agruparTramos([punto(0, [motor()])]);
  assert.equal(tramos.length, 1);
  assert.equal(tramos[0].estado, "ok");
  assert.equal(tramos[0].puntos.length, 1);
});

test("todos iguales: un solo tramo (no una polilínea por punto)", () => {
  const pts = [];
  for (let i = 0; i < 500; i++) pts.push(punto(i, [motor()]));
  const tramos = agruparTramos(pts);
  assert.equal(tramos.length, 1);
  assert.equal(tramos[0].puntos.length, 500);
});

test("un día entero sin qx es un solo tramo gris", () => {
  const pts = [];
  for (let i = 0; i < 2000; i++) pts.push(punto(i));
  const tramos = agruparTramos(pts);
  assert.equal(tramos.length, 1);
  assert.equal(tramos[0].estado, "sin_dato");
});

test("la alternancia abre un tramo nuevo en cada cambio", () => {
  const bueno = [motor()], malo = [motor({ real: 0 })];
  const pts = [
    punto(0, bueno), punto(1, bueno),
    punto(2, malo),
    punto(3, bueno), punto(4, bueno), punto(5, bueno),
    punto(6, malo), punto(7, malo),
  ];
  const tramos = agruparTramos(pts);
  assert.deepEqual(tramos.map(t => t.estado), ["ok", "critico", "ok", "critico"]);
  assert.deepEqual(tramos.map(t => t.puntos.length), [2, 1, 3, 2]);
});

test("agrupar conserva TODOS los puntos y su orden, sin duplicar bordes", () => {
  const pts = [
    punto(0, [motor()]), punto(1), punto(2, [motor({ real: 0 })]),
    punto(3, [motor({ seccion_on: false, real: 0 })]), punto(4, [motor()]),
    punto(5, [motor()]), punto(6),
  ];
  const tramos = agruparTramos(pts);
  const total = tramos.reduce((n, t) => n + t.puntos.length, 0);
  assert.equal(total, pts.length);
  assert.deepEqual(tramos.flatMap(t => t.puntos), pts);
});

test("el tramo se queda con su peor momento para poder nombrarlo", () => {
  const tramos = agruparTramos([
    punto(0, [motor({ id: 1, real: 6 * 0.85 })]),
    punto(1, [motor({ id: 7, real: 6 * 0.50 })]), // el peor del tramo
    punto(2, [motor({ id: 3, real: 6 * 0.88 })]),
  ]);
  assert.equal(tramos.length, 1);
  assert.equal(tramos[0].detalle.peor.id, 7);
});

// ── resumenDosis ───────────────────────────────────────────────────────

test("resumen de un recorrido vacío: no hay datos y no revienta", () => {
  const r = resumenDosis([]);
  assert.equal(r.total, 0);
  assert.equal(r.conDosis, 0);
  assert.equal(r.hayDatos, false);
  assert.equal(r.estados.ok.puntos, 0);
  assert.equal(resumenDosis(null).hayDatos, false);
});

test("recorrido sin ningún qx: hayDatos en false (el aviso del sheet)", () => {
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push(punto(i));
  const r = resumenDosis(pts);
  assert.equal(r.hayDatos, false);
  assert.equal(r.total, 100);
  assert.equal(r.conDosis, 0);
  assert.equal(r.estados.sin_dato.puntos, 100);
});

test("un traslado con las secciones cerradas SÍ tiene datos de dosificación", () => {
  const cerrado = [motor({ seccion_on: false, real: 0 })];
  const r = resumenDosis([punto(0, cerrado), punto(1, cerrado)]);
  assert.equal(r.hayDatos, true);
  assert.equal(r.conDosis, 0);
  assert.equal(r.estados.cerrado.puntos, 2);
});

test("el resumen cuenta puntos y metros por estado", () => {
  const bueno = [motor()], malo = [motor({ real: 0 })];
  const r = resumenDosis([punto(0, bueno), punto(1, bueno), punto(2, malo), punto(3, bueno)]);
  assert.equal(r.total, 4);
  assert.equal(r.conDosis, 4);
  assert.equal(r.estados.ok.puntos, 3);
  assert.equal(r.estados.critico.puntos, 1);
  // El primer punto no tiene segmento previo: sus metros no se cuentan.
  assert.equal(Math.round(r.estados.ok.metros), Math.round(2 * r.estados.critico.metros));
  assert.ok(r.estados.critico.metros > 0);
});

test("la suma de puntos del resumen es el recorrido entero", () => {
  const pts = [
    punto(0, [motor()]), punto(1), punto(2, [motor({ real: 0 })]),
    punto(3, [motor({ seccion_on: false, real: 0 })]), punto(4, [motor({ real: 6 * 1.3 })]),
  ];
  const r = resumenDosis(pts);
  const suma = Object.keys(ESTADOS_DOSIS).reduce((n, k) => n + r.estados[k].puntos, 0);
  assert.equal(suma, pts.length);
  assert.equal(suma, r.total);
});

// ── La simplificación no se come un bache ──────────────────────────────

test("un bache corto sobrevive a la simplificación por distancia", () => {
  // 400 puntos cada 2 m (bien por debajo del umbral de 8 m) y en el medio
  // tres puntos —unos 6 m, un surco tapado 3 segundos— sin dosificar. Sin la
  // simplificación consciente del estado, esos tres puntos se descartan y el
  // bache desaparece del mapa.
  const bueno = [motor()], malo = [motor({ real: 0 })];
  const k = 111320 * Math.cos(-34.6 * Math.PI / 180);
  const pts = [];
  for (let i = 0; i < 400; i++) {
    pts.push({ lat: -34.6, lon: -60.9 + (i * 2) / k, ts: T0 + i * 1000, idx: i, qx: bueno });
  }
  // El bache se planta justo en tres puntos que el filtro por distancia
  // descarta (se busca el hueco en vez de suponerlo: los 8 m caen entre el
  // cuarto y el quinto punto según el redondeo).
  const quedan = new Set(simplificarTraza(pts, 8, 2000).map(p => p.idx));
  let bache = -1;
  for (let i = 150; i < 300 && bache < 0; i++) {
    if (!quedan.has(i) && !quedan.has(i + 1) && !quedan.has(i + 2)) bache = i;
  }
  assert.ok(bache > 0, "no se encontró un hueco donde plantar el bache");
  for (let i = bache; i < bache + 3; i++) pts[i].qx = malo;

  const estadoDe = p => clasificarDosis(p).estado;
  const conEstado = simplificarTraza(pts, 8, 2000, estadoDe);
  const sinEstado = simplificarTraza(pts, 8, 2000);

  assert.ok(conEstado.some(p => p.qx === malo), "se perdió el bache");
  assert.ok(!sinEstado.some(p => p.qx === malo), "el test no prueba nada si el bache sobrevivía solo");
  // Y no por eso deja de simplificar: sigue siendo una fracción del original.
  assert.ok(conEstado.length < pts.length / 3, `quedaron ${conEstado.length} de ${pts.length}`);
  // El bache queda delimitado: entra y sale con un cambio de estado.
  const estados = conEstado.map(estadoDe);
  assert.deepEqual([...new Set(estados)].sort(), ["critico", "ok"]);
});

test("el diezmado tampoco borra un cambio de estado", () => {
  // Muchos más puntos que el techo, con un bache de un solo punto.
  const bueno = [motor()], malo = [motor({ real: 0 })];
  const k = 111320 * Math.cos(-34.6 * Math.PI / 180);
  const pts = [];
  for (let i = 0; i < 6000; i++) {
    pts.push({ lat: -34.6, lon: -60.9 + (i * 50) / k, ts: T0 + i * 1000, qx: i === 3777 ? malo : bueno });
  }
  const simple = simplificarTraza(pts, 8, 500, p => clasificarDosis(p).estado);
  assert.ok(simple.some(p => p.qx === malo), "el diezmado se comió el bache");
  assert.equal(simple[0], pts[0]);
  assert.equal(simple[simple.length - 1], pts[pts.length - 1]);
});

test("sin estados, simplificar se comporta exactamente como antes", () => {
  const k = 111320 * Math.cos(-34.6 * Math.PI / 180);
  const pts = [];
  for (let i = 0; i < 3000; i++) pts.push({ lat: -34.6, lon: -60.9 + (i * 3) / k, ts: T0 + i * 1000 });
  assert.deepEqual(simplificarTraza(pts, 8, 2000, null), simplificarTraza(pts, 8, 2000));
  assert.deepEqual(simplificarTraza(pts, 8, 2000, () => null), simplificarTraza(pts, 8, 2000));
});

// ── De la respuesta del endpoint al color ──────────────────────────────

test("el qx llega entero desde la respuesta del endpoint", () => {
  const qx = [motor({ real: 0 })];
  const [p] = normalizarRecorrido({ points: [{ lat: -34.6, lon: -60.9, ts: T0, qx }] });
  assert.deepEqual(p.qx, qx);
  assert.equal(clasificarDosis(p).estado, "critico");
});

test("un punto sin qx no se lleva la clave puesta (no ensucia el punto)", () => {
  const [p] = normalizarRecorrido({ points: [{ lat: -34.6, lon: -60.9, ts: T0 }] });
  assert.ok(!("qx" in p));
  const [q] = normalizarRecorrido({ points: [{ lat: -34.6, lon: -60.9, ts: T0, qx: [] }] });
  assert.ok(!("qx" in q));
});
