// routes/ndvi.js
// Proxy de tiles NDVI desde Copernicus Data Space (Sentinel Hub WMS).
// El token OAuth2 se obtiene con las credenciales de CADA org, se cachea
// en memoria por 10 minutos y se refresca automáticamente.
// El frontend NUNCA ve el token de Copernicus — solo llama /api/ndvi/tile/...

const router   = require('express').Router();
const { getDB } = require('../services/couchdb');
const { decrypt } = require('./integraciones');

// Cache de tokens por org: { [estabSlug]: { token, expiresAt } }
const tokenCache = new Map();

// ── Obtener (o renovar) el token OAuth2 de Copernicus ────
async function getCopernicusToken(estabSlug) {
  const cached = tokenCache.get(estabSlug);
  // Reutilizar si le quedan más de 30 segundos de vida
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  const db     = getDB('orbitx_global');
  const orgDoc = await db.get(`org_${estabSlug}`);
  const coper  = orgDoc.integraciones?.copernicus;

  if (!coper?.activo) {
    throw Object.assign(new Error('Copernicus no configurado para esta org'), { status: 402 });
  }

  const client_id     = decrypt(coper.client_id);
  const client_secret = decrypt(coper.client_secret);

  const r = await fetch(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id,
        client_secret,
      }),
    }
  );

  if (!r.ok) {
    const err = await r.text().catch(() => '');
    throw Object.assign(
      new Error(`Copernicus OAuth error ${r.status}: ${err}`),
      { status: 502 }
    );
  }

  const data = await r.json();
  tokenCache.set(estabSlug, {
    token:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

// ── Conversión tile XYZ → BBOX EPSG:3857 ─────────────────
function tileToBbox(z, x, y) {
  z = parseInt(z); x = parseInt(x); y = parseInt(y);
  const R  = 6378137;
  const n  = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  const n1 = Math.PI - 2 * Math.PI * (y + 1) / Math.pow(2, z);
  const west  = x       / Math.pow(2, z) * 360 - 180;
  const east  = (x + 1) / Math.pow(2, z) * 360 - 180;
  const lonToM = lon => lon * R * Math.PI / 180;
  const latToM = n   => Math.log(Math.tan(Math.PI / 4 + Math.atan(Math.sinh(n)) / 2)) * R;
  return `${lonToM(west)},${latToM(n1)},${lonToM(east)},${latToM(n)}`;
}

// ══════════════════════════════════════════════════════════
//  GET /api/ndvi/tile/:z/:x/:y
//  Parámetros query opcionales:
//    date     = YYYY-MM-DD  (default: hoy)
//    opacity  = 0-1         (solo informativo para el cliente)
// ══════════════════════════════════════════════════════════
router.get('/tile/:z/:x/:y', async (req, res) => {
  try {
    const { estabSlug } = req.user;
    const { z, x, y }  = req.params;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    // Leer instance_id de esta org
    const db          = getDB('orbitx_global');
    const orgDoc      = await db.get(`org_${estabSlug}`);
    const coper       = orgDoc.integraciones?.copernicus;
    if (!coper?.activo) {
      return res.status(402).json({ error: 'Copernicus no configurado' });
    }
    const instance_id = decrypt(coper.instance_id);

    // Obtener token (con caché)
    const token = await getCopernicusToken(estabSlug);

    // Armar URL WMS de Sentinel Hub
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
    ].join('');

    const tileResp = await fetch(wmsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!tileResp.ok) {
      console.error('[ndvi/tile] Sentinel Hub error:', tileResp.status);
      return res.status(tileResp.status).json({ error: 'Error al obtener tile' });
    }

    // Cache de 1 hora — los tiles NDVI no cambian en el día
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    tileResp.body.pipe(res);

  } catch (e) {
    console.error('[ndvi/tile]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  GET /api/ndvi/fechas-disponibles?bbox=minLng,minLat,maxLng,maxLat
//  Devuelve las fechas de imágenes disponibles para un lote
// ══════════════════════════════════════════════════════════
router.get('/fechas-disponibles', async (req, res) => {
  try {
    const { estabSlug } = req.user;
    const { bbox, dias = 90 } = req.query;
    if (!bbox) return res.status(400).json({ error: 'bbox requerido' });

    const token  = await getCopernicusToken(estabSlug);
    const desde  = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const hasta  = new Date().toISOString().slice(0, 10);
    const [minLng, minLat, maxLng, maxLat] = bbox.split(',');

    const catalogUrl = 'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search';
    const body = {
      collections: ['sentinel-2-l2a'],
      datetime:    `${desde}T00:00:00Z/${hasta}T23:59:59Z`,
      bbox:        [parseFloat(minLng), parseFloat(minLat), parseFloat(maxLng), parseFloat(maxLat)],
      limit:       50,
      fields: { include: ['properties.datetime', 'properties.eo:cloud_cover'] }
    };

    const r = await fetch(catalogUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!r.ok) return res.status(r.status).json({ error: 'Error catalog Copernicus' });

    const data   = await r.json();
    const fechas = (data.features || [])
      .map(f => ({
        fecha:       f.properties.datetime?.slice(0, 10),
        cloud_cover: Math.round(f.properties['eo:cloud_cover'] || 0),
      }))
      .filter(f => f.fecha)
      .sort((a, b) => b.fecha.localeCompare(a.fecha));

    res.json({ fechas });
  } catch (e) {
    console.error('[ndvi/fechas]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
