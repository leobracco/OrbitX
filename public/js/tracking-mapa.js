// tracking-mapa.js — Mapa de tracking de vehículos en vivo + historial
"use strict";

let mapa = null;
let markers = {};          // device_id → L.marker
let capaHistorial = null;  // L.polyline del historial
let selectedDevice = null;
let refreshTimer = null;

const COLOR_MOVING  = "#B8FF3C";
const COLOR_STOPPED = "#3C9EFF";
const COLOR_OFFLINE = "#555";
const COLOR_TRAIL   = "#FFB03C";

// ── Init ─────────────────────────────────────────────────
function initMapa() {
  if (mapa) return;
  mapa = L.map("trk-mapa", { zoomControl: true, preferCanvas: true })
           .setView([-34.6, -60.0], 6);

  const ESRI_MAX_NATIVE = 18;
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Esri World Imagery", maxZoom: 22, maxNativeZoom: ESRI_MAX_NATIVE,
  }).addTo(mapa);

  L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 22, maxNativeZoom: ESRI_MAX_NATIVE, opacity: 0.6,
  }).addTo(mapa);

  mapa.on("zoomend", () => {
    document.getElementById("trk-mapa").style.background =
      mapa.getZoom() > ESRI_MAX_NATIVE ? "#0a0a0a" : "";
  });
}

// ── Icono tractor (SVG dinámico) ─────────────────────────
function tractorIcon(heading, color, pulsar) {
  const rot = heading || 0;
  const pulse = pulsar ? `<circle cx="16" cy="16" r="14" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.4"><animate attributeName="r" from="14" to="22" dur="1.5s" repeatCount="indefinite"/><animate attributeName="opacity" from="0.4" to="0" dur="1.5s" repeatCount="indefinite"/></circle>` : "";
  const svg = `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
    ${pulse}
    <circle cx="16" cy="16" r="10" fill="${color}" opacity="0.2"/>
    <circle cx="16" cy="16" r="5" fill="${color}"/>
    <line x1="16" y1="16" x2="${16 + 10*Math.sin(rot*Math.PI/180)}" y2="${16 - 10*Math.cos(rot*Math.PI/180)}" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
  </svg>`;

  return L.divIcon({
    html: svg,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    className: "",
  });
}

// ── Cargar vehículos en vivo ─────────────────────────────
async function cargarLive() {
  initMapa();
  try {
    const devices = await Auth.get("/api/tracking/live");

    // KPIs
    document.getElementById("kpi-online").textContent   = devices.length;
    document.getElementById("kpi-moviendo").textContent  = devices.filter(d => d.speed > 0.5).length;
    document.getElementById("kpi-campo").textContent     = devices.filter(d => d.field && d.field !== "").length;
    document.getElementById("trk-count").textContent     = `${devices.length} vehículo${devices.length !== 1 ? "s" : ""}`;
    document.getElementById("trk-estado").textContent    = devices.length
      ? "En vivo · " + new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
      : "Sin vehículos online";

    // Lista
    const lista = document.getElementById("trk-lista");
    if (!devices.length) {
      lista.innerHTML = `
        <div class="empty-state" style="padding:40px">
          <span class="icon">📍</span>
          <p>No hay vehículos transmitiendo posición.<br>
          <span style="font-size:11px;color:var(--muted2)">Los tractores con OrbitX envían posición automáticamente.</span></p>
        </div>`;
      return;
    }

    lista.innerHTML = devices.map(d => {
      const moving  = d.speed > 0.5;
      const color   = moving ? COLOR_MOVING : COLOR_STOPPED;
      const selected = selectedDevice === d.device_id;
      const modBadges = [];
      if (d.modules?.vistax)   modBadges.push('<span class="badge badge-lime" style="font-size:9px">VistaX</span>');
      if (d.modules?.quantix)  modBadges.push('<span class="badge badge-blue" style="font-size:9px">QuantiX</span>');
      if (d.modules?.sectionx) modBadges.push('<span class="badge badge-teal" style="font-size:9px">SectionX</span>');

      return `
        <div onclick="seleccionarDevice('${d.device_id}')"
          style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;transition:background .1s;${selected ? "background:var(--surface2)" : ""}"
          onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background='${selected ? "var(--surface2)" : ""}'">
          <div style="width:34px;height:34px;border-radius:50%;background:${color}18;border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">
            🚜
          </div>
          <div style="flex:1;min-width:0">
            <div class="td-main">${d.nombre || d.device_id}</div>
            <div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap">
              ${moving
                ? `<span class="badge badge-lime" style="font-size:9px">${d.speed.toFixed(1)} km/h</span>`
                : '<span class="badge badge-gray" style="font-size:9px">Detenido</span>'}
              ${d.field ? `<span class="badge badge-teal" style="font-size:9px">${d.field}</span>` : ""}
              ${modBadges.join("")}
            </div>
          </div>
          <div class="td-dim" style="font-size:10px;text-align:right;white-space:nowrap">
            ${d.age_sec < 60 ? "hace " + d.age_sec + "s" : "hace " + Math.round(d.age_sec/60) + "min"}
          </div>
        </div>`;
    }).join("");

    // Markers en mapa
    const activeIds = new Set(devices.map(d => d.device_id));

    // Quitar markers de devices que ya no están
    for (const id of Object.keys(markers)) {
      if (!activeIds.has(id)) {
        mapa.removeLayer(markers[id]);
        delete markers[id];
      }
    }

    // Actualizar o crear markers
    for (const d of devices) {
      const moving = d.speed > 0.5;
      const color  = moving ? COLOR_MOVING : COLOR_STOPPED;
      const icon   = tractorIcon(d.heading, color, moving);

      if (markers[d.device_id]) {
        markers[d.device_id].setLatLng([d.lat, d.lon]);
        markers[d.device_id].setIcon(icon);
        markers[d.device_id].setTooltipContent(tooltipHtml(d));
      } else {
        const m = L.marker([d.lat, d.lon], { icon })
          .addTo(mapa)
          .bindTooltip(tooltipHtml(d), { opacity: 1, direction: "top", offset: [0, -16] })
          .on("click", () => seleccionarDevice(d.device_id));
        markers[d.device_id] = m;
      }
    }

    // Auto-centrar si es primera carga
    if (devices.length && !selectedDevice) {
      const group = L.featureGroup(Object.values(markers));
      mapa.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 14 });
    }

    document.getElementById("btn-centrar").style.display = devices.length ? "inline-flex" : "none";

  } catch (e) {
    document.getElementById("trk-estado").textContent = "Error: " + e.message;
    document.getElementById("trk-lista").innerHTML = `<div class="alert error show" style="margin:12px">${e.message}</div>`;
  }
}

