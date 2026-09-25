// scripts/test-bot.js — Prueba directa del motor del bot de soporte: genera una
// respuesta para un device y un mensaje simulado, SIN persistir nada ni tocar el
// chat. Solo verifica que la API responde y el prompt/contexto funcionan.
//
// Uso (en el droplet): node scripts/test-bot.js <device_id> "<mensaje del operario>"
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
const bot = require("../services/soporte-bot");

(async () => {
  const deviceId = process.argv[2] || "OX-E9DDA1E1E47A";
  const texto = process.argv[3] || "El tractor viborea, va de lado a lado sobre la linea. Que puedo ajustar?";
  const db = couch.getDB("global");
  const mensajes = [{ rol: "operario", texto, ts: 1 }];
  console.log("device:", deviceId);
  console.log("operario:", texto);
  console.log("--- generando respuesta del bot (llama a Claude) ---");
  const r = await bot.generarRespuestaBot(db, deviceId, mensajes);
  console.log(JSON.stringify(r, null, 2));
})().catch(e => { console.error("ERROR " + e.message); process.exit(1); });
