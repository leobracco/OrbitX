import { test } from "node:test";
import assert from "node:assert/strict";
import { agregarTemporada } from "../../services/reportes.js";
import { rangoTemporada } from "../../services/temporada.js";

const rango = rangoTemporada("2025/26");
// Dentro del rango (temporada 2025/26: 2025-09-01 a 2026-08-31)
const tsDentro1 = Date.parse("2025-10-05T12:00:00-03:00");
const tsDentro2 = Date.parse("2025-10-06T12:00:00-03:00"); // más nueva, mismo lote que tsDentro1
// Fuera del rango
const tsFueraAntes = Date.parse("2025-08-20T12:00:00-03:00");

function stats(trabajado, neto) {
  return { trabajado_ha: trabajado, neto_ha: neto, repintado_ha: trabajado - neto, repintado_pct: trabajado > 0 ? Math.round(((trabajado - neto) / trabajado) * 1000) / 10 : 0, bloques: 3 };
}

test("agregarTemporada: solo cuenta coberturas dentro del rango; una fuera de rango no aparece con stats", () => {
  const maestros = [{ nombre: "Lote A", cultivo: "Soja", temporada: "2025/26", ha_estimadas: 40 }, { nombre: "Lote B", cultivo: "Maíz", temporada: "2025/26", ha_estimadas: 20 }];
  const coberturas = [
    { lote_nombre: "Lote A", ts: tsDentro1, stats: stats(35.2, 32) }, // dentro
    { lote_nombre: "Lote B", ts: tsFueraAntes, stats: stats(100, 90) }, // fuera de rango
  ];
  const r = agregarTemporada({ temporada: "2025/26", rango, maestros, coberturas, lluvias: [] });
  const loteA = r.lotes.find(l => l.nombre === "Lote A");
  const loteB = r.lotes.find(l => l.nombre === "Lote B");
  assert.equal(loteA.trabajado_ha, 35.2);
  assert.equal(loteB.trabajado_ha, null); // la cobertura de Lote B queda fuera del rango
  assert.equal(loteB.neto_ha, null);
});

test("agregarTemporada: dos coberturas del mismo lote → gana la de ts más nuevo", () => {
  const coberturas = [
    { lote_nombre: "Lote A", ts: tsDentro1, stats: stats(20, 18) },
    { lote_nombre: "Lote A", ts: tsDentro2, stats: stats(34.6, 30) }, // más nueva, gana
  ];
  const r = agregarTemporada({ temporada: "2025/26", rango, maestros: [], coberturas, lluvias: [] });
  const loteA = r.lotes.find(l => l.nombre === "Lote A");
  assert.equal(loteA.trabajado_ha, 34.6);
  assert.equal(loteA.neto_ha, 30);
  assert.equal(loteA.ultimo_ts, tsDentro2);
});

test("agregarTemporada: lluvia_mm por lote suma solo sus registros; totales.lluvia_mm incluye también los sin lote", () => {
  const maestros = [{ nombre: "Lote A", cultivo: "Soja", temporada: "2025/26", ha_estimadas: 40 }];
  const lluvias = [
    { fecha: "2025-10-01", mm: 12, lote: "Lote A" },
    { fecha: "2025-10-10", mm: 8, lote: "Lote A" },
    { fecha: "2025-11-01", mm: 5, lote: "Otro Lote" },
    { fecha: "2025-11-05", mm: 20 }, // sin lote (lluvia general del establecimiento)
  ];
  const r = agregarTemporada({ temporada: "2025/26", rango, maestros, coberturas: [], lluvias });
  const loteA = r.lotes.find(l => l.nombre === "Lote A");
  assert.equal(loteA.lluvia_mm, 20); // 12 + 8
  assert.equal(r.totales.lluvia_mm, 45); // 12 + 8 + 5 + 20 (todos los registros del rango)
});

test("agregarTemporada: lote solo-maestro (sin cobertura) aparece con stats null y cultivo/ha_estimadas del maestro", () => {
  const maestros = [{ nombre: "Lote C", cultivo: "Trigo", temporada: "2025/26", ha_estimadas: 15 }];
  const r = agregarTemporada({ temporada: "2025/26", rango, maestros, coberturas: [], lluvias: [] });
  assert.equal(r.lotes.length, 1);
  const loteC = r.lotes[0];
  assert.equal(loteC.cultivo, "Trigo");
  assert.equal(loteC.ha_estimadas, 15);
  assert.equal(loteC.temporada, "2025/26");
  assert.equal(loteC.trabajado_ha, null);
  assert.equal(loteC.neto_ha, null);
  assert.equal(loteC.repintado_ha, null);
  assert.equal(loteC.repintado_pct, null);
  assert.equal(loteC.bloques, null);
  assert.equal(loteC.ultimo_ts, null);
  assert.equal(loteC.lluvia_mm, 0);
});

test("agregarTemporada: orden desc por trabajado_ha con los null (sin cobertura) al final, y redondeo a 1 decimal", () => {
  const maestros = [{ nombre: "Solo maestro", cultivo: "Girasol", temporada: "2025/26", ha_estimadas: 10 }];
  const coberturas = [
    { lote_nombre: "Chico", ts: tsDentro1, stats: stats(10.333, 9.111) },
    { lote_nombre: "Grande", ts: tsDentro1, stats: stats(50.555, 45.222) },
  ];
  const r = agregarTemporada({ temporada: "2025/26", rango, maestros, coberturas, lluvias: [] });
  assert.deepEqual(r.lotes.map(l => l.nombre), ["Grande", "Chico", "Solo maestro"]);
  const grande = r.lotes.find(l => l.nombre === "Grande");
  assert.equal(grande.trabajado_ha, 50.6); // 50.555 → 1 decimal
  assert.equal(grande.neto_ha, 45.2); // 45.222 → 1 decimal
  const chico = r.lotes.find(l => l.nombre === "Chico");
  assert.equal(chico.trabajado_ha, 10.3); // 10.333 → 1 decimal
  assert.equal(r.totales.lotes, 3);
  assert.equal(r.totales.trabajado_ha, 60.9); // 50.6 + 10.3 + 0 (solo maestro)
  assert.equal(r.rango.desde, "2025-09-01");
  assert.equal(r.rango.hasta, "2026-08-31");
});
