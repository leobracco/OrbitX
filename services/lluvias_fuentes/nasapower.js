// services/lluvias_fuentes/nasapower.js
// NASA POWER — precipitación diaria gridded (~50 km), global, sin API key.
// PRECTOTCORR en mm/día. Histórico + casi-tiempo-real (latencia de pocos días).
"use strict";

const BASE = "https://power.larc.nasa.gov/api/temporal/daily/point";

const ymd = (f) => f.replace(/-/g, ""); // "YYYY-MM-DD" → "YYYYMMDD"

// Serie diaria de precipitación en [desde, hasta] (YYYY-MM-DD) → [{fecha, mm}].
async function historico(lat, lon, desde, hasta) {
  const url = `${BASE}?parameters=PRECTOTCORR&community=AG` +
    `&latitude=${lat}&longitude=${lon}&start=${ymd(desde)}&end=${ymd(hasta)}&format=JSON`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`NASA POWER: HTTP ${r.status}`);
  const j = await r.json();
  const p = j?.properties?.parameter?.PRECTOTCORR || {};
  const out = [];
  for (const [k, v] of Object.entries(p)) {
    const mm = Number(v);
    if (mm === -999 || !Number.isFinite(mm) || mm < 0) continue; // -999 = fill value
    out.push({ fecha: `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`, mm });
  }
  out.sort((a, b) => a.fecha.localeCompare(b.fecha));
  return out;
}

module.exports = {
  id:          "nasapower",
  nombre:      "NASA POWER",
  tipo:        "satelital",
  resolucion:  "~50 km · global · desde 1981",
  capacidades: { historico: true, pronostico: false },
  historico,
};
