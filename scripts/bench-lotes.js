// scripts/bench-lotes.js
// Mide tiempos directos contra CouchDB para diagnosticar lentitud de lotes.
// Uso: node scripts/bench-lotes.js <slug>
//      node scripts/bench-lotes.js el_susto

require("dotenv").config();
const nano = require("nano")(process.env.COUCHDB_URL || "http://admin:password@localhost:5984");

const slug = process.argv[2];
if (!slug) { console.error("Uso: node scripts/bench-lotes.js <slug>"); process.exit(1); }

const dbName = `orbitx_${slug}`;
const db = nano.db.use(dbName);

const fmt = (ms) => `${ms.toString().padStart(6, " ")} ms`;

async function bench(label, fn) {
  const t0 = Date.now();
  let info = "";
  try {
    info = await fn();
  } catch (e) {
    info = `ERROR: ${e.message}`;
  }
  const ms = Date.now() - t0;
  console.log(`${fmt(ms)}  ${label.padEnd(38)}  ${info}`);
  return ms;
}

(async () => {
  console.log(`\n📊 Benchmark de queries en orbitx_${slug}\n`);
  console.log(`        ms  query                                   info`);
  console.log(`──────────  ──────────────────────────────────────  ─────────────────────`);

  // 1. info de la DB.
  await bench("nano.info()", async () => {
    const i = await db.info();
    return `${i.doc_count.toLocaleString()} docs · ${(i.sizes?.file / 1048576).toFixed(1)} MB`;
  });

  // 2. _all_docs total (sin docs).
  await bench("_all_docs (count only)", async () => {
    const r = await db.list({ limit: 0 });
    return `${r.total_rows.toLocaleString()} total_rows`;
  });

  // 3. Mango find lote_maestro.
  await bench("mango find {tipo:lote_maestro} limit:10", async () => {
    const r = await db.find({ selector: { tipo: "lote_maestro" }, limit: 10 });
    return `${r.docs.length} docs`;
  });

  // 4. Mango find aog_archivo es_lote=true.
  await bench("mango find {tipo:aog_archivo,es_lote:true}", async () => {
    const r = await db.find({ selector: { tipo: "aog_archivo", es_lote: true }, fields: ["lote_nombre"], limit: 2000 });
    return `${r.docs.length} docs`;
  });

  // 5. Mango find aog_archivo (todos).
  await bench("mango find {tipo:aog_archivo} limit:3000", async () => {
    const r = await db.find({ selector: { tipo: "aog_archivo" }, fields: ["lote_nombre","subtipo"], limit: 3000 });
    return `${r.docs.length} docs`;
  });

  // 6. View lotes_maestros_por_fecha.
  await bench("view lotes_maestros_por_fecha (cold)", async () => {
    const r = await db.view("orbitx", "lotes_maestros_por_fecha", { descending: true, limit: 10 });
    return `${r.rows.length} rows · total ${r.total_rows}`;
  });

  // 7. Misma view caliente (segunda vez).
  await bench("view lotes_maestros_por_fecha (warm)", async () => {
    const r = await db.view("orbitx", "lotes_maestros_por_fecha", { descending: true, limit: 10 });
    return `${r.rows.length} rows · total ${r.total_rows}`;
  });

  // 8. View lotes_aog_por_nombre group_level:1 (nombres únicos).
  await bench("view lotes_aog_por_nombre group:1 (cold)", async () => {
    const r = await db.view("orbitx", "lotes_aog_por_nombre", { group_level: 1 });
    return `${r.rows.length} nombres únicos`;
  });

  await bench("view lotes_aog_por_nombre group:1 (warm)", async () => {
    const r = await db.view("orbitx", "lotes_aog_por_nombre", { group_level: 1 });
    return `${r.rows.length} nombres únicos`;
  });

  // 9. View lotes_aog_por_nombre reduce:false (todos los pares).
  await bench("view lotes_aog_por_nombre reduce:false", async () => {
    const r = await db.view("orbitx", "lotes_aog_por_nombre", { reduce: false });
    return `${r.rows.length} rows`;
  });

  // 10. View con stale=update_after (cache).
  await bench("view ...por_fecha stale=update_after", async () => {
    const r = await db.view("orbitx", "lotes_maestros_por_fecha", { descending: true, limit: 10, stable: true, update: "lazy" });
    return `${r.rows.length} rows`;
  });

  console.log("");
  console.log("Si las views \"warm\" están en milisegundos pero la \"cold\" tarda mucho:");
  console.log("  → CouchDB está indexando la vista por primera vez. Próximas requests serán rápidas.");
  console.log("Si las views siguen lentas en warm:");
  console.log("  → La DB tiene demasiados docs y la vista necesita más memoria/disco. Mover a global.");
  console.log("Si Mango es 10x más lento que las views:");
  console.log("  → Falta índice o el índice no se está usando. Verificar con _explain.");
  console.log("");
})().catch(e => { console.error(e); process.exit(1); });
