import { test } from "node:test";
import assert from "node:assert/strict";
import { seleccionarCaidos } from "../../lib/push.js";

const MIN = 60_000;
const ahora = 1_800_000_000_000;

test("selecciona los que no reportan hace más de 15 min y aún no fueron notificados en este episodio", () => {
  const devs = [
    { device_id: "a", ultimo_visto: ahora - 20 * MIN },                                     // caído, nunca notificado → sí
    { device_id: "b", ultimo_visto: ahora - 5 * MIN },                                      // reciente → no
    { device_id: "c", ultimo_visto: ahora - 40 * MIN, caido_notificado_ts: ahora - 20 * MIN }, // ya notificado después del último heartbeat → no
    { device_id: "d", ultimo_visto: ahora - 20 * MIN, caido_notificado_ts: ahora - 60 * MIN }, // notificado ANTES del último heartbeat → episodio nuevo → sí
    { device_id: "e", ultimo_visto: null },                                                 // nunca reportó → no (no es una caída)
  ];
  assert.deepEqual(seleccionarCaidos(devs, ahora).map(d => d.device_id), ["a", "d"]);
});

test("respeta el umbral pasado por parámetro", () => {
  const devs = [{ device_id: "a", ultimo_visto: ahora - 3 * MIN }];
  assert.equal(seleccionarCaidos(devs, ahora, 2 * MIN).length, 1);
  assert.equal(seleccionarCaidos(devs, ahora, 5 * MIN).length, 0);
});
