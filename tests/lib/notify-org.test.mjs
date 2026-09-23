import { test } from "node:test";
import assert from "node:assert/strict";
import { sanearNotif, EVENTOS, DEFAULT_NOTIF } from "../../lib/notify-org.js";

test("sanearNotif({}) devuelve la matriz por defecto: 5 eventos, 3 canales en true, canales apagados", () => {
  const out = sanearNotif({});
  assert.equal(Object.keys(out.eventos).length, EVENTOS.length);
  for (const canal of ["telegram", "whatsapp", "email"]) {
    assert.equal(out[canal].enabled, false, `${canal} debería empezar deshabilitado`);
  }
  for (const e of EVENTOS) {
    assert.deepEqual(out.eventos[e.clave], { telegram: true, whatsapp: true, email: true });
  }
  // No debe mutar el default compartido.
  assert.deepEqual(DEFAULT_NOTIF.eventos.nodo_caido, { telegram: true, whatsapp: true, email: true });
});

test("un evento con un canal apagado queda apagado solo en ese canal, el resto sigue en true", () => {
  const out = sanearNotif({ eventos: { nodo_caido: { telegram: false, whatsapp: true, email: true } } });
  assert.deepEqual(out.eventos.nodo_caido, { telegram: false, whatsapp: true, email: true });
  // Los demás eventos no se tocan.
  assert.deepEqual(out.eventos.alerta_critica, { telegram: true, whatsapp: true, email: true });
  assert.deepEqual(out.eventos.reporte_diario, { telegram: true, whatsapp: true, email: true });
});

test("claves de evento desconocidas se ignoran (no aparecen en el resultado)", () => {
  const out = sanearNotif({ eventos: { otro_evento_inventado: { telegram: false, whatsapp: false, email: false } } });
  assert.equal(out.eventos.otro_evento_inventado, undefined);
  assert.equal(Object.keys(out.eventos).length, EVENTOS.length);
  // Y los eventos reales quedan con el default (la clave desconocida no pisó nada).
  for (const e of EVENTOS) {
    assert.deepEqual(out.eventos[e.clave], { telegram: true, whatsapp: true, email: true });
  }
});

test("email.to: strings vacíos o solo espacios se descartan, valores no-string se coercionan con String()", () => {
  const out = sanearNotif({ email: { enabled: true, to: ["  a@b.com  ", "", "   ", 123, null, undefined] } });
  // Vacíos/whitespace-only se filtran (String vacía tras trim() es falsy).
  assert.deepEqual(out.email.to, ["a@b.com", "123", "null", "undefined"]);
  assert.equal(out.email.enabled, true);
});

test("email.to respeta el tope de 10 entradas", () => {
  const muchos = Array.from({ length: 15 }, (_, i) => `mail${i}@x.com`);
  const out = sanearNotif({ email: { enabled: true, to: muchos } });
  assert.equal(out.email.to.length, 10);
});
