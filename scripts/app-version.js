// app-version.js — Bumpea la versión de la PWA: escribe app/version.json y
// reemplaza el literal "const VERSION" en app/sw.js con el mismo valor.
// Correr antes de deployar (npm run app:version). El test
// tests/app/version.test.mjs verifica que ambos archivos coincidan.
const fs = require("fs");
const path = require("path");

const versionPath = path.join(__dirname, "..", "app", "version.json");
const swPath = path.join(__dirname, "..", "app", "sw.js");

// Formato AAAAMMDD-NN con NN correlativo dentro del día: monótono y sin
// colisiones (dos bumps iguales dejarían sw.js byte-idéntico y el navegador
// no detectaría la actualización).
const hoy  = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const prev = JSON.parse(fs.readFileSync(versionPath, "utf8")).version || "";
const n    = prev.startsWith(hoy) ? Number(prev.slice(-2)) + 1 : 1;
const v    = `${hoy}-${String(n).padStart(2, "0")}`;

const RE_VERSION = /const VERSION\s*=\s*"[^"]+"/;
let sw = fs.readFileSync(swPath, "utf8");
if (!RE_VERSION.test(sw)) throw new Error("no encontré `const VERSION = \"...\"` en app/sw.js: no se bumpeó nada");

fs.writeFileSync(versionPath, JSON.stringify({ version: v }, null, 2) + "\n");
fs.writeFileSync(swPath, sw.replace(RE_VERSION, `const VERSION = "${v}"`));

console.log("version", v);
