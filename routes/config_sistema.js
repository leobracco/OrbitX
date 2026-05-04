// routes/config_sistema.js — Configuración global del sistema (solo superadmin).
// Lee/escribe llaves persistidas en CouchDB (services/config_sistema).
"use strict";

const router = require("express").Router();
const cfg    = require("../services/config_sistema");
const notify = require("../lib/notify-admin");
const wa     = require("../lib/whatsapp");
const smtp   = require("../lib/smtp");
const { soloSuperadmin } = require("../middleware/auth");

router.use(soloSuperadmin);

// GET /api/config-sistema — lista de llaves con secrets enmascarados.
router.get("/", async (req, res) => {
  try {
    const data = await cfg.getAllMasked();
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/config-sistema — guarda múltiples llaves: { values: {KEY: "val", ...} }
router.put("/", async (req, res) => {
  try {
    const values = req.body?.values || {};
    if (typeof values !== "object" || Array.isArray(values))
      return res.status(400).json({ error: "Body inválido (values debe ser objeto)" });

    const byUid = req.user?.uid ? `usr_${req.user.uid}` : "system";
    const guardadas = [];
    for (const [k, v] of Object.entries(values)) {
      // Si el value viene como el placeholder enmascarado (••••), no lo pisamos.
      if (typeof v === "string" && v.startsWith("•")) continue;
      await cfg.set(k, v ?? "", byUid);
      guardadas.push(k);
    }
    res.json({ ok: true, guardadas });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/config-sistema/test/telegram — manda un mensaje de prueba al chat configurado.
router.post("/test/telegram", async (req, res) => {
  try {
    const txt = "🌱 *Agro Parallel* — Mensaje de prueba desde *OrbitX*\\.\n\nSi te llegó este mensaje, Telegram está bien configurado\\.";
    const r = await notify.sendTelegram(txt);
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
    res.json({ ok: true, message_id: r.message_id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/config-sistema/test/smtp — manda un mail de prueba a {to} (default: el del admin que pidió).
router.post("/test/smtp", async (req, res) => {
  try {
    const to = req.body?.to;
    if (!to) return res.status(400).json({ error: "Pasá un email destino" });

    const r = await smtp.sendMail({
      to,
      subject: "OrbitX · Prueba de SMTP — Agro Parallel",
      text:    "Si recibiste este mail, el SMTP global está bien configurado.",
      html:    `<p>Si recibiste este mail, el <b>SMTP global</b> está bien configurado.</p>
                <p style="color:#9AA3AD;font-size:12px">Agro Parallel · OrbitX</p>`,
    });
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/config-sistema/test/copernicus — OAuth + Process API con un polígono dummy.
// Process API NO requiere configurar layers en el Sentinel Hub Dashboard:
// el evalscript va inline en el body. Por eso ya no probamos WMS.
router.post("/test/copernicus", async (req, res) => {
  try {
    const client_id     = await cfg.get("COPERNICUS_CLIENT_ID");
    const client_secret = await cfg.get("COPERNICUS_CLIENT_SECRET");
    if (!client_id || !client_secret)
      return res.status(400).json({ ok: false, error: "Faltan client_id o client_secret" });

    // 1) OAuth
    const oauth = await fetch(
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
      {
        method:  "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body:    new URLSearchParams({ grant_type: "client_credentials", client_id, client_secret }),
      }
    );
    if (!oauth.ok) {
      const txt = await oauth.text().catch(() => "");
      return res.status(400).json({ ok: false, paso: "oauth", error: `OAuth ${oauth.status}: ${txt.slice(0, 200)}` });
    }
    const { access_token, expires_in } = await oauth.json();

    // 2) Process API — pedir un cuadrado chico cerca de Córdoba (ARG) con NDVI inline.
    const today = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const dummyPolygon = {
      type: "Polygon",
      coordinates: [[
        [-64.18, -31.42],
        [-64.17, -31.42],
        [-64.17, -31.41],
        [-64.18, -31.41],
        [-64.18, -31.42],
      ]],
    };
    const evalscript = `//VERSION=3
function setup() { return { input: ["B04","B08","dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) {
  const ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  return [ndvi, ndvi, ndvi, s.dataMask];
}`;

    const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type":  "application/json",
        "Accept":        "image/png",
      },
      body: JSON.stringify({
        input: {
          bounds: {
            geometry: dummyPolygon,
            properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
          },
          data: [{
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange:        { from: `${desde}T00:00:00Z`, to: `${today}T23:59:59Z` },
              mosaickingOrder:  "leastCC",
              maxCloudCoverage: 30,
            },
          }],
        },
        output:    { width: 256, height: 256, responses: [{ identifier: "default", format: { type: "image/png" } }] },
        evalscript,
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(400).json({
        ok:           false,
        paso:         "process_api",
        process_status: r.status,
        process_error: txt.slice(0, 400),
        expires_in,
      });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.json({
      ok:            true,
      paso:          "fin",
      expires_in,
      tamano_bytes:  buf.length,
      tip:           "Todo OK — Copernicus Process API funciona. No hace falta tocar el dashboard.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/config-sistema/test/whatsapp — manda un text de prueba al número {to}.
router.post("/test/whatsapp", async (req, res) => {
  try {
    const to = req.body?.to;
    if (!to) return res.status(400).json({ error: "Pasá un número destino (E.164 sin signos)" });

    const r = await wa.sendText({
      to,
      body: "🌱 Agro Parallel — Prueba desde OrbitX. Si lo recibiste, WhatsApp está OK.",
    });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
