// aplicado-mapas.js — mapa de calor de lo aplicado por lote.
//
// Datos: /api/aog/aplicado/datos?lote=X (ver routes/aog.js), que junta las
// partes NDJSON que sube PilotX:
//   tramos: [lat, lon, rumbo, dist, t, vel, [[canal, off, ancho, real, obj, frac], ...]]
//   surcos: [lat, lon, rumbo, dist, t, vel, [[surco, off, sem_m, sing, dob, fal], ...]]
// lat/lon es el CENTRO del tramo (la herramienta), rumbo 0 = norte, horario;
// off = metros a la DERECHA del rumbo. Cada canal/surco ocupa un rectángulo
// de ancho × largo del tramo. Dos vistas: mapa de calor (grilla suavizada,
// la de entrada) y Tramos (los rectángulos tal cual, para ver el dato crudo).

let _apm = { mapa: null, capaLeaflet: null, datos: null, capas: [], capa: null, modo: "desvio", vista: "calor", bounds: null, features: [] };

const APM_UNIDAD = { l_ha: "L/ha", kg_ha: "kg/ha", sem_m: "sem/m" };
const APM_GRIS = "#7d857e";
// Rampas CONTINUAS (posición 0..1 → color). Desvío: abajo rojo, en rango
// verde, arriba azul. Valor: de poco (rojo) a mucho (verde).
const APM_RAMPA_DESVIO = [[0, "#d7301f"], [0.25, "#fc8d59"], [0.42, "#4ABA3E"], [0.58, "#4ABA3E"], [0.75, "#74add1"], [1, "#4575b4"]];
const APM_RAMPA_VALOR = [[0, "#d7301f"], [0.25, "#fc8d59"], [0.5, "#fee08b"], [0.75, "#91cf60"], [1, "#1a9850"]];
const APM_RAMPA_INVERTIDA = APM_RAMPA_VALOR.map(([t, c]) => [1 - t, c]).reverse();
// Escalas fijas para los índices de VistaX (ISO 7256-1): lo "bueno" no
// depende del lote.
const APM_FIJAS = {
  sing: { dom: [85, 100], rampa: APM_RAMPA_VALOR },
  fal: { dom: [0, 12], rampa: APM_RAMPA_INVERTIDA },
  dob: { dom: [0, 12], rampa: APM_RAMPA_INVERTIDA },
};

function apmEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function apmNum(v, d) { return (v == null || isNaN(v)) ? "—" : Number(v).toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }); }

// ── Mapa ──────────────────────────────────────────────────────────
function apmInitMapa() {
  if (_apm.mapa) return;
  _apm.mapa = L.map("apm-mapa", { zoomControl: true, preferCanvas: true }).setView([-34.6, -60.0], 8);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Esri World Imagery", maxZoom: 22, maxNativeZoom: 18,
  }).addTo(_apm.mapa);
}

// Rectángulo de un canal: centro del tramo + off a la derecha, largo a lo
// largo del rumbo. Aproximación plana (de sobra para 10 m).
function apmRect(lat, lon, rumboDeg, off, ancho, largo) {
  const h = rumboDeg * Math.PI / 180;
  const rE = Math.cos(h), rN = -Math.sin(h);   // derecha
  const fE = Math.sin(h), fN = Math.cos(h);    // adelante
  const kLat = 1 / 111320, kLon = 1 / (111320 * Math.cos(lat * Math.PI / 180));
  const cE = off * rE, cN = off * rN;
  const a = ancho / 2, l = largo / 2;
  const p = (sf, sr) => [lat + (cN + sf * l * fN + sr * a * rN) * kLat, lon + (cE + sf * l * fE + sr * a * rE) * kLon];
  return [p(-1, -1), p(1, -1), p(1, 1), p(-1, 1)];
}

