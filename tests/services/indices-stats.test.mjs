import { test } from "node:test";
import assert from "node:assert/strict";
import couch from "../../services/couchdb.js";
import parser from "../../services/aog_parser.js";

const { ESTAB_INDEX_FIELDS, GLOBAL_INDEX_FIELDS } = couch;
const { STATS_VER, statsVigentes } = parser;

const tiene = (lista, campos) =>
  lista.some(f => f.length === campos.length && f.every((c, i) => c === campos[i]));

test("ESTAB_INDEX_FIELDS cubre las queries nuevas del Sprint 2", () => {
  // Pieza 2: listar temporadas de un lote desde aog_historial sin bajar contenido.
  assert.ok(tiene(ESTAB_INDEX_FIELDS, ["tipo", "subtipo", "lote_nombre", "ts"]));
  // Pieza 1: prescripciones de un lote.
  assert.ok(tiene(ESTAB_INDEX_FIELDS, ["tipo", "lote_nombre"]));
  // Pieza 6: historial de notificaciones paginado por ts (ya existía, no se rompe).
  assert.ok(tiene(ESTAB_INDEX_FIELDS, ["tipo", "ts"]));
});

test("GLOBAL_INDEX_FIELDS cubre el lookup de tokens de org", () => {
  assert.ok(tiene(GLOBAL_INDEX_FIELDS, ["tipo", "hash"]));
  assert.ok(tiene(GLOBAL_INDEX_FIELDS, ["tipo", "org_slug"]));
});

test("statsVigentes: solo confía cuando la versión y el hash coinciden", () => {
  const base = { stats: { trabajado_ha: 1 }, stats_ver: STATS_VER, stats_hash: "abc", hash_md5: "abc" };
  assert.equal(statsVigentes(base), true);
  assert.equal(statsVigentes({ ...base, stats_ver: STATS_VER + 1 }), false);
  assert.equal(statsVigentes({ ...base, hash_md5: "otro" }), false);
  assert.equal(statsVigentes({ ...base, stats: null }), false);
  assert.equal(statsVigentes(null), false);
});

test("statsVigentes: sin hash_md5 NO hay falso positivo undefined === undefined", () => {
  // Bug real detectado en el análisis: dos undefined comparaban iguales y las
  // stats quedaban pegadas a un contenido que ya había cambiado.
  assert.equal(statsVigentes({ stats: { neto_ha: 1 }, stats_ver: STATS_VER }), false);
  assert.equal(statsVigentes({ stats: { neto_ha: 1 }, stats_ver: STATS_VER, stats_hash: undefined, hash_md5: undefined }), false);
});
