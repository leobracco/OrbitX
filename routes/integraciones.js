// routes/integraciones.js
// Gestión de credenciales de integraciones externas (Copernicus, etc.)
// Las credenciales se cifran con AES-256-CBC antes de guardarse en CouchDB.
// La ORBITX_CIPHER_KEY vive en .env del servidor — nunca viaja al cliente.

const router     = require('express').Router();
const crypto     = require('crypto');
const { getDB }  = require('../services/couchdb');

// ── Cifrado AES-256-CBC ───────────────────────────────────
const CIPHER_KEY = Buffer.from(process.env.ORBITX_CIPHER_KEY, 'hex'); // 32 bytes

function encrypt(text) {
  const iv  = crypto.randomBytes(16);
  const c   = crypto.createCipheriv('aes-256-cbc', CIPHER_KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(payload) {
  const [ivHex, encHex] = payload.split(':');
  const iv  = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const d   = crypto.createDecipheriv('aes-256-cbc', CIPHER_KEY, iv);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ── Exportar decrypt para usar en ndvi.js ────────────────
module.exports.decrypt = decrypt;

// ══════════════════════════════════════════════════════════
//  GET /api/integraciones/copernicus
//  Devuelve solo el estado — NUNCA las credenciales reales
// ══════════════════════════════════════════════════════════
router.get('/copernicus', async (req, res) => {
  try {
    const { estabSlug } = req.user;
    const db     = getDB('orbitx_global');
    const orgDoc = await db.get(`org_${estabSlug}`);
    const coper  = orgDoc.integraciones?.copernicus;

    res.json({
      configurado:      !!coper?.activo,
      configurado_at:   coper?.configurado_at  || null,
      configurado_por:  coper?.configurado_por || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  PUT /api/integraciones/copernicus
//  Guarda (o actualiza) credenciales cifradas
//  Body: { client_id, client_secret, instance_id }
//  Solo owner / admin_org pueden hacerlo
// ══════════════════════════════════════════════════════════
router.post('/copernicus', async (req, res) => {
  try {
    const { estabSlug, uid, rol } = req.user;

    // Solo roles con permiso de configuración
    if (!['owner', 'admin_org', 'superadmin'].includes(rol)) {
      return res.status(403).json({ error: 'Sin permiso' });
    }

    const { client_id, client_secret, instance_id } = req.body;
    if (!client_id || !client_secret || !instance_id) {
      return res.status(400).json({ error: 'client_id, client_secret e instance_id son requeridos' });
    }

    const db     = getDB('orbitx_global');
    const orgDoc = await db.get(`org_${estabSlug}`);

    orgDoc.integraciones = orgDoc.integraciones || {};
    orgDoc.integraciones.copernicus = {
      client_id:       encrypt(client_id.trim()),
      client_secret:   encrypt(client_secret.trim()),
      instance_id:     encrypt(instance_id.trim()),
      activo:          true,
      configurado_por: `usr_${uid}`,
      configurado_at:  Date.now(),
    };
    orgDoc.updated_at = Date.now();

    await db.insert(orgDoc);
    res.json({ ok: true });
  } catch (e) {
    console.error('[integraciones/copernicus PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  DELETE /api/integraciones/copernicus
//  Elimina las credenciales de la org
// ══════════════════════════════════════════════════════════
router.delete('/copernicus', async (req, res) => {
  try {
    const { estabSlug, rol } = req.user;
    if (!['owner', 'superadmin'].includes(rol)) {
      return res.status(403).json({ error: 'Sin permiso' });
    }

    const db     = getDB('orbitx_global');
    const orgDoc = await db.get(`org_${estabSlug}`);

    if (orgDoc.integraciones?.copernicus) {
      delete orgDoc.integraciones.copernicus;
      orgDoc.updated_at = Date.now();
      await db.insert(orgDoc);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports.router = router;