// ── Lotes ────────────────────────────────────────────────────────
async function apmCargarLotes() {
  const sel = document.getElementById("apm-lote");
  try {
    const lotes = await Auth.get("/api/aog/aplicado/lotes");
    if (!lotes || lotes.length === 0) {
      sel.innerHTML = '<option value="">Sin datos todavía</option>';
      document.getElementById("apm-info").textContent =
        "Todavía no hay registros de aplicación. PilotX los sube solos mientras se trabaja con un lote abierto (FlowX, QuantiX o VistaX).";
      return;
    }
    sel.innerHTML = '<option value="">— Elegí un lote —</option>' + lotes.map(l => {
      const f = l.ts_ultimo ? new Date(l.ts_ultimo).toLocaleDateString("es-AR") : "";
      const que = [l.aplicado ? "dosis" : "", l.vistax ? "VistaX" : ""].filter(Boolean).join(" + ");
      return `<option value="${apmEsc(l.lote)}">${apmEsc(l.lote)} · ${que}${f ? " · " + f : ""}</option>`;
    }).join("");
    const ultimo = localStorage.getItem("apm-lote");
    if (ultimo && lotes.some(l => l.lote === ultimo)) { sel.value = ultimo; apmCargarLote(ultimo); }
  } catch (e) {
    sel.innerHTML = '<option value="">Error cargando</option>';
    document.getElementById("apm-info").textContent = "Error: " + e.message;
  }
}

async function apmCargarLote(lote) {
  if (!lote) return;
  try { localStorage.setItem("apm-lote", lote); } catch {}
  document.getElementById("apm-info").textContent = "Cargando " + lote + "...";
  try {
    _apm.datos = await Auth.get("/api/aog/aplicado/datos?lote=" + encodeURIComponent(lote));
  } catch (e) {
    document.getElementById("apm-info").textContent = "Error: " + e.message;
    return;
  }
  apmArmarCapas();
  apmResumen();
  apmDibujar(true);
}

// ── Capas: un FlowX por nodo (todos sus cortes), un QuantiX por motor, VistaX por índice ──
function apmArmarCapas() {
  const d = _apm.datos, capas = [];
  const ids = new Set();
  d.tramos.forEach(t => t[6].forEach(c => ids.add(c[0])));
  const grupos = {};
  [...ids].sort().forEach(id => {
    const def = d.canales[id] || { prod: id.split(":")[0], nombre: id, unidad: "" };
    const partes = id.split(":");
    if (def.prod === "flowx") {
      const k = partes[0] + ":" + partes[1];
      const nombre = String(def.nombre || "FlowX").split(" · corte")[0];
      if (!grupos[k]) grupos[k] = { id: k, tipo: "aplicado", prod: "flowx", nombre: "FlowX · " + nombre, unidad: def.unidad, canales: [] };
      grupos[k].canales.push(id);
    } else {
      grupos[id] = { id, tipo: "aplicado", prod: def.prod, nombre: "QuantiX · " + (def.nombre || id), unidad: def.unidad, canales: [id] };
    }
  });
  Object.values(grupos).forEach(g => capas.push(g));
  if (d.surcos.length) {
    capas.push({ id: "vx:sem", tipo: "vistax", campo: 2, nombre: "VistaX · semillas por metro", unidad: "sem_m" });
    capas.push({ id: "vx:sing", tipo: "vistax", campo: 3, fija: "sing", nombre: "VistaX · singulación", unidad: "%" });
    capas.push({ id: "vx:fal", tipo: "vistax", campo: 5, fija: "fal", nombre: "VistaX · fallas", unidad: "%" });
    capas.push({ id: "vx:dob", tipo: "vistax", campo: 4, fija: "dob", nombre: "VistaX · dobles", unidad: "%" });
  }
  _apm.capas = capas;
  const sel = document.getElementById("apm-capa");
  sel.disabled = capas.length === 0;
  sel.innerHTML = capas.length
    ? capas.map(c => `<option value="${apmEsc(c.id)}">${apmEsc(c.nombre)}${APM_UNIDAD[c.unidad] ? " (" + APM_UNIDAD[c.unidad] + ")" : ""}</option>`).join("")
    : '<option value="">Sin capas</option>';
  _apm.capa = capas[0] || null;
}

function apmModo(m) {
  _apm.modo = m;
  document.getElementById("apm-modo-desvio").classList.toggle("btn-primary", m === "desvio");
  document.getElementById("apm-modo-valor").classList.toggle("btn-primary", m === "valor");
  apmDibujar(false);
}

