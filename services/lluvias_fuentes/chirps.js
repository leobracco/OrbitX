// services/lluvias_fuentes/chirps.js
// CHIRPS (UCSB) vía ClimateSERV — lluvia satelital ~5 km, diaria desde 1981.
// El estándar para agro. Solo histórico (latencia de días/semanas).
// API asíncrona: submit → poll de progreso → traer datos.
"use strict";

const API = "https://climateserv.servirglobal.net/api";
const DATATYPE_CHIRPS = 0;     // "UCSB CHIRPS" en ClimateSERV
const INTERVAL_DAILY  = 0;
const OP_AVERAGE      = 5;     // promedio sobre el polígono (chico → ≈ valor del punto)

const fmt = (f) => { const [y, m, d] = f.split("-"); return `${m}/${d}/${y}`; }; // MM/DD/YYYY
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function submit(lat, lon, desde, hasta) {
  const d = 0.02; // ~2 km de lado: cae dentro de una celda CHIRPS
  const geometry = JSON.stringify({
    type: "Polygon",
    coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]],
  });
  const qs = new URLSearchParams({
    datatype:     String(DATATYPE_CHIRPS),
    begintime:    fmt(desde),
    endtime:      fmt(hasta),
    intervaltype: String(INTERVAL_DAILY),
    operationtype: String(OP_AVERAGE),
    geometry,
  });
  const r = await fetch(`${API}/submitDataRequest/?${qs}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`CHIRPS: HTTP ${r.status}`);
  const j = await r.json();
  const id = Array.isArray(j) ? j[0] : j?.id;
  if (!id) throw new Error("CHIRPS: no se pudo iniciar la consulta");
  return id;
}

async function progreso(id) {
  const r = await fetch(`${API}/getDataRequestProgress/?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => [0]);
  return Array.isArray(j) ? Number(j[0]) || 0 : 0;
}

async function datos(id) {
  const r = await fetch(`${API}/getDataFromRequest/?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
  const j = await r.json();
  const out = [];
  for (const row of j?.data || []) {
    const iso = row.isodate || row.date; // MM/DD/YYYY
    const mm  = Number(row?.value?.avg ?? row?.raw_value);
    if (!iso || !Number.isFinite(mm) || mm < 0) continue;
    const [m, d, y] = iso.split("/");
    out.push({ fecha: `${y}-${m}-${d}`, mm });
  }
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return out;
}

// Serie diaria de precipitación en [desde, hasta] → [{fecha, mm}].
async function historico(lat, lon, desde, hasta) {
  const id = await submit(lat, lon, desde, hasta);
  for (let i = 0; i < 25; i++) {
    if (await progreso(id) >= 100) break;
    await sleep(2500);
  }
  return datos(id);
}

module.exports = {
  id:          "chirps",
  nombre:      "CHIRPS (satelital 5 km)",
  tipo:        "satelital",
  resolucion:  "~5 km · desde 1981 · estándar agro",
  capacidades: { historico: true, pronostico: false },
  historico,
};
