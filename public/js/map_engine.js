// ============================================================
// VistaX — public/js/map_engine.js
// Geometría, Leaflet, tiles online/offline, pintado de surcos
// Depende de: window.APP_CONFIG, window.LOTE_ACTIVO
// Expone: MapEngine (objeto global)
// ============================================================

const MapEngine = (() => {
  // ------ Config desde el servidor ---------------------------
  const ANCHO_DEFAULT =
    (APP_CONFIG.setup && APP_CONFIG.setup.distancia_entre_surcos) || 0.191;
  const OBJETIVO_DEFAULT =
    (APP_CONFIG.setup && APP_CONFIG.setup.densidad_objetivo) || 16;

  const SURCOS_CONFIG = (() => {
    if (!APP_CONFIG.mapeo_sensores) return [];
    return APP_CONFIG.mapeo_sensores
      .filter(
        (s) =>
          s.tipo === "semilla" ||
          s.tipo === "ferti_linea" ||
          s.tipo === "ferti_costado",
      )
      .map((s) => ({
        bajada: parseInt(s.bajada),
        tipo: s.tipo,
        tren: s.tren || 1,
      }))
      .sort((a, b) => a.bajada - b.bajada);
  })();

  // ------ Estado interno -------------------------------------
  let anchoPasada = ANCHO_DEFAULT;
  let surcosCentro = 0;
  let centrado = false;
  let spmMax = 0;
  // FIX #3: alertasCount ahora refleja alertas ACTIVAS en el punto actual,
  // no un acumulador que solo crece. Se recalcula en cada pintarPuntoGPS.
  let alertasActivas = 0;
  let totalPuntos = 0;
  let trackCoords = [];
  let trackLine = null;
  let siguiendoGPS = true;
  let ultimaPosicion = null;
  let btnSeguir = null;

  // ------ Mapa Leaflet ---------------------------------------
  const map = L.map("map", {
    center: [-34.6, -58.4],
    zoom: 17,
    zoomControl: true,
    preferCanvas: false,
  });

  const capas = {
    surcos: L.layerGroup().addTo(map),
    alertas: L.layerGroup().addTo(map),
    track: L.layerGroup().addTo(map),
  };

  // Dejar de seguir si el usuario arrastra el mapa
  map.on("dragstart", () => {
    siguiendoGPS = false;
    if (btnSeguir) {
      btnSeguir.style.color = "#aaa";
      btnSeguir.style.borderColor = "#2a2a2a";
    }
  });

  // ============================================================
  // TILES — online con fallback offline
  // ============================================================
  let tileLayer = null;

  const TILE_MAX_NATIVE_ZOOM = 19; // CartoDB soporta hasta zoom 19
  let modoOfflineForzado = false;   // true = sin internet, no intentar restaurar tiles
  let gridLayer = null;             // referencia a la grilla offline

  function iniciarTiles() {
    tileLayer = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:   "© OpenStreetMap © CARTO",
        maxZoom:       24,
        maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
      },
    );

    // Fallback por error de red
    tileLayer.on("tileerror", () => {
      if (tileLayer) {
        map.removeLayer(tileLayer);
        tileLayer = null;
        modoOfflineForzado = true;
        activarModoOffline();
      }
    });

    tileLayer.addTo(map);

    // Detectar zoom > maxNativeZoom → pasar a grilla offline
    // Detectar zoom <= maxNativeZoom → restaurar tiles si hay internet
    map.on("zoomend", () => {
      if (modoOfflineForzado) return; // sin internet, no restaurar

      const zoom = map.getZoom();

      if (zoom > TILE_MAX_NATIVE_ZOOM && tileLayer) {
        // Supera el zoom nativo — quitar tiles y mostrar grilla
        map.removeLayer(tileLayer);
        tileLayer = null;
        activarGrillaZoom();
      } else if (zoom <= TILE_MAX_NATIVE_ZOOM && !tileLayer) {
        // Volvió al rango soportado — restaurar tiles
        desactivarGrillaZoom();
        iniciarTiles();
      }
    });
  }

  // Grilla temporal solo por zoom excesivo (sin el aviso de offline)
  function activarGrillaZoom() {
    document.getElementById("map").style.background = "#0a0a0a";
    if (!gridLayer) {
      gridLayer = L.layerGroup().addTo(map);
      map.on("moveend zoomend", _actualizarGrillaZoom);
    }
    _actualizarGrillaZoom();
  }

  function desactivarGrillaZoom() {
    document.getElementById("map").style.background = "";
    if (gridLayer) {
      map.removeLayer(gridLayer);
      map.off("moveend zoomend", _actualizarGrillaZoom);
      gridLayer = null;
    }
  }

  function _actualizarGrillaZoom() {
    if (!gridLayer) return;
    gridLayer.clearLayers();
    dibujarGrillaEnLayer(gridLayer);
  }

  function activarModoOffline() {
    document.getElementById("map").style.background = "#0a0a0a";

    // Reusar gridLayer si ya existe (por zoom excesivo previo)
    if (!gridLayer) {
      gridLayer = L.layerGroup().addTo(map);
      map.on("moveend zoomend", () => dibujarGrillaEnLayer(gridLayer));
    }
    dibujarGrillaEnLayer(gridLayer);

    const aviso = document.createElement("div");
    aviso.style.cssText = [
      "position:fixed",
      "top:60px",
      "left:50%",
      "transform:translateX(-50%)",
      "background:#2b1a0d",
      "border:1px solid #5c3a1a",
      "color:#ffb300",
      "padding:6px 14px",
      "border-radius:5px",
      "font-size:11px",
      "font-weight:700",
      "z-index:1000",
      "pointer-events:none",
    ].join(";");
    aviso.innerHTML =
      '<i class="fas fa-wifi" style="text-decoration:line-through;margin-right:5px"></i>MODO OFFLINE — sin mapa base';
    document.body.appendChild(aviso);
  }

  function dibujarGrillaEnLayer(layer) {
    layer.clearLayers();
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    const celdaMetros =
      zoom >= 18
        ? 10
        : zoom >= 17
          ? 20
          : zoom >= 16
            ? 50
            : zoom >= 15
              ? 100
              : 200;
    const R = 6371000;
    const latCentro = (bounds.getNorth() + bounds.getSouth()) / 2;
    const celdaLat = (celdaMetros / R) * (180 / Math.PI);
    const celdaLon =
      ((celdaMetros / R) * (180 / Math.PI)) /
      Math.cos((latCentro * Math.PI) / 180);
    const latMin = Math.floor(bounds.getSouth() / celdaLat) * celdaLat;
    const latMax = Math.ceil(bounds.getNorth() / celdaLat) * celdaLat;
    const lonMin = Math.floor(bounds.getWest() / celdaLon) * celdaLon;
    const lonMax = Math.ceil(bounds.getEast() / celdaLon) * celdaLon;
    const estilo = { color: "#1a1a1a", weight: 1, opacity: 1 };
    for (let lat = latMin; lat <= latMax; lat += celdaLat) {
      L.polyline(
        [
          [lat, lonMin],
          [lat, lonMax],
        ],
        estilo,
      ).addTo(layer);
    }
    for (let lon = lonMin; lon <= lonMax; lon += celdaLon) {
      L.polyline(
        [
          [latMin, lon],
          [latMax, lon],
        ],
        estilo,
      ).addTo(layer);
    }
  }

  // Verificar conectividad
  fetch("https://tile.openstreetmap.org/0/0/0.png", {
    method: "HEAD",
    mode: "no-cors",
    signal: AbortSignal.timeout(3000),
  })
    .then(() => iniciarTiles())
    .catch(() => {
      console.log("[VistaX Mapa] Sin internet — modo offline");
      activarModoOffline();
    });

  // ============================================================
  // BOTÓN DE SEGUIMIENTO GPS
  // ============================================================
  function crearBotonSeguir() {
    btnSeguir = document.createElement("button");
    btnSeguir.innerHTML = '<i class="fas fa-crosshairs"></i>';
    btnSeguir.title = "Centrar en GPS";
    btnSeguir.style.cssText = [
      "position:fixed",
      "bottom:18px",
      "left:calc(var(--panel-w) + 14px)",
      "z-index:1000",
      "background:#141414",
      "border:1px solid #2a2a2a",
      "color:#aaa",
      "width:36px",
      "height:36px",
      "border-radius:5px",
      "font-size:14px",
      "cursor:pointer",
      "display:flex",
      "align-items:center",
      "justify-content:center",
    ].join(";");
    btnSeguir.onclick = () => {
      siguiendoGPS = true;
      btnSeguir.style.color = "var(--accent)";
      btnSeguir.style.borderColor = "#1a5c35";
      if (ultimaPosicion)
        map.setView(ultimaPosicion, map.getZoom(), { animate: true });
    };
    document.body.appendChild(btnSeguir);
  }

  crearBotonSeguir();

  // ============================================================
  // GEOMETRÍA
  // ============================================================
  function desplazarPunto(lat, lon, headingGrados, offsetMetros) {
    const R = 6371000;
    const perpRad = (((headingGrados + 90) % 360) * Math.PI) / 180;
    const latRad = (lat * Math.PI) / 180;
    const dLat = (offsetMetros * Math.cos(perpRad)) / R;
    const dLon = (offsetMetros * Math.sin(perpRad)) / (R * Math.cos(latRad));
    return [lat + dLat * (180 / Math.PI), lon + dLon * (180 / Math.PI)];
  }

  function calcularOffsets() {
    if (!SURCOS_CONFIG.length) return {};
    const centroIdx =
      surcosCentro > 0
        ? SURCOS_CONFIG.findIndex((s) => s.bajada === surcosCentro)
        : Math.floor((SURCOS_CONFIG.length - 1) / 2);
    const offsets = {};
    SURCOS_CONFIG.forEach((s, idx) => {
      offsets[s.bajada] = (idx - centroIdx) * anchoPasada;
    });
    return offsets;
  }

  // ============================================================
  // COLOR
  // ============================================================
  function lerp(c1, c2, t) {
    const p = (s) => [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
    ];
    const [r1, g1, b1] = p(c1),
      [r2, g2, b2] = p(c2);
    return (
      "#" +
      [
        Math.round(r1 + (r2 - r1) * t),
        Math.round(g1 + (g2 - g1) * t),
        Math.round(b1 + (b2 - b1) * t),
      ]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    );
  }

  function spmAColor(spm) {
    if (!spm || spm <= 0) return "#ff1744";
    const pct = Math.min(spm / (OBJETIVO_DEFAULT * 1.2), 1);
    if (pct < 0.5) return lerp("#ffb300", "#ffea00", pct / 0.5);
    return lerp("#ffea00", "#00e676", (pct - 0.5) / 0.5);
  }

  // ============================================================
  // PINTAR UN PUNTO GPS — N círculos, uno por surco
  // ============================================================
  function pintarPuntoGPS(p) {
    const latGPS = parseFloat(p.lat);
    const lonGPS = parseFloat(p.lon);
    const heading = parseFloat(p.heading) || 0;
    const surcos = p.surcos || {};
    const ts = p.ts;
    const vel = parseFloat(p.vel) || 0;

    if (!latGPS || !lonGPS) return;

    const offsets = calcularOffsets();
    let spmTotal = 0,
      countSpm = 0;

    // FIX #3: recalcular alertasActivas en este punto (no acumular)
    let alertasEnEstePunto = 0;

    Object.values(surcos).forEach((v) => {
      const s = parseFloat(v) || 0;
      if (s > spmMax) {
        spmMax = s;
        const elMax = document.getElementById("leg-max");
        const elMid = document.getElementById("leg-mid");
        if (elMax) elMax.textContent = spmMax.toFixed(1);
        if (elMid) elMid.textContent = (spmMax / 2).toFixed(1);
      }
      if (s > 0) {
        spmTotal += s;
        countSpm++;
      }
    });

    const spmProm = countSpm > 0 ? (spmTotal / countSpm).toFixed(1) : "0";

    // Track GPS
    trackCoords.push([latGPS, lonGPS]);
    if (trackLine) capas.track.removeLayer(trackLine);
    trackLine = L.polyline(trackCoords, {
      color: "rgba(255,255,255,0.15)",
      weight: 1,
      dashArray: "4 4",
    });
    capas.track.addLayer(trackLine);

    // Un círculo por cada surco configurado
    SURCOS_CONFIG.forEach((sc) => {
      const bajada = sc.bajada;
      const spm = parseFloat(surcos[bajada]) || 0;
      const alerta = spm === 0 && vel > 1.5;
      const color = spmAColor(spm);
      const offset = offsets[bajada] !== undefined ? offsets[bajada] : 0;

      const [latSurco, lonSurco] = desplazarPunto(
        latGPS,
        lonGPS,
        heading,
        offset,
      );

      const circle = L.circleMarker([latSurco, lonSurco], {
        radius: alerta ? 4 : 3,
        fillColor: color,
        fillOpacity: alerta ? 0.95 : 0.85,
        color: alerta ? "#ff1744" : "transparent",
        weight: alerta ? 1.5 : 0,
      });

      circle.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        circle.openTooltip();
        if (typeof MapUI !== "undefined") MapUI.abrirDetalle(bajada, sc.tipo);
      });

      circle.bindTooltip(
        `
        <div class="surco-tip">
          <div class="st-num">Bajada ${bajada}</div>
          <div class="st-spm" style="color:${color}">${spm > 0 ? spm.toFixed(1) : "—"} s/m</div>
          ${alerta ? '<div class="st-alrt"><i class="fas fa-exclamation-triangle"></i> TAPADO</div>' : ""}
          <div class="st-meta">${ts ? new Date(ts).toLocaleTimeString("es-AR") : ""} · ${vel.toFixed(1)} km/h</div>
        </div>
      `,
        { sticky: false, opacity: 1, direction: "top", offset: [0, -6] },
      );

      capas.surcos.addLayer(circle);

      if (alerta) {
        alertasEnEstePunto++;
        capas.alertas.addLayer(
          L.circleMarker([latSurco, lonSurco], {
            radius: 7,
            fillColor: "transparent",
            color: "#ff1744",
            weight: 2,
            opacity: 0.8,
          }),
        );
      }
    });

    // FIX #3: actualizar alertas con el máximo del punto actual
    // (evita que el contador crezca indefinidamente sin resetear)
    if (alertasEnEstePunto > 0) {
      alertasActivas = Math.max(alertasActivas, alertasEnEstePunto);
      const elAlertas = document.getElementById("hkpi-alertas");
      if (elAlertas) elAlertas.textContent = alertasActivas;
    }

    // Seguimiento GPS
    ultimaPosicion = [latGPS, lonGPS];
    if (!centrado) {
      map.setView([latGPS, lonGPS], 18);
      centrado = true;
    } else if (siguiendoGPS) {
      map.panTo([latGPS, lonGPS], { animate: true, duration: 0.3 });
    }

    totalPuntos++;
    const elPts = document.getElementById("hkpi-pts");
    const elSpm = document.getElementById("hkpi-spm");
    if (elPts) elPts.textContent = totalPuntos;
    if (elSpm) elSpm.textContent = spmProm;

    return spmProm;
  }

  // ============================================================
  // RESET — al iniciar un lote nuevo
  // ============================================================
  function resetear() {
    capas.surcos.clearLayers();
    capas.alertas.clearLayers();
    capas.track.clearLayers();
    trackCoords = [];
    trackLine = null;
    centrado = false;
    spmMax = 0;
    // FIX #2: también actualizar el DOM al resetear
    alertasActivas = 0;
    totalPuntos = 0;
    siguiendoGPS = true;
    ultimaPosicion = null;

    // Actualizar KPIs del header del mapa
    const elAlertas = document.getElementById("hkpi-alertas");
    const elPts = document.getElementById("hkpi-pts");
    const elSpm = document.getElementById("hkpi-spm");
    const elHa = document.getElementById("hkpi-ha");
    const elMax = document.getElementById("leg-max");
    const elMid = document.getElementById("leg-mid");
    if (elAlertas) elAlertas.textContent = "0";
    if (elPts)     elPts.textContent = "0";
    if (elSpm)     elSpm.textContent = "—";
    if (elHa)      elHa.textContent = "— ha";
    if (elMax)     elMax.textContent = "óptimo+";
    if (elMid)     elMid.textContent = "—";

    if (btnSeguir) {
      btnSeguir.style.color = "var(--accent)";
      btnSeguir.style.borderColor = "#1a5c35";
    }
  }

  // ============================================================
  // API pública
  // ============================================================
  return {
    map,
    capas,
    SURCOS_CONFIG,
    ANCHO_DEFAULT,
    OBJETIVO_DEFAULT,
    get TOTAL_SURCOS() {
      return SURCOS_CONFIG.length;
    },
    pintarPuntoGPS,
    spmAColor,
    resetear,
    setAnchoPasada: (v) => {
      anchoPasada = parseFloat(v) || ANCHO_DEFAULT;
    },
    setSurcosCentro: (v) => {
      surcosCentro = parseInt(v) || 0;
    },
    toggleCapa(nombre) {
      const chk = document.getElementById(`toggle-${nombre}`);
      if (!chk) return;
      chk.checked
        ? map.addLayer(capas[nombre])
        : map.removeLayer(capas[nombre]);
    },
  };
})();
