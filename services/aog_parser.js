// services/aog_parser.js
// Parsea los formatos de archivo de AgOpenGPS → GeoJSON/latLons

// ── Field.txt → lat/lon de origen ────────────────────────
// Formato nuevo AOG: tiene header con $FieldDir, StartFix, etc.
// Formato viejo: lat lon en la primera línea
function parseFieldTxt(contenido) {
  try {
    const lines = (contenido || "").trim().split(/\r?\n/);

    // Formato nuevo: buscar "StartFix" y leer la siguiente línea
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].trim() === "StartFix") {
        const parts = lines[i + 1].trim().split(",");
        if (parts.length >= 2) {
          const lat = parseFloat(parts[0]);
          const lon = parseFloat(parts[1]);
          if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
            return { lat, lon };
        }
      }
    }

    // Fallback: formato viejo (lat lon en la primera línea, separados por espacio o coma)
    const parts = lines[0].trim().split(/[\s,]+/);
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lon = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        return { lat, lon };
    }
  } catch {}
  return null;
}

// ── Metros relativos → lat/lon ────────────────────────────
function relToLatLon(origen, x, y) {
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((origen.lat * Math.PI) / 180);
  return [origen.lat + y / mPerLat, origen.lon + x / mPerLon];
}

// ── Boundary.txt → polígono ───────────────────────────────
// $Boundary False False 354
// x,y,heading  (metros relativos al origen)
function parseBoundaryTxt(contenido, origen) {
  try {
    const lines  = (contenido || "").trim().split(/\r?\n/);
    const header = lines[0].trim().split(/\s+/);
    if (!header[0]?.startsWith("$Boundary")) return null;

    const nPoints = parseInt(header[3]) || 0;
    const latLons = [];

    for (let i = 1; i < lines.length && latLons.length < nPoints; i++) {
      const p = lines[i].trim().split(",");
      if (p.length >= 2) {
        const x = parseFloat(p[0]);
        const y = parseFloat(p[1]);
        if (!isNaN(x) && !isNaN(y)) {
          if (origen) {
            latLons.push(relToLatLon(origen, x, y));
          } else {
            latLons.push([y, x]);
          }
        }
      }
    }

    if (!latLons.length) return null;
    latLons.push(latLons[0]); // cerrar polígono
    return latLons;
  } catch {
    return null;
  }
}

// ── KML → coordenadas WGS84 ───────────────────────────────
function parseKML(contenido) {
  try {
    const match = (contenido || "").match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
    if (!match) return null;
    const points = match[1]
      .trim()
      .split(/\s+/)
      .map((c) => {
        const [lon, lat] = c.split(",").map(parseFloat);
        return [lat, lon];
      })
      .filter(([lat, lon]) => !isNaN(lat) && !isNaN(lon));
    if (!points.length) return null;
    points.push(points[0]);
    return points;
  } catch {
    return null;
  }
}

// ── Sections.txt → polígonos de cobertura ────────────────
// Formato AOG real:
//   nPoints          ← entero solo en la línea (sin coma)
//   anchoIzq,anchoDer,heading
//   x,y,0  ← punto izquierdo
//   x,y,0  ← punto derecho  (alternados)
//   ...
function parseSections(contenido, origen) {
  try {
    if (!origen) return null;
    const lines = (contenido || "").trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return null;

    const polys = [];
    let i = 0;

    while (i < lines.length) {
      // Encabezado de bloque: un solo entero sin coma
      const nPts = parseInt(lines[i]);
      if (isNaN(nPts) || lines[i].includes(",")) { i++; continue; }
      i++;

      // Línea metadata (anchoIzq,anchoDer,heading) — 3 valores
      if (i < lines.length && lines[i].split(",").length === 3) i++;

      // Leer nPts puntos alternados izq/der
      const ptsIzq = [], ptsDer = [];
      for (let j = 0; j < nPts && i < lines.length; j++, i++) {
        const p = lines[i].split(",").map(parseFloat);
        if (p.length >= 2 && !p.some(isNaN)) {
          if (j % 2 === 0) ptsIzq.push(relToLatLon(origen, p[0], p[1]));
          else              ptsDer.push(relToLatLon(origen, p[0], p[1]));
        }
      }

      if (ptsIzq.length && ptsDer.length) {
        polys.push([...ptsIzq, ...ptsDer.reverse(), ptsIzq[0]]);
      }
    }

    return polys.length ? polys : null;
  } catch (e) {
    console.error("[parseSections]", e.message);
    return null;
  }
}

// ── Parser completo de un lote ────────────────────────────
function parseLote(docs) {
  const result = {
    nombre:    null,
    origen:    null,
    boundary:  null,
    sections:  null,
    ts_ultimo: 0,
  };

  if (!docs.length) return result;
  result.nombre = docs[0].lote_nombre || "?";

  const byType = {};
  for (const doc of docs) {
    byType[doc.subtipo] = byType[doc.subtipo] || [];
    byType[doc.subtipo].push(doc);
    if (doc.ts > result.ts_ultimo) result.ts_ultimo = doc.ts;
  }

  // 1. Origen desde Field.txt
  if (byType.field_origin?.[0])
    result.origen = parseFieldTxt(byType.field_origin[0].contenido);

  // 2. Boundary: preferir KML (WGS84 directo), si no usar Boundary.txt
  if (byType.boundary_kml?.[0]) {
    result.boundary = parseKML(byType.boundary_kml[0].contenido);
  }
  if (!result.boundary && byType.boundary?.[0]) {
    result.boundary = parseBoundaryTxt(byType.boundary[0].contenido, result.origen);
  }

  // 3. Sections (cobertura aplicada) — requiere origen para convertir metros → lat/lon
  if (byType.sections_coverage?.[0] && result.origen) {
    result.sections = parseSections(byType.sections_coverage[0].contenido, result.origen);
  }

  return result;
}

module.exports = { parseFieldTxt, parseBoundaryTxt, parseKML, parseSections, parseLote };
