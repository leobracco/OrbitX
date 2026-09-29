// services/zona.js — Datos zonales por departamento:
//  · Georef (IGN/datos.gob.ar): lat/lon → provincia + departamento (id INDEC).
//  · Estimaciones agrícolas SAGyP: superficie, producción y rinde por
//    departamento/cultivo/campaña. El CSV (~15 MB) se baja una vez por mes y
//    se guarda reducido en .cache/zona/ (cultivos extensivos, últimas campañas).
"use strict";

const fs   = require("fs");
const path = require("path");

const DIR          = path.resolve(__dirname, "..", ".cache", "zona");
const F_GEOREF     = path.join(DIR, "georef.json");
const F_ESTIM      = path.join(DIR, "estimaciones.json");
const GEOREF_URL   = "https://apis.datos.gob.ar/georef/api/ubicacion";
const CKAN_PACKAGE = "https://datos.magyp.gob.ar/api/3/action/package_show?id=estimaciones-agricolas";
const CULTIVOS     = ["maíz", "soja 1ra", "soja 2da", "trigo total", "girasol", "cebada total", "sorgo"];
const CAMPANIAS    = 10;
const ESTIM_TTL_MS = 30 * 86400000;

function leerJson(f, def) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; }
}
function guardarJson(f, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data));
}

// ── Georef ────────────────────────────────────────────────
// El departamento de un punto no cambia: cache permanente a ~1 km.
let _georef = null;
async function departamento(lat, lon) {
  _georef ||= leerJson(F_GEOREF, {});
  const clave = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (_georef[clave]) return _georef[clave];

  const r = await fetch(`${GEOREF_URL}?lat=${lat}&lon=${lon}`, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Georef: HTTP ${r.status}`);
  const u = (await r.json()).ubicacion || {};
  if (!u.departamento?.id) return null;
  const dep = {
    id:        u.departamento.id,
    nombre:    u.departamento.nombre,
    provincia: u.provincia?.nombre || null,
  };
  _georef[clave] = dep;
  guardarJson(F_GEOREF, _georef);
  return dep;
}

// ── Estimaciones agrícolas ────────────────────────────────
// Parser mínimo de CSV con comillas (el archivo no trae comas dentro de campos,
// pero los nombres vienen entre comillas).
function campos(linea) {
  return linea.split(",").map(s => s.replace(/^"|"$/g, ""));
}

// Recibe las líneas de a una (async iterable): el CSV entero en memoria es un
// pico de ~100 MB que el droplet de 1 GB no necesita.
async function reducir(lineasIter) {
  let I = null;
  // El archivo arranca en 1969: se descarta de entrada lo que nunca va a entrar.
  const desde = String(new Date().getFullYear() - CAMPANIAS - 3);
  const filas = [];
  const campanias = new Set();
  for await (const linea of lineasIter) {
    if (!linea) continue;
    const c = campos(linea);
    if (!I) {
      const ix = (n) => c.indexOf(n);
      I = {
        cultivo: ix("cultivo"), campania: ix("campania"), dep: ix("departamento_id"), depNom: ix("departamento"), prov: ix("provincia"),
        sem: ix("superficie_sembrada_ha"), cos: ix("superficie_cosechada_ha"), prod: ix("produccion_tm"), rinde: ix("rendimiento_kgxha"),
      };
      if (Object.values(I).some(v => v < 0)) throw new Error("Estimaciones: cambiaron las columnas del CSV");
      continue;
    }
    if (!CULTIVOS.includes(c[I.cultivo]) || c[I.campania] < desde) continue;
    campanias.add(c[I.campania]);
    filas.push(c);
  }
  const ultimas = new Set([...campanias].sort().slice(-CAMPANIAS));

  const deps = {};
  for (const c of filas) {
    if (!ultimas.has(c[I.campania])) continue;
    const d = (deps[c[I.dep]] ||= { nombre: c[I.depNom], provincia: c[I.prov], cultivos: {} });
    (d.cultivos[c[I.cultivo]] ||= {})[c[I.campania]] = {
      sembrada_ha: +c[I.sem] || 0,
      cosechada_ha: +c[I.cos] || 0,
      produccion_tn: +c[I.prod] || 0,
      rinde_kgha: +c[I.rinde] || 0,
    };
  }
  return { campanias: [...ultimas].sort(), deps };
}

async function* lineasDe(body) {
  const dec = new TextDecoder("utf-8");
  let resto = "";
  for await (const chunk of body) {
    resto += dec.decode(chunk, { stream: true });
    const partes = resto.split(/\r?\n/);
    resto = partes.pop();
    yield* partes;
  }
  resto += dec.decode();
  if (resto) yield resto;
}

let _estim = null;
let _actualizando = null;

async function actualizarEstimaciones() {
  const pkg = await (await fetch(CKAN_PACKAGE, { signal: AbortSignal.timeout(30_000) })).json();
  const rec = (pkg.result?.resources || []).find(r => /csv/i.test(r.format) && /estimaciones-agricolas/i.test(r.url));
  if (!rec) throw new Error("Estimaciones: no se encontró el CSV en el dataset");
  const r = await fetch(rec.url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`Estimaciones: HTTP ${r.status}`);
  const data = { ...(await reducir(lineasDe(r.body))), url: rec.url, fuente_actualizada: rec.last_modified || null, bajado: Date.now() };
  guardarJson(F_ESTIM, data);
  _estim = data;
  console.log(`[Zona] ✓ estimaciones SAGyP: ${Object.keys(data.deps).length} departamentos, campañas ${data.campanias[0]}–${data.campanias.at(-1)}`);
  return data;
}

async function estimaciones() {
  _estim ||= leerJson(F_ESTIM, null);
  if (_estim && Date.now() - _estim.bajado < ESTIM_TTL_MS) return _estim;
  // Una sola descarga a la vez; si falla y hay copia vieja, se usa la vieja.
  _actualizando ||= actualizarEstimaciones().finally(() => { _actualizando = null; });
  try { return await _actualizando; }
  catch (e) { if (_estim) { console.warn("[Zona]", e.message); return _estim; } throw e; }
}

// Rindes de la zona para una org: departamentos de sus lotes + serie por cultivo.
async function rindesZona(puntos) {
  const porDep = new Map();
  for (const p of puntos) {
    try {
      const dep = await departamento(p.lat, p.lon);
      if (!dep) continue;
      const g = porDep.get(dep.id) || { ...dep, lotes: [] };
      g.lotes.push(p.nombre || "Lote sin nombre");
      porDep.set(dep.id, g);
    } catch (e) { console.warn("[Zona/georef]", e.message); }
  }
  const est = await estimaciones();
  const departamentos = [...porDep.values()].map(d => {
    const cultivos = est.deps[d.id]?.cultivos || {};
    return {
      ...d,
      cultivos: CULTIVOS.filter(c => cultivos[c]).map(c => {
        const serie = est.campanias.filter(k => cultivos[c][k]).map(k => ({ campania: k, ...cultivos[c][k] }));
        const con = serie.filter(s => s.rinde_kgha > 0).slice(-5);
        return {
          cultivo: c,
          serie,
          promedio_5_kgha: con.length ? Math.round(con.reduce((a, s) => a + s.rinde_kgha, 0) / con.length) : null,
        };
      }),
    };
  });
  return { departamentos, campanias: est.campanias, fuente_actualizada: est.fuente_actualizada };
}

module.exports = { departamento, estimaciones, actualizarEstimaciones, rindesZona, reducir, CULTIVOS };
