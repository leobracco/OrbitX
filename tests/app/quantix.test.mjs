// quantix.test.mjs — Las cuentas de la dosificación de QuantiX en la pantalla
// Equipos. El contrato del dato es el de normalizarQx (routes/tracking.js):
// cada motor trae uid, id, pps_obj, pps_real, obj, real, unidad, pwm,
// carga_pct, seccion_on y cortes.
//
// Hoy en producción NINGÚN equipo manda `qx` todavía (PilotX lo empezó a
// mandar recién y no salió a los tractores), así que los casos vacíos no son
// teoría: son lo único que se ve en pantalla por ahora y tienen que quedar
// prolijos. El resto de los casos son los que rompen una cuenta hecha de
// apuro: sección cerrada (real en cero legítimo), objetivo en cero (división),
// unidad que no conocemos y campos que no son números.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UMBRAL_DESVIO, EDAD_MAX_MS,
  normalizarMotores, leerQxLive, desvioRelativo, estadoMotor,
  formatearValor, formatearDesvio, resumenMotores,
} from "../../app/pantallas/equipos.js";

// Un motor como lo deja el server: sembrando 7 sem/m y contando 7 sem/m.
function motor(extra = {}) {
  return {
    uid: "QX-C45857858428", id: 1,
    pps_obj: 412, pps_real: 410,
    obj: 7, real: 7, unidad: "sem_m",
    pwm: 2100, carga_pct: 51, seccion_on: true, cortes: [],
    ...extra,
  };
}

// ── normalizarMotores ────────────────────────────────────────────────────

test("sin qx no hay motores, y no explota con cualquier cosa", () => {
  // El caso de hoy: el equipo postea posición pero sin `qx` (el server lo
  // guarda como null cuando no vino).
  assert.deepEqual(normalizarMotores(null), []);
  assert.deepEqual(normalizarMotores(undefined), []);
  assert.deepEqual(normalizarMotores([]), []);
  assert.deepEqual(normalizarMotores("no-es-lista"), []);
  assert.deepEqual(normalizarMotores({ 0: motor() }), []);
  // Basura adentro de la lista: se saltea, no tira la fila entera.
  assert.equal(normalizarMotores([null, "x", 3, motor()]).length, 1);
});

test("normalizarMotores deja los campos que se muestran y tira los pps", () => {
  const [m] = normalizarMotores([motor({ carga_pct: 51 })]);
  assert.equal(m.uid, "QX-C45857858428");
  assert.equal(m.id, 1);
  assert.equal(m.obj, 7);
  assert.equal(m.real, 7);
  assert.equal(m.unidad, "sem_m");
  assert.equal(m.carga, 51);
  assert.equal(m.seccion_on, true);
  // Regla firme del producto: al operario no se le muestran pulsos. Si los
  // pps sobreviven a la normalización, alguien los va a terminar pintando.
  assert.equal("pps_obj" in m, false);
  assert.equal("pps_real" in m, false);
});

test("los valores que no son números quedan en null, nunca en cero", () => {
  // Un cero inventado en `real` haría sonar la alarma de "no está dosificando"
  // sobre un motor del que en realidad no sabemos nada.
  const [m] = normalizarMotores([{ uid: "QX-1", id: "x", obj: null, real: "", carga_pct: "ochenta", seccion_on: true }]);
  assert.equal(m.id, null);
  assert.equal(m.obj, null);
  assert.equal(m.real, null);
  assert.equal(m.carga, null);
  // Y los strings numéricos sí entran: 7 y "7" son el mismo 7.
  const [n] = normalizarMotores([{ uid: "QX-1", id: "2", obj: "7.5", real: "7.2", seccion_on: true }]);
  assert.equal(n.id, 2);
  assert.equal(n.obj, 7.5);
  assert.equal(n.real, 7.2);
  // true/false no son números aunque JS los sepa sumar.
  const [b] = normalizarMotores([{ uid: "QX-1", obj: true, real: false }]);
  assert.equal(b.obj, null);
  assert.equal(b.real, null);
});

test("una unidad que no conocemos no se convierte en otra", () => {
  const [m] = normalizarMotores([motor({ unidad: "lts_ha" })]);
  assert.equal(m.unidad, "");   // vacía: se muestra el número sin unidad
  const [k] = normalizarMotores([motor({ unidad: "kg_ha" })]);
  assert.equal(k.unidad, "kg_ha");
});

test("la sección que el equipo no informó no cuenta como cerrada", () => {
  // Tomar el campo ausente como "apagado" silenciaría la alarma de un motor
  // que sí tendría que estar tirando producto.
  const [m] = normalizarMotores([{ uid: "QX-1", id: 1, obj: 7, real: 0 }]);
  assert.equal(m.seccion_on, null);
  assert.equal(estadoMotor(m).clave, "cortado");
  const [c] = normalizarMotores([{ uid: "QX-1", id: 1, obj: 7, real: 0, seccion_on: false }]);
  assert.equal(c.seccion_on, false);
  assert.equal(estadoMotor(c).clave, "apagado");
});

