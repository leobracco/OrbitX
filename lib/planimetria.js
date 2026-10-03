"use strict";
// planimetria.js — Mapa de alturas de un lote a partir de los puntos que
// registra PilotX con RTK fijo (planimetría fase 2).
//
// Entrada: las partes Elevation_NNNN.txt que sube PilotX (subtipo
// "elevation_points", ver ElevacionPartes.cs en el repo PilotX). Cada parte es
// un Elevation.txt válido: cabecera de AOG + filas
//   Latitude,Longitude,Elevation,Quality,Easting,Northing,Heading,Roll
//
// Salida: grilla regular (DEM), curvas de nivel (GeoJSON lat/lon), pendiente
// por celda, bajos (depresiones donde se junta agua) y estadísticas.
//
// Módulo PURO: sin Express ni CouchDB, para poder testearlo con datos
// sintéticos (tests/lib/planimetria.test.mjs). La I/O y el cache viven en
// services/planimetria.js.
//
// Pensado para el droplet de 1 GB: todo en typed arrays, sin copias del texto
// (cada parte se parsea y se suelta) y con topes de puntos y de celdas.
//
// Pasos:
//   1. parsear + filtrar Quality == 4 (solo RTK fijo) y filas con 8 campos
//   2. proyectar lat/lon a un plano local (metros) alrededor del centro
//   3. cortar el recorrido en "pasadas" (huecos y cambios de rumbo)
//   4. nivelar: un offset por pasada para que coincida con sus vecinas
//   5. grillar con un plano local ponderado (no IDW: el IDW deja "escalones"
//      a lo largo de las pasadas); celdas lejos de todo dato = null
//   6. curvas de nivel (marching squares propio), pendiente y bajos
//      (llenado de depresiones "priority-flood")

const PLANI_VER = 1;

// Celdas sin dato en las codificaciones compactas.
const NULO_U16 = 0xFFFF;

// Topes duros (el droplet comparte 1 GB con ~25 apps).
const MAX_PUNTOS = 600000;     // por encima se ralea (1 de cada k)
const MAX_CELDAS = 1500000;    // por encima se agranda la resolución
const INTERVALOS_AUTO = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5];

// ════════════════════════════════════════════════════════════════════
//  1. Parseo
// ════════════════════════════════════════════════════════════════════

