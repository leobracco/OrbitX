// services/planimetria.js: flags (global + por org), parámetros acotados y
// cache por hash de partes. CouchDB en memoria (sin servidor).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generarLote } from "./planimetria-sintetico.mjs";
const require = createRequire(import.meta.url);
const svc = require("../../services/planimetria.js");

// Fake de nano con lo que usa el service: get/insert y find con $gt/$in/fields.
function fakeCouch(docs = []) {
  const m = new Map(docs.map(d => [d._id, { ...d, _rev: "1-a" }]));
  let n = 1;
  const cumple = (d, sel) => Object.entries(sel).every(([k, v]) => {
    if (v && typeof v === "object") {
      if ("$gt" in v) return d[k] > v.$gt;
      if ("$in" in v) return v.$in.includes(d[k]);
    }
    return d[k] === v;
  });
  return {
    _m: m, gets: 0,
    async get(id) { this.gets++; if (!m.has(id)) { const e = new Error("missing"); e.statusCode = 404; throw e; } return structuredClone(m.get(id)); },
    async insert(doc) {
      const act = m.get(doc._id);
      if (act && act._rev !== doc._rev) { const e = new Error("conflict"); e.statusCode = 409; throw e; }
      const nuevo = { ...structuredClone(doc), _rev: `${++n}-x` };
      m.set(doc._id, nuevo); return { ok: true };
    },
    async find({ selector, fields, limit = 25 }) {
      let r = [...m.values()].filter(d => cumple(d, selector)).slice(0, limit);
      if (fields) r = r.map(d => Object.fromEntries(fields.filter(f => f in d).map(f => [f, d[f]])));
      return { docs: structuredClone(r) };
    },
  };
}

function docsDeLote(L, lote = "Sintetico") {
  return L.partes.map((p, i) => ({
    _id: `aog_x_aog_fields_${lote}_Elevation_${p.nombre}`, tipo: "aog_archivo", subtipo: "elevation_points",
    es_lote: true, lote_nombre: lote, nombre: p.nombre, ruta_rel: p.ruta_rel, contenido: p.contenido,
    hash_md5: "h" + i, tamaño: p.contenido.length, ts: 1000 + i,
  }));
}

test("flag global: apagado sin la variable de entorno", () => {
  assert.equal(svc.habilitadaGlobal({}), false);
  assert.equal(svc.habilitadaGlobal({ PLANIMETRIA_ENABLED: "0" }), false);
  assert.equal(svc.habilitadaGlobal({ PLANIMETRIA_ENABLED: "1" }), true);
  assert.equal(svc.habilitadaGlobal({ PLANIMETRIA_ENABLED: "true" }), true);
});

test("flag por org: necesita la variable Y 'planimetria' en org.modulos", async () => {
  const gdb = fakeCouch([
    { _id: "org_si", tipo: "org", slug: "si", modulos: ["vistax", "planimetria"] },
    { _id: "org_no", tipo: "org", slug: "no", modulos: ["vistax", "linex", "centrix"] },
  ]);
  const antes = process.env.PLANIMETRIA_ENABLED;
  try {
    delete process.env.PLANIMETRIA_ENABLED;
    assert.equal(await svc.habilitadaParaOrg("si", { gdb }), false, "sin variable, nadie");
    process.env.PLANIMETRIA_ENABLED = "1";
    svc.olvidarOrg("si"); svc.olvidarOrg("no");
    assert.equal(await svc.habilitadaParaOrg("si", { gdb }), true);
    assert.equal(await svc.habilitadaParaOrg("no", { gdb }), false);
    assert.equal(await svc.habilitadaParaOrg("inexistente", { gdb }), false);
  } finally {
    if (antes === undefined) delete process.env.PLANIMETRIA_ENABLED; else process.env.PLANIMETRIA_ENABLED = antes;
  }
});

test("conModulo agrega/saca sin duplicar ni tocar los demás", () => {
  assert.deepEqual(svc.conModulo(["vistax", "linex"], "planimetria", true), ["vistax", "linex", "planimetria"]);
  assert.deepEqual(svc.conModulo(["vistax", "planimetria"], "planimetria", true), ["vistax", "planimetria"]);
  assert.deepEqual(svc.conModulo(["vistax", "planimetria", "linex"], "planimetria", false), ["vistax", "linex"]);
  assert.deepEqual(svc.conModulo(undefined, "planimetria", true), ["planimetria"]);
});

test("parámetros: se ajustan a la lista permitida (acota los docs de cache)", () => {
  assert.deepEqual(svc.normalizarParams({}), { res: 3, curvas: "auto", umbral: 0.05, nivelar: true });
  assert.equal(svc.normalizarParams({ curvas: "auto" }).curvas, "auto");
  assert.deepEqual(svc.normalizarParams({ res: "2.4", curvas: "0.12", umbral: "x", nivelar: "0" }),
    { res: 2, curvas: 0.1, umbral: 0.05, nivelar: false });
  assert.equal(svc.normalizarParams({ res: "999" }).res, 10);
});

test("obtener: calcula, guarda cache y la reusa mientras no cambien las partes", async () => {
  const L = generarLote({ cabeceras: false });
  const edb = fakeCouch(docsDeLote(L));
  const r1 = await svc.obtener("x", "Sintetico", { res: "3" }, { estabDB: edb });
  assert.equal(r1.estado, "ok");
  assert.equal(r1.json.ok, true);
  assert.equal(r1.json.desde_cache, false);
  assert.equal(r1.json.partes, L.partes.length);
  const cache = [...edb._m.values()].find(d => d.tipo === "planimetria_cache");
  assert.ok(cache && cache.hash_partes === r1.json.hash);

  const r2 = await svc.obtener("x", "Sintetico", { res: "3" }, { estabDB: edb });
  assert.equal(r2.json.desde_cache, "memoria");

  // La última parte crece (otro hash): se recalcula.
  const ult = [...edb._m.values()].filter(d => d.subtipo === "elevation_points").sort((a, b) => b.ts - a.ts)[0];
  ult.hash_md5 = "otro"; ult._rev = "1-a"; await edb.insert(ult);
  const r3 = await svc.obtener("x", "Sintetico", { res: "3" }, { estabDB: edb });
  assert.equal(r3.json.desde_cache, false);
  assert.notEqual(r3.json.hash, r1.json.hash);
});

test("obtener: lote sin partes de elevación → sin_datos", async () => {
  const edb = fakeCouch([{ _id: "a", tipo: "aog_archivo", subtipo: "boundary", lote_nombre: "L", ts: 1, es_lote: true }]);
  const r = await svc.obtener("x", "L", {}, { estabDB: edb });
  assert.equal(r.estado, "sin_datos");
  assert.equal(r.json.sin_datos, true);
});

test("obtener: dos pedidos iguales en paralelo comparten el cálculo", async () => {
  const L = generarLote({ cabeceras: false, seed: 3 });
  const edb = fakeCouch(docsDeLote(L, "Par"));
  const [a, b] = await Promise.all([
    svc.obtener("y", "Par", { res: "5" }, { estabDB: edb }),
    svc.obtener("y", "Par", { res: "5" }, { estabDB: edb }),
  ]);
  assert.equal(a.json.calculado_ts, b.json.calculado_ts);
  const caches = [...edb._m.values()].filter(d => d.tipo === "planimetria_cache");
  assert.equal(caches.length, 1);
});