// ── Elementos de la capa: [{ rect, valor, obj, popup, props }] ────
function apmElementos(capa) {
  const d = _apm.datos, out = [];
  if (capa.tipo === "aplicado") {
    const set = new Set(capa.canales);
    d.tramos.forEach(t => {
      const [lat, lon, rumbo, dist, ts, vel, cs] = t;
      cs.forEach(c => {
        const [id, off, ancho, real, obj, frac] = c;
        if (!set.has(id) || !(frac > 0) || !(ancho > 0)) return;
        const def = d.canales[id] || { nombre: id };
        const largo = Math.max(1, dist * Math.min(1, frac));
        out.push({
          rect: apmRect(lat, lon, rumbo, off, ancho, largo),
          geo: { lat, lon, rumbo, off, ancho, largo },
          centro: apmRect(lat, lon, rumbo, off, 0, 0)[0],
          valor: real, obj,
          props: { canal: def.nombre, unidad: def.unidad, real, objetivo: obj, fecha: ts, vel_kmh: vel },
        });
      });
    });
  } else {
    d.surcos.forEach(t => {
      const [lat, lon, rumbo, dist, ts, vel, ss] = t;
      // Ancho de cada surco = la menor distancia entre surcos vecinos.
      const offs = ss.map(s => s[1]).sort((a, b) => a - b);
      let paso = Infinity;
      for (let i = 1; i < offs.length; i++) { const dd = offs[i] - offs[i - 1]; if (dd > 0.05 && dd < paso) paso = dd; }
      if (!isFinite(paso)) paso = 0.52;
      ss.forEach(s => {
        const v = s[capa.campo];
        if (v == null) return;
        const largo = Math.max(1, dist);
        out.push({
          rect: apmRect(lat, lon, rumbo, s[1], paso, largo),
          geo: { lat, lon, rumbo, off: s[1], ancho: paso, largo },
          centro: apmRect(lat, lon, rumbo, s[1], 0, 0)[0],
          valor: v, obj: null,
          props: { surco: s[0], valor: v, unidad: capa.unidad, fecha: ts, vel_kmh: vel },
        });
      });
    });
  }
  return out;
}

// ── Escala de color de la capa (continua) ─────────────────────────
function apmHex(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
function apmRampa(rampa, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < rampa.length; i++) {
    if (t <= rampa[i][0]) {
      const [t0, c0] = rampa[i - 1], [t1, c1] = rampa[i];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0, a = apmHex(c0), b = apmHex(c1);
      return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
    }
  }
  return apmHex(rampa[rampa.length - 1][1]);
}

function apmPercentil(v, p) { return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]; }

// { val(e) → número | null, dom:[min,max], rampa, txt(número), titulo }
function apmEscala(capa, els) {
  const u = APM_UNIDAD[capa.unidad] || capa.unidad || "";
  if (capa.tipo === "aplicado" && _apm.modo === "desvio") {
    return {
      val: e => (e.valor != null && e.valor >= 0 && e.obj > 0) ? (e.valor - e.obj) / e.obj * 100 : null,
      dom: [-30, 30], rampa: APM_RAMPA_DESVIO,
      txt: x => (x > 0 ? "+" : "") + apmNum(x, 0) + " %", titulo: "Desvío del objetivo",
    };
  }
  const val = e => (e.valor != null && e.valor >= 0) ? e.valor : null;
  if (capa.fija) {
    const f = APM_FIJAS[capa.fija];
    return { val, dom: f.dom, rampa: f.rampa, txt: x => apmNum(x, 0) + " %", titulo: capa.nombre.replace("VistaX · ", "") };
  }
  // Valor: del percentil 5 al 95 del lote, así un pico suelto no aplasta la escala.
  const v = els.map(val).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  let lo = v.length ? apmPercentil(v, 0.05) : 0, hi = v.length ? apmPercentil(v, 0.95) : 1;
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const dec = capa.unidad === "sem_m" ? 1 : 0;
  return { val, dom: [lo, hi], rampa: APM_RAMPA_VALOR, txt: x => apmNum(x, dec) + " " + u, titulo: "Valor" };
}

function apmColor(esc, e) {
  const x = esc.val(e);
  if (x == null) return APM_GRIS;
  const c = apmRampa(esc.rampa, (x - esc.dom[0]) / (esc.dom[1] - esc.dom[0]));
  return "rgb(" + c.join(",") + ")";
}

