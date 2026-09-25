// campana.test.mjs — La sección Campaña del Inicio: formato de números para el
// productor y armado del resumen a partir de GET /api/reportes/temporada.
// Los casos salen de la forma real que devuelve services/reportes.js: lotes con
// trabajado_ha en null (lote del maestro que todavía no se trabajó), cultivo
// sin cargar, y lluvia_mm siempre presente pero en 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatearNumero, formatearHa, formatearMm, armarCampana,
} from "../../app/pantallas/inicio.js";

test("los números se leen como los escribe un productor argentino", () => {
  assert.equal(formatearNumero(1234.5), "1.234,5");
  assert.equal(formatearNumero(1234567.89), "1.234.567,9");
  assert.equal(formatearNumero(999), "999");
  assert.equal(formatearNumero(1000), "1.000");
  // los ceros de la derecha se recortan: "120 ha", no "120,0 ha"
  assert.equal(formatearNumero(120.0), "120");
  assert.equal(formatearNumero(0), "0");
  assert.equal(formatearNumero(-12.34), "-12,3");
  // 0 decimales para conteos y porcentajes
  assert.equal(formatearNumero(86.4, 0), "86");
  assert.equal(formatearNumero(12345, 0), "12.345");
});

test("cero hectáreas es cero, no vacío", () => {
  assert.equal(formatearHa(0), "0 ha");
  assert.equal(formatearMm(0), "0 mm");
  assert.equal(formatearHa(1234.56), "1.234,6 ha");
  assert.equal(formatearMm(45.5), "45,5 mm");
});

test("un valor que no es número no se inventa: sale raya", () => {
  for (const v of [null, undefined, "", "  ", "ochenta", NaN, Infinity, -Infinity, true, false, {}, []]) {
    assert.equal(formatearNumero(v), "—", `falló con ${JSON.stringify(v)}`);
  }
  assert.equal(formatearHa(null), "—");
  assert.equal(formatearMm("mucha"), "—");
  // un número que llega como texto (CouchDB a veces guarda strings) sí se usa
  assert.equal(formatearNumero("120.5"), "120,5");
});

test("respuesta vacía: la sección avisa en vez de pintar ceros", () => {
  for (const r of [null, undefined, {}, { lotes: [], totales: {} }, "no soy un objeto"]) {
    const v = armarCampana(r);
    assert.equal(v.hay_datos, false);
    assert.equal(v.total_lotes, 0);
    assert.equal(v.lotes.length, 0);
    assert.equal(v.cultivos.length, 0);
    assert.equal(v.total_ha, 0);
    assert.equal(v.lluvia_mm, null);
  }
});

test("una campaña real se ordena por hectáreas y agrupa por cultivo", () => {
  const v = armarCampana({
    temporada: "2026/27",
    rango: { desde: "2026-09-01", hasta: "2027-08-31" },
    lotes: [
      { nombre: "La Loma", cultivo: "Soja", trabajado_ha: 120.4, lluvia_mm: 45, ha_estimadas: 140 },
      { nombre: "El Bajo", cultivo: "Maíz", trabajado_ha: 70.1, lluvia_mm: 38.5, ha_estimadas: null },
      { nombre: "Las Tres", cultivo: "Soja", trabajado_ha: 200, lluvia_mm: 0, ha_estimadas: 200 },
      { nombre: "El Monte", cultivo: "Trigo", trabajado_ha: null, lluvia_mm: 0, ha_estimadas: 60 },
    ],
    totales: { lotes: 4, trabajado_ha: 390.5, neto_ha: 380.2, repintado_ha: 10.3, lluvia_mm: 83.5 },
  });

  assert.equal(v.hay_datos, true);
  assert.equal(v.temporada, "2026/27");
  assert.equal(v.total_ha, 390.5);
  assert.equal(v.lluvia_mm, 83.5);
  assert.equal(v.total_lotes, 4);
  assert.equal(v.lotes_trabajados, 3);
  assert.equal(v.lotes_sin_trabajar, 1);
  // el lote sin cobertura no entra en la comparación
  assert.deepEqual(v.lotes.map((l) => l.nombre), ["Las Tres", "La Loma", "El Bajo"]);
  // avance contra lo planificado, solo cuando hay ha_estimadas
  assert.equal(v.lotes[0].avance_pct, 100);
  assert.equal(v.lotes[1].avance_pct, 86);
  assert.equal(v.lotes[2].avance_pct, null);
  // por cultivo, de mayor a menor
  assert.deepEqual(v.cultivos, [
    { cultivo: "Soja", ha: 320.4, lotes: 2 },
    { cultivo: "Maíz", ha: 70.1, lotes: 1 },
  ]);
});

