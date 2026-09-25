// scripts/registrar-fw.js — Registra un firmware en el módulo OTA desde la CLI
// del servidor (mismo efecto que POST /api/ota/upload del panel superadmin).
//
// Uso (en el droplet, desde la raíz del server):
//   node scripts/registrar-fw.js <Producto> <version> <ruta.bin> "<changelog>"
//
// Mueve el .bin a firmwares/<Producto>/<version>.bin, calcula SHA256 y crea
// el doc firmware_<Producto>_<version> en orbitx_global.
"use strict";

const fs = require("fs");
const path = require("path");

// Cargar .env sin depender de dotenv.
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const couch = require("../services/couchdb");
const fw = require("../lib/firmware");

(async () => {
  const [, , producto, version, srcPath, changelog] = process.argv;
  if (!producto || !version || !srcPath) {
    console.error('Uso: node scripts/registrar-fw.js <Producto> <version> <ruta.bin> "<changelog>"');
    process.exit(2);
  }
  if (!fs.existsSync(srcPath)) {
    console.error("No existe el archivo: " + srcPath);
    process.exit(2);
  }

  const meta = await fw.guardarBin(producto, version, srcPath);
  const db = couch.getDB("global");
  const now = Date.now();
  await db.insert({
    _id: `firmware_${producto}_${version}`,
    tipo: "firmware",
    producto,
    version,
    changelog: changelog || "",
    hash_sha256: meta.sha256,
    tamano_bytes: meta.tamano,
    ruta_rel: meta.ruta_rel,
    nombre_archivo: `${producto}_v${version}.bin`,
    subido_por_uid: "cli",
    ts: now,
    created_at: now,
  });
  console.log(`OK ${producto} ${version} sha=${meta.sha256} bytes=${meta.tamano} -> ${meta.ruta_rel}`);

  // Poda automatica. Cada release suma ~200 MB (completo) + 6 MB (parche) y
  // antes no se borraba nada: el disco llego al 91% dos veces en tres dias.
  // Corre DESPUES de publicar, nunca antes, para no tocar nada si el registro
  // fallo. Y si la poda misma falla, se avisa y se sigue: quedarse sin podar
  // es mucho menos grave que dar por fallida una publicacion que salio bien.
  try {
    const { execFileSync } = require("child_process");
    const salida = execFileSync(
      process.execPath,
      [require("path").join(__dirname, "podar-releases.js"), "--aplicar"],
      { cwd: require("path").dirname(__dirname), encoding: "utf8" },
    );
    const resumen = salida.split("\n").filter((l) => /borrados|COHERENTE|ATENCION/.test(l));
    if (resumen.length) console.log("[poda] " + resumen.join(" | "));
  } catch (e) {
    console.error("[poda] no se pudo podar (la version quedo publicada igual):", e.message);
  }
})().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
