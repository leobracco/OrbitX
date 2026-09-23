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
//
// `semilla`, `ferti_linea` y `ferti_costado` también son parte del esquema:
// son las tres dosis que el operador carga en la pantalla de prescripciones y
// las que QuantiX necesita por zona (siembra + fertilizante en línea + al
// costado). Son opcionales: si no vienen quedan en null, pero NO se descartan
// ni se guardan aparte — viajan en las properties de cada feature, que es lo
// único que llega al tractor en el GeoJSON.
const PROPS_CANONICAS = ["zona", "dosis", "unidad", "nombre", "ndvi_medio", "ha", "semilla", "ferti_linea", "ferti_costado"];

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
        // Las tres dosis del operador: se conservan tal cual vinieron.
        semilla:       num(p.semilla),
        ferti_linea:   num(p.ferti_linea),
        ferti_costado: num(p.ferti_costado),
      },
    };
  });
  // `n_zonas` se conserva si vino: es lo que `asignarDosis` usa para mapear la
  // dosis por número de zona (si zonificar saltea una clase, la cantidad de
  // features NO es la cantidad de zonas pedidas).
  const nZonas = num(fc?.properties?.n_zonas);
  return {
    type: "FeatureCollection",
    // `prescription_dosis_variable` no es estándar, pero es lo que PilotX /
    // QuantiX ya buscan en el archivo que baja el tractor. No sacarlo.
    properties: {
      prescription_dosis_variable: true,
      nombre: nombre || fc?.properties?.nombre || "",
      ...(nZonas ? { n_zonas: nZonas } : {}),
    },
    features,
  };
}

// dosis puede ser un array (una por zona, en orden) o {min,max} para
// interpolar. `sentido` decide si va más insumo donde hay más vigor o donde
// hay menos.
//
// El índice de la dosis es el NÚMERO DE ZONA (`properties.zona`), no la
// posición de la feature en el array: `zonificar` puede saltear una clase
// (cuantiles con una moda gigante, o una zona que quedó entera por debajo del
// área mínima) y entonces la zona 3 recibía la dosis pensada para la 2. La
// cantidad de zonas sale de `properties.n_zonas` si está, y si no del número de
// zona más alto que haya.
function asignarDosis(fc, { dosis, unidad = null, sentido = "mas_donde_menos" } = {}) {
  const features = (fc.features || []).slice().sort((a, b) => a.properties.zona - b.properties.zona);
  const zonas = features.map(f => num(f.properties?.zona) || 0);
  const nZonas = Math.max(num(fc?.properties?.n_zonas) || 0, ...zonas, 1);
  const valor = (zona) => {
    const i = (num(zona) || 1) - 1;
    if (Array.isArray(dosis)) return num(dosis[i]);
    if (dosis && typeof dosis === "object") {
      const min = num(dosis.min) ?? 0, max = num(dosis.max) ?? 0;
      if (nZonas <= 1) return max;
      const t = i / (nZonas - 1);
      return Math.round((sentido === "mas_donde_mas" ? min + t * (max - min) : max - t * (max - min)) * 100) / 100;
    }
    return null;
  };
  return {
    ...fc,
    features: features.map(f => ({
      ...f,
      properties: { ...f.properties, dosis: valor(f.properties?.zona), unidad: unidad ?? f.properties.unidad },
    })),
  };
}

// Convierte una prescripción guardada en localStorage['orbitx_presc'].
// La dosis canónica es la semilla (es la que QuantiX usa como set point), pero
// las tres dosis van POR FEATURE: un `extra` paralelo al array de zonas se
// perdía al mandar el GeoJSON al tractor (que es lo único que viaja) y se
// desfasaba con cualquier reordenamiento de features.
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
      semilla:       num(z.semilla),
      ferti_linea:   num(z.ferti_linea),
      ferti_costado: num(z.ferti_costado),
    },
  }));
  return {
    nombre: obj.nombre || "Sin nombre",
    origen: "manual",
    units:  obj.units || null,
    geojson: { type: "FeatureCollection", properties: { prescription_dosis_variable: true, nombre: obj.nombre || "" }, features },
    local_id: obj.id || null,
  };
}

// Rescate de los docs que se migraron con la versión anterior, que guardaba el
// fertilizante en un array `extra` paralelo a las features en vez de dentro de
// cada una. Ese `extra` nunca llegaba al tractor (se manda solo el GeoJSON).
// Se aplica al enviar: si la feature ya trae el dato, no se toca.
function conExtraLegacy(fc, extra) {
  if (!Array.isArray(extra) || !extra.length || !Array.isArray(fc?.features)) return fc;
  return {
    ...fc,
    features: fc.features.map((f, i) => {
      const e = extra[i];
      if (!e || typeof e !== "object") return f;
      const p = f.properties || {};
      return {
        ...f,
        properties: {
          ...p,
          semilla:       p.semilla       ?? num(e.semilla) ?? num(p.dosis),
          ferti_linea:   p.ferti_linea   ?? num(e.ferti_linea),
          ferti_costado: p.ferti_costado ?? num(e.ferti_costado),
        },
      };
    }),
  };
}

module.exports = { PROPS_CANONICAS, normalizarColeccion, asignarDosis, desdeLocalStorage, conExtraLegacy };
