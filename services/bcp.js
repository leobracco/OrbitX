// services/bcp.js — Estaciones meteorológicas de la Bolsa de Cereales de Bahía Blanca.
// No hay API: MapaG.asp trae todas las estaciones en arrays JS
// (htmlEstacion/habilEstacion/sitioEstacion + jsDatos[i][sensor][0|1]).
// Si cambian la página, parsear() devuelve [] y estaciones() tira error.
const URL_MAPA = "https://info.bcp.org.ar/Estaciones/MapaG.asp";

// Índices de sensor en jsDatos (constantes que define la propia página).
const S = {
  lat: 0, lon: 1,
  temp: 5, tmin: 6, tmax: 7,
  ppDia: 10, pp7d: 11, ppMes: 12, ppAno: 13,
  hum: 14, presion: 16, radiacion: 17,
  vientoVel: 19, rafagaMaxDia: 21, vientoDir: 23, ultDato: 25,
};

const ENTIDADES = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", ordm: "º", sup2: "²", nbsp: " ", amp: "&",
};
function desentidad(s) {
  return String(s).replace(/&(\w+);/g, (m, n) => ENTIDADES[n] ?? m);
}

// "1.7 mm" → 1.7 · "N/D" → null
function num(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// "29/09/2026 8:51:00" → { fecha:"2026-09-29", iso:"2026-09-29T08:51:00-03:00" }
function fechaHora(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || "").trim());
  if (!m) return null;
  const p2 = (x) => String(x).padStart(2, "0");
  const fecha = `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
  const hora  = m[4] ? `${p2(m[4])}:${m[5]}:${m[6] || "00"}` : "00:00:00";
  return { fecha, iso: `${fecha}T${hora}-03:00` };
}

function hoyArgentina() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Rango "01/09 al 28/09" → fecha ISO del último día. La página arma los rangos
// con la fecha de hoy, así que el año sale de hoy (en enero, un rango de
// diciembre es del año anterior).
function hastaDeRango(rango, hoy) {
  const m = /al\s+(\d{1,2})\/(\d{1,2})/.exec(String(rango || ""));
  if (!m) return null;
  let anio = parseInt(hoy.slice(0, 4), 10);
  const mes = parseInt(m[2], 10);
  if (mes > parseInt(hoy.slice(5, 7), 10)) anio -= 1;
  return `${anio}-${String(mes).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

function parsear(html, hoy = hoyArgentina()) {
  const porIdx = {};
  const fila = (i) => (porIdx[i] ||= { sensores: {} });

  for (const m of html.matchAll(/^\s*htmlEstacion\[(\d+)\]\s*=\s*'([^']*)'/gm)) fila(m[1]).html = m[2];
  for (const m of html.matchAll(/^\s*habilEstacion\[(\d+)\]\s*=\s*(\d+)/gm))   fila(m[1]).habil = m[2] === "1";
  for (const m of html.matchAll(/^\s*sitioEstacion\[(\d+)\]\s*=\s*(\d+)/gm))   fila(m[1]).sitio = parseInt(m[2], 10);
  for (const m of html.matchAll(/^\s*jsDatos\[(\d+)\]\[(\d+)\]\[([01])\]\s*=\s*(?:'([^']*)'|(-?[\d.]+))/gm)) {
    const s = (fila(m[1]).sensores[m[2]] ||= []);
    // Los datos atrasados vienen envueltos en <font color=red>…</font>.
    const crudo = m[4] !== undefined ? m[4] : m[5];
    s[parseInt(m[3], 10)] = String(crudo).replace(/<[^>]*>/g, "").trim();
    if (m[2] === String(S.ultDato) && /<font/i.test(crudo)) fila(m[1]).atrasada = true;
  }

  const out = [];
  for (const f of Object.values(porIdx)) {
    const v = (k, j = 0) => f.sensores[S[k]]?.[j];
    const lat = num(v("lat")), lon = num(v("lon"));
    if (!f.sitio || !f.html || lat == null || lon == null) continue;

    const titulo = desentidad(f.html).trim();
    // Bajas: "… HASTA 06/04/26" o "… 16/09/22 AL 31/12/22".
    const baja   = /(?:HASTA|\bAL)\s+(\d{2}\/\d{2}\/\d{2,4})/i.exec(titulo);
    const ult    = fechaHora(v("ultDato"));
    const dirV   = v("vientoDir");
    out.push({
      sitio:          f.sitio,
      numero:         parseInt((/^Estaci[oó]n\s+(\d+)/i.exec(titulo) || [])[1], 10) || null,
      nombre:         titulo.replace(/^Estaci[oó]n\s+\d+\s*-\s*/i, "")
                            .replace(/\s*(HASTA|\d{2}\/\d{2}\/\d{2,4}\s+AL)\s+.*$/i, "").trim(),
      activa:         f.habil !== false && !baja,
      baja:           baja ? baja[1] : null,
      lat, lon,
      ult_dato:       ult?.iso || null,
      ult_fecha:      ult?.fecha || null,
      atrasada:       !!f.atrasada,
      pp_dia:         num(v("ppDia")),
      pp_7d:          num(v("pp7d")),
      pp_mes:         num(v("ppMes")),
      pp_mes_hasta:   hastaDeRango(v("ppMes", 1), hoy),
      pp_ano:         num(v("ppAno")),
      temp:           num(v("temp")),
      tmin:           num(v("tmin")),
      tmax:           num(v("tmax")),
      hum:            num(v("hum")),
      presion:        num(v("presion")),
      radiacion:      num(v("radiacion")),
      viento_kmh:     num(v("vientoVel")),
      viento_dir:     dirV && dirV !== "N/D" ? dirV : null,
      rafaga_max_dia: num(v("rafagaMaxDia")),
    });
  }
  return out.sort((a, b) => (a.numero || 999) - (b.numero || 999));
}

// ── Cache en memoria: una sola descarga sirve a todas las orgs ──
const TTL_MS = 15 * 60 * 1000;
let _cache = null;

async function estaciones({ fresco = false } = {}) {
  if (!fresco && _cache && _cache.exp > Date.now()) return _cache.data;
  const r = await fetch(URL_MAPA, {
    headers: { "User-Agent": "OrbitX/1.0 (Agro Parallel)" },
    signal:  AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`BCP: HTTP ${r.status}`);
  // IIS viejo: la página viene en windows-1252.
  const html = new TextDecoder("windows-1252").decode(await r.arrayBuffer());
  const data = parsear(html);
  if (!data.length) throw new Error("BCP: no se encontraron estaciones (¿cambió la página?)");
  _cache = { data, exp: Date.now() + TTL_MS };
  return data;
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = d => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function buscarEstaciones({ lat, lon, q, limit = 8 } = {}) {
  let lista = (await estaciones()).filter(e => e.activa);
  if (q) {
    const qn = String(q).toLowerCase();
    lista = lista.filter(e => e.nombre.toLowerCase().includes(qn));
  }
  lista = lista.map(e => ({ ...e }));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    lista.forEach(e => { e.dist_km = Math.round(haversineKm(lat, lon, e.lat, e.lon)); });
    lista.sort((a, b) => a.dist_km - b.dist_km);
  }
  return lista.slice(0, limit);
}

module.exports = { estaciones, buscarEstaciones, parsear, hoyArgentina, URL_MAPA };
