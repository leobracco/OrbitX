// siembra.js — Lo que el dueño del campo quiere saber del celular: si la
// sembradora está sembrando bien. Los datos los pone VistaX y los sube PilotX.
//
// Fuentes (routes/vistax.js):
//   GET /api/vistax/lotes      → lista de metas de siembra. Devuelve un ARRAY
//        pelado si no se le manda paginación, y {items,total,limit,skip} si sí.
//        Cada item: {lote_id, nombre, cultivo, startTs, endTs, totalSemillas,
//        duracionMin, device_id, ts_sync, tiene_densidad, tiene_semillas}.
//   GET /api/vistax/lote/:id   → {lote_id, meta, densidad, semillas, alertas}.
//        `meta` es el JSON del lote tal cual lo escribió PilotX; `densidad` y
//        `semillas` son solo banderas {disponible, ts, tamano, device_id}
//        (los GeoJSON pesados viven en /geojson/:id y /semillas/:id, que esta
//        pantalla NO pide: son megas y esto se abre con datos móviles).
//        404 si el lote no tiene ningún archivo sincronizado.
//   GET /api/vistax/perfil     → perfil del implemento: config.setup trae
//        `densidad_objetivo` (sem/m) y `tolerancia_desvio` (%). 404 si no hay
//        ninguna sembradora sincronizada todavía.
//   GET /api/vistax/alertas    → array plano con lo que haya en los docs
//        vistax_alertas, ordenado por ts descendente.
//
// El estado normal HOY es "no hay nada": ninguna sembradora sincronizó. Por eso
// la pantalla está escrita alrededor del vacío — explica qué falta, no tira un
// error ni deja un spinner girando.
import { esc } from "../ui/html.js";
import { haceCuanto, fechaCorta } from "../core/fecha.js";

// Tolerancia de fábrica del implemento VistaX (ImplementoSetup.ToleranciaDesvio)
// para cuando el perfil sincronizado no la trae.
export const TOLERANCIA_DEFECTO = 20;

// ── Lectura defensiva de los datos ──────────────────────────
// Todo lo de acá abajo llega de CouchDB, donde el contenido lo escribió PilotX
// como texto libre: puede faltar el campo, venir como string, o venir con coma
// decimal. Un dato que no se entiende vale null y no se muestra — inventar un
// número de siembra es peor que dejar el renglón vacío.

