// scripts/backup-couchdb.js — Backup diario de CouchDB (OrbitX Cloud).
//
// Exporta TODAS las bases `orbitx_*` (global + una por establecimiento) a
// NDJSON gzip en BACKUP_DIR/YYYY-MM-DD/<db>.ndjson.gz y borra corridas más
// viejas que BACKUP_RETENTION_DAYS. Sin esto, un crash del disco de CouchDB
// era pérdida total (hallazgo crítico de la auditoría 2026-07-02).
//
// Uso:
//   node scripts/backup-couchdb.js            ← corrida manual
//   (server.js lo agenda vía node-cron a las 03:00 America/Argentina/Cordoba)
//
// Env:
//   COUCHDB_URL            (default http://admin:password@localhost:5984)
//   BACKUP_DIR             (default ./backups)
//   BACKUP_RETENTION_DAYS  (default 14)
//
// Restore: scripts/restore-couchdb.js <archivo.ndjson.gz> <db_destino>

const nano = require("nano");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const URL = process.env.COUCHDB_URL || "http://admin:password@localhost:5984";
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "14", 10);
const PREFIX = "orbitx_";
const BATCH = 500; // docs por página — acota memoria en DBs grandes

async function backupDb(couch, dbName, outDir) {
  const db = couch.db.use(dbName);
  const file = path.join(outDir, `${dbName}.ndjson.gz`);
  const tmp = file + ".tmp";
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);

  let startkey = null;
  let total = 0;
  for (;;) {
    const opts = { include_docs: true, limit: BATCH + (startkey ? 1 : 0) };
    if (startkey) opts.startkey = startkey;
    const page = await db.list(opts);
    let rows = page.rows;
    if (startkey && rows.length > 0) rows = rows.slice(1); // saltear el startkey repetido
    if (rows.length === 0) break;
    for (const r of rows) {
      // _design docs también van: las views se regeneran, pero el hash-check
      // del bootstrap las compara contra el código, así que no molestan.
      if (!gz.write(JSON.stringify(r.doc) + "\n")) {
        await new Promise((res) => gz.once("drain", res));
      }
      total++;
    }
    if (rows.length < BATCH) break;
    startkey = rows[rows.length - 1].id;
  }

  await new Promise((res, rej) => {
    out.on("finish", res);
    out.on("error", rej);
    gz.end();
  });
  fs.renameSync(tmp, file); // atómico: nunca queda un backup a medias con nombre final
  return total;
}

function pruneOld(baseDir, retentionDays) {
  if (!fs.existsSync(baseDir)) return [];
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const name of fs.readdirSync(baseDir)) {
    // Solo carpetas con forma de fecha — no tocar nada que no hayamos creado.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const ts = new Date(name + "T00:00:00Z").getTime();
    if (isNaN(ts) || ts >= cutoff) continue;
    fs.rmSync(path.join(baseDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

async function runBackup() {
  const couch = nano(URL);
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.join(BACKUP_DIR, today);
  fs.mkdirSync(outDir, { recursive: true });

  const all = await couch.db.list();
  const targets = all.filter((n) => n.startsWith(PREFIX));
  const summary = { fecha: today, dir: outDir, dbs: {}, errores: {} };

  for (const dbName of targets) {
    try {
      summary.dbs[dbName] = await backupDb(couch, dbName, outDir);
    } catch (e) {
      // Una DB rota no debe frenar el backup del resto.
      summary.errores[dbName] = e.message;
    }
  }

  summary.podados = pruneOld(BACKUP_DIR, RETENTION_DAYS);
  fs.writeFileSync(
    path.join(outDir, "_resumen.json"),
    JSON.stringify(summary, null, 2),
  );
  return summary;
}

module.exports = { runBackup };

// CLI directo
if (require.main === module) {
  runBackup()
    .then((s) => {
      const nDbs = Object.keys(s.dbs).length;
      const nErr = Object.keys(s.errores).length;
      console.log(`[backup] ✓ ${nDbs} DBs → ${s.dir}` + (nErr ? ` · ${nErr} con error` : ""));
      if (nErr) { console.error(s.errores); process.exit(1); }
    })
    .catch((e) => {
      console.error("[backup] ✗", e.message);
      process.exit(1);
    });
}
