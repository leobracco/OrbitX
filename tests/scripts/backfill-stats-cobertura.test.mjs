import { test } from "node:test";
import assert from "node:assert/strict";
import backfill from "../../scripts/backfill-stats-cobertura.js";

const { arg, selectorPara, decidirAccion, formatResumen } = backfill;

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