// Arreglo creciente de Float64 (evita arrays JS de números sueltos).
class Acum {
  constructor(cap = 8192) { this.a = new Float64Array(cap); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  vista() { return this.a.subarray(0, this.n); }
}

// Índice de la parte a partir del nombre/ruta ("Elevation_0012.txt" → 12).
// Un Elevation.txt entero (legacy, subtipo "elevation") va primero (0).
function indiceParte(p) {
  const s = String((p && (p.nombre || p.ruta_rel)) || "");
  const m = s.match(/Elevation_(\d+)\.txt$/i);
  return m ? parseInt(m[1], 10) : 0;
}

function ordenarPartes(partes) {
  return [...(partes || [])].sort((a, b) => indiceParte(a) - indiceParte(b));
}

// Agrega al acumulador las filas válidas de un Elevation.txt. Una fila vale si:
//  - tiene EXACTAMENTE 8 campos (AOG viejo escribía "N7" con separador de
//    miles: "1,234.56" parte la fila en más campos — se descarta),
//  - Quality == 4 (RTK fijo; filas viejas de AOG pueden traer otra calidad),
//  - lat/lon/altura finitos y razonables.
function parsearTexto(texto, acc, cuenta) {
  if (!texto) return;
  let ini = 0;
  const L = texto.length;
  while (ini < L) {
    let fin = texto.indexOf("\n", ini);
    if (fin < 0) fin = L;
    const linea = texto.slice(ini, fin);
    ini = fin + 1;
    // Rápido: las filas de datos empiezan con dígito o signo.
    const c0 = linea.charCodeAt(0);
    if (!(c0 === 45 || (c0 >= 48 && c0 <= 57))) continue;
    const f = linea.split(",");
    if (f.length < 8) continue;           // cabecera ("StartFix" lat,lon) u otra cosa
    cuenta.filas++;
    if (f.length !== 8) { cuenta.invalidas++; continue; }
    const q = Number(f[3]);
    if (q !== 4) { cuenta.no_rtk++; continue; }
    const lat = Number(f[0]), lon = Number(f[1]), z = Number(f[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(z) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
        (Math.abs(lat) < 0.01 && Math.abs(lon) < 0.01) || z < -500 || z > 9000) {
      cuenta.invalidas++; continue;
    }
    acc.lat.push(lat); acc.lon.push(lon); acc.z.push(z);
    cuenta.q4++;
  }
}

// Junta las partes de un lote, en orden, y devuelve los puntos RTK fijo.
// `partes`: [{ nombre?, ruta_rel?, contenido }]
function juntarPuntos(partes) {
  const acc = { lat: new Acum(), lon: new Acum(), z: new Acum() };
  const cuenta = { partes: 0, filas: 0, q4: 0, no_rtk: 0, invalidas: 0 };
  for (const p of ordenarPartes(partes)) {
    cuenta.partes++;
    parsearTexto(p && p.contenido, acc, cuenta);
  }
  return { lat: acc.lat.vista(), lon: acc.lon.vista(), z: acc.z.vista(), n: acc.z.n, cuenta };
}

// Versión incremental para el service: parsea parte por parte sin retener texto.
function crearAcumulador() {
  const acc = { lat: new Acum(), lon: new Acum(), z: new Acum() };
  const cuenta = { partes: 0, filas: 0, q4: 0, no_rtk: 0, invalidas: 0 };
  return {
    agregar(texto) { cuenta.partes++; parsearTexto(texto, acc, cuenta); },
    resultado() { return { lat: acc.lat.vista(), lon: acc.lon.vista(), z: acc.z.vista(), n: acc.z.n, cuenta }; },
  };
}

// ════════════════════════════════════════════════════════════════════
//  2. Proyección local (WGS84, equirectangular con radios locales)
// ════════════════════════════════════════════════════════════════════
// x = (lon-lon0)·N·cos(lat0), y = (lat-lat0)·M. Es lineal en lat/lon, así que
// la grilla es exactamente un rectángulo lat/lon (sirve directo como
// imageOverlay de Leaflet). Error de escala < 0,1 % en 5 km: sobra para una
// grilla de metros.
function crearProyeccion(lat0, lon0) {
  const a = 6378137, e2 = 0.00669437999014, rad = Math.PI / 180;
  const s = Math.sin(lat0 * rad), w = 1 - e2 * s * s;
  const M = a * (1 - e2) / Math.pow(w, 1.5);
  const N = a / Math.sqrt(w);
  const kx = N * Math.cos(lat0 * rad) * rad, ky = M * rad;
  return {
    lat0, lon0,
    aXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    x: (lon) => (lon - lon0) * kx,
    y: (lat) => (lat - lat0) * ky,
    aLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

function mediana(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Proyecta, descarta puntos a > 20 km de la mediana (fixes absurdos que
// inflarían la grilla) y ralea si hay demasiados.
function proyectar(P, { maxPuntos = MAX_PUNTOS } = {}) {
  const n0 = P.n;
  const paso0 = Math.max(1, Math.floor(n0 / 4000));
  const latS = [], lonS = [];
  for (let i = 0; i < n0; i += paso0) { latS.push(P.lat[i]); lonS.push(P.lon[i]); }
  const lat0 = mediana(latS), lon0 = mediana(lonS);
  const pr = crearProyeccion(lat0, lon0);
  const k = Math.max(1, Math.ceil(n0 / maxPuntos));
  const cap = Math.ceil(n0 / k);
  const x = new Float64Array(cap), y = new Float64Array(cap), z = new Float64Array(cap);
  let n = 0, lejos = 0, repetidos = 0;
  for (let i = 0; i < n0; i += k) {
    const px = pr.x(P.lon[i]), py = pr.y(P.lat[i]);
    if (px * px + py * py > 4e8) { lejos++; continue; }       // > 20 km
    // Tractor parado: puntos repetidos pesarían de más en la nivelación.
    if (n > 0 && Math.abs(px - x[n - 1]) < 0.15 && Math.abs(py - y[n - 1]) < 0.15) { repetidos++; continue; }
    x[n] = px; y[n] = py; z[n] = P.z[i]; n++;
  }
  return { pr, x: x.subarray(0, n), y: y.subarray(0, n), z: z.subarray(0, n), n, raleo: k, lejos, repetidos };
}

// ════════════════════════════════════════════════════════════════════
//  Hash espacial (cubetas fijas, orden por conteo)
// ════════════════════════════════════════════════════════════════════
function crearHash(x, y, n, celda) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minx) minx = x[i]; if (x[i] > maxx) maxx = x[i];
    if (y[i] < miny) miny = y[i]; if (y[i] > maxy) maxy = y[i];
  }
  if (!n) { minx = miny = 0; maxx = maxy = 0; }
  const nx = Math.max(1, Math.floor((maxx - minx) / celda) + 1);
  const ny = Math.max(1, Math.floor((maxy - miny) / celda) + 1);
  const start = new Int32Array(nx * ny + 1);
  const cel = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((x[i] - minx) / celda) + Math.floor((y[i] - miny) / celda) * nx;
    cel[i] = c; start[c + 1]++;
  }
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const items = new Int32Array(n);
  const pos = start.slice(0, nx * ny);
  for (let i = 0; i < n; i++) items[pos[cel[i]]++] = i;
  return {
    celda, minx, miny, maxx, maxy, nx, ny, start, items,
    // Llama cb(j, d2) para cada punto a distancia ≤ r de (px,py).
    vecinos(px, py, r, cb) {
      const r2 = r * r;
      const c0 = Math.max(0, Math.floor((px - r - minx) / celda)), c1 = Math.min(nx - 1, Math.floor((px + r - minx) / celda));
      const f0 = Math.max(0, Math.floor((py - r - miny) / celda)), f1 = Math.min(ny - 1, Math.floor((py + r - miny) / celda));
      for (let f = f0; f <= f1; f++) {
        for (let c = c0; c <= c1; c++) {
          const k = c + f * nx;
          for (let t = start[k], e = start[k + 1]; t < e; t++) {
            const j = items[t];
            const dx = x[j] - px, dy = y[j] - py, d2 = dx * dx + dy * dy;
            if (d2 <= r2) cb(j, d2, dx, dy);
          }
        }
      }
    },
  };
}

// ════════════════════════════════════════════════════════════════════
//  3. Pasadas
// ════════════════════════════════════════════════════════════════════
function difAng(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// Corta el recorrido (en orden de filas) en pasadas:
//  - hueco > gapMax metros entre puntos consecutivos,
//  - cambio de rumbo > giroMax respecto del rumbo de la pasada (cabecera),
//  - pasada más larga que maxLargo (la deriva del RTK es temporal: en pasadas
//    de 1 km conviene más de un offset).
// Los pedazos cortos (giros en la cabecera) se pegan a la pasada anterior: el
// sesgo es temporal, el giro comparte el de la pasada de la que sale.
function segmentarPasadas(x, y, n, o = {}) {
  const gap = o.gapMax ?? 15, paso = o.pasoRumbo ?? 3;
  const giro = (o.giroMax ?? 50) * Math.PI / 180;
  const minLargo = o.minLargo ?? 30, maxLargo = o.maxLargo ?? 500;
  const crudo = new Int32Array(n);
  const largos = [0], trasHueco = [true];
  let id = 0, ax = n ? x[0] : 0, ay = n ? y[0] : 0, ref = NaN;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    let corta = false, porHueco = false;
    if (d > gap) { corta = true; porHueco = true; }
    else {
      const da = Math.hypot(x[i] - ax, y[i] - ay);
      if (da >= paso) {
        const b = Math.atan2(y[i] - ay, x[i] - ax);
        if (Number.isNaN(ref)) ref = b;
        else {
          const df = difAng(b, ref);
          if (Math.abs(df) > giro) corta = true;
          else ref += 0.3 * df;
        }
        ax = x[i]; ay = y[i];
      }
      if (!corta && largos[id] + d > maxLargo) corta = true;
    }
    if (corta) { id++; largos.push(0); trasHueco.push(porHueco); ref = NaN; ax = x[i]; ay = y[i]; }
    else largos[id] += d;
    crudo[i] = id;
  }
  // Pegar pedazos cortos a la anterior (si no hay hueco en el medio).
  const nCrudo = id + 1;
  const destino = new Int32Array(nCrudo);
  for (let s = 0; s < nCrudo; s++) {
    destino[s] = s;
    if (s > 0 && largos[s] < minLargo && !trasHueco[s]) destino[s] = destino[s - 1];
  }
  // Pedazo corto tras hueco: pegarlo a la siguiente si ésta no arranca con hueco.
  for (let s = nCrudo - 2; s >= 0; s--) {
    if (destino[s] === s && largos[s] < minLargo && trasHueco[s] && s + 1 < nCrudo && !trasHueco[s + 1]) {
      destino[s] = destino[s + 1];
    }
  }
  // Renumerar consecutivo.
  const mapa = new Map();
  const seg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const d = destino[crudo[i]];
    if (!mapa.has(d)) mapa.set(d, mapa.size);
    seg[i] = mapa.get(d);
  }
  return { seg, nSeg: mapa.size };
}

// Separación típica entre pasadas: mediana de la distancia de cada punto al
// punto más cercano de OTRA pasada. null si hay una sola pasada.
function estimarEspaciado(x, y, n, seg, hash) {
  const paso = Math.max(1, Math.floor(n / 3000));
  const ds = [];
  const R = 40;
  for (let i = 0; i < n; i += paso) {
    let mejor = Infinity;
    const s = seg[i];
    hash.vecinos(x[i], y[i], R, (j, d2) => { if (seg[j] !== s && d2 < mejor) mejor = d2; });
    if (mejor < Infinity) ds.push(Math.sqrt(mejor));
  }
  if (ds.length < 10) return null;
  const m = mediana(ds);
  return m > 0.5 ? m : null;
}

// ════════════════════════════════════════════════════════════════════
//  4. Nivelación entre pasadas
// ════════════════════════════════════════════════════════════════════
// Cada pasada p tiene un sesgo o_p (deriva vertical del RTK, error de la
// corrección por rolido según el sentido de marcha). Para un punto i de p se
// ajusta un plano ponderado con los puntos de las OTRAS pasadas cercanas y se
// evalúa en i: S_i. Como el plano es lineal en las alturas,
//   S_i = Σ_j α_ij (z_j − o_q(j)) = base_i − Σ_q C_iq·o_q
// y el residuo r_i = z_i − base_i ≈ o_p − Σ_q C_iq·o_q. Se resuelve por
// iteración (Jacobi con prior hacia 0) quitando la media (el datum no cambia).
// Requisitos para que un punto observe: vecinos de ≥ 2 pasadas distintas y
// bien repartidos (si hay una sola vecina, pendiente transversal y sesgo son
// indistinguibles: ese punto no aporta).
function nivelarPasadas(x, y, z, n, seg, nSeg, hash, espaciado, o = {}) {
  const sinCambio = (motivo) => ({ offsets: new Float64Array(nSeg), aplicada: false, motivo,
    sesgo_rms_antes_m: null, sesgo_rms_despues_m: null, pasadas_niveladas: 0 });
  if (!espaciado || nSeg < 3) return sinCambio(!espaciado ? "una sola pasada" : "menos de 3 pasadas");

  const R = Math.min(30, Math.max(8, (o.factorRadio ?? 2.1) * espaciado));
  const maxEval = o.maxEval ?? 40000;
  const k = Math.max(1, Math.ceil(n / maxEval));
  const minEig = Math.pow(0.2 * espaciado, 2);

  const evP = [], evR = [], coefIni = [0], coefSeg = [], coefVal = [];
  const vj = [], vw = [], vdx = [], vdy = [];
  for (let i = 0; i < n; i += k) {
    const p = seg[i];
    vj.length = vw.length = vdx.length = vdy.length = 0;
    let S0 = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0;
    const segsVistos = new Set();
    hash.vecinos(x[i], y[i], R, (j, d2, dx, dy) => {
      if (seg[j] === p) return;
      const u = 1 - d2 / (R * R), w = u * u;
      if (w <= 0) return;
      vj.push(j); vw.push(w); vdx.push(dx); vdy.push(dy);
      S0 += w; Sx += w * dx; Sy += w * dy; Sxx += w * dx * dx; Sxy += w * dx * dy; Syy += w * dy * dy;
      segsVistos.add(seg[j]);
    });
    if (segsVistos.size < 2 || vj.length < 6) continue;
    const mx = Sx / S0, my = Sy / S0;
    const cxx = Sxx / S0 - mx * mx, cxy = Sxy / S0 - mx * my, cyy = Syy / S0 - my * my;
    const tr = cxx + cyy, det2 = cxx * cyy - cxy * cxy;
    const eigMin = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det2));
    if (eigMin < minEig) continue;
    if (Math.hypot(mx, my) > 0.75 * R) continue;    // extrapolaría demasiado
    const c00 = Sxx * Syy - Sxy * Sxy;
    const c01 = -(Sx * Syy - Sxy * Sy);
    const c02 = Sx * Sxy - Sxx * Sy;
    const det = S0 * c00 + Sx * c01 + Sy * c02;
    if (!(Math.abs(det) > 1e-9)) continue;
    let base = 0;
    const porSeg = new Map();
    for (let t = 0; t < vj.length; t++) {
      const a = vw[t] * (c00 + c01 * vdx[t] + c02 * vdy[t]) / det;
      base += a * z[vj[t]];
      const q = seg[vj[t]];
      porSeg.set(q, (porSeg.get(q) || 0) + a);
    }
    evP.push(p); evR.push(z[i] - base);
    for (const [q, a] of porSeg) { coefSeg.push(q); coefVal.push(a); }
    coefIni.push(coefSeg.length);
  }
  const nEv = evP.length;
  if (nEv < 20) return sinCambio("pocas superposiciones entre pasadas");

  // Robustez: fuera los residuos > 4·MAD (mínimo 8 cm) de la mediana de su pasada.
  const porPasada = Array.from({ length: nSeg }, () => []);
  for (let e = 0; e < nEv; e++) porPasada[evP[e]].push(evR[e]);
  const med = new Float64Array(nSeg), tol = new Float64Array(nSeg);
  for (let s = 0; s < nSeg; s++) {
    const a = porPasada[s];
    if (!a.length) continue;
    med[s] = mediana(a);
    const mad = mediana(a.map(v => Math.abs(v - med[s]))) * 1.4826;
    tol[s] = Math.max(0.08, 4 * mad);
  }
  const usa = new Uint8Array(nEv);
  const cnt = new Float64Array(nSeg);
  for (let e = 0; e < nEv; e++) {
    if (Math.abs(evR[e] - med[evP[e]]) <= tol[evP[e]]) { usa[e] = 1; cnt[evP[e]]++; }
  }
  const minObs = o.minObs ?? 8;
  const lambda = o.lambda ?? 4;

  const sesgoRms = (off) => {
    const acc = new Float64Array(nSeg);
    for (let e = 0; e < nEv; e++) {
      if (!usa[e]) continue;
      let v = evR[e] - off[evP[e]];
      for (let t = coefIni[e]; t < coefIni[e + 1]; t++) v += coefVal[t] * off[coefSeg[t]];
      acc[evP[e]] += v;
    }
    let s2 = 0, m = 0;
    for (let s = 0; s < nSeg; s++) if (cnt[s] >= minObs) { const v = acc[s] / cnt[s]; s2 += v * v; m++; }
    return m ? Math.sqrt(s2 / m) : null;
  };

  // Mínimos cuadrados amortiguados por gradiente conjugado (CGLS):
  //   min Σ_e (r_e − o_p + Σ_q C_eq·o_q)² + λ·Σ o²
  // A·o (por observación) y Aᵀ·u (por pasada) salen directo de los
  // coeficientes; no se arma ninguna matriz. Pasadas con pocas
  // observaciones quedan fijas en 0 (columna fuera).
  const activa = new Uint8Array(nSeg);
  for (let s = 0; s < nSeg; s++) activa[s] = cnt[s] >= minObs ? 1 : 0;
  const Ax = (v, out) => {
    for (let e = 0; e < nEv; e++) {
      if (!usa[e]) { out[e] = 0; continue; }
      let a = activa[evP[e]] ? v[evP[e]] : 0;
      for (let t = coefIni[e]; t < coefIni[e + 1]; t++) if (activa[coefSeg[t]]) a -= coefVal[t] * v[coefSeg[t]];
      out[e] = a;
    }
  };
  const ATx = (u, out) => {
    out.fill(0);
    for (let e = 0; e < nEv; e++) {
      if (!usa[e]) continue;
      const ue = u[e];
      if (activa[evP[e]]) out[evP[e]] += ue;
      for (let t = coefIni[e]; t < coefIni[e + 1]; t++) if (activa[coefSeg[t]]) out[coefSeg[t]] -= coefVal[t] * ue;
    }
  };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

  let off = new Float64Array(nSeg);
  const antes = sesgoRms(off);
  const iterMax = o.iteraciones ?? 200;
  const res = new Float64Array(nEv);
  for (let e = 0; e < nEv; e++) res[e] = usa[e] ? evR[e] : 0;
  const sv = new Float64Array(nSeg), q = new Float64Array(nEv);
  ATx(res, sv);
  const pv = Float64Array.from(sv);
  let gamma = dot(sv, sv);
  const gamma0 = gamma;
  let iters = 0;
  for (; iters < iterMax && gamma > 1e-14 * Math.max(1, gamma0); iters++) {
    Ax(pv, q);
    const alfa = gamma / (dot(q, q) + lambda * dot(pv, pv));
    for (let s = 0; s < nSeg; s++) off[s] += alfa * pv[s];
    for (let e = 0; e < nEv; e++) res[e] -= alfa * q[e];
    ATx(res, sv);
    for (let s = 0; s < nSeg; s++) sv[s] -= lambda * off[s];
    const gNuevo = dot(sv, sv);
    const beta = gNuevo / gamma;
    gamma = gNuevo;
    for (let s = 0; s < nSeg; s++) pv[s] = sv[s] + beta * pv[s];
  }
  // El datum no cambia: se quita la media ponderada de los offsets.
  let sw = 0, sm = 0;
  for (let s = 0; s < nSeg; s++) if (activa[s]) { sw += cnt[s]; sm += cnt[s] * off[s]; }
  if (sw) for (let s = 0; s < nSeg; s++) if (activa[s]) off[s] -= sm / sw;
  // Tope de seguridad: un offset de más de 50 cm no es sesgo de RTK, es un
  // dato roto. Se descarta la corrección de esa pasada.
  for (let s = 0; s < nSeg; s++) if (Math.abs(off[s]) > 0.5) off[s] = 0;
  const despues = sesgoRms(off);
  let niveladas = 0;
  for (let s = 0; s < nSeg; s++) if (cnt[s] >= minObs) niveladas++;
  return {
    offsets: off, aplicada: true, motivo: null, radio_m: R, observaciones: nEv, iteraciones: iters,
    pasadas_niveladas: niveladas,
    sesgo_rms_antes_m: antes, sesgo_rms_despues_m: despues,
  };
}

