// routes/ndvi.js
// Proxy de tiles NDVI desde Copernicus Data Space (Sentinel Hub WMS).
// Las credenciales son GLOBALES de Agro Parallel (configuradas en /config).
// El token OAuth2 se cachea en memoria por su tiempo de vida.

const router  = require("express").Router();
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");
const cfg     = require("../services/config_sistema");
const indices = require("../lib/indices_satelitales");

// Cache global de token (todas las orgs comparten el mismo).
let tokenCache = { token: null, expiresAt: 0 };

// Cache en disco de imágenes NDVI por (geometría + fecha).
// Cada imagen pesa ~50-200 KB y se reusa mucho — lo persistimos.
const NDVI_CACHE_DIR = path.resolve(__dirname, "..", ".cache", "ndvi");
function ensureCacheDir() { if (!fs.existsSync(NDVI_CACHE_DIR)) fs.mkdirSync(NDVI_CACHE_DIR, { recursive: true }); }
function cacheKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// Evalscript NDVI estándar (sale a vivir inline en el request — no depende del dashboard).
const EVALSCRIPT_NDVI = `//VERSION=3
function setup() {
  return { input: [{ bands: ["B04", "B08", "dataMask"] }], output: { bands: 4 } };
}
function evaluatePixel(s) {
  const ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  if (ndvi < 0.0)  return [0.05, 0.05, 0.05, s.dataMask];
  if (ndvi < 0.2)  return [0.75, 0.75, 0.00, s.dataMask];
  if (ndvi < 0.4)  return [0.60, 0.85, 0.20, s.dataMask];
  if (ndvi < 0.6)  return [0.30, 0.70, 0.20, s.dataMask];
  return                 [0.05, 0.45, 0.05, s.dataMask];
}`;

