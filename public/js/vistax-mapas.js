// vistax-mapas.js — Viewer cloud-side de sesiones VistaX (SHP + DBF).
// Lee los shapefiles sincronizados desde AOG (subtipo vistax_shp/vistax_log)
// vía /api/aog/vistax-sesiones + /api/aog/archivo (que devuelve contenido_base64),
// decodifica el SHP (Point/Polygon) y el DBF en el navegador, y renderea con Leaflet.
//
// Soporta:
//   - SHP shapeType 1 (Point)        → renderiza CircleMarker coloreado por SPM
//   - SHP shapeType 5 (Polygon)      → renderiza celdas de heatmap coloreadas por clase
// Sin dependencias npm: parser SHP+DBF embebido (minimalista, ~200 líneas).

let _mapa = null;
let _capaPuntos = null;
let _capaHeatmap = null;
let _capaActiva = "puntos";      // "puntos" | "heatmap"
let _sesiones = [];
let _sesionActual = null;
let _heatmapCargado = false;     // evita re-parsear el mismo SHP si el usuario toggle-a de ida y vuelta

// ── Map init ────────────────────────────────────────────────────
function initMapa() {
  if (_mapa) return;
  _mapa = L.map("vxm-mapa", { zoomControl: true, preferCanvas: true })
           .setView([-34.6, -60.0], 8);
  const MAX_NATIVE = 18;
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Esri World Imagery", maxZoom: 22, maxNativeZoom: MAX_NATIVE,
  }).addTo(_mapa);
  L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 22, maxNativeZoom: MAX_NATIVE, opacity: 0.6,
  }).addTo(_mapa);
}

// ── Color por SPM (mismo gradient que vistax-mapa.js) ──────────
function colorSPM(spm) {
  if (!spm || spm <= 0) return "#ff1744";
  if (spm < 4) return "#ff9100";
  if (spm < 7) return "#ffea00";
  if (spm < 10) return "#76ff03";
  return "#00e676";
}

// ── Color por clase de heatmap (ver VistaXFieldLogger.ExportHeatmapShapefile) ──
// 0 = sin datos, 1 = bueno, 2 = medio, 3 = bajo, 4 = falla
function colorClase(clase) {
  switch (clase) {
    case 1: return "#00e676";
    case 2: return "#ffea00";
    case 3: return "#ff9100";
    case 4: return "#ff1744";
    default: return "#888888";
  }
}

// ── Parser SHP (sólo Point) ────────────────────────────────────
// Spec: ESRI Shapefile Technical Description (julio 1998).
// File header: 100 bytes. Record header: 8 bytes (rec#, content len) big-endian.
// Record body para Point: shapeType i32 LE = 1 ; X f64 LE ; Y f64 LE.
function parseShpPoints(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 100) return [];
  const shapeType = dv.getInt32(32, true);
  if (shapeType !== 1) {
    console.warn("[VistaX] SHP shapeType", shapeType, "- parseShpPoints sólo soporta Point (1)");
    return [];
  }
  const pts = [];
  let off = 100;
  while (off + 8 <= buf.byteLength) {
    // recNum BE, contentLen BE (en palabras de 16 bits)
    const contentLen = dv.getInt32(off + 4, false) * 2;
    if (off + 8 + contentLen > buf.byteLength) break;
    const recType = dv.getInt32(off + 8, true);
    if (recType === 1) {
      const x = dv.getFloat64(off + 12, true);
      const y = dv.getFloat64(off + 20, true);
      pts.push({ lon: x, lat: y });
    }
    off += 8 + contentLen;
  }
  return pts;
}