// ════════════════════════════════════════════════════════════════════
//  5. Grilla
// ════════════════════════════════════════════════════════════════════
// Cada celda: plano ponderado (peso (1−d²/R²)²) de los puntos a ≤ R,
// evaluado en el centro. Sin extrapolar: si el punto más cercano está a más
// de dCerca, la celda queda null. dCerca ≈ 0,6 × espaciado entre pasadas
// (entre dos pasadas la celda más lejana está a medio espaciado; afuera de la
// última pasada se acepta un poco más que medio ancho de labor).
function grillar(x, y, z, n, o) {
  const res = o.res;
  const esp = o.espaciado || 0;
  const R = o.radio ?? Math.min(30, Math.max(2.5 * res, 1.25 * esp, 4));
  const dCerca = o.dCerca ?? Math.max(0.75 * res, 0.6 * esp, 2);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minx) minx = x[i]; if (x[i] > maxx) maxx = x[i];
    if (y[i] < miny) miny = y[i]; if (y[i] > maxy) maxy = y[i];
  }
  // Centros de celda alineados a múltiplos de res (estable entre recálculos).
  const x0 = Math.floor((minx - dCerca) / res) * res;
  const y0 = Math.floor((miny - dCerca) / res) * res;
  const nx = Math.floor((maxx + dCerca - x0) / res) + 1;
  const ny = Math.floor((maxy + dCerca - y0) / res) + 1;
  const yTop = y0 + (ny - 1) * res;
  const hash = o.hash && o.hash.celda >= R * 0.5 ? o.hash : crearHash(x, y, n, R);
  const g = new Float32Array(nx * ny).fill(NaN);
  const dC2 = dCerca * dCerca, R2 = R * R;
  // Regularización de la pendiente: si los puntos quedan sobre una sola
  // línea (una pasada), el plano no está definido en la transversal; el
  // término ridge lo lleva a pendiente 0 en esa dirección.
  const ridge = 1e-3 * R2;
  let cubiertas = 0;
  for (let r = 0; r < ny; r++) {
    const cy = yTop - r * res;
    for (let c = 0; c < nx; c++) {
      const cx = x0 + c * res;
      let dmin = Infinity, S0 = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0, Sz = 0, Sxz = 0, Syz = 0;
      hash.vecinos(cx, cy, R, (j, d2, dx, dy) => {
        if (d2 < dmin) dmin = d2;
        const u = 1 - d2 / R2, w = u * u;
        const zz = z[j];
        S0 += w; Sx += w * dx; Sy += w * dy; Sxx += w * dx * dx; Sxy += w * dx * dy; Syy += w * dy * dy;
        Sz += w * zz; Sxz += w * dx * zz; Syz += w * dy * zz;
      });
      if (dmin > dC2 || S0 <= 0) continue;
      const a11 = Sxx + ridge * S0, a22 = Syy + ridge * S0;
      // Resolver [S0 Sx Sy; Sx a11 Sxy; Sy Sxy a22]·[a b c] = [Sz Sxz Syz] (Cramer).
      const det = S0 * (a11 * a22 - Sxy * Sxy) - Sx * (Sx * a22 - Sxy * Sy) + Sy * (Sx * Sxy - a11 * Sy);
      const media = Sz / S0;
      let v = media;
      if (Math.abs(det) > 1e-12) {
        const da = Sz * (a11 * a22 - Sxy * Sxy) - Sx * (Sxz * a22 - Sxy * Syz) + Sy * (Sxz * Sxy - a11 * Syz);
        const a = da / det;
        if (Number.isFinite(a) && Math.abs(a - media) < 0.5) v = a;
      }
      g[r * nx + c] = v;
      cubiertas++;
    }
  }
  return { z: g, nx, ny, res, x0, yTop, radio_m: R, d_cerca_m: dCerca, cubiertas };
}

