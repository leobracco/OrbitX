// services/aog_parser.js
// Parsea los formatos de archivo de AgOpenGPS → GeoJSON/latLons

// ── Field.txt → lat/lon de origen ────────────────────────
function parseFieldTxt(contenido) {
  try {
    const lines = (contenido||"").trim().split(/\r?\n/);
    const parts = lines[0].trim().split(/\s+/);
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
  const mPerLon = 111320 * Math.cos(origen.lat * Math.PI / 180);
  return [
    origen.lat + y / mPerLat,
    origen.lon + x / mPerLon,
  ];
}

// ── Boundary.txt → polígono ───────────────────────────────
// $Boundary False False 354
// x,y,heading  (metros relativos al origen)
function parseBoundaryTxt(contenido, origen) {
  try {
    const lines  = (contenido||"").trim().split(/\r?\n/);
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
            latLons.push([y, x]); // sin origen, devolver crudo
          }
        }
      }
    }

    if (!latLons.length) return null;
    latLons.push(latLons[0]); // cerrar polígono
    return latLons;
  } catch { return null; }
}

// ── KML → coordenadas WGS84 ───────────────────────────────
function parseKML(contenido) {
  try {
    const match = (contenido||"").match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
    if (!match) return null;
    const points = match[1].trim().split(/\s+/).map(c => {
      const [lon, lat] = c.split(",").map(parseFloat);
      return [lat, lon];
    }).filter(([lat, lon]) => !isNaN(lat) && !isNaN(lon));
    if (!points.length) return null;
    points.push(points[0]);
    return points;
  } catch { return null; }
}

// ── Sections.txt → rectángulos de cobertura ──────────────
function parseSections(contenido, origen) {
  try {
    if (!origen) return null;
    const lines = (contenido||"").trim().split(/\r?\n/).filter(l=>l.trim());
    if (!lines.length) return null;
    const rects = [];
    for (const line of lines) {
      const p = line.trim().split(",").map(parseFloat);
      if (p.length < 4 || p.some(isNaN)) continue;
      const [x1, y1, x2, y2] = p;
      rects.push([
        relToLatLon(origen, x1, y1),
        relToLatLon(origen, x2, y1),
        relToLatLon(origen, x2, y2),
        relToLatLon(origen, x1, y2),
      ]);
    }
    return rects.length ? rects : null;
  } catch { return null; }
}

// ── Parser completo de un lote ────────────────────────────
function parseLote(docs) {
  const result = {
    nombre:   null,
    origen:   null,
    boundary: null,
    sections: null,
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

  // 1. Origen
  if (byType.field_origin?.[0])
    result.origen = parseFieldTxt(byType.field_origin[0].contenido);

  // 2. Boundary: preferir KML (WGS84 directo), si no usar Boundary.txt
  if (byType.boundary_kml?.[0]) {
    result.boundary = parseKML(byType.boundary_kml[0].contenido);
  }
  if (!result.boundary && byType.boundary?.[0]) {
    result.boundary = parseBoundaryTxt(byType.boundary[0].contenido, result.origen);
  }

  // 3. Sections (cobertura aplicada)
  if (byType.sections_coverage?.[0] && result.origen) {
    result.sections = parseSections(byType.sections_coverage[0].contenido, result.origen);
  }

  return result;
}

module.exports = { parseFieldTxt, parseBoundaryTxt, parseKML, parseSections, parseLote };
