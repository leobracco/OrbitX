// scripts/backup-couchdb.js — Backup diario de CouchDB (OrbitX Cloud).
//
// Exporta TODAS las bases `orbitx_*` (global + una por establecimiento) a
// NDJSON gzip en BACKUP_DIR/YYYY-MM-DD/<db>.ndjson.gz y borra corridas más
// viejas que BACKUP_RETENTION_DAYS. Sin esto, un crash del disco de CouchDB
// era pérdida total (hallazgo crítico de la auditoría 2026-07-02).
//
// Uso:
//   node scripts/backup-couchdb.js            ← corrida manual
//   (server.js lo agenda vía node-cron a las 03:00 America/Argentina/Cordoba,
//    lanzándolo como proceso HIJO — ver server.js: si el backup se infla, se
//    lleva puesto un proceso descartable y no el servidor web)
//
// Memoria (incidente 2026-09-20): antes se pedían 500 documentos ENTEROS por
// página con `include_docs: true`. Con lotes guardados inline en `contenido`
// (155 KiB de promedio, picos de 5,9 MB) una sola página son ~77 MB de JSON,
// y nano/undici bufferiza el body entero antes de parsearlo: el pico de heap
// llegaba a 3,5-4× eso y mataba el proceso. Ahora la paginación es en DOS
// niveles: primero los ids con `_all_docs` SIN include_docs (~70 B por fila),
// después los documentos en tandas chicas con `db.fetch({keys})`.
//
// Env:
//   COUCHDB_URL            (default http://admin:password@localhost:5984)
//   BACKUP_DIR             (default ./backups)
//   BACKUP_RETENTION_DAYS  (default 14)
//   BACKUP_DOCS_CHUNK      (default 25)   ← documentos por tanda de db.fetch
//   BACKUP_IDS_PAGE        (default 5000) ← ids por página de _all_docs
//   BACKUP_EXCLUIR         (opcional)     ← bases que NO entran al backup
//                                           automatico (ver el comentario abajo)
//   BACKUP_SOLO            (opcional)     ← lista separada por comas: respalda
//                                           solo esas bases (corridas a mano)
//
// Restore: scripts/restore-couchdb.js <archivo.ndjson.gz> <db_destino>

// Cargar .env si está disponible: el script se corre a mano y como proceso
// hijo, sin el dotenv que server.js ya tenía cargado en su propio process.env.
try {
  require("dotenv").config();
} catch (_) {
  /* sin dotenv se usan las variables de entorno que ya haya */
}

const nano = require("nano");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const URL = process.env.COUCHDB_URL || "http://admin:password@localhost:5984";
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || "14", 10);
const PREFIX = "orbitx_";
const DOCS_CHUNK = parseInt(process.env.BACKUP_DOCS_CHUNK || "25", 10);
const IDS_PAGE = parseInt(process.env.BACKUP_IDS_PAGE || "5000", 10);

// Trae una página de ids de `_all_docs` SIN los documentos. Cada fila pesa
// ~70 B, así que 5000 ids son ~350 KB de heap — nada, comparado con traer los
// documentos enteros. Devuelve los ids ya sin el startkey repetido.
async function paginaDeIds(db, startkey) {
  const opts = { limit: IDS_PAGE + (startkey ? 1 : 0) };
  if (startkey) opts.startkey = startkey;
  const page = await db.list(opts); // sin include_docs
  let rows = page.rows || [];
  if (startkey && rows.length > 0) rows = rows.slice(1); // saltear el startkey repetido
  // `_all_docs` no lista borrados, pero por las dudas filtramos los tombstones.
  return rows.filter((r) => !(r.value && r.value.deleted)).map((r) => r.id);
}

