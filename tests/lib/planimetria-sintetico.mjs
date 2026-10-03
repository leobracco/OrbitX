// Lote sintético para probar lib/planimetria.js: ~400×300 m con lomas suaves
// (±1,5 m), pasadas cada 8 m en serpentina con giros en la cabecera, dos
// vueltas de cabecera, ruido de 2 cm y un sesgo distinto por pasada (±3 cm).
// Genera las partes Elevation_NNNN.txt igual que PilotX (ElevacionPartes.cs):
// cabecera de AOG + filas de 5000, con algunas filas viejas de AOG mezcladas
// (Quality ≠ 4 y una con separador de miles) que el parser tiene que tirar.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { crearProyeccion } = require("../../lib/planimetria.js");

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CABECERA =
  "2026-October-03 10:00:00 AM\r\n$FieldDir\r\nElevation\r\n$Offsets\r\n0,0\r\nConvergence\r\n0\r\nStartFix\r\n-33.1,-61.7\r\n"
  + "Latitude,Longitude,Elevation,Quality,Easting,Northing,Heading,Roll\r\n";

export const POZO = { x: 87.5, y: 260 };

// Superficie verdadera en metros locales (x este, y norte, origen esquina SO).
export function terreno(x, y, { pozo = true, amplitud = 1.5 } = {}) {
  let z = 100 + amplitud * Math.sin(2 * Math.PI * x / 350) * Math.cos(2 * Math.PI * y / 260) + 0.002 * x;
  // Pozo de 50 cm arriba de una loma (87,5 ; 260): un bajo cerrado de verdad.
  if (pozo) z -= 0.5 * Math.exp(-((x - POZO.x) ** 2 + (y - POZO.y) ** 2) / (2 * 15 * 15));
  return z;
}


export function generarLote({
  seed = 7, largo = 400, ancho = 300, espaciado = 8, paso = 1,
  ruido = 0.02, sesgo = 0.03, cabeceras = true, pozo = true,
  filasPorParte = 5000, lat0 = -33.1, lon0 = -61.7, filasViejas = true,
  amplitud = 1.5, // amplitud de las lomas (m)
  hueco = null,   // [yMin, yMax]: franja sin pasadas (para probar celdas null)
} = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const pr = crearProyeccion(lat0, lon0);
  const pts = [];          // {x,y,b} en orden de marcha; b = sesgo de su pasada
  const sesgos = [];
  const nuevaPasada = () => { const b = (rnd() * 2 - 1) * sesgo; sesgos.push(b); return b; };

  const nPas = Math.floor((ancho - espaciado / 2) / espaciado) + 1;
  for (let k = 0; k < nPas; k++) {
    const y = espaciado / 2 + k * espaciado;
    const ida = k % 2 === 0;
    const b = nuevaPasada();
    if (hueco && y >= hueco[0] && y <= hueco[1]) continue;
    for (let s = 0; s <= largo; s += paso) pts.push({ x: ida ? s : largo - s, y, b });
    // Giro en U (semicírculo de radio espaciado/2) con el mismo sesgo.
    if (k < nPas - 1) {
      const r = espaciado / 2, cx = ida ? largo : 0, cy = y + r;
      const nArc = Math.ceil(Math.PI * r / paso);
      for (let t = 1; t < nArc; t++) {
        const a = -Math.PI / 2 + Math.PI * t / nArc;
        pts.push({ x: cx + (ida ? 1 : -1) * r * Math.cos(a), y: cy + r * Math.sin(a), b });
      }
    }
  }
  if (cabeceras) {
    // Dos vueltas de cabecera alrededor, cada lado con su sesgo.
    for (let v = 0; v < 2; v++) {
      const m = 10 + v * espaciado;
      const esq = [[-m, -m / 2], [largo + m, -m / 2], [largo + m, ancho + m / 2], [-m, ancho + m / 2], [-m, -m / 2]];
      for (let e = 0; e < 4; e++) {
        const b = nuevaPasada();
        const [x1, y1] = esq[e], [x2, y2] = esq[e + 1];
        const L = Math.hypot(x2 - x1, y2 - y1);
        for (let s = 0; s < L; s += paso) pts.push({ x: x1 + (x2 - x1) * s / L, y: y1 + (y2 - y1) * s / L, b });
      }
    }
  }

  const filas = [];
  for (const p of pts) {
    const z = terreno(p.x, p.y, { pozo, amplitud }) + p.b + ruido * gauss();
    const [lat, lon] = pr.aLatLon(p.x, p.y);
    filas.push(`${lat.toFixed(7)},${lon.toFixed(7)},${z.toFixed(3)},4,${p.x.toFixed(2)},${p.y.toFixed(2)},${(rnd() * 6.28).toFixed(3)},${(gauss() * 0.5).toFixed(3)}`);
  }
  if (filasViejas) {
    // Filas de AOG viejo: sin RTK (Quality 1/5) con alturas locas, y una con
    // separador de miles que parte la fila en más campos.
    const [la, lo] = pr.aLatLon(200, 150);
    filas.splice(100, 0, `${la.toFixed(7)},${lo.toFixed(7)},150.000,1,200.00,150.00,0.000,0`);
    filas.splice(2000, 0, `${la.toFixed(7)},${lo.toFixed(7)},90.000,5,200.00,150.00,0.000,0`);
    filas.splice(3000, 0, `${la.toFixed(7)},${lo.toFixed(7)},100.000,4,1,234.56,150.00,0.000,0`);
  }

  const partes = [];
  for (let i = 0, idx = 1; i < filas.length; i += filasPorParte, idx++) {
    const nombre = `Elevation_${String(idx).padStart(4, "0")}.txt`;
    partes.push({ nombre, ruta_rel: `aog/fields/Sintetico/Elevation/${nombre}`,
      contenido: CABECERA + filas.slice(i, i + filasPorParte).join("\r\n") + "\r\n" });
  }
  return {
    partes, sesgos, pr, nPuntos: pts.length,
    verdadLatLon: (lat, lon) => { const [x, y] = pr.aXY(lat, lon); return terreno(x, y, { pozo, amplitud }); },
    limite: [[0, 0], [largo, 0], [largo, ancho], [0, ancho]].map(([x, y]) => pr.aLatLon(x, y)),
    pozoLatLon: pr.aLatLon(POZO.x, POZO.y),
  };
}
