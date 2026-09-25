// ============================================================================
//  podar-releases.js — deja el catalogo OTA con lo que sirve, y nada mas.
//
//  Dos cosas que tienen que quedar COHERENTES y hoy no lo estan:
//    · los .bin en /opt/AgroParallel/OrbitX/firmwares/
//    · los docs firmware_* en CouchDB (lo que el panel ofrece)
//
//  Hoy el catalogo ofrece 12 versiones de PilotX cuyos .bin ya no existen: si
//  alguien elige una de esas para actualizar, la descarga falla. Esto borra las
//  dos puntas del problema.
//
//  QUE SE CONSERVA:
//    · PilotX (ZIP completo, 193 MB c/u): las 2 ultimas. Sirven para
//      instalaciones nuevas; quien ya tiene PilotX actualiza por parche.
//    · PilotXParche (6 MB c/u): los 3 ultimos. Un parche lleva HASTA una
//      version, asi que los viejos no le sirven a nadie; se dejan 3 por si hay
//      que volver atras.
//
//  Corre en seco por defecto. Con --aplicar borra de verdad.
// ============================================================================
"use strict";
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const nano = require("nano")(process.env.COUCHDB_URL);

const FW_DIR = "/opt/AgroParallel/OrbitX/firmwares";
const DB = "orbitx_global";
const CONSERVAR = { PilotX: 2, PilotXParche: 3 };
const APLICAR = process.argv.includes("--aplicar");

function semverCmp(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

(async () => {
  const db = nano.use(DB);
  const all = await db.list();
  const docs = all.rows.map((r) => r.id).filter((i) => /^firmware_PilotX/.test(i));

  let liberado = 0;
  const aBorrarBin = [];
  const aBorrarDoc = [];

  for (const producto of Object.keys(CONSERVAR)) {
    const dir = path.join(FW_DIR, producto);
    const enDisco = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).map((f) => f.replace(/\.bin$/, ""))
      : [];

    // Los docs de ESTE producto exactamente (PilotX no debe tragarse PilotXParche).
    const enCatalogo = docs
      .filter((id) => id.startsWith(`firmware_${producto}_`))
      .map((id) => id.slice(`firmware_${producto}_`.length));

    const todas = [...new Set([...enDisco, ...enCatalogo])].sort(semverCmp);
    const conservar = new Set(todas.slice(-CONSERVAR[producto]));

    console.log(`\n=== ${producto} ===`);
    console.log(`  conservar: ${[...conservar].join(", ")}`);

    for (const v of todas) {
      if (conservar.has(v)) continue;
      const bin = path.join(dir, `${v}.bin`);
      const hayBin = fs.existsSync(bin);
      const hayDoc = enCatalogo.includes(v);
      const mb = hayBin ? fs.statSync(bin).size / 1048576 : 0;
      if (hayBin) { aBorrarBin.push(bin); liberado += mb; }
      if (hayDoc) aBorrarDoc.push(`firmware_${producto}_${v}`);
      console.log(
        `  borrar ${v.padEnd(8)} ${hayBin ? mb.toFixed(1).padStart(6) + " MB" : "  (sin bin)"}` +
          `${hayDoc ? "  + doc" : "  (sin doc: huerfano en disco)"}`,
      );
    }
  }

  console.log(`\n--- total: ${aBorrarBin.length} archivos, ${liberado.toFixed(0)} MB; ${aBorrarDoc.length} docs ---`);

  if (!APLICAR) { console.log("\n(en seco — correr con --aplicar para borrar)"); return; }

  for (const f of aBorrarBin) fs.unlinkSync(f);
  console.log(`borrados ${aBorrarBin.length} .bin`);

  for (const id of aBorrarDoc) {
    try {
      const d = await db.get(id);
      await db.destroy(id, d._rev);
    } catch (e) {
      console.error(`  no se pudo borrar ${id}: ${e.message}`);
    }
  }
  console.log(`borrados ${aBorrarDoc.length} docs del catalogo`);

  // Verificacion: disco y catalogo tienen que coincidir exactamente.
  console.log("\n=== verificacion final ===");
  const all2 = await db.list();
  const docs2 = all2.rows.map((r) => r.id).filter((i) => /^firmware_PilotX/.test(i));
  let ok = true;
  for (const producto of Object.keys(CONSERVAR)) {
    const dir = path.join(FW_DIR, producto);
    const bins = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".bin")).map((f) => f.replace(/\.bin$/, "")).sort(semverCmp)
      : [];
    const cat = docs2
      .filter((id) => id.startsWith(`firmware_${producto}_`))
      .map((id) => id.slice(`firmware_${producto}_`.length))
      .sort(semverCmp);
    console.log(`  ${producto}`);
    console.log(`    disco:    ${bins.join(", ") || "(vacio)"}`);
    console.log(`    catalogo: ${cat.join(", ") || "(vacio)"}`);
    const faltaBin = cat.filter((v) => !bins.includes(v));
    const faltaDoc = bins.filter((v) => !cat.includes(v));
    if (faltaBin.length) { ok = false; console.log(`    OFRECIDAS SIN ARCHIVO: ${faltaBin.join(", ")}`); }
    if (faltaDoc.length) { ok = false; console.log(`    archivo sin ofrecer:   ${faltaDoc.join(", ")}`); }
  }
  console.log(ok ? "\n  COHERENTE: todo lo ofrecido se puede descargar." : "\n  ATENCION: quedaron inconsistencias.");
})();
