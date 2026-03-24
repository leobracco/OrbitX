/**
 * public/js/mapa-ndvi.js
 * Layer NDVI sobre Leaflet — OrbitX / Copernicus Data Space
 *
 * Depende de:
 *   - window._mapa      → instancia L.map creada en mapa.ejs
 *   - window.Auth       → cliente HTTP autenticado (auth.js)
 *   - window.toast()    → notificaciones (app.js)
 *
 * Expone en window:
 *   - OrbitNDVI.toggle(bounds?)
 *   - OrbitNDVI.setFecha(fecha)
 *   - OrbitNDVI.setOpacity(0-1)
 *   - OrbitNDVI.destroy()
 *   - OrbitNDVI.estado   → { activo, fecha, fechas[] }
 */

(function (global) {
  'use strict';

  // ── Estado interno ─────────────────────────────────────
  let _layer      = null;
  let _activo     = false;
  let _fecha      = null;
  let _fechas     = [];   // [{ fecha, cloud_cover }]
  let _opacity    = 0.75;
  let _configured = null; // null = no consultado, true/false

  // ── Verificar si Copernicus está configurado (caché en sesión) ──
  async function isCopernicusOk() {
    if (_configured !== null) return _configured;
    try {
      const r = await Auth.get('/api/integraciones/copernicus');
      _configured = !!r.configurado;
    } catch {
      _configured = false;
    }
    return _configured;
  }

  // ── Cargar fechas disponibles para el bbox del mapa/lote ──
  async function cargarFechas(bounds) {
    if (!bounds && global._mapa) bounds = global._mapa.getBounds();
    if (!bounds) return [];

    const bbox = [
      bounds.getWest().toFixed(6),
      bounds.getSouth().toFixed(6),
      bounds.getEast().toFixed(6),
      bounds.getNorth().toFixed(6),
    ].join(',');

    try {
      const r = await Auth.get(`/api/ndvi/fechas-disponibles?bbox=${bbox}&dias=90`);
      _fechas = r.fechas || [];
    } catch (e) {
      console.warn('[NDVI] No se pudieron cargar fechas:', e.message);
      _fechas = [];
    }
    return _fechas;
  }

  // ── Aplicar (o cambiar) el layer al mapa ──────────────
  function aplicarLayer(fecha) {
    if (!global._mapa) {
      console.error('[NDVI] _mapa no disponible');
      return;
    }

    // Quitar layer anterior si existe
    if (_layer) {
      global._mapa.removeLayer(_layer);
      _layer = null;
    }

    _fecha = fecha;

    _layer = L.tileLayer(
      `/api/ndvi/tile/{z}/{x}/{y}?date=${fecha}`,
      {
        opacity:     _opacity,
        maxZoom:     22,
        attribution: `NDVI · Sentinel-2 · ${fecha} · Copernicus`,
        crossOrigin: true,
        errorTileUrl: '', // tile transparente si falla
      }
    );

    // Insertar debajo de las etiquetas (por encima de la ortofoto)
    // Buscar el layer de etiquetas por su URL
    let insertBefore = null;
    global._mapa.eachLayer(l => {
      if (l._url && l._url.includes('World_Boundaries')) insertBefore = l;
    });
    _layer.addTo(global._mapa);

    _activo = true;
    _actualizarUI();

    const cloudInfo = _fechas.find(f => f.fecha === fecha);
    const nubes = cloudInfo ? ` · ${cloudInfo.cloud_cover}% ☁` : '';
    toast('🛰 NDVI activado', `${fecha}${nubes}`, 'lime');
  }

  // ── Quitar layer ───────────────────────────────────────
  function quitarLayer() {
    if (_layer && global._mapa) {
      global._mapa.removeLayer(_layer);
      _layer = null;
    }
    _activo = false;
    _actualizarUI();
  }

  // ── Actualizar controles de UI ─────────────────────────
  function _actualizarUI() {
    // Botón toggle
    const btn = document.getElementById('btn-ndvi');
    if (btn) btn.classList.toggle('active', _activo);

    // Panel de fechas
    const panel = document.getElementById('ndvi-panel');
    if (panel) panel.style.display = _activo ? 'block' : 'none';

    // Selector de fecha
    const sel = document.getElementById('ndvi-fecha-sel');
    if (sel && _fecha) sel.value = _fecha;
  }

  // ── Construir el panel de control (se llama una vez al montar) ──
  function montarPanel(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    el.innerHTML = `
      <div id="ndvi-panel" style="display:none;padding:10px 14px;
           border-top:1px solid var(--border);background:var(--surface)">

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;color:var(--text-dim);font-weight:500">
            🛰 NDVI · Sentinel-2
          </span>
          <button onclick="OrbitNDVI.destroy()"
            style="margin-left:auto;font-size:10px;color:var(--text-dim);
                   background:none;border:none;cursor:pointer;padding:2px 6px">
            ✕ Quitar
          </button>
        </div>

        <div style="display:flex;flex-direction:column;gap:6px">

          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;color:var(--text-dim);min-width:44px">Fecha</label>
            <select id="ndvi-fecha-sel" onchange="OrbitNDVI.setFecha(this.value)"
              style="flex:1;background:var(--surface2);border:1px solid var(--border);
                     color:var(--text);padding:4px 8px;border-radius:6px;font-size:11px">
              <option value="">Cargando…</option>
            </select>
          </div>

          <div style="display:flex;align-items:center;gap:8px">
            <label style="font-size:11px;color:var(--text-dim);min-width:44px">Opacidad</label>
            <input type="range" id="ndvi-opacity" min="0" max="1" step="0.05"
              value="${_opacity}"
              oninput="OrbitNDVI.setOpacity(+this.value)"
              style="flex:1;accent-color:var(--lime)"/>
          </div>

        </div>
      </div>`;
  }

  // ── Poblar el select de fechas ─────────────────────────
  function _poblarSelect() {
    const sel = document.getElementById('ndvi-fecha-sel');
    if (!sel) return;

    if (!_fechas.length) {
      sel.innerHTML = '<option value="">Sin imágenes disponibles</option>';
      return;
    }

    sel.innerHTML = _fechas.map(f =>
      `<option value="${f.fecha}">${f.fecha} · ${f.cloud_cover}% ☁</option>`
    ).join('');

    if (_fecha) sel.value = _fecha;
  }

  // ══════════════════════════════════════════════════════
  //  API pública — window.OrbitNDVI
  // ══════════════════════════════════════════════════════
  const OrbitNDVI = {

    get estado() {
      return { activo: _activo, fecha: _fecha, fechas: _fechas };
    },

    /** Inicializar panel (llamar al montar el mapa) */
    init(containerId) {
      montarPanel(containerId);
      // Resetear caché de configuración al init
      _configured = null;
    },

    /** Toggle NDVI on/off */
    async toggle(bounds) {
      if (_activo) {
        quitarLayer();
        return;
      }

      const ok = await isCopernicusOk();
      if (!ok) {
        toast('Copernicus no configurado',
          'Ir a Integraciones para conectar tu cuenta', 'amber');
        // Navegar a integraciones si el nav global existe
        if (typeof nav === 'function') nav('integraciones');
        return;
      }

      await cargarFechas(bounds);
      _poblarSelect();

      const fecha = _fechas.length
        ? _fechas[0].fecha
        : new Date().toISOString().slice(0, 10);

      aplicarLayer(fecha);
    },

    /** Cambiar fecha sin desactivar */
    setFecha(fecha) {
      if (!fecha || !_activo) return;
      aplicarLayer(fecha);
    },

    /** Ajustar opacidad del layer */
    setOpacity(v) {
      _opacity = Math.min(1, Math.max(0, v));
      if (_layer) _layer.setOpacity(_opacity);
    },

    /** Quitar layer y resetear estado */
    destroy() {
      quitarLayer();
      _fecha  = null;
      _fechas = [];
      const sel = document.getElementById('ndvi-fecha-sel');
      if (sel) sel.innerHTML = '<option value="">–</option>';
    },

    /** Recargar fechas cuando cambia el lote visible */
    async refreshFechas(bounds) {
      if (!_activo) return;
      await cargarFechas(bounds);
      _poblarSelect();
    },
  };

  global.OrbitNDVI = OrbitNDVI;

})(window);
