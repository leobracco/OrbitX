// equipos.test.mjs — La comparación de versiones de la pantalla Equipos.
// Los casos salen de datos reales del parque (2026-09-25): nodos que reportan
// "Flow" cuando el catálogo lo llama "FlowX", equipos con versiones que no son
// semver y equipos MÁS nuevos que el catálogo.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claveProducto, buscarUltima, esSemver, comparar, hayActualizacion,
} from "../../app/pantallas/equipos.js";

const CATALOGO = {
  "pilotx": "1.0.84",
  "pilotxparche": "1.0.84",
  "quantix": "3.0.1",
  "flowx": "1.9.12",
  "toolx": "1.0.0",
  "corex-ecu": "1.16.2",
};

test("comparar ordena versiones numéricas", () => {
  assert.equal(comparar("1.0.84", "1.0.83"), 1);
  assert.equal(comparar("1.0.78", "1.0.84"), -1);
  assert.equal(comparar("1.0.84", "1.0.84"), 0);
  // 1.0.9 < 1.0.10: por número, no alfabético
  assert.equal(comparar("1.0.9", "1.0.10"), -1);
  // distinta cantidad de partes
  assert.equal(comparar("3.0", "3.0.1"), -1);
  assert.equal(comparar("3.0.0", "3.0"), 0);
});

test("una versión que no es numérica no se compara", () => {
  // Un equipo real reporta "AgOpenGPS-AP": no debe dar ni mayor ni menor.
  assert.equal(esSemver("AgOpenGPS-AP"), false);
  assert.equal(comparar("AgOpenGPS-AP", "1.0.84"), 0);
  assert.equal(hayActualizacion("AgOpenGPS-AP", "1.0.84"), false);
});

test("el tipo del nodo encuentra su producto en el catálogo", () => {
  assert.equal(claveProducto("  QuantiX "), "quantix");
  // el nodo dice "Quantix", el catálogo "QuantiX"
  assert.equal(buscarUltima(CATALOGO, "Quantix"), "3.0.1");
  // el nodo dice "Flow", el catálogo "FlowX" — la X de más la agrega la búsqueda
  assert.equal(buscarUltima(CATALOGO, "Flow"), "1.9.12");
  assert.equal(buscarUltima(CATALOGO, "Toolx"), "1.0.0");
  assert.equal(buscarUltima(CATALOGO, "CoreX-ECU"), "1.16.2");
  assert.equal(buscarUltima(CATALOGO, "InventadoX"), null);
  assert.equal(buscarUltima(CATALOGO, ""), null);
});

test("hay actualización solo cuando el catálogo tiene algo más nuevo", () => {
  assert.equal(hayActualizacion("1.0.78", "1.0.84"), true);
  assert.equal(hayActualizacion("1.0.84", "1.0.84"), false);
  // un equipo con build de prueba, más nuevo que el catálogo, está al día
  assert.equal(hayActualizacion("1.0.85", "1.0.84"), false);
  // un nodo ToolX en 1.0.1 con catálogo en 1.0.0: al día
  assert.equal(hayActualizacion("1.0.1", "1.0.0"), false);
  // sin dato de un lado, no se afirma nada
  assert.equal(hayActualizacion(null, "1.0.84"), false);
  assert.equal(hayActualizacion("1.0.84", null), false);
});
