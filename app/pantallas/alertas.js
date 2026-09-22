// alertas.js — Alertas activas arriba, historial abajo. Solo lectura en Fase 1
// (el server no expone resolver por API todavía).
import { fechaCorta, haceCuanto } from "../core/fecha.js";
import { esc } from "../ui/html.js";

const COLOR = { critico: "err", critica: "err", alto: "err", alta: "err", medio: "warn", media: "warn", bajo: "info", baja: "info" };

function fila(a) {
  const c = COLOR[String(a.nivel || "").toLowerCase()] || "warn";
  return `<li class="fila"><span class="dot ${c}"></span>
    <span class="txt"><b>${esc(a.mensaje || "Alerta")}</b><span>${esc(a.nivel || "")}${a.lote ? " · " + esc(a.lote) : ""} · ${fechaCorta(a.ts_inicio)}</span></span>
    <span class="val">${a.resuelta ? "resuelta" : haceCuanto(a.ts_inicio)}</span></li>`;
}

export async function montar(ctx, root) {
  root.classList.add("scroll");
  async function cargar() {
    let act, hist;
    try { act = await ctx.api.get("/api/alertas"); } catch (e) {
      root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
      // Sin datos ni cache: que la franja lo diga y el badge no mienta.
      ctx.nav.setOffline(true, null);
      ctx.nav.setBadge("alertas", 0);
      return;
    }
    try { hist = await ctx.api.get("/api/alertas/historial?limit=50"); } catch { hist = { data: [] }; }
    ctx.nav.setOffline(act.desdeCache, act.ts);
    ctx.nav.setBadge("alertas", act.data.length);
    const activasIds = new Set(act.data.map(a => a._id));
    const pasadas = hist.data.filter(a => !activasIds.has(a._id));
    root.innerHTML = `
      <div class="titulo-seccion">Activas · ${act.data.length}</div>
      <ul class="lista">${act.data.length ? act.data.map(fila).join("") : `<li class="vacio">Sin alertas activas. 👌</li>`}</ul>
      <div class="titulo-seccion">Historial</div>
      <ul class="lista">${pasadas.length ? pasadas.map(fila).join("") : `<li class="vacio">Sin historial.</li>`}</ul>`;
  }
  await cargar();
  const timer = setInterval(cargar, 60000);
  return { desmontar() { clearInterval(timer); } };
}
