/**
 * public/js/mapa-comparar.js — Comparador de dos paneles.
 *
 * Fase A: NDVI de dos fechas o de dos índices, mismo lote.
 * Fase B: cobertura de dos temporadas (necesita las stats del Sprint 2).
 *
 * Toda la lógica vive acá: views/pages/mapa.ejs (que está sucio y tiene 1.000
 * líneas de JS inline) solo aporta el markup de los contenedores y el arranque.
 * La sincronización son quince líneas propias — no se vendoriza leaflet.sync.
 */
(function (global) {
  "use strict";

  const TOKEN = () => localStorage.getItem("orbitx_token") || "";
  const auth = (extra) => Object.assign({ "Authorization": `Bearer ${TOKEN()}` }, extra || {});
  const toast = (...a) => (typeof global.toast === "function") && global.toast(...a);

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // El dropdown de establecimiento es un FILTRO de listado: puede estar en
  // "Todos". Para pedir el contexto de un lote lo que vale es el
  // establecimiento de ESE lote (window._loteEstab, que setea mapa.ejs al
  // seleccionarlo); el dropdown queda solo como fallback.
  const dropdownEstab = () => document.getElementById("filtro-estab")?.value || "";
  const qsEstab = (slug) => (slug ? `?estab=${encodeURIComponent(slug)}` : "");

  // Se expone global porque mapa.ejs lo usa para arreglar los /contexto que
  // hoy piden sin ?estab= (bug latente que con dos paneles es garantizado).
  global._estabQS = function () {
    return qsEstab(global._loteEstab || dropdownEstab());
  };

  // El lote abierto en el mapa principal es un `let` del <script> inline de
  // mapa.ejs: vive en el scope léxico global, no en window. Por eso se lee con
  // typeof y no como propiedad.
  const loteActual = () =>
    (typeof _loteActual !== "undefined" && _loteActual) || global._loteActual || "";

  const paneles = {};   // { A: {...}, B: {...} }
  let _abierto = false;

  function sincronizar(a, b) {
    let guard = false;
    const enlazar = (src, dst) => src.on("move zoom", () => {
      if (guard) return;
      guard = true;
      dst.setView(src.getCenter(), src.getZoom(), { animate: false });
      guard = false;
    });
    enlazar(a, b);
    enlazar(b, a);
  }

  function crearMapa(idContenedor) {
    const mapa = L.map(idContenedor, { zoomControl: true, preferCanvas: true }).setView([-34.6, -60.0], 10);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri", maxNativeZoom: 17, maxZoom: 22 }).addTo(mapa);
    L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 17, maxZoom: 22, opacity: 0.7 }).addTo(mapa);
    return mapa;
  }

  // El listado sí usa el dropdown: si dice "Todos", queremos todos los lotes
  // (después cada <option> se acuerda de su propio establecimiento).
  async function cargarLotes() {
    const r = await fetch(`/api/aog/lotes-mapa${qsEstab(dropdownEstab())}`, { headers: auth() });
    return r.ok ? await r.json() : [];
  }

  async function cargarFechas(boundary) {
    if (!boundary || boundary.length < 3) return [];
    const lats = boundary.map(p => p[0]), lons = boundary.map(p => p[1]);
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(",");
    const r = await fetch(`/api/ndvi/fechas-disponibles?bbox=${bbox}&dias=180`, { headers: auth() });
    const j = r.ok ? await r.json() : { fechas: [] };
    return j.fechas || [];
  }

  async function cargarTemporadas(lote, estab) {
    const r = await fetch(`/api/aog/lotes/${encodeURIComponent(lote)}/temporadas${qsEstab(estab)}`, { headers: auth() });
    const j = r.ok ? await r.json() : { temporadas: [] };
    return j.temporadas || [];
  }

  async function cargarLote(lote, estab, temporada) {
    const p = new URLSearchParams({ lote });
    if (estab) p.set("estab", estab);
    if (temporada) p.set("temporada", temporada);
    const r = await fetch(`/api/aog/mapa?${p}`, { headers: auth() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const lotes = await r.json();
    return lotes[0] || null;
  }

  function limpiar(pan) {
    pan.capas.forEach(l => pan.mapa.removeLayer(l));
    pan.capas = [];
  }

  function dibujar(pan, lote, mostrarCobertura) {
    limpiar(pan);
    if (!lote) return;
    if (lote.boundary) {
      const poly = L.polygon(lote.boundary, { color: "#b8ff3c", weight: 2, fill: false }).addTo(pan.mapa);
      pan.capas.push(poly);
      pan.mapa.fitBounds(poly.getBounds());
    }
    if (mostrarCobertura && lote.sections) {
      for (const bloque of lote.sections) {
        const s = L.polygon(bloque, { color: "#3c9eff", weight: 0, fillOpacity: 0.5 }).addTo(pan.mapa);
        pan.capas.push(s);
      }
    }
    const st = lote.stats || {};
    const el = document.getElementById(`cmp-info-${pan.id}`);
    if (el) el.textContent = st.trabajado_ha != null
      ? `${st.trabajado_ha} ha trabajadas · ${st.neto_ha ?? "—"} netas${st.repintado_pct != null ? ` · ${st.repintado_pct}% repintado` : ""}`
      : "sin stats";
  }

  // Cada modo usa sus propios selectores: mostrar los cinco siempre confunde.
  function aplicarVisibilidad(id, capa) {
    const ver = (campo, mostrar) => {
      const el = document.getElementById(`cmp-${campo}-${id}`);
      if (el) el.style.display = mostrar ? "" : "none";
    };
    ver("indice", capa === "ndvi");
    ver("fecha",  capa === "ndvi");
    ver("temp",   capa === "cobertura");
  }

  // El <option> elegido es la única fuente de verdad del par lote+estab:
  // dos orgs distintas pueden tener un lote con el mismo nombre.
  function loteElegido(id) {
    const sel = document.getElementById(`cmp-lote-${id}`);
    const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
    if (!opt) return null;
    return { clave: opt.value, nombre: opt.dataset.nombre || opt.value, estab: opt.dataset.estab || "" };
  }

  async function refrescar(id) {
    const pan = paneles[id];
    if (!pan) return;
    const sel  = loteElegido(id);
    const capa = document.getElementById(`cmp-capa-${id}`).value;
    aplicarVisibilidad(id, capa);
    if (!sel || !sel.nombre) return;
    try {
      const temporada = capa === "cobertura" ? (document.getElementById(`cmp-temp-${id}`).value || "") : "";
      const datos = await cargarLote(sel.nombre, sel.estab, temporada);
      dibujar(pan, datos, capa === "cobertura");
      pan.boundary = datos?.boundary || null;
      if (capa === "ndvi") {
        // Un solo pedido a Copernicus por refresco (antes eran hasta tres,
        // compitiendo entre sí): setTodo setea boundary+índice+fecha y pide.
        await pan.ndvi.setTodo({
          boundary: pan.boundary,
          nombre:   sel.nombre,
          indice:   document.getElementById(`cmp-indice-${id}`).value,
          fecha:    document.getElementById(`cmp-fecha-${id}`).value,
          activar:  true,
        });
      } else {
        // Primero apagar y después guardar el boundary: al revés, un NDVI
        // activo re-pedía la imagen justo antes de destruirla.
        pan.ndvi.destroy();
        pan.ndvi.setTodo({ boundary: pan.boundary, nombre: sel.nombre });
      }
      await poblarSelectores(id, sel, pan.boundary);
    } catch (e) {
      toast("Comparar", e.message, "red");
    }
  }

  async function poblarSelectores(id, sel, boundary) {
    const lote = sel.clave;
    const selF = document.getElementById(`cmp-fecha-${id}`);
    if (selF && selF.dataset.lote !== lote) {
      const fechas = await cargarFechas(boundary);
      const elegida = selF.value;
      selF.innerHTML = `<option value="">Mejor de los últimos 30 días</option>` +
        fechas.slice(0, 40).map(f => `<option value="${f.fecha}">${f.fecha} · ${f.cloud_cover}% nubes</option>`).join("");
      if ([...selF.options].some(o => o.value === elegida)) selF.value = elegida;
      selF.dataset.lote = lote;
    }
    const selT = document.getElementById(`cmp-temp-${id}`);
    if (selT && selT.dataset.lote !== lote) {
      const temps = await cargarTemporadas(sel.nombre, sel.estab);
      const elegida = selT.value;
      selT.innerHTML = `<option value="">Última cobertura</option>` +
        temps.map(t => `<option value="${t.temporada}">${t.temporada}${t.trabajado_ha != null ? ` · ${t.trabajado_ha} ha` : ""}</option>`).join("");
      if ([...selT.options].some(o => o.value === elegida)) selT.value = elegida;
      selT.dataset.lote = lote;
    }
  }

  function pintarControles(id) {
    return `
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px;background:rgba(0,0,0,0.35)">
        <select id="cmp-lote-${id}" style="flex:1;min-width:120px"></select>
        <select id="cmp-capa-${id}">
          <option value="ndvi">NDVI</option>
          <option value="cobertura">Cobertura</option>
        </select>
        <select id="cmp-indice-${id}"><option value="ndvi">NDVI</option></select>
        <select id="cmp-fecha-${id}"><option value="">Mejor reciente</option></select>
        <select id="cmp-temp-${id}"><option value="">Última cobertura</option></select>
      </div>
      <div id="cmp-mapa-${id}" style="height:100%;min-height:380px;background:#050810"></div>
      <div id="cmp-controls-${id}"></div>
      <div id="cmp-info-${id}" style="padding:6px 8px;font-size:11px;color:#9AA3AD"></div>`;
  }

  async function abrir() {
    if (_abierto) return cerrar();
    const cont = document.getElementById("cmp-overlay");
    if (!cont) return;
    cont.style.display = "block";
    _abierto = true;

    for (const id of ["A", "B"]) {
      document.getElementById(`cmp-panel-${id}`).innerHTML = pintarControles(id);
    }

    const lotes = await cargarLotes();
    if (!_abierto) return cerrar();   // cerraron el overlay mientras cargaba
    const indicesResp = await fetch("/api/ndvi/indices", { headers: auth() }).then(r => r.ok ? r.json() : { indices: [] }).catch(() => ({ indices: [] }));
    if (!_abierto) return cerrar();

    for (const id of ["A", "B"]) {
      const mapa = crearMapa(`cmp-mapa-${id}`);
      paneles[id] = {
        id, mapa, capas: [], boundary: null,
        ndvi: global.crearNDVI({ prefijo: `cmp${id}`, mapa }),
      };
      await paneles[id].ndvi.init(`cmp-controls-${id}`);
      if (!_abierto) return cerrar();

      const selL = document.getElementById(`cmp-lote-${id}`);
      // value = "<estab>|<nombre>": dos orgs pueden tener lotes homónimos y el
      // value solo con el nombre los hacía colisionar.
      selL.innerHTML = lotes.map(l => {
        const est = l.estab_slug || "";
        return `<option value="${esc(est + "|" + (l.nombre || ""))}" data-estab="${esc(est)}" data-nombre="${esc(l.nombre || "")}">` +
               `${esc(l.nombre || "?")}${est && est !== "unassigned" ? ` · ${esc(est)}` : ""}</option>`;
      }).join("");
      document.getElementById(`cmp-indice-${id}`).innerHTML =
        (indicesResp.indices || []).map(i => `<option value="${esc(i.clave)}">${esc(i.nombre)}</option>`).join("") || `<option value="ndvi">NDVI</option>`;

      for (const campo of ["lote", "capa", "indice", "fecha", "temp"]) {
        document.getElementById(`cmp-${campo}-${id}`)?.addEventListener("change", () => refrescar(id));
      }
    }

    sincronizar(paneles.A.mapa, paneles.B.mapa);
    // Obligatorio: los contenedores nacen con tamaño 0 dentro del overlay.
    setTimeout(() => { if (paneles.A && paneles.B) { paneles.A.mapa.invalidateSize(); paneles.B.mapa.invalidateSize(); } }, 60);

    // Arranca con el lote que ya estaba abierto en el mapa principal, si hay
    // (prefiriendo el del mismo establecimiento cuando hay homónimos).
    const abierto = loteActual();
    const estabAbierto = global._loteEstab || "";
    if (abierto) {
      for (const id of ["A", "B"]) {
        const selL = document.getElementById(`cmp-lote-${id}`);
        const opts = [...selL.options];
        const match = opts.find(o => o.dataset.nombre === abierto && o.dataset.estab === estabAbierto)
                   || opts.find(o => o.dataset.nombre === abierto);
        if (match) selL.value = match.value;
      }
    }
    await refrescar("A");
    if (!_abierto) return cerrar();
    await refrescar("B");
  }

  function cerrar() {
    const cont = document.getElementById("cmp-overlay");
    if (cont) cont.style.display = "none";
    for (const id of ["A", "B"]) {
      if (!paneles[id]) continue;
      try { paneles[id].ndvi.destroy(); paneles[id].mapa.remove(); } catch {}
      delete paneles[id];
      // Sin esto el registro global se queda con instancias muertas y los
      // onclick inline de un panel viejo seguirían resolviendo.
      if (global.__ndvi) delete global.__ndvi[`cmp${id}`];
    }
    _abierto = false;
  }

  global.OrbitComparar = { abrir, cerrar };
})(window);
