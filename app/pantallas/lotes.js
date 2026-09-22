// lotes.js — Lista de lotes de la org y detalle con mini mapa del límite y
// las últimas lluvias registradas en ese lote.
//
// Fuentes (las mismas que el panel de escritorio): /api/lotes-maestro?lite=1
// lista los lotes cargados a mano Y los que llegaron por archivos de PilotX;
// /api/aog/mapa?lote=<nombre>&lite=1 trae el límite parseado (sin pasadas);
// /api/lotes-maestro/<nombre>/contexto trae cultivo, hectáreas y capas.
// /api/lotes (docs "lote") no se usa: en muchas orgs está vacío.
import { esc } from "../ui/html.js";
import { haceCuanto } from "../core/fecha.js";

export async function montar(ctx, root, nombre) {
  root.classList.add("scroll");
  return nombre ? detalle(ctx, root, nombre) : lista(ctx, root);
}

async function lista(ctx, root) {
  let r;
  try { r = await ctx.api.get("/api/lotes-maestro?lite=1&limit=200"); }
  catch (e) { root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return { desmontar() {} }; }
  ctx.nav.setOffline(r.desdeCache, r.ts);
  const items = r.data.items || [];
  root.innerHTML = items.length ? `<ul class="lista">${items.map(l => `
    <li><a class="fila" href="#/lotes/${encodeURIComponent(l.nombre)}" style="text-decoration:none">
      <span class="dot ${l.aog?.tiene_boundary ? "ok" : (l.tiene_maestro ? "info" : "")}"></span>
      <span class="txt"><b>${esc(l.nombre)}</b><span>${esc(l.cultivo || "sin cultivo")}${l.ha_estimadas ? " · " + esc(l.ha_estimadas) + " ha" : ""}${l.ts_ultimo ? " · " + haceCuanto(l.ts_ultimo) : ""}</span></span>
      <span class="val">${l.aog?.tiene_boundary ? "▸" : "sin límite"}</span>
    </a></li>`).join("")}</ul>${r.data.hayMas ? `<div class="vacio">Se muestran los primeros ${items.length} de ${r.data.total}.</div>` : ""}`
    : `<div class="vacio">Este establecimiento todavía no tiene lotes: se cargan desde el panel o llegan solos desde PilotX.</div>`;
  return { desmontar() {} };
}

async function detalle(ctx, root, nombre) {
  let mapa = null;
  const org = ctx.usuario?.org_activa;
  const enc = encodeURIComponent(nombre);
  // Contexto (cultivo, ha, capas) y límite se piden en paralelo; cada uno
  // falla por separado sin tumbar la pantalla.
  const [rCtx, rMapa] = await Promise.all([
    ctx.api.get(`/api/lotes-maestro/${enc}/contexto`).catch(e => ({ data: null, error: e.message })),
    org ? ctx.api.get(`/api/aog/mapa?estab=${encodeURIComponent(org)}&lote=${enc}&lite=1`).catch(() => ({ data: [] })) : { data: [] },
  ]);
  const c = rCtx.data || {};
  const boundary = (rMapa.data || []).find(x => x.nombre === nombre)?.boundary || (rMapa.data || [])[0]?.boundary || null;
  const aog = c.capas?.aog || null;
  if (rCtx.ts) ctx.nav.setOffline(rCtx.desdeCache, rCtx.ts);

  const datos = [
    c.cultivo ? esc(c.cultivo) : "sin cultivo",
    c.temporada ? esc(c.temporada) : null,
    c.ha_estimadas ? esc(c.ha_estimadas) + " ha" : (aog?.contorno_ha ? Number(aog.contorno_ha).toFixed(1) + " ha (contorno)" : null),
    aog?.trabajado_ha ? Number(aog.trabajado_ha).toFixed(1) + " ha trabajadas" : null,
  ].filter(Boolean).join(" · ");

  root.innerHTML = `
    <div class="card"><a href="#/lotes" style="color:var(--ap-muted);font-size:13px;text-decoration:none">‹ Lotes</a>
      <h3>${esc(nombre)}</h3><p>${datos}${rCtx.error ? ` · <span style="color:var(--ap-yellow)">${esc(rCtx.error)}</span>` : ""}</p></div>
    ${Array.isArray(boundary) && boundary.length > 2 ? `<div class="mini-mapa" id="mini"></div>` : `<div class="card"><p>Este lote no tiene límite dibujado${org ? "" : " (elegí un establecimiento)"}.</p></div>`}
    <div class="titulo-seccion">Lluvias en este lote</div><ul class="lista" id="lluvias-lote"><li class="vacio">Cargando…</li></ul>`;
  if (root.querySelector("#mini")) {
    try {
      mapa = L.map("mini", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}").addTo(mapa);
      const poly = L.polygon(boundary, { color: "#A4BA3E", weight: 2, fillOpacity: 0.12 }).addTo(mapa);
      mapa.fitBounds(poly.getBounds(), { padding: [10, 10] });
    } catch (e) {
      console.warn("[lotes] no se pudo dibujar el límite:", e.message);
      mapa?.remove(); mapa = null;
      root.querySelector("#mini").outerHTML = `<div class="card"><p>No se pudo dibujar el límite de este lote.</p></div>`;
    }
  }
  try {
    const ll = await ctx.api.get(`/api/lluvias?lote=${enc}`);
    const regs = (ll.data.registros || []).slice(0, 10);
    root.querySelector("#lluvias-lote").innerHTML = regs.length ? regs.map(x => `<li class="fila"><span class="dot info"></span><span class="txt"><b>${esc(x.mm)} mm</b><span>${esc(x.fecha)}${x.nota ? " · " + esc(x.nota) : ""}</span></span></li>`).join("") : `<li class="vacio">Sin lluvias registradas.</li>`;
  } catch { root.querySelector("#lluvias-lote").innerHTML = `<li class="vacio">Sin conexión para traer lluvias.</li>`; }
  return { desmontar() { mapa?.remove(); } };
}