function apmPopup(capa, e) {
  const p = e.props, u = APM_UNIDAD[p.unidad] || p.unidad || "";
  const hora = p.fecha ? new Date(p.fecha).toLocaleString("es-AR") : "";
  if (capa.tipo === "aplicado") {
    const real = p.real == null || p.real < 0 ? "sin lectura" : apmNum(p.real, 1) + " " + u;
    const dv = (p.real >= 0 && p.objetivo > 0) ? ((p.real - p.objetivo) / p.objetivo * 100) : null;
    return `<b>${apmEsc(p.canal)}</b><br>Real: ${real}<br>Objetivo: ${apmNum(p.objetivo, 1)} ${u}` +
      (dv != null ? `<br>Desvío: ${dv > 0 ? "+" : ""}${apmNum(dv, 1)} %` : "") +
      `<br><span style="color:#888">${hora} · ${apmNum(p.vel_kmh, 1)} km/h</span>`;
  }
  return `<b>Surco ${apmEsc(p.surco)}</b><br>${apmEsc(capa.nombre.replace("VistaX · ", ""))}: ${apmNum(p.valor, 1)} ${u}` +
    `<br><span style="color:#888">${hora} · ${apmNum(p.vel_kmh, 1)} km/h</span>`;
}

// ── Mapa de calor: grilla fina + suavizado gaussiano ──────────────
// Cada tramo se reparte en puntos de muestra sobre su rectángulo; se suman
// a una grilla de ~1 m y la grilla se suaviza con un gaussiano separable
// (rápido aunque el lote tenga millones de muestras). El color es el
// promedio suavizado de los valores; la transparencia sale de cuánta
// superficie trabajada hay alrededor, así el borde se desvanece en vez de
// cortar en escalones y lo no trabajado queda transparente.
const APM_MAX_CELDAS = 1.2e6;
const APM_SIGMA_M = 3;

function apmCalor(els, esc) {
  if (!els.length) return null;
  let lat0 = 0;
  els.forEach(e => { lat0 += e.geo.lat; });
  lat0 /= els.length;
  const ky = 111320, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const lon0 = els[0].geo.lon;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  els.forEach(e => e.rect.forEach(([la, lo]) => {
    const x = (lo - lon0) * kx, y = (la - lat0) * ky;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }));
  const margen = APM_SIGMA_M * 3;
  x0 -= margen; x1 += margen; y0 -= margen; y1 += margen;
  const cell = Math.max(1, Math.sqrt((x1 - x0) * (y1 - y0) / APM_MAX_CELDAS));
  const sigma = Math.max(APM_SIGMA_M, cell * 1.5);
  const W = Math.ceil((x1 - x0) / cell), H = Math.ceil((y1 - y0) / cell);
  const sv = new Float32Array(W * H), sw = new Float32Array(W * H), oc = new Float32Array(W * H);

  // 1. Muestras → grilla. Paso menor que la celda: un canal de 6 m cubre su
  //    ancho entero, un surco de 0,52 m deja su hilera.
  const paso = cell / 1.5;
  els.forEach(e => {
    const g = e.geo, x = esc.val(e);
    const h = g.rumbo * Math.PI / 180;
    const rE = Math.cos(h), rN = -Math.sin(h), fE = Math.sin(h), fN = Math.cos(h);
    const cx = (g.lon - lon0) * kx + g.off * rE, cy = (g.lat - lat0) * ky + g.off * rN;
    const nL = Math.max(1, Math.round(g.largo / paso)), nA = Math.max(1, Math.round(g.ancho / paso));
    const t = x == null ? null : Math.max(-0.2, Math.min(1.2, (x - esc.dom[0]) / (esc.dom[1] - esc.dom[0])));
    for (let i = 0; i < nL; i++) {
      const sl = ((i + 0.5) / nL - 0.5) * g.largo;
      for (let j = 0; j < nA; j++) {
        const sa = ((j + 0.5) / nA - 0.5) * g.ancho;
        const px = cx + sl * fE + sa * rE, py = cy + sl * fN + sa * rN;
        const ci = Math.floor((px - x0) / cell), cj = Math.floor((y1 - py) / cell);
        if (ci < 0 || cj < 0 || ci >= W || cj >= H) continue;
        const k = cj * W + ci;
        oc[k] = 1;
        if (t != null) { sv[k] += t; sw[k] += 1; }
      }
    }
  });

  // 2. Gaussiano separable sobre las tres grillas.
  const r = Math.ceil(3 * sigma / cell), ker = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * cell) * (i * cell) / (2 * sigma * sigma)); ker.push(w); ks += w; }
  for (let i = 0; i < ker.length; i++) ker[i] /= ks;
  const tmp = new Float32Array(W * H);
  const blur = a => {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) { const xx = x + i; if (xx >= 0 && xx < W) s += a[o + xx] * ker[i + r]; }
        tmp[o + x] = s;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let s = 0;
        for (let i = -r; i <= r; i++) { const yy = y + i; if (yy >= 0 && yy < H) s += tmp[yy * W + x] * ker[i + r]; }
        a[y * W + x] = s;
      }
    }
  };
  blur(sv); blur(sw); blur(oc);

  // 3. Pintar: color = promedio suavizado; alfa = cobertura (borde suave).
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), px = img.data;
  const gris = apmHex(APM_GRIS);
  for (let k = 0; k < W * H; k++) {
    const cob = oc[k];
    if (cob < 0.2) continue;
    const a = Math.min(1, (cob - 0.2) / 0.3);
    const c = sw[k] > 1e-4 ? apmRampa(esc.rampa, sv[k] / sw[k]) : gris;
    px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = Math.round(a * 225);
  }
  ctx.putImageData(img, 0, 0);
  const sur = lat0 + (y1 - H * cell) / ky, norte = lat0 + y1 / ky;
  const oeste = lon0 + x0 / kx, este = lon0 + (x0 + W * cell) / kx;
  return L.imageOverlay(cv.toDataURL(), [[sur, oeste], [norte, este]], { className: "apm-calor", interactive: false });
}