test("los motores salen ordenados por caja y después por surco", () => {
  const lista = normalizarMotores([
    motor({ uid: "QX-B", id: 2 }), motor({ uid: "QX-A", id: 3 }),
    motor({ uid: "QX-A", id: 1 }), motor({ uid: "QX-B", id: 1 }),
  ]);
  assert.deepEqual(lista.map(m => `${m.uid}#${m.id}`), ["QX-A#1", "QX-A#3", "QX-B#1", "QX-B#2"]);
  // El motor sin número va al final de su caja, no al principio.
  const conNull = normalizarMotores([motor({ uid: "QX-A", id: null }), motor({ uid: "QX-A", id: 5 })]);
  assert.deepEqual(conNull.map(m => m.id), [5, null]);
});

// ── leerQxLive ───────────────────────────────────────────────────────────

test("leerQxLive distingue no reportar de reportar sin dosificación", () => {
  const vivo = [
    { device_id: "OX-1", ts: 1_700_000_000_000, qx: [motor()] },
    { device_id: "OX-2", ts: 1_700_000_000_000, qx: null },
  ];
  // Equipo que manda dosificación.
  const a = leerQxLive(vivo, "OX-1");
  assert.equal(a.reporta, true);
  assert.equal(a.motores.length, 1);
  // Equipo que postea posición pero todavía no manda `qx`: el caso de hoy.
  const b = leerQxLive(vivo, "OX-2");
  assert.equal(b.reporta, true);
  assert.deepEqual(b.motores, []);
  // Equipo que no está en la respuesta: no posteó en los últimos 5 min.
  const c = leerQxLive(vivo, "OX-9");
  assert.equal(c.reporta, false);
  assert.equal(c.ts, null);
  assert.deepEqual(c.motores, []);
  // Respuesta que no es una lista (cache raro, error del server).
  for (const basura of [null, undefined, {}, "x"]) {
    assert.deepEqual(leerQxLive(basura, "OX-1"), { reporta: false, ts: null, motores: [] });
  }
});

test("leerQxLive compara el device_id como texto y trae el ts del punto", () => {
  const vivo = [{ device_id: 1234, ts: 1_700_000_000_000, qx: [motor()] }];
  assert.equal(leerQxLive(vivo, "1234").reporta, true);
  assert.equal(leerQxLive(vivo, 1234).ts, 1_700_000_000_000);
  // Sin ts no se inventa una hora: la antigüedad se resuelve arriba.
  assert.equal(leerQxLive([{ device_id: "OX-1", qx: [] }], "OX-1").ts, null);
});

// ── desvioRelativo ───────────────────────────────────────────────────────

test("el desvío es relativo al objetivo y tiene signo", () => {
  assert.equal(desvioRelativo(7, 7), 0);
  assert.equal(desvioRelativo(10, 12), 0.2);    // 20% por encima
  assert.equal(desvioRelativo(10, 8), -0.2);    // 20% por debajo
  assert.equal(desvioRelativo("10", "11"), 0.1);
});

test("objetivo cero: no se divide, se devuelve null", () => {
  // La pantalla puede estar sin dosis cargada. Dividir por cero daría
  // Infinity y la fila mostraría un desvío inventado de millones por ciento.
  assert.equal(desvioRelativo(0, 5), null);
  assert.equal(desvioRelativo(0, 0), null);
  assert.equal(desvioRelativo(-3, 5), null);
  // Falta un dato: tampoco hay desvío.
  assert.equal(desvioRelativo(null, 5), null);
  assert.equal(desvioRelativo(7, null), null);
  assert.equal(desvioRelativo(7, "ochenta"), null);
});

// ── estadoMotor ──────────────────────────────────────────────────────────

test("motor en objetivo", () => {
  const e = estadoMotor(normalizarMotores([motor({ obj: 7, real: 7.2 })])[0]);
  assert.equal(e.clave, "ok");
  assert.equal(e.tono, "ok");
});

test("sección cerrada NO es un problema aunque el real sea cero", () => {
  // Un motor apagado a propósito (levantó el cuerpo, cerró la sección) no
  // dosifica y está perfecto. Marcarlo en rojo entrena al operario a ignorar
  // los rojos.
  const e = estadoMotor(normalizarMotores([motor({ seccion_on: false, real: 0 })])[0]);
  assert.equal(e.clave, "apagado");
  assert.equal(e.tono, "");       // neutro: ni ok, ni warn, ni err
  assert.equal(e.texto, "sección cerrada");
  // Y sigue siendo apagado aunque el desvío sea enorme.
  const g = estadoMotor(normalizarMotores([motor({ seccion_on: false, obj: 7, real: 1 })])[0]);
  assert.equal(g.clave, "apagado");
  assert.equal(g.tono, "");
});

test("sección abierta y el sensor no cuenta nada: esa sí es la alarma", () => {
  const e = estadoMotor(normalizarMotores([motor({ seccion_on: true, obj: 7, real: 0 })])[0]);
  assert.equal(e.clave, "cortado");
  assert.equal(e.tono, "err");
});