export function aNumero(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Primer nombre de campo que exista y sea numérico. Los nombres cambiaron entre
// el VistaX viejo (Node) y el embebido en PilotX, y la base tiene lotes de los
// dos: se aceptan los dos en vez de romper con los archivos que ya están.
export function campoNumero(obj, nombres) {
  if (!obj || typeof obj !== "object") return null;
  for (const n of nombres) {
    if (obj[n] === undefined || obj[n] === null) continue;
    const v = aNumero(obj[n]);
    if (v !== null) return v;
  }
  return null;
}

// /api/vistax/lotes contesta array o {items}: normalizamos a array siempre.
export function normalizarLotes(data) {
  const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return arr.filter((l) => l && typeof l === "object");
}

// Del más nuevo al más viejo. Un lote sin startTs (meta a medio escribir) se va
// al fondo en vez de quedar arriba como si fuera el último trabajo.
export function ordenarLotes(lotes) {
  return [...lotes].sort((a, b) => (cuando(b) ?? -1) - (cuando(a) ?? -1));
}

export function cuando(lote) {
  return campoNumero(lote, ["startTs", "start_ts", "ts_sync", "ts"]);
}

// Objetivo de siembra del perfil del implemento. null = no hay perfil
// sincronizado o no tiene densidad cargada: entonces no se compara nada.
export function objetivoSiembra(perfil) {
  const setup = perfil?.config?.setup || perfil?.setup || null;
  const densidad = campoNumero(setup, ["densidad_objetivo", "densidadObjetivo"]);
  if (densidad === null || densidad <= 0) return null;
  let tolerancia = campoNumero(setup, ["tolerancia_desvio", "toleranciaDesvio"]);
  if (tolerancia === null || tolerancia <= 0) tolerancia = TOLERANCIA_DEFECTO;
  return { densidad, tolerancia };
}

// Densidad realmente lograda en el lote, si la meta la trae.
export function densidadDeLote(lote) {
  return campoNumero(lote, [
    "densidad", "densidad_promedio", "densidadPromedio",
    "spmPromedio", "spm_promedio", "sem_metro",
  ]);
}

export function fallasDeLote(lote) {
  return campoNumero(lote, ["fallas", "fallas_total", "fallasTotal"]);
}

export function doblesDeLote(lote) {
  return campoNumero(lote, ["dobles", "dobles_total", "doblesTotal"]);
}

// Veredicto de la densidad contra el objetivo del perfil.
// "sin_dato" cuando falta cualquiera de los dos: no se afirma que esté bien.
export function estadoDensidad(real, objetivo) {
  if (real === null || real === undefined || !objetivo || !(objetivo.densidad > 0))
    return { estado: "sin_dato", desvio: null };
  const desvio = ((real - objetivo.densidad) / objetivo.densidad) * 100;
  const tol = objetivo.tolerancia > 0 ? objetivo.tolerancia : TOLERANCIA_DEFECTO;
  if (Math.abs(desvio) <= tol) return { estado: "ok", desvio };
  return { estado: desvio < 0 ? "baja" : "alta", desvio };
}

// Alertas de siembra que siguen abiertas. El doc vistax_alertas lo escribe
// PilotX y todavía no tiene forma fija: se acepta `resuelta` o `resuelto`, y
// lo que no diga nada se cuenta como activa (una alerta de menos es peor que
// una de más cuando la sembradora está trabajando).
export function alertasActivas(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.filter((a) => a && typeof a === "object" && !a.resuelta && !a.resuelto);
}

export function textoAlerta(a) {
  return a?.mensaje || a?.texto || a?.msg || a?.titulo || "Alerta de siembra";
}

// Resumen de arriba de todo: qué fue lo último que se sembró y cómo viene.
export function resumenSiembra({ lotes, alertas, objetivo } = {}) {
  const orden = ordenarLotes(normalizarLotes(lotes));
  const activas = alertasActivas(alertas);
  const ultimo = orden[0] || null;
  const fuera = orden.filter((l) => {
    const e = estadoDensidad(densidadDeLote(l), objetivo).estado;
    return e === "baja" || e === "alta";
  }).length;
  return {
    hay: orden.length > 0,
    total: orden.length,
    lotes: orden,
    ultimo,
    ultimoTs: ultimo ? cuando(ultimo) : null,
    alertas: activas,
    fueraDeRango: fuera,
  };
}

// Por qué no hay nada en pantalla, en castellano. Un "HTTP 403" pelado no le
// dice nada al dueño del campo.
export function motivoVacio(error) {
  const status = error?.status;
  if (status === 401) return "Tu sesión venció. Entrá de nuevo para ver la siembra.";
  if (status === 403) return "Tu usuario no tiene permiso para ver la siembra de este establecimiento.";
  if (status === 404) return "Todavía no hay datos de siembra en este establecimiento.";
  if (status >= 500) return "El servidor no pudo leer los datos de siembra. Probá de nuevo en un rato.";
  if (error?.name === "ErrorSinDatos") return "Sin conexión y sin datos de siembra guardados en este teléfono.";
  return error?.message || "No se pudieron leer los datos de siembra.";
}

// ── Textos de la UI ─────────────────────────────────────────

const VACIO_SIN_DATOS =
  "Todavía no hay datos de siembra. Aparecen acá cuando una sembradora con VistaX trabaje y PilotX sincronice.";

function numero(n, dec = 0) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString("es-AR", {
    minimumFractionDigits: dec, maximumFractionDigits: dec,
  });
}

function chipDensidad(real, objetivo) {
  const { estado, desvio } = estadoDensidad(real, objetivo);
  if (estado === "sin_dato") return "";
  const signo = desvio > 0 ? "+" : "";
  if (estado === "ok") return `<span class="pill ok">${numero(real, 1)} sem/m</span>`;
  return `<span class="pill warn">${numero(real, 1)} sem/m · ${signo}${numero(desvio, 0)} %</span>`;
}

function subtituloLote(l, objetivo) {
  const partes = [];
  if (l.cultivo && l.cultivo !== "–") partes.push(esc(l.cultivo));
  const ts = cuando(l);
  if (ts !== null) partes.push(esc(fechaCorta(ts)));
  const semillas = campoNumero(l, ["totalSemillas", "total_semillas"]);
  if (semillas) partes.push(numero(semillas) + " semillas");
  const dur = campoNumero(l, ["duracionMin", "duracion_min"]);
  if (dur) partes.push(numero(dur) + " min");
  const fallas = fallasDeLote(l);
  if (fallas) partes.push(numero(fallas) + " fallas");
  const dobles = doblesDeLote(l);
  if (dobles) partes.push(numero(dobles) + " dobles");
  const d = densidadDeLote(l);
  if (d !== null && !objetivo) partes.push(numero(d, 1) + " sem/m");
  return partes.join(" · ") || "sin detalle sincronizado";
}

