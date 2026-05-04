/**
 * public/js/mapa-ndvi.js
 * NDVI / NDRE / NDMI / EVI / MSAVI / GNDVI / BSI sobre Leaflet — Agro Parallel.
 *
 * Cambio importante (2026-05-04): ya NO se usa WMS tile-by-tile.
 * Ahora una única request al Process API por lote — recortado al polígono.
 * Mucho más eficiente (1 PU vs decenas) y no requiere configurar layers
 * en el dashboard de Sentinel Hub: el evalscript va inline.
 *
 * Depende de:
 *   - window._mapa       → instancia L.map creada en mapa.ejs
 *   - window._loteActual → nombre del lote actual (set en mapa.ejs)
 *   - window._layers     → para detectar si hay lote cargado
 *   - window.toast()     → notificaciones
 *
 * Expone en window:
 *   - OrbitNDVI.init(containerId)
 *   - OrbitNDVI.toggle()
 *   - OrbitNDVI.setIndice(clave)
 *   - OrbitNDVI.setFecha(fecha)
 *   - OrbitNDVI.setOpacity(0-1)
 *   - OrbitNDVI.destroy()
 */

(function (global) {
  "use strict";

  // ── Estado ─────────────────────────────────────────────
  let _activo      = false;
  let _imgLayer    = null;       // L.imageOverlay actual
  let _objUrl      = null;       // URL.createObjectURL del blob
  let _boundary    = null;       // [[lat,lon], ...] seteado desde mapa.ejs
  let _loteNombre  = "";
  let _indices     = [];         // catálogo del backend
  let _indiceActual = "ndvi";
  let _fecha        = "";        // YYYY-MM-DD o "" = mejor disponible últimos 30 días
  let _opacity      = 0.78;
  let _container    = null;

  const TOKEN  = () => localStorage.getItem("orbitx_token") || "";
  const auth   = (extra) => Object.assign({ "Authorization": `Bearer ${TOKEN()}` }, extra || {});
  const toast  = (...a) => (typeof global.toast === "function") && global.toast(...a);

  // ── Init: monta el panel y carga catálogo ──────────────
  async function init(containerId) {
    _container = document.getElementById(containerId);
    if (!_container) return;

    try {
      const r = await fetch("/api/ndvi/indices", { headers: auth() });
      const j = await r.json();
      _indices = j.indices || [];
    } catch {
      _indices = [];
    }

    pintarPanel();
  }

  function pintarPanel() {
    if (!_container) return;

    const opciones = _indices.map(i =>
      `<option value="${i.clave}">${i.nombre} — ${i.descripcion}</option>`
    ).join("");

    _container.innerHTML = `
      <div id="ndvi-panel" style="display:none;position:fixed;right:20px;bottom:20px;z-index:1500;
           width:320px;background:rgba(20,24,30,0.96);border:1px solid var(--ap-border,#3D333B);
           border-radius:12px;padding:14px;backdrop-filter:blur(20px);box-shadow:0 12px 40px rgba(0,0,0,0.6);
           font-size:12px;color:#E6E6E6">

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-size:16px">🛰</span>
          <span style="font-weight:600;color:#fff">Análisis satelital</span>
          <span id="ndvi-cache-badge" style="margin-left:auto;font-size:9px;padding:2px 6px;border-radius:6px;background:rgba(164,186,62,0.15);color:#A4BA3E;text-transform:uppercase;letter-spacing:0.5px;display:none">cache</span>
          <button onclick="OrbitNDVI.destroy()" style="background:none;border:none;color:#9AA3AD;cursor:pointer;font-size:14px;padding:0;line-height:1">✕</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px">

          <div>
            <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9AA3AD;margin-bottom:4px;display:block">Índice</label>
            <select id="ndvi-idx" onchange="OrbitNDVI.setIndice(this.value)"
              style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--ap-border,#3D333B);color:#E6E6E6;padding:7px 10px;border-radius:7px;font-size:12px;outline:none">
              ${opciones}
            </select>
            <div id="ndvi-desc" style="font-size:10px;color:#9AA3AD;margin-top:4px;line-height:1.5"></div>
          </div>

          <div>
            <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9AA3AD;margin-bottom:4px;display:block">Fecha</label>
            <input type="date" id="ndvi-fecha" onchange="OrbitNDVI.setFecha(this.value)"
              style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--ap-border,#3D333B);color:#E6E6E6;padding:7px 10px;border-radius:7px;font-size:12px;outline:none"/>
            <div style="font-size:10px;color:#9AA3AD;margin-top:4px;line-height:1.5">
              Vacío = mejor imagen de los últimos 30 días (menor nubosidad).
            </div>
          </div>

          <div>
            <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9AA3AD;margin-bottom:4px;display:flex;justify-content:space-between">
              <span>Opacidad</span><span id="ndvi-op-val">${Math.round(_opacity*100)}%</span>
            </label>
            <input type="range" min="0" max="100" value="${Math.round(_opacity*100)}" id="ndvi-op"
              oninput="OrbitNDVI.setOpacity(this.value/100)"
              style="width:100%;accent-color:#A4BA3E"/>
          </div>

          <div id="ndvi-leyenda" style="border-top:1px solid var(--ap-border,#3D333B);padding-top:10px"></div>

          <div id="ndvi-status" style="font-size:11px;color:#9AA3AD;line-height:1.5"></div>
        </div>
      </div>
    `;

    // Set inicial
    const sel = document.getElementById("ndvi-idx");
    if (sel) sel.value = _indiceActual;
    pintarLeyenda();
    pintarDesc();
  }

  function pintarDesc() {
    const i = _indices.find(x => x.clave === _indiceActual);
    const el = document.getElementById("ndvi-desc");
    if (el && i) el.textContent = i.descripcion || "";
  }

  function pintarLeyenda() {
    const el = document.getElementById("ndvi-leyenda");
    if (!el) return;
    const i = _indices.find(x => x.clave === _indiceActual);
    if (!i || !i.leyenda) { el.innerHTML = ""; return; }
    el.innerHTML = `
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#9AA3AD;margin-bottom:6px">Leyenda — ${i.nombre}</div>
      ${i.leyenda.map(L => `
        <div style="display:flex;align-items:center;gap:8px;font-size:11px;line-height:1.7">
          <span style="display:inline-block;width:18px;height:10px;border-radius:2px;background:${L.color};flex-shrink:0"></span>
          <span style="color:#E6E6E6;font-family:monospace;font-size:10px">${L.rango}</span>
          <span style="color:#9AA3AD;font-size:10px">${L.desc}</span>
        </div>
      `).join("")}
    `;
  }

  function statusMsg(txt, kind) {
    const el = document.getElementById("ndvi-status");
    if (!el) return;
    const color = kind === "error" ? "#E74C3E" : kind === "ok" ? "#A4BA3E" : "#9AA3AD";
    el.innerHTML = `<span style="color:${color}">${txt}</span>`;
  }

  // ── Conseguir el polígono del lote actual ──────────────
  // El boundary lo setea mapa.ejs cuando carga un lote vía OrbitNDVI.setLoteBoundary().
  // Si no, intentamos buscar un polígono Leaflet en el mapa como fallback.
  function geometriaLote() {
    if (_boundary && _boundary.length > 2) {
      const coords = _boundary.map(p => {
        // Acepta [lat,lon] o {lat,lng}
        if (Array.isArray(p)) return [p[1], p[0]];          // [lat,lon] → [lng,lat]
        if (p && typeof p.lat === "number") return [p.lng, p.lat];
        return null;
      }).filter(Boolean);
      if (coords.length < 3) return null;
      // Cerrar si hace falta.
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
      return { type: "Polygon", coordinates: [coords] };
    }

    // Fallback: buscar el polígono más grande en el mapa Leaflet.
    if (!global._mapa) return null;
    let mejor = null, mejorArea = 0;
    global._mapa.eachLayer(l => {
      if (typeof l.getLatLngs !== "function") return;
      const llg = l.getLatLngs();
      const ring = Array.isArray(llg[0]) ? llg[0] : llg;
      if (!ring.length || typeof ring[0]?.lat !== "number") return;
      // Heurística simple: aproximar área por bounding box.
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      ring.forEach(p => {
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
        if (p.lng < minLng) minLng = p.lng;
        if (p.lng > maxLng) maxLng = p.lng;
      });
      const area = (maxLat - minLat) * (maxLng - minLng);
      if (area > mejorArea) { mejorArea = area; mejor = ring; }
    });
    if (!mejor) return null;
    const coords = mejor.map(p => [p.lng, p.lat]);
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return { type: "Polygon", coordinates: [coords] };
  }

  function bboxLatLng(geom) {
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    function visitar(c) {
      if (typeof c[0] === "number" && typeof c[1] === "number") {
        const [lng, lat] = c;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      } else if (Array.isArray(c)) c.forEach(visitar);
    }
    visitar(geom.coordinates || []);
    return [[minLat, minLng], [maxLat, maxLng]];
  }

  // ── Pedir imagen al backend y montarla como overlay ────
  async function pedirImagen() {
    const geom = geometriaLote();
    if (!geom) { toast("NDVI", "No hay lote seleccionado", "amber"); return false; }

    statusMsg("Pidiendo imagen a Copernicus…");
    try {
      const body = {
        geometry: geom,
        indice:   _indiceActual,
        date:     _fecha || undefined,
        width:    1024, height: 1024,
      };
      const r = await fetch("/api/ndvi/lote", {
        method:  "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body:    JSON.stringify(body),
      });

      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        statusMsg(`✗ ${r.status}: ${j.error || "error"}`, "error");
        toast("NDVI", j.error || `HTTP ${r.status}`, "red");
        return false;
      }

      const cacheBadge = document.getElementById("ndvi-cache-badge");
      if (cacheBadge) cacheBadge.style.display = r.headers.get("X-Cache") === "HIT" ? "inline-block" : "none";

      const blob = await r.blob();
      if (_objUrl) URL.revokeObjectURL(_objUrl);
      _objUrl = URL.createObjectURL(blob);

      // Montar overlay sobre el bbox del polígono
      if (_imgLayer) global._mapa.removeLayer(_imgLayer);
      _imgLayer = L.imageOverlay(_objUrl, bboxLatLng(geom), { opacity: _opacity, interactive: false });
      _imgLayer.addTo(global._mapa);

      const sizeKB = Math.round(blob.size / 1024);
      statusMsg(`✓ ${_indiceActual.toUpperCase()} cargado · ${sizeKB} KB${r.headers.get("X-Cache") === "HIT" ? " · cache" : ""}`, "ok");
      _activo = true;
      return true;
    } catch (e) {
      statusMsg("✗ " + (e.message || e), "error");
      toast("NDVI", e.message, "red");
      return false;
    }
  }

  // ── API pública ────────────────────────────────────────
  function abrirPanel() {
    const p = document.getElementById("ndvi-panel");
    if (p) p.style.display = "block";
  }
  function cerrarPanel() {
    const p = document.getElementById("ndvi-panel");
    if (p) p.style.display = "none";
  }

  async function toggle() {
    // Si no hay lote, no hace nada
    if (!geometriaLote()) {
      toast("NDVI", "Buscá un lote primero", "amber");
      return;
    }
    if (_activo) return destroy();

    abrirPanel();
    await pedirImagen();
  }

  function setIndice(clave) {
    if (!clave) return;
    _indiceActual = clave;
    pintarLeyenda();
    pintarDesc();
    if (_activo) pedirImagen(); // re-pedir con el nuevo índice
  }

  function setFecha(fecha) {
    _fecha = fecha || "";
    if (_activo) pedirImagen();
  }

  function setOpacity(o) {
    _opacity = Math.max(0, Math.min(1, parseFloat(o) || 0));
    document.getElementById("ndvi-op-val") && (document.getElementById("ndvi-op-val").textContent = Math.round(_opacity * 100) + "%");
    if (_imgLayer) _imgLayer.setOpacity(_opacity);
  }

  function destroy() {
    if (_imgLayer && global._mapa) {
      global._mapa.removeLayer(_imgLayer);
      _imgLayer = null;
    }
    if (_objUrl) {
      URL.revokeObjectURL(_objUrl);
      _objUrl = null;
    }
    _activo = false;
    cerrarPanel();
  }

  // mapa.ejs llama esto cuando carga un lote (con su boundary en [[lat,lon],...]).
  function setLoteBoundary(boundary, nombre) {
    _boundary   = Array.isArray(boundary) && boundary.length > 2 ? boundary : null;
    _loteNombre = nombre || "";
    if (_activo && _boundary) pedirImagen();          // re-pedir si ya estaba prendido
    if (_activo && !_boundary) destroy();             // si limpiaron el lote, apagar
  }

  global.OrbitNDVI = {
    init,
    toggle,
    setIndice,
    setFecha,
    setOpacity,
    setLoteBoundary,
    destroy,
    get estado() {
      return { activo: _activo, indice: _indiceActual, fecha: _fecha, opacity: _opacity, lote: _loteNombre };
    },
  };
})(window);
