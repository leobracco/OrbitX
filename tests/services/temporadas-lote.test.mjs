import { test } from "node:test";
import assert from "node:assert/strict";
import tl from "../../services/temporadas_lote.js";

const { derivarTemporadasDeHistorial } = tl;

const ts = (iso) => Date.parse(iso + "T12:00:00-03:00");

test("agrupa por temporada agrícola y se queda con el snapshot más nuevo", () => {
  const docs = [
    { _id: "h1", ts: ts("2025-11-10"), stats: { trabajado_ha: 100, neto_ha: 98 } },
    { _id: "h2", ts: ts("2025-12-20"), stats: { trabajado_ha: 140, neto_ha: 135 } },
    { _id: "h3", ts: ts("2026-10-05"), stats: { trabajado_ha: 60, neto_ha: 59 } },
  ];
  const r = derivarTemporadasDeHistorial(docs);
  assert.deepEqual(r.map(x => x.temporada), ["2026/27", "2025/26"]);
  assert.equal(r[1].doc_id, "h2");
  assert.equal(r[1].trabajado_ha, 140);
  assert.equal(r[0].trabajado_ha, 60);
});

test("docs sin stats entran igual, con los valores en null", () => {
  const r = derivarTemporadasDeHistorial([{ _id: "h1", ts: ts("2026-03-01") }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].trabajado_ha, null);
  assert.equal(r[0].neto_ha, null);
});

test("descarta los docs sin ts y la lista vacía", () => {
  assert.deepEqual(derivarTemporadasDeHistorial([{ _id: "x" }]), []);
  assert.deepEqual(derivarTemporadasDeHistorial([]), []);
});
