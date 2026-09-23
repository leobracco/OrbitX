import { test } from "node:test";
import assert from "node:assert/strict";
import esquema from "../../lib/prescripcion_schema.js";

const { normalizarColeccion, asignarDosis, desdeLocalStorage } = esquema;

const FC = () => ({
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { zona: 1, ndvi_medio: 0.3, ha: 10 } },
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }, properties: { zona: 2, ndvi_medio: 0.7, ha: 5 } },
  ],
});

test("normalizarColeccion: deja siempre las mismas properties", () => {
  const fc = normalizarColeccion(FC(), { nombre: "Maíz lote 3" });
  assert.equal(fc.properties.nombre, "Maíz lote 3");
  assert.equal(fc.properties.prescription_dosis_variable, true);
  for (const f of fc.features) {
    assert.deepEqual(Object.keys(f.properties).sort(), ["dosis", "ha", "ndvi_medio", "nombre", "unidad", "zona"]);
    assert.equal(typeof f.properties.zona, "number");
  }
  assert.equal(fc.features[0].properties.nombre, "Zona 1");
});

test("normalizarColeccion: rellena zona y nombre si faltan", () => {
  const fc = normalizarColeccion({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: {} }] }, {});
  assert.equal(fc.features[0].properties.zona, 1);
  assert.equal(fc.features[0].properties.nombre, "Zona 1");
  assert.equal(fc.features[0].properties.dosis, null);
});

test("asignarDosis: lista explícita, en orden de zona", () => {
  const fc = asignarDosis(normalizarColeccion(FC(), {}), { dosis: [80, 120], unidad: "kg_ha" });
  assert.equal(fc.features[0].properties.dosis, 80);
  assert.equal(fc.features[1].properties.dosis, 120);
  assert.equal(fc.features[0].properties.unidad, "kg_ha");
});

test("asignarDosis: interpolación entre min y max según el sentido", () => {
  const base = normalizarColeccion(FC(), {});
  const mas = asignarDosis(base, { dosis: { min: 60, max: 100 }, unidad: "kg_ha", sentido: "mas_donde_mas" });
  assert.equal(mas.features[0].properties.dosis, 60);   // zona de menos vigor
  assert.equal(mas.features[1].properties.dosis, 100);

  const menos = asignarDosis(base, { dosis: { min: 60, max: 100 }, unidad: "kg_ha", sentido: "mas_donde_menos" });
  assert.equal(menos.features[0].properties.dosis, 100);
  assert.equal(menos.features[1].properties.dosis, 60);
});

test("asignarDosis: una sola zona toma el máximo y no divide por cero", () => {
  const fc = normalizarColeccion({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { zona: 1 } }] }, {});
  const out = asignarDosis(fc, { dosis: { min: 10, max: 30 }, unidad: "kg_ha", sentido: "mas_donde_mas" });
  assert.equal(out.features[0].properties.dosis, 30);
});

test("desdeLocalStorage: convierte el formato viejo del navegador", () => {
  const viejo = {
    id: 1720000000000, nombre: "Prueba", fecha: "01/07/2026", zonas: 2,
    units: { semilla: "sem_m", ferti_linea: "kg_ha", ferti_costado: "kg_ha" },
    data: [
      { nombre: "Zona 1", semilla: 7.5, ferti_linea: 80, ferti_costado: 0, geojson: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} } },
      { nombre: "Zona 2", semilla: 9.0, ferti_linea: 100, ferti_costado: 0, geojson: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }, properties: {} } },
    ],
  };
  const out = desdeLocalStorage(viejo);
  assert.equal(out.nombre, "Prueba");
  assert.equal(out.origen, "manual");
  assert.equal(out.geojson.features.length, 2);
  // La dosis canónica es la semilla; ferti va en units/meta para no perder nada.
  assert.equal(out.geojson.features[0].properties.dosis, 7.5);
  assert.equal(out.geojson.features[0].properties.unidad, "sem_m");
  assert.equal(out.geojson.features[1].properties.zona, 2);
  assert.deepEqual(out.units, viejo.units);
  assert.deepEqual(out.extra[0], { ferti_linea: 80, ferti_costado: 0 });
});

test("desdeLocalStorage: objeto basura devuelve null", () => {
  assert.equal(desdeLocalStorage(null), null);
  assert.equal(desdeLocalStorage({ nombre: "x" }), null);
});