// Click en el mapa de calor: el tramo más cercano (≤ 15 m) en un popup.
function apmClickCalor(ev) {
  if (_apm.vista !== "calor" || !_apm.features.length || !_apm.capa) return;
  const kx = 111320 * Math.cos(ev.latlng.lat * Math.PI / 180);
  let mejor = null, dmin = 15 * 15;
  _apm.features.forEach(e => {
    const dx = (e.centro[1] - ev.latlng.lng) * kx, dy = (e.centro[0] - ev.latlng.lat) * 111320;
    const d = dx * dx + dy * dy;
    if (d < dmin) { dmin = d; mejor = e; }
  });
  if (mejor) L.popup().setLatLng(ev.latlng).setContent(apmPopup(_apm.capa, mejor)).openOn(_apm.mapa);
}

function apmVista(v) {
  _apm.vista = v;
  document.getElementById("apm-vista-calor").classList.toggle("btn-primary", v === "calor");
  document.getElementById("apm-vista-tramos").classList.toggle("btn-primary", v === "tramos");
  apmDibujar(false);
}

// En la vista Tramos, con muchos rectángulos el navegador se arrastra
// (VistaX con 30 surcos en un lote grande pasa los 150.000): arriba de este
// número se dibuja 1 de cada N. El mapa de calor usa todos.
const APM_MAX = 60000;

function apmDibujar(encajar) {
  apmInitMapa();
  const sel = document.getElementById("apm-capa");
  _apm.capa = _apm.capas.find(c => c.id === sel.value) || _apm.capas[0] || null;
  if (_apm.capaLeaflet) { _apm.mapa.removeLayer(_apm.capaLeaflet); _apm.capaLeaflet = null; }
  _apm.mapa.closePopup();
  const capa = _apm.capa;
  const ley = document.getElementById("apm-leyenda");
  if (!capa) { ley.innerHTML = ""; return; }
  // VistaX no tiene objetivo en el registro: solo Valor.
  const soloValor = capa.tipo !== "aplicado";
  const bDesvio = document.getElementById("apm-modo-desvio"), bValor = document.getElementById("apm-modo-valor");
  bDesvio.disabled = soloValor;
  bDesvio.classList.toggle("btn-primary", !soloValor && _apm.modo === "desvio");
  bValor.classList.toggle("btn-primary", soloValor || _apm.modo === "valor");

  const todos = apmElementos(capa);
  const esc = apmEscala(capa, todos);
  _apm.features = todos;
  let nota = "";

  if (_apm.vista === "calor") {
    _apm.capaLeaflet = apmCalor(todos, esc);
    if (_apm.capaLeaflet) _apm.capaLeaflet.addTo(_apm.mapa);
  } else {
    let els = todos;
    if (els.length > APM_MAX) {
      const p = Math.ceil(els.length / APM_MAX);
      nota = ` · se muestra 1 de cada ${p} (lote grande)`;
      els = els.filter((_, i) => i % p === 0);
    }
    const renderer = L.canvas({ padding: 0.3 });
    const grupo = L.featureGroup();
    els.forEach(e => {
      const pol = L.polygon(e.rect, { renderer, stroke: false, fillColor: apmColor(esc, e), fillOpacity: 0.85 });
      pol.bindPopup(() => apmPopup(capa, e));
      grupo.addLayer(pol);
    });
    grupo.addTo(_apm.mapa);
    _apm.capaLeaflet = grupo;
  }

  if (todos.length) {
    let s = 90, n = -90, o = 180, es = -180;
    todos.forEach(e => e.rect.forEach(([la, lo]) => { if (la < s) s = la; if (la > n) n = la; if (lo < o) o = lo; if (lo > es) es = lo; }));
    _apm.bounds = L.latLngBounds([s, o], [n, es]);
  } else _apm.bounds = null;
  if (encajar) apmEncajar();

  const css = esc.rampa.map(([t, c]) => `${c} ${Math.round(t * 100)}%`).join(", ");
  ley.innerHTML = `<span class="apm-grad"><strong>${apmEsc(esc.titulo)}</strong> ${apmEsc(esc.txt(esc.dom[0]))}` +
    `<b style="background:linear-gradient(90deg, ${css})"></b>${apmEsc(esc.txt(esc.dom[1]))}</span>` +
    `<span><i style="background:${APM_GRIS}"></i>sin lectura</span>`;
  document.getElementById("apm-info").textContent =
    `${_apm.datos.lote} · ${todos.length.toLocaleString("es-AR")} tramos${nota}`;
}

