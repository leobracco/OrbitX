// Datos editables de una org. Nació de "PEQUEÑOS TURPIALES": la org se creó
// con la Ñ rota y no había forma de corregirla sin tocar CouchDB a mano.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const o = require("../../lib/org-datos.js");

test("normalizarCuit acepta guiones y espacios", () => {
  assert.equal(o.normalizarCuit("30-60693312-2"), "30606933122");
  assert.equal(o.normalizarCuit(" 20233224759 "), "20233224759");
  assert.equal(o.normalizarCuit(""), "");
  assert.equal(o.normalizarCuit(undefined), "");
});

test("normalizarCuit rechaza largo inválido", () => {
  assert.throws(() => o.normalizarCuit("123"), e => e.status === 400);
});

test("validarNombre toma nombre y lo devuelve trimado", () => {
  assert.equal(o.validarNombre("  LOS PEQUEÑOS TURPIALES S.A. "), "LOS PEQUEÑOS TURPIALES S.A.");
});

test("validarNombre rechaza vacío después de trim", () => {
  assert.throws(() => o.validarNombre("   "), e => e.status === 400 && e.message.includes("no puede quedar vacío"));
  assert.throws(() => o.validarNombre(""), e => e.status === 400);
});

test("validarNombre rechaza el carácter Unicode de reemplazo (encoding roto)", () => {
  assert.throws(() => o.validarNombre("PEQUE\uFFFDOS"), e => e.status === 400 && e.message.includes("\uFFFD"));
});

test("validarNombre acepta el texto plano que antes daba falso positivo", () => {
  assert.equal(o.validarNombre("CAMPO FFFD"), "CAMPO FFFD");
});

test("validarNombre trunca a 160 caracteres", () => {
  const long = "a".repeat(200);
  assert.equal(o.validarNombre(long).length, 160);
});

test("validarCambiosOrg toma nombre y cuit", () => {
  assert.deepEqual(o.validarCambiosOrg({ nombre: "  LOS PEQUEÑOS TURPIALES S.A. ", cuit: "30606933122", slug: "x" }),
    { nombre: "LOS PEQUEÑOS TURPIALES S.A.", cuit: "30606933122" });
});

test("validarCambiosOrg rechaza el carácter Unicode de reemplazo (encoding roto)", () => {
  assert.throws(() => o.validarCambiosOrg({ nombre: "PEQUE\uFFFDOS" }), e => e.status === 400);
});

test("validarCambiosOrg sin cambios es 400", () => {
  assert.throws(() => o.validarCambiosOrg({}), e => e.status === 400);
  assert.throws(() => o.validarCambiosOrg({ nombre: "   " }), e => e.status === 400);
});
