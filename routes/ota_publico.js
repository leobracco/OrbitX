// routes/ota_publico.js — Catálogo público de firmwares + descargas sin login.
//
// Pensado para instaladores/distribuidores que necesitan bajar un .bin o
// flashear un nodo por USB sin tener cuenta en OrbitX. SIN auth (se monta
// en server.js antes de /api/ota, que sí exige JWT/device-auth).
//
// Solo se exponen los productos de campo con ESP32 propio (lista blanca
// PRODUCTOS_PUBLICOS). PilotX (ZIP de PC), PilotXParche, PilotXAndroid y
// CoreX-ECU (Teensy) NO se listan ni se pueden descargar por acá: tienen
// sus propios canales (autoupdate de PilotX, panel logueado para CoreX-ECU).
"use strict";

const router = require("express").Router();
const path   = require("path");
const fs     = require("fs");
const fw     = require("../lib/firmware");
const couch  = require("../services/couchdb");

const PRODUCTOS_PUBLICOS = ["VistaX", "QuantiX", "FlowX", "SectionX", "ToolX", "StormX"];

// ── Carpetas de flash-app/ con manifest.json (ESP Web Tools) ──────────────
// Se lee una sola vez al arrancar, no en cada request: flash-app/ no cambia
// en caliente (los binarios de flasheo se suben a mano al servidor).
const FLASH_APP_DIR = path.join(__dirname, "..", "flash-app");
let FLASHEABLES = [];
try {
  FLASHEABLES = fs.readdirSync(FLASH_APP_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((nombre) => fs.existsSync(path.join(FLASH_APP_DIR, nombre, "manifest.json")))
    .map((nombre) => nombre.toLowerCase());
} catch (e) {
  console.warn("[ota_publico] no se pudo leer flash-app/:", e.message);
}

// ── Límite de descargas por IP: 20/hora (lib/limite-descargas.js) ─────────
const { crearLimite, ipCliente } = require("../lib/limite-descargas");
const limiteDescargas = crearLimite({ limite: 20, ventanaMs: 60 * 60 * 1000 });
setInterval(() => limiteDescargas.barrer(), 10 * 60 * 1000).unref();

// ── Catálogo: docs tipo:"firmware" filtrados por lista blanca ─────────────
async function cargarCatalogo() {
  const db = couch.getDB("global");
  const sel = { tipo: "firmware" };
  const fields = ["producto", "version", "tamano_bytes", "changelog", "ts", "hash_sha256", "created_at"];

  let docs = [];
  try {
    const r = await db.find({ selector: sel, fields, limit: 500 });
    docs = r.docs;
  } catch {
    const all = await db.list({ include_docs: true });
    docs = all.rows.map((r) => r.doc).filter((d) => d && d.tipo === "firmware");
  }

  const productos = {};
  for (const p of PRODUCTOS_PUBLICOS) productos[p] = [];

  for (const d of docs) {
    if (!PRODUCTOS_PUBLICOS.includes(d.producto)) continue;
    productos[d.producto].push({
      version:      d.version,
      tamano_bytes: d.tamano_bytes,
      changelog:    d.changelog || "",
      ts:           d.ts || d.created_at || 0,
      hash_sha256:  d.hash_sha256,
    });
  }
  for (const p of PRODUCTOS_PUBLICOS) productos[p].sort((a, b) => (b.ts || 0) - (a.ts || 0));

  return productos;
}

// ══════════════════════════════════════════════════════════
//  GET /api/ota/publico — catálogo público en JSON
// ══════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const productos = await cargarCatalogo();
    res.json({ productos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/ota/publico/firmware/:producto/:version — descarga del .bin
//  Sin auth. Límite 20 descargas/IP/hora.
// ══════════════════════════════════════════════════════════
router.get("/firmware/:producto/:version", (req, res) => {
  try {
    const { producto, version } = req.params;
    if (!PRODUCTOS_PUBLICOS.includes(producto))
      return res.status(404).json({ error: "Firmware no encontrado" });
    if (!fw.existeBin(producto, version))
      return res.status(404).json({ error: "Firmware no encontrado" });

    if (!limiteDescargas.permitir(ipCliente(req)))
      return res.status(429).json({ error: "Demasiadas descargas, esperá una hora" });

    const ruta = fw.rutaBin(producto, version);
    res.download(ruta, `${producto}-${version}.bin`, (err) => {
      if (err && !res.headersSent) {
        console.error("[ota_publico/firmware] download:", err.message);
        res.status(500).json({ error: "Error leyendo firmware" });
      }
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  GET /api/ota/publico/pagina — página pública /releases
// ══════════════════════════════════════════════════════════
router.get("/pagina", async (req, res) => {
  try {
    const productos = await cargarCatalogo();
    res.render("releases", { productos, flasheables: FLASHEABLES });
  } catch (e) {
    console.error("[ota_publico/pagina]", e.message);
    res.status(500).send("Error cargando releases");
  }
});

module.exports = router;
