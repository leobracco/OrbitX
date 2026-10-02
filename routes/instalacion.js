"use strict";
// Lo que llama PilotX-Instalador.exe con su token de equipo, después de que
// Agro Parallel aprobó la pantalla: perfil, avance y diagnóstico de red.
const router = require("express").Router();
const cfg  = require("../services/config_sistema");
const inst = require("../lib/instalacion");

// nano/CouchDB usa e.statusCode (no e.status); contemplamos ambos.
const fallo = (res, e) => res.status(e.status || e.statusCode || 500).json({ error: e.message || String(e) });

router.get("/", async (req, res) => {
  try {
    res.json(await inst.armarPerfil({ gdb: req.app.locals.globalDB, cfg, deviceId: req.deviceId, now: Date.now() }));
  } catch (e) { fallo(res, e); }
});

router.post("/progreso", async (req, res) => {
  try {
    await inst.actualizarDoc(req.app.locals.globalDB, req.deviceId, d => inst.agregarPaso(d, req.body || {}, Date.now()));
    res.json({ ok: true });
  } catch (e) { fallo(res, e); }
});

router.post("/red", async (req, res) => {
  try {
    await inst.actualizarDoc(req.app.locals.globalDB, req.deviceId, d => inst.guardarRed(d, req.body || null, Date.now()));
    res.json({ ok: true });
  } catch (e) { fallo(res, e); }
});

module.exports = router;
