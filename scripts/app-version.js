// app-version.js — Bumpea la versión de la PWA: escribe app/version.json y
// reemplaza el literal "const VERSION" en app/sw.js con el mismo valor.
// Correr antes de deployar (npm run app:version). El test
// tests/app/version.test.mjs verifica que ambos archivos coincidan.
const fs = require("fs");
const path = require("path");

const versionPath = path.join(__dirname, "..", "app", "version.json");
const swPath = path.join(__dirname, "..", "app", "sw.js");

const v = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + String(Date.now() % 100).padStart(2, "0");

fs.writeFileSync(versionPath, JSON.stringify({ version: v }) + "\n");

let sw = fs.readFileSync(swPath, "utf8");
sw = sw.replace(/const VERSION\s*=\s*"[^"]+"/, `const VERSION = "${v}"`);
fs.writeFileSync(swPath, sw);

console.log("version", v);
