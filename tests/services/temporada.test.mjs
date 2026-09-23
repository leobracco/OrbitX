import { test } from "node:test";
import assert from "node:assert/strict";
import { temporadaDe, rangoTemporada, temporadaActual, esTemporadaValida } from "../../services/temporada.js";

test("temporadaDe: año agrícola sep→ago, hemisferio sur", () => {
  assert.equal(temporadaDe(new Date("2026-09-01T03:00:00Z")), "2026/27");
  assert.equal(temporadaDe(new Date("2026-08-31T23:00:00Z")), "2025/26");
  assert.equal(temporadaDe(new Date("2027-03-15T12:00:00Z")), "2026/27");
  assert.equal(temporadaDe(Date.UTC(2025, 11, 24)), "2025/26");
  assert.equal(temporadaDe("2026-01-10"), "2025/26");
});
test("rangoTemporada devuelve los límites y sus ms", () => {
  const r = rangoTemporada("2026/27");
  assert.equal(r.desde, "2026-09-01"); assert.equal(r.hasta, "2027-08-31");
  assert.ok(r.desdeMs < r.hastaMs);
  assert.equal(temporadaDe(r.desdeMs), "2026/27");
  assert.equal(temporadaDe(r.hastaMs), "2026/27");
});
test("esTemporadaValida acepta AAAA/AA y rechaza el resto", () => {
  assert.equal(esTemporadaValida("2026/27"), true);
  assert.equal(esTemporadaValida("2026/28"), false);
  assert.equal(esTemporadaValida("26/27"), false);
  assert.equal(esTemporadaValida(""), false);
});
test("esTemporadaValida acota AAAA entre 2015 y la temporada actual + 1", () => {
  assert.equal(esTemporadaValida("2014/15"), false); // antes de 2015: no hay datos
  assert.equal(esTemporadaValida("2015/16"), true);  // límite inferior
  const anioActual = Number(temporadaActual().slice(0, 4));
  assert.equal(esTemporadaValida(`${anioActual + 1}/${String((anioActual + 2) % 100).padStart(2, "0")}`), true); // límite superior
  assert.equal(esTemporadaValida(`${anioActual + 2}/${String((anioActual + 3) % 100).padStart(2, "0")}`), false); // pasa el límite
});
test("temporadaActual usa la fecha dada", () => {
  assert.equal(temporadaActual(new Date("2026-09-23T15:00:00Z")), "2026/27");
});