// ════════════════════════════════════════════════════════════════════
//  6a. Pendiente (%)
// ════════════════════════════════════════════════════════════════════
function pendientes(G) {
  const { z, nx, ny, res } = G;
  const p = new Float32Array(nx * ny).fill(NaN);
  const val = (r, c) => (r < 0 || c < 0 || r >= ny || c >= nx) ? NaN : z[r * nx + c];
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const v = z[r * nx + c];
      if (Number.isNaN(v)) continue;
      const e = val(r, c + 1), w = val(r, c - 1), nN = val(r - 1, c), s = val(r + 1, c);
      let dzdx, dzdy;
      if (!Number.isNaN(e) && !Number.isNaN(w)) dzdx = (e - w) / (2 * res);
      else if (!Number.isNaN(e)) dzdx = (e - v) / res;
      else if (!Number.isNaN(w)) dzdx = (v - w) / res;
      else continue;
      // Fila 0 = norte: "arriba" es r-1.
      if (!Number.isNaN(nN) && !Number.isNaN(s)) dzdy = (nN - s) / (2 * res);
      else if (!Number.isNaN(nN)) dzdy = (nN - v) / res;
      else if (!Number.isNaN(s)) dzdy = (v - s) / res;
      else continue;
      p[r * nx + c] = 100 * Math.hypot(dzdx, dzdy);
    }
  }
  return p;
}

