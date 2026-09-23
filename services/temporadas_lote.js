"use strict";
// temporadas_lote.js — De los snapshots de cobertura (aog_historial + el doc
// vigente) a la lista de temporadas disponibles de un lote.
//
// Gratis gracias a la Pieza 0: cada snapshot ya tiene sus `stats` copiadas al
// archivarse, así que esto sale de un `find` con `fields` y no baja un byte de
// `contenido`. Sin eso, en el_susto serían 11,1 GB de reparseo.
const { temporadaDe } = require("./temporada");

function derivarTemporadasDeHistorial(docs) {
  const porTemporada = new Map();
  for (const d of docs || []) {
    const ts = Number(d.ts) || 0;
    if (!ts) continue;
    const t = temporadaDe(ts);
    const prev = porTemporada.get(t);
    if (prev && prev.ts >= ts) continue;
    porTemporada.set(t, {
      temporada:    t,
      ts,
      doc_id:       d._id || null,
      trabajado_ha: d.stats?.trabajado_ha ?? null,
      neto_ha:      d.stats?.neto_ha ?? null,
    });
  }
  return [...porTemporada.values()].sort((a, b) => b.ts - a.ts);
}

module.exports = { derivarTemporadasDeHistorial };
