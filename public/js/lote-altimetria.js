// lote-altimetria.js — Capa "Altimetría" del visor de lote (planimetría fase 2).
//
// Pide GET /api/aog/lotes/:nombre/planimetria (grilla compacta + curvas GeoJSON
// + bajos + stats, cacheado en el server) y lo dibuja sobre Leaflet:
//   · Altura: rampa azul de un solo tono (claro = alto, oscuro = bajo) con
//     relieve sombreado opcional.
//   · Pendiente: rampa naranja, calculada acá con las mismas diferencias
//     centrales que el server (la pendiente no viaja para achicar el JSON).
//   · Bajos: relieve gris + profundidad del bajo en azul.
//   · Curvas de nivel blancas con halo oscuro (se leen sobre cualquier
//     color); las maestras (cada 5) más gruesas y con la cota.
// Exporta curvas (GeoJSON / KML) y la grilla (CSV), todo armado en el
// navegador con lo que ya bajó.
//
// Script clásico: expone window.LoteAltimetria (panel EJS; la PWA lo puede
// reusar). Necesita Leaflet (L) y Auth (Auth.get) cargados antes.
(function () {
  "use strict";

  const TILE = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  // Rampas (dataviz: secuencial = un tono, claro → oscuro).
  const AZUL = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  const NARANJA = ["#fbe3d6", "#f7c3a5", "#f29a6e", "#eb6834", "#c9501f", "#9a3b14", "#6e2a0e"];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const xml = (s) => String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  const slug = (s) => String(s || "lote").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "lote";
  const num = (v, d = 1) => (v == null || isNaN(v) ? "–" : Number(v).toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }));

  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const AZUL_RGB = AZUL.map(hexRgb), NARANJA_RGB = NARANJA.map(hexRgb);
  function rampa(rgbs, t) {
    t = Math.max(0, Math.min(1, t));
    const x = t * (rgbs.length - 1), i = Math.min(rgbs.length - 2, Math.floor(x)), f = x - i;
    const a = rgbs[i], b = rgbs[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }

  /* ── Decodificar la grilla ─────────────────────────────── */
  function decodificar(g) {
    const N = g.nx * g.ny;
    const bin = atob(g.z), dv = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
    const z = new Float32Array(N);
    for (let i = 0; i < N; i++) { const v = dv.getUint16(2 * i, true); z[i] = v === g.nulo ? NaN : g.z_base + v * g.z_escala; }
    const bb = atob(g.bajos_cm), bajos = new Uint8Array(N);
    for (let i = 0; i < N; i++) bajos[i] = bb.charCodeAt(i);
    return { z, bajos };
  }

  // Igual que pendientes() de lib/planimetria.js (fila 0 = norte).
  function pendientes(z, nx, ny, res) {
    const p = new Float32Array(nx * ny).fill(NaN);
    const val = (r, c) => (r < 0 || c < 0 || r >= ny || c >= nx) ? NaN : z[r * nx + c];
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      const v = z[r * nx + c]; if (isNaN(v)) continue;
      const e = val(r, c + 1), w = val(r, c - 1), n = val(r - 1, c), s = val(r + 1, c);
      let dx, dy;
      if (!isNaN(e) && !isNaN(w)) dx = (e - w) / (2 * res); else if (!isNaN(e)) dx = (e - v) / res; else if (!isNaN(w)) dx = (v - w) / res; else continue;
      if (!isNaN(n) && !isNaN(s)) dy = (n - s) / (2 * res); else if (!isNaN(n)) dy = (n - v) / res; else if (!isNaN(s)) dy = (v - s) / res; else continue;
      p[r * nx + c] = 100 * Math.hypot(dx, dy);
    }
    return p;
  }

  // Relieve sombreado (sol del NO a 45°), 0..1.
  function sombra(z, nx, ny, res) {
    const out = new Float32Array(nx * ny).fill(1);
    const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180, exag = 8;
    const val = (r, c, v0) => { if (r < 0 || c < 0 || r >= ny || c >= nx) return v0; const v = z[r * nx + c]; return isNaN(v) ? v0 : v; };
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
      const v = z[r * nx + c]; if (isNaN(v)) continue;
      const dzdx = (val(r, c + 1, v) - val(r, c - 1, v)) / (2 * res) * exag;
      const dzdy = (val(r - 1, c, v) - val(r + 1, c, v)) / (2 * res) * exag;
      const pend = Math.atan(Math.hypot(dzdx, dzdy)), aspecto = Math.atan2(dzdy, -dzdx);
      const h = Math.sin(alt) * Math.cos(pend) + Math.cos(alt) * Math.sin(pend) * Math.cos(az - Math.PI / 2 - aspecto);
      out[r * nx + c] = Math.max(0, Math.min(1, h));
    }
    return out;
  }

  function percentil(arr, q) {
    const v = Array.from(arr).filter((x) => !isNaN(x)).sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : 0;
  }

  /* ── Exportar ──────────────────────────────────────────── */
  function descargar(nombre, texto, tipo) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texto], { type: tipo }));
    a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function kmlCurvas(lote, data) {
    const inter = data.curvas.properties?.intervalo_m ?? data.params?.intervalo;
    const marcas = data.curvas.features.map((f) => {
      const lineas = f.geometry.coordinates.map((l) => `<LineString><tessellate>1</tessellate><coordinates>${l.map(([lo, la]) => `${lo},${la},0`).join(" ")}</coordinates></LineString>`).join("");
      return `<Placemark><name>${num(f.properties.elev, 2)} m</name><styleUrl>#${f.properties.maestra ? "maestra" : "curva"}</styleUrl><ExtendedData><Data name="altura_m"><value>${f.properties.elev}</value></Data></ExtendedData><MultiGeometry>${lineas}</MultiGeometry></Placemark>`;
    }).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>${xml(lote)} · curvas de nivel cada ${Math.round(inter * 100)} cm</name>
<description>Agro Parallel · OrbitX · altimetría con RTK fijo de PilotX</description>
<Style id="curva"><LineStyle><color>ccffffff</color><width>1</width></LineStyle></Style>
<Style id="maestra"><LineStyle><color>ffffffff</color><width>2.5</width></LineStyle></Style>
${marcas}
</Document></kml>`;
  }

  function csvGrilla(st) {
    const g = st.data.grilla, [[S, W], [N, E]] = g.bounds;
    const dLat = (N - S) / g.ny, dLon = (E - W) / g.nx;
    const filas = ["lat,lon,altura_m,pendiente_pct,bajo_cm"];
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) {
      const i = r * g.nx + c, z = st.z[i];
      if (isNaN(z)) continue;
      const p = st.pend[i];
      filas.push(`${(N - (r + 0.5) * dLat).toFixed(7)},${(W + (c + 0.5) * dLon).toFixed(7)},${z.toFixed(2)},${isNaN(p) ? "" : p.toFixed(2)},${st.bajos[i] || 0}`);
    }
    return filas.join("\n");
  }

  /* ── Widget ────────────────────────────────────────────── */
  // opts: { lote, estab?, avisar?(msg, tipo) }
  function montar(el, opts) {
    const st = { capa: "altura", relieve: true, curvas: "auto", res: 3, data: null, mapa: null, capas: [], lote: opts.lote };
    const id = "alt-" + Math.random().toString(36).slice(2, 8);
    el.innerHTML = `
      <div class="alt-ctrl" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
        <div style="display:flex;border:1px solid var(--ap-border);border-radius:8px;overflow:hidden" role="group" aria-label="Capa">
          ${[["altura", "Altura"], ["pendiente", "Pendiente"], ["bajos", "Bajos"]].map(([k, t]) =>
            `<button type="button" data-capa="${k}" class="btn btn-sm" style="border:none;border-radius:0">${t}</button>`).join("")}
        </div>
        <label style="font-size:11px;color:var(--ap-muted)">Curvas
          <select data-k="curvas" style="margin-left:4px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:6px;font-size:11px">
            ${[["auto", "automático"], [0.05, "5 cm"], [0.1, "10 cm"], [0.2, "20 cm"], [0.25, "25 cm"], [0.5, "50 cm"], [0, "sin curvas"]].map(([v, t]) => `<option value="${v}" ${v === "auto" ? "selected" : ""}>${t}</option>`).join("")}
          </select></label>
        <label style="font-size:11px;color:var(--ap-muted)">Celda
          <select data-k="res" style="margin-left:4px;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:6px;font-size:11px">
            ${[2, 3, 5].map((v) => `<option value="${v}" ${v === 3 ? "selected" : ""}>${v} m</option>`).join("")}
          </select></label>
        <label style="font-size:11px;color:var(--ap-muted);display:flex;align-items:center;gap:4px;cursor:pointer">
          <input type="checkbox" data-k="relieve" checked> Relieve</label>
      </div>
      <div style="position:relative">
        <div id="${id}" style="height:340px;border-radius:8px;overflow:hidden;background:#000"></div>
        <div data-k="hover" style="position:absolute;top:8px;right:8px;z-index:500;background:rgba(18,22,24,.86);color:#fff;padding:6px 9px;border-radius:6px;font-size:11px;line-height:1.5;pointer-events:none;display:none"></div>
        <div data-k="cargando" style="position:absolute;inset:0;z-index:600;display:flex;align-items:center;justify-content:center;background:rgba(18,22,24,.55);color:#fff;font-size:12px;border-radius:8px"><span class="spinner" style="width:14px;height:14px;margin-right:8px"></span>Calculando altimetría…</div>
      </div>
      <div data-k="leyenda" style="margin:8px 0 12px"></div>
      <div data-k="stats"></div>
      <div data-k="bajos"></div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <div style="font-size:10px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Exportar</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn btn-ghost btn-sm" data-exp="geojson">Curvas GeoJSON</button>
          <button type="button" class="btn btn-ghost btn-sm" data-exp="kml">Curvas KML</button>
          <button type="button" class="btn btn-ghost btn-sm" data-exp="csv">Grilla CSV</button>
        </div>
      </div>`;
    const $ = (sel) => el.querySelector(sel);

    function marcarCapa() {
      el.querySelectorAll("[data-capa]").forEach((b) => {
        const on = b.dataset.capa === st.capa;
        b.className = "btn btn-sm " + (on ? "btn-primary" : "btn-ghost");
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    el.querySelectorAll("[data-capa]").forEach((b) => b.addEventListener("click", () => { st.capa = b.dataset.capa; marcarCapa(); dibujar(); }));
    $('[data-k="relieve"]').addEventListener("change", (e) => { st.relieve = e.target.checked; dibujar(); });
    $('[data-k="curvas"]').addEventListener("change", (e) => {
      const v = e.target.value;
      if (v === "0") { st.curvas = 0; dibujar(); return; }   // apagar curvas no recalcula
      st.curvas = v === "auto" ? "auto" : +v; cargar();
    });
    $('[data-k="res"]').addEventListener("change", (e) => { st.res = +e.target.value; cargar(); });
    el.querySelectorAll("[data-exp]").forEach((b) => b.addEventListener("click", () => exportar(b.dataset.exp)));
    marcarCapa();

    function initMapa() {
      if (st.mapa) { st.mapa.invalidateSize(); return; }
      st.mapa = L.map(id, { zoomControl: true, attributionControl: false, zoomSnap: 0.25 });
      L.tileLayer(TILE, { maxNativeZoom: 17, maxZoom: 21 }).addTo(st.mapa);
      st.mapa.setView([-34.6, -60], 6);
      st.mapa.on("mousemove", (e) => mostrarValor(e.latlng));
      st.mapa.on("mouseout", () => { $('[data-k="hover"]').style.display = "none"; });
    }

    function celdaEn(latlng) {
      const g = st.data?.grilla; if (!g) return -1;
      const [[S, W], [N, E]] = g.bounds;
      const c = Math.floor((latlng.lng - W) / (E - W) * g.nx), r = Math.floor((N - latlng.lat) / (N - S) * g.ny);
      return (c < 0 || r < 0 || c >= g.nx || r >= g.ny) ? -1 : r * g.nx + c;
    }
    function mostrarValor(latlng) {
      const box = $('[data-k="hover"]'), i = celdaEn(latlng);
      if (i < 0 || isNaN(st.z[i])) { box.style.display = "none"; return; }
      box.innerHTML = `Altura <b>${num(st.z[i], 2)} m</b><br>Pendiente <b>${num(st.pend[i], 2)} %</b>${st.bajos[i] ? `<br>Bajo <b>${st.bajos[i]} cm</b> de agua` : ""}`;
      box.style.display = "block";
    }

    function dibujar() {
      if (!st.data || !st.mapa) return;
      const g = st.data.grilla, N = g.nx * g.ny;
      st.capas.forEach((c) => st.mapa.removeLayer(c)); st.capas = [];
      const cv = document.createElement("canvas"); cv.width = g.nx; cv.height = g.ny;
      const ctx = cv.getContext("2d"), img = ctx.createImageData(g.nx, g.ny), px = img.data;
      // Escala robusta (p2–p98) para que un punto loco no aplaste los colores.
      let lo, hi, ley;
      if (st.capa === "pendiente") { lo = 0; hi = Math.max(0.5, st.p98p); ley = { rgbs: NARANJA, lo, hi, u: "%", d: 1, titulo: "Pendiente" }; }
      else if (st.capa === "bajos") { lo = 0; hi = Math.max(5, st.bajoMax); ley = { rgbs: AZUL, lo, hi, u: "cm", d: 0, titulo: "Profundidad del bajo" }; }
      else { lo = st.p02; hi = st.p98; ley = { rgbs: [...AZUL].reverse(), lo, hi, u: "m", d: 2, titulo: "Altura" }; }
      for (let i = 0; i < N; i++) {
        const z = st.z[i]; if (isNaN(z)) continue;
        const k = st.relieve || st.capa === "bajos" ? 0.55 + 0.45 * st.sombra[i] : 1;
        let rgb;
        if (st.capa === "pendiente") rgb = isNaN(st.pend[i]) ? [150, 150, 150] : rampa(NARANJA_RGB, (st.pend[i] - lo) / (hi - lo));
        else if (st.capa === "bajos") rgb = st.bajos[i] ? rampa(AZUL_RGB, 0.25 + 0.75 * st.bajos[i] / hi) : [205, 207, 200];
        else rgb = rampa(AZUL_RGB, 1 - (z - lo) / (hi - lo));   // claro = alto
        const f = st.capa === "bajos" && st.bajos[i] ? 1 : k;
        px[4 * i] = rgb[0] * f; px[4 * i + 1] = rgb[1] * f; px[4 * i + 2] = rgb[2] * f; px[4 * i + 3] = 225;
      }
      ctx.putImageData(img, 0, 0);
      const ov = L.imageOverlay(cv.toDataURL(), g.bounds, { opacity: 0.88, interactive: false }).addTo(st.mapa);
      st.capas.push(ov);
      if (st.curvas !== 0 && st.data.curvas.features.length) {
        const estilo = (f, halo) => ({ color: halo ? "#000" : "#fff", opacity: halo ? 0.35 : 0.9,
          weight: (f.properties.maestra ? 2.2 : 0.9) + (halo ? 1.6 : 0), interactive: !halo });
        st.capas.push(L.geoJSON(st.data.curvas, { style: (f) => estilo(f, true) }).addTo(st.mapa));
        const top = L.geoJSON(st.data.curvas, { style: (f) => estilo(f, false),
          onEachFeature: (f, l) => l.bindTooltip(`${num(f.properties.elev, 2)} m`, { sticky: true }) }).addTo(st.mapa);
        st.capas.push(top);
        // Cota en el medio de la línea más larga de cada maestra.
        st.data.curvas.features.filter((f) => f.properties.maestra).forEach((f) => {
          const l = f.geometry.coordinates.reduce((a, b) => (b.length > a.length ? b : a), []);
          if (l.length < 8) return;
          const [lo2, la2] = l[l.length >> 1];
          st.capas.push(L.marker([la2, lo2], { interactive: false, icon: L.divIcon({ className: "",
            html: `<span style="font-size:10px;color:#fff;text-shadow:0 0 3px #000,0 0 2px #000;white-space:nowrap">${num(f.properties.elev, 1)}</span>` }) }).addTo(st.mapa));
        });
      }
      (st.data.bajos || []).slice(0, 20).forEach((b, k) => {
        if (st.capa !== "bajos") return;
        st.capas.push(L.circleMarker([b.lat, b.lon], { radius: 5, color: "#fff", weight: 2, fillColor: "#0d366b", fillOpacity: 1 })
          .bindTooltip(`Bajo ${k + 1}: ${b.prof_max_cm} cm · ${num(b.area_m2 / 1e4, 2)} ha · ${num(b.volumen_m3, 0)} m³`).addTo(st.mapa));
      });
      leyenda(ley);
    }

    function leyenda({ rgbs, lo, hi, u, d, titulo }) {
      const grad = `linear-gradient(90deg, ${rgbs.join(",")})`;
      $('[data-k="leyenda"]').innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-size:11px;color:var(--ap-muted)">
          <span style="min-width:120px">${titulo}${st.data.curvas.features.length && st.curvas !== 0 ? ` · curvas cada ${Math.round(st.data.curvas.properties.intervalo_m * 100)} cm` : ""}</span>
          <span>${num(lo, d)} ${u}</span>
          <span style="flex:1;height:10px;border-radius:5px;background:${grad};border:1px solid var(--border)"></span>
          <span>${num(hi, d)} ${u}</span>
        </div>`;
    }

    function stats() {
      const s = st.data.stats || {}, n = s.nivelacion || {};
      const tarjeta = (titulo, valor, sub) => `
        <div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">
          <div style="font-family:var(--font-m);font-size:17px;color:var(--text)">${valor}</div>
          <div style="font-size:11px;color:var(--text);margin-top:3px">${titulo}</div>
          <div style="font-size:9px;color:var(--muted2);margin-top:1px">${sub}</div>
        </div>`;
      $('[data-k="stats"]').innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
          ${tarjeta("Desnivel", `${num(s.desnivel_m, 2)} <span style="font-size:11px;color:var(--muted2)">m</span>`, `${num(s.z_min_m, 2)} – ${num(s.z_max_m, 2)} m`)}
          ${tarjeta("Pendiente", `${num(s.pendiente_media_pct, 2)} <span style="font-size:11px;color:var(--muted2)">%</span>`, `media · 90 % del lote bajo ${num(s.pendiente_p90_pct, 1)} %`)}
          ${tarjeta("Bajos", `${s.bajos_cantidad ?? 0}`, `${num(s.bajos_area_ha, 2)} ha · ${num(s.bajos_volumen_m3, 0)} m³ de agua`)}
          ${tarjeta("Cubierto", s.cobertura_pct != null ? `${num(s.cobertura_pct, 0)} <span style="font-size:11px;color:var(--muted2)">%</span>` : `${num(s.area_cubierta_ha, 1)} <span style="font-size:11px;color:var(--muted2)">ha</span>`,
            s.cobertura_pct != null ? `${num(s.area_cubierta_ha, 1)} ha de ${num(s.limite_ha, 1)} ha del lote` : "con altura medida")}
          ${tarjeta("Puntos RTK", (s.puntos_usados || 0).toLocaleString("es-AR"), `${s.pasadas || 0} pasadas · cada ${num(s.espaciado_pasadas_m, 1)} m`)}
          ${tarjeta("Nivelación", n.aplicada ? `${num(n.sesgo_rms_antes_cm, 1)} → ${num(n.sesgo_rms_despues_cm, 1)}` : "–",
            n.aplicada ? "cm de diferencia entre pasadas" : esc(n.motivo || "no aplicada"))}
        </div>
        <div style="font-size:10px;color:var(--muted2);margin-top:6px">Solo puntos con RTK fijo · celda de ${num(st.data.params.res, 0)} m${st.data.calculado_ts ? " · calculado " + new Date(st.data.calculado_ts).toLocaleString("es-AR") : ""}</div>`;
      const b = st.data.bajos || [];
      $('[data-k="bajos"]').innerHTML = b.length ? `
        <div style="font-size:10px;color:var(--muted2);text-transform:uppercase;letter-spacing:1px;margin:14px 0 6px">Bajos donde se junta agua</div>
        ${b.slice(0, 5).map((x, k) => `
          <div class="capa-row" data-bajo="${k}" style="cursor:pointer">
            <span style="width:10px;height:10px;border-radius:50%;background:#0d366b;border:2px solid #fff;flex-shrink:0"></span>
            <span style="font-size:12px;color:var(--text)">Bajo ${k + 1}</span>
            <span class="td-dim" style="font-size:11px">${x.prof_max_cm} cm de profundidad · ${num(x.area_m2 / 1e4, 2)} ha · ${num(x.volumen_m3, 0)} m³</span>
          </div>`).join("")}` : "";
      el.querySelectorAll("[data-bajo]").forEach((row) => row.addEventListener("click", () => {
        const x = b[+row.dataset.bajo];
        st.capa = "bajos"; marcarCapa(); dibujar();
        st.mapa.setView([x.lat, x.lon], Math.max(st.mapa.getZoom(), 17));
      }));
    }

    async function cargar() {
      initMapa();
      const carg = $('[data-k="cargando"]');
      carg.style.display = "flex";
      try {
        const q = new URLSearchParams({ res: st.res, curvas: st.curvas || "auto" });
        if (opts.estab) q.set("estab", opts.estab);
        const data = await Auth.get(`/api/aog/lotes/${encodeURIComponent(st.lote)}/planimetria?${q}`);
        const primera = !st.data;
        st.data = data;
        const g = data.grilla, dec = decodificar(g);
        st.z = dec.z; st.bajos = dec.bajos;
        st.pend = pendientes(st.z, g.nx, g.ny, g.res);
        st.sombra = sombra(st.z, g.nx, g.ny, g.res);
        st.p02 = percentil(st.z, 0.02); st.p98 = percentil(st.z, 0.98);
        if (!(st.p98 > st.p02)) st.p98 = st.p02 + 0.01;
        st.p98p = percentil(st.pend, 0.98);
        st.bajoMax = st.bajos.reduce((a, b) => Math.max(a, b), 0);
        st.mapa.invalidateSize();
        if (primera) {
          st.mapa.fitBounds(g.bounds, { padding: [10, 10] });
          // El modal puede terminar de acomodarse después: reencuadrar.
          setTimeout(() => { if (st.mapa) { st.mapa.invalidateSize(); st.mapa.fitBounds(g.bounds, { padding: [10, 10] }); } }, 250);
        }
        dibujar(); stats();
      } catch (e) {
        el.innerHTML = `<div class="empty-state" style="padding:30px"><p>${esc(e.message)}</p>
          <p style="font-size:11px;color:var(--muted2);margin-top:8px">Las alturas las registra PilotX solo con RTK fijo, mientras se trabaja el lote, y se suben solas a OrbitX.</p></div>`;
        if (st.mapa) { st.mapa.remove(); st.mapa = null; }
        return;
      } finally { const c = $('[data-k="cargando"]'); if (c) c.style.display = "none"; }
    }

    function exportar(tipo) {
      if (!st.data) return;
      const base = `altimetria_${slug(st.lote)}`;
      const cm = Math.round((st.data.curvas.properties?.intervalo_m || st.curvas) * 100);
      if (tipo === "geojson") descargar(`${base}_curvas_${cm}cm.geojson`, JSON.stringify(st.data.curvas), "application/geo+json");
      else if (tipo === "kml") descargar(`${base}_curvas_${cm}cm.kml`, kmlCurvas(st.lote, st.data), "application/vnd.google-earth.kml+xml");
      else if (tipo === "csv") descargar(`${base}_grilla_${st.data.params.res}m.csv`, csvGrilla(st), "text/csv");
      opts.avisar && opts.avisar("Archivo descargado", "ok");
    }

    // Leaflet necesita el contenedor visible para medir: el que monta llama
    // después de mostrar la pestaña.
    setTimeout(cargar, 30);
    return {
      refrescarTamano() { if (st.mapa) st.mapa.invalidateSize(); },
      destruir() { if (st.mapa) { st.mapa.remove(); st.mapa = null; } el.innerHTML = ""; },
    };
  }

  // Nombres internos expuestos para poder probarlos sin navegador.
  window.LoteAltimetria = { montar, _interno: { decodificar, pendientes, kmlCurvas, csvGrilla, rampa } };
})();
