"use strict";
// planimetria-worker.js — corre lib/planimetria.js en un worker_thread para no
// bloquear el event loop de OrbitX (un lote de 100 ha tarda ~1 s en una
// notebook y varias veces más en el droplet; mientras tanto los tractores
// siguen sincronizando). El service le manda las partes de a una
// ({tipo:"parte", texto}) y al final {tipo:"calcular", opts, meta}; el worker
// devuelve el resultado serializado y el service lo termina.
const { parentPort } = require("worker_threads");
const plani = require("./planimetria");

const acc = plani.crearAcumulador();
parentPort.on("message", (m) => {
  if (!m) return;
  if (m.tipo === "parte") { acc.agregar(m.texto); return; }
  if (m.tipo === "calcular") {
    try {
      const R = plani.calcularDesdePuntos(acc.resultado(), m.opts || {});
      parentPort.postMessage({ ok: true, S: plani.serializar(R, m.meta || {}) });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: e.message });
    }
  }
});
