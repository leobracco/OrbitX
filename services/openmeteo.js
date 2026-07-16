// services/openmeteo.js — Cliente de Open-Meteo (open-meteo.com).
// Precipitación diaria por lat/lon (modelo grillado, sin estación física).
// Dos endpoints: archivo histórico (reanálisis) y pronóstico (hasta 16 días).
// Tier gratuito = uso NO comercial. Sin API key.
const ARCHIVE  = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

function buildUrl(base, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${qs}`;
}

async function omGet(base, params) {
  const r = await fetch(buildUrl(base, params), { signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (j && j.error) throw new Error(`Open-Meteo: ${j.reason || "error"}`);
  if (!r.ok) throw new Error(`Open-Meteo: HTTP ${r.status}`);
  return j;
}

// Convierte { daily:{ time:[], precipitation_sum:[] } } → [{ fecha, mm }].
function serie(j) {
  const t  = j?.daily?.time || [];
  const pp = j?.daily?.precipitation_sum || [];
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const fecha = t[i];
    const mm    = Number(pp[i]);
    if (fecha && Number.isFinite(mm)) out.push({ fecha, mm });
  }
  return out;
}

// Serie histórica diaria de precipitación en [desde, hasta] (YYYY-MM-DD).
async function historico(lat, lon, desde, hasta) {
  const j = await omGet(ARCHIVE, {
    latitude:   lat,
    longitude:  lon,
    start_date: desde,
    end_date:   hasta,
    daily:      "precipitation_sum",
    timezone:   "auto",
  });
  return serie(j);
}

// Pronóstico (y opcionalmente días pasados) de precipitación diaria.
// Marca cada día con `futuro:true` si es de hoy en adelante.
async function pronostico(lat, lon, { dias = 10, pastDays = 0 } = {}) {
  const j = await omGet(FORECAST, {
    latitude:     lat,
    longitude:    lon,
    daily:        "precipitation_sum",
    forecast_days: Math.min(Math.max(dias, 1), 16),
    past_days:     Math.min(Math.max(pastDays, 0), 92),
    timezone:      "auto",
  });
  const hoy = new Date().toISOString().slice(0, 10);
  return serie(j).map(d => ({ ...d, futuro: d.fecha >= hoy }));
}

module.exports = { historico, pronostico };
