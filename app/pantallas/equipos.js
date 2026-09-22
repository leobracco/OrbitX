// equipos.js — Estado de los dispositivos de la org. "online" lo decide el
// server (ultimo_visto < 2 min); acá solo se muestra.
import { esc } from "../ui/html.js";
import { haceCuanto } from "../core/fecha.js";

export async function montar(ctx, root) {
  root.classList.add("scroll");
  async function cargar() {
    let r;
    // Siempre con ?estab=: para un superadmin, /api/devices sin filtro devuelve
    // los equipos de TODAS las orgs (comportamiento del panel).
    const org = ctx.usuario?.org_activa;
    const url = org ? `/api/devices?estab=${encodeURIComponent(org)}` : "/api/devices";
    try { r = await ctx.api.get(url); } catch (e) { root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return; }
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const eq = [...r.data].sort((a, b) => (b.online - a.online) || ((b.ultimo_visto || 0) - (a.ultimo_visto || 0)));
    const on = eq.filter(d => d.online).length;
    root.innerHTML = `
      <div class="titulo-seccion">${on} en línea · ${eq.length - on} sin reportar</div>
      <ul class="lista">${eq.map(d => `
        <li class="fila">
          <span class="dot ${d.online ? "ok" : (d.ultimo_visto ? "warn" : "")}"></span>
          <span class="txt"><b>${esc(d.hostname || d.device_id)}</b><span>${d.version ? "v" + esc(d.version) + " · " : ""}${d.ultimo_visto ? "visto " + haceCuanto(d.ultimo_visto) : "nunca reportó"}</span></span>
          <span class="val">${d.online ? "en línea" : "—"}</span>
        </li>`).join("")}</ul>
      ${eq.length ? "" : `<div class="vacio">No hay equipos asignados a este establecimiento.</div>`}`;
  }
  await cargar();
  const timer = setInterval(cargar, 60000);
  return { desmontar() { clearInterval(timer); } };
}