function apmEncajar() {
  if (_apm.bounds && _apm.bounds.isValid()) _apm.mapa.fitBounds(_apm.bounds, { padding: [20, 20] });
}

// ── Resumen del lote (resumen.json de PilotX) ─────────────────────
function apmResumen() {
  const div = document.getElementById("apm-resumen");
  const r = _apm.datos.resumen && _apm.datos.resumen.aplicado;
  if (!r || !Array.isArray(r.canales) || !r.canales.length) { div.innerHTML = ""; return; }
  const filas = r.canales.map(c => {
    const u = APM_UNIDAD[c.unidad] || c.unidad || "";
    const dv = (c.real_prom >= 0 && c.obj_prom > 0) ? (c.real_prom - c.obj_prom) / c.obj_prom * 100 : null;
    const cls = dv == null ? "" : (Math.abs(dv) <= 10 ? "apm-ok" : (Math.abs(dv) <= 25 ? "apm-warn" : "apm-bad"));
    return `<tr><td>${apmEsc(c.nombre || c.id)}</td><td>${apmNum(c.ha, 2)}</td>` +
      `<td>${c.real_prom >= 0 ? apmNum(c.real_prom, 1) + " " + u : "—"}</td>` +
      `<td>${apmNum(c.obj_prom, 1)} ${u}</td>` +
      `<td class="${cls}">${dv == null ? "—" : (dv > 0 ? "+" : "") + apmNum(dv, 1) + " %"}</td>` +
      `<td>${c.total > 0 ? apmNum(c.total, 0) + " " + apmEsc(c.total_unidad) : "—"}</td></tr>`;
  }).join("");
  const desde = r.desde ? new Date(r.desde).toLocaleString("es-AR") : "", hasta = r.hasta ? new Date(r.hasta).toLocaleString("es-AR") : "";
  div.innerHTML = `<table class="apm-tabla"><thead><tr><th>Canal</th><th>ha</th><th>Real prom.</th><th>Objetivo prom.</th><th>Desvío</th><th>Total echado</th></tr></thead>` +
    `<tbody>${filas}</tbody></table>` +
    `<div style="font-size:11px; color:var(--muted2); margin-top:6px">${desde && hasta ? desde + " → " + hasta + " · " : ""}${r.tramos} tramos</div>`;
}

// ── Descarga GeoJSON de la capa (para QGIS / el agrónomo) ─────────
function apmGeoJson() {
  if (!_apm.capa || !_apm.features.length) return;
  const fc = {
    type: "FeatureCollection",
    features: _apm.features.map(e => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [e.rect.concat([e.rect[0]]).map(p => [p[1], p[0]])] },
      properties: e.props,
    })),
  };
  const blob = new Blob([JSON.stringify(fc)], { type: "application/geo+json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (_apm.datos.lote + "_" + _apm.capa.nombre).replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, "_").replace(/\s+/g, "_") + ".geojson";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.getElementById("apm-lote").addEventListener("change", e => apmCargarLote(e.target.value));
document.getElementById("apm-capa").addEventListener("change", () => apmDibujar(false));
apmInitMapa();
_apm.mapa.on("click", apmClickCalor);
apmCargarLotes();
