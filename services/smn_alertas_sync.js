// services/smn_alertas_sync.js — Avisa a cada org cuando una alerta del SMN toca
// alguno de sus lotes. Una sola vez por evento+inicio; vuelve a avisar si sube
// el nivel. Lo ya avisado vive en el doc "smn_alertas_avisadas" de la org.
"use strict";

const db     = require("./couchdb");
const smn    = require("./smn_alertas");
const { puntosLotes } = require("../lib/lotes-puntos");

const DOC_ID = "smn_alertas_avisadas";
const RETENER_MS = 4 * 86400000;

function fmtHora(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

const EMOJI = { amarilla: "🟡", naranja: "🟠", roja: "🔴" };

function mensaje(a) {
  const lotes = a.lotes.length > 5 ? `${a.lotes.slice(0, 5).join(", ")} y ${a.lotes.length - 5} más` : a.lotes.join(", ");
  return {
    titulo: `${EMOJI[a.nivel] || "⚠"} Alerta ${a.nivel} por ${a.evento.toLowerCase()} · SMN`,
    cuerpo: `Lotes: ${lotes}\nDesde ${fmtHora(a.inicio)} hasta ${fmtHora(a.fin)}\n\n${a.descripcion || ""}\n\nFuente: Servicio Meteorológico Nacional`,
  };
}

async function avisarOrg(slug, alertas) {
  const puntos = await puntosLotes(slug);
  if (!puntos.length) return 0;
  const afectan = smn.alertasParaPuntos(alertas, puntos);
  if (!afectan.length) return 0;

  const edb = db.getDB(slug);
  let doc;
  try { doc = await edb.get(DOC_ID); }
  catch (e) { if (e.statusCode !== 404) throw e; doc = { _id: DOC_ID, tipo: "smn_alertas_avisadas", avisadas: {} }; }

  const ahora = Date.now();
  const avisadas = Object.fromEntries(Object.entries(doc.avisadas || {}).filter(([, v]) => ahora - v.ts < RETENER_MS));
  let enviadas = 0;
  for (const a of afectan) {
    const prev = avisadas[a.clave];
    if (prev && smn.ORDEN_NIVEL[prev.nivel] >= smn.ORDEN_NIVEL[a.nivel]) continue;

    const m = mensaje(a);
    await require("../lib/notify-org").notify(slug, "alerta_smn", m)
      .catch(e => console.warn("[SMN/notify]", slug, e.message));
    const push = require("../lib/push");
    if (push.configurado())
      await push.notificarOrg(slug, { titulo: m.titulo, cuerpo: `${a.lotes.join(", ")} · desde ${fmtHora(a.inicio)}`, url: "/lluvias" })
        .catch(e => console.warn("[SMN/push]", slug, e.message));
    avisadas[a.clave] = { nivel: a.nivel, ts: ahora };
    enviadas++;
  }
  await edb.insert({ ...doc, avisadas, updated_at: ahora });
  return enviadas;
}

async function sincronizar() {
  const alertas = await smn.alertasVigentes({ fresco: true });
  if (!alertas.length) return 0;
  let total = 0;
  for (const o of await db.getEstablecimientos()) {
    try { total += await avisarOrg(o.slug, alertas); }
    catch (e) { console.warn(`[SMN/alertas] ${o.slug}:`, e.message); }
  }
  if (total) console.log(`[SMN/alertas] ✓ ${total} avisos enviados`);
  return total;
}

// Para la UI: alertas vigentes que tocan lotes de la org, con polígonos.
async function alertasOrg(slug) {
  const [alertas, puntos] = await Promise.all([smn.alertasVigentes(), puntosLotes(slug)]);
  return { alertas: smn.alertasParaPuntos(alertas, puntos), lotes: puntos.length };
}

module.exports = { sincronizar, alertasOrg, avisarOrg, mensaje };
