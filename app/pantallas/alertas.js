// alertas.js — Alertas activas arriba, historial abajo. Solo lectura en Fase 1
// (el server no expone resolver por API todavía).
import { fechaCorta, haceCuanto } from "../core/fecha.js";
import { esc } from "../ui/html.js";
import { estadoPush, suscribirPush, desuscribirPush, suscripcionActual } from "../core/push.js";

const COLOR = { critico: "err", critica: "err", alto: "err", alta: "err", medio: "warn", media: "warn", bajo: "info", baja: "info" };

function fila(a) {
  const c = COLOR[String(a.nivel || "").toLowerCase()] || "warn";
  return `<li class="fila"><span class="dot ${c}"></span>
    <span class="txt"><b>${esc(a.mensaje || "Alerta")}</b><span>${esc(a.nivel || "")}${a.lote ? " · " + esc(a.lote) : ""} · ${fechaCorta(a.ts_inicio)}</span></span>
    <span class="val">${a.resuelta ? "resuelta" : haceCuanto(a.ts_inicio)}</span></li>`;
}

async function tarjetaPush() {
  const st = estadoPush();
  const sub = st.soportado ? await suscripcionActual() : null;
  const texto = sub ? "Notificaciones activadas en este teléfono."
    : st.esIOS && !st.instalada ? "Para recibir alertas en iPhone, instalá la app: Compartir → Agregar a pantalla de inicio."
    : "Recibí las alertas y los equipos caídos como notificación.";
  return `<div class="card" id="card-push"><h3>Notificaciones</h3><p>${texto}</p>
    ${st.soportado && !(st.esIOS && !st.instalada) ? `<button class="btn ${sub ? "secundario" : ""}" id="btn-push" style="margin-top:10px;width:100%">${sub ? "Desactivar" : "Activar notificaciones"}</button>` : ""}</div>`;
}

export async function montar(ctx, root) {
  root.classList.add("scroll");
  async function cargar() {
    let act, hist;
    try { act = await ctx.api.get("/api/alertas"); } catch (e) {
      root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
      // Sin datos ni cache: que la franja lo diga. El badge se deja como
      // estaba: un 0 se leería como "confirmado sin alertas", y no lo sabemos.
      ctx.nav.setOffline(true, null);
      return;
    }
    try { hist = await ctx.api.get("/api/alertas/historial?limit=50"); } catch { hist = { data: [] }; }
    ctx.nav.setOffline(act.desdeCache, act.ts);
    ctx.nav.setBadge("alertas", act.data.length);
    const activasIds = new Set(act.data.map(a => a._id));
    const pasadas = hist.data.filter(a => !activasIds.has(a._id));
    root.innerHTML = `${await tarjetaPush()}
      <div class="titulo-seccion">Activas · ${act.data.length}</div>
      <ul class="lista">${act.data.length ? act.data.map(fila).join("") : `<li class="vacio">Sin alertas activas. 👌</li>`}</ul>
      <div class="titulo-seccion">Historial</div>
      <ul class="lista">${pasadas.length ? pasadas.map(fila).join("") : `<li class="vacio">Sin historial.</li>`}</ul>`;
    root.querySelector("#btn-push")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        if (await suscripcionActual()) { await desuscribirPush(ctx.api); ctx.toast("Notificaciones desactivadas", "ok"); }
        else { const r = await suscribirPush(ctx.api); ctx.toast(r.ok ? "Notificaciones activadas" : r.motivo, r.ok ? "ok" : "error"); }
      } catch (e) { ctx.toast(e.message, "error"); }
      cargar();
    });
  }
  await cargar();
  const timer = setInterval(cargar, 60000);
  return { desmontar() { clearInterval(timer); } };
}