// ── Parser SHP (sólo Polygon, shapeType 5) ─────────────────────
// Usado para el heatmap: cada feature es un anillo rectangular simple
// (una sola parte), producido por VistaXFieldLogger.ExportHeatmapShapefile.
// Record body: shapeType i32 LE=5 ; Box[4] f64 LE ; NumParts i32 ;
// NumPoints i32 ; Parts[NumParts] i32 (índices) ; Points[NumPoints] (X,Y f64 LE).
function parseShpPolygons(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 100) return [];
  const shapeType = dv.getInt32(32, true);
  if (shapeType !== 5) {
    console.warn("[VistaX] SHP shapeType", shapeType, "- parseShpPolygons sólo soporta Polygon (5)");
    return [];
  }
  const polys = [];
  let off = 100;
  while (off + 8 <= buf.byteLength) {
    const contentLen = dv.getInt32(off + 4, false) * 2; // bytes
    const recStart = off + 8;
    if (recStart + contentLen > buf.byteLength) break;
    const recType = dv.getInt32(recStart, true);
    if (recType === 5) {
      const numParts  = dv.getInt32(recStart + 36, true);
      const numPoints = dv.getInt32(recStart + 40, true);
      const partsOff  = recStart + 44;
      const parts = [];
      for (let i = 0; i < numParts; i++) parts.push(dv.getInt32(partsOff + i * 4, true));
      const ptsOff = partsOff + numParts * 4;
      const allPts = [];
      for (let i = 0; i < numPoints; i++) {
        const x = dv.getFloat64(ptsOff + i * 16, true);
        const y = dv.getFloat64(ptsOff + i * 16 + 8, true);
        allPts.push([y, x]); // [lat, lon] para Leaflet
      }
      // Separar en anillos según `parts`.
      const rings = [];
      for (let p = 0; p < numParts; p++) {
        const start = parts[p];
        const end = p + 1 < numParts ? parts[p + 1] : numPoints;
        rings.push(allPts.slice(start, end));
      }
      polys.push({ rings });
    }
    off = recStart + contentLen;
  }
  return polys;
}

// ── Parser DBF (xBase III) ─────────────────────────────────────
// Header: 32 bytes. Luego field descriptors de 32 bytes hasta 0x0D.
// Cada record empieza con un byte de delete flag (0x20 vivo, 0x2A borrado).
function parseDbf(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 33) return [];
  const numRec      = dv.getUint32(4, true);
  const headerLen   = dv.getUint16(8, true);
  const recordLen   = dv.getUint16(10, true);
  const fields = [];
  let p = 32;
  const td = new TextDecoder("latin1");
  while (p < headerLen - 1) {
    const term = dv.getUint8(p);
    if (term === 0x0D) break;
    // Nombre: 11 bytes null-padded
    let name = "";
    for (let i = 0; i < 11; i++) {
      const c = dv.getUint8(p + i);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    const type = String.fromCharCode(dv.getUint8(p + 11));
    const len  = dv.getUint8(p + 16);
    fields.push({ name: name.trim(), type, len });
    p += 32;
  }
  const out = [];
  let rec = headerLen;
  for (let i = 0; i < numRec; i++) {
    if (rec + recordLen > buf.byteLength) break;
    const flag = dv.getUint8(rec);
    if (flag !== 0x2A) { // 0x2A = borrado
      const r = {};
      let off = rec + 1;
      for (const f of fields) {
        const bytes = new Uint8Array(buf, off, f.len);
        const s = td.decode(bytes).trim();
        if (f.type === "N" || f.type === "F") {
          const v = parseFloat(s);
          r[f.name] = isNaN(v) ? null : v;
        } else {
          r[f.name] = s;
        }
        off += f.len;
      }
      out.push(r);
    }
    rec += recordLen;
  }
  return out;
}

