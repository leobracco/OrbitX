// vistax-mapas.js — Viewer cloud-side de sesiones VistaX (SHP + DBF).
// Lee los shapefiles sincronizados desde AOG (subtipo vistax_shp/vistax_log)
// vía /api/aog/vistax-sesiones + /api/aog/archivo (que devuelve contenido_base64),
// decodifica el SHP (Point) y el DBF en el navegador, y renderea con Leaflet.
//
// Soporta:
//   - SHP shapeType 1 (Point)        → renderiza CircleMarker coloreado por SPM
//   - SHP shapeType 5 (Polygon)      → TODO para heatmap; placeholder por ahora
// Sin dependencias npm: parser SHP+DBF embebido (minimalista, ~150 líneas).

let _mapa = null;
let _capaPuntos = null;
let _sesiones = [];

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

// ── Parser SHP (sólo Point) ────────────────────────────────────
// Spec: ESRI Shapefile Technical Description (julio 1998).
// File header: 100 bytes. Record header: 8 bytes (rec#, content len) big-endian.
// Record body para Point: shapeType i32 LE = 1 ; X f64 LE ; Y f64 LE.
function parseShpPoints(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 100) return [];
  const shapeType = dv.getInt32(32, true);
  if (shapeType !== 1) {
    console.warn("[VistaX] SHP shapeType", shapeType, "- viewer sólo soporta Point (1)");
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

// ── Renderiza sesión seleccionada ──────────────────────────────
async function renderSesion(ts) {
  const sesion = _sesiones.find(s => s.ts === ts);
  if (!sesion) return;

  const info = document.getElementById("vxm-info");
  info.textContent = "Descargando shapefile...";
  if (_capaPuntos) { _mapa.removeLayer(_capaPuntos); _capaPuntos = null; }

  try {
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
    info.textContent =
      `${pts.length.toLocaleString("es-AR")} puntos · SPM promedio ${avgSpm}` +
      (sesion.heatmap && sesion.heatmap.shp
        ? " · TODO: render heatmap (Polygon parser pendiente)"
        : "");
  } catch (e) {
    console.error("[VistaX Mapas] render:", e);
    info.textContent = "Error: " + e.message;
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
