import { test } from "node:test";
import assert from "node:assert/strict";
import esquema from "../../lib/prescripcion_schema.js";

const { normalizarColeccion, asignarDosis, desdeLocalStorage, conExtraLegacy, PROPS_CANONICAS } = esquema;

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
    assert.deepEqual(Object.keys(f.properties).sort(), PROPS_CANONICAS.slice().sort());
    assert.equal(typeof f.properties.zona, "number");
  }
  assert.equal(fc.features[0].properties.nombre, "Zona 1");
});

test("normalizarColeccion: conserva semilla / ferti_linea / ferti_costado", () => {
  const fc = normalizarColeccion({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { zona: 1, dosis: 7.5, semilla: 7.5, ferti_linea: 80, ferti_costado: 20 },
    }],
  }, {});
  const p = fc.features[0].properties;
  assert.equal(p.semilla, 7.5);
  assert.equal(p.ferti_linea, 80);
  assert.equal(p.ferti_costado, 20);
});

test("normalizarColeccion: las tres dosis son opcionales y quedan en null", () => {
  const fc = normalizarColeccion({ type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: {} }] }, {});
  const p = fc.features[0].properties;
  assert.equal(p.semilla, null);
  assert.equal(p.ferti_linea, null);
  assert.equal(p.ferti_costado, null);
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
  // La dosis canónica es la semilla; las tres dosis van POR FEATURE (antes el
  // ferti quedaba en un `extra` paralelo que nunca llegaba al tractor).
  assert.equal(out.geojson.features[0].properties.dosis, 7.5);
  assert.equal(out.geojson.features[0].properties.unidad, "sem_m");
  assert.equal(out.geojson.features[1].properties.zona, 2);
  assert.deepEqual(out.units, viejo.units);
  assert.equal(out.geojson.features[0].properties.semilla, 7.5);
  assert.equal(out.geojson.features[0].properties.ferti_linea, 80);
  assert.equal(out.geojson.features[0].properties.ferti_costado, 0);
  assert.equal(out.geojson.features[1].properties.ferti_linea, 100);
  assert.equal(out.extra, undefined, "el `extra` paralelo ya no existe");
  // Y sobreviven a normalizarColeccion, que es por donde pasa todo antes de
  // guardarse y de mandarse al tractor.
  const norm = normalizarColeccion(out.geojson, { nombre: out.nombre });
  assert.equal(norm.features[0].properties.ferti_linea, 80);
  assert.equal(norm.features[1].properties.semilla, 9);
});

test("conExtraLegacy: pliega el `extra` de los docs viejos dentro de cada feature", () => {
  const fc = normalizarColeccion({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: null, properties: { zona: 1, dosis: 7.5 } },
      { type: "Feature", geometry: null, properties: { zona: 2, dosis: 9 } },
    ],
  }, {});
  const out = conExtraLegacy(fc, [{ ferti_linea: 80, ferti_costado: 0 }, { ferti_linea: 100, ferti_costado: 5 }]);
  assert.equal(out.features[0].properties.ferti_linea, 80);
  assert.equal(out.features[0].properties.semilla, 7.5, "sin semilla en el extra, cae a la dosis");
  assert.equal(out.features[1].properties.ferti_costado, 5);
});

test("conExtraLegacy: sin `extra` no toca nada y no pisa lo que ya está", () => {
  const fc = normalizarColeccion({
    type: "FeatureCollection",
    features: [{ type: "Feature", geometry: null, properties: { zona: 1, dosis: 7.5, ferti_linea: 42 } }],
  }, {});
  assert.equal(conExtraLegacy(fc, null), fc);
  assert.equal(conExtraLegacy(fc, []), fc);
  assert.equal(conExtraLegacy(fc, [{ ferti_linea: 999 }]).features[0].properties.ferti_linea, 42);
});

test("desdeLocalStorage: objeto basura devuelve null", () => {
  assert.equal(desdeLocalStorage(null), null);
  assert.equal(desdeLocalStorage({ nombre: "x" }), null);
});

// ── Revisión final de la Pieza 1 ─────────────────────────────

// I14. La dosis se indexa por NÚMERO DE ZONA, no por posición en el array.
// `zonificar` puede saltear una clase (cuantiles con una moda gigante, o una
// zona que quedó entera por debajo del área mínima) y entonces la zona 3
// terminaba con la dosis pensada para la 2 — o sea, el tractor aplicando la
// dosis equivocada en media hectárea.
const FC_CON_HUECO = () => ({
  type: "FeatureCollection",
  properties: { n_zonas: 3 },
  features: [
    { type: "Feature", geometry: null, properties: { zona: 1, ndvi_medio: 0.2, ha: 8 } },
    { type: "Feature", geometry: null, properties: { zona: 3, ndvi_medio: 0.8, ha: 6 } },
  ],
});

test("normalizarColeccion: conserva n_zonas cuando viene", () => {
  assert.equal(normalizarColeccion(FC_CON_HUECO(), {}).properties.n_zonas, 3);
  assert.equal(normalizarColeccion(FC(), {}).properties.n_zonas, undefined);
});

test("asignarDosis: con una zona salteada, la lista se indexa por zona", () => {
  const fc = asignarDosis(normalizarColeccion(FC_CON_HUECO(), {}), { dosis: [10, 20, 30], unidad: "kg_ha" });
  assert.equal(fc.features[0].properties.zona, 1);
  assert.equal(fc.features[0].properties.dosis, 10);
  assert.equal(fc.features[1].properties.zona, 3);
  assert.equal(fc.features[1].properties.dosis, 30, "la zona 3 tiene que llevarse la tercera dosis, no la segunda");
});

test("asignarDosis: con una zona salteada, la interpolación usa n_zonas", () => {
  const fc = asignarDosis(normalizarColeccion(FC_CON_HUECO(), {}), { dosis: { min: 60, max: 120 }, sentido: "mas_donde_mas" });
  assert.equal(fc.features[0].properties.dosis, 60);    // zona 1 → t = 0
  assert.equal(fc.features[1].properties.dosis, 120);   // zona 3 → t = (3-1)/(3-1) = 1

  const inverso = asignarDosis(normalizarColeccion(FC_CON_HUECO(), {}), { dosis: { min: 60, max: 120 }, sentido: "mas_donde_menos" });
  assert.equal(inverso.features[0].properties.dosis, 120);
  assert.equal(inverso.features[1].properties.dosis, 60);
});

test("asignarDosis: sin n_zonas, la cantidad sale del número de zona más alto", () => {
  const crudo = { type: "FeatureCollection", features: FC_CON_HUECO().features };
  const fc = asignarDosis(normalizarColeccion(crudo, {}), { dosis: { min: 60, max: 120 }, sentido: "mas_donde_mas" });
  assert.equal(fc.features[0].properties.dosis, 60);
  assert.equal(fc.features[1].properties.dosis, 120);
});
