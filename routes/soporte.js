// ============================================================
//  OrbitX Cloud - routes/soporte.js
//  Canal de diagnostico remoto: el panel deja un pedido, la
//  pantalla lo levanta cuando pregunta, y devuelve el texto.
//
//  Por que existe:
//    Cuando una pantalla en el campo falla, la unica forma de
//    ver que pasa era dictarle comandos por telefono a quien
//    estuviera parado adelante. El 2026-09-05 eso costo varias
//    horas y una maquina parada.
//
//  Como funciona:
//    El servidor NO se conecta al tractor. La pantalla pregunta
//    cada 20 s si tiene algo pendiente; si hay, corre la funcion
//    del catalogo y postea el texto. Todo sale de adentro hacia
//    afuera, asi que no hace falta abrir nada en el tractor.
//
//  Que se puede pedir:
//    Solo las ocho funciones de diagnostico que estan escritas
//    en la pantalla (AccionesSoporte.cs): estado, sistema, red,
//    puertos, procesos, firewall, logs_pilotx, nodos. El campo
//    "accion" es una CLAVE de diccionario, no un comando: si no
//    esta en el catalogo, la pantalla lo rechaza. Aca ademas se
//    valida contra la misma lista para no encolar pedidos que
//    van a rebotar.
//
//  Endpoints:
//    POST /api/soporte/comando      (JWT)    encolar un pedido
//    GET  /api/soporte/comandos     (JWT)    historial + resultados
//    GET  /api/soporte/catalogo     (JWT)    que se puede pedir
//    GET  /api/soporte/pendientes   (device) los suyos, y solo los suyos
//    POST /api/soporte/resultado    (device) devuelve el texto
// ============================================================

const router = require("express").Router();
const { deviceAuth } = require("./devices");
const soporteBot = require("../services/soporte-bot"); // capa 2 — bot IA

// Espejo del catalogo que vive en la pantalla (AccionesSoporte.cs).
// Si se agrega una funcion alla, agregarla aca; si no, el panel no la
// ofrece. Lista blanca a proposito: un "accion" que no este en esta
// lista no se encola.
const CATALOGO = {
  estado:      "Version de PilotX, si el motor responde y perfil activo",
  sistema:     "Windows, RAM, disco y CPU",
  red:         "IPs, gateway, DNS y si llega a OrbitX",
  puertos:     "Quien escucha en 5180 / 1883 / 8888",
  procesos:    "Que procesos de PilotX corren y desde que ruta",
  firewall:    "Perfiles de firewall y reglas de PilotX",
  logs_pilotx: "Ultimas lineas del log de eventos (param: lineas)",
  nodos:       "Config de nodos vista por la pantalla",
  flowx_diag:       "FlowX: caudal, PWM, objetivo, config y secciones",
  flowx_pwm:        "FlowX: mueve la valvula a un PWM (params: uid, pwm, seg)",
  flowx_pisos:      "FlowX: graba pwm_min de arranque (params: uid, pos, neg)",
  flowx_config:     "FlowX: ajusta config en PilotX (params: uid, pwm_min, dosis_lha, modo_manual, manual_lmin, meter_cal)",
  secciones_manual: "Maestro de secciones en manual (param: on)",
  nodos_live:       "Nodos que ve el Engine: online/offline, IP, version, ultimo visto",
  nodo_estado:      "Matriz wifi/mqtt/target/status de un nodo (param: uid)",
  ping:             "Ping a una IP privada de la LAN (param: ip)",
  corte_config:     "Config del corte (rumbo, anticipacion, secciones, implemento) + motores QuantiX + live",
};

// Cuales de esas acciones NO son solo lectura: escriben config en la pantalla
// o mueven la maquina (valvula de FlowX, maestro de secciones). El catalogo
// las declaraba todas como solo_lectura: true, lo que es mentira y hace que
// quien mira el panel crea que pedir un diagnostico nunca toca el fierro.
const ESCRIBEN = new Set([
  "flowx_pwm",        // mueve la valvula a un PWM durante unos segundos
  "flowx_pisos",      // graba pwm_min de arranque
  "flowx_config",     // ajusta config de FlowX en PilotX
  "secciones_manual", // pone el maestro de secciones en manual
]);

