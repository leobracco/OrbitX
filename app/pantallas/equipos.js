// equipos.js — Estado, VERSIONES, CÁMARAS y DOSIFICACIÓN de los equipos de la
// org. "online" lo decide el server (ultimo_visto < 2 min); acá solo se muestra.
//
// Cada equipo muestra la versión de PilotX y, al tocarlo, los nodos que ese
// PilotX ve en su broker con el firmware de cada uno (vienen en el heartbeat,
// campo `nodos`, desde PilotX 1.0.60). Contra el catálogo OTA se marca lo que
// tiene una versión más nueva disponible: es la pregunta que se hace el que
// atiende el parque —quién quedó viejo— y antes había que entrar equipo por
// equipo al panel.
//
// En ese mismo detalle está el acceso a las cámaras del tractor. El video va
// por HLS desde MediaMTX, igual que el panel web: OrbitX firma una URL corta
// (/api/camaras/playback) y el reproductor la consume. Nada de esto se pide en
// el refresco de 60 s — solo cuando el usuario toca "Cámaras".
//
// Y en el mismo detalle está qué dosifica cada motor de QuantiX: lo que pidió
// PilotX contra lo que contó el sensor, en la unidad del operario. Ese dato no
// viene del heartbeat sino de la posición (GET /api/tracking/live) y se pide
// recién al desplegar un equipo — ver el bloque QuantiX más abajo.
import { esc } from "../ui/html.js";
import { haceCuanto } from "../core/fecha.js";

// El `tipo` que reporta el nodo no siempre es el nombre del producto en el
// catálogo: llegan "Quantix" (catálogo "QuantiX") y "Flow" (catálogo "FlowX").
// Se normaliza a minúsculas y, si así no aparece, se prueba con la X final.
export function claveProducto(nombre) {
  return String(nombre || "").trim().toLowerCase();
}
export function buscarUltima(catalogo, nombre) {
  const k = claveProducto(nombre);
  if (!k) return null;
  return catalogo[k] || catalogo[k + "x"] || null;
}

