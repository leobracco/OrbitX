"use strict";
// backfill-stats-cobertura.js — Migración one-shot: calcula y guarda las stats
// de los Sections.txt que ya están en CouchDB.
//
//   node scripts/backfill-stats-cobertura.js --org la_flora --dry-run
//   node scripts/backfill-stats-cobertura.js --org la_flora
//
// Reglas del droplet (1 vCPU / 1 GB, ~25 apps):
//  · se piden PRIMERO solo los metadatos (con `fields`) para saber cuáles
//    migrar; jamás se baja el `contenido` de todos juntos (en el_susto eso es
//    22,8 MB de una sola vez);
//  · después se hace un `get` por doc, se calcula y se suelta la referencia;
//  · --historial está APAGADO por defecto: son 10.177 docs / 11,1 GB en
//    el_susto y son horas de CPU. Lo vigente de toda la plataforma son 390
//    docs (~35 MB) y son minutos.
//  · correr fuera de horario de siembra.
require("dotenv").config();
const db = require("../services/couchdb");
const { calcularStatsAsync, statsVigentes, STATS_VER } = require("../services/aog_parser");
const { statsParaDoc } = require("../services/cobertura_stats");

function arg(nombre, def = null, argv = process.argv) {
  const i = argv.indexOf(`--${nombre}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (!v || v.startsWith("--")) ? true : v;
}

// Pura: qué selector Mango corresponde a cada tipo de doc. `aog_archivo`
// usa el índice ["tipo","subtipo","es_lote"]; `aog_historial` (--historial)
// usa ["tipo","subtipo"] — ambos ya existen en ESTAB_INDEX_FIELDS
// (services/couchdb.js), así que ninguna de las dos queries hace table scan.
function selectorPara(tipo) {
  return tipo === "aog_archivo"
    ? { tipo, es_lote: true, subtipo: "sections_coverage" }
    : { tipo, subtipo: "sections_coverage" };
}

// Pura: decide qué hacer con un doc a partir de sus metadatos (sin bajar
// `contenido`). "vigente" y "sin_hash" se saltean; solo "migrar" pasa a
// hacer el `get` completo y recalcular.
function decidirAccion(meta) {
  if (statsVigentes(meta)) return "vigente";
  if (!meta.hash_md5) return "sin_hash";
  return "migrar";
}

// Pura: línea de resumen final de una org.
function formatResumen(org, { total, migrados, salteados, fallidos, dry }) {
  return `\n[${org}] listo — ${total} vistos · ${migrados} migrados · ${salteados} salteados · ${fallidos} fallidos${dry ? " (DRY RUN, no se escribió nada)" : ""}`;
}

async function main() {
  const org = arg("org");
  const dry = !!arg("dry-run");
  const conHistorial = !!arg("historial");
  const limite = Number(arg("limite", 5000)) || 5000;

  if (!org || org === true) {
    console.error("Falta --org <slug>. Ejemplo: --org la_flora");
    process.exit(1);
  }

  const estabDB = db.getDB(org);
  const tipos = conHistorial ? ["aog_archivo", "aog_historial"] : ["aog_archivo"];
  let total = 0, migrados = 0, salteados = 0, fallidos = 0;

  for (const tipo of tipos) {
    const r = await estabDB.find({
      selector: selectorPara(tipo),
      fields: ["_id", "lote_nombre", "hash_md5", "stats_ver", "stats_hash", "ts"],
      limit: limite,
    });
    const docs = r.docs || [];
    console.log(`\n[${org}] ${tipo}: ${docs.length} docs de cobertura`);

    for (const meta of docs) {
      total++;
      const accion = decidirAccion(meta);

      if (accion === "vigente") { salteados++; continue; }
      if (accion === "sin_hash") {
        console.warn(`  ! ${meta._id}: sin hash_md5, se saltea (no se puede invalidar)`);
        salteados++;
        continue;
      }
      if (dry) {
        console.log(`  · [dry] migraría ${meta._id} (${meta.lote_nombre || "?"})`);
        migrados++;
        continue;
      }
      try {
        // Releer el doc completo (no confiar en los metadatos del find):
        // entre el find y este punto pudo llegar un sync nuevo del mismo
        // archivo y queremos calcular sobre el contenido más fresco.
        const doc = await estabDB.get(meta._id);
        const stats = statsParaDoc(await calcularStatsAsync(doc.contenido || "", null));
        if (!stats) { console.warn(`  ! ${meta._id}: sin bloques, se saltea`); salteados++; continue; }
        await estabDB.insert({
          ...doc,
          stats,
          stats_hash: doc.hash_md5,
          stats_ver:  STATS_VER,
          ts_trabajo: doc.ts || Date.now(),
        });
        migrados++;
        console.log(`  OK ${doc.lote_nombre || meta._id} · ${stats.trabajado_ha} ha trabajadas / ${stats.neto_ha} netas`);
      } catch (e) {
        fallidos++;
        console.error(`  X ${meta._id}: ${e.message}`);
      }
      // Respirar entre docs: este script comparte el vCPU con el server.
      await new Promise(cb => setTimeout(cb, 50));
    }
  }

  console.log(formatResumen(org, { total, migrados, salteados, fallidos, dry }));
}

if (require.main === module) {
  main().catch(e => { console.error("[backfill]", e); process.exit(1); });
}

module.exports = { arg, selectorPara, decidirAccion, formatResumen };
