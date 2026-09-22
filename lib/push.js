// push.js — Web Push (VAPID) para la app móvil. Best-effort siempre: si no
// hay claves configuradas o falla el envío, se loguea y se sigue. Las
// suscripciones viven en usr_<id>.notificaciones.push_subs (máx 5 por
// usuario, sin duplicar endpoint). Una suscripción que devuelve 404/410 se
// borra del usuario.
const webpush = require("web-push");

const PUB  = process.env.VAPID_PUBLIC_KEY  || "";
const PRIV = process.env.VAPID_PRIVATE_KEY || "";
const SUBJ = process.env.VAPID_SUBJECT     || "mailto:info@agroparallel.com";
let listo = false;
if (PUB && PRIV) { try { webpush.setVapidDetails(SUBJ, PUB, PRIV); listo = true; } catch (e) { console.warn("[push] VAPID inválido:", e.message); } }

function configurado() { return listo; }

// Puro y testeable: dispositivos que llevan más de `umbralMs` sin reportar y
// cuya última notificación (si hubo) es anterior al último heartbeat, o sea,
// un episodio nuevo. Los que nunca reportaron no cuentan como caída.
function seleccionarCaidos(devices, ahora = Date.now(), umbralMs = 15 * 60 * 1000) {
  return devices.filter(d =>
    typeof d.ultimo_visto === "number" &&
    ahora - d.ultimo_visto > umbralMs &&
    !(typeof d.caido_notificado_ts === "number" && d.caido_notificado_ts > d.ultimo_visto)
  );
}

async function enviarAUsuarios(uids, payload) {
  if (!listo || !uids.length) return { enviados: 0 };
  const db = require("../services/couchdb").getDB("global");
  let enviados = 0;
  for (const uid of uids) {
    let u; try { u = await db.get(uid); } catch { continue; }
    const subs = u.notificaciones?.push_subs || [];
    if (!subs.length) continue;
    const vivas = [];
    for (const s of subs) {
      try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); enviados++; vivas.push(s); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) console.log("[push] suscripción vencida, se borra", uid); else { console.warn("[push]", uid, e.statusCode, e.message); vivas.push(s); } }
    }
    if (vivas.length !== subs.length) { try { await db.insert({ ...u, notificaciones: { ...u.notificaciones, push_subs: vivas }, updated_at: Date.now() }); } catch {} }
  }
  return { enviados };
}

async function notificarOrg(orgSlug, payload) {
  if (!listo) return { enviados: 0 };
  const { getMiembros } = require("../services/auth_service"); // lazy: evita ciclo couchdb→push→auth_service→couchdb
  const miembros = await getMiembros(orgSlug);
  return enviarAUsuarios(miembros.map(m => m.uid), payload);
}

module.exports = { configurado, seleccionarCaidos, enviarAUsuarios, notificarOrg, VAPID_PUBLIC_KEY: PUB };