// ════════════════════════════════════════════════════════════════════
//  6b. Bajos: llenado de depresiones (priority-flood, Barnes 2014)
// ════════════════════════════════════════════════════════════════════
// El agua sale por el borde de la zona relevada (borde de la grilla o celda
// vecina a una sin dato). Lo que queda por debajo del nivel de desborde es un
// bajo: profundidad = lleno − z. Se marcan bajos con profundidad ≥ umbral y
// superficie ≥ areaMin.
class Heap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    let i = this.n++;
    if (i >= this.k.length) {
      const k2 = new Float64Array(this.k.length * 2); k2.set(this.k); this.k = k2;
      const v2 = new Int32Array(this.v.length * 2); v2.set(this.v); this.v = v2;
    }
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], topK = this.k[0];
    const n = --this.n;
    if (n > 0) {
      const key = this.k[n], val = this.v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
      }
      this.k[i] = key; this.v[i] = val;
    }
    this.ultimaClave = topK;
    return top;
  }
}

function bajos(G, { umbral = 0.05, areaMinM2 = 50 } = {}) {
  const { z, nx, ny, res } = G;
  const N = nx * ny;
  const lleno = new Float32Array(N).fill(NaN);
  const visto = new Uint8Array(N);
  const heap = new Heap(Math.max(1024, 2 * (nx + ny)));
  const DR = [-1, -1, -1, 0, 0, 1, 1, 1], DC = [-1, 0, 1, -1, 1, -1, 0, 1];
  // Semillas: celdas con dato en el borde o vecinas (4-conexas) de una sin dato.
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (Number.isNaN(z[i])) continue;
      let borde = r === 0 || c === 0 || r === ny - 1 || c === nx - 1;
      if (!borde) borde = Number.isNaN(z[i - 1]) || Number.isNaN(z[i + 1]) || Number.isNaN(z[i - nx]) || Number.isNaN(z[i + nx]);
      if (borde) { visto[i] = 1; lleno[i] = z[i]; heap.push(z[i], i); }
    }
  }
  while (heap.n) {
    const i = heap.pop();
    const nivel = lleno[i];
    const r = (i / nx) | 0, c = i - r * nx;
    for (let t = 0; t < 8; t++) {
      const rr = r + DR[t], cc = c + DC[t];
      if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
      const j = rr * nx + cc;
      if (visto[j] || Number.isNaN(z[j])) continue;
      visto[j] = 1;
      lleno[j] = Math.max(z[j], nivel);
      heap.push(lleno[j], j);
    }
  }
  const prof = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!Number.isNaN(z[i]) && !Number.isNaN(lleno[i])) {
      const d = lleno[i] - z[i];
      prof[i] = d >= umbral ? d : 0;
    }
  }
  // Componentes conexas (8) → zonas; las chicas se descartan.
  const etiqueta = new Int32Array(N).fill(-1);
  const zonas = [];
  const pila = new Int32Array(N);
  const areaCelda = res * res;
  for (let i0 = 0; i0 < N; i0++) {
    if (prof[i0] <= 0 || etiqueta[i0] >= 0) continue;
    const id = zonas.length;
    let sp = 0; pila[sp++] = i0; etiqueta[i0] = id;
    const celdas = [];
    let profMax = 0, vol = 0, sr = 0, sc = 0, zMin = Infinity;
    while (sp) {
      const i = pila[--sp];
      celdas.push(i);
      const d = prof[i];
      if (d > profMax) profMax = d;
      vol += d * areaCelda;
      if (z[i] < zMin) zMin = z[i];
      const r = (i / nx) | 0, c = i - r * nx;
      sr += r; sc += c;
      for (let t = 0; t < 8; t++) {
        const rr = r + DR[t], cc = c + DC[t];
        if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
        const j = rr * nx + cc;
        if (prof[j] > 0 && etiqueta[j] < 0) { etiqueta[j] = id; pila[sp++] = j; }
      }
    }
    const area = celdas.length * areaCelda;
    if (area < areaMinM2) { for (const i of celdas) prof[i] = 0; zonas.push(null); continue; }
    zonas.push({ celdas: celdas.length, area_m2: area, prof_max_m: profMax, volumen_m3: vol,
      fila: sr / celdas.length, col: sc / celdas.length, z_min: zMin });
  }
  return { prof, zonas: zonas.filter(Boolean) };
}