function filaLote(l, objetivo) {
  const id = l.lote_id || "";
  const est = estadoDensidad(densidadDeLote(l), objetivo).estado;
  const dot = est === "ok" ? "ok" : est === "sin_dato" ? (l.tiene_densidad ? "info" : "") : "warn";
  const nombre = l.nombre || id || "Lote sin nombre";
  const interior = `
      <span class="dot ${dot}"></span>
      <span class="txt"><b>${esc(nombre)}</b><span>${subtituloLote(l, objetivo)}</span></span>
      <span class="val">${chipDensidad(densidadDeLote(l), objetivo) || (id ? "▸" : "")}</span>`;
  // Sin lote_id no hay detalle que abrir: queda como renglón, no como link roto.
  return id
    ? `<li><a class="fila" href="#/siembra/${encodeURIComponent(id)}" style="text-decoration:none">${interior}</a></li>`
    : `<li class="fila">${interior}</li>`;
}

function filaAlerta(a) {
  const ts = aNumero(a.ts);
  return `<li class="fila"><span class="dot err"></span>
    <span class="txt"><b>${esc(textoAlerta(a))}</b><span>${esc(a.lote || a.lote_id || "")}${a.surco ? " · surco " + esc(a.surco) : ""}</span></span>
    <span class="val">${ts === null ? "" : esc(haceCuanto(ts))}</span></li>`;
}

function tarjetaResumen(res, objetivo) {
  const u = res.ultimo;
  const cuandoTxt = res.ultimoTs === null ? "sin fecha" : haceCuanto(res.ultimoTs);
  const objetivoTxt = objetivo
    ? `Objetivo del implemento: <b>${numero(objetivo.densidad, 1)} sem/m</b> ± ${numero(objetivo.tolerancia)} %`
    : "Sin perfil de sembradora sincronizado: no se puede comparar contra un objetivo.";
  const aviso = res.alertas.length
    ? `<p><b style="color:var(--ap-red)">${res.alertas.length} alerta${res.alertas.length === 1 ? "" : "s"} de siembra sin resolver.</b></p>`
    : res.fueraDeRango
      ? `<p><b style="color:var(--ap-yellow)">${res.fueraDeRango} lote${res.fueraDeRango === 1 ? "" : "s"} fuera del objetivo de siembra.</b></p>`
      : `<p>Sin alertas de siembra.</p>`;
  return `<div class="card">
    <h3>Último trabajo de siembra</h3>
    <p><b>${esc(u?.nombre || u?.lote_id || "—")}</b> · ${esc(cuandoTxt)}${u?.cultivo && u.cultivo !== "–" ? " · " + esc(u.cultivo) : ""}</p>
    <p>${objetivoTxt}</p>
    ${aviso}
  </div>`;
}

// ── Pantalla ────────────────────────────────────────────────

export async function montar(ctx, root, loteId) {
  root.classList.add("scroll");

  const org = ctx.usuario?.org_activa;
  // El server ya filtra por la org del token (req.user.estabSlug): `estab` va en
  // la URL solo para que el cache offline de api.js —cuya clave es "GET <ruta>"—
  // no le muestre los lotes de un establecimiento al que cambió a otro.
  const conOrg = (ruta) => (org ? `${ruta}${ruta.includes("?") ? "&" : "?"}estab=${encodeURIComponent(org)}` : ruta);

  if (!org) {
    root.innerHTML = `<div class="vacio">Elegí un establecimiento arriba para ver la siembra.</div>`;
    return { desmontar() {} };
  }

  if (loteId) {
    await detalle(ctx, root, loteId, conOrg);
    return { desmontar() {} };
  }

  async function cargar() {
    let r;
    try {
      r = await ctx.api.get(conOrg("/api/vistax/lotes"));
    } catch (e) {
      root.innerHTML = `<div class="vacio">${esc(motivoVacio(e))}</div>`;
      ctx.nav.setOffline(true, null);
      return;
    }
    ctx.nav.setOffline(r.desdeCache, r.ts);

    // Perfil y alertas son accesorios: si fallan (404 porque nunca sincronizó
    // una sembradora, o sin red), la lista de lotes se muestra igual.
    const [perfil, alertas] = await Promise.all([
      ctx.api.get(conOrg("/api/vistax/perfil")).then((x) => x.data).catch(() => null),
      ctx.api.get(conOrg("/api/vistax/alertas")).then((x) => x.data).catch(() => []),
    ]);
    const objetivo = objetivoSiembra(perfil);
    const res = resumenSiembra({ lotes: r.data, alertas, objetivo });

    if (!res.hay) {
      root.innerHTML = `<div class="vacio">${esc(VACIO_SIN_DATOS)}</div>`;
      return;
    }

    root.innerHTML = `
      ${tarjetaResumen(res, objetivo)}
      ${res.alertas.length ? `<div class="titulo-seccion">Alertas de siembra · ${res.alertas.length}</div>
        <ul class="lista">${res.alertas.slice(0, 20).map(filaAlerta).join("")}</ul>` : ""}
      <div class="titulo-seccion">Lotes sembrados · ${res.total}</div>
      <ul class="lista">${res.lotes.map((l) => filaLote(l, objetivo)).join("")}</ul>`;
  }

  await cargar();
  const timer = setInterval(cargar, 60000);
  const alVolver = () => cargar();
  window.addEventListener("online", alVolver);
  return {
    desmontar() {
      clearInterval(timer);
      window.removeEventListener("online", alVolver);
    },
  };
}

