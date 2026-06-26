// ============================================================================
// routes/camaras.js - Backend de cámaras remotas vía MediaMTX
//
// Roles:
//  1. AOG/tractor publica el stream RTSP de cada cámara Hikvision al server
//     (MediaMTX corre en el mismo droplet). MediaMTX delega la auth a OrbitX
//     vía webhook → validamos contra el device_<id> en CouchDB.
//
//  2. El panel web (y futuras apps TV/móvil) piden la URL de playback HLS.
//     Generamos una URL firmada con HMAC + expiración corta. MediaMTX la
//     valida también por webhook.
//
//  3. AOG registra la lista de cámaras de ese tractor (nombre, canal) en el
//     device doc — para que el panel sepa qué mostrar antes de que el stream
//     arranque.
//
// Endpoints:
//   POST /api/camaras/auth          → webhook MediaMTX (publish/read)       [interno]
//   POST /api/camaras/registrar     → AOG registra sus cámaras              [device auth]
//   GET  /api/camaras/list/:devId   → listar cámaras de un tractor          [JWT]
//   GET  /api/camaras/playback/:devId/:cam → URL HLS firmada                [JWT]
//
// ENV:
//   CAMARAS_PUBLIC_HOST     hostname público del MediaMTX (ej cam.agroparallel.com)
//   CAMARAS_HLS_PORT        puerto HLS (default 8888)
//   CAMARAS_HLS_SCHEME      http|https (default https)
//   CAMARAS_SIGN_SECRET     secreto HMAC para firmar URLs de playback
//   MEDIAMTX_WEBHOOK_SECRET secreto que MediaMTX manda en X-Webhook-Secret
// ============================================================================

const router = require("express").Router();
const crypto = require("crypto");
const { spawn } = require("child_process");
const auth = require("../middleware/auth");
const { deviceAuth } = require("./devices");

const PUBLIC_HOST  = process.env.CAMARAS_PUBLIC_HOST  || "";
const HLS_PORT     = process.env.CAMARAS_HLS_PORT     || "8888";
const HLS_SCHEME   = process.env.CAMARAS_HLS_SCHEME   || "https";
const SIGN_SECRET  = process.env.CAMARAS_SIGN_SECRET  || "change-me-camaras-secret";
const HOOK_SECRET  = process.env.MEDIAMTX_WEBHOOK_SECRET || "";

const PLAYBACK_TTL_MS = 60 * 60 * 1000; // 1 hora

