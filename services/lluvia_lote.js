// services/lluvia_lote.js — La lluvia de un lote, un valor por día, armada en el
// momento con las fuentes externas (nada que importar a mano):
//   1. pluviómetro del campo (lluvia_registro manual de ese lote)
//   2. estación a ≤ 15 km que haya medido ese día (SIGA INTA, INA, Bolsa B. Blanca)
//   3. Open-Meteo (modelo ~11 km, siempre disponible hasta hoy)
// Nunca se suman dos fuentes para el mismo día. Los registros importados con el
// flujo viejo (CHIRPS, INA, etc. guardados por lote) se ignoran.
"use strict";

const db       = require("./couchdb");
const om       = require("./openmeteo");
const omOrg    = require("../lib/openmeteo-org");
const { puntosLotes } = require("../lib/lotes-puntos");

const RADIO_KM    = 15;
const MAX_DIAS    = 366;
const CACHE_MS    = 30 * 60 * 1000;
const _cache      = new Map();

const NOMBRE_RED = { siga: "SIGA INTA", ina: "INA", bcp: "Bolsa de Cereales B. Blanca" };

function norm(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, toR = d => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLon = toR(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function hoyAR() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function sumarDias(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Punto del lote: origen AOG (Field.txt) o centroide del boundary del lote maestro.
async function puntoLote(slug, nombre) {
  const n = norm(nombre);
  const p = (await puntosLotes(slug)).find(x => norm(x.nombre) === n);
  if (p) return { lat: p.lat, lon: p.lon, origen: "aog" };

  try {
    const r = await db.getDB(slug).find({ selector: { tipo: "lote_maestro" }, fields: ["nombre", "boundary_geojson"], limit: 2000 });
    const m = r.docs.find(d => norm(d.nombre) === n);
    const ring = m?.boundary_geojson?.coordinates?.[0];
    if (Array.isArray(ring) && ring.length >= 3) {
      const pts = ring.slice(0, -1);
      return {
        lat: pts.reduce((a, c) => a + c[1], 0) / pts.length,
        lon: pts.reduce((a, c) => a + c[0], 0) / pts.length,
        origen: "boundary",
      };
    }
  } catch { /* sin índice o sin lote maestro */ }
  return null;
}

// Estaciones activas a ≤ RADIO_KM, la más cercana primero.
async function estacionesCercanas(lat, lon) {
  const out = [];
  const agregar = (red, id, nombre, eLat, eLon) => {
    const dist = haversineKm(lat, lon, eLat, eLon);
    if (dist <= RADIO_KM) out.push({ red, id, nombre, dist_km: Math.round(dist * 10) / 10 });
  };
  const ina = require("./ina");
  const [siga, inaEst, inaSer, bcp] = await Promise.allSettled([
    require("./siga").estaciones(),
    ina.estaciones(),
    ina.seriesPrecip(),
    require("./bcp").estaciones(),
  ]);
  if (siga.status === "fulfilled") for (const e of Object.values(siga.value)) if (e.activa) agregar("siga", e.id, e.nombre, e.lat, e.lon);
  if (inaEst.status === "fulfilled" && inaSer.status === "fulfilled") {
    // Solo estaciones INA con serie de lluvia que siga viva (último dato < 30 días).
    const limite = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const s of Object.values(inaSer.value)) {
      const e = inaEst.value[s.sitecode];
      if (e && String(s.to_date || "").slice(0, 10) >= limite) agregar("ina", e.sitecode, e.nombre, e.lat, e.lon);
    }
  }
  if (bcp.status === "fulfilled")  for (const e of bcp.value) if (e.activa) agregar("bcp", e.sitio, e.nombre, e.lat, e.lon);
  return out.sort((a, b) => a.dist_km - b.dist_km).slice(0, 3);
}

// Serie diaria de una estación → Map(fecha → mm). Días sin dato no aparecen.
async function serieEstacion(est, desde, hasta) {
  const m = new Map();
  if (est.red === "siga") {
    for (const x of await require("./siga").datosDiarios(est.id, desde, hasta)) if (x.mm != null) m.set(x.fecha, x.mm);
  } else if (est.red === "ina") {
    for (const x of await require("./ina").datosPrecip(est.id, desde, hasta)) m.set(x.fecha, x.mm);
  } else if (est.red === "bcp") {
    // El cron guarda un doc global por estación y día (services/bcp_sync.js).
    const ids = [];
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) ids.push(`bcp_dia_${est.id}_${f}`);
    const r = await db.getDB("global").fetch({ keys: ids });
    for (const row of r.rows) if (row.doc && row.doc.mm != null) m.set(row.doc.fecha, row.doc.mm);
  }
  return m;
}

// Lo externo (estaciones + Open-Meteo) depende solo del punto y el rango: se cachea.
async function externo(slug, lat, lon, desde, hasta) {
  const clave = `${lat.toFixed(3)},${lon.toFixed(3)}|${desde}|${hasta}`;
  const c = _cache.get(clave);
  if (c && c.exp > Date.now()) return c.data;

  const estaciones = await estacionesCercanas(lat, lon).catch(() => []);
  const apiKey = await omOrg.getApiKey(slug).catch(() => null);
  const [omSerie, ...series] = await Promise.all([
    om.historico(lat, lon, desde, hasta, apiKey).catch(e => { console.warn("[lluvia_lote/om]", e.message); return []; }),
    ...estaciones.map(e => serieEstacion(e, desde, hasta).catch(err => { console.warn(`[lluvia_lote/${e.red}]`, err.message); return new Map(); })),
  ]);
  const data = {
    om: new Map(omSerie.filter(x => x.mm != null).map(x => [x.fecha, x.mm])),
    estaciones: estaciones.map((e, i) => ({ ...e, serie: series[i] })),
  };
  _cache.set(clave, { data, exp: Date.now() + CACHE_MS });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return data;
}

async function manualesDelLote(slug, nombre) {
  const n = norm(nombre);
  const edb = db.getDB(slug);
  let docs;
  try { docs = (await edb.find({ selector: { tipo: "lluvia_registro" }, limit: 5000 })).docs; }
  catch { docs = (await edb.list({ include_docs: true })).rows.map(r => r.doc).filter(d => d?.tipo === "lluvia_registro"); }
  return docs.filter(d => (!d.fuente || d.fuente === "manual") && norm(d.lote) === n);
}

// { punto, estaciones, dias:[{fecha, mm, fuente, estacion?}], registros (días con lluvia, desc), por_fuente }
async function lluviaLote(slug, nombre, { dias = 365 } = {}) {
  const hasta = hoyAR();
  const desde = sumarDias(hasta, -(Math.min(Math.max(dias, 1), MAX_DIAS) - 1));

  const [punto, manuales] = await Promise.all([puntoLote(slug, nombre), manualesDelLote(slug, nombre)]);
  const porDiaManual = new Map();
  for (const d of manuales) {
    if (!d.fecha || d.fecha < desde || d.fecha > hasta) continue;
    const prev = porDiaManual.get(d.fecha) || { mm: 0, ids: [], notas: [] };
    prev.mm += Number(d.mm) || 0;
    prev.ids.push(d._id);
    if (d.nota) prev.notas.push(d.nota);
    porDiaManual.set(d.fecha, prev);
  }

  const ext = punto ? await externo(slug, punto.lat, punto.lon, desde, hasta) : { om: new Map(), estaciones: [] };

  const serie = [];
  const por_fuente = { pluviometro: 0, estacion: 0, openmeteo: 0 };
  for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
    const man = porDiaManual.get(f);
    if (man) {
      serie.push({ fecha: f, mm: Math.round(man.mm * 10) / 10, fuente: "pluviometro", ids: man.ids, nota: man.notas.join(" · ") || "Pluviómetro" });
      por_fuente.pluviometro++;
      continue;
    }
    const est = ext.estaciones.find(e => e.serie.has(f));
    if (est) {
      serie.push({ fecha: f, mm: Math.round(est.serie.get(f) * 10) / 10, fuente: "estacion", nota: `${NOMBRE_RED[est.red]} · ${est.nombre} (${est.dist_km} km)` });
      por_fuente.estacion++;
      continue;
    }
    if (ext.om.has(f)) {
      serie.push({ fecha: f, mm: Math.round(ext.om.get(f) * 10) / 10, fuente: "openmeteo", nota: "Open-Meteo (modelo)" });
      por_fuente.openmeteo++;
    }
  }

  return {
    lote: nombre,
    desde, hasta,
    punto,
    estaciones: ext.estaciones.map(({ serie: s, ...e }) => ({ ...e, red_nombre: NOMBRE_RED[e.red], dias_con_dato: s.size })),
    dias: serie,
    registros: serie.filter(d => d.mm > 0).sort((a, b) => b.fecha.localeCompare(a.fecha)),
    total_mm: Math.round(serie.reduce((a, d) => a + d.mm, 0) * 10) / 10,
    por_fuente,
  };
}

module.exports = { lluviaLote, puntoLote, estacionesCercanas, RADIO_KM };