// Compara versiones tipo 1.0.84. Devuelve 1 si a > b, -1 si a < b, 0 si iguales
// o si alguna no es numérica (hay equipos reportando cosas como "AgOpenGPS-AP":
// esos no se comparan, se muestran tal cual).
export function esSemver(v) { return /^\d+(\.\d+)*$/.test(String(v || "").trim()); }
export function comparar(a, b) {
  if (!esSemver(a) || !esSemver(b)) return 0;
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Chip de versión: al día, hay una más nueva, o sin comparación posible.
// Un equipo puede estar MÁS adelantado que el catálogo (build de prueba en
// cabina): eso es "al día", no un problema.
function chipVersion(actual, ultima) {
  if (!actual) return `<span class="pill">sin versión</span>`;
  if (!ultima || comparar(actual, ultima) >= 0) return "";
  return `<span class="pill warn">hay ${esc(ultima)}</span>`;
}

export function hayActualizacion(actual, ultima) {
  return !!(actual && ultima && comparar(actual, ultima) < 0);
}

// ── Cámaras ────────────────────────────────────────────────────────────────
// Saber si un equipo tiene cámaras NO cuesta un pedido extra: /api/devices
// devuelve el doc entero del device, con `camaras` incluido. Por eso el acceso
// se decide con lo que ya está en pantalla y recién al tocarlo se pide el
// detalle (/api/camaras/list) y la URL de video (/api/camaras/playback).
export function contarCamaras(d) {
  return Array.isArray(d?.camaras) ? d.camaras.length : 0;
}

// Por qué una cámara no se puede mirar, en criollo. Replica los rechazos que
// hace el server en /api/camaras/playback: si el server no va a entregar URL
// firmada, no tiene sentido ofrecer el botón y después mostrar un 403 pelado.
const MOTIVOS = {
  marca_no_soportada: "marca no soportada — por ahora solo Hikvision",
  deshabilitada_por_usuario: "desactivada desde PilotX",
};
export function motivoCamara(c) {
  const cam = c || {};
  const marca = String(cam.marca || "").trim().toLowerCase();
  if (marca && marca !== "hikvision") return `marca ${marca} no soportada — por ahora solo Hikvision`;
  if (cam.activa === false) return MOTIVOS[cam.motivo_inactiva] || "desactivada en el equipo";
  // Sin idx no hay path en MediaMTX (<deviceId>_cam<N>): no se puede pedir video.
  if (!Number.isFinite(Number(cam.idx))) return "el equipo no informó el número de cámara";
  return "";
}

// Deja la respuesta de /api/camaras/list en algo que la lista pueda pintar sin
// preguntarse si cada campo vino. `activa` ausente cuenta como activa: así lo
// trata el server (solo rechaza `activa === false`).
export function normalizarCamaras(resp) {
  const r = resp || {};
  const dev = r.device || {};
  const lista = Array.isArray(r.camaras) ? r.camaras : [];
  return {
    nombre: String(dev.nombre || dev.id || ""),
    online: dev.online === true,
    camaras: lista.map((c, i) => {
      const cam = c || {};
      const idx = Number(cam.idx);
      const motivo = motivoCamara(cam);
      return {
        idx: Number.isFinite(idx) ? idx : null,
        nombre: String(cam.nombre || `Cámara ${i + 1}`),
        online: cam.online === true,
        motivo,
        disponible: motivo === "",
      };
    }),
  };
}

// La URL firmada de /api/camaras/playback dura una hora. api.get() puede
// devolver una respuesta vieja de cache cuando no hay red: una firma vencida
// no reproduce nada, así que preferimos avisarlo a dejar un video en negro.
export function urlVideo(resp, ahora = Date.now()) {
  const hls = typeof resp?.hls === "string" ? resp.hls.trim() : "";
  if (!hls) return null;
  const exp = Number(resp?.expiresAt);
  if (Number.isFinite(exp) && exp <= ahora) return null;
  return hls;
}

// hls.js avisa con códigos; el que mira el celular necesita saber qué hacer.
export function textoErrorHls(detalle) {
  const d = String(detalle || "");
  if (d === "manifestLoadError" || d === "manifestLoadTimeOut")
    return "El tractor no está transmitiendo esta cámara. Revisá en PilotX que el módulo Cámaras esté prendido con “Streaming remoto”.";
  if (d === "manifestParsingError") return "El servidor de video devolvió una respuesta inválida.";
  if (d === "manifestIncompatibleCodecsError") return "El formato de esta cámara no lo puede reproducir el teléfono.";
  return d ? `Falló el video (${d}).` : "Falló el video.";
}

// ── QuantiX: qué está dosificando cada motor ───────────────────────────────
// De dónde sale el dato: NO del heartbeat. /api/devices trae el doc del equipo
// (versión, nodos, cámaras) y ahí no hay dosificación. Lo que dosifica cada
// motor viaja pegado a la posición que postea PilotX (routes/tracking.js, campo
// `qx` del POST /position, normalizado por normalizarQx) y el server lo deja en
// el doc `tracking_live` del equipo. Por eso la fuente es
// GET /api/tracking/live, la misma que usa el Mapa: un solo pedido devuelve el
// último punto de TODOS los equipos del establecimiento, con su `qx` y el `ts`
// de ese punto. /api/tracking/history también lo trae, pero es un pedido por
// equipo y por día entero para leer el último valor: no paga.
//
// Un motor NO es un nodo: el nodo es la caja QuantiX (`uid`) y maneja varios
// motores, uno por surco (`id`). Por eso varios motores comparten uid y la
// identidad de cada uno es uid + id.

// Umbral de desvío entre lo que pidió PilotX y lo que contó el sensor.
// Por qué 10% y no menos: el sensor cuenta pulsos sobre una ventana corta y el
// PID está siempre corrigiendo detrás de los cambios de velocidad, así que unos
// pocos puntos de diferencia son el ruido normal de una máquina que anda bien —
// alertar al 3% sería llenar la pantalla de chips amarillos hasta que el
// operario deje de mirarlos. Por qué no más: 10% de 70.000 sem/ha son 7.000
// semillas por hectárea, eso ya se ve en el lote y amerita ir a mirar el surco.
// El borde cuenta como alerta (>=): un motor clavado justo en el 10% es tan
// sospechoso como uno en el 11%.
export const UMBRAL_DESVIO = 0.10;

// Después de 2 minutos sin posición nueva, lo que tenemos es "lo último que
// mandó", no "lo que está dosificando ahora" (mismo criterio que el mapa).
// El server ya saca de /live todo lo anterior a 5 min, pero la respuesta puede
// venir del cache de la PWA sin conexión y tener horas: la edad se mide SIEMPRE
// contra el `ts` del punto, nunca contra cuándo lo pedimos.
export const EDAD_MAX_MS = 2 * 60 * 1000;

// Unidades que entiende el operario. `sem_m` y `kg_ha` son las dos que emite
// normalizarQx; cualquier otra cosa es un server más nuevo o un dato viejo de
// cache. Los pps NO están acá a propósito: son el crudo de diagnóstico y al
// operario no se le muestran pulsos nunca.
const UNIDADES = { sem_m: "sem/m", kg_ha: "kg/ha" };

// Número o null. Ojo con Number(v): Number(null), Number("") y Number(false)
// valen 0, y un 0 acá no es lo mismo que "no vino" — un `real` ausente leído
// como cero haría sonar la alarma de "no está dosificando" sin motivo.
function numeroFinito(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Deja el `qx` de un punto en algo que la lista pueda pintar sin preguntarse si
// cada campo vino. Lo que no es numérico queda en null (= "sin dato"), no en 0.
export function normalizarMotores(qx) {
  if (!Array.isArray(qx)) return [];
  const out = [];
  for (const m of qx) {
    if (!m || typeof m !== "object") continue;
    const id = numeroFinito(m.id);
    out.push({
      uid: String(m.uid || ""),
      id: id === null ? null : Math.trunc(id),
      obj: numeroFinito(m.obj),
      real: numeroFinito(m.real),
      unidad: UNIDADES[m.unidad] ? String(m.unidad) : "",
      carga: numeroFinito(m.carga_pct),
      // Tres estados a propósito: true/false los manda el equipo, null es "no
      // lo informó". Tomar el ausente como sección cerrada silenciaría la
      // alarma de un motor que sí tendría que estar tirando.
      seccion_on: m.seccion_on === undefined || m.seccion_on === null ? null : !!m.seccion_on,
    });
  }
  // Orden estable por caja y después por surco: sin esto, dos refrescos
  // seguidos pueden mostrar los motores en distinto orden y el operario termina
  // comparando filas que se le movieron de lugar.
  out.sort((a, b) => {
    if (a.uid !== b.uid) return a.uid < b.uid ? -1 : 1;
    const ia = a.id === null ? Number.MAX_SAFE_INTEGER : a.id;
    const ib = b.id === null ? Number.MAX_SAFE_INTEGER : b.id;
    return ia - ib;
  });
  return out;
}

// Saca de la respuesta de /api/tracking/live lo que le corresponde a un equipo.
// `reporta:false` = el equipo no está en la respuesta, o sea que no posteó
// posición en los últimos 5 minutos (el server filtra por eso). Eso no es lo
// mismo que reportar posición pero sin dosificación.
export function leerQxLive(lista, deviceId) {
  const arr = Array.isArray(lista) ? lista : [];
  const id = String(deviceId ?? "");
  const d = arr.find(x => x && String(x.device_id) === id);
  if (!d) return { reporta: false, ts: null, motores: [] };
  return { reporta: true, ts: numeroFinito(d.ts), motores: normalizarMotores(d.qx) };
}

// Desvío con signo: -0,2 es 20% por debajo del objetivo. Sin objetivo no hay
// contra qué comparar y además no se puede dividir: devuelve null, no cero.
export function desvioRelativo(obj, real) {
  const o = numeroFinito(obj), r = numeroFinito(real);
  if (o === null || r === null) return null;
  if (o <= 0) return null;
  return (r - o) / o;
}

// Estado de un motor, con el tono que usan las clases de la hoja de estilos
// ("" neutro, ok, warn, err). El orden de las preguntas importa: la sección
// cerrada se contesta ANTES que cualquier cuenta, porque un motor apagado a
// propósito tiene el real en cero y no está fallando.
export function estadoMotor(m, umbral = UMBRAL_DESVIO) {
  if (!m || typeof m !== "object") return { clave: "sin_dato", tono: "", texto: "sin dato" };
  if (m.seccion_on === false) return { clave: "apagado", tono: "", texto: "sección cerrada" };
  const obj = numeroFinito(m.obj), real = numeroFinito(m.real);
  if (obj === null || real === null) return { clave: "sin_dato", tono: "", texto: "sin dato" };
  // Objetivo en cero con la sección abierta: la pantalla todavía no tiene dosis
  // cargada. No es una falla del motor y no se puede calcular desvío.
  if (obj <= 0) return { clave: "sin_objetivo", tono: "", texto: "sin objetivo cargado" };
  // Sección abierta, dosis cargada y el sensor no cuenta nada: surco tapado,
  // correa cortada o motor frenado. Es la alarma que importa.
  if (real <= 0) return { clave: "cortado", tono: "err", texto: "no está dosificando" };
  const d = desvioRelativo(obj, real);
  if (d !== null && Math.abs(d) >= umbral) return { clave: "desviado", tono: "warn", texto: "fuera de objetivo" };
  return { clave: "ok", tono: "ok", texto: "en objetivo" };
}

// Valor en la unidad del operario. Coma decimal: es como lo lee en la pantalla
// del tractor. Una unidad que no conocemos se muestra sin unidad antes que con
// una inventada: confundir kg/ha con sem/m hace errar la dosis por dos órdenes.
export function formatearValor(valor, unidad) {
  const n = numeroFinito(valor);
  if (n === null) return "—";
  const txt = n.toFixed(1).replace(".", ",");
  const u = UNIDADES[unidad];
  return u ? `${txt} ${u}` : txt;
}

// "12% abajo" / "12% arriba". Para el chip: dice de qué lado está el problema,
// que es lo primero que pregunta el que va a corregirlo.
export function formatearDesvio(desvio) {
  if (!Number.isFinite(desvio)) return "";
  const pct = Math.round(Math.abs(desvio) * 100);
  if (pct === 0) return "en objetivo";
  return `${pct}% ${desvio < 0 ? "abajo" : "arriba"}`;
}

// Cuenta para el encabezado. `abiertos` son los que están tirando producto
// (sección no cerrada): son los únicos sobre los que tiene sentido alarmar.
export function resumenMotores(motores) {
  const lista = Array.isArray(motores) ? motores : [];
  let abiertos = 0, alertas = 0, criticos = 0;
  for (const m of lista) {
    const e = estadoMotor(m);
    if (e.clave !== "apagado") abiertos++;
    if (e.tono === "warn") alertas++;
    if (e.tono === "err") { alertas++; criticos++; }
  }
  return { total: lista.length, abiertos, alertas, criticos };
}

// Sangría de las filas del detalle — la misma que usan los nodos y las cámaras,
// para que el desplegado se lea como una sola lista.
const SANGRIA = `padding-left:34px;background:rgba(255,255,255,0.02)`;

function filaAvisoQx(texto, tono = "") {
  return `<li class="fila" style="${SANGRIA}">
    <span class="dot ${tono}"></span>
    <span class="txt"><b>Dosificación</b><span>${esc(texto)}</span></span>
  </li>`;
}

// Filas de dosificación dentro del detalle de un equipo. `qx` es el estado
// compartido del último /api/tracking/live (ver montar).
function filasQuantiX(d, qx, ahora = Date.now()) {
  if (qx.fase === "inicial" || qx.fase === "cargando")
    return filaAvisoQx("buscando qué está dosificando…", "info");
  if (qx.fase === "error")
    return filaAvisoQx(`no se pudo pedir la dosificación — ${qx.mensaje}`);

  const { reporta, ts, motores } = leerQxLive(qx.lista, d.device_id);
  const guardado = qx.desdeCache ? " · dato guardado sin conexión" : "";

  // Sin posición reciente no hay dosificación: el dato viaja con el punto.
  if (!reporta)
    return filaAvisoQx(`el equipo no está reportando posición — la dosificación viaja con la posición, así que vuelve cuando el equipo vuelva a reportar${guardado}`);

  // El caso de hoy en todo el parque: el equipo postea posición pero todavía no
  // manda `qx`. No es un error ni una falla del tractor: falta la versión de
  // PilotX que lo envíe (el código está hecho, no salió a los tractores).
  if (!motores.length)
    return filaAvisoQx(`este equipo todavía no informa lo que dosifica. Lo manda PilotX junto con la posición y hace falta una versión que lo envíe — todavía no llegó a los tractores${guardado}`);

  const edad = ts === null ? Infinity : ahora - ts;
  const fresco = edad <= EDAD_MAX_MS;
  const cuando = ts === null ? "sin hora" : haceCuanto(ts, ahora);
  const r = resumenMotores(motores);

  const encabezado = fresco
    ? `${r.total} motor${r.total === 1 ? "" : "es"} · ${r.abiertos} con la sección abierta · ${cuando}${guardado}`
    : `último dato ${cuando} — no es lo que está dosificando ahora${guardado}`;
  // Con el dato viejo no se afirma nada: el desvío que hubo hace una hora puede
  // estar corregido hace rato. Se muestran los números, sin chips de alerta.
  const chipCab = !fresco ? `<span class="pill">sin dato reciente</span>`
    // Con motores cortados Y motores desviados, el chip dice cuántos hay que
    // mirar en total: contar solo los cortados haría creer que el resto anda.
    : r.criticos ? `<span class="pill err">${r.alertas > r.criticos ? r.alertas + " para revisar" : r.criticos + " sin dosificar"}</span>`
    : r.alertas  ? `<span class="pill warn">${r.alertas} fuera de objetivo</span>`
    : `<span class="pill ok">en objetivo</span>`;

  const cabecera = `<li class="fila" style="${SANGRIA}">
    <span class="dot ${fresco ? (r.criticos ? "err" : r.alertas ? "warn" : "ok") : ""}"></span>
    <span class="txt"><b>Dosificación</b><span>${esc(encabezado)}</span></span>
    <span class="val">${chipCab}</span>
  </li>`;

  const filas = motores.map((m) => {
    const e = estadoMotor(m);
    // "pidió" / "salió": lo que mandó PilotX contra lo que contó el sensor,
    // siempre en la unidad del operario. Los pps no se muestran.
    const partes = [
      `pidió ${formatearValor(m.obj, m.unidad)}`,
      `salió ${formatearValor(m.real, m.unidad)}`,
    ];
    if (m.carga !== null) partes.push(`carga ${Math.round(m.carga)}%`);
    partes.push(m.seccion_on === false ? "sección cerrada"
      : m.seccion_on === true ? "sección abierta"
      : "sección sin dato");
    if (m.uid) partes.push(m.uid);

    const desvio = desvioRelativo(m.obj, m.real);
    const chip = !fresco ? ""
      : e.clave === "desviado" ? `<span class="pill warn">${esc(formatearDesvio(desvio))}</span>`
      : e.clave === "cortado"  ? `<span class="pill err">sin dosificar</span>`
      : e.clave === "ok"       ? `<span class="pill ok">en objetivo</span>`
      : `<span class="pill">${esc(e.texto)}</span>`;

    return `<li class="fila" style="${SANGRIA}">
      <span class="dot ${fresco ? e.tono : ""}"></span>
      <span class="txt">
        <b>Motor ${m.id === null ? "" : esc(m.id)}</b>
        <span>${esc(partes.join(" · "))}</span>
      </span>
      <span class="val">${chip}</span>
    </li>`;
  }).join("");

  return cabecera + filas;
}

function filaNodo(n, catalogo, equipoOnline) {
  const ultima = buscarUltima(catalogo, n.tipo);
  // UID entero: dos QuantiX del mismo equipo pueden compartir los últimos 6
  // (QX-C45857858428 / QX-F8E956858428) y no habría cómo distinguirlos.
  const uid = String(n.uid || "");
  // Si el equipo no está reportando, lo que sabemos de sus nodos es viejo:
  // no se pinta verde ni se afirma "sin conexión", que sería inventar.
  const estado = equipoOnline ? (n.online ? "ok" : "") : "";
  const detalle = equipoOnline
    ? (n.online ? "" : " · sin conexión")
    : "";
  return `<li class="fila" style="padding-left:34px;background:rgba(255,255,255,0.02)">
    <span class="dot ${estado}"></span>
    <span class="txt">
      <b>${esc(n.tipo || "nodo")}</b>
      <span>${uid ? esc(uid) + " · " : ""}${n.fw ? "fw " + esc(n.fw) : "sin firmware"}${detalle}${n.safe_mode ? " · modo seguro" : ""}</span>
    </span>
    <span class="val">${chipVersion(n.fw, ultima)}</span>
  </li>`;
}

// hls.js es lo que usa el panel web (misma versión) y es lo único que hace
// andar HLS en Android: Chrome no lo reproduce nativo. Se baja recién cuando
// el usuario abre una cámara — no queremos 400 kB en cada visita a Equipos —
// y una sola vez por sesión. En iPhone ni se usa: Safari reproduce HLS solo.
const URL_HLS_JS = "https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js";
let bajandoHls = null;
function cargarHls() {
  if (globalThis.Hls) return Promise.resolve(globalThis.Hls);
  if (bajandoHls) return bajandoHls;
  bajandoHls = new Promise((listo, falla) => {
    const s = document.createElement("script");
    s.src = URL_HLS_JS;
    s.onload = () => listo(globalThis.Hls);
    s.onerror = () => { bajandoHls = null; falla(new Error("no se pudo bajar el reproductor")); };
    document.head.appendChild(s);
  });
  return bajandoHls;
}

// Acceso a cámaras dentro del detalle del equipo. Sin cámaras registradas no
// hay botón: hoy ningún equipo registró ninguna, así que lo que se ve es la
// explicación de qué falta hacer en el tractor, no un error ni un vacío mudo.
function filaCamaras(d) {
  const n = contarCamaras(d);
  const fondo = `padding-left:34px;background:rgba(255,255,255,0.02)`;
  if (!n) {
    return `<li class="fila" style="${fondo}">
      <span class="dot"></span>
      <span class="txt">
        <b>Cámaras</b>
        <span>sin cámaras registradas — las publica PilotX al prender el módulo Cámaras con “Streaming remoto”</span>
      </span>
    </li>`;
  }
  return `<li><button class="fila" style="${fondo}" data-cam-eq="${esc(d.device_id)}" data-cam-titulo="${esc(d.hostname || d.device_id)}">
    <span class="dot info"></span>
    <span class="txt">
      <b>Cámaras</b>
      <span>${n} cámara${n === 1 ? "" : "s"} registrada${n === 1 ? "" : "s"} · tocá para ver</span>
    </span>
    <span class="val">›</span>
  </button></li>`;
}

function filaEquipo(d, catalogo, abierto, qx) {
  const nodos = Array.isArray(d.nodos) ? d.nodos : [];
  const ultimaPilotX = buscarUltima(catalogo, "PilotX");
  const desactualizados = nodos.filter(n => hayActualizacion(n.fw, buscarUltima(catalogo, n.tipo))).length;
  const equipoViejo = hayActualizacion(d.version, ultimaPilotX);

  const resumenNodos = nodos.length
    ? `${nodos.length} nodo${nodos.length === 1 ? "" : "s"}${d.online ? "" : " (último reporte)"}${desactualizados ? ` · ${desactualizados} con update` : ""}`
    : "sin nodos reportados";

  return `<li>
    <button class="fila" data-eq="${esc(d.device_id)}" aria-expanded="${abierto ? "true" : "false"}">
      <span class="dot ${d.online ? "ok" : (d.ultimo_visto ? "warn" : "")}"></span>
      <span class="txt">
        <b>${esc(d.hostname || d.device_id)}</b>
        <span>${d.version ? "PilotX " + esc(d.version) + " · " : ""}${d.ultimo_visto ? "visto " + haceCuanto(d.ultimo_visto) : "nunca reportó"}</span>
        <span style="color:var(--ap-muted-2)">${abierto ? "▾ " : "▸ "}${esc(resumenNodos)}</span>
      </span>
      <span class="val">${equipoViejo ? chipVersion(d.version, ultimaPilotX) : (d.online ? "en línea" : "—")}</span>
    </button>
    ${abierto ? `<ul class="lista">${nodos.map(n => filaNodo(n, catalogo, d.online)).join("")}${filasQuantiX(d, qx)}${filaCamaras(d)}</ul>` : ""}
  </li>`;
}

export async function montar(ctx, root) {
  root.classList.add("scroll");

  // Qué equipos tienen la lista de nodos desplegada. Se guarda acá y no en el
  // DOM porque cargar() vuelve a dibujar todo cada 60 s: sin esto, la lista se
  // cerraba sola mientras la estabas mirando.
  const abiertos = new Set();

  // El catálogo cambia cuando se sube un firmware, no cada minuto: se pide
  // aparte y se reusa. Si falla (403, sin red), la pantalla igual muestra las
  // versiones instaladas, solo que sin avisar de actualizaciones.
  let catalogo = {};
  async function cargarCatalogo() {
    try {
      const r = await ctx.api.get("/api/ota/firmwares");
      const mapa = {};
      for (const f of r.data || []) {
        const k = claveProducto(f.producto);
        if (!k) continue;
        if (!mapa[k] || comparar(f.version, mapa[k]) > 0) mapa[k] = f.version;
      }
      catalogo = mapa;
    } catch {
      catalogo = {};
    }
  }

  // ── Dosificación de QuantiX ──────────────────────────────
  // Estado compartido del último GET /api/tracking/live. Una sola respuesta
  // trae el `qx` de TODOS los equipos del establecimiento, así que da igual
  // cuántas filas estén desplegadas: el pedido es uno solo. Ese endpoint
  // resuelve el establecimiento con la sesión (no lleva ?estab=, igual que en
  // el Mapa) y acá cada fila busca su propio device_id: un equipo que no esté
  // en la respuesta simplemente muestra el estado vacío, nunca el dato de otro.
  //
  // Cuándo se pide: al desplegar un equipo, igual que las cámaras. El refresco
  // de 60 s lo vuelve a pedir SOLO mientras haya alguna fila abierta — con todo
  // cerrado, Equipos cuesta exactamente lo que costaba antes (un /api/devices
  // por minuto). Refrescar dosificación que nadie está mirando no vale una
  // llamada por minuto por cada celular con la PWA abierta.
  const qx = { fase: "inicial", mensaje: "", lista: [], desdeCache: false, ts: 0 };
  // Desplegar dos equipos seguidos no pide dos veces lo mismo.
  const QX_FRESCO_MS = 30000;
  let pidiendoQx = false;
  let vivo = true;

  // Último /api/devices dibujado y si lo que hay en pantalla es la lista (y no
  // el cartel de error): sin esto, una respuesta de dosificación que llega
  // tarde le pisaría el error al usuario con una lista vieja.
  let equipos = [];
  let hayLista = false;

  function pintar() {
    const on = equipos.filter(d => d.online).length;

    // Cuántos tienen algo para actualizar — el equipo o alguno de sus nodos.
    const conUpdate = equipos.filter(d =>
      hayActualizacion(d.version, buscarUltima(catalogo, "PilotX")) ||
      (Array.isArray(d.nodos) && d.nodos.some(n => hayActualizacion(n.fw, buscarUltima(catalogo, n.tipo))))
    ).length;

    root.innerHTML = `
      <div class="titulo-seccion">${on} en línea · ${equipos.length - on} sin reportar${conUpdate ? ` · ${conUpdate} con actualización` : ""}</div>
      <ul class="lista">${equipos.map(d => filaEquipo(d, catalogo, abiertos.has(d.device_id), qx)).join("")}</ul>
      ${equipos.length ? "" : `<div class="vacio">No hay equipos asignados a este establecimiento.</div>`}`;
    hayLista = true;
  }

  async function refrescarQx() {
    if (pidiendoQx || !vivo) return;
    if (qx.fase === "listo" && Date.now() - qx.ts < QX_FRESCO_MS) return;
    pidiendoQx = true;
    if (qx.fase === "inicial") { qx.fase = "cargando"; if (hayLista) pintar(); }
    try {
      const r = await ctx.api.get("/api/tracking/live");
      qx.lista = Array.isArray(r.data) ? r.data : [];
      qx.desdeCache = !!r.desdeCache;
      qx.fase = "listo";
      qx.mensaje = "";
    } catch (e) {
      qx.fase = "error";
      qx.mensaje = e.message || "no respondió el servidor";
    } finally {
      qx.ts = Date.now();
      pidiendoQx = false;
    }
    // La respuesta puede llegar cuando el usuario ya se fue de la pantalla, o
    // después de que /api/devices falló y root muestra el error: ahí no se toca
    // nada. La antigüedad del dato NO se mide con este reloj sino con el `ts`
    // de cada punto (ver filasQuantiX): una respuesta de cache puede tener horas.
    if (vivo && hayLista) pintar();
  }

  async function cargar() {
    let r;
    // Siempre con ?estab=: para un superadmin, /api/devices sin filtro devuelve
    // los equipos de TODAS las orgs (comportamiento del panel).
    const org = ctx.usuario?.org_activa;
    const url = org ? `/api/devices?estab=${encodeURIComponent(org)}` : "/api/devices";
    try { r = await ctx.api.get(url); } catch (e) { hayLista = false; root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return; }
    ctx.nav.setOffline(r.desdeCache, r.ts);

    equipos = [...r.data].sort((a, b) => (b.online - a.online) || ((b.ultimo_visto || 0) - (a.ultimo_visto || 0)));
    pintar();
    // Solo con algún equipo desplegado: ver el comentario de `qx` arriba.
    if (abiertos.size) refrescarQx();
  }

  // ── Panel de cámaras ─────────────────────────────────────
  // Cuelga de <body>, no de `root`: cargar() reescribe root.innerHTML cada
  // 60 s y se llevaría puesto el <video> en medio de la transmisión.
  let capaCam = null;   // el panel abierto, o null
  let player  = null;   // { hls, video } del stream corriendo

  // Cortar de verdad: destruir hls.js no alcanza, el <video> con src sigue
  // bajando segmentos y se come los datos y la batería del celular.
  function pararVideo() {
    if (!player) return;
    try { player.hls?.destroy(); } catch {}
    try {
      player.video.pause();
      player.video.removeAttribute("src");
      player.video.load();
    } catch {}
    player = null;
  }

  function cerrarCamaras() {
    pararVideo();
    capaCam?.remove();
    capaCam = null;
  }

  function htmlListaCamaras(info) {
    if (!info.camaras.length) {
      return `<div class="vacio">Este equipo todavía no registró cámaras.
        <br><small>Las registra PilotX solo: en el tractor, módulo Cámaras › “Streaming remoto”. Recién ahí aparecen acá.</small></div>`;
    }
    const aviso = info.online ? "" : `<div class="card"><p>El equipo no está reportando. Podés abrir una cámara igual, pero si PilotX está apagado no va a llegar imagen.</p></div>`;
    return aviso + `<ul class="lista">${info.camaras.map(c => c.disponible
      ? `<li><button class="fila" data-cam-idx="${c.idx}" data-cam-nombre="${esc(c.nombre)}">
          <span class="dot ${c.online ? "ok" : ""}"></span>
          <span class="txt"><b>${esc(c.nombre)}</b><span>${c.online ? "transmitiendo" : "sin transmisión ahora"}</span></span>
          <span class="val">Ver ›</span>
        </button></li>`
      : `<li class="fila">
          <span class="dot"></span>
          <span class="txt"><b>${esc(c.nombre)}</b><span>${esc(c.motivo)}</span></span>
          <span class="val"><span class="pill">no disponible</span></span>
        </li>`).join("")}</ul>`;
  }

  async function verCamara(deviceId, camIdx, nombre) {
    const capa = capaCam;
    if (!capa) return;
    pararVideo();
    const caja = capa.querySelector("[data-video]");
    caja.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
      <div style="background:#000;aspect-ratio:16/9">
        <video data-v muted playsinline controls style="width:100%;height:100%;object-fit:contain"></video>
      </div>
      <p data-estado style="padding:8px 12px">Conectando con ${esc(nombre)}…</p>
    </div>`;
    const video = caja.querySelector("[data-v]");
    const estado = caja.querySelector("[data-estado]");
    // Solo hablamos si el panel sigue siendo el mismo: si lo cerraron mientras
    // esperábamos al server, escribir acá sería tocar un DOM ya tirado.
    const decir = (t) => { if (capaCam === capa) estado.textContent = t; };

    let url;
    try {
      const r = await ctx.api.get(`/api/camaras/playback/${encodeURIComponent(deviceId)}/${camIdx}`);
      url = urlVideo(r.data);
      if (!url) throw new Error(r.desdeCache
        ? "el permiso de video guardado venció y no hay conexión para pedir otro"
        : "el servidor no devolvió dirección de video");
    } catch (e) {
      decir(`No se pudo abrir ${nombre}: ${e.message}`);
      return;
    }
    if (capaCam !== capa) return;

    let Hls = null;
    try { Hls = await cargarHls(); } catch { /* sin hls.js probamos el reproductor del sistema */ }
    if (capaCam !== capa) return;

    if (Hls && Hls.isSupported()) {
      const hls = new Hls({
        lowLatencyMode: true,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 4,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 4,
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { decir(`${nombre} · en vivo`); video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        decir(textoErrorHls(data.details));
        pararVideo();   // liberar: el error fatal deja el player inservible
      });
      player = { hls, video };
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // iPhone: Safari reproduce HLS nativo y no hace falta bajar hls.js.
      video.src = url;
      video.addEventListener("loadedmetadata", () => { decir(`${nombre} · en vivo`); video.play().catch(() => {}); });
      video.addEventListener("error", () => decir(textoErrorHls("manifestLoadError")));
      player = { hls: null, video };
    } else {
      decir("Este teléfono no puede reproducir el video: hace falta el reproductor hls.js y no se pudo bajar (¿sin conexión?).");
    }
  }

  async function abrirCamaras(deviceId, titulo) {
    cerrarCamaras();
    const capa = document.createElement("div");
    capa.className = "selector-capa";
    capa.innerHTML = `
      <div class="sheet selector" role="dialog" aria-label="Cámaras del equipo">
        <div class="handle"></div>
        <div class="titulo-seccion">Cámaras · ${esc(titulo)}</div>
        <div class="cuerpo">
          <div data-video></div>
          <div data-lista><div class="vacio">Buscando las cámaras del equipo…</div></div>
        </div>
        <div class="campo"><button class="btn secundario" data-cerrar style="width:100%">Cerrar</button></div>
      </div>`;
    capa.addEventListener("click", (ev) => {
      if (ev.target === capa || ev.target.closest("[data-cerrar]")) { cerrarCamaras(); return; }
      const b = ev.target.closest("[data-cam-idx]");
      if (b) verCamara(deviceId, Number(b.getAttribute("data-cam-idx")), b.getAttribute("data-cam-nombre") || "la cámara");
    });
    document.body.appendChild(capa);
    capaCam = capa;

    const lista = capa.querySelector("[data-lista]");
    let info;
    try {
      const r = await ctx.api.get(`/api/camaras/list/${encodeURIComponent(deviceId)}`);
      info = normalizarCamaras(r.data);
    } catch (e) {
      if (capaCam !== capa) return;
      lista.innerHTML = `<div class="vacio">No se pudo pedir la lista de cámaras.<br><small>${esc(e.message)}</small></div>`;
      return;
    }
    if (capaCam !== capa) return;   // lo cerraron mientras cargaba
    lista.innerHTML = htmlListaCamaras(info);
  }

  // Delegación: las filas se redibujan enteras, así que el listener vive en la
  // raíz de la pantalla y no en cada botón.
  function alTocar(ev) {
    // Las cámaras primero: su botón vive dentro del detalle del equipo, pero
    // no adentro del botón del equipo, así que no se pisan.
    const cam = ev.target.closest("[data-cam-eq]");
    if (cam) { abrirCamaras(cam.getAttribute("data-cam-eq"), cam.getAttribute("data-cam-titulo") || ""); return; }
    const btn = ev.target.closest("[data-eq]");
    if (!btn) return;
    const id = btn.getAttribute("data-eq");
    if (abiertos.has(id)) abiertos.delete(id); else abiertos.add(id);
    cargar();
  }
  root.addEventListener("click", alTocar);

  await cargarCatalogo();
  await cargar();
  const timer = setInterval(cargar, 60000);
  const timerCat = setInterval(cargarCatalogo, 15 * 60000);
  return {
    desmontar() {
      clearInterval(timer);
      clearInterval(timerCat);
      root.removeEventListener("click", alTocar);
      // El panel de cámaras vive en <body>: si no lo sacamos acá, queda tapando
      // la pantalla siguiente y con el stream corriendo.
      cerrarCamaras();
      // Un /api/tracking/live en vuelo no tiene que escribir en una pantalla
      // muerta, y la telemetría guardada no sobrevive a la salida: al volver a
      // Equipos se pide de nuevo antes que mostrar dosificación de hace rato.
      vivo = false;
      qx.fase = "inicial"; qx.lista = []; qx.mensaje = ""; qx.desdeCache = false; qx.ts = 0;
      equipos = []; hayLista = false;
    },
  };
}