// ─────────────────────────────────────────────────────────
// HMAC sign / verify
// ─────────────────────────────────────────────────────────
function sign(path, expiresAt) {
  const data = `${path}|${expiresAt}`;
  return crypto.createHmac("sha256", SIGN_SECRET).update(data).digest("hex").slice(0, 32);
}
function verifySign(path, expiresAt, sig) {
  if (!path || !expiresAt || !sig) return false;
  if (Date.now() > Number(expiresAt)) return false;
  const expected = sign(path, expiresAt);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

function pathFor(deviceId, camIndex) {
  // Path en MediaMTX: <deviceId>_cam<N> (flat — más simple, sin slashes)
  return `${deviceId}_cam${camIndex}`;
}

// ─────────────────────────────────────────────────────────
// Webhook MediaMTX — publish y read
// ─────────────────────────────────────────────────────────
// MediaMTX manda (en authHTTPAddress mode):
//   { ip, user, password, action: "publish"|"read", path, protocol, query }
// Devolvemos 200 si OK, 401 si no.
// ─────────────────────────────────────────────────────────
router.post("/api/camaras/auth", express_json(), async (req, res) => {
  const deny = (status, motivo) => {
    console.warn(`[camaras/auth] ${status}: ${motivo}`, JSON.stringify(req.body || {}));
    return res.status(status).json({ error: motivo });
  };
  try {
    // Validar shared-secret entre MediaMTX y OrbitX.
    // Excepción: si el webhook viene de loopback (127.0.0.1 / ::1) confiamos
    // — solo procesos del mismo droplet pueden alcanzar :5005. Esto es
    // necesario porque MediaMTX v1.13.x no expande `${ENV}` en URLs y por lo
    // tanto no puede enviarnos el secreto vía query param.
    if (HOOK_SECRET) {
      // Usamos socket.remoteAddress (no req.ip) para no ser engañados por
      // X-Forwarded-For si OrbitX está detrás de un proxy.
      const remote = (req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
      const isLoopback = remote === "127.0.0.1" || remote === "::1";
      if (!isLoopback) {
        const got = req.headers["x-webhook-secret"] || req.query?.webhook_secret || "";
        if (got !== HOOK_SECRET) return deny(401, "webhook secret inválido (remoto " + remote + ")");
      }
    }

    const { user, password, action, path, query } = req.body || {};
    if (!action || !path) return deny(400, "faltan campos");

    // Path esperado: <deviceId>_cam<N>
    const m = String(path).match(/^([^/]+?)_cam(\d+)$/);
    if (!m) return deny(401, "path inválido: " + path);
    const deviceId = m[1];

    if (action === "publish") {
      // Tractor pushea — auth con basic-auth (user=deviceId, pass=token)
      if (!user || !password) return deny(401, "credenciales requeridas");
      if (user !== deviceId)  return deny(401, `user(${user})≠deviceId(${deviceId})`);

      const globalDB = req.app.locals.globalDB;
      const doc = await globalDB.get(`device_${deviceId}`).catch(() => null);
      if (!doc)              return deny(401, "device no registrado: " + deviceId);
      if (doc.bloqueado)     return deny(403, "device bloqueado");
      if (doc.token !== password) return deny(401, "token inválido");

      // Defensa en profundidad: el path trae el idx de la cam. Si el
      // device intenta empujar para una cam que no figura registrada
      // como Hikvision (o está inactiva), no la dejamos siquiera ocupar
      // el path en MediaMTX. Excepción: device de TEST (OX-TEST-STREAM)
      // que no usa registro normal de cámaras.
      if (!doc.is_test && deviceId !== TEST_DEVICE_ID) {
        const camIdx = parseInt(m[2], 10);
        const cam = Array.isArray(doc.camaras)
          ? doc.camaras.find(c => Number(c.idx) === camIdx)
          : null;
        if (!cam) return deny(404, `cam idx ${camIdx} no registrada para ${deviceId}`);
        if (cam.marca && cam.marca !== "hikvision")
          return deny(403, `cam ${camIdx} marca '${cam.marca}' no soportada`);
        if (cam.activa === false)
          return deny(403, `cam ${camIdx} inactiva (${cam.motivo_inactiva || "?"})`);
      }

      console.log(`[camaras/auth] publish OK ${deviceId} cam${m[2]}`);
      return res.json({ ok: true, role: "publish", deviceId });
    }

    if (action === "read") {
      // Browser/TV/celular consume — auth con URL firmada por OrbitX
      const q = parseQS(query || "");
      const expiresAt = q.exp;
      const sig       = q.sig;
      if (!verifySign(path, expiresAt, sig))
        return deny(401, "firma inválida o expirada");

      console.log(`[camaras/auth] read OK ${path}`);
      return res.json({ ok: true, role: "read" });
    }

    return deny(400, "action desconocida: " + action);
  } catch (e) {
    console.error("[camaras/auth]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// Solo aceptamos Hikvision. AOG hace probe ISAPI
// (GET /ISAPI/System/deviceInfo) y manda la metadata que devolvió la
// cámara. Acá normalizamos `marca` y rechazamos (marcamos inactiva,
// NO borramos) todo lo que no sea Hikvision — el panel las muestra en
// gris con `motivo_inactiva` para que el operario entienda por qué.
// El stream real se publica vía MediaMTX (RTSP push) — esto es metadata.
//
// Body esperado:
//   { camaras: [{ idx, nombre, marca, modelo, firmware, serial,
//                 canales: [{ id, nombre, rtsp_path }],
//                 activa, online }] }
// OJO: NO guardamos usuario/clave Hikvision en cloud — quedan en AOG.
// ─────────────────────────────────────────────────────────
const HIK_BRAND_RE = /^\s*(hik\s*vision|hikvision|hik)\s*$/i;

function normalizarCamara(c, i) {
  const marcaRaw = String(c.marca || c.brand || "").trim();
  const esHik = HIK_BRAND_RE.test(marcaRaw);
  const canalesIn = Array.isArray(c.canales) ? c.canales : [];
  const canales = canalesIn.slice(0, 8).map((ch, j) => ({
    id:        Number(ch.id ?? j + 1),
    nombre:    String(ch.nombre || `Canal ${j + 1}`).slice(0, 40),
    rtsp_path: String(ch.rtsp_path || "").slice(0, 200), // ej: /ISAPI/Streaming/channels/101
  }));

  const out = {
    idx:      Number(c.idx ?? i + 1),
    nombre:   String(c.nombre || `Cámara ${i + 1}`).slice(0, 60),
    marca:    esHik ? "hikvision" : (marcaRaw.toLowerCase().slice(0, 32) || "desconocida"),
    modelo:   String(c.modelo || "").slice(0, 64),
    firmware: String(c.firmware || "").slice(0, 32),
    serial:   String(c.serial   || "").slice(0, 64),
    canales,
    online:   !!c.online,
    activa:   esHik ? !!c.activa : false,
    motivo_inactiva: esHik
      ? (c.activa ? null : (String(c.motivo_inactiva || "deshabilitada_por_usuario").slice(0, 40)))
      : "marca_no_soportada",
  };
  return out;
}

router.post("/api/camaras/registrar", deviceAuth, express_json(), async (req, res) => {
  try {
    const camaras = Array.isArray(req.body?.camaras) ? req.body.camaras : null;
    if (!camaras) return res.status(400).json({ error: "se espera { camaras: [...] }" });
    if (camaras.length > 32) return res.status(400).json({ error: "máximo 32 cámaras por device" });

    const limpio = camaras.map(normalizarCamara);
    const rechazadas = limpio.filter(c => c.motivo_inactiva === "marca_no_soportada");

    const globalDB = req.app.locals.globalDB;
    // Retry 409 — el device puede tener heartbeat concurrente actualizando el doc.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await globalDB.get(`device_${req.deviceId}`);
        doc.camaras = limpio;
        doc.camaras_updated_at = Date.now();
        await globalDB.insert(doc);
        break;
      } catch (e) {
        if ((e.statusCode === 409 || e.error === "conflict") && attempt < 2) continue;
        throw e;
      }
    }

    if (rechazadas.length) {
      console.warn(`[camaras/registrar] ${req.deviceId}: ${rechazadas.length} cámara(s) rechazada(s) por marca no Hikvision`);
    }

    res.json({
      ok: true,
      n: limpio.length,
      hik: limpio.length - rechazadas.length,
      rechazadas: rechazadas.length,
      rechazadas_detalle: rechazadas.map(c => ({ idx: c.idx, nombre: c.nombre, marca: c.marca })),
    });
  } catch (e) {
    console.error("[camaras/registrar]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// Listar cámaras de un tractor (panel)
// ─────────────────────────────────────────────────────────
router.get("/api/camaras/list/:deviceId", auth.required, async (req, res) => {
  try {
    const globalDB = req.app.locals.globalDB;
    const doc = await globalDB.get(`device_${req.params.deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error: "device no encontrado" });

    // Filtro multi-org: si el user no es SA, debe pertenecer al estab del device
    const u = req.user || {};
    const esSA = u.rol_global === "superadmin";
    const miSlug = u.estabSlug || u.estab_slug;
    if (!esSA && doc.estab_slug && doc.estab_slug !== miSlug)
      return res.status(403).json({ error: "no autorizado" });

    res.json({
      ok: true,
      device: { id: doc.device_id, nombre: doc.nombre, online: doc.online === true },
      camaras: doc.camaras || [],
      camaras_updated_at: doc.camaras_updated_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// Playback URL firmada (panel pide; browser/TV/celular consume)
// ─────────────────────────────────────────────────────────
router.get("/api/camaras/playback/:deviceId/:cam", auth.required, async (req, res) => {
  try {
    if (!PUBLIC_HOST) return res.status(500).json({ error: "CAMARAS_PUBLIC_HOST no configurado" });

    const deviceId = req.params.deviceId;
    const camIdx   = parseInt(req.params.cam, 10);
    // `!camIdx` rechazaba también idx 0 (cam válida con idx 0-based). Solo
    // rechazamos no-numérico o negativo.
    if (Number.isNaN(camIdx) || camIdx < 0) return res.status(400).json({ error: "cam idx inválido" });

    // Verificar permisos sobre el device
    const globalDB = req.app.locals.globalDB;
    const doc = await globalDB.get(`device_${deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error: "device no encontrado" });

    const u = req.user || {};
    const esSA = u.rol_global === "superadmin";
    const miSlug = u.estabSlug || u.estab_slug;
    if (!esSA && doc.estab_slug && doc.estab_slug !== miSlug)
      return res.status(403).json({ error: "no autorizado" });

    // Solo Hikvision. Si la cam no figura, no es marca soportada, o quedó
    // inactiva por config del usuario, no entregamos URL firmada — sin
    // esto, una cam genérica podría seguir tirando stream por MediaMTX
    // aunque la app la pinte en gris.
    const cam = Array.isArray(doc.camaras)
      ? doc.camaras.find(c => Number(c.idx) === camIdx)
      : null;
    if (!cam) return res.status(404).json({ error: "cámara no registrada" });
    if (cam.marca && cam.marca !== "hikvision") {
      return res.status(403).json({ error: "marca no soportada", marca: cam.marca, motivo: cam.motivo_inactiva || "marca_no_soportada" });
    }
    if (cam.activa === false) {
      return res.status(403).json({ error: "cámara inactiva", motivo: cam.motivo_inactiva || "deshabilitada_por_usuario" });
    }

    const path = pathFor(deviceId, camIdx);
    const expiresAt = Date.now() + PLAYBACK_TTL_MS;
    const sig = sign(path, expiresAt);

    const portPart = (HLS_SCHEME === "https" && HLS_PORT === "443") ||
                     (HLS_SCHEME === "http"  && HLS_PORT === "80")
                       ? "" : `:${HLS_PORT}`;
    const baseUrl = `${HLS_SCHEME}://${PUBLIC_HOST}${portPart}`;

    res.json({
      ok: true,
      hls: `${baseUrl}/${path}/index.m3u8?exp=${expiresAt}&sig=${sig}`,
      // RTSP directo (apps móviles tipo VLC) — usa el mismo hash
      rtsp: `rtsp://${PUBLIC_HOST}:8554/${path}?exp=${expiresAt}&sig=${sig}`,
      expiresAt,
      ttl_ms: PLAYBACK_TTL_MS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// TEST STREAM — para probar el pipeline desde el panel sin tractor.
// Crea un device de prueba (si no existe), lanza ffmpeg en el server con
// testsrc, y queda visible como cualquier otra cámara. Solo superadmin.
//
// Endpoints:
//   POST /api/camaras/test/start   → arranca ffmpeg + asegura device doc
//   POST /api/camaras/test/stop    → mata ffmpeg
//   GET  /api/camaras/test/status  → estado del proceso
// ─────────────────────────────────────────────────────────
const TEST_DEVICE_ID = "OX-TEST-STREAM";
const TEST_CAM_IDX   = 1;
const TEST_AUTOSTOP_MS = 30 * 60 * 1000; // 30 min de runtime máximo
let _testProc = null;
let _testStartedAt = 0;
let _testAutoStop = null;

function killTest() {
  if (_testProc) {
    try { _testProc.kill("SIGTERM"); } catch {}
    _testProc = null;
  }
  if (_testAutoStop) { clearTimeout(_testAutoStop); _testAutoStop = null; }
}

router.post("/api/camaras/test/start", auth.required, express_json(), async (req, res) => {
  try {
    const u = req.user || {};
    if (u.rol_global !== "superadmin") return res.status(403).json({ error: "solo superadmin" });

    const globalDB = req.app.locals.globalDB;

    // Asegurar device doc de prueba
    let doc = await globalDB.get(`device_${TEST_DEVICE_ID}`).catch(() => null);
    let token;
    if (!doc) {
      token = crypto.randomBytes(24).toString("hex");
      doc = {
        _id: `device_${TEST_DEVICE_ID}`,
        tipo: "device",
        device_id: TEST_DEVICE_ID,
        nombre: "🧪 Test Stream (servidor)",
        token,
        is_test: true,
        ultimo_visto: Date.now(),
        camaras: [{ idx: 1, nombre: "Test cam", activa: true, online: true }],
        camaras_updated_at: Date.now(),
      };
      await globalDB.insert(doc);
    } else {
      token = doc.token;
      doc.ultimo_visto = Date.now();
      doc.camaras = [{ idx: 1, nombre: "Test cam", activa: true, online: true }];
      doc.camaras_updated_at = Date.now();
      await globalDB.insert(doc);
    }

    killTest();

    const path = pathFor(TEST_DEVICE_ID, TEST_CAM_IDX);
    const url  = `rtsp://${TEST_DEVICE_ID}:${token}@127.0.0.1:8554/${path}`;

    _testProc = spawn("ffmpeg", [
      "-re",
      "-f", "lavfi",
      "-i", "testsrc=size=640x480:rate=15",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-g", "30",
      "-rtsp_transport", "tcp",
      "-f", "rtsp",
      url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    _testStartedAt = Date.now();
    _testProc.stderr.on("data", chunk => {
      const txt = chunk.toString().trim();
      if (txt) console.log("[camaras/test/ffmpeg] " + txt.replace(/\n+/g, " | "));
    });
    _testProc.on("exit", code => {
      console.log(`[camaras/test/ffmpeg] exit code=${code}`);
      _testProc = null;
    });
    _testAutoStop = setTimeout(killTest, TEST_AUTOSTOP_MS);

    res.json({
      ok: true,
      deviceId: TEST_DEVICE_ID,
      cam: TEST_CAM_IDX,
      msg: "Test stream lanzado. Aparece en ~5s.",
    });
  } catch (e) {
    console.error("[camaras/test/start]", e);
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/camaras/test/stop", auth.required, async (req, res) => {
  const u = req.user || {};
  if (u.rol_global !== "superadmin") return res.status(403).json({ error: "solo superadmin" });
  killTest();
  res.json({ ok: true });
});

router.get("/api/camaras/test/status", auth.required, (req, res) => {
  res.json({
    running: !!_testProc,
    startedAt: _testStartedAt,
    deviceId: TEST_DEVICE_ID,
  });
});

// Limpiar al apagar el server
process.on("SIGTERM", killTest);
process.on("SIGINT", killTest);

// ─────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────
function express_json() {
  // body parser local (algunas rutas usan auth.required que ya parsea, pero
  // /api/camaras/auth viene de MediaMTX y necesitamos json-parse acá).
  return require("express").json({ limit: "256kb" });
}

function parseQS(q) {
  const out = {};
  for (const part of String(q).split("&")) {
    if (!part) continue;
    const [k, v] = part.split("=");
    out[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return out;
}

module.exports = router;
