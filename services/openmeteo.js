// services/openmeteo.js — Cliente de Open-Meteo (open-meteo.com).
// Precipitación diaria por lat/lon (modelo grillado, sin estación física).
// Dos endpoints: archivo histórico (reanálisis) y pronóstico (hasta 16 días).
//
// Dos modos según la API key del cliente:
//   · Sin key  → api.open-meteo.com / archive-api.open-meteo.com (tier gratuito,
//                NO comercial, 10k llamadas/día).
//   · Con key  → customer-api.open-meteo.com (plan pago del propio cliente,
//                uso comercial, ilimitado). La key va en `&apikey=`.
// Así cada org usa su propia suscripción: el uso es individual y comercial-legítimo.
const HOSTS = {
  free: { ARCHIVE: "https://archive-api.open-meteo.com/v1/archive", FORECAST: "https://api.open-meteo.com/v1/forecast" },
  paid: { ARCHIVE: "https://customer-archive-api.open-meteo.com/v1/archive", FORECAST: "https://customer-api.open-meteo.com/v1/forecast" },
};

function buildUrl(base, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${base}?${qs}`;
}

async function omGet(endpoint, params, apiKey) {
  const hosts = apiKey ? HOSTS.paid : HOSTS.free;
  const p     = apiKey ? { ...params, apikey: apiKey } : params;
  const r = await fetch(buildUrl(hosts[endpoint], p), { signal: AbortSignal.timeout(30_000) });
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
async function historico(lat, lon, desde, hasta, apiKey) {
  const j = await omGet("ARCHIVE", {
    latitude:   lat,
    longitude:  lon,
    start_date: desde,
    end_date:   hasta,
    daily:      "precipitation_sum",
    timezone:   "auto",
  }, apiKey);
  return serie(j);
}

// Pronóstico (y opcionalmente días pasados) de precipitación diaria.
// Marca cada día con `futuro:true` si es de hoy en adelante.
async function pronostico(lat, lon, { dias = 10, pastDays = 0, apiKey } = {}) {
  const j = await omGet("FORECAST", {
    latitude:     lat,
    longitude:    lon,
    daily:        "precipitation_sum",
    forecast_days: Math.min(Math.max(dias, 1), 16),
    past_days:     Math.min(Math.max(pastDays, 0), 92),
    timezone:      "auto",
  }, apiKey);
  const hoy = new Date().toISOString().slice(0, 10);
  return serie(j).map(d => ({ ...d, futuro: d.fecha >= hoy }));
}

module.exports = { historico, pronostico };
