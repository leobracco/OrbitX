// lotes.js — Lista de lotes de la org y detalle con mini mapa del límite y
// las últimas lluvias registradas en ese lote.
import { esc } from "../ui/html.js";
import { fechaCorta } from "../core/fecha.js";

export async function montar(ctx, root, id) {
  root.classList.add("scroll");
  return id ? detalle(ctx, root, id) : lista(ctx, root);
}

async function lista(ctx, root) {
  let r;
  try { r = await ctx.api.get("/api/lotes"); } catch (e) { root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return { desmontar() {} }; }
  ctx.nav.setOffline(r.desdeCache, r.ts);
  root.innerHTML = r.data.length ? `<ul class="lista">${r.data.map(l => `
    <li><a class="fila" href="#/lotes/${encodeURIComponent(l._id)}" style="text-decoration:none">
      <span class="dot ${l.fecha_fin ? "" : "ok"}"></span>
      <span class="txt"><b>${esc(l.nombre || l._id)}</b><span>${esc(l.cultivo || "sin cultivo")}${l.fecha_inicio ? " · " + fechaCorta(l.fecha_inicio) : ""}</span></span>
      <span class="val">${Array.isArray(l.boundary) ? "▸" : "sin límite"}</span>
    </a></li>`).join("")}</ul>` : `<div class="vacio">Todavía no hay lotes sincronizados desde PilotX.</div>`;
  return { desmontar() {} };
}

async function detalle(ctx, root, id) {
  let r, mapa = null;
  try { r = await ctx.api.get(`/api/lotes/${encodeURIComponent(id)}`); } catch (e) { root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return { desmontar() {} }; }
  const l = r.data;
  ctx.nav.setOffline(r.desdeCache, r.ts);
  root.innerHTML = `
    <div class="card"><a href="#/lotes" style="color:var(--ap-muted);font-size:13px;text-decoration:none">‹ Lotes</a>
      <h3>${esc(l.nombre || id)}</h3><p>${esc(l.cultivo || "sin cultivo")}${l.fecha_inicio ? " · desde " + fechaCorta(l.fecha_inicio) : ""}${l.fecha_fin ? " · hasta " + fechaCorta(l.fecha_fin) : " · en curso"}</p></div>
    ${Array.isArray(l.boundary) && l.boundary.length > 2 ? `<div class="mini-mapa" id="mini"></div>` : `<div class="card"><p>Este lote no tiene límite dibujado.</p></div>`}
    <div class="titulo-seccion">Lluvias en este lote</div><ul class="lista" id="lluvias-lote"><li class="vacio">Cargando…</li></ul>`;
  if (root.querySelector("#mini")) {
    mapa = L.map("mini", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}").addTo(mapa);
    const poly = L.polygon(l.boundary, { color: "#A4BA3E", weight: 2, fillOpacity: 0.12 }).addTo(mapa);
    mapa.fitBounds(poly.getBounds(), { padding: [10, 10] });
  }
  try {
    const ll = await ctx.api.get(`/api/lluvias?lote=${encodeURIComponent(l.nombre || "")}`);
    const regs = (ll.data.registros || []).slice(0, 10);
    root.querySelector("#lluvias-lote").innerHTML = regs.length ? regs.map(x => `<li class="fila"><span class="dot info"></span><span class="txt"><b>${esc(x.mm)} mm</b><span>${esc(x.fecha)}${x.nota ? " · " + esc(x.nota) : ""}</span></span></li>`).join("") : `<li class="vacio">Sin lluvias registradas.</li>`;
  } catch { root.querySelector("#lluvias-lote").innerHTML = `<li class="vacio">Sin conexión para traer lluvias.</li>`; }
  return { desmontar() { mapa?.remove(); } };
}