async function detalle(ctx, root, loteId, conOrg) {
  const volver = `<a href="#/siembra" style="color:var(--ap-muted);font-size:13px;text-decoration:none">‹ Siembra</a>`;
  let r;
  try {
    r = await ctx.api.get(conOrg(`/api/vistax/lote/${encodeURIComponent(loteId)}`));
  } catch (e) {
    const texto = e?.status === 404
      ? "Este lote no tiene datos de siembra sincronizados."
      : motivoVacio(e);
    root.innerHTML = `<div class="card">${volver}<h3>${esc(loteId)}</h3></div>
      <div class="vacio">${esc(texto)}</div>`;
    return;
  }
  ctx.nav.setOffline(r.desdeCache, r.ts);

  const d = r.data || {};
  const meta = d.meta && typeof d.meta === "object" ? d.meta : {};
  const objetivo = objetivoSiembra(
    await ctx.api.get(conOrg("/api/vistax/perfil")).then((x) => x.data).catch(() => null),
  );
  const real = densidadDeLote(meta);
  const { estado, desvio } = estadoDensidad(real, objetivo);

  const ini = campoNumero(meta, ["startTs", "start_ts"]);
  const fin = campoNumero(meta, ["endTs", "end_ts"]);
  const semillas = campoNumero(meta, ["totalSemillas", "total_semillas"]);
  const dur = campoNumero(meta, ["duracionMin", "duracion_min"]);
  const fallas = fallasDeLote(meta);
  const dobles = doblesDeLote(meta);

  // Un renglón por dato que EXISTE. Los que faltan no se dibujan: una lista con
  // ocho "—" hace creer que el trabajo salió mal, cuando en realidad ese dato
  // nunca se sincronizó.
  const renglones = [];
  const renglon = (etiqueta, html) => {
    if (html) renglones.push(`<li class="fila"><span class="dot"></span><span class="txt"><b>${esc(etiqueta)}</b></span><span class="val">${html}</span></li>`);
  };
  const dato = (etiqueta, texto) => renglon(etiqueta, texto === null || texto === undefined ? "" : esc(texto));

  const densidadPill = estado === "sin_dato"
    ? (real === null ? "" : `<span class="pill">${numero(real, 1)} sem/m</span>`)
    : chipDensidad(real, objetivo);
  renglon("Densidad lograda", densidadPill);
  if (objetivo) dato("Objetivo", `${numero(objetivo.densidad, 1)} sem/m ± ${numero(objetivo.tolerancia)} %`);
  if (semillas !== null) dato("Semillas", numero(semillas));
  if (dur !== null) dato("Duración", numero(dur) + " min");
  if (fallas !== null) dato("Fallas", numero(fallas));
  if (dobles !== null) dato("Dobles", numero(dobles));
  if (ini !== null) dato("Arranque", fechaCorta(ini));
  if (fin !== null) dato("Fin", fechaCorta(fin));
  if (d.densidad?.disponible) dato("Mapa de densidad", "sincronizado");
  if (d.semillas?.disponible) dato("Semillas georreferenciadas", "sincronizado");

  const alertasLote = alertasActivas(Array.isArray(d.alertas) ? d.alertas : d.alertas ? [d.alertas] : []);

  root.innerHTML = `
    <div class="card">${volver}
      <h3>${esc(meta.nombre || d.lote_id || loteId)}</h3>
      <p>${esc(meta.cultivo && meta.cultivo !== "–" ? meta.cultivo : "sin cultivo")}${ini === null ? "" : " · " + esc(fechaCorta(ini))}</p>
      ${estado === "baja" || estado === "alta"
        ? `<p><b style="color:var(--ap-yellow)">La densidad se fue ${numero(Math.abs(desvio), 0)} % ${estado === "baja" ? "por debajo" : "por encima"} del objetivo.</b></p>`
        : estado === "ok" ? `<p>Densidad dentro del objetivo.</p>` : ""}
    </div>
    ${renglones.length ? `<div class="titulo-seccion">Datos del trabajo</div>
    <ul class="lista">${renglones.join("")}</ul>` : ""}
    ${alertasLote.length ? `<div class="titulo-seccion">Alertas de este lote · ${alertasLote.length}</div>
      <ul class="lista">${alertasLote.slice(0, 20).map(filaAlerta).join("")}</ul>` : ""}
    ${real === null && !d.densidad?.disponible
      ? `<div class="vacio">De este lote llegó la ficha del trabajo, pero no el detalle de densidad. Lo sube PilotX al cerrar el lote.</div>`
      : ""}`;
}
