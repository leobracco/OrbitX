// ============================================================================
// routes/crm.js — puente de SOLO LECTURA para el CRM (crm.agroparallel.com).
//
// El CRM vincula sus clientes con establecimientos de OrbitX y muestra la
// flota (pantallas PilotX) en la ficha del cliente: última conexión, versión
// y el ID de RustDesk para soporte en un clic.
//
// Auth servicio-a-servicio: header X-CRM-Token debe coincidir con la env
// CRM_SERVICE_TOKEN. Fail-fast: sin la env configurada el puente queda
// APAGADO (503) — mismo criterio que el hardening Tanda A (defaults de prod
// cerrados). No usa JWT ni device-token: es otro AUDIENCE, otro secreto.
//
//   GET /api/crm/establecimientos → { establecimientos:[{slug,nombre}] }
//   GET /api/crm/flota/:estab     → { devices:[{device_id,nombre,hostname,
//                                     version,ultimo_visto,online,rustdesk_id}] }
//   GET /api/crm/devices          → todos los devices (incluye sin asignar),
//                                     mismos campos + estab_slug
// ============================================================================
"use strict";

const router = require("express").Router();
const db = require("../services/couchdb");

const TOKEN = process.env.CRM_SERVICE_TOKEN || "";

// Umbral de "online": mismo criterio visual que el panel (heartbeat cada
// pocos minutos; 10 min sin ver al equipo = apagado o sin internet).
const ONLINE_MS = 10 * 60 * 1000;

router.use((req, res, next) => {
  if (!TOKEN) {
    return res.status(503).json({ error: "Puente CRM apagado (CRM_SERVICE_TOKEN sin configurar)" });
  }
  if (req.get("X-CRM-Token") !== TOKEN) {
    return res.status(401).json({ error: "Token de servicio inválido" });
  }
  next();
});

router.get("/establecimientos", async (_req, res) => {
  try {
    // Prod guarda las organizaciones como tipo:"org" (org_<slug>); el código
    // viejo usaba tipo:"establecimiento". Se aceptan ambos y se mergea por
    // slug para que el puente ande contra cualquier base.
    const g = db.getDB("global");
    const r = await g.find({
      selector: { tipo: { $in: ["org", "establecimiento"] } },
      limit: 500,
    });
    const porSlug = new Map();
    for (const d of r.docs || []) {
      if (d.slug && !porSlug.has(d.slug)) {
        porSlug.set(d.slug, { slug: d.slug, nombre: d.nombre || d.slug });
      }
    }
    res.json({ establecimientos: [...porSlug.values()] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Todos los devices, INCLUIDOS los sin asignar (estab_slug null): el CRM
// los usa para el registro de equipos fabricados — un piloto recién armado
// en el banco ya aparece acá con su RustDesk aunque no tenga cliente.
router.get("/devices", async (_req, res) => {
  try {
    const g = db.getDB("global");
    const r = await g.find({
      selector: { tipo: "device" },
      limit: 500,
    });
    const ahora = Date.now();
    const devices = (r.docs || []).map((d) => ({
        device_id: d.device_id,
        nombre: d.nombre || d.device_id,
        hostname: d.hostname || null,
        version: d.version || null,
        ultimo_visto: d.ultimo_visto || null,
        online: !!d.ultimo_visto && ahora - d.ultimo_visto < ONLINE_MS,
        rustdesk_id: d.rustdesk_id || null,
        estab_slug: d.estab_slug || null,
      }));
    devices.sort((a, b) =>
      (b.online - a.online) || ((b.ultimo_visto || 0) - (a.ultimo_visto || 0)));
    res.json({ devices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/flota/:estab", async (req, res) => {
  try {
    const g = db.getDB("global");
    const r = await g.find({
      selector: { tipo: "device", estab_slug: req.params.estab },
      limit: 200,
    });
    const ahora = Date.now();
    // Online ARRIBA, offline abajo; dentro de cada grupo, el visto mas
    // reciente primero (pedido explicito del admin del CRM).
    const devices = (r.docs || []).map((d) => ({
        device_id: d.device_id,
        nombre: d.nombre || d.device_id,
        hostname: d.hostname || null,
        version: d.version || null,
        ultimo_visto: d.ultimo_visto || null,
        online: !!d.ultimo_visto && ahora - d.ultimo_visto < ONLINE_MS,
        rustdesk_id: d.rustdesk_id || null,
      }));
    devices.sort((a, b) =>
      (b.online - a.online) || ((b.ultimo_visto || 0) - (a.ultimo_visto || 0)));
    res.json({ devices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
