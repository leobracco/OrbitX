import { test } from "node:test";
import assert from "node:assert/strict";
import cs from "../../services/cobertura_stats.js";

const { agregarACola, statsParaDoc } = cs;

test("agregarACola: dedupe por clave", () => {
  const cola = [], vistos = new Set();
  assert.equal(agregarACola(cola, vistos, "la_flora::aog_x"), true);
  assert.equal(agregarACola(cola, vistos, "la_flora::aog_x"), false);
  assert.equal(agregarACola(cola, vistos, "la_flora::aog_y"), true);
  assert.deepEqual(cola, ["la_flora::aog_x", "la_flora::aog_y"]);
});

test("agregarACola: la misma ruta en dos orgs son claves distintas", () => {
  const cola = [], vistos = new Set();
  agregarACola(cola, vistos, "la_flora::aog_x");
  assert.equal(agregarACola(cola, vistos, "el_susto::aog_x"), true);
  assert.equal(cola.length, 2);
});

test("statsParaDoc: saca contorno_ha (no se conoce al momento del sync)", () => {
  const s = { trabajado_ha: 12, neto_ha: 11, repintado_ha: 1, repintado_pct: 8.3, contorno_ha: 0, bloques: 20, resolucion_m: 0.5 };
  const out = statsParaDoc(s);
  assert.equal("contorno_ha" in out, false);
  assert.equal(out.trabajado_ha, 12);
  assert.equal(out.bloques, 20);
  assert.equal(statsParaDoc(null), null);
});
