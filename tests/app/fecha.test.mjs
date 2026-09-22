import { test } from "node:test";
import assert from "node:assert/strict";
import { haceCuanto, fechaCorta, fechaISOHoy } from "../../app/core/fecha.js";

test("haceCuanto escala minutos, horas y días", () => {
  const ahora = 1_800_000_000_000;
  assert.equal(haceCuanto(ahora - 20_000, ahora), "recién");
  assert.equal(haceCuanto(ahora - 3 * 60_000, ahora), "hace 3 min");
  assert.equal(haceCuanto(ahora - 2 * 3_600_000, ahora), "hace 2 h");
  assert.equal(haceCuanto(ahora - 3 * 86_400_000, ahora), "hace 3 d");
});

test("fechaCorta usa TZ Argentina", () => {
  // 2026-09-22T17:05:00Z = 14:05 en Buenos Aires (UTC-3)
  assert.equal(fechaCorta(Date.UTC(2026, 8, 22, 17, 5)), "22/09 14:05");
});

test("fechaISOHoy devuelve YYYY-MM-DD", () => {
  assert.match(fechaISOHoy(), /^\d{4}-\d{2}-\d{2}$/);
});
