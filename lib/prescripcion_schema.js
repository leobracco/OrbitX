"use strict";
// prescripcion_schema.js — UN solo esquema de properties por zona.
//
// En el navegador conviven cuatro formatos distintos para lo mismo (el que va
// al tractor, el export GeoJSON, el DBF y el JSON de QuantiX). Antes de
// automatizar la generación hay que normalizar: si la generación automática
// elige otro, QuantiX no la lee.
//
// Canónico (decisión del spec): { zona, dosis, unidad, nombre } + ndvi_medio y
// ha, que son informativos. `dosis` es la clave que lee PilotX (su parser
// acepta dosis/dose/rate/kgha/lha/tasa: usamos la primera).
const PROPS_CANONICAS = ["zona", "dosis", "unidad", "nombre", "ndvi_medio", "ha"];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalizarColeccion(fc, { nombre = "" } = {}) {
  const features = (fc?.features || []).map((f, i) => {
    const p = f.properties || {};
    const zona = num(p.zona) ?? (i + 1);
    return {
      type: "Feature",
      geometry: f.geometry,
      properties: {
        zona,
        dosis:      num(p.dosis),
        unidad:     p.unidad || null,
        nombre:     p.nombre || `Zona ${zona}`,
        ndvi_medio: num(p.ndvi_medio),
        ha:         num(p.ha),
      },
    };
  });
  return {
    type: "FeatureCollection",
    // `prescription_dosis_variable` no es estándar, pero es lo que PilotX /
    // QuantiX ya buscan en el archivo que baja el tractor. No sacarlo.
    properties: { prescription_dosis_variable: true, nombre: nombre || fc?.properties?.nombre || "" },
    features,
  };
}

// dosis puede ser un array (una por zona, en orden) o {min,max} para
// interpolar. `sentido` decide si va más insumo donde hay más vigor o donde
// hay menos.
function asignarDosis(fc, { dosis, unidad = null, sentido = "mas_donde_menos" } = {}) {
  const features = (fc.features || []).slice().sort((a, b) => a.properties.zona - b.properties.zona);
  const n = features.length;
  const valor = (i) => {
    if (Array.isArray(dosis)) return num(dosis[i]);
    if (dosis && typeof dosis === "object") {
      const min = num(dosis.min) ?? 0, max = num(dosis.max) ?? 0;
      if (n <= 1) return max;
      const t = i / (n - 1);
      return Math.round((sentido === "mas_donde_mas" ? min + t * (max - min) : max - t * (max - min)) * 100) / 100;
    }
    return null;
  };
  return {
    ...fc,
    features: features.map((f, i) => ({
      ...f,
      properties: { ...f.properties, dosis: valor(i), unidad: unidad ?? f.properties.unidad },
    })),
  };
}

// Convierte una prescripción guardada en localStorage['orbitx_presc'].
// La dosis canónica es la semilla (es la que QuantiX usa como set point); el
// fertilizante se conserva en `extra` y en `units` para no perder nada.
function desdeLocalStorage(obj) {
  if (!obj || !Array.isArray(obj.data) || !obj.data.length) return null;
  const features = obj.data.map((z, i) => ({
    type: "Feature",
    geometry: z.geojson?.geometry || z.geojson || null,
    properties: {
      zona:       i + 1,
      dosis:      num(z.semilla),
      unidad:     obj.units?.semilla || null,
      nombre:     z.nombre || `Zona ${i + 1}`,
      ndvi_medio: null,
      ha:         null,
    },
  }));
  return {
    nombre: obj.nombre || "Sin nombre",
    origen: "manual",
    units:  obj.units || null,
    extra:  obj.data.map(z => ({ ferti_linea: num(z.ferti_linea), ferti_costado: num(z.ferti_costado) })),
    geojson: { type: "FeatureCollection", properties: { prescription_dosis_variable: true, nombre: obj.nombre || "" }, features },
    local_id: obj.id || null,
  };
}

module.exports = { PROPS_CANONICAS, normalizarColeccion, asignarDosis, desdeLocalStorage };