async function getCopernicusToken() {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 30_000)
    return tokenCache.token;

  const client_id     = await cfg.get("COPERNICUS_CLIENT_ID");
  const client_secret = await cfg.get("COPERNICUS_CLIENT_SECRET");

  if (!client_id || !client_secret) {
    throw Object.assign(
      new Error("Copernicus sin configurar — pedile a Agro Parallel que cargue las credenciales"),
      { status: 402 }
    );
  }

  const r = await fetch(
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
    {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        grant_type:    "client_credentials",
        client_id,
        client_secret,
      }),
    }
  );

  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw Object.assign(
      new Error(`Copernicus OAuth ${r.status}: ${err.slice(0, 200)}`),
      { status: 502 }
    );
  }

  const data = await r.json();
  tokenCache = {
    token:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

// Invalidar cache cuando se cambian credenciales (lo llama config_sistema vía evento futuro;
// por ahora se invalida solo cuando el token expira).
function invalidarToken() { tokenCache = { token: null, expiresAt: 0 }; }

// ── Conversión tile XYZ → BBOX EPSG:3857 ─────────────────
function tileToBbox(z, x, y) {
  z = parseInt(z); x = parseInt(x); y = parseInt(y);
  const R  = 6378137;
  const n  = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  const n1 = Math.PI - 2 * Math.PI * (y + 1) / Math.pow(2, z);
  const west  = x       / Math.pow(2, z) * 360 - 180;
  const east  = (x + 1) / Math.pow(2, z) * 360 - 180;
  const lonToM = lon => lon * R * Math.PI / 180;
  const latToM = nn  => Math.log(Math.tan(Math.PI / 4 + Math.atan(Math.sinh(nn)) / 2)) * R;
  return `${lonToM(west)},${latToM(n1)},${lonToM(east)},${latToM(n)}`;
}

// ══════════════════════════════════════════════════════════
//  GET /api/ndvi/tile/:z/:x/:y
// ══════════════════════════════════════════════════════════
router.get("/tile/:z/:x/:y", async (req, res) => {
  try {
    const { z, x, y } = req.params;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const instance_id = await cfg.get("COPERNICUS_INSTANCE_ID");
    if (!instance_id)
      return res.status(402).json({ error: "Copernicus sin configurar" });

    const token = await getCopernicusToken();

    const bbox   = tileToBbox(z, x, y);
    const wmsUrl = [
      `https://sh.dataspace.copernicus.eu/ogc/wms/${instance_id}`,
      `?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0`,
      `&LAYERS=NDVI`,
      `&STYLES=`,
      `&CRS=EPSG:3857`,
      `&WIDTH=256&HEIGHT=256`,
      `&FORMAT=image/png`,
      `&TRANSPARENT=true`,
      `&BBOX=${bbox}`,
      `&TIME=${date}/${date}`,
    ].join("");

    const tileResp = await fetch(wmsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!tileResp.ok) {
      const body = await tileResp.text().catch(() => "");
      console.error("[ndvi/tile] Sentinel Hub error:", tileResp.status, "→", body.slice(0, 600).replace(/\s+/g, " "));
      console.error("[ndvi/tile] URL:", wmsUrl);
      return res.status(tileResp.status).json({
        error:  "Sentinel Hub rechazó el tile",
        status: tileResp.status,
        detalle: body.slice(0, 400),
      });
    }

    const buffer = await tileResp.arrayBuffer();
    res.set("Content-Type",  "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error("[ndvi/tile]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/ndvi/fechas-disponibles?bbox=...
// ══════════════════════════════════════════════════════════
router.get("/fechas-disponibles", async (req, res) => {
  try {
    const { bbox, dias = 90 } = req.query;
    if (!bbox) return res.status(400).json({ error: "Hace falta el bbox" });

    const token  = await getCopernicusToken();
    const desde  = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const hasta  = new Date().toISOString().slice(0, 10);
    const [minLng, minLat, maxLng, maxLat] = bbox.split(",");

    const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body:    JSON.stringify({
        collections: ["sentinel-2-l2a"],
        datetime:    `${desde}T00:00:00Z/${hasta}T23:59:59Z`,
        bbox:        [parseFloat(minLng), parseFloat(minLat), parseFloat(maxLng), parseFloat(maxLat)],
        limit:       50,
        fields: { include: ["properties.datetime", "properties.eo:cloud_cover"] }
      }),
    });

    if (!r.ok) return res.status(r.status).json({ error: "Error catalog Copernicus" });

    const data   = await r.json();
    const fechas = (data.features || [])
      .map(f => ({
        fecha:       f.properties.datetime?.slice(0, 10),
        cloud_cover: Math.round(f.properties["eo:cloud_cover"] || 0),
      }))
      .filter(f => f.fecha)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));

    res.json({ fechas });
  } catch (e) {
    console.error("[ndvi/fechas]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  Sentinel Hub Process API — pide UNA imagen recortada al polígono.
//  Mucho más eficiente que WMS tile-by-tile y NO requiere configurar
//  un layer en el dashboard (el evalscript va inline en el body).
// ══════════════════════════════════════════════════════════
async function processAPI({ geometry, desde, hasta, width, height, evalscript, maxCloudCoverage }) {
  const token = await getCopernicusToken();

  const body = {
    input: {
      bounds: {
        geometry,
        properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
      },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          timeRange:        { from: `${desde}T00:00:00Z`, to: `${hasta}T23:59:59Z` },
          mosaickingOrder:  "leastCC",
          maxCloudCoverage: maxCloudCoverage ?? 30,
        },
      }],
    },
    output: {
      width:  width  || 1024,
      height: height || 1024,
      responses: [{ identifier: "default", format: { type: "image/png" } }],
    },
    evalscript: evalscript || EVALSCRIPT_NDVI,
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/process", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "image/png",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw Object.assign(new Error(`Process API ${r.status}: ${txt.slice(0, 300)}`), { status: r.status });
  }
  return Buffer.from(await r.arrayBuffer());
}

// ══════════════════════════════════════════════════════════
//  POST /api/ndvi/lote
//  Body: {
//    geometry: <GeoJSON Polygon en lon/lat>,
//    date: "YYYY-MM-DD" (opcional; si no, usa últimos 30 días con leastCC),
//    width: 1024, height: 1024 (opcional)
//  }
//  Devuelve: image/png recortada al polígono.
// ══════════════════════════════════════════════════════════
router.post("/lote", async (req, res) => {
  try {
    const { geometry, date, width, height, indice, evalscript, maxCloudCoverage } = req.body || {};
    if (!geometry || !geometry.type)
      return res.status(400).json({ error: "Pasá geometry con un GeoJSON válido" });

    // Resolver evalscript: el del índice elegido > el inline custom > NDVI por default.
    const claveIdx  = (indice || "ndvi").toLowerCase();
    const finalEval = evalscript || (() => {
      try { return indices.getEvalscript(claveIdx); }
      catch { return EVALSCRIPT_NDVI; }
    })();

    const hasta = date || new Date().toISOString().slice(0, 10);
    const desde = date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const key = cacheKey({ geometry, desde, hasta, width, height, indice: claveIdx, evalCustom: !!evalscript });
    ensureCacheDir();
    const cachePath = path.join(NDVI_CACHE_DIR, `${key}.png`);

    if (fs.existsSync(cachePath)) {
      res.set("Content-Type",  "image/png");
      res.set("Cache-Control", "public, max-age=86400");
      res.set("X-Cache",       "HIT");
      res.set("X-Indice",      claveIdx);
      fs.createReadStream(cachePath).pipe(res);
      return;
    }

    const png = await processAPI({
      geometry, desde, hasta,
      width:  width  || 1024,
      height: height || 1024,
      evalscript: finalEval,
      maxCloudCoverage,
    });

    fs.promises.writeFile(cachePath, png).catch(e => console.warn("[ndvi/lote] cache write:", e.message));

    res.set("Content-Type",  "image/png");
    res.set("Cache-Control", "public, max-age=86400");
    res.set("X-Cache",       "MISS");
    res.set("X-Indice",      claveIdx);
    res.send(png);
  } catch (e) {
    console.error("[ndvi/lote]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/ndvi/indices — catálogo de índices disponibles + leyenda.
router.get("/indices", (req, res) => {
  res.json({ indices: indices.catalogo() });
});

// ══════════════════════════════════════════════════════════
//  GET /api/ndvi/lote/bbox  — devuelve el bbox del polígono (helper para Leaflet imageOverlay).
//  Lo agregamos para que el frontend no tenga que recalcular.
//  Acepta el polígono por query (encoded JSON) o body POST.
// ══════════════════════════════════════════════════════════
function calcularBbox(geom) {
  const acc = { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity };
  function visitar(coords) {
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [lng, lat] = coords;
      if (lng < acc.minLng) acc.minLng = lng;
      if (lng > acc.maxLng) acc.maxLng = lng;
      if (lat < acc.minLat) acc.minLat = lat;
      if (lat > acc.maxLat) acc.maxLat = lat;
    } else if (Array.isArray(coords)) {
      coords.forEach(visitar);
    }
  }
  visitar(geom.coordinates || []);
  return acc;
}

router.post("/lote/bbox", (req, res) => {
  try {
    const { geometry } = req.body || {};
    if (!geometry?.coordinates) return res.status(400).json({ error: "geometry inválida" });
    res.json(calcularBbox(geometry));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  Sentinel Hub Statistical API — devuelve min/max/mean/stDev + histograma
//  de un índice sobre un polígono, sin descargar imagen.
// ══════════════════════════════════════════════════════════
// Asegura orientación counter-clockwise del outer ring (GeoJSON spec).
// Sentinel Hub algunas veces rechaza polígonos clockwise.
function asegurarCCW(geom) {
  if (geom?.type !== "Polygon" || !Array.isArray(geom.coordinates?.[0])) return geom;
  const ring = geom.coordinates[0];
  // Shoelace: si > 0 es clockwise (en proyección lon/lat), invertir.
  let acc = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    acc += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
  }
  if (acc > 0) {
    return { ...geom, coordinates: [ring.slice().reverse(), ...geom.coordinates.slice(1)] };
  }
  return geom;
}

async function statsAPI({ geometry, desde, hasta, indice = "ndvi", evalscript, maxCloudCoverage }) {
  const token = await getCopernicusToken();

  geometry = asegurarCCW(geometry);

  let evalUsado = evalscript;
  if (!evalUsado) {
    try { evalUsado = indices.getEvalscriptStats(indice); }
    catch { evalUsado = indices.getEvalscriptStats("ndvi"); }
  }

  // Bucket POR DÍA: con mosaicking SIMPLE (default), SH busca una imagen por
  // bucket. Si pongo P30D y solo hay imagen el día 12, el bucket completo queda
  // vacío. Con P1D tenemos un bucket cada día: los días con imagen vienen con
  // datos. Después tomamos el más reciente con datos.
  const body = {
    input: {
      bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          maxCloudCoverage: maxCloudCoverage ?? 30,
        },
      }],
    },
    aggregation: {
      timeRange:           { from: `${desde}T00:00:00Z`, to: `${hasta}T23:59:59Z` },
      aggregationInterval: { of: "P1D" },
      // CRS84 usa grados. ~11m a 38°lat ≈ 0.0001° (resolución nativa S2).
      resx:                0.0001,
      resy:                0.0001,
      evalscript:          evalUsado,
    },
    calculations: {
      default: {
        statistics: { default: { percentiles: { k: [10, 50, 90] } } },
        // Histograms omitidos: requieren matchear sampleType (FLOAT32 vs int)
        // y para el análisis nos alcanza con mean/min/max/percentiles.
      },
    },
  };

  const r = await fetch("https://sh.dataspace.copernicus.eu/api/v1/statistics", {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw Object.assign(new Error(`Statistical API ${r.status}: ${txt.slice(0, 300)}`), { status: r.status });
  }
  const json = await r.json();

  // Log detallado SIEMPRE para diagnosticar (sacar después).
  const ok = !!(json.data && json.data.length);
  console.log(`[NDVI-DEBUG ${indice}] HTTP ${r.status} · ok=${ok} · timeRange ${desde}→${hasta} · maxCC=${maxCloudCoverage}`);
  if (!ok) {
    console.log(`[NDVI-DEBUG ${indice}] body req:`, JSON.stringify({
      geometry: { type: geometry.type, n: geometry.coordinates?.[0]?.length },
      aggregationInterval: body.aggregation.aggregationInterval,
      data: body.input.data,
      output: evalUsado.match(/output:\s*\[([\s\S]*?)\]/)?.[1]?.replace(/\s+/g, " ").slice(0, 200),
    }));
    console.log(`[NDVI-DEBUG ${indice}] resp:`, JSON.stringify(json).slice(0, 800));
  }
  return json;
}

// POST /api/ndvi/lote/stats — atajo para el frontend (y para agrarIA).
router.post("/lote/stats", async (req, res) => {
  try {
    const { geometry, indice = "ndvi", desdeDias = 30 } = req.body || {};
    if (!geometry?.coordinates) return res.status(400).json({ error: "geometry inválida" });

    const hasta = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.now() - desdeDias * 86400000).toISOString().slice(0, 10);

    const data = await statsAPI({ geometry, desde, hasta, indice });
    // Estructura SH Statistical API: data.data[i].outputs.data.bands.<clave>.stats
    const dias = (data.data || [])
      .map(d => {
        const band = d.outputs?.data?.bands?.[indice];
        if (!band?.stats) return null;
        return {
          fecha:      d.interval?.from?.slice(0, 10),
          stats:      band.stats,
          histograma: band.histogram?.bins || null,
        };
      })
      .filter(Boolean);

    res.json({ ok: true, indice, dias, ultimo: dias[dias.length - 1] || null });
  } catch (e) {
    console.error("[ndvi/lote/stats]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Exponer helpers para reuso.
module.exports = router;
module.exports.invalidarToken = invalidarToken;
module.exports.processAPI     = processAPI;
module.exports.statsAPI       = statsAPI;
module.exports.EVALSCRIPT_NDVI = EVALSCRIPT_NDVI;
