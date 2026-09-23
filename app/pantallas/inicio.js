// inicio.js — Pestaña de inicio: resumen de la actividad de la temporada
// (hectáreas, equipos, lluvia y últimos movimientos). La ven todos los roles.
// Fuente: GET /api/actividad/resumen (Tarea 3) — un superadmin sin
// establecimiento elegido recibe 400 "Sin establecimiento".
import { esc } from "../ui/html.js";
import { haceCuanto } from "../core/fecha.js";
import { ErrorHttp } from "../core/api.js";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DOT_POR_TIPO = { lote: "ok", lluvia: "info", alerta: "err", equipo: "warn" };
const REFRESCO_MS = 5 * 60 * 1000;

function mesCorto(fechaISO) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(fechaISO || ""));
  return m ? `${MESES[Number(m[2]) - 1]} ${m[1]}` : "—";
}

function diaMesCorto(fechaISO) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(fechaISO || ""));
  return m ? `${m[2]}/${m[1]}` : "—";
}

function tile(numero, rotulo) {
  return `<div class="card">
    <div style="font-size:28px;font-weight:700;color:var(--ap-green)">${esc(numero)}</div>
    <p>${esc(rotulo)}</p>
  </div>`;
}

function filaUltimo(u) {
  const dot = DOT_POR_TIPO[u.tipo] || "";
  const contenido = `<span class="dot ${dot}"></span><span class="txt">${esc(u.texto)}</span><span class="val">${haceCuanto(u.ts)}</span>`;
  if (u.tipo === "lote" && u.lote)
    return `<li><a class="fila" href="#/lotes/${encodeURIComponent(u.lote)}" style="text-decoration:none;color:inherit">${contenido}</a></li>`;
  return `<li class="fila">${contenido}</li>`;
}

export async function montar(ctx, root) {
  root.classList.add("scroll");

  async function cargar() {
    let r;
    try {
      r = await ctx.api.get("/api/actividad/resumen");
    } catch (e) {
      if (e instanceof ErrorHttp && e.status === 400) {
        root.innerHTML = `<div class="vacio">Elegí un establecimiento arriba</div>`;
      } else {
        root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
      }
      return;
    }
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const d = r.data;
    const ha = d.hectareas || {};
    const eq = d.equipos || {};
    const ll = d.lluvia || {};
    const num = (n) => Number(n || 0).toLocaleString("es-AR");

    const sinRep = eq.sin_reportar?.[0];
    const rotuloEquipos = sinRep
      ? `${sinRep.hostname} sin reportar hace ${(sinRep.hace_min || 0) < 60 ? (sinRep.hace_min || 0) + " min" : Math.round((sinRep.hace_min || 0) / 60) + " h"}`
      : "todos reportando";

    const rotuloLluvia = ll.ultima
      ? `última: ${diaMesCorto(ll.ultima.fecha)} · ${num(ll.ultima.mm)} mm`
      : "sin lluvias registradas";

    const ultimos = d.ultimos || [];

    root.innerHTML = `
      <div class="card">
        <h3>Temporada ${esc(d.temporada || "—")}</h3>
        <p>${mesCorto(d.rango?.desde)} – ${mesCorto(d.rango?.hasta)}</p>
      </div>
      ${d.alertas_activas > 0 ? `<div style="margin:0 12px 10px"><a class="pill err" href="#/alertas" style="text-decoration:none">${num(d.alertas_activas)} alerta${d.alertas_activas === 1 ? "" : "s"} activa${d.alertas_activas === 1 ? "" : "s"}</a></div>` : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
        ${tile(num(ha.trabajadas) + " ha", `${num(ha.lotes)} lote${ha.lotes === 1 ? "" : "s"}`)}
        ${tile(num(ha.netas) + " ha", `repintado ${num(ha.repintado_pct)} %`)}
        ${tile(`${num(eq.online)} / ${num(eq.total)}`, rotuloEquipos)}
        ${tile(num(ll.mes_mm) + " mm", rotuloLluvia)}
      </div>
      <div class="titulo-seccion">Últimos movimientos</div>
      ${ultimos.length
        ? `<ul class="lista">${ultimos.map(filaUltimo).join("")}</ul>`
        : `<div class="vacio">Sin movimientos recientes.</div>`}`;
  }

  await cargar();
  const timer = setInterval(cargar, REFRESCO_MS);
  return { desmontar() { clearInterval(timer); } };
}
