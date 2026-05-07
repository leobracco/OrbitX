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
  try {
    // (Opcional) validar shared-secret entre MediaMTX y OrbitX
    if (HOOK_SECRET && req.headers["x-webhook-secret"] !== HOOK_SECRET) {
      return res.status(401).json({ error: "webhook secret inválido" });
    }

    const { user, password, action, path, query } = req.body || {};
    if (!action || !path) return res.status(400).json({ error: "faltan campos" });

    // Path esperado: <deviceId>_cam<N>
    const m = String(path).match(/^([^/]+?)_cam(\d+)$/);
    if (!m) return res.status(401).json({ error: "path inválido" });
    const deviceId = m[1];

    if (action === "publish") {
      // Tractor pushea — auth con basic-auth (user=deviceId, pass=token)
      if (!user || !password) return res.status(401).json({ error: "credenciales requeridas" });
      if (user !== deviceId)  return res.status(401).json({ error: "user≠deviceId" });

      const globalDB = req.app.locals.globalDB;
      const doc = await globalDB.get(`device_${deviceId}`).catch(() => null);
      if (!doc)              return res.status(401).json({ error: "device no registrado" });
      if (doc.bloqueado)     return res.status(403).json({ error: "device bloqueado" });
      if (doc.token !== password) return res.status(401).json({ error: "token inválido" });

      return res.json({ ok: true, role: "publish", deviceId });
    }

    if (action === "read") {
      // Browser/TV/celular consume — auth con URL firmada por OrbitX
      const q = parseQS(query || "");
      const expiresAt = q.exp;
      const sig       = q.sig;
      if (!verifySign(path, expiresAt, sig))
        return res.status(401).json({ error: "firma inválida o expirada" });

      return res.json({ ok: true, role: "read" });
    }

    return res.status(400).json({ error: "action desconocida" });
  } catch (e) {
    console.error("[camaras/auth]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────
// AOG/tractor registra sus cámaras: lista de {nombre, ip_lan, canal}
// Lo guardamos en el device doc para que el panel sepa qué hay disponible.
// El stream real se publica vía MediaMTX (RTSP push) — esto es solo metadata.
// ─────────────────────────────────────────────────────────
router.post("/api/camaras/registrar", deviceAuth, express_json(), async (req, res) => {
  try {
    const camaras = Array.isArray(req.body?.camaras) ? req.body.camaras : null;
    if (!camaras) return res.status(400).json({ error: "se espera { camaras: [...] }" });

    const limpio = camaras.map((c, i) => ({
      idx:    Number(c.idx ?? i + 1),
      nombre: String(c.nombre || `Cámara ${i + 1}`).slice(0, 60),
      activa: !!c.activa,
      online: !!c.online, // estado de stream actual
      // OJO: NO guardamos usuario/clave Hikvision en cloud — quedan en el tractor
    }));

    const globalDB = req.app.locals.globalDB;
    const doc = await globalDB.get(`device_${req.deviceId}`);
    doc.camaras = limpio;
    doc.camaras_updated_at = Date.now();
    await globalDB.insert(doc);
    res.json({ ok: true, n: limpio.length });
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
    const u = req.jwtUser || {};
    const esSA = u.rol === "superadmin";
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
    if (!camIdx) return res.status(400).json({ error: "cam idx inválido" });

    // Verificar permisos sobre el device
    const globalDB = req.app.locals.globalDB;
    const doc = await globalDB.get(`device_${deviceId}`).catch(() => null);
    if (!doc) return res.status(404).json({ error: "device no encontrado" });

    const u = req.jwtUser || {};
    const esSA = u.rol === "superadmin";
    const miSlug = u.estabSlug || u.estab_slug;
    if (!esSA && doc.estab_slug && doc.estab_slug !== miSlug)
      return res.status(403).json({ error: "no autorizado" });

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
