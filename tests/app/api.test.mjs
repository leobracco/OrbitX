import { test } from "node:test";
import assert from "node:assert/strict";
import { crearApi, ErrorSinDatos, ErrorHttp } from "../../app/core/api.js";
import { crearStore, memBackend } from "../../app/core/store.js";

const ok = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const falla = () => async () => { throw new TypeError("Failed to fetch"); };
const cuelga = () => (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("abort", "AbortError"))));
const status = (code, body = {}) => async () => new Response(JSON.stringify(body), { status: code });

function arma(fetchFn, extra = {}) {
  const store = crearStore(memBackend());
  const api = crearApi({ fetchFn, store, getToken: () => "tok", timeoutMs: 50, ...extra });
  return { api, store };
}

test("get con red OK devuelve data fresca y la cachea", async () => {
  const { api, store } = arma(ok([1, 2]));
  const r = await api.get("/api/lotes");
  assert.deepEqual(r.data, [1, 2]);
  assert.equal(r.desdeCache, false);
  assert.deepEqual((await store.cacheGet("GET /api/lotes")).data, [1, 2]);
});

test("get manda Authorization Bearer", async () => {
  let vistos;
  const { api } = arma(async (_u, opts) => { vistos = opts.headers; return new Response("[]", { status: 200 }); });
  await api.get("/api/lotes");
  assert.equal(vistos.Authorization, "Bearer tok");
});

test("get sin red devuelve el cache marcado desdeCache", async () => {
  const { api, store } = arma(falla());
  await store.cacheSet("GET /api/lotes", [9]);
  const r = await api.get("/api/lotes");
  assert.deepEqual(r.data, [9]);
  assert.equal(r.desdeCache, true);
  assert.ok(typeof r.ts === "number");
});

test("get que se cuelga más del timeout cae al cache", async () => {
  const { api, store } = arma(cuelga());
  await store.cacheSet("GET /api/lotes", [7]);
  const r = await api.get("/api/lotes");
  assert.equal(r.desdeCache, true);
});

test("get sin red y sin cache lanza ErrorSinDatos", async () => {
  const { api } = arma(falla());
  await assert.rejects(() => api.get("/api/lotes"), ErrorSinDatos);
});

test("401 llama onNoAuth y lanza ErrorHttp", async () => {
  let llamado = false;
  const { api } = arma(status(401), { onNoAuth: () => { llamado = true; } });
  await assert.rejects(() => api.get("/api/lotes"), (e) => e instanceof ErrorHttp && e.status === 401);
  assert.equal(llamado, true);
});

test("post no usa cache y devuelve el body; error trae status y body", async () => {
  const { api } = arma(ok({ ok: true, _id: "x" }));
  assert.deepEqual(await api.post("/api/lluvias", { mm: 5 }), { ok: true, _id: "x" });
  const { api: api2 } = arma(status(400, { error: "mm inválidos" }));
  await assert.rejects(() => api2.post("/api/lluvias", {}), (e) => e.status === 400 && e.body.error === "mm inválidos");
});