function tooltipHtml(d) {
  const moving = d.speed > 0.5;
  return `<div style="font-size:11px;color:#ccc;min-width:120px">
    <b style="color:#fff">${d.nombre || d.device_id}</b><br>
    ${moving ? `<span style="color:${COLOR_MOVING}">${d.speed.toFixed(1)} km/h</span>` : '<span style="color:#888">Detenido</span>'}
    ${d.field ? `<br><span style="color:${COLOR_STOPPED}">${d.field}</span>` : ""}
    <br><span style="color:#555">${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}</span>
  </div>`;
}

// ── Seleccionar device ───────────────────────────────────
function seleccionarDevice(deviceId) {
  selectedDevice = deviceId;
  document.getElementById("btn-historial").disabled = false;

  // Centrar en el marker
  if (markers[deviceId]) {
    mapa.setView(markers[deviceId].getLatLng(), 16);
    markers[deviceId].openTooltip();
  }

  // Remarcar en la lista
  cargarLive();
}

// ── Historial ────────────────────────────────────────────
async function cargarHistorial() {
  if (!selectedDevice) return;
  const fecha = document.getElementById("trk-fecha").value;
  if (!fecha) { toast("Seleccioná una fecha", "", "amber"); return; }

  limpiarHistorial();

  try {
    const data = await Auth.get(`/api/tracking/history/${selectedDevice}?date=${fecha}`);
    if (!data.points || !data.points.length) {
      toast("Sin datos de recorrido para ese día", "", "amber");
      return;
    }

    const latlngs = data.points.map(p => [p.lat, p.lon]);

    // Polyline del recorrido
    capaHistorial = L.polyline(latlngs, {
      color: COLOR_TRAIL,
      weight: 3,
      opacity: 0.8,
      dashArray: "6 4",
    }).addTo(mapa);

    // Marcador de inicio y fin
    L.circleMarker(latlngs[0], {
      radius: 6, fillColor: "#00e676", fillOpacity: 1, color: "#fff", weight: 2,
    }).addTo(mapa).bindTooltip(`<b style="color:#0f0">Inicio</b><br>${new Date(data.points[0].ts).toLocaleTimeString("es-AR")}`, { opacity: 1 });

    const last = data.points[data.points.length - 1];
    L.circleMarker(latlngs[latlngs.length - 1], {
      radius: 6, fillColor: "#ff1744", fillOpacity: 1, color: "#fff", weight: 2,
    }).addTo(mapa).bindTooltip(`<b style="color:#f44">Fin</b><br>${new Date(last.ts).toLocaleTimeString("es-AR")}`, { opacity: 1 });

    mapa.fitBounds(capaHistorial.getBounds(), { padding: [40, 40] });
    document.getElementById("btn-limpiar-historial").style.display = "inline-flex";
    document.getElementById("mapa-titulo").textContent = `Recorrido ${fecha} · ${data.points.length} puntos`;

    toast(`${data.points.length} puntos cargados`, "", "lime");
  } catch (e) {
    toast("Error al cargar historial", e.message, "red");
  }
}

function limpiarHistorial() {
  if (capaHistorial) {
    mapa.removeLayer(capaHistorial);
    capaHistorial = null;
  }
  // Quitar circle markers del historial (inicio/fin)
  mapa.eachLayer(l => {
    if (l instanceof L.CircleMarker && l !== markers[selectedDevice]) {
      mapa.removeLayer(l);
    }
  });
  document.getElementById("btn-limpiar-historial").style.display = "none";
  document.getElementById("mapa-titulo").textContent = "Mapa en vivo";
}

function centrarMapa() {
  const group = L.featureGroup(Object.values(markers));
  if (group.getLayers().length) {
    mapa.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 14 });
  }
}

// ── Socket.IO live updates ───────────────────────────────
function initSocket() {
  if (typeof io === "undefined") return;
  const socket = io();
  socket.on("tracking:position", (data) => {
    // Actualizar marker en tiempo real sin esperar polling
    if (!mapa) return;
    const moving = data.speed > 0.5;
    const color  = moving ? COLOR_MOVING : COLOR_STOPPED;
    const icon   = tractorIcon(data.heading, color, moving);

    if (markers[data.device_id]) {
      markers[data.device_id].setLatLng([data.lat, data.lon]);
      markers[data.device_id].setIcon(icon);
    }
  });
}

// ── Auto-refresh ─────────────────────────────────────────
function startAutoRefresh() {
  refreshTimer = setInterval(cargarLive, 15000); // cada 15s
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Fecha default: hoy
  const hoy = new Date().toISOString().slice(0, 10);
  document.getElementById("trk-fecha").value = hoy;

  cargarLive();
  initSocket();
  startAutoRefresh();
});