// ════════════════════════════════════════════════════════════════════
//  6c. Curvas de nivel (marching squares sobre centros de celda)
// ════════════════════════════════════════════════════════════════════
// Cada cruce cae sobre una arista identificada por un entero (horizontal o
// vertical), así el encadenado de segmentos es exacto, sin redondeos.
function curvasNivel(G, intervalo) {
  const { z, nx, ny } = G;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < z.length; i++) { const v = z[i]; if (v < zmin) zmin = v; if (v > zmax) zmax = v; }
  if (!(zmax > zmin)) return { niveles: [], intervalo };
  // Tope de niveles: con relieve grande el intervalo pedido se agranda.
  let inter = intervalo;
  while ((zmax - zmin) / inter > 250) inter *= 2;
  const out = [];
  const nivel0 = Math.ceil(zmin / inter) * inter;
  // Aristas: horizontal (r,c)-(r,c+1) → 2·(r·nx+c); vertical (r,c)-(r+1,c) → 2·(r·nx+c)+1
  for (let L = nivel0; L <= zmax; L += inter) {
    const lv = Math.round(L * 1e4) / 1e4;
    const punto = new Map();   // arista → [col, fila] fraccionarios
    const ady = new Map();     // arista → [aristas vecinas]
    const unir = (a, b) => {
      if (!ady.has(a)) ady.set(a, []); if (!ady.has(b)) ady.set(b, []);
      ady.get(a).push(b); ady.get(b).push(a);
    };
    const cruce = (k, r1, c1, r2, c2) => {
      if (!punto.has(k)) {
        const v1 = z[r1 * nx + c1], v2 = z[r2 * nx + c2];
        const t = (lv - v1) / (v2 - v1);
        punto.set(k, [c1 + t * (c2 - c1), r1 + t * (r2 - r1)]);
      }
      return k;
    };
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const a = z[r * nx + c], b = z[r * nx + c + 1], d = z[(r + 1) * nx + c], e = z[(r + 1) * nx + c + 1];
        if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(d) || Number.isNaN(e)) continue;
        // Esquinas: a=(r,c) b=(r,c+1) e=(r+1,c+1) d=(r+1,c). "Arriba" = ≥ nivel.
        const caso = (a >= lv ? 8 : 0) | (b >= lv ? 4 : 0) | (e >= lv ? 2 : 0) | (d >= lv ? 1 : 0);
        if (caso === 0 || caso === 15) continue;
        const top = () => cruce(2 * (r * nx + c), r, c, r, c + 1);
        const bot = () => cruce(2 * ((r + 1) * nx + c), r + 1, c, r + 1, c + 1);
        const izq = () => cruce(2 * (r * nx + c) + 1, r, c, r + 1, c);
        const der = () => cruce(2 * (r * nx + c + 1) + 1, r, c + 1, r + 1, c + 1);
        switch (caso) {
          case 1: case 14: unir(izq(), bot()); break;
          case 2: case 13: unir(bot(), der()); break;
          case 3: case 12: unir(izq(), der()); break;
          case 4: case 11: unir(top(), der()); break;
          case 6: case 9:  unir(top(), bot()); break;
          case 7: case 8:  unir(izq(), top()); break;
          case 5: case 10: {
            // Silla: decide el promedio del centro.
            const centro = (a + b + d + e) / 4 >= lv;
            if ((caso === 5) === centro) { unir(izq(), top()); unir(bot(), der()); }
            else { unir(izq(), bot()); unir(top(), der()); }
            break;
          }
        }
      }
    }
    // Encadenar: primero desde extremos (grado 1), después los anillos cerrados.
    const usado = new Set();
    const lineas = [];
    const recorrer = (inicio) => {
      const l = [inicio]; usado.add(inicio);
      let actual = inicio;
      for (;;) {
        const sig = (ady.get(actual) || []).find(k => !usado.has(k));
        if (sig === undefined) {
          // ¿Cierra el anillo?
          if (l.length > 2 && (ady.get(actual) || []).includes(inicio)) l.push(inicio);
          break;
        }
        usado.add(sig); l.push(sig); actual = sig;
      }
      return l;
    };
    for (const [k, v] of ady) if (v.length === 1 && !usado.has(k)) lineas.push(recorrer(k));
    for (const k of ady.keys()) if (!usado.has(k)) lineas.push(recorrer(k));
    out.push({ elev: lv, lineas: lineas.filter(l => l.length >= 2).map(l => l.map(k => punto.get(k))) });
  }
  return { niveles: out, intervalo: inter };
}

