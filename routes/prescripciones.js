"use strict";
// routes/prescripciones.js — Prescripciones como documentos de CouchDB.
//
// Se monta en /api/prescripciones ANTES del router viejo (prescripciones_api),
// que sigue sirviendo /pendientes con auth de dispositivo. Las rutas de acá no
// chocan con esas y la auth se declara ruta por ruta, para no exigir JWT en el
// camino del tractor.
const router = require("express").Router();
const auth = require("../middleware/auth");
const { noDevices } = require("./devices");
const db = require("../services/couchdb");
const presc = require("../services/prescripciones");
const { conExtraLegacy } = require("../lib/prescripcion_schema");

// Lectura: cualquier miembro autenticado que no sea un device.
const guard = [auth.required, noDevices];

// Escritura (crear / editar / borrar / generar / enviar al tractor): hace falta
// el permiso `prescripciones:write` de PERMS (middleware/auth.js): superadmin,
// owner, admin_org y agrónomo. requirePermiso evalúa el rol en la org ACTIVA del
// JWT y ya rechaza devices y tokens `orbx_`; como estas rutas aceptan ?estab=,
// permisoEnOrg vuelve a evaluar el permiso contra la org efectiva (un owner de
// la org A que es viewer en la B no puede escribir en la B).
const guardW = [auth.required, noDevices, auth.requirePermiso("prescripciones", "write"), permisoEnOrg("write")];

// Rol del usuario en la org pedida (superadmin en todas; el resto por membresía).
function rolEn(req, slug) {
  if (req.user?.rol_global === "superadmin") return "superadmin";
  return (req.user?.memberships || []).find(m => m.orgSlug === slug)?.rol || null;
}

function permisoEnOrg(accion) {
  return (req, res, next) => {
    let slug;
    try { slug = orgDe(req); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
    if (!auth.tienePermiso(rolEn(req, slug), "prescripciones", accion))
      return res.status(403).json({ error: "Sin permiso", detalle: `tu rol en ${slug} no puede escribir prescripciones` });
    next();
  };
}

function orgDe(req) {
  const slug = req.query.estab || req.user?.estabSlug;
  if (!slug) { const e = new Error("Sin organización activa"); e.status = 400; throw e; }
  if (req.query.estab && req.query.estab !== req.user?.estabSlug && !rolEn(req, req.query.estab)) {
    const e = new Error("Sin acceso a esa organización"); e.status = 403; throw e;
  }
  return slug;
}

router.get("/docs", ...guard, async (req, res) => {
  try { res.json({ ok: true, items: await presc.listar(orgDe(req), { lote: req.query.lote || null }) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get("/docs/:id", ...guard, async (req, res) => {
  try { res.json({ ok: true, doc: await presc.obtener(orgDe(req), req.params.id) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post("/docs", ...guardW, async (req, res) => {
  try { res.json({ ok: true, doc: await presc.guardar(orgDe(req), req.body || {}, req.user?.uid) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put("/docs/:id", ...guardW, async (req, res) => {
  try { res.json({ ok: true, doc: await presc.actualizar(orgDe(req), req.params.id, req.body || {}, req.user?.uid) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete("/docs/:id", ...guardW, async (req, res) => {
  try { await presc.borrar(orgDe(req), req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/prescripciones/generar — vista previa. No guarda nada salvo ?guardar=1.
router.post("/generar", ...guardW, async (req, res) => {
  try {
    const slug = orgDe(req);
    const { lote, fecha, indice, n_zonas, min_ha, dosis, unidad, sentido, nombre } = req.body || {};
    if (!lote) return res.status(400).json({ error: "Elegí un lote" });
    const fc = await presc.generar({
      slug, lote, fecha, indice, nombre,
      n: n_zonas, areaMinHa: min_ha, dosis, unidad, sentido,
    });
    if (req.query.guardar === "1") {
      const doc = await presc.guardar(slug, {
        nombre: nombre || `${lote} · ${indice || "ndvi"} ${fecha || ""}`.trim(),
        lote_nombre: lote, origen: "ndvi", geojson: fc, fuente: fc.properties.fuente,
      }, req.user?.uid);
      return res.json({ ok: true, geojson: fc, doc });
    }
    res.json({ ok: true, geojson: fc });
  } catch (e) {
    console.error("[prescripciones/generar]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/prescripciones/docs/:id/enviar — manda una prescripción guardada
// a un tractor. Sin esto, lo generado desde NDVI se queda en CouchDB y nunca
// aparece en /pendientes, que es de donde lo baja PilotX.
router.post("/docs/:id/enviar", ...guardW, async (req, res) => {
  try {
    const slug = orgDe(req);
    const deviceId = req.body?.device_id;
    if (!deviceId) return res.status(400).json({ error: "Elegí el tractor destino" });

    const doc = await presc.obtener(slug, req.params.id);

    // El tractor destino tiene que ser de la misma org: si no, se le podría
    // mandar una prescripción a la máquina de otro establecimiento.
    const globalDB = db.getDB("global");
    const dev = await globalDB.get(`device_${deviceId}`).catch(() => null);
    if (!dev) return res.status(404).json({ error: "Dispositivo no encontrado" });
    if (req.user?.rol_global !== "superadmin" && dev.estab_slug !== slug)
      return res.status(403).json({ error: "Ese tractor no es de tu organización" });
    if (dev.bloqueado) return res.status(409).json({ error: "El tractor está bloqueado" });

    const ahora = Date.now();
    const nombre = doc.nombre || "prescripcion";
    // El GeoJSON es lo ÚNICO que viaja al tractor, así que las tres dosis
    // (semilla, ferti en línea, ferti al costado) tienen que estar en las
    // properties de cada feature. En los docs migrados con la versión vieja el
    // ferti quedó en `extra`: lo plegamos acá para no mandar una prescripción
    // incompleta al campo.
    const geojson = conExtraLegacy(doc.geojson, doc.extra);
    await db.getDB(slug).insert({
      _id:       `prescripcion_${deviceId}_${ahora}`,
      tipo:      "aog_descarga_pendiente",
      ruta_rel:  `quantix/prescripciones/${nombre}.geojson`,
      nombre,
      subtipo:   "prescripcion",
      producto:  req.body?.producto || "quantix",
      contenido: JSON.stringify(geojson),
      presc_id:  doc._id,
      device_id: deviceId,
      entregado: false,
      ts:        ahora,
    });

    if (req.io) req.io.to(`maquina:${deviceId}`).emit("prescripcion:nueva", { nombre, ts: ahora });

    // Queda marcada como enviada, pero si falla no abortamos: el pendiente ya
    // está encolado y es lo que el tractor necesita.
    presc.actualizar(slug, doc._id, { estado: "enviada" }, req.user?.uid)
      .catch(e => console.warn("[prescripciones] marcar enviada:", e.message));

    res.json({ ok: true, mensaje: `Prescripción enviada a ${deviceId}` });
  } catch (e) {
    console.error("[prescripciones/enviar]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/prescripciones/migrar — sube lo que quedó en el localStorage.
router.post("/migrar", ...guardW, async (req, res) => {
  try {
    const r = await presc.migrarLocales(orgDe(req), req.body?.locales || [], req.user?.uid);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
