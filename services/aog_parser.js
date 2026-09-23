// services/aog_parser.js
// Parsea los formatos de archivo de AgOpenGPS → GeoJSON/latLons

// ── Field.txt → lat/lon de origen ────────────────────────
// Formato nuevo AOG: tiene header con $FieldDir, StartFix, etc.
// Formato viejo: lat lon en la primera línea
function parseFieldTxt(contenido) {
  try {
    const lines = (contenido || "").trim().split(/\r?\n/);

    // Formato nuevo: buscar "StartFix" (con o sin prefijo "$") y leer la
    // siguiente línea. AOG y el writer de OrbitX emiten "$StartFix".
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].trim().replace(/^\$/, "") === "StartFix") {
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
// Soporta dos formatos:
//
// Formato AOG legacy (header inline): "$Boundary False False 354"
//   x,y,heading  (metros relativos al origen)
//
// Formato AOG v6 (multi-línea), también el que genera OrbitX:
//   $Boundary
//   True               ← outer/inner
//   354                ← count
//   lat,lon,0,0        ← coords ABSOLUTAS en grados decimales
function parseBoundaryTxt(contenido, origen) {
  try {
    const lines  = (contenido || "").trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length || !lines[0].startsWith("$Boundary")) return null;

    // Detectar formato por el header.
    const headerTokens = lines[0].split(/\s+/);
    const esLegacy = headerTokens.length >= 4;

    const latLons = [];

    if (esLegacy) {
      const nPoints = parseInt(headerTokens[3]) || 0;
      for (let i = 1; i < lines.length && latLons.length < nPoints; i++) {
        const p = lines[i].split(",");
        if (p.length >= 2) {
          const x = parseFloat(p[0]);
          const y = parseFloat(p[1]);
          if (!isNaN(x) && !isNaN(y)) {
            latLons.push(origen ? relToLatLon(origen, x, y) : [y, x]);
          }
        }
      }
    } else {
      // Formato v6: skip "True"/"False" lines, leer el primer entero solo, después coords lat/lon.
      let i = 1;
      // Saltar línea True/False (puede haber más de un ring; usamos el primero).
      if (lines[i] === "True" || lines[i] === "False") i++;
      const nPoints = parseInt(lines[i]);
      if (isNaN(nPoints)) return null;
      i++;
      // El motor headless de PilotX escribe este mismo header multi-linea
      // pero con x,y,heading en METROS relativos al origen (no lat/lon).
      // Se distingue por la distancia al origen: una coordenada absoluta
      // cae a menos de 0.5 grados del StartFix; un metro relativo, no.
      // Sin este chequeo el contorno quedaba en el Atlantico o vacio.
      for (let leídos = 0; leídos < nPoints && i < lines.length; i++, leídos++) {
        const p = lines[i].split(",");
        if (p.length >= 2) {
          const a = parseFloat(p[0]);
          const b = parseFloat(p[1]);
          if (isNaN(a) || isNaN(b)) continue;
          const esLatLon = Math.abs(a) <= 90 && Math.abs(b) <= 180 &&
            (!origen || (Math.abs(a - origen.lat) < 0.5 && Math.abs(b - origen.lon) < 0.5));
          if (esLatLon) latLons.push([a, b]);
          else if (origen) latLons.push(relToLatLon(origen, a, b));
        }
      }
    }

    if (latLons.length < 3) return null;
    // Cerrar polígono si hace falta.
    const first = latLons[0], last = latLons[latLons.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) latLons.push(first);
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

// ── Sections.txt → bloques de cobertura (metros) ──────────
// Formato AOG real (lo escribe CPatches / SectionsFiles.Append):
//   N              ← cantidad de lineas del bloque, INCLUYENDO la de color
//   r,g,b          ← color del parche (primera de las N)
//   x,y,0          ← punto izquierdo de la barra      ┐ N-1 puntos,
//   x,y,0          ← punto derecho                    ┘ alternados izq/der
//   ...
// Cada bloque es una "tira de triangulos": el area es la suma de los
// triangulos (k, k+1, k+2). PilotX corta un bloque nuevo cada 61 avances o
// cuando las secciones se apagan/prenden — un bloque NO es una pasada.
//
// Bug historico (hasta 2026-09-06): se salteaba la linea de color y despues
// se leian N puntos, uno de mas: se comia el encabezado del bloque siguiente
// y se perdia un bloque de cada dos (14 "pasadas" de 27 bloques reales, y el
// mapa dibujaba la mitad de la cobertura).
function leerBloques(contenido) {
  const lines = (contenido || "").trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const bloques = [];
  let i = 0;
  if (lines[0] && lines[0].startsWith("$")) i = 1;
  while (i < lines.length) {
    const n = parseInt(lines[i]);
    if (isNaN(n) || lines[i].includes(",")) { i++; continue; }
    const cuerpo = lines.slice(i + 1, i + 1 + n);
    i += 1 + n;
    const pts = [];
    // cuerpo[0] es el color; la geometria arranca en [1].
    for (let k = 1; k < cuerpo.length; k++) {
      const p = cuerpo[k].split(",");
      const x = parseFloat(p[0]), y = parseFloat(p[1]);
      if (!isNaN(x) && !isNaN(y)) pts.push([x, y]);
    }
    if (pts.length >= 3) bloques.push(pts);
  }
  return bloques;
}

// Bloques → poligonos lat/lon para dibujar en el mapa.
function parseSections(contenido, origen) {
  try {
    if (!origen) return null;
    const polys = [];
    for (const pts of leerBloques(contenido)) {
      const izq = [], der = [];
      pts.forEach((p, j) => (j % 2 === 0 ? izq : der).push(relToLatLon(origen, p[0], p[1])));
      if (izq.length && der.length) polys.push([...izq, ...der.reverse(), izq[0]]);
    }
    return polys.length ? polys : null;
  } catch (e) {
    console.error("[parseSections]", e.message);
    return null;
  }
}

// ── Estadisticas de cobertura ─────────────────────────────
// Devuelve, en hectareas:
//   trabajado  = lo que sumo la barra (misma formula que PilotX; cuenta dos
//                veces lo repintado)
//   neto       = suelo realmente cubierto (union de todos los parches, en
//                una grilla de 0.5 m)
//   repintado  = trabajado - neto, y su % sobre trabajado
//   contorno   = area del boundary
// La grilla se dimensiona al lote: 100 ha a 0.5 m son 4 MB. Si el lote es
// enorme se baja la resolucion para no pasar de ~40 MB.
function areaTira(pts) {
  let s = 0;
  for (let k = 0; k + 2 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1], c = pts[k + 2];
    s += Math.abs(a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1])) * 0.5;
  }
  return s;
}