// Douglas-Peucker en coordenadas de grilla.
function simplificar(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const pila = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (pila.length) {
    const [i0, i1] = pila.pop();
    const [ax, ay] = pts[i0], [bx, by] = pts[i1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let maxd = -1, idx = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const [px, py] = pts[i];
      let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey;
      if (d > maxd) { maxd = d; idx = i; }
    }
    if (maxd > t2) { keep[idx] = 1; pila.push([i0, idx], [idx, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ════════════════════════════════════════════════════════════════════
//  Límite del lote (opcional): % del lote con altura
// ════════════════════════════════════════════════════════════════════
function dentroPoligono(px, py, poly) {
  let dentro = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) dentro = !dentro;
  }
  return dentro;
}

// ════════════════════════════════════════════════════════════════════
//  Orquestador
// ════════════════════════════════════════════════════════════════════
// opts: { res (m), intervalo (m), umbralBajo (m), areaMinBajoM2, nivelar (bool),
//         limite: [[lat,lon],...] }
function calcularDesdePuntos(P, opts = {}) {
  const t0 = Date.now();
  let res = Number(opts.res) || 3;
  // "auto": el intervalo más fino que deje ≤ 15 curvas en el lote (se
  // decide después de grillar, cuando se conoce el desnivel).
  const intervaloAuto = opts.intervalo === "auto";
  let intervalo = intervaloAuto ? 0.1 : (Number(opts.intervalo) || 0.1);
  const umbralBajo = opts.umbralBajo ?? 0.05;
  const cuenta = P.cuenta || {};
  const base = { ver: PLANI_VER, params: { res, intervalo, umbral_bajo: umbralBajo } };
  if (P.n < 50) {
    return { ...base, ok: false, motivo: P.n ? "pocos puntos con RTK fijo" : "sin puntos con RTK fijo",
      stats: { puntos_filas: cuenta.filas || 0, puntos_rtk: P.n } };
  }

  const Q = proyectar(P, { maxPuntos: opts.maxPuntos });
  const { x, y, z, n, pr } = Q;
  const { seg, nSeg } = segmentarPasadas(x, y, n, opts.pasadas || {});
  const hashN = crearHash(x, y, n, 10);
  const espaciado = estimarEspaciado(x, y, n, seg, hashN);

  let niv = { offsets: new Float64Array(nSeg), aplicada: false, motivo: "desactivada" };
  if (opts.nivelar !== false) {
    const Rn = Math.min(30, Math.max(8, 2.1 * (espaciado || 8)));
    const hashL = crearHash(x, y, n, Rn);
    niv = nivelarPasadas(x, y, z, n, seg, nSeg, hashL, espaciado, opts.nivelacion || {});
  }
  const zc = new Float64Array(n);
  for (let i = 0; i < n; i++) zc[i] = z[i] - niv.offsets[seg[i]];

  // Tope de celdas: se agranda la resolución si el lote es enorme.
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minx) minx = x[i]; if (x[i] > maxx) maxx = x[i];
    if (y[i] < miny) miny = y[i]; if (y[i] > maxy) maxy = y[i];
  }
  const maxCeldas = opts.maxCeldas || MAX_CELDAS;
  while (((maxx - minx) / res + 3) * ((maxy - miny) / res + 3) > maxCeldas) res *= 1.5;
  res = Math.round(res * 100) / 100;

  const G = grillar(x, y, zc, n, { res, espaciado, radio: opts.radioGrilla });
  const pend = pendientes(G);
  const B = bajos(G, { umbral: umbralBajo, areaMinM2: opts.areaMinBajoM2 ?? Math.max(50, 4 * res * res) });
  if (intervaloAuto) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < G.z.length; i++) { const v = G.z[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const des = hi > lo ? hi - lo : 0;
    intervalo = INTERVALOS_AUTO.find(c => des / c <= 15) || INTERVALOS_AUTO[INTERVALOS_AUTO.length - 1];
  }
  const C = curvasNivel(G, intervalo);

  // Estadísticas.
  let zmin = Infinity, zmax = -Infinity, zs = 0, nz = 0;
  const pv = [];
  for (let i = 0; i < G.z.length; i++) {
    const v = G.z[i];
    if (Number.isNaN(v)) continue;
    if (v < zmin) zmin = v; if (v > zmax) zmax = v; zs += v; nz++;
    if (!Number.isNaN(pend[i])) pv.push(pend[i]);
  }
  pv.sort((a, b) => a - b);
  const pct = (q) => pv.length ? pv[Math.min(pv.length - 1, Math.floor(q * pv.length))] : null;

  let coberturaPct = null, limiteHa = null;
  if (Array.isArray(opts.limite) && opts.limite.length >= 3) {
    const poly = opts.limite.map(([la, lo]) => pr.aXY(la, lo));
    let dentro = 0, conDato = 0;
    for (let r = 0; r < G.ny; r++) {
      const cy = G.yTop - r * G.res;
      for (let c = 0; c < G.nx; c++) {
        // Celdas del lote fuera de la grilla no se cuentan acá: se suman abajo por área.
        if (dentroPoligono(G.x0 + c * G.res, cy, poly)) { dentro++; if (!Number.isNaN(G.z[r * G.nx + c])) conDato++; }
      }
    }
    let a2 = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a2 += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    const areaLim = Math.abs(a2) / 2;
    limiteHa = areaLim / 1e4;
    if (areaLim > 0) coberturaPct = Math.min(100, 100 * conDato * G.res * G.res / areaLim);
  }

  const areaCubiertaHa = nz * G.res * G.res / 1e4;
  const zonasOrd = B.zonas.sort((a, b) => b.volumen_m3 - a.volumen_m3);
  const r2 = (v, d = 2) => v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

  return {
    ...base,
    ok: true,
    params: { res: G.res, res_pedida: Number(opts.res) || 3, intervalo: C.intervalo, intervalo_pedido: intervaloAuto ? "auto" : intervalo, umbral_bajo: umbralBajo },
    proyeccion: { lat0: pr.lat0, lon0: pr.lon0 },
    pr,
    grilla: G,
    pendiente: pend,
    bajos: B,
    curvas: C,
    stats: {
      puntos_filas: cuenta.filas ?? null,
      puntos_rtk: P.n,
      puntos_descartados_no_rtk: cuenta.no_rtk ?? null,
      puntos_invalidos: cuenta.invalidas ?? null,
      puntos_usados: n,
      raleo: Q.raleo,
      partes: cuenta.partes ?? null,
      pasadas: nSeg,
      espaciado_pasadas_m: r2(espaciado, 1),
      z_min_m: r2(zmin, 3), z_max_m: r2(zmax, 3), desnivel_m: r2(zmax - zmin, 3), z_media_m: r2(zs / nz, 3),
      area_cubierta_ha: r2(areaCubiertaHa, 2),
      limite_ha: r2(limiteHa, 2),
      cobertura_pct: r2(coberturaPct, 1),
      pendiente_media_pct: r2(pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : null, 2),
      pendiente_p90_pct: r2(pct(0.9), 2),
      pendiente_max_pct: r2(pv.length ? pv[pv.length - 1] : null, 2),
      bajos_cantidad: zonasOrd.length,
      bajos_area_ha: r2(zonasOrd.reduce((a, b) => a + b.area_m2, 0) / 1e4, 2),
      bajos_volumen_m3: r2(zonasOrd.reduce((a, b) => a + b.volumen_m3, 0), 0),
      nivelacion: {
        aplicada: !!niv.aplicada, motivo: niv.motivo || null,
        pasadas_niveladas: niv.pasadas_niveladas || 0,
        sesgo_rms_antes_cm: niv.sesgo_rms_antes_m == null ? null : r2(niv.sesgo_rms_antes_m * 100, 2),
        sesgo_rms_despues_cm: niv.sesgo_rms_despues_m == null ? null : r2(niv.sesgo_rms_despues_m * 100, 2),
        offset_max_cm: r2(Math.max(0, ...Array.from(niv.offsets, Math.abs)) * 100, 2),
      },
      ms: Date.now() - t0,
    },
    _interno: { seg, offsets: niv.offsets, x, y, z, zc },
  };
}

function calcularPlanimetria(partes, opts = {}) {
  return calcularDesdePuntos(juntarPuntos(partes), opts);
}

// ════════════════════════════════════════════════════════════════════
//  Serialización compacta para el panel (y el cache)
// ════════════════════════════════════════════════════════════════════
// Grilla: fila 0 = NORTE, row-major. z en cm sobre z_base (Uint16 LE, 65535 =
// sin dato) → base64. Bajos: profundidad en cm (Uint8, 0 = no es bajo, tope
// 254). La pendiente NO viaja (el panel la saca de la grilla con las mismas
// diferencias centrales que pendientes()): ahorra ~25 % del JSON; las
// estadísticas de pendiente sí van en stats.
function b64(typed) { return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64"); }

function aU16LE(arr) {
  const out = new Uint16Array(arr.length);
  // Uint16Array usa el endianness de la máquina; Node en x64/arm64 es LE.
  out.set(arr);
  return out;
}

function serializar(R, meta = {}) {
  if (!R.ok) return { ok: false, ver: R.ver, motivo: R.motivo, stats: R.stats, params: R.params, ...meta };
  const G = R.grilla, pr = R.pr;
  const N = G.nx * G.ny;
  let zmin = Infinity;
  for (let i = 0; i < N; i++) if (G.z[i] < zmin) zmin = G.z[i];
  const zBase = Math.floor(zmin * 100) / 100;
  const zq = new Uint16Array(N), bq = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const v = G.z[i];
    zq[i] = Number.isNaN(v) ? NULO_U16 : Math.min(65534, Math.round((v - zBase) * 100));
    const b = R.bajos.prof[i];
    bq[i] = b > 0 ? Math.max(1, Math.min(254, Math.round(b * 100))) : 0;
  }
  // Bordes de la grilla (bordes de celda, no centros) en lat/lon.
  const xW = G.x0 - G.res / 2, xE = G.x0 + (G.nx - 1) * G.res + G.res / 2;
  const yN = G.yTop + G.res / 2, yS = G.yTop - (G.ny - 1) * G.res - G.res / 2;
  const [latS, lonW] = pr.aLatLon(xW, yS);
  const [latN, lonE] = pr.aLatLon(xE, yN);
  const celdaALatLon = (col, fila) => pr.aLatLon(G.x0 + col * G.res, G.yTop - fila * G.res);
  const r6 = (v) => Math.round(v * 1e6) / 1e6;

  // Curvas → GeoJSON (lon,lat). Cada nivel = un MultiLineString. "maestra"
  // cada 5 intervalos (se dibuja más gruesa).
  const inter = R.curvas.intervalo;
  const features = R.curvas.niveles.map(nv => {
    const lineas = nv.lineas.map(l => simplificar(l, 0.12)).filter(l => l.length >= 2)
      .map(l => l.map(([c, f]) => { const [la, lo] = celdaALatLon(c, f); return [r6(lo), r6(la)]; }));
    const k = Math.round(nv.elev / inter);
    return lineas.length ? {
      type: "Feature",
      properties: { elev: Math.round(nv.elev * 1000) / 1000, maestra: k % 5 === 0 },
      geometry: { type: "MultiLineString", coordinates: lineas },
    } : null;
  }).filter(Boolean);

  const zonas = R.bajos.zonas.slice(0, 100).map(zn => {
    const [la, lo] = celdaALatLon(zn.col, zn.fila);
    return { lat: r6(la), lon: r6(lo), area_m2: Math.round(zn.area_m2), prof_max_cm: Math.round(zn.prof_max_m * 100),
      volumen_m3: Math.round(zn.volumen_m3 * 10) / 10 };
  });

  return {
    ok: true,
    ver: R.ver,
    params: R.params,
    ...meta,
    grilla: {
      nx: G.nx, ny: G.ny, res: G.res, orden: "fila0_norte",
      bounds: [[r6(latS), r6(lonW)], [r6(latN), r6(lonE)]],
      z_base: zBase, z_escala: 0.01, nulo: NULO_U16,
      z: b64(aU16LE(zq)),
      bajos_cm: b64(bq),
    },
    curvas: { type: "FeatureCollection", properties: { intervalo_m: inter }, features },
    bajos: zonas,
    stats: R.stats,
  };
}

// Decodifica la grilla serializada (para exportar/tests): Float32 con NaN.
function decodificarGrilla(S) {
  const g = S.grilla;
  const buf = Buffer.from(g.z, "base64");
  const N = g.nx * g.ny;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = buf.readUInt16LE(2 * i);
    out[i] = v === g.nulo ? NaN : g.z_base + v * g.z_escala;
  }
  return out;
}

module.exports = {
  PLANI_VER,
  // pasos (exportados para tests)
  indiceParte, ordenarPartes, juntarPuntos, crearAcumulador, crearProyeccion, proyectar,
  segmentarPasadas, estimarEspaciado, nivelarPasadas, grillar, pendientes, bajos, curvasNivel,
  simplificar, crearHash,
  // orquestación
  calcularPlanimetria, calcularDesdePuntos, serializar, decodificarGrilla,
};
