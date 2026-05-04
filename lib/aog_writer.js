// lib/aog_writer.js — Generadores de archivos formato AgOpenGPS.
// Spec basado en AOG v6.x. Una vez generados, OrbitX-Sync los baja
// y los deja en el filesystem del tractor en Fields/<nombre>/.
"use strict";

// Orden lat,lon decimal con 7 dígitos (~1cm de precisión).
function fmt(n, d = 7) {
  return Number(n).toFixed(d);
}

// ── Field.txt ─────────────────────────────────────────────
//
// $FieldDir
// <NombreLote>
// $Offsets
// 0,0
// $Convergence
// 0
// $StartFix
// <lat>,<lon>
function generarFieldTxt({ nombre, origen }) {
  if (!nombre) throw new Error("Hace falta nombre del lote");
  if (!origen || typeof origen.lat !== "number" || typeof origen.lon !== "number")
    throw new Error("Hace falta origen { lat, lon }");

  return [
    "$FieldDir",
    nombre,
    "$Offsets",
    "0,0",
    "$Convergence",
    "0",
    "$StartFix",
    `${fmt(origen.lat)},${fmt(origen.lon)}`,
    "",
  ].join("\r\n");
}

// ── Boundary.txt ──────────────────────────────────────────
//
// $Boundary
// True            (es outer)
// <count>         (cantidad de vértices)
// <lat>,<lon>,<heading=0>,<unused=0>
// ...
//
// Si hay rings interiores (huecos), se repite el bloque con "False".
function generarBoundaryTxt({ rings }) {
  if (!rings || !rings.length) throw new Error("Hace falta al menos un ring");
  const lineas = ["$Boundary"];

  rings.forEach((ring, i) => {
    if (!Array.isArray(ring) || ring.length < 3)
      throw new Error("Cada ring necesita mínimo 3 puntos");

    // Cerrar el ring si hace falta.
    const pts = ring.slice();
    const first = pts[0];
    const last  = pts[pts.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);

    lineas.push(i === 0 ? "True" : "False");  // primer ring = outer, resto = inner
    lineas.push(String(pts.length));
    pts.forEach(([lat, lon]) => {
      lineas.push(`${fmt(lat)},${fmt(lon)},0,0`);
    });
  });

  return lineas.join("\r\n") + "\r\n";
}

// ── boundary.kml — copia para visualizar en Google Earth ──
function generarKML({ nombre, ring }) {
  const coordStr = ring
    .map(([lat, lon]) => `${fmt(lon)},${fmt(lat)},0`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(nombre)}</name>
    <Placemark>
      <name>${escapeXml(nombre)} — Boundary</name>
      <Style>
        <LineStyle><color>ffffffff</color><width>2</width></LineStyle>
        <PolyStyle><color>4d33b09e</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs>
          <LinearRing>
            <coordinates>${coordStr}</coordinates>
          </LinearRing>
        </outerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>
`;
}

function escapeXml(s) {
  return String(s ?? "").replace(/[<>&"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;",
  }[c]));
}

// ── Helpers de geometría ──────────────────────────────────

// Centroide simple del primer ring (lat/lon promedio).
function centroide(ring) {
  let lat = 0, lon = 0;
  for (const p of ring) { lat += p[0]; lon += p[1]; }
  return { lat: lat / ring.length, lon: lon / ring.length };
}

// Hectáreas usando shoelace en proyección equirectangular local.
function calcularHectareas(ring) {
  if (!ring || ring.length < 3) return 0;
  const meanLat = centroide(ring).lat * Math.PI / 180;
  const mLon = 111320 * Math.cos(meanLat);
  const mLat = 110540;
  let acc = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lat1, lon1] = ring[i];
    const [lat2, lon2] = ring[(i + 1) % ring.length];
    const x1 = lon1 * mLon, y1 = lat1 * mLat;
    const x2 = lon2 * mLon, y2 = lat2 * mLat;
    acc += (x1 * y2 - x2 * y1);
  }
  return Math.abs(acc / 2) / 10000; // m² → ha
}

module.exports = {
  generarFieldTxt,
  generarBoundaryTxt,
  generarKML,
  centroide,
  calcularHectareas,
};
