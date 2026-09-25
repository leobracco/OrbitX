// mapa.js — Mapa a pantalla completa con las máquinas en vivo y los límites
// de los lotes. Arranca con /api/tracking/live (últimos 5 min) y después se
// actualiza por socket. Sin señal: lotes y últimas posiciones desde cache
// sobre fondo liso (los tiles no se cachean, ver spec).
//
// Modo "recorrido": al tocar una máquina se pide
// GET /api/tracking/history/:deviceId?date=YYYY-MM-DD y se dibuja la traza
// del día encima del mapa, sin sacar el punto vivo. El endpoint devuelve
// { device_id, date, points:[{lat,lon,heading,speed,field,ts}], resumen }
// con resumen = { km_total, km_sin_piloto, min_mov_con_piloto,
// min_mov_sin_piloto }. Nada de hectáreas: el endpoint no las calcula y no
// se inventan acá.
//
// Sobre ese recorrido se puede pintar la DOSIS de QuantiX: cada punto puede
// traer `qx` (un registro por motor con lo que pidió PilotX y lo que contó el
// sensor, ver normalizarQx en routes/tracking.js), y la traza se colorea verde
// / ámbar / rojo según cómo venía siguiendo el objetivo en ese lugar del lote.
// El criterio de "fuera de objetivo" NO se define acá: se importa de
// equipos.js, así lo que en la lista de equipos es una alarma amarilla en el
// mapa es un tramo amarillo y no dos cosas distintas.
import { crearSheet } from "../ui/sheet.js";
import { haceCuanto, fechaISOHoy } from "../core/fecha.js";
import { esc } from "../ui/html.js";
import {
  UMBRAL_DESVIO, normalizarMotores, estadoMotor, desvioRelativo, formatearValor,
} from "./equipos.js";

const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const VIEJO_MS = 2 * 60 * 1000; // sin dato hace >2 min → marcador amarillo (mismo criterio que devices.js:254)
const COLOR_TRAZA = "#3C9EFF";  // --ap-blue: contrasta con el verde de lotes/máquinas sobre la imagen satelital
const TZ = "America/Argentina/Buenos_Aires";

// ── Estados de dosificación de un punto del recorrido ───────────────────
// `orden` es la severidad: se usa para elegir el peor motor de un punto y para
// apilar los colores en el mapa (lo rojo arriba de lo verde, que si no un
// bache corto queda tapado por la pasada de al lado).
// Los colores son los mismos tokens que usa el resto de la PWA
// (--ap-green / --ap-yellow / --ap-red / --ap-muted-2), pero acá van literales
// porque Leaflet pinta SVG por atributo y no lee variables CSS.
// "cerrado" y "sin_dato" comparten el gris a propósito: en los dos casos el
// mapa NO está diciendo que algo ande mal, solo que ahí no hay nada que juzgar.
export const ESTADOS_DOSIS = Object.freeze({
  critico:  { orden: 3, tono: "err",  color: "#E74C3E", titulo: "No estaba dosificando", ayuda: "sección abierta, dosis cargada y el sensor no contaba nada" },
  desviado: { orden: 2, tono: "warn", color: "#F5C400", titulo: "Fuera de objetivo",     ayuda: `se despegó más del ${Math.round(UMBRAL_DESVIO * 100)}% de lo pedido` },
  ok:       { orden: 1, tono: "ok",   color: "#A4BA3E", titulo: "En objetivo",           ayuda: "el real siguió a lo que pidió la pantalla" },
  cerrado:  { orden: 0, tono: "",     color: "#6F7882", titulo: "Sin sembrar",           ayuda: "sección cerrada: acá no tenía que tirar" },
  sin_dato: { orden: 0, tono: "",     color: "#6F7882", titulo: "Sin dato de dosis",     ayuda: "el equipo no informó QuantiX en esos puntos" },
});
// Traduce el estado POR MOTOR de equipos.js al estado POR PUNTO del mapa. Un
// motor sin objetivo cargado no es una falla ni es "no sembraba": es un punto
// sobre el que no se puede opinar, así que cae en el gris junto al sin dato.
const ESTADO_DE_MOTOR = Object.freeze({
  apagado: "cerrado", cortado: "critico", desviado: "desviado",
  ok: "ok", sin_dato: "sin_dato", sin_objetivo: "sin_dato",
});
const SIN_DOSIS = Object.freeze({ estado: "sin_dato", total: 0, abiertos: 0, cerrados: 0, peor: null, desvio: null });

