import { test } from "node:test";
import assert from "node:assert/strict";
import { crearStore, memBackend } from "../../app/core/store.js";

test("cacheSet/cacheGet guardan data con marca de tiempo", async () => {
  const s = crearStore(memBackend());
  await s.cacheSet("GET /api/lotes", [{ _id: "l1" }]);
  const r = await s.cacheGet("GET /api/lotes");
  assert.deepEqual(r.data, [{ _id: "l1" }]);
  assert.ok(Date.now() - r.ts < 1000);
});

test("cacheGet devuelve null si no hay nada", async () => {
  const s = crearStore(memBackend());
  assert.equal(await s.cacheGet("nada"), null);
});

test("la cola conserva el orden de llegada y asigna id temporal", async () => {
  const s = crearStore(memBackend());
  const a = await s.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 10 } });
  const b = await s.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 20 } });
  assert.match(a.id, /^tmp_/);
  assert.equal(a.estado, "pendiente");
  assert.equal(a.intentos, 0);
  const lista = await s.colaListar();
  assert.deepEqual(lista.map(i => i.body.mm), [10, 20]);
  assert.ok(a.ts <= b.ts);
});

test("colaActualizar aplica el patch y colaQuitar elimina", async () => {
  const s = crearStore(memBackend());
  const a = await s.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  const upd = await s.colaActualizar(a.id, { intentos: 2, estado: "error", error: "boom" });
  assert.equal(upd.intentos, 2);
  assert.equal(upd.error, "boom");
  await s.colaQuitar(a.id);
  assert.deepEqual(await s.colaListar(), []);
});