// Un pedido que nadie levanta no se acumula para siempre: si la pantalla
// estuvo apagada media hora, cuando prenda no tiene sentido correrle
// diagnosticos que se pidieron en otro momento.
const VENCE_MS = 30 * 60 * 1000;

// Tope de texto guardado, alineado con el de la pantalla (256 KB).
const MAX_SALIDA = 256 * 1024;

const ahora = () => Date.now();
const nuevoId = () =>
  "soporte_cmd_" + ahora().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

function db(req) { return req.app.locals.globalDB; }

// Defensa en profundidad, igual que en routes/devices.js: auth.required
// TAMBIEN autentica equipos (rol_global "device"), asi que sin este guard un
// token de dispositivo podia ENCOLAR diagnosticos sobre CUALQUIER maquina de
// la flota y leer la salida. Se detecto probando: el POST /comando entraba
// con el token del propio equipo. Encolar y ver resultados son acciones de
// panel: solo personas logueadas.
function soloPersonas(req, res, next) {
  if (req.user && req.user.isDevice)
    return res.status(403).json({ error: "Endpoint no disponible para dispositivos" });
  next();
}

// ------------------------------------------------------------
//  POST /api/soporte/comando   (JWT)
//  body: { device_id, accion, params?, timeout_seg? }
// ------------------------------------------------------------
router.post("/comando", soloPersonas, async (req, res) => {
  try {
    const { device_id, accion } = req.body || {};
    if (!device_id) return res.status(400).json({ error: "Falta device_id" });
    if (!accion)    return res.status(400).json({ error: "Falta accion" });

    if (!Object.prototype.hasOwnProperty.call(CATALOGO, accion))
      return res.status(400).json({
        error: `Diagnostico desconocido: ${accion}`,
        disponibles: Object.keys(CATALOGO),
      });

    const equipo = await db(req).get(`device_${device_id}`).catch(() => null);
    if (!equipo) return res.status(404).json({ error: "Equipo no registrado" });

    // Scoping por org, mismo patron que /chat/enviar. Sin esto cualquier
    // usuario logueado del panel — incluido un viewer de otra organizacion —
    // encolaba acciones sobre CUALQUIER equipo de la flota (red, procesos,
    // firewall, logs, y las de FlowX/secciones que mueven la maquina).
    const orgs = orgsDelUsuario(req);
    if (orgs && !orgs.has(equipo.estab_slug))
      return res.status(403).json({ error: "Sin acceso a ese equipo" });

    // Params: solo strings cortos. Las funciones de la pantalla los validan
    // igual, pero no tiene sentido dejar entrar cualquier cosa.
    const params = {};
    for (const [k, v] of Object.entries(req.body.params || {})) {
      if (typeof k === "string" && k.length <= 40)
        params[k] = String(v).slice(0, 200);
    }

    let timeout = parseInt(req.body.timeout_seg, 10);
    if (!Number.isFinite(timeout)) timeout = 60;
    timeout = Math.min(Math.max(timeout, 1), 300);

    const id = nuevoId();
    const t = ahora();
    await db(req).insert({
      _id: id,
      tipo: "soporte_cmd",
      device_id,
      accion,
      params,
      timeout_seg: timeout,
      estado: "pendiente",         // pendiente -> entregado -> listo
      pedido_por: req.user?.uid ? `usr_${req.user.uid}` : "system",
      created_at: t,
      updated_at: t,
      vence_en: t + VENCE_MS,
      ok: null,
      salida: null,
      ms: null,
    });

    res.json({
      ok: true, id, accion, device_id,
      nota: "La pantalla pregunta cada 20 s. Consultar el resultado en GET /api/soporte/comandos?id=" + id,
    });
  } catch (e) {
    console.error("[soporte/comando]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
//  GET /api/soporte/catalogo   (JWT)
// ------------------------------------------------------------
router.get("/catalogo", soloPersonas, (_req, res) => {
  res.json({
    acciones: Object.entries(CATALOGO).map(([nombre, descripcion]) => ({
      nombre, descripcion, solo_lectura: !ESCRIBEN.has(nombre),
    })),
  });
});

// ------------------------------------------------------------
//  GET /api/soporte/comandos?device_id=&id=&limit=   (JWT)
// ------------------------------------------------------------
router.get("/comandos", soloPersonas, async (req, res) => {
  try {
    // El doc del comando no guarda la org: sale del equipo al que apunta.
    // Sin este scoping se leia la salida (red, procesos, firewall, logs) de
    // equipos de cualquier organizacion.
    const orgs = orgsDelUsuario(req);

    if (req.query.id) {
      const d = await db(req).get(req.query.id).catch(() => null);
      if (!d || d.tipo !== "soporte_cmd") return res.status(404).json({ error: "No existe" });
      if (orgs) {
        const dev = await db(req).get(`device_${d.device_id}`).catch(() => null);
        if (!dev || !orgs.has(dev.estab_slug))
          return res.status(403).json({ error: "Sin acceso a ese equipo" });
      }
      return res.json(d);
    }

    const selector = { tipo: "soporte_cmd" };
    if (req.query.device_id) selector.device_id = req.query.device_id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);

    const r = await db(req).find({ selector, limit: 500 });
    let docs = r.docs
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    if (orgs) {
      // Que equipos de los que aparecen en la lista son de mis orgs:
      // un solo round-trip contra CouchDB, como en /config-backups.
      const keys = [...new Set(docs.map(d => `device_${d.device_id}`))];
      const permitidos = new Set();
      if (keys.length) {
        const all = await db(req).list({ keys, include_docs: true }).catch(() => ({ rows: [] }));
        for (const row of all.rows)
          if (row.doc && orgs.has(row.doc.estab_slug)) permitidos.add(row.doc.device_id);
      }
      docs = docs.filter(d => permitidos.has(d.device_id));
    }

    docs = docs.slice(0, limit);
    res.json({ total: docs.length, comandos: docs });
  } catch (e) {
    console.error("[soporte/comandos]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
//  GET /api/soporte/pendientes   (device)
//  Devuelve SOLO los del equipo que pregunta y los marca entregados,
//  para que no se corran dos veces si la respuesta se pierde a mitad.
// ------------------------------------------------------------
router.get("/pendientes", deviceAuth, async (req, res) => {
  try {
    const t = ahora();
    const r = await db(req).find({
      selector: { tipo: "soporte_cmd", device_id: req.deviceId, estado: "pendiente" },
      limit: 20,
    });

    const salida = [];
    for (const d of r.docs) {
      if (d.vence_en && d.vence_en < t) {
        // Vencido: se cierra sin correrlo. Que quede constancia de por que
        // no hay resultado, en vez de desaparecer.
        try {
          await db(req).insert({
            ...d, estado: "listo", ok: false, updated_at: t,
            salida: "Vencido: la pantalla no estuvo conectada dentro de los 30 minutos.",
          });
        } catch {}
        continue;
      }
      salida.push({
        id: d._id,
        accion: d.accion,
        params: d.params || {},
        timeout_seg: d.timeout_seg || 60,
      });
      try { await db(req).insert({ ...d, estado: "entregado", updated_at: t }); } catch {}
    }

    res.json({ comandos: salida });
  } catch (e) {
    console.error("[soporte/pendientes]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
//  POST /api/soporte/resultado   (device)
//  body: { id, ok, salida, ms }
// ------------------------------------------------------------
router.post("/resultado", deviceAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Falta id" });

    const d = await db(req).get(id).catch(() => null);
    if (!d || d.tipo !== "soporte_cmd") return res.status(404).json({ error: "No existe" });

    // Un equipo solo puede contestar lo suyo. Sin esto, un token cualquiera
    // podria pisar el resultado de otra maquina.
    if (d.device_id !== req.deviceId)
      return res.status(403).json({ error: "Ese pedido es de otro equipo" });

    let salida = typeof req.body.salida === "string" ? req.body.salida : "";
    if (salida.length > MAX_SALIDA)
      salida = salida.slice(0, MAX_SALIDA) + "\n[...recortado por el servidor]";

    const t = ahora();
    await db(req).insert({
      ...d,
      estado: "listo",
      ok: req.body.ok === true,
      salida,
      ms: parseInt(req.body.ms, 10) || null,
      respondido_en: t,
      updated_at: t,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error("[soporte/resultado]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------------------------------------------
//  Backup de configuracion del equipo (device)
//  El equipo sube su config (vehiculo, implemento, secciones, nodos) al
//  arrancar. Se guarda 1 doc por equipo con las ultimas N versiones, para
//  poder restaurar si se pierde el disco o se rompe una config en el campo.
//    POST /api/soporte/config-backup   (device)  { config: {...}, version }
//    GET  /api/soporte/config-backup   (JWT)     ?device_id=...
// ------------------------------------------------------------
const MAX_VERSIONES = 10;             // historial por equipo
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

router.post("/config-backup", deviceAuth, async (req, res) => {
  try {
    const cfg = req.body && req.body.config;
    if (cfg === undefined || cfg === null)
      return res.status(400).json({ error: "Falta 'config'" });

    const payload = JSON.stringify(cfg);
    if (payload.length > MAX_BACKUP_BYTES)
      return res.status(413).json({ error: "Config demasiado grande" });

    const id = `config_backup_${req.deviceId}`;
    const t = ahora();
    const doc = await db(req).get(id).catch(() => null);

    // Firma para no versionar dos veces lo mismo: si el equipo rearranca sin
    // cambios, se actualiza solo la fecha del ultimo visto, no se agrega copia.
    const firma = require("crypto").createHash("sha256").update(payload).digest("hex");
    const versiones = (doc && doc.versiones) || [];
    const ultima = versiones[versiones.length - 1];

    if (ultima && ultima.firma === firma) {
      await db(req).insert({ ...doc, ultimo_visto: t, updated_at: t });
      return res.json({ ok: true, sin_cambios: true, total: versiones.length });
    }

    versiones.push({
      ts: t,
      version_pilotx: String(req.body.version || "").slice(0, 40),
      firma,
      config: cfg,
    });
    while (versiones.length > MAX_VERSIONES) versiones.shift();

    await db(req).insert({
      _id: id,
      ...(doc ? { _rev: doc._rev } : {}),
      tipo: "config_backup",
      device_id: req.deviceId,
      estab_slug: (req.deviceDoc && req.deviceDoc.estab_slug) || null,
      versiones,
      ultimo_visto: t,
      created_at: (doc && doc.created_at) || t,
      updated_at: t,
    });
    res.json({ ok: true, total: versiones.length });
  } catch (e) {
    console.error("[soporte/config-backup POST]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Un usuario solo ve configs de equipos de sus orgs; superadmin todas.
// (null = sin restricción)
function orgsDelUsuario(req) {
  const u = req.user || {};
  if (u.rol_global === "superadmin") return null;
  const set = new Set((u.memberships || []).map(m => m.orgSlug));
  if (u.estabSlug) set.add(u.estabSlug);
  return set;
}

// ------------------------------------------------------------
//  GET /api/soporte/config-backups   (JWT)
//  Indice de la config real de cada equipo, scoped por org.
// ------------------------------------------------------------
router.get("/config-backups", soloPersonas, async (req, res) => {
  try {
    const r = await db(req).find({ selector: { tipo: "config_backup" }, limit: 500 });
    const orgs = orgsDelUsuario(req);
    const docs = r.docs.filter(d => !orgs || orgs.has(d.estab_slug));

    // hostname de cada equipo en un solo round-trip
    const keys = docs.map(d => `device_${d.device_id}`);
    const nombres = new Map();
    if (keys.length) {
      try {
        const all = await db(req).list({ keys, include_docs: true });
        for (const row of all.rows) if (row.doc) nombres.set(row.doc.device_id, row.doc.hostname || "");
      } catch {}
    }

    res.json(docs.map(d => {
      const vs  = d.versiones || [];
      const ult = vs[vs.length - 1] || {};
      return {
        device_id:      d.device_id,
        estab_slug:     d.estab_slug,
        hostname:       nombres.get(d.device_id) || "",
        ultimo_visto:   d.ultimo_visto,
        n_versiones:    vs.length,
        version_pilotx: ult.version_pilotx || "",
        ts_ultima:      ult.ts || null,
      };
    }).sort((a, b) => (b.ultimo_visto || 0) - (a.ultimo_visto || 0)));
  } catch (e) {
    console.error("[soporte/config-backups]", e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get("/config-backup", soloPersonas, async (req, res) => {
  try {
    if (!req.query.device_id)
      return res.status(400).json({ error: "Falta device_id" });
    const doc = await db(req).get(`config_backup_${req.query.device_id}`).catch(() => null);
    if (!doc) return res.status(404).json({ error: "Sin backup para ese equipo" });
    // Scoping por org: sin esto cualquier usuario logueado bajaba la config
    // completa (con device_token) de equipos de otras orgs.
    const orgs = orgsDelUsuario(req);
    if (orgs && !orgs.has(doc.estab_slug))
      return res.status(403).json({ error: "Sin acceso a ese equipo" });
    // Si piden ?full=1 devuelve las configs completas; por defecto solo el indice.
    if (req.query.full === "1") return res.json(doc);
    res.json({
      device_id: doc.device_id,
      estab_slug: doc.estab_slug,
      ultimo_visto: doc.ultimo_visto,
      versiones: (doc.versiones || []).map((v) => ({
        ts: v.ts, version_pilotx: v.version_pilotx, firma: v.firma,
      })),
    });
  } catch (e) {
    console.error("[soporte/config-backup GET]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
//  CHAT DE SOPORTE (capa 1) — transporte PilotX <-> OrbitX
//  La pantalla PREGUNTA por mensajes nuevos y POSTEA los del operario
//  (device-auth, sin abrir puertos). Nosotros escribimos/leemos con JWT.
//  Doc: soporte_chat_<device_id> { mensajes:[{rol, texto, ts, entregado, leido}] }
//    rol: "operario" (pantalla) | "soporte" (nosotros) | "bot" (IA, capa 2)
// ============================================================
const MAX_MSG = 4000;
const MAX_HIST = 500;

async function upsertChat(dbi, id, mutar, deviceId, estabSlug) {
  const t = ahora();
  for (let i = 0; i < 3; i++) {
    try {
      const doc = await dbi.get(id).catch(() => null);
      const base = doc || {
        _id: id, tipo: "soporte_chat", device_id: deviceId,
        estab_slug: estabSlug || null, mensajes: [], created_at: t,
      };
      base.mensajes = (base.mensajes || []).slice();
      mutar(base, t);
      base.mensajes = base.mensajes.slice(-MAX_HIST);
      base.updated_at = t;
      await dbi.insert(base);
      return base;
    } catch (e) {
      if ((e.statusCode === 409 || e.error === "conflict") && i < 2) {
        await new Promise(r => setTimeout(r, 20 + Math.random() * 40));
        continue;
      }
      throw e;
    }
  }
}

// GET /api/soporte/chat/pendientes (device) — mensajes nuestros/bot no entregados
router.get("/chat/pendientes", deviceAuth, async (req, res) => {
  try {
    const doc = await db(req).get(`soporte_chat_${req.deviceId}`).catch(() => null);
    if (!doc) return res.json({ mensajes: [] });
    const nuevos = (doc.mensajes || []).filter(m => m.rol !== "operario" && !m.entregado);
    if (nuevos.length) {
      await upsertChat(db(req), doc._id, (d) => {
        d.mensajes = d.mensajes.map(m => (m.rol !== "operario" && !m.entregado) ? { ...m, entregado: true } : m);
      }, req.deviceId, (req.deviceDoc || {}).estab_slug);
    }
    // Capa 2: si el mensaje es del bot y trae tipo/payload (ej. una
    // propuesta_config), se los pasamos a la pantalla para que pueda mostrar
    // Aceptar/Rechazar. Mensajes viejos sin 'tipo' siguen siendo texto normal.
    res.json({ mensajes: nuevos.map(m => ({
      rol: m.rol, texto: m.texto, ts: m.ts,
      tipo: m.tipo || "texto",
      ...(m.payload ? { payload: m.payload } : {}),
    })) });
  } catch (e) {
    console.error("[soporte/chat/pendientes]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/soporte/chat/mensaje (device) — el operario manda un mensaje
router.post("/chat/mensaje", deviceAuth, async (req, res) => {
  try {
    const texto = String((req.body || {}).texto || "").slice(0, MAX_MSG).trim();
    if (!texto) return res.status(400).json({ error: "Mensaje vacío" });
    const doc = await upsertChat(db(req), `soporte_chat_${req.deviceId}`, (d, t) => {
      d.mensajes.push({ rol: "operario", tipo: "texto", texto, ts: t, entregado: true, leido: false });
    }, req.deviceId, (req.deviceDoc || {}).estab_slug);

    // Le contestamos YA a la pantalla; el bot (si esta activo) corre aparte y su
    // respuesta la levanta la pantalla en el proximo GET /chat/pendientes.
    res.json({ ok: true });

    // ── GATING capa 2 ────────────────────────────────────────────
    // El bot SOLO responde si el chat tiene bot_activo === true. El default
    // es false/undefined, asi que con la config de hoy esto no hace NADA y el
    // comportamiento es identico al de la capa 1.
    if (doc && doc.bot_activo === true) {
      dispararBot(db(req), req.deviceId, (req.deviceDoc || {}).estab_slug)
        .catch(e => console.error("[soporte/bot] fallo generando respuesta:", e.message));
    }
  } catch (e) {
    console.error("[soporte/chat/mensaje]", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// POST /api/soporte/chat/propuesta (device) — la pantalla marca el estado de
// una propuesta_config cuando el operario Acepta/Rechaza (o cuando se aplico).
// body: { ts:<epoch ms del mensaje propuesta>, estado:"aceptada"|"rechazada"|"aplicada", detalle? }
// Busca el mensaje bot con ese ts y tipo "propuesta_config" y le setea el
// estado en el payload. Si no lo encuentra, {ok:false} (200, no es error).
const ESTADOS_PROPUESTA = ["aceptada", "rechazada", "aplicada"];
router.post("/chat/propuesta", deviceAuth, async (req, res) => {
  try {
    const ts = parseInt((req.body || {}).ts, 10);
    const estado = String((req.body || {}).estado || "");
    if (!Number.isFinite(ts)) return res.status(400).json({ error: "Falta ts" });
    if (!ESTADOS_PROPUESTA.includes(estado))
      return res.status(400).json({ error: "estado invalido", estados: ESTADOS_PROPUESTA });
    const detalle = typeof (req.body || {}).detalle === "string"
      ? req.body.detalle.slice(0, MAX_MSG) : null;

    let encontrado = false;
    await upsertChat(db(req), `soporte_chat_${req.deviceId}`, (d, t) => {
      d.mensajes = d.mensajes.map(m => {
        if (m.ts === ts && m.tipo === "propuesta_config") {
          encontrado = true;
          const payload = { ...(m.payload || {}), estado, resuelto_ts: t };
          if (detalle !== null) payload.detalle = detalle;
          return { ...m, payload };
        }
        return m;
      });
    }, req.deviceId, (req.deviceDoc || {}).estab_slug);

    res.json({ ok: encontrado });
  } catch (e) {
    console.error("[soporte/chat/propuesta]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Genera la respuesta del bot y la persiste como mensaje rol:"bot". Se corre
// fuera del ciclo request/response (fire-and-forget) para no demorarle el POST
// a la pantalla; los errores se loguean y no afectan al operario.
async function dispararBot(dbi, deviceId, estabSlug) {
  const chatId = `soporte_chat_${deviceId}`;
  const doc = await dbi.get(chatId).catch(() => null);
  if (!doc || doc.bot_activo !== true) return; // re-chequeo por si se apago en el medio
  const mensajes = doc.mensajes || [];
  // Nada que contestar si el ultimo no es del operario (ya contestamos).
  const ultimo = mensajes[mensajes.length - 1];
  if (!ultimo || ultimo.rol !== "operario") return;

  const salida = await soporteBot.generarRespuestaBot(dbi, deviceId, mensajes);
  if (!salida || !salida.texto) return;

  await upsertChat(dbi, chatId, (d, t) => {
    d.mensajes.push({
      rol: "bot",
      tipo: salida.tipo || "texto",
      texto: salida.texto,
      ...(salida.payload ? { payload: salida.payload } : {}),
      ts: t, entregado: false, leido: false, por: "bot",
    });
  }, deviceId, estabSlug);
}

// POST /api/soporte/chat/enviar (JWT) — nosotros/bot escribimos a la pantalla
router.post("/chat/enviar", soloPersonas, async (req, res) => {
  try {
    const { device_id, texto, rol } = req.body || {};
    if (!device_id) return res.status(400).json({ error: "Falta device_id" });
    const txt = String(texto || "").slice(0, MAX_MSG).trim();
    if (!txt) return res.status(400).json({ error: "Mensaje vacío" });
    const dev = await db(req).get(`device_${device_id}`).catch(() => null);
    if (!dev) return res.status(404).json({ error: "Equipo no encontrado" });
    const orgs = orgsDelUsuario(req);
    if (orgs && !orgs.has(dev.estab_slug)) return res.status(403).json({ error: "Sin acceso a ese equipo" });
    await upsertChat(db(req), `soporte_chat_${device_id}`, (d, t) => {
      d.mensajes.push({ rol: rol === "bot" ? "bot" : "soporte", texto: txt, ts: t, entregado: false, leido: false, por: `usr_${req.user.uid}` });
    }, device_id, dev.estab_slug);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/soporte/chat/:device/bot (JWT) — activar/desactivar el bot IA
// del equipo. body: { activo: true|false }. Scoped por org como el resto.
// Con bot_activo=false (default) el bot no responde solo — no cambia nada
// respecto de la capa 1.
router.post("/chat/:device/bot", soloPersonas, async (req, res) => {
  try {
    const activo = (req.body || {}).activo === true;
    const dev = await db(req).get(`device_${req.params.device}`).catch(() => null);
    if (!dev) return res.status(404).json({ error: "Equipo no encontrado" });
    const orgs = orgsDelUsuario(req);
    if (orgs && !orgs.has(dev.estab_slug)) return res.status(403).json({ error: "Sin acceso a ese equipo" });
    await upsertChat(db(req), `soporte_chat_${req.params.device}`, (d) => {
      d.bot_activo = activo;
      d.bot_por = `usr_${req.user.uid}`;
    }, req.params.device, dev.estab_slug);
    res.json({ ok: true, device_id: req.params.device, bot_activo: activo });
  } catch (e) {
    console.error("[soporte/chat/bot]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/soporte/chat/:device (JWT) — ver la conversación completa
router.get("/chat/:device", soloPersonas, async (req, res) => {
  try {
    const dev = await db(req).get(`device_${req.params.device}`).catch(() => null);
    if (!dev) return res.status(404).json({ error: "Equipo no encontrado" });
    const orgs = orgsDelUsuario(req);
    if (orgs && !orgs.has(dev.estab_slug)) return res.status(403).json({ error: "Sin acceso a ese equipo" });
    const doc = await db(req).get(`soporte_chat_${req.params.device}`).catch(() => null);
    res.json({
      device_id: req.params.device,
      bot_activo: !!(doc && doc.bot_activo),
      mensajes: doc ? (doc.mensajes || []) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
