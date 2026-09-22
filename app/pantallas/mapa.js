// mapa.js — Mapa a pantalla completa con las máquinas en vivo y los límites
// de los lotes. Arranca con /api/tracking/live (últimos 5 min) y después se
// actualiza por socket. Sin señal: lotes y últimas posiciones desde cache
// sobre fondo liso (los tiles no se cachean, ver spec).
import { crearSheet } from "../ui/sheet.js";
import { haceCuanto } from "../core/fecha.js";
import { esc } from "../ui/html.js";

const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const VIEJO_MS = 2 * 60 * 1000; // sin dato hace >2 min → marcador amarillo (mismo criterio que devices.js:254)

export async function montar(ctx, root) {
  root.innerHTML = `
    <div id="mapa" class="mapa"></div>
    <div class="chip-flotante" id="chips"></div>
    <div class="sheet" id="sheet"><div class="handle"></div><div class="cuerpo"><ul class="lista" id="lista-maq"></ul></div></div>`;

  const mapa = L.map("mapa", { zoomControl: false, attributionControl: false }).setView([-34.6, -60.9], 7);
  L.tileLayer(TILES, { maxZoom: 18 }).addTo(mapa);
  const capaLotes = L.layerGroup().addTo(mapa);
  const marcadores = new Map(); // device_id → { marker, datos }
  const sheet = crearSheet(root.querySelector("#sheet"));
  let timer = null, primerEncuadre = true;

  function icono(viejo) {
    return L.divIcon({ className: "", html: `<div class="marcador-maquina ${viejo ? "viejo" : ""}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
  }
  function upsertMaquina(d) {
    const viejo = Date.now() - d.ts > VIEJO_MS;
    const ll = [d.lat, d.lon];
    const prev = marcadores.get(d.device_id);
    if (prev) { prev.marker.setLatLng(ll).setIcon(icono(viejo)); prev.datos = { ...prev.datos, ...d }; }
    else marcadores.set(d.device_id, { marker: L.marker(ll, { icon: icono(viejo) }).addTo(mapa), datos: d });
  }
  function pintarLista() {
    const ul = root.querySelector("#lista-maq"); ul.innerHTML = "";
    const items = [...marcadores.values()].map(m => m.datos).sort((a, b) => b.ts - a.ts);
    let activas = 0, viejas = 0;
    for (const d of items) {
      const viejo = Date.now() - d.ts > VIEJO_MS; viejo ? viejas++ : activas++;
      const li = document.createElement("li");
      li.innerHTML = `<button class="fila"><span class="dot ${viejo ? "warn" : "ok"}"></span>
        <span class="txt"><b>${esc(d.nombre || d.device_id)}</b><span>${d.field ? "Lote " + esc(d.field) + " · " : ""}${(d.speed ?? 0).toFixed(1)} km/h</span></span>
        <span class="val">${haceCuanto(d.ts)}</span></button>`;
      li.querySelector("button").addEventListener("click", () => { mapa.setView([d.lat, d.lon], 16); sheet.cerrar(); });
      ul.appendChild(li);
    }
    if (!items.length) ul.innerHTML = `<li class="vacio">Ninguna máquina reportó en los últimos 5 minutos.</li>`;
    root.querySelector("#chips").innerHTML = `<span class="pill ok">${activas} activas</span>${viejas ? `<span class="pill warn">${viejas} sin dato</span>` : ""}`;
  }
  async function cargar() {
    try {
      const [live, lotes] = await Promise.all([ctx.api.get("/api/tracking/live"), ctx.api.get("/api/lotes")]);
      ctx.nav.setOffline(live.desdeCache, live.ts);
      for (const d of live.data) upsertMaquina(d);
      capaLotes.clearLayers();
      const bounds = [];
      for (const l of lotes.data) if (Array.isArray(l.boundary) && l.boundary.length > 2) {
        L.polygon(l.boundary, { color: "#A4BA3E", weight: 1.5, fillOpacity: 0.08 }).bindTooltip(esc(l.nombre), { permanent: false }).addTo(capaLotes);
        bounds.push(...l.boundary);
      }
      for (const m of marcadores.values()) bounds.push(m.marker.getLatLng());
      if (primerEncuadre && bounds.length) { mapa.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 }); primerEncuadre = false; }
      pintarLista();
    } catch (e) { ctx.toast(e.message, "error"); }
  }

  ctx.onPosicion = (p) => { upsertMaquina({ ...p, nombre: marcadores.get(p.device_id)?.datos.nombre }); pintarLista(); };
  await cargar();
  timer = setInterval(() => { if (!ctx.socket?.connected) cargar(); else pintarLista(); }, 30000); // sin socket → polling; con socket → solo refresca "hace X"

  return { desmontar() { clearInterval(timer); ctx.onPosicion = null; sheet.destruir(); mapa.remove(); } };
}
