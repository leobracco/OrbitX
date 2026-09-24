import { test } from "node:test";
import assert from "node:assert/strict";
import backfill from "../../scripts/backfill-stats-cobertura.js";
import { contornoVigente } from "../../services/actividad.js";

const { arg, selectorPara, decidirAccion, formatResumen, CAMPOS_META, CAMPOS_META_CONTORNOS } = backfill;

test("arg: lee --nombre valor, default y flags booleanos", () => {
  const argv = ["node", "script.js", "--org", "la_flora", "--dry-run", "--limite", "10"];
  assert.equal(arg("org", null, argv), "la_flora");
  assert.equal(arg("dry-run", null, argv), true); // sin valor propio (le sigue --limite)
  assert.equal(arg("limite", 5000, argv), "10");
  assert.equal(arg("historial", null, argv), null); // no está en argv
  assert.equal(arg("no-existe", "def", argv), "def");
});

test("selectorPara: aog_archivo filtra por es_lote:true, historial no", () => {
  assert.deepEqual(selectorPara("aog_archivo"), { tipo: "aog_archivo", es_lote: true, subtipo: "sections_coverage" });
  assert.deepEqual(selectorPara("aog_historial"), { tipo: "aog_historial", subtipo: "sections_coverage" });
});

test("decidirAccion: doc con stats vigentes se saltea", () => {
  const meta = { _id: "aog_x", hash_md5: "abc", stats_ver: 1, stats_hash: "abc", stats: { trabajado_ha: 1 } };
  assert.equal(decidirAccion(meta), "vigente");
});

test("decidirAccion: doc sin hash_md5 se saltea (no se puede invalidar)", () => {
  const meta = { _id: "aog_x" };
  assert.equal(decidirAccion(meta), "sin_hash");
});

test("decidirAccion: doc con hash pero stats desactualizadas/ausentes migra", () => {
  assert.equal(decidirAccion({ _id: "aog_x", hash_md5: "abc" }), "migrar");
  assert.equal(decidirAccion({ _id: "aog_x", hash_md5: "abc", stats_hash: "viejo", stats: { trabajado_ha: 1 }, stats_ver: 1 }), "migrar");
});

test("formatResumen: cuenta total/migrados/salteados/fallidos y marca dry-run", () => {
  const base = { total: 10, migrados: 6, salteados: 3, fallidos: 1 };
  const normal = formatResumen("la_flora", { ...base, dry: false });
  assert.match(normal, /\[la_flora\] listo — 10 vistos · 6 migrados · 3 salteados · 1 fallidos/);
  assert.equal(/DRY RUN/.test(normal), false);

  const dry = formatResumen("la_flora", { ...base, dry: true });
  assert.match(dry, /\(DRY RUN, no se escribió nada\)$/);
});

test("CAMPOS_META incluye stats (sin ella statsVigentes nunca da vigente y el backfill no es idempotente)", () => {
  assert.ok(CAMPOS_META.includes("stats"));
  assert.ok(!CAMPOS_META.includes("contenido"), "contenido se baja de a uno con get()");
});

test("arg: --contornos es un flag booleano como --dry-run", () => {
  const argv = ["node", "script.js", "--org", "la_flora", "--contornos"];
  assert.equal(arg("contornos", null, argv), true);
});

// ── --contornos (I13): mismo selector/decidirAccion, subtipo boundary_kml ──
test("selectorPara: con subtipo explícito (--contornos usa boundary_kml)", () => {
  assert.deepEqual(selectorPara("aog_archivo", "boundary_kml"), { tipo: "aog_archivo", es_lote: true, subtipo: "boundary_kml" });
  // Sin segundo argumento sigue siendo sections_coverage (compat con el uso existente).
  assert.deepEqual(selectorPara("aog_archivo"), { tipo: "aog_archivo", es_lote: true, subtipo: "sections_coverage" });
});

test("decidirAccion: con contornoVigente como vigenteFn decide igual que con statsVigentes, sobre contorno_hash/hash_md5", () => {
  const vigente = { _id: "a", hash_md5: "h1", contorno_hash: "h1", contorno_ha: 12.5 };
  const desactualizado = { _id: "b", hash_md5: "nuevo", contorno_hash: "viejo", contorno_ha: 1 };
  const sinHash = { _id: "c" };
  const nuncaCalculado = { _id: "d", hash_md5: "h2" };

  assert.equal(decidirAccion(vigente, contornoVigente), "vigente");
  assert.equal(decidirAccion(desactualizado, contornoVigente), "migrar");
  assert.equal(decidirAccion(sinHash, contornoVigente), "sin_hash");
  assert.equal(decidirAccion(nuncaCalculado, contornoVigente), "migrar");
});

test("decidirAccion: sin vigenteFn (uso existente de stats) no cambió", () => {
  const meta = { _id: "x", hash_md5: "abc", stats_ver: 1, stats_hash: "abc", stats: { trabajado_ha: 1 } };
  assert.equal(decidirAccion(meta), "vigente");
});

test("CAMPOS_META_CONTORNOS incluye contorno_ha y contorno_hash (para que contornoVigente decida sin bajar contenido) y no contenido", () => {
  assert.ok(CAMPOS_META_CONTORNOS.includes("contorno_ha"));
  assert.ok(CAMPOS_META_CONTORNOS.includes("contorno_hash"));
  assert.ok(CAMPOS_META_CONTORNOS.includes("hash_md5"));
  assert.ok(!CAMPOS_META_CONTORNOS.includes("contenido"));
});
