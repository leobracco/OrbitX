// services/smn_alertas.js — Alertas del SMN (feed CAP 1.2, licencia CC BY 4.0).
// El índice RSS (CAP/AR.php) lista un XML por evento y zona, cada uno con el
// polígono del área. Se cruzan contra el punto de cada lote de la org.
"use strict";

const URL_FEED = "https://ssl.smn.gob.ar/CAP/AR.php";

// Escala del SMN: amarilla / naranja / roja.
const NIVEL = { Minor: "amarilla", Moderate: "amarilla", Severe: "naranja", Extreme: "roja" };
const ORDEN_NIVEL = { amarilla: 1, naranja: 2, roja: 3 };

function desentidad(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&").trim();
}

function tag(xml, nombre) {
  const m = new RegExp(`<${nombre}>([\\s\\S]*?)</${nombre}>`).exec(xml);
  return m ? desentidad(m[1]) : null;
}

async function get(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "OrbitX/1.0 (Agro Parallel)" },
    signal:  AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`SMN ${url.split("/").pop()}: HTTP ${r.status}`);
  return r.text();
}

// "lat,lon lat,lon …" → [[lat,lon], …]
function parsePoligono(s) {
  return String(s).trim().split(/\s+/)
    .map(par => par.split(",").map(Number))
    .filter(p => p.length === 2 && p.every(Number.isFinite));
}

function parseCap(xml, url) {
  const severidad = tag(xml, "severity");
  const poligonos = [...xml.matchAll(/<polygon>([\s\S]*?)<\/polygon>/g)]
    .map(m => parsePoligono(m[1])).filter(p => p.length >= 3);
  return {
    id:          tag(xml, "identifier"),
    url,
    evento:      tag(xml, "event"),
    severidad,
    nivel:       NIVEL[severidad] || "amarilla",
    enviado:     tag(xml, "sent"),
    inicio:      tag(xml, "onset") || tag(xml, "effective"),
    fin:         tag(xml, "expires"),
    descripcion: tag(xml, "description"),
    zona:        tag(xml, "areaDesc") || null,
    poligonos,
  };
}

// Ray casting sobre [lat,lon].
function puntoEnPoligono(lat, lon, pol) {
  let dentro = false;
  for (let i = 0, j = pol.length - 1; i < pol.length; j = i++) {
    const [yi, xi] = pol[i], [yj, xj] = pol[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

// Los XML tienen timestamp en el nombre y no cambian: se cachean por URL.
const _xml = new Map();
const TTL_LISTA_MS = 10 * 60 * 1000;
let _lista = null;

async function alertasVigentes({ fresco = false } = {}) {
  if (!fresco && _lista && _lista.exp > Date.now()) return _lista.data;
  const rss   = await get(URL_FEED);
  const urls  = [...new Set([...rss.matchAll(/<link>(https?:\/\/[^<]+\.xml)<\/link>/g)].map(m => m[1]))];

  const out = [];
  for (const url of urls) {
    try {
      if (!_xml.has(url)) _xml.set(url, parseCap(await get(url), url));
      out.push(_xml.get(url));
    } catch (e) { console.warn("[SMN/alertas]", e.message); }
  }
  // Olvidar XML que ya no están en el feed.
  for (const k of _xml.keys()) if (!urls.includes(k)) _xml.delete(k);

  const ahora = Date.now();
  const data  = out.filter(a => !a.fin || new Date(a.fin).getTime() > ahora);
  _lista = { data, exp: ahora + TTL_LISTA_MS };
  return data;
}

// Alertas que tocan algún punto. Agrupa por evento + inicio (el SMN parte un
// mismo evento en varios XML por zona) y se queda con el nivel más alto.
function alertasParaPuntos(alertas, puntos) {
  const grupos = new Map();
  for (const a of alertas) {
    const lotes = puntos.filter(p => a.poligonos.some(pol => puntoEnPoligono(p.lat, p.lon, pol)));
    if (!lotes.length) continue;
    const clave = `${a.evento}|${a.inicio}`;
    const g = grupos.get(clave);
    if (!g) {
      grupos.set(clave, { ...a, clave, lotes: lotes.map(l => l.nombre || "Lote sin nombre") });
    } else {
      if (ORDEN_NIVEL[a.nivel] > ORDEN_NIVEL[g.nivel]) Object.assign(g, { nivel: a.nivel, severidad: a.severidad, descripcion: a.descripcion });
      g.lotes = [...new Set([...g.lotes, ...lotes.map(l => l.nombre || "Lote sin nombre")])];
      if (a.fin > g.fin) g.fin = a.fin;
    }
  }
  return [...grupos.values()].sort((a, b) => (a.inicio || "").localeCompare(b.inicio || ""));
}

module.exports = { alertasVigentes, alertasParaPuntos, puntoEnPoligono, parseCap, NIVEL, ORDEN_NIVEL, URL_FEED };