test("objetivo en cero con la sección abierta es 'sin objetivo', no una falla", () => {
  const e = estadoMotor(normalizarMotores([motor({ obj: 0, real: 0 })])[0]);
  assert.equal(e.clave, "sin_objetivo");
  assert.equal(e.tono, "");
});

test("sin datos numéricos no se afirma nada", () => {
  assert.equal(estadoMotor(null).clave, "sin_dato");
  assert.equal(estadoMotor(undefined).tono, "");
  assert.equal(estadoMotor("x").clave, "sin_dato");
  const [m] = normalizarMotores([{ uid: "QX-1", id: 1, seccion_on: true }]);
  assert.equal(estadoMotor(m).clave, "sin_dato");
  assert.equal(estadoMotor(m).tono, "");
});

test("el borde del umbral cuenta como alerta", () => {
  assert.equal(UMBRAL_DESVIO, 0.10);
  const con = (obj, real) => estadoMotor(normalizarMotores([motor({ obj, real })])[0]);
  // Justo 10% abajo: alerta (>=), un motor clavado en el borde es sospechoso.
  assert.equal(con(10, 9).clave, "desviado");
  // Justo 10% arriba: alerta también.
  assert.equal(con(10, 11).clave, "desviado");
  // Un pelo adentro del umbral: no se alarma.
  assert.equal(con(10, 9.05).clave, "ok");
  assert.equal(con(10, 10.9).clave, "ok");
  // Y el umbral se puede mover sin tocar la función.
  assert.equal(estadoMotor(normalizarMotores([motor({ obj: 10, real: 9.5 })])[0], 0.05).clave, "desviado");
  assert.equal(estadoMotor(normalizarMotores([motor({ obj: 10, real: 9.5 })])[0], 0.20).clave, "ok");
});

// ── formato ──────────────────────────────────────────────────────────────

test("el valor se muestra en la unidad del operario, con coma", () => {
  assert.equal(formatearValor(7.25, "sem_m"), "7,3 sem/m");
  assert.equal(formatearValor(118, "kg_ha"), "118,0 kg/ha");
  assert.equal(formatearValor(0, "sem_m"), "0,0 sem/m");
});

test("una unidad desconocida muestra el número sin unidad inventada", () => {
  // Confundir kg/ha con sem/m hace errar la dosis por dos órdenes: antes el
  // número pelado que una unidad equivocada.
  assert.equal(formatearValor(12.4, "lts_ha"), "12,4");
  assert.equal(formatearValor(12.4, ""), "12,4");
  assert.equal(formatearValor(12.4, undefined), "12,4");
  // Y nunca aparece "pps" ni nada que se le parezca.
  assert.equal(formatearValor(410, "pps"), "410,0");
});

test("un valor que no es número se muestra como vacío, no como cero", () => {
  assert.equal(formatearValor(null, "sem_m"), "—");
  assert.equal(formatearValor(undefined, "sem_m"), "—");
  assert.equal(formatearValor("", "sem_m"), "—");
  assert.equal(formatearValor("mucho", "sem_m"), "—");
  assert.equal(formatearValor(NaN, "sem_m"), "—");
  assert.equal(formatearValor(Infinity, "sem_m"), "—");
});

test("el desvío se dice para qué lado", () => {
  assert.equal(formatearDesvio(-0.2), "20% abajo");
  assert.equal(formatearDesvio(0.15), "15% arriba");
  assert.equal(formatearDesvio(0), "en objetivo");
  assert.equal(formatearDesvio(null), "");
  assert.equal(formatearDesvio(NaN), "");
});

// ── resumen ──────────────────────────────────────────────────────────────

test("el resumen no cuenta como alerta lo que está apagado", () => {
  const motores = normalizarMotores([
    motor({ id: 1, obj: 7, real: 7 }),                      // ok
    motor({ id: 2, obj: 7, real: 5 }),                      // 29% abajo → warn
    motor({ id: 3, obj: 7, real: 0 }),                      // no dosifica → err
    motor({ id: 4, obj: 7, real: 0, seccion_on: false }),   // apagado a propósito
  ]);
  const r = resumenMotores(motores);
  assert.equal(r.total, 4);
  assert.equal(r.abiertos, 3);   // el apagado no cuenta como trabajando
  assert.equal(r.alertas, 2);    // warn + err
  assert.equal(r.criticos, 1);   // solo el que no dosifica
});

test("el resumen de una lista vacía es todo cero", () => {
  assert.deepEqual(resumenMotores([]), { total: 0, abiertos: 0, alertas: 0, criticos: 0 });
  assert.deepEqual(resumenMotores(null), { total: 0, abiertos: 0, alertas: 0, criticos: 0 });
  assert.deepEqual(resumenMotores("x"), { total: 0, abiertos: 0, alertas: 0, criticos: 0 });
});

test("la ventana de dato fresco es la misma que usa el mapa", () => {
  // Más viejo que esto se muestra como "último dato", nunca como lo que está
  // pasando ahora: un dato de hace 3 horas (cache sin conexión) mentiría.
  assert.equal(EDAD_MAX_MS, 2 * 60 * 1000);
});
