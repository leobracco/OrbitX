// scripts/mover-y-bot.js — Mueve un device a otro establecimiento y (opcional)
// activa el bot de soporte. Uso interno de superadmin desde la CLI del server.
//
// Uso (en el droplet): node scripts/mover-y-bot.js <device_id> <estab_destino> [bot:true|false]
"use strict";

const fs = require("fs");
const path = require("path");
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
  const deviceId = process.argv[2];
  const destino = process.argv[3];
  const activarBot = String(process.argv[4] || "true") === "true";
  if (!deviceId || !destino) {
    console.error("Uso: node scripts/mover-y-bot.js <device_id> <estab_destino> [bot:true|false]");
    process.exit(2);
  }
  const db = couch.getDB("global");

  // Sanidad: el estab destino debe existir (que haya OTRO device ahi). Evita
  // mandar el device a un slug mal escrito y dejarlo huerfano.
  const all = await db.list({ include_docs: true });
  const devs = all.rows.map(r => r.doc).filter(d => d && d._id && d._id.startsWith("device_"));
  const otrosEnDestino = devs.filter(d => d.estab_slug === destino && d._id !== `device_${deviceId}`);
  if (otrosEnDestino.length === 0) {
    console.error(`No hay otros devices en '${destino}' — puede ser un slug equivocado. Estabs existentes:`);
    const cnt = {}; devs.forEach(d => { cnt[d.estab_slug] = (cnt[d.estab_slug] || 0) + 1; });
    Object.entries(cnt).forEach(([s, n]) => console.error("  " + s + ": " + n));
    process.exit(1);
  }

  const dev = await db.get(`device_${deviceId}`);
  const antes = dev.estab_slug;
  dev.estab_slug = destino;
  await db.insert(dev);

  const chatId = `soporte_chat_${deviceId}`;
  let chat = await db.get(chatId).catch(() => null);
  if (!chat) chat = { _id: chatId, tipo: "soporte_chat", device_id: deviceId, mensajes: [] };
  chat.estab_slug = destino;
  if (activarBot) chat.bot_activo = true;
  await db.insert(chat);

  console.log(`OK device ${deviceId} (${dev.nombre || "-"}): estab ${antes} -> ${destino}` +
    (activarBot ? ", bot_activo=true" : ""));
})().catch(e => { console.error("ERROR " + e.message); process.exit(1); });
