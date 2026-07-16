// services/lluvias_fuentes/index.js
// Registro de fuentes de lluvia. Cada fuente "por punto" expone:
//   { id, nombre, tipo, resolucion, capacidades:{historico,pronostico}, historico(lat,lon,desde,hasta,opts), pronostico?(lat,lon,opts) }
// INA es "por estación" y se importa con su flujo dedicado (ver routes/lluvias.js),
// pero se lista acá para que la UI la muestre junto al resto.
"use strict";

const om        = require("../openmeteo");
const nasapower = require("./nasapower");
const chirps    = require("./chirps");

// Adapter de Open-Meteo (única fuente con pronóstico real). Usa la API key
// de la org si está configurada (opts.apiKey).
const openmeteo = {
  id:          "openmeteo",
  nombre:      "Open-Meteo",
  tipo:        "satelital",
  resolucion:  "~11 km · con pronóstico",
  capacidades: { historico: true, pronostico: true },
  historico:   (lat, lon, desde, hasta, opts = {}) => om.historico(lat, lon, desde, hasta, opts.apiKey),
  pronostico:  (lat, lon, opts = {}) => om.pronostico(lat, lon, opts),
};

// Fuentes "por punto" (importación genérica).
const PUNTO = { openmeteo, nasapower, chirps };

// Metadata de INA (flujo por estación, no genérico).
const INA_META = {
  id:          "ina",
  nombre:      "INA (estaciones)",
  tipo:        "estacion",
  resolucion:  "pluviómetros hidrológicos · tiempo real",
  capacidades: { historico: true, pronostico: false, estaciones: true },
  punto:       false,
};

function meta(f) {
  return { id: f.id, nombre: f.nombre, tipo: f.tipo, resolucion: f.resolucion, capacidades: f.capacidades, punto: true };
}

// Lista de fuentes para la UI (satelitales por punto + INA por estación).
function list() {
  return [...Object.values(PUNTO).map(meta), INA_META];
}

// Devuelve la fuente por-punto con su id, o null.
function get(id) {
  return PUNTO[id] || null;
}

module.exports = { list, get };
