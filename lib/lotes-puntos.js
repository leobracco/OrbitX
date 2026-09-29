// lib/lotes-puntos.js — Un punto (lat/lon) por lote de la org, a partir del
// origen del Field.txt que sincroniza AOG. Alcanza para cruzar contra datos
// zonales (estaciones, alertas SMN, departamento).
"use strict";

const db = require("../services/couchdb");

const TTL_MS = 30 * 60 * 1000;
const _cache = new Map();

async function puntosLotes(estabSlug, { fresco = false } = {}) {
  const c = _cache.get(estabSlug);
  if (!fresco && c && c.exp > Date.now()) return c.data;

  const edb = db.getDB(estabSlug);
  let docs = [];
  try {
    const r = await edb.find({ selector: { tipo: "aog_archivo", subtipo: "field_origin" }, limit: 300 });
    docs = r.docs;
  } catch {
    const all = await edb.list({ include_docs: true });
    docs = all.rows.map(x => x.doc).filter(d => d && d.tipo === "aog_archivo" && d.subtipo === "field_origin");
  }
  const { parseFieldTxt } = require("../services/aog_parser");
  const pts = [];
  for (const d of docs) {
    const o = parseFieldTxt(d.contenido);
    // Un lote creado sin fix de GPS queda con origen 0,0: no es un punto real.
    if (!o || (Math.abs(o.lat) < 0.01 && Math.abs(o.lon) < 0.01)) continue;
    pts.push({ ...o, nombre: d.lote_nombre || d.nombre || null });
  }
  _cache.set(estabSlug, { data: pts, exp: Date.now() + TTL_MS });
  return pts;
}

module.exports = { puntosLotes };