test("campos faltantes no rompen el armado", () => {
  const v = armarCampana({
    lotes: [
      { nombre: "Sin cultivo", trabajado_ha: 30 },
      { trabajado_ha: 10 },
      null,
      "basura",
      { nombre: "  ", trabajado_ha: 5 },
    ],
  });
  assert.equal(v.temporada, null);
  assert.equal(v.lluvia_mm, null);
  assert.equal(v.total_lotes, 3);
  assert.equal(v.lotes_trabajados, 3);
  assert.deepEqual(v.lotes.map((l) => l.nombre), ["Sin cultivo", "Lote sin nombre", "Lote sin nombre"]);
  assert.equal(v.lotes[0].cultivo, null);
  assert.equal(v.lotes[0].lluvia_mm, null);
  assert.equal(v.lotes[0].avance_pct, null);
  // nadie cargó cultivo: no se muestra una bolsa "sin cultivo cargado"
  assert.deepEqual(v.cultivos, []);
  // el backend no mandó totales: se suman los lotes en vez de mostrar raya
  assert.equal(v.total_ha, 45);
});

test("cero hectáreas trabajadas: hay lotes pero ninguno se tocó", () => {
  const v = armarCampana({
    temporada: "2026/27",
    lotes: [
      { nombre: "La Loma", cultivo: "Soja", trabajado_ha: 0, lluvia_mm: 0, ha_estimadas: 140 },
      { nombre: "El Bajo", cultivo: "Maíz", trabajado_ha: null, lluvia_mm: 0, ha_estimadas: 90 },
    ],
    totales: { lotes: 2, trabajado_ha: 0, lluvia_mm: 0 },
  });
  assert.equal(v.hay_datos, true);
  assert.equal(v.total_ha, 0);
  assert.equal(v.lluvia_mm, 0);
  assert.equal(v.lotes_trabajados, 0);
  assert.equal(v.lotes_sin_trabajar, 2);
  assert.deepEqual(v.lotes, []);
  assert.deepEqual(v.cultivos, []);
});

test("números grandes de un establecimiento grande", () => {
  const v = armarCampana({
    lotes: [{ nombre: "Campo Norte", cultivo: "Soja", trabajado_ha: 12345.678, lluvia_mm: 1234.5, ha_estimadas: 12000 }],
    totales: { trabajado_ha: 12345.7, lluvia_mm: 1234.5 },
  });
  assert.equal(formatearHa(v.total_ha), "12.345,7 ha");
  assert.equal(formatearMm(v.lluvia_mm), "1.234,5 mm");
  // 12345,678 sobre 12000 planificadas: 103 %, se trabajó más de lo estimado
  assert.equal(v.lotes[0].avance_pct, 103);
});

test("valores no numéricos en los lotes no ensucian los totales", () => {
  const v = armarCampana({
    lotes: [
      { nombre: "La Loma", cultivo: "Soja", trabajado_ha: "che", lluvia_mm: "mucha", ha_estimadas: "?" },
      { nombre: "El Bajo", cultivo: "Maíz", trabajado_ha: "70.1", lluvia_mm: 10, ha_estimadas: 0 },
    ],
    totales: { trabajado_ha: "no sé", lluvia_mm: null },
  });
  // "che" no es número: el lote queda como sin trabajar
  assert.equal(v.lotes_sin_trabajar, 1);
  assert.equal(v.lotes_trabajados, 1);
  assert.equal(v.lotes[0].nombre, "El Bajo");
  // "70.1" sí es un número escrito como texto
  assert.equal(v.lotes[0].trabajado_ha, 70.1);
  // ha_estimadas en 0 no habilita una división por cero
  assert.equal(v.lotes[0].avance_pct, null);
  // el total del backend no era número: se recalcula con los lotes
  assert.equal(v.total_ha, 70.1);
  assert.equal(v.lluvia_mm, null);
});
