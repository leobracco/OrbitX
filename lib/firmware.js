// lib/firmware.js — Storage local de firmwares OTA.
// Ruta por defecto: <root>/firmwares/<producto>/<version>.bin
// Cada upload: superadmin sube .bin, calculamos SHA256, guardamos el doc en orbitx_global.
"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRODUCTOS = [
  "VistaX", "SoilX", "SignalX", "CowX", "QuantiX",
  "LineX", "SectionX", "StormX", "FlowX",
  // PilotX = la app de PC en el tractor (autoupdate del propio AOG).
  // El archivo .bin para este producto es en realidad un .zip con el build
  // completo; el cliente C# (PilotXSelfUpdate) lo detecta por magic bytes.
  // NOTA 2026-05-27: PilotX migró a canal público agroparallel.com/update,
  // este slot queda por compat con historial de firmwares ya subidos.
  "PilotX",
  // CoreX-ECU = firmware Teensy del módulo de control de pilotaje (WAS,
  // autosteer, ADS1115, BNO RVC). El archivo es .hex de Teensy Loader, se
  // sirve igual que un .bin — el cliente PilotX lo descarga al cache local
  // y el módulo OTA del Teensy lo flashea (NO usa el flujo Update.h ESP32).
  "CoreX-ECU",
];

const FW_DIR = process.env.FIRMWARE_DIR
  ? path.resolve(process.env.FIRMWARE_DIR)
  : path.resolve(__dirname, "..", "firmwares");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function dirProducto(producto) {
  return path.join(FW_DIR, producto);
}

function rutaBin(producto, version) {
  return path.join(dirProducto(producto), `${version}.bin`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(filePath);
    s.on("error", reject);
    s.on("data", (b) => h.update(b));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

// Mueve un archivo subido (multer) al storage definitivo. Devuelve {ruta, sha256, tamano}.
async function guardarBin(producto, version, tmpPath) {
  if (!PRODUCTOS.includes(producto))
    throw Object.assign(new Error(`Producto desconocido: ${producto}`), { status: 400 });
  if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(version))
    throw Object.assign(new Error(`Versión inválida: ${version} (usá semver, ej 1.2.3)`), { status: 400 });

  ensureDir(dirProducto(producto));
  const dst = rutaBin(producto, version);
  if (fs.existsSync(dst))
    throw Object.assign(new Error(`Ya existe ${producto} ${version}`), { status: 409 });

  await fs.promises.rename(tmpPath, dst).catch(async (e) => {
    // Si rename cruza filesystem (EXDEV) — copia + delete.
    if (e.code === "EXDEV") {
      await fs.promises.copyFile(tmpPath, dst);
      await fs.promises.unlink(tmpPath).catch(() => {});
    } else throw e;
  });

  const stat   = await fs.promises.stat(dst);
  const sha256 = await sha256File(dst);
  return { ruta: dst, ruta_rel: path.relative(FW_DIR, dst).replace(/\\/g, "/"), sha256, tamano: stat.size };
}

async function eliminarBin(producto, version) {
  const p = rutaBin(producto, version);
  if (fs.existsSync(p)) await fs.promises.unlink(p);
}

function streamBin(producto, version) {
  const p = rutaBin(producto, version);
  if (!fs.existsSync(p))
    throw Object.assign(new Error("Firmware no encontrado en disco"), { status: 404 });
  return fs.createReadStream(p);
}

function existeBin(producto, version) {
  return fs.existsSync(rutaBin(producto, version));
}

module.exports = {
  PRODUCTOS,
  FW_DIR,
  ensureDir,
  rutaBin,
  guardarBin,
  eliminarBin,
  streamBin,
  existeBin,
  sha256File,
};
