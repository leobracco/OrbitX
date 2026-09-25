// scripts/set-bot.js — Activa/desactiva el bot IA de soporte de un equipo desde
// la CLI del servidor (equivalente a POST /api/soporte/chat/:device/bot, pero sin
// necesitar sesion web). Reusa la conexion CouchDB del server.
//
// Uso (en el droplet, desde la raiz del server):
//   node scripts/set-bot.js <substr_nombre_o_deviceid>            -> lista candidatos
//   node scripts/set-bot.js <substr_nombre_o_deviceid> true|false -> setea si es unico
"use strict";

const fs = require("fs");
const path = require("path");

// Cargar .env sin depender de dotenv (mismo patron que registrar-fw.js).
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const couch = require("../services/couchdb");

(async () => {
  const [, , query, activoArg] = process.argv;
  console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "presente" : "AUSENTE (el bot no podra responder)");
  if (!query) {
    console.error("Uso: node scripts/set-bot.js <substr_nombre_o_deviceid> [true|false]");
    process.exit(2);
  }
  const db = couch.getDB("global");
  const all = await db.list({ include_docs: true });
  const devs = all.rows.map(r => r.doc).filter(d => d && d._id && d._id.startsWith("device_"));
  const q = query.toLowerCase();
  const match = devs.filter(d =>
    d._id.toLowerCase().includes(q) ||
    (d.nombre || "").toLowerCase().includes(q) ||
    (d.estab_slug || "").toLowerCase().includes(q) ||
    (d.hostname || "").toLowerCase().includes(q)
  );
  if (match.length === 0) { console.error("Sin coincidencias para: " + query); process.exit(1); }
  if (activoArg === undefined || match.length > 1) {
    console.log("Candidatos (" + match.length + "):");
    for (const d of match)
      console.log("  " + d._id + "  nombre=" + (d.nombre || "-") + "  estab=" + (d.estab_slug || "-") + "  ver=" + (d.version || "-"));
    if (activoArg === undefined) process.exit(0);
    console.error("Mas de un equipo coincide; afina el filtro para no tocar el equivocado.");
    process.exit(1);
  }
  const dev = match[0];
  const deviceId = dev._id.replace(/^device_/, "");
  const activo = String(activoArg) === "true";
  const chatId = "soporte_chat_" + deviceId;
  let doc = await db.get(chatId).catch(() => null);
  if (!doc) doc = { _id: chatId, tipo: "soporte_chat", device_id: deviceId, estab_slug: dev.estab_slug || "", mensajes: [] };
  doc.bot_activo = activo;
  await db.insert(doc);
  console.log("OK " + chatId + " bot_activo=" + activo + "  (equipo " + (dev.nombre || deviceId) + ", ver " + (dev.version || "-") + ")");
})().catch(e => { console.error("ERROR " + e.message); process.exit(1); });