// ── Base64 → ArrayBuffer ───────────────────────────────────────
function b64ToBuf(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

// ── Fetch helpers ──────────────────────────────────────────────
async function fetchArchivoBuf(ruta_rel) {
  const j = await Auth.get(`/api/aog/archivo?ruta=${encodeURIComponent(ruta_rel)}`);
  if (!j || !j.contenido_base64) throw new Error("archivo sin contenido_base64: " + ruta_rel);
  return b64ToBuf(j.contenido_base64);
}

// ── Formato de tamaño (bytes → KB/MB legible) ───────────────────
function fmtTamano(bytes) {
  if (!bytes) return "0 KB";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

// ── Carga lista de sesiones ────────────────────────────────────
async function cargarSesiones() {
  const sel = document.getElementById("vxm-sesion");
  sel.innerHTML = '<option value="">Cargando...</option>';
  try {
    _sesiones = await Auth.get("/api/aog/vistax-sesiones");
    if (!_sesiones || _sesiones.length === 0) {
      sel.innerHTML = '<option value="">Sin sesiones sincronizadas</option>';
      document.getElementById("vxm-info").textContent =
        "Todavía no hay shapefiles VistaX en este establecimiento. " +
        "Cuando AOG termine una siembra, el sync empuja los .shp/.dbf y aparecen acá.";
      return;
    }
    sel.innerHTML = '<option value="">— Elegí una sesión —</option>' +
      _sesiones.map(s => {
        const fecha = new Date(s.fecha).toLocaleString("es-AR", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" });
        const lote  = s.lote ? ` · ${s.lote}` : "";
        const hm    = (s.heatmap && s.heatmap.shp) ? " · +heatmap" : "";
        return `<option value="${s.ts}">${fecha}${lote}${hm}</option>`;
      }).join("");
    document.getElementById("vxm-info").textContent =
      `${_sesiones.length} sesión${_sesiones.length !== 1 ? "es" : ""} disponible${_sesiones.length !== 1 ? "s" : ""}.`;
  } catch (e) {
    console.error("[VistaX Mapas]", e);
    sel.innerHTML = '<option value="">Error cargando</option>';
    document.getElementById("vxm-info").textContent = "Error: " + e.message;
  }
}

// ── Renderiza los puntos por surco (capa por default) ───────────
async function renderPuntos(sesion) {
  const info = document.getElementById("vxm-info");
  info.textContent = "Descargando shapefile de puntos...";
  if (_capaPuntos) { _mapa.removeLayer(_capaPuntos); _capaPuntos = null; }

  const shpBuf = await fetchArchivoBuf(sesion.puntos.shp);
  let dbfRecs = null;
  if (sesion.puntos.dbf) {
    try {
      const dbfBuf = await fetchArchivoBuf(sesion.puntos.dbf);
      dbfRecs = parseDbf(dbfBuf);
    } catch (e) { console.warn("[VistaX Mapas] DBF parse:", e.message); }
  }
  const pts = parseShpPoints(shpBuf);
  if (pts.length === 0) {
    info.textContent = "El SHP no tiene puntos (¿formato no soportado?).";
    return;
  }

  const markers = [];
  let nSpm = 0, sumSpm = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const attr = dbfRecs && dbfRecs[i] ? dbfRecs[i] : {};
    const spm = attr.spm != null ? attr.spm : null;
    if (spm != null) { nSpm++; sumSpm += spm; }
    const surco = attr.surco != null ? attr.surco : "?";
    const kmh = attr.vel_kmh != null ? attr.vel_kmh.toFixed(1) : "?";
    const m = L.circleMarker([p.lat, p.lon], {
      radius: 2.5, color: colorSPM(spm), weight: 0,
      fillColor: colorSPM(spm), fillOpacity: 0.7,
    });
    m.bindTooltip(`surco ${surco} · ${kmh} km/h · spm ${spm != null ? spm.toFixed(1) : "?"}`,
                  { sticky: true, opacity: 0.9 });
    markers.push(m);
  }
  _capaPuntos = L.layerGroup(markers).addTo(_mapa);
  _mapa.fitBounds(L.featureGroup(markers).getBounds(), { padding: [20, 20] });

  const avgSpm = nSpm > 0 ? (sumSpm / nSpm).toFixed(2) : "—";
  info.textContent = `${pts.length.toLocaleString("es-AR")} puntos · SPM promedio ${avgSpm}`;
}

// ── Renderiza el heatmap (celdas, capa alternativa a demanda) ───
async function renderHeatmap(sesion) {
  const info = document.getElementById("vxm-info");
  if (!sesion.heatmap || !sesion.heatmap.shp) {
    info.textContent = "Esta sesión no tiene heatmap sincronizado.";
    return;
  }
  info.textContent = "Descargando heatmap...";
  if (_capaHeatmap) { _mapa.removeLayer(_capaHeatmap); _capaHeatmap = null; }

  const shpBuf = await fetchArchivoBuf(sesion.heatmap.shp);
  let dbfRecs = null;
  if (sesion.heatmap.dbf) {
    try {
      const dbfBuf = await fetchArchivoBuf(sesion.heatmap.dbf);
      dbfRecs = parseDbf(dbfBuf);
    } catch (e) { console.warn("[VistaX Mapas] DBF heatmap parse:", e.message); }
  }
  const polys = parseShpPolygons(shpBuf);
  if (polys.length === 0) {
    info.textContent = "El SHP de heatmap no tiene celdas (¿formato no soportado?).";
    return;
  }

  const cells = [];
  for (let i = 0; i < polys.length; i++) {
    const attr = dbfRecs && dbfRecs[i] ? dbfRecs[i] : {};
    const clase = attr.clase != null ? attr.clase : 0;
    const color = colorClase(clase);
    const poly = L.polygon(polys[i].rings, {
      color, weight: 0.5, opacity: 0.6,
      fillColor: color, fillOpacity: 0.55,
    });
    const spmAvg = attr.spm_avg != null ? attr.spm_avg.toFixed(1) : "?";
    const pctFall = attr.pct_fall != null ? attr.pct_fall.toFixed(0) : "?";
    poly.bindTooltip(`SPM prom ${spmAvg} · fallas ${pctFall}% · lecturas ${attr.lecturas || "?"}`,
                      { sticky: true, opacity: 0.9 });
    cells.push(poly);
  }
  _capaHeatmap = L.layerGroup(cells).addTo(_mapa);
  info.textContent = `${polys.length.toLocaleString("es-AR")} celdas de heatmap.`;
  _heatmapCargado = true;
}

// ── Toggle entre capa de puntos y heatmap ───────────────────────
async function mostrarCapa(tipo) {
  if (!_sesionActual || tipo === _capaActiva) return;
  _capaActiva = tipo;

  const btnPuntos  = document.getElementById("vxm-btn-puntos");
  const btnHeatmap = document.getElementById("vxm-btn-heatmap");
  btnPuntos.classList.toggle("btn-primary", tipo === "puntos");
  btnHeatmap.classList.toggle("btn-primary", tipo === "heatmap");

  if (_capaPuntos)  _mapa[tipo === "puntos"  ? "addLayer" : "removeLayer"](_capaPuntos);
  document.getElementById("vxm-leyenda").style.display = tipo === "puntos" ? "" : "none";
  document.getElementById("vxm-leyenda-heatmap").style.display = tipo === "heatmap" ? "" : "none";

  if (tipo === "heatmap") {
    if (!_heatmapCargado) {
      try { await renderHeatmap(_sesionActual); }
      catch (e) { console.error("[VistaX Mapas] heatmap:", e); document.getElementById("vxm-info").textContent = "Error: " + e.message; }
    } else if (_capaHeatmap) {
      _mapa.addLayer(_capaHeatmap);
    }
  } else if (_capaHeatmap) {
    _mapa.removeLayer(_capaHeatmap);
  }
}

// ── Lista de links de descarga individuales (no hay lib de zip) ─
function construirDescargas(sesion) {
  const cont = document.getElementById("vxm-descargas");
  const token = Auth.getToken ? Auth.getToken() : "";
  const rutas = [
    sesion.ndjson,
    sesion.puntos && sesion.puntos.shp, sesion.puntos && sesion.puntos.shx,
    sesion.puntos && sesion.puntos.dbf, sesion.puntos && sesion.puntos.prj,
    sesion.heatmap && sesion.heatmap.shp, sesion.heatmap && sesion.heatmap.shx,
    sesion.heatmap && sesion.heatmap.dbf, sesion.heatmap && sesion.heatmap.prj,
  ].filter(Boolean);
  if (rutas.length === 0) { cont.innerHTML = ""; return; }
  const links = rutas.map(r => {
    const nombre = r.split(/[/\\]/).pop();
    const href = `/api/aog/archivo/descarga?ruta=${encodeURIComponent(r)}&token=${encodeURIComponent(token || "")}`;
    return `<a href="${href}" download="${nombre}" style="color:var(--lime)">${nombre}</a>`;
  }).join(" · ");
  cont.innerHTML = `<strong>Descargar sesión</strong> (${rutas.length} archivo${rutas.length !== 1 ? "s" : ""}): ${links}`;
}

// ── Renderiza sesión seleccionada ──────────────────────────────
async function renderSesion(ts) {
  const sesion = _sesiones.find(s => s.ts === ts);
  if (!sesion) return;
  _sesionActual = sesion;
  _heatmapCargado = false;
  _capaActiva = "puntos";
  if (_capaHeatmap) { _mapa.removeLayer(_capaHeatmap); _capaHeatmap = null; }

  const btnPuntos  = document.getElementById("vxm-btn-puntos");
  const btnHeatmap = document.getElementById("vxm-btn-heatmap");
  btnPuntos.classList.add("btn-primary");
  btnHeatmap.classList.remove("btn-primary");
  btnHeatmap.disabled = !(sesion.heatmap && sesion.heatmap.shp);
  document.getElementById("vxm-leyenda").style.display = "";
  document.getElementById("vxm-leyenda-heatmap").style.display = "none";

  construirDescargas(sesion);

  try {
    await renderPuntos(sesion);
    const info = document.getElementById("vxm-info");
    const extra = [];
    if (sesion.archivos) extra.push(`${sesion.archivos} archivos`);
    if (sesion.tamano)   extra.push(fmtTamano(sesion.tamano));
    if (extra.length) info.textContent += ` · ${extra.join(" · ")}`;
  } catch (e) {
    console.error("[VistaX Mapas] render:", e);
    document.getElementById("vxm-info").textContent = "Error: " + e.message;
  }
}

// ── Boot ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  initMapa();
  await cargarSesiones();
  document.getElementById("vxm-sesion").addEventListener("change", (e) => {
    const ts = e.target.value;
    if (ts) renderSesion(ts);
  });
});