async function backupDb(couch, dbName, outDir) {
  const db = couch.db.use(dbName);
  const file = path.join(outDir, `${dbName}.ndjson.gz`);
  const tmp = file + ".tmp";
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);

  // Un error del stream (ENOSPC, por ejemplo) llega de forma asincrónica: lo
  // guardamos y lo revisamos en el loop para abortar con un mensaje útil.
  let errStream = null;
  const anotarErr = (e) => {
    if (!errStream) errStream = e;
  };
  gz.on("error", anotarErr);
  out.on("error", anotarErr);

  let total = 0;
  try {
    let startkey = null;
    for (;;) {
      const ids = await paginaDeIds(db, startkey);
      if (ids.length === 0) break;

      // Los documentos se traen en tandas chicas: el pico de memoria es el
      // tamaño de UNA tanda, no el de la página entera.
      for (let i = 0; i < ids.length; i += DOCS_CHUNK) {
        if (errStream) throw errStream;
        const keys = ids.slice(i, i + DOCS_CHUNK);
        const res = await db.fetch({ keys });
        for (const r of res.rows || []) {
          // Filas con `error` (not_found por un borrado entre medio) o sin doc
          // se saltean: el backup refleja lo que existía al momento de leerlo.
          if (!r || r.error || !r.doc) continue;
          // _design docs también van: las views se regeneran, pero el
          // hash-check del bootstrap las compara contra el código, así que no
          // molestan.
          if (!gz.write(JSON.stringify(r.doc) + "\n")) {
            await new Promise((res2, rej2) => {
              const okDrain = () => {
                gz.off("error", errDrain);
                res2();
              };
              const errDrain = (e) => {
                gz.off("drain", okDrain);
                rej2(e);
              };
              gz.once("drain", okDrain);
              gz.once("error", errDrain);
            });
          }
          total++;
        }
      }

      if (ids.length < IDS_PAGE) break;
      startkey = ids[ids.length - 1];
    }

    await new Promise((res, rej) => {
      out.on("finish", res);
      out.on("error", rej);
      gz.end();
    });
    if (errStream) throw errStream;
    fs.renameSync(tmp, file); // atómico: nunca queda un backup a medias con nombre final
    return total;
  } catch (e) {
    // Limpieza: cerrar los streams y BORRAR el temporal. Sin esto, cada
    // corrida abortada dejaba un `.tmp` huérfano — así se juntaron 1,8 GB
    // antes del incidente del 2026-09-20.
    try {
      gz.destroy();
    } catch (_) {}
    try {
      out.destroy();
    } catch (_) {}
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    throw e;
  }
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
  let targets = all.filter((n) => n.startsWith(PREFIX));
  // BACKUP_SOLO permite respaldar a mano un subconjunto (rescates, pruebas).
  const solo = (process.env.BACKUP_SOLO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (solo.length) targets = targets.filter((n) => solo.includes(n));
  // BACKUP_EXCLUIR saca bases del backup AUTOMATICO. Existe por un motivo
  // concreto y no por gusto: orbitx_el_susto pesa ~3,1 GiB comprimidos porque
  // guarda los archivos de lote INLINE en el campo `contenido` de cada doc
  // (67 mil docs, 10,2 GiB de JSON). Con el disco al 86% entra UNA copia; la
  // segunda lo llena, y un disco lleno se lleva puesto a CouchDB y con el a
  // las 13 apps del droplet.
  //
  // No es la solucion: es el freno de mano. Lo que corresponde es pasar esos
  // archivos a attachments de CouchDB (el backup ni los tocaria) o mandar esa
  // base a un destino externo. Mientras tanto, se respalda a mano con
  // BACKUP_SOLO=orbitx_el_susto cuando haya lugar.
  const excluir = (process.env.BACKUP_EXCLUIR || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (excluir.length) {
    const fuera = targets.filter((n) => excluir.includes(n));
    targets = targets.filter((n) => !excluir.includes(n));
    if (fuera.length)
      console.warn(
        `[backup] EXCLUIDAS del backup automatico: ${fuera.join(", ")}` +
          " (ver BACKUP_EXCLUIR en el .env)",
      );
  }
  const summary = { fecha: today, dir: outDir, dbs: {}, errores: {} };

  for (const dbName of targets) {
    try {
      const t0 = Date.now();
      summary.dbs[dbName] = await backupDb(couch, dbName, outDir);
      console.log(
        `[backup]   ${dbName}: ${summary.dbs[dbName]} docs en ${((Date.now() - t0) / 1000).toFixed(0)}s`,
      );
    } catch (e) {
      // Una DB rota no debe frenar el backup del resto.
      summary.errores[dbName] = e.message;
      console.error(`[backup]   ${dbName}: ✗ ${e.message}`);
    }
  }

  summary.podados = pruneOld(BACKUP_DIR, RETENTION_DAYS);
  fs.writeFileSync(
    path.join(outDir, "_resumen.json"),
    JSON.stringify(summary, null, 2),
  );
  return summary;
}

module.exports = { runBackup, backupDb };

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
