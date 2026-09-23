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

const COLOR_AVISO = { critico: "err", info: "info", ok: "ok" };

function filaAviso(n) {
  const c = COLOR_AVISO[n.nivel] || "info";
  // Misma opacidad que usa el panel (topbar.ejs / notificaciones.ejs) para
  // distinguir de un vistazo lo ya leído de lo que falta.
  return `<li class="fila" style="${n.leida ? "opacity:0.55" : ""}"><span class="dot ${c}"></span>
    <span class="txt"><b>${esc(n.titulo || "Aviso")}</b><span>${esc((n.cuerpo || "").slice(0, 90))}</span></span>
    <span class="val">${haceCuanto(n.ts)}</span></li>`;
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
  // Se mantiene entre llamadas de cargar() (el poll de 60 s): si falla la
  // consulta a /no-leidas por estar sin red, el badge se queda con el último
  // valor conocido en vez de aparentar "0 avisos sin leer" en falso.
  let _ultimoNoLeidas = 0;

  function engancharBotonPush() {
    root.querySelector("#btn-push")?.addEventListener("click", async (ev) => {
      ev.target.disabled = true;
      try {
        if (await suscripcionActual()) { await desuscribirPush(ctx.api); ctx.toast("Notificaciones desactivadas", "ok"); }
        else { const r = await suscribirPush(ctx.api); ctx.toast(r.ok ? "Notificaciones activadas" : r.motivo, r.ok ? "ok" : "error"); }
      } catch (e) { ctx.toast(e.message, "error"); }
      cargar();
    });
  }

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
    // Avisos: el historial de notify-org. No es una pestaña nueva — las 6 de
    // app/core/permisos.js ya están justas — sino una sección más acá.
    let avisos;
    try { avisos = await ctx.api.get("/api/notif-org/historial?limit=20"); } catch { avisos = { data: { items: [] } }; }
    const listaAvisos = avisos?.data?.items || [];
    // El conteo del badge sale de /no-leidas (cuenta real sobre hasta 100
    // avisos), no de esta página de 20 del historial: con más de 20 no leídos
    // la página de 20 subestima el número. Sin red, se deja el último valor
    // conocido (declarado arriba de cargar()) en vez de mostrar 0 en falso.
    try {
      const nl = await ctx.api.get("/api/notif-org/no-leidas");
      _ultimoNoLeidas = nl?.data?.no_leidas ?? _ultimoNoLeidas;
    } catch {}
    ctx.nav.setOffline(act.desdeCache, act.ts);
    ctx.nav.setBadge("alertas", act.data.length + _ultimoNoLeidas);
    const activasIds = new Set(act.data.map(a => a._id));
    const pasadas = hist.data.filter(a => !activasIds.has(a._id));
    root.innerHTML = `<div id="slot-push"></div>
      <div class="titulo-seccion">Activas · ${act.data.length}</div>
      <ul class="lista">${act.data.length ? act.data.map(fila).join("") : `<li class="vacio">Sin alertas activas. 👌</li>`}</ul>
      <div class="titulo-seccion">Historial</div>
      <ul class="lista">${pasadas.length ? pasadas.map(fila).join("") : `<li class="vacio">Sin historial.</li>`}</ul>
      <div class="titulo-seccion">Avisos</div>
      <ul class="lista">${listaAvisos.length ? listaAvisos.map(filaAviso).join("") : `<li class="vacio">Sin avisos.</li>`}</ul>`;
    tarjetaPush().then((html) => {
      const slot = root.querySelector("#slot-push");
      if (slot) { slot.outerHTML = html; engancharBotonPush(); }
    }).catch((e) => console.warn("[alertas] tarjeta push:", e.message));
  }
  await cargar();
  const timer = setInterval(cargar, 60000);
  return { desmontar() { clearInterval(timer); } };
}
