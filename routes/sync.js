// routes/sync.js — Recibe batches de los tractores
const router  = require("express").Router();
const db      = require("../services/couchdb");
const agraria = require("../services/agraria");

// POST /api/sync/batch
// Llamado por el PouchDB del tractor cuando detecta docs sin sincronizar
// También funciona como endpoint REST por si el tractor no usa PouchDB nativo
router.post("/batch", async (req, res) => {
  const deviceId  = req.user.uid;
  const estabSlug = req.headers["x-estab-slug"] || req.user.estabSlug;

  if (!estabSlug || estabSlug === "unknown")
    return res.status(400).json({ error: "x-estab-slug header requerido" });

  const { payload } = req.body;
  if (!Array.isArray(payload) || payload.length === 0)
    return res.status(400).json({ error: "payload debe ser un array no vacío" });

  console.log(`[Sync] ${deviceId} → ${estabSlug} · ${payload.length} docs`);

  try {
    const result = await db.procesarBatchSync(estabSlug, payload, deviceId);

    // Notificar al portal en tiempo real
    req.io.to(`estab:${estabSlug}`).emit("sync:update", {
      deviceId,
      estabSlug,
      recibidos: payload.length,
      ok:        result.ok,
      ts:        Date.now()
    });

    // Si hay lotes cerrados en el batch, generar análisis agrarIA
    const lotesFinalizados = payload.filter(d => d.tipo === "lote" && d.estado === "completado");
    for (const lote of lotesFinalizados) {
      setImmediate(async () => {
        try {
          const resumen  = await db.getResumenLote(estabSlug, lote._id);
          const analisis = await agraria.analizarLote(resumen);
          req.io.to(`estab:${estabSlug}`).emit("agraria:lote_analizado", {
            loteId: lote._id, nombre: lote.nombre, analisis, ts: Date.now()
          });
        } catch {}
      });
    }

    // Notificar alertas críticas recibidas
    const alertasCriticas = payload.filter(d => d.tipo === "alerta" && d.nivel === "CRITICO");
    for (const alerta of alertasCriticas) {
      req.io.to(`estab:${estabSlug}`).emit("alerta:nueva", {
        ...alerta, deviceId, ts: Date.now()
      });
    }

    res.json({ ok: true, recibidos: payload.length, procesados: result.ok, errores: result.errores });
  } catch (e) {
    console.error("[Sync] Error procesando batch:", e.message);
    res.status(500).json({ error: "Error procesando sync", detalle: e.message });
  }
});

// GET /api/sync/status
router.get("/status", async (req, res) => {
  const estabSlug = req.user.estabSlug;
  try {
    const pendientes = await db.countPendingSync(estabSlug);
    res.json({ estabSlug, pendientes, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sync/config  (el tractor pide su config actualizada)
router.post("/config", async (req, res) => {
  const { device_id } = req.body;
  const estabSlug = req.headers["x-estab-slug"] || req.user.estabSlug;
  try {
    const nodo = await db.getNodo(estabSlug, device_id);
    res.json({ nodo: nodo || null });
  } catch {
    res.json({ nodo: null });
  }
});

module.exports = router;