// ── Umbral de simplificación de la traza ────────────────────────────────
// La pantalla postea a ~1 Hz y una sembradora trabaja a 6–10 km/h, o sea un
// punto cada ~2 m: una jornada de 8 h son ~28.000 puntos. Encima el equipo
// quieto (carga de semilla, almuerzo) sigue posteando y apila puntos sobre
// el mismo lugar.
// A zoom 15, que es donde entra un lote entero en un celular, un píxel son
// ~4 m; dos puntos separados por menos de 8 m caen en el mismo par de
// píxeles, así que descartarlos NO cambia el dibujo y saca ~3/4 de los
// vértices (y colapsa las paradas a un punto). Se conservan siempre el
// primero y el último para no mentir el arranque ni el final de la jornada.
const MIN_METROS = 8;
// Techo duro: Leaflet en un celular de cabina empieza a trabarse (pan/zoom
// a tirones) arriba de ~2.000 vértices en una sola polilínea. Si después
// del filtro por distancia todavía sobran puntos, se diezma parejo.
const MAX_PUNTOS = 2000;

// ── Funciones puras (exportadas para tests) ─────────────────────────────

// Número o NaN. Ojo con el atajo `Number(v)`: `Number(null)`, `Number("")` y
// `Number(false)` valen 0, así que un punto con `lat: null` se colaría como
// si estuviera sobre el ecuador. Acá null/vacío/booleano son NaN a propósito.
function num(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
// Un punto dibujable: coordenadas numéricas, dentro del planeta, y que no sea
// el 0/0 que deja PilotX cuando postea sin fix (OrbitXSync manda
// `parseFloat(lat)||0`, así que la isla Null es "no había señal").
function puntoValido(p) {
  if (!p || typeof p !== "object") return false;
  const lat = num(p.lat), lon = num(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  return !(lat === 0 && lon === 0);
}

// Pasa la respuesta de /api/tracking/history a una lista de puntos usable.
// Acepta el objeto completo o directamente el array.
export function normalizarRecorrido(respuesta) {
  const bruto = Array.isArray(respuesta) ? respuesta
    : Array.isArray(respuesta?.points) ? respuesta.points
    : [];
  const puntos = [];
  for (const p of bruto) {
    if (!puntoValido(p)) continue;
    const ts = num(p.ts);
    if (!Number.isFinite(ts)) continue;
    const q = {
      lat: num(p.lat), lon: num(p.lon), ts,
      speed: Number.isFinite(num(p.speed)) ? num(p.speed) : 0,
      field: typeof p.field === "string" ? p.field : "",
    };
    // `qx` viaja crudo y SOLO si vino, igual que lo guarda el server: un
    // equipo sin QuantiX no tiene por qué arrastrar un null por cada punto de
    // la jornada, y el resto del mapa distingue "no informó" por su ausencia.
    if (Array.isArray(p.qx) && p.qx.length) q.qx = p.qx;
    puntos.push(q);
  }
  // Los buckets vienen ordenados por Couch pero los legacy `tracking_point`
  // se mezclan: sin ordenar, la polilínea dibuja zigzags que no pasaron.
  puntos.sort((a, b) => a.ts - b.ts);
  return puntos;
}

// Primer y último punto del recorrido, en ms. `minutos` es el lapso cubierto
// (incluye las paradas: es "de tal hora a tal hora", no horas de trabajo).
export function rangoHorario(puntos) {
  if (!Array.isArray(puntos) || puntos.length === 0) return null;
  let desde = Infinity, hasta = -Infinity;
  for (const p of puntos) {
    const ts = num(p?.ts);
    if (!Number.isFinite(ts)) continue;
    if (ts < desde) desde = ts;
    if (ts > hasta) hasta = ts;
  }
  if (!Number.isFinite(desde) || !Number.isFinite(hasta)) return null;
  return { desde, hasta, minutos: Math.round((hasta - desde) / 60000) };
}

// Distancia aproximada en metros. Equirectangular en vez de haversine: sobre
// 28.000 puntos la diferencia de precisión es irrelevante para decidir si dos
// puntos caen en el mismo píxel, y cuesta la mitad.
function metrosEntre(a, b) {
  const latMed = ((num(a?.lat) + num(b?.lat)) / 2) * Math.PI / 180;
  const dx = (num(b?.lon) - num(a?.lon)) * 111320 * Math.cos(latMed);
  const dy = (num(b?.lat) - num(a?.lat)) * 110540;
  return Math.hypot(dx, dy);
}

// Achica la traza para que se pueda dibujar en un celular. Conserva SIEMPRE
// el primero y el último punto (son el arranque y el final de la jornada: si
// los pierde, el rango horario que se muestra al lado miente). Los del medio
// con coordenadas rotas se descartan aunque debieran haber caído antes en
// normalizarRecorrido: un NaN metido en la polilínea la parte a la mitad.
//
// `estadoDe` es opcional y es lo que evita que la simplificación se coma un
// bache de siembra. Tirar puntos por distancia está bien mientras todos digan
// lo mismo: dos puntos a 3 m que estaban los dos en objetivo son el mismo
// dibujo y el mismo dato. Pero si el de al lado cambió de estado (el motor
// dejó de contar, o volvió a entrar en objetivo), descartarlo NO es perder
// precisión de dibujo: es borrar el bache entero. Un surco tapado a 8 km/h
// durante 3 segundos son ~7 m, o sea justo por debajo del umbral — el caso que
// más importa ver es el que se perdería. Por eso todo cambio de estado fuerza
// vértice, tanto en el filtro por distancia como en el diezmado: los puntos
// que se descartan son siempre vecinos del MISMO estado, así que ningún tramo
// promedia dosis de lugares distintos del lote.
export function simplificarTraza(puntos, minMetros = MIN_METROS, maxPuntos = MAX_PUNTOS, estadoDe = null) {
  if (!Array.isArray(puntos)) return [];
  if (puntos.length <= 2) return puntos.slice();
  const est = typeof estadoDe === "function" ? estadoDe : () => null;

  const filtrados = [puntos[0]];
  let ref = puntos[0], refEstado = est(puntos[0]);
  for (let i = 1; i < puntos.length - 1; i++) {
    if (!puntoValido(puntos[i])) continue;
    const e = est(puntos[i]);
    if (e !== refEstado || metrosEntre(ref, puntos[i]) >= minMetros) {
      filtrados.push(puntos[i]); ref = puntos[i]; refEstado = e;
    }
  }
  filtrados.push(puntos[puntos.length - 1]);

  if (filtrados.length <= maxPuntos) return filtrados;
  const paso = Math.ceil(filtrados.length / maxPuntos);
  const diezmados = [];
  let ultEstado = est(filtrados[0]);
  for (let i = 0; i < filtrados.length; i++) {
    const e = est(filtrados[i]);
    if (i % paso === 0 || e !== ultEstado) { diezmados.push(filtrados[i]); ultEstado = e; }
  }
  const ultimo = filtrados[filtrados.length - 1];
  if (diezmados[diezmados.length - 1] !== ultimo) diezmados.push(ultimo);
  return diezmados;
}

// ── Dosis de QuantiX sobre el recorrido ─────────────────────────────────

// DECISIÓN DE DISEÑO: un punto tiene varios motores (una sembradora real trae
// 14 o 24 surcos) y el tramo se pinta con el PEOR de los que estaban sembrando.
//
// Por qué el peor y no el promedio: si se tapa un surco de 24, el promedio se
// mueve un 4% y el mapa queda verde de punta a punta — justo el problema que
// vinimos a buscar desaparece en la cuenta. El operario no siembra "en
// promedio": esa hectárea le quedó con un surco vacío y eso se ve en la
// cosecha. Por qué tampoco la proporción de motores fuera de objetivo:
// obligaría a inventar un segundo umbral ("¿desde cuántos surcos pinto
// amarillo?") que no existe en ningún otro lado del producto, y con un solo
// surco roto tendría que pintar igual, o sea que termina siendo el peor motor
// con pasos de más. Y sobre todo: en Equipos la alarma ya es POR MOTOR — si un
// surco fuera de objetivo prende el chip amarillo en la lista, tiene que
// pintar amarillo en el mapa, o el mismo dato dice dos cosas distintas.
//
// El costo de elegir el peor es que un mapa muy rojo puede ser un solo surco
// malo toda la jornada; por eso el tramo se queda con el motor culpable y la
// referencia lo nombra (surco N, pidió X, salió Y) en vez de dejar al operario
// adivinando cuál de los 24 mirar.
//
// Los motores con la sección cerrada NO participan: un motor apagado a
// propósito tiene el real en cero y no está fallando (mismo orden de preguntas
// que estadoMotor en equipos.js). Si TODOS estaban cerrados, el punto es
// "cerrado" (neutro: ahí no sembraba, no es un problema).
export function clasificarDosis(punto, umbral = UMBRAL_DESVIO) {
  const qx = punto?.qx;
  // Atajo barato y el caso de hoy: ningún equipo en producción manda `qx`
  // todavía, así que la jornada entera sale por acá sin normalizar un motor.
  if (!Array.isArray(qx) || qx.length === 0) return SIN_DOSIS;
  const motores = normalizarMotores(qx);
  if (!motores.length) return SIN_DOSIS;

  let estado = null, peor = null, peorAbs = -1;
  let abiertos = 0, cerrados = 0, sinDato = 0;
  for (const m of motores) {
    const clave = ESTADO_DE_MOTOR[estadoMotor(m, umbral).clave] || "sin_dato";
    if (clave === "cerrado") { cerrados++; continue; }
    abiertos++;
    if (clave === "sin_dato") { sinDato++; continue; }
    const d = desvioRelativo(m.obj, m.real);
    const abs = Number.isFinite(d) ? Math.abs(d) : 0;
    const orden = ESTADOS_DOSIS[clave].orden;
    const ordenActual = estado ? ESTADOS_DOSIS[estado].orden : -1;
    // A igual severidad gana el que más se despegó: es el que hay que ir a ver.
    if (orden > ordenActual || (orden === ordenActual && abs > peorAbs)) {
      estado = clave; peor = m; peorAbs = abs;
    }
  }
  // Sin ningún motor juzgable: "cerrado" solo si TODOS estaban cerrados. Si
  // había alguno abierto pero sin dato, el punto es gris por ignorancia, no
  // por estar sin sembrar — decir "no sembraba" ahí sería inventar.
  if (!estado) estado = cerrados > 0 && sinDato === 0 ? "cerrado" : "sin_dato";
  return {
    estado, total: motores.length, abiertos, cerrados, peor,
    desvio: peor ? desvioRelativo(peor.obj, peor.real) : null,
  };
}

// Agrupa puntos consecutivos del mismo estado en tramos. Esto es lo que evita
// las miles de polilíneas: no se dibuja un segmento por par de puntos sino un
// tramo por RACHA, y una sembradora trabaja en rachas largas (un surco tapado
// lo está por media pasada, no por un segundo). Encima el dibujo junta después
// todos los tramos del mismo color en UNA sola capa Leaflet multi-línea, así
// que el mapa tiene como mucho 5 capas pase lo que pase con el dato.
//
// Cada punto pertenece a UN solo tramo (no se duplican los bordes): el puente
// visual entre dos colores lo agrega el dibujo, no la agrupación, para que
// valga la cuenta "la suma de los tramos es la cantidad de puntos".
export function agruparTramos(puntos) {
  const lista = Array.isArray(puntos) ? puntos : [];
  const tramos = [];
  for (const p of lista) {
    const c = clasificarDosis(p);
    const ult = tramos[tramos.length - 1];
    if (ult && ult.estado === c.estado) {
      ult.puntos.push(p);
      // El detalle del tramo es su peor momento: el que se va a mostrar.
      const abs = Math.abs(Number(c.desvio) || 0);
      if (abs > Math.abs(Number(ult.detalle?.desvio) || 0)) ult.detalle = c;
    } else {
      tramos.push({ estado: c.estado, puntos: [p], detalle: c });
    }
  }
  return tramos;
}

// Resumen del día por estado, en puntos y en metros. Los metros son lo que el
// operario entiende ("1,2 km fuera de objetivo" dice algo; "340 puntos" no).
// Cada segmento se le carga al estado del punto de LLEGADA, la misma regla con
// la que se pinta, para que la referencia y el mapa no se contradigan.
export function resumenDosis(puntos) {
  const lista = Array.isArray(puntos) ? puntos : [];
  const estados = {};
  for (const k of Object.keys(ESTADOS_DOSIS)) estados[k] = { puntos: 0, metros: 0 };
  let previo = null;
  for (const p of lista) {
    const e = clasificarDosis(p).estado;
    estados[e].puntos++;
    if (previo) estados[e].metros += metrosEntre(previo, p);
    previo = p;
  }
  const conDosis = estados.ok.puntos + estados.desviado.puntos + estados.critico.puntos;
  return {
    total: lista.length,
    conDosis,
    // "Hay datos" incluye la sección cerrada: que el equipo informe que no
    // estaba sembrando ES dato de QuantiX, y sin esto un recorrido de traslado
    // con QuantiX instalado diría "no tiene datos de dosificación".
    hayDatos: lista.length > 0 && estados.sin_dato.puntos < lista.length,
    estados,
  };
}

// ── Formato ─────────────────────────────────────────────────────────────

function horaAR(ts) {
  if (!Number.isFinite(ts)) return "—";
  return new Intl.DateTimeFormat("es-AR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(ts));
}
function duracion(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
function num1(v) { return (Math.round(Number(v) * 10) / 10).toFixed(1).replace(".", ","); }
// Metros abajo del kilómetro y km arriba: "820 m fuera de objetivo" se
// entiende de una, "0,8 km" hay que traducirlo mentalmente.
function distancia(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 1000 ? `${num1(n / 1000)} km` : `${Math.round(n)} m`;
}
function recortar(txt, n = 16) {
  const s = String(txt ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function numeroFinito(v) { const n = num(v); return Number.isFinite(n) ? n : null; }

// ── Pantalla ────────────────────────────────────────────────────────────

export async function montar(ctx, root) {
  root.innerHTML = `
    <div id="mapa" class="mapa"></div>
    <div class="chip-flotante" id="chips"></div>
    <div class="sheet" id="sheet"><div class="handle"></div><div class="cuerpo"><ul class="lista" id="lista-maq"></ul></div></div>`;

  const mapa = L.map("mapa", { zoomControl: false, attributionControl: false }).setView([-34.6, -60.9], 7);
  L.tileLayer(TILES, { maxZoom: 18 }).addTo(mapa);
  const capaLotes = L.layerGroup().addTo(mapa);
  const capaRecorrido = L.layerGroup().addTo(mapa); // se vacía al cambiar de máquina y al desmontar
  const marcadores = new Map(); // device_id → { marker, datos }
  const sheet = crearSheet(root.querySelector("#sheet"));
  const ul = root.querySelector("#lista-maq");
  let timer = null, primerEncuadre = true, desmontado = false;
  // Estado del modo recorrido. `gen` corta las respuestas que llegan tarde
  // cuando el usuario ya cambió de máquina o salió del modo.
  let recorrido = null, gen = 0;
  // Preferencia del usuario para el pintado por dosis; sobrevive al cambio de
  // máquina (el que está mirando dosificación quiere seguir mirándola en la
  // siguiente). Arranca en true porque cuando hay dato de QuantiX la traza
  // coloreada es la misma línea con más información: no se pierde nada y se
  // gana el "dónde sembró flojo". Si el recorrido no tiene dato, la bandera no
  // alcanza: dosisActiva() manda.
  let modoDosis = true;
  function dosisActiva() { return modoDosis && !!recorrido?.dosis?.hayDatos; }

  function icono(viejo) {
    return L.divIcon({ className: "", html: `<div class="marcador-maquina ${viejo ? "viejo" : ""}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
  }
  function upsertMaquina(d) {
    const viejo = Date.now() - d.ts > VIEJO_MS;
    const ll = [d.lat, d.lon];
    const prev = marcadores.get(d.device_id);
    if (prev) { prev.marker.setLatLng(ll).setIcon(icono(viejo)); prev.datos = { ...prev.datos, ...d }; }
    else marcadores.set(d.device_id, { marker: L.marker(ll, { icon: icono(viejo) }).addTo(mapa), datos: d });
  }

  // ── Recorrido del día ────────────────────────────────────────────────

  // Nombre del motor culpable para el tooltip. Sin `id` (equipo viejo que no
  // informa el surco) se cae al UID de la caja, recortado.
  function nombreMotor(m) {
    if (!m) return "";
    return m.id === null || m.id === undefined ? recortar(m.uid, 12) : `surco ${m.id}`;
  }
  // Todo lo que entra al tooltip pasa por esc(): el uid y la unidad salen de
  // la base y Leaflet inserta el tooltip como HTML.
  function tooltipDosis(clave, datos) {
    const e = ESTADOS_DOSIS[clave];
    const partes = [`<b>${esc(e.titulo)}</b>`, esc(distancia(datos.metros))];
    const peor = datos.detalle?.peor;
    if (peor && (clave === "desviado" || clave === "critico")) {
      partes.push(esc(`peor: ${nombreMotor(peor)} pidió ${formatearValor(peor.obj, peor.unidad)}, salió ${formatearValor(peor.real, peor.unidad)}`));
    }
    return partes.join("<br>");
  }

  // Pinta la traza por dosis. Enfoque: agrupar en rachas del mismo estado y
  // después meter TODAS las rachas de un color en una sola capa Leaflet
  // (L.polyline acepta una lista de líneas y las dibuja como un único path
  // SVG con varios sub-trazos). Así el mapa tiene 5 capas como máximo por más
  // fragmentado que venga el día, en vez de una polilínea por racha: en un
  // celular de cabina la diferencia entre 5 y 800 capas es que el pan/zoom
  // ande o vaya a los tirones.
  function dibujarPorDosis(p) {
    const tramos = agruparTramos(p);
    const porEstado = new Map(); // estado → { lineas, metros, detalle }
    for (let i = 0; i < tramos.length; i++) {
      const t = tramos[i];
      // Se le antepone el último punto del tramo anterior para que no queden
      // huecos blancos entre colores. El segmento puente toma el color del
      // tramo nuevo: el cambio de estado empieza justo ahí.
      const anterior = i > 0 ? tramos[i - 1].puntos[tramos[i - 1].puntos.length - 1] : null;
      const pts = anterior ? [anterior, ...t.puntos] : t.puntos;
      if (pts.length < 2) continue; // un punto suelto no dibuja línea
      let acc = porEstado.get(t.estado);
      if (!acc) { acc = { lineas: [], metros: 0, detalle: t.detalle }; porEstado.set(t.estado, acc); }
      acc.lineas.push(pts.map(q => [q.lat, q.lon]));
      for (let k = 1; k < pts.length; k++) acc.metros += metrosEntre(pts[k - 1], pts[k]);
      if (Math.abs(Number(t.detalle?.desvio) || 0) > Math.abs(Number(acc.detalle?.desvio) || 0)) acc.detalle = t.detalle;
    }
    // De menor a mayor severidad: lo rojo se dibuja último y queda arriba. Si
    // no, la pasada de al lado (verde) tapa el bache y desaparece del mapa.
    const orden = Object.keys(ESTADOS_DOSIS).sort((a, b) => ESTADOS_DOSIS[a].orden - ESTADOS_DOSIS[b].orden);
    for (const clave of orden) {
      const acc = porEstado.get(clave);
      if (!acc) continue;
      const e = ESTADOS_DOSIS[clave];
      // Lo neutro va más apagado: tiene que verse (si no el recorrido se corta
      // a la vista) pero sin competir con los tramos que sí dicen algo.
      L.polyline(acc.lineas, { color: e.color, weight: 4, opacity: e.orden === 0 ? 0.7 : 0.95 })
        .bindTooltip(tooltipDosis(clave, acc), { sticky: true })
        .addTo(capaRecorrido);
    }
  }

  function dibujarTraza(encuadrar = true) {
    capaRecorrido.clearLayers(); // saca también las capas de dosis: son del mismo grupo
    const p = recorrido?.puntos;
    if (!p?.length) return;
    if (p.length > 1) {
      if (dosisActiva()) dibujarPorDosis(p);
      else L.polyline(p.map(q => [q.lat, q.lon]), { color: COLOR_TRAZA, weight: 3, opacity: 0.9 }).addTo(capaRecorrido);
    }
    const ini = p[0], fin = p[p.length - 1];
    L.circleMarker([ini.lat, ini.lon], { radius: 5, color: COLOR_TRAZA, weight: 2, fillColor: "#0E1512", fillOpacity: 1 })
      .bindTooltip(`Arrancó ${horaAR(ini.ts)}`).addTo(capaRecorrido);
    if (fin !== ini) {
      L.circleMarker([fin.lat, fin.lon], { radius: 5, color: COLOR_TRAZA, weight: 2, fillColor: COLOR_TRAZA, fillOpacity: 1 })
        .bindTooltip(`Último punto ${horaAR(fin.ts)}`).addTo(capaRecorrido);
    }
    // Al prender/apagar el pintado por dosis NO se reencuadra: el que está
    // mirando un pedazo del lote de cerca lo perdería en cada toque.
    if (encuadrar) mapa.fitBounds(p.map(q => [q.lat, q.lon]), { padding: [30, 30], maxZoom: 16 });
  }

  async function abrirRecorrido(deviceId, nombre) {
    const mio = ++gen;
    recorrido = { deviceId, nombre: nombre || deviceId, puntos: [], resumen: null, dosis: null, cargando: true, error: "", desdeCache: false };
    capaRecorrido.clearLayers();
    pintarLista();
    sheet.abrir();
    try {
      // El endpoint arma el día en UTC; le mandamos el día argentino para que
      // "hoy" sea el que ve el operario y no el del server.
      const dia = fechaISOHoy();
      const r = await ctx.api.get(`/api/tracking/history/${encodeURIComponent(deviceId)}?date=${encodeURIComponent(dia)}`);
      if (desmontado || mio !== gen) return; // cambió de máquina mientras cargaba
      // La simplificación se hace SIEMPRE consciente de la dosis, aunque el
      // usuario mire la traza común: así prender el color no obliga a pedir el
      // día de nuevo y las dos vistas dibujan exactamente los mismos vértices.
      // Cuando no hay `qx` (el caso de hoy) clasificarDosis sale por el atajo
      // y esto cuesta lo mismo que antes.
      recorrido.puntos = simplificarTraza(
        normalizarRecorrido(r.data), MIN_METROS, MAX_PUNTOS, p => clasificarDosis(p).estado);
      recorrido.dosis = resumenDosis(recorrido.puntos);
      recorrido.resumen = r.data?.resumen || null;
      recorrido.desdeCache = !!r.desdeCache;
      recorrido.cargando = false;
      dibujarTraza();
    } catch (e) {
      if (desmontado || mio !== gen) return;
      recorrido.cargando = false;
      recorrido.error = e.name === "ErrorSinDatos"
        ? "Sin señal y sin recorrido guardado."
        : (e.message || "No se pudo traer el recorrido.");
    }
    pintarLista();
  }
  function cerrarRecorrido() {
    gen++;                       // invalida una carga en vuelo
    recorrido = null;
    capaRecorrido.clearLayers(); // la traza no queda colgada sobre el mapa
    pintarLista();
  }

  function filasRecorrido() {
    const r = recorrido;
    const nombre = esc(recortar(r.nombre, 28));
    const volver = `<li><button class="fila" data-volver>
        <span class="dot"></span>
        <span class="txt"><b>← Todas las máquinas</b><span>Salir del recorrido</span></span>
        <span class="val">Volver</span></button></li>`;

    if (r.cargando) {
      return volver + `<li class="fila"><span class="dot info"></span>
        <span class="txt"><b>Recorrido de ${nombre}</b><span>Buscando por dónde anduvo hoy…</span></span></li>`;
    }
    if (r.error) {
      return volver + `<li class="fila"><span class="dot err"></span>
        <span class="txt"><b>Recorrido de ${nombre}</b><span>${esc(r.error)}</span></span></li>`;
    }
    if (!r.puntos.length) {
      return volver + `<li class="vacio">Sin recorrido registrado hoy para ${nombre}.</li>`;
    }

    const rg = rangoHorario(r.puntos);
    const km = numeroFinito(r.resumen?.km_total);
    const conLote = numeroFinito(r.resumen?.min_mov_con_piloto);
    const sinLote = numeroFinito(r.resumen?.min_mov_sin_piloto);
    const cache = r.desdeCache ? " · dato guardado" : "";

    let html = volver + `<li class="fila"><span class="dot info"></span>
      <span class="txt"><b>Recorrido de ${nombre}</b>
      <span>De ${horaAR(rg.desde)} a ${horaAR(rg.hasta)} · ${duracion(rg.minutos)} entre el primer y el último punto${cache}</span></span>
      <span class="val">${km === null ? "" : num1(km) + " km"}</span></li>`;

    html += filasDosis();

    if ((conLote ?? 0) > 0 || (sinLote ?? 0) > 0) {
      const detalle = [];
      if ((conLote ?? 0) > 0) detalle.push(`${duracion(conLote)} con lote abierto`);
      if ((sinLote ?? 0) > 0) detalle.push(`${duracion(sinLote)} sin lote`);
      html += `<li class="fila"><span class="dot ok"></span>
        <span class="txt"><b>En movimiento</b><span>${esc(detalle.join(" · "))}</span></span>
        <span class="val">${duracion((conLote ?? 0) + (sinLote ?? 0))}</span></li>`;
    }
    return html;
  }

  // Bloque de dosificación del sheet: el interruptor y, cuando está pintado,
  // la referencia de colores. La referencia va acá arriba y no en un cartel
  // flotante porque la tira de chips no entra en un celular de 360 px, y
  // porque con la altura mínima del sheet estas filas quedan a la vista.
  function filasDosis() {
    const d = recorrido?.dosis;
    if (!d) return "";
    if (!d.hayDatos) {
      // El caso normal hoy: ningún equipo manda QuantiX con la posición. Se
      // dice y listo — la traza común queda dibujada igual, sin botón que no
      // haga nada ni mapa mudo.
      return `<li class="fila"><span class="dot"></span>
        <span class="txt"><b>Dosificación</b><span>Este recorrido no tiene datos de dosificación.</span></span></li>`;
    }
    const activo = dosisActiva();
    let html = `<li><button class="fila" data-dosis>
      <span class="dot ${activo ? "ok" : ""}"></span>
      <span class="txt"><b>${activo ? "Pintado por dosis" : "Recorrido común"}</b>
      <span>${activo ? "Cada tramo con el peor motor que estaba sembrando ahí" : "Pintalo para ver dónde se sembró flojo"}</span></span>
      <span class="val">${activo ? "Quitar" : "Pintar"}</span></button></li>`;
    if (!activo) return html;

    for (const clave of Object.keys(ESTADOS_DOSIS)) {
      const e = ESTADOS_DOSIS[clave], dat = d.estados[clave];
      if (!dat.puntos) continue; // no se lista un color que no está en el mapa
      html += `<li class="fila"><span class="dot ${e.tono}"></span>
        <span class="txt"><b>${esc(e.titulo)}</b><span>${esc(e.ayuda)}</span></span>
        <span class="val">${esc(distancia(dat.metros))}</span></li>`;
    }
    return html;
  }

  function chipsRecorrido() {
    const r = recorrido;
    const nombre = `<span class="pill ok">Recorrido · ${esc(recortar(r.nombre))}</span>`;
    if (r.cargando) return nombre + `<span class="pill">buscando…</span>`;
    if (r.error) return nombre + `<span class="pill err">sin datos</span>`;
    const rg = rangoHorario(r.puntos);
    // Un solo chip extra: con el mapa pintado hay que saber que lo que se ve
    // es dosis y no el recorrido común. La referencia de colores está en el
    // sheet, que es donde entra.
    const dosis = dosisActiva() ? `<span class="pill warn">por dosis</span>` : "";
    return nombre + (rg ? `<span class="pill">${horaAR(rg.desde)}–${horaAR(rg.hasta)}</span>`
                        : `<span class="pill warn">sin recorrido hoy</span>`) + dosis;
  }

  // ── Lista y chips ────────────────────────────────────────────────────
  function pintarLista() {
    const items = [...marcadores.values()].map(m => m.datos).sort((a, b) => b.ts - a.ts);
    let activas = 0, viejas = 0;
    const filas = [];
    for (const d of items) {
      const viejo = Date.now() - d.ts > VIEJO_MS; viejo ? viejas++ : activas++;
      const elegida = recorrido?.deviceId === d.device_id;
      filas.push(`<li><button class="fila" data-dev="${esc(d.device_id)}">
        <span class="dot ${viejo ? "warn" : "ok"}"></span>
        <span class="txt"><b>${esc(d.nombre || d.device_id)}</b><span>${d.field ? "Lote " + esc(d.field) + " · " : ""}${(d.speed ?? 0).toFixed(1)} km/h</span></span>
        <span class="val">${elegida ? "en el mapa" : haceCuanto(d.ts)}</span></button></li>`);
    }
    if (!filas.length) filas.push(`<li class="vacio">Ninguna máquina reportó en los últimos 5 minutos.</li>`);
    ul.innerHTML = (recorrido ? filasRecorrido() : "") + filas.join("");
    root.querySelector("#chips").innerHTML = recorrido
      ? chipsRecorrido()
      : `<span class="pill ok">${activas} activas</span>${viejas ? `<span class="pill warn">${viejas} sin dato</span>` : ""}`;
  }

  // Un solo listener delegado en el <ul>: la lista se redibuja con cada
  // posición que entra por socket, así que enganchar botón por botón sería
  // crear y tirar listeners varias veces por segundo.
  function alTocarLista(ev) {
    if (ev.target.closest("[data-volver]")) return cerrarRecorrido();
    if (ev.target.closest("[data-dosis]")) {
      modoDosis = !modoDosis;
      dibujarTraza(false); // sin reencuadrar: el usuario ya eligió qué mira
      pintarLista();
      return;
    }
    const b = ev.target.closest("[data-dev]");
    if (!b) return;
    const id = b.dataset.dev;
    const m = marcadores.get(id);
    if (m) mapa.setView(m.marker.getLatLng(), 16);
    if (recorrido?.deviceId === id) { sheet.cerrar(); return; } // ya está dibujado: solo centra
    abrirRecorrido(id, m?.datos.nombre);
  }
  ul.addEventListener("click", alTocarLista);

  async function cargar() {
    try {
      // Los límites salen de los archivos de PilotX (/api/aog/mapa), igual que
      // en el panel: /api/lotes solo tiene los lotes sincronizados como doc
      // "lote", que en muchas orgs es cero. Siempre con ?estab= (un superadmin
      // sin filtro recibiría TODAS las orgs) y ?lite=1 (sin pasadas: 67 MB → KB).
      const org = ctx.usuario?.org_activa;
      const urlLotes = org ? `/api/aog/mapa?estab=${encodeURIComponent(org)}&lite=1` : null;
      const [live, lotes] = await Promise.all([
        ctx.api.get("/api/tracking/live"),
        urlLotes ? ctx.api.get(urlLotes).catch(e => { console.warn("[mapa] lotes:", e.message); return { data: [] }; }) : { data: [] },
      ]);
      ctx.nav.setOffline(live.desdeCache, live.ts);
      for (const d of live.data) upsertMaquina(d);
      capaLotes.clearLayers();
      const bounds = [];
      for (const l of lotes.data) if (Array.isArray(l.boundary) && l.boundary.length > 2) {
        // Tocar un lote abre su detalle, que trae la cobertura de PilotX (acá
        // no se dibuja: son 200–300 KB por lote, ~10 MB para toda la org).
        L.polygon(l.boundary, { color: "#A4BA3E", weight: 1.5, fillOpacity: 0.08 })
          .bindTooltip(esc(l.nombre), { permanent: false })
          .on("click", () => { location.hash = `#/lotes/${encodeURIComponent(l.nombre)}`; })
          .addTo(capaLotes);
        bounds.push(...l.boundary);
      }
      for (const m of marcadores.values()) bounds.push(m.marker.getLatLng());
      // Con un recorrido abierto el encuadre lo manda la traza, no los lotes.
      if (primerEncuadre && bounds.length && !recorrido) { mapa.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 }); primerEncuadre = false; }
      pintarLista();
    } catch (e) { ctx.toast(e.message, "error"); }
  }

  ctx.onPosicion = (p) => { upsertMaquina({ ...p, nombre: marcadores.get(p.device_id)?.datos.nombre }); pintarLista(); };
  await cargar();
  timer = setInterval(() => { if (!ctx.socket?.connected) cargar(); else pintarLista(); }, 30000); // sin socket → polling; con socket → solo refresca "hace X"

  return {
    desmontar() {
      desmontado = true; gen++;            // lo que esté en vuelo no toca un mapa muerto
      clearInterval(timer); timer = null;
      ul.removeEventListener("click", alTocarLista);
      ctx.onPosicion = null;
      recorrido = null;
      capaRecorrido.clearLayers();
      sheet.destruir();
      mapa.remove();
    },
  };
}
