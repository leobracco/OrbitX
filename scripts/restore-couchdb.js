// scripts/restore-couchdb.js — Restore de un backup NDJSON gzip a CouchDB.
//
// Contraparte de backup-couchdb.js. Lee un <db>.ndjson.gz y hace bulk insert
// en la DB destino. Los docs se insertan SIN _rev (docs nuevos); si la DB
// destino ya tiene docs con el mismo _id, esos quedan reportados como
// conflictos y NO se pisan — para pisar, restaurar sobre una DB vacía.
//
// Uso:
//   node scripts/restore-couchdb.js <archivo.ndjson.gz> <db_destino>
//   node scripts/restore-couchdb.js backups/2026-07-01/orbitx_global.ndjson.gz orbitx_global_restaurada
//
// Env:
//   COUCHDB_URL  (default http://admin:password@localhost:5984)

const nano = require("nano");
const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");

const URL = process.env.COUCHDB_URL || "http://admin:password@localhost:5984";
const BATCH = 500;

async function flush(db, docs, stats) {
  if (docs.length === 0) return;
  const res = await db.bulk({ docs });
  for (const r of res) {
    if (r.error) {
      stats.errores++;
      if (r.error === "conflict") stats.conflictos++;
      else console.error(`[restore] doc ${r.id}: ${r.error} — ${r.reason}`);
    } else {
      stats.insertados++;
    }
  }
  docs.length = 0;
}

async function restore(file, dbName) {
  const couch = nano(URL);

  // Crear la DB si no existe (restore típico: DB nueva/vacía).
  const existing = await couch.db.list();
  if (!existing.includes(dbName)) {
    await couch.db.create(dbName);
    console.log(`[restore] DB "${dbName}" creada`);
  }
  const db = couch.db.use(dbName);

  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  const stats = { insertados: 0, conflictos: 0, errores: 0 };
  const docs = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    delete doc._rev; // el _rev del backup no existe en la DB destino
    docs.push(doc);
    if (docs.length >= BATCH) await flush(db, docs, stats);
  }
  await flush(db, docs, stats);
  return stats;
}

// CLI
if (require.main === module) {
  const [file, dbName] = process.argv.slice(2);
  if (!file || !dbName) {
    console.error("Uso: node scripts/restore-couchdb.js <archivo.ndjson.gz> <db_destino>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`[restore] ✗ no existe: ${file}`);
    process.exit(1);
  }
  restore(file, dbName)
    .then((s) => {
      console.log(
        `[restore] ✓ ${s.insertados} docs → ${dbName}` +
          (s.conflictos ? ` · ${s.conflictos} conflictos (no pisados)` : "") +
          (s.errores - s.conflictos ? ` · ${s.errores - s.conflictos} errores` : ""),
      );
      process.exit(s.errores - s.conflictos > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error("[restore] ✗", e.message);
      process.exit(1);
    });
}

module.exports = { restore };
