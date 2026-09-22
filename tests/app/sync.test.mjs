import { test } from "node:test";
import assert from "node:assert/strict";
import { crearSync } from "../../app/core/sync.js";
import { crearStore, memBackend } from "../../app/core/store.js";
import { ErrorHttp } from "../../app/core/api.js";

function arma(postImpl) {
  const store = crearStore(memBackend());
  const eventos = [];
  const sync = crearSync({ store, api: { post: postImpl }, onEvento: (e) => eventos.push(e) });
  return { store, sync, eventos };
}

test("envía en orden y quita de la cola lo confirmado", async () => {
  const enviados = [];
  const { store, sync, eventos } = arma(async (ruta, body) => { enviados.push(body.mm); return { _id: "real_" + body.mm }; });
  await store.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 1 } });
  await store.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 2 } });
  const r = await sync.drenar();
  assert.deepEqual(enviados, [1, 2]);
  assert.equal(r.enviados, 2);
  assert.deepEqual(await store.colaListar(), []);
  assert.equal(eventos.filter(e => e.tipo === "enviado").length, 2);
  assert.equal(eventos[0].respuesta._id, "real_1");
});

test("un fallo de red incrementa intentos y NO quita el item", async () => {
  const { store, sync } = arma(async () => { throw new TypeError("Failed to fetch"); });
  const it = await store.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  const r = await sync.drenar();
  assert.equal(r.fallidos, 1);
  const [q] = await store.colaListar();
  assert.equal(q.id, it.id);
  assert.equal(q.intentos, 1);
  assert.equal(q.estado, "pendiente");
});

test("al tercer fallo consecutivo marca error, emite detenido y no sigue con el resto", async () => {
  let llamadas = 0;
  const { store, sync, eventos } = arma(async () => { llamadas++; throw new TypeError("sin red"); });
  await store.colaAgregar({ metodo: "POST", ruta: "/a", body: {} });
  await store.colaAgregar({ metodo: "POST", ruta: "/b", body: {} });
  await sync.drenar(); await sync.drenar();
  const r = await sync.drenar();
  assert.equal(r.detenido, true);
  const [a, b] = await store.colaListar();
  assert.equal(a.estado, "error");
  assert.equal(a.intentos, 3);
  assert.equal(b.intentos, 0, "el segundo nunca se intentó porque el primero cortó");
  assert.equal(llamadas, 3);
  assert.equal(eventos.at(-1).tipo, "detenido");
});

test("un rechazo del server (4xx) marca error de inmediato sin agotar reintentos", async () => {
  const { store, sync, eventos } = arma(async () => { throw new ErrorHttp(400, { error: "mm inválidos" }, "/x"); });
  await store.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  const r = await sync.drenar();
  const [q] = await store.colaListar();
  assert.equal(q.estado, "error");
  assert.equal(q.error, "mm inválidos");
  assert.equal(r.detenido, true);
  assert.equal(eventos.at(-1).tipo, "detenido");
});

test("los items en estado error no se reintentan solos", async () => {
  let llamadas = 0;
  const { store, sync } = arma(async () => { llamadas++; return {}; });
  const it = await store.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  await store.colaActualizar(it.id, { estado: "error", intentos: 3 });
  await sync.drenar();
  assert.equal(llamadas, 0);
});