function areaPoligono(pts) {
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function netoRaster(bloques) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of bloques) for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return { neto: 0, res: 0 };
  let res = 0.5;
  const MAX_CELDAS = 40e6;
  while (((maxX - minX) / res + 2) * ((maxY - minY) / res + 2) > MAX_CELDAS) res *= 2;
  const W = Math.ceil((maxX - minX) / res) + 2, H = Math.ceil((maxY - minY) / res) + 2;
  const grid = new Uint8Array(W * H);
  let celdas = 0;
  const marcar = (a, b, c) => {
    const bx0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - minX) / res));
    const bx1 = Math.min(W - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - minX) / res));
    const by0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - minY) / res));
    const by1 = Math.min(H - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - minY) / res));
    // Un triangulo de mas de 400 m de lado es un salto de GPS, no cobertura.
    if ((bx1 - bx0) * res > 400 || (by1 - by0) * res > 400) return;
    for (let gy = by0; gy <= by1; gy++) {
      const py = minY + (gy + 0.5) * res;
      for (let gx = bx0; gx <= bx1; gx++) {
        const px = minX + (gx + 0.5) * res;
        const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
        const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
        const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
        const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
        if (neg && pos) continue;
        const idx = gy * W + gx;
        if (!grid[idx]) { grid[idx] = 1; celdas++; }
      }
    }
  };
  for (const pts of bloques)
    for (let k = 0; k + 2 < pts.length; k++) marcar(pts[k], pts[k + 1], pts[k + 2]);
  return { neto: celdas * res * res, res };
}

// Boundary (lat/lon) → metros locales para medir el contorno.
function contornoM2(boundaryLatLon) {
  if (!boundaryLatLon || boundaryLatLon.length < 4) return 0;
  const lat0 = boundaryLatLon[0][0], lon0 = boundaryLatLon[0][1];
  const mPerLat = 111320, mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = boundaryLatLon.map(([la, lo]) => [(lo - lon0) * mPerLon, (la - lat0) * mPerLat]);
  return areaPoligono(pts);
}

function calcularStats(sectionsTxt, boundaryLatLon) {
  try {
    const bloques = leerBloques(sectionsTxt);
    if (!bloques.length) return null;
    let trabajado = 0;
    for (const pts of bloques) trabajado += areaTira(pts);
    const { neto, res } = netoRaster(bloques);
    const repintado = Math.max(0, trabajado - neto);
    const contorno = contornoM2(boundaryLatLon);
    const ha = (m2) => Math.round(m2 / 100) / 100;   // 2 decimales
    return {
      trabajado_ha:  ha(trabajado),
      neto_ha:       ha(neto),
      repintado_ha:  ha(repintado),
      repintado_pct: trabajado > 0 ? Math.round((repintado / trabajado) * 1000) / 10 : 0,
      contorno_ha:   ha(contorno),
      bloques:       bloques.length,
      resolucion_m:  res,
    };
  } catch (e) {
    console.error("[calcularStats]", e.message);
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

  // 4. Estadisticas (ha trabajadas / netas / repintadas / contorno). No
  //    necesita origen: se calcula en metros sobre el archivo crudo.
  result.stats = byType.sections_coverage?.[0]
    ? calcularStats(byType.sections_coverage[0].contenido, result.boundary)
    : null;

  return result;
}

module.exports = { parseFieldTxt, parseBoundaryTxt, parseKML, parseSections, parseLote, leerBloques, calcularStats };
