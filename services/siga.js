// services/siga.js — Estaciones meteorológicas del INTA (SIGA, siga.inta.gob.ar).
// No hay API documentada: la SPA consulta un único PHP proxy que devuelve JSON
// (nombre ofuscado, sale de siga.inta.gob.ar/js/urlserver.js; si lo renombran
// esto se rompe y el error lo dice). "La información es de libre descarga."
const BASE = "https://siga.inta.gob.ar/CdnaUV0iiERRpFQE.php";

// "diario" corta en silencio a los 1000 registros: se pide en tramos.
const TRAMO_DIAS = 900;
// Una estación con último registro más viejo que esto se considera inactiva.
const ACTIVA_DIAS = 7;

async function sigaGet(tipo, valor = "") {
  const url = `${BASE}?param_type=${encodeURIComponent(tipo)}&param_value=${valor}`;
  const r = await fetch(url, {
    headers: { "User-Agent": "OrbitX/1.0 (Agro Parallel)" },
    signal:  AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`SIGA ${tipo}: HTTP ${r.status}`);
  const txt = await r.text();
  if (!txt.trim()) return [];
  try { return JSON.parse(txt); }
  catch { throw new Error(`SIGA ${tipo}: respuesta no es JSON (¿cambió la API?)`); }
}

// "2026-09-27T00:00:00Z[UTC]" → "2026-09-27T00:00:00Z"
function limpiarFecha(s) {
  return s ? String(s).replace(/\[.*\]$/, "") : null;
}

// ISO "2026-09-20" → "20-9-2026" (el endpoint devuelve vacío con ISO o con ceros).
function fechaSiga(iso) {
  const [a, m, d] = iso.split("-").map(Number);
  return `${d}-${m}-${a}`;
}

function sumarDias(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Cache en memoria del catálogo ─────────────────────────
const TTL_MS = 3 * 3600 * 1000;
let _cache = null;

// Catálogo con último dato (estacionautomatica trae también las convencionales).
async function estaciones() {
  if (_cache && _cache.exp > Date.now()) return _cache.data;
  const d = await sigaGet("estacionautomatica");
  const limite = Date.now() - ACTIVA_DIAS * 86400000;
  const map = {};
  for (const e of Array.isArray(d) ? d : []) {
    if (typeof e.latitud !== "number" || typeof e.longitud !== "number") continue;
    const ult = limpiarFecha(e.ultimoRegistro);
    map[e.id] = {
      id:         e.id,
      id_interno: e.idInterno || null,
      nombre:     e.nombre,
      provincia:  e.provincia || null,
      localidad:  e.localidad || null,
      tipo:       e.tipo || null,
      lat:        e.latitud,
      lon:        e.longitud,
      desde:      limpiarFecha(e.minimoDiario)?.slice(0, 10) || null,
      hasta:      limpiarFecha(e.maximoDiario)?.slice(0, 10) || null,
      ult_dato:   ult,
      activa:     !!ult && new Date(ult).getTime() > limite,
      pp_hoy:     typeof e.precipitacion === "number" ? Math.round(e.precipitacion * 10) / 10 : null,
      pp_4d:      typeof e.precipitacionAcumulada4dias === "number" ? Math.round(e.precipitacionAcumulada4dias * 10) / 10 : null,
      temp:       e.temperaturaActual ?? null,
    };
  }
  if (!Object.keys(map).length) throw new Error("SIGA: catálogo vacío (¿cambió la API?)");
  _cache = { data: map, exp: Date.now() + TTL_MS };
  return map;
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = d => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Estaciones con histórico diario, por cercanía o texto. Por defecto solo las
// que reportan; con inactivas:true también las viejas (sirven para histórico).
async function buscarEstaciones({ lat, lon, q, limit = 8, inactivas = false } = {}) {
  let lista = Object.values(await estaciones()).filter(e => e.desde && (inactivas || e.activa));
  if (q) {
    const qn = String(q).toLowerCase();
    lista = lista.filter(e =>
      (e.nombre || "").toLowerCase().includes(qn) ||
      (e.localidad || "").toLowerCase().includes(qn) ||
      (e.provincia || "").toLowerCase().includes(qn));
  }
  lista = lista.map(e => ({ ...e }));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    lista.forEach(e => { e.dist_km = Math.round(haversineKm(lat, lon, e.lat, e.lon)); });
    lista.sort((a, b) => a.dist_km - b.dist_km);
  }
  return lista.slice(0, limit);
}

// Serie diaria [desde, hasta] → [{ fecha, mm, tmax, tmin, hum, et0 }].
// Lluvia: pluviógrafo (precDiaCrono) en las automáticas, pluviómetro
// (precDiaPlub) si no hay; en las EMA ambos pueden diferir.
async function datosDiarios(id, desde, hasta) {
  const out = [];
  for (let ini = desde; ini <= hasta; ini = sumarDias(ini, TRAMO_DIAS + 1)) {
    const fin = [sumarDias(ini, TRAMO_DIAS), hasta].sort()[0];
    const d = await sigaGet("diario", `${id}/${fechaSiga(ini)}/${fechaSiga(fin)}`);
    for (const r of Array.isArray(d) ? d : []) {
      const fecha = limpiarFecha(r.fechaHora)?.slice(0, 10);
      const mm    = r.precDiaCrono ?? r.precDiaPlub;
      if (!fecha) continue;
      out.push({
        fecha,
        mm:   Number.isFinite(mm) ? mm : null,
        tmax: r.tempAbrigo150Max ?? null,
        tmin: r.tempAbrigo150Min ?? null,
        hum:  r.HMedia ?? null,
        et0:  r.evapotransPotencial ?? null,
      });
    }
  }
  return out;
}

module.exports = { estaciones, buscarEstaciones, datosDiarios };
