// services/ina.js — Cliente de la API a5 del INA (alerta.ina.gob.ar).
// Series de precipitación diaria de la Red Hidrológica Nacional + otras redes.
// La API usa el estilo /pub/datos/<endpoint>&param=val (el & va pegado, NO ?).
const BASE       = "https://alerta.ina.gob.ar/pub/datos";
const VAR_PRECIP = 1; // "precipitación diaria 12Z" (mm/d)

function buildUrl(endpoint, params = {}) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${BASE}/${endpoint}${qs ? "&" + qs : ""}&format=json`;
}

async function inaGet(endpoint, params) {
  const r = await fetch(buildUrl(endpoint, params), { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`INA ${endpoint}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.title === "Mensaje de error") {
    // "No se encontraron resultados" = rango sin datos, no es un error real.
    if (/no se encontraron/i.test(j.mensaje || "")) return [];
    throw new Error(`INA: ${j.mensaje || "error"}`);
  }
  return j.data || [];
}

// ── Cache en memoria (los catálogos cambian poco) ─────────
const _cache = {};
const TTL_MS = 6 * 3600 * 1000;
async function cached(key, fn) {
  const now = Date.now();
  if (_cache[key] && _cache[key].exp > now) return _cache[key].data;
  const data = await fn();
  _cache[key] = { data, exp: now + TTL_MS };
  return data;
}

// Todas las estaciones con lat/lon, indexadas por sitecode.
async function estaciones() {
  return cached("estaciones", async () => {
    const d = await inaGet("estaciones");
    const map = {};
    for (const e of d) {
      if (typeof e.lat === "number" && typeof e.lon === "number") {
        map[e.sitecode] = {
          sitecode: e.sitecode,
          nombre:   e.nombre,
          distrito: e.distrito || null,
          red:      e.nombre_red || null,
          lat:      e.lat,
          lon:      e.lon,
        };
      }
    }
    return map;
  });
}

// Mejor serie de precipitación diaria por estación (la de más observaciones).
async function seriesPrecip() {
  return cached("series_precip", async () => {
    const d = await inaGet("series", { varId: VAR_PRECIP });
    const best = {};
    for (const s of d) {
      if (s.varid !== VAR_PRECIP || !s.obs_count) continue;
      const cur = best[s.sitecode];
      if (!cur || s.obs_count > cur.obs_count) {
        best[s.sitecode] = {
          sitecode:  s.sitecode,
          seriesid:  s.seriesid,
          from_date: s.from_date,
          to_date:   s.to_date,
          obs_count: s.obs_count,
        };
      }
    }
    return best;
  });
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = d => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Estaciones con precipitación, ordenadas por cercanía a lat/lon, o filtradas
// por texto (nombre/distrito). Devuelve hasta `limit` resultados.
async function buscarEstaciones({ lat, lon, q, limit = 8 } = {}) {
  const [est, ser] = await Promise.all([estaciones(), seriesPrecip()]);
  let lista = Object.values(ser)
    .map(s => {
      const e = est[s.sitecode];
      if (!e) return null;
      return { ...e, from_date: s.from_date, to_date: s.to_date, obs_count: s.obs_count };
    })
    .filter(Boolean);

  if (q) {
    const qn = String(q).toLowerCase();
    lista = lista.filter(e =>
      (e.nombre || "").toLowerCase().includes(qn) ||
      (e.distrito || "").toLowerCase().includes(qn));
  }

  const tieneCoords = Number.isFinite(lat) && Number.isFinite(lon);
  if (tieneCoords) {
    lista.forEach(e => { e.dist_km = Math.round(haversineKm(lat, lon, e.lat, e.lon)); });
    lista.sort((a, b) => a.dist_km - b.dist_km);
  } else {
    lista.sort((a, b) => b.obs_count - a.obs_count);
  }
  return lista.slice(0, limit);
}

// Serie diaria de precipitación de una estación en un rango [desde, hasta].
// Devuelve [{ fecha:"YYYY-MM-DD", mm:Number }].
async function datosPrecip(sitecode, desde, hasta) {
  const d = await inaGet("datos", {
    timeStart: desde,
    timeEnd:   hasta,
    siteCode:  sitecode,
    varId:     VAR_PRECIP,
  });
  const out = [];
  for (const r of d) {
    const fecha = (r.timestart || "").slice(0, 10);
    const mm    = Number(r.valor);
    if (fecha && Number.isFinite(mm)) out.push({ fecha, mm });
  }
  return out;
}

module.exports = { estaciones, seriesPrecip, buscarEstaciones, datosPrecip, VAR_PRECIP };
