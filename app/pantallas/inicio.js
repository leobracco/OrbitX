// inicio.js — Pestaña de inicio: resumen de la actividad de la temporada
// (hectáreas, equipos, lluvia y últimos movimientos). La ven todos los roles.
// Fuente: GET /api/actividad/resumen (Tarea 3) — un superadmin sin
// establecimiento elegido recibe 400 "Sin establecimiento".
import { esc } from "../ui/html.js";
import { haceCuanto } from "../core/fecha.js";
import { ErrorHttp } from "../core/api.js";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DOT_POR_TIPO = { lote: "ok", lluvia: "info", alerta: "err", equipo: "warn" };
const REFRESCO_MS = 5 * 60 * 1000;

// La campaña se refresca cada 30 min (6 ciclos del Inicio) y NO en cada
// refresco de 5 min. Por qué: /api/reportes/temporada reparsea las coberturas
// de PilotX de toda la temporada (el server lo cachea 5 min justamente porque
// es caro) y los acumulados de campaña se mueven unas pocas veces por día —
// pedirlo cada 5 minutos gastaría datos del celular y CPU del server sin que
// el número cambie. Si el dueño quiere el dato al toque, vuelve a entrar a la
// pestaña y se remonta la pantalla.
const REFRESCO_CAMPANA_MS = 30 * 60 * 1000;

function mesCorto(fechaISO) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(fechaISO || ""));
  return m ? `${MESES[Number(m[2]) - 1]} ${m[1]}` : "—";
}

function diaMesCorto(fechaISO) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(fechaISO || ""));
  return m ? `${m[2]}/${m[1]}` : "—";
}

// ── Formato de números para un productor argentino ────────────────────────
// Miles con punto y decimales con coma ("1.234,5"). Se escribe a mano en vez
// de usar toLocaleString porque el resultado tiene que ser idéntico en el
// celular, en el server y en los tests, sin depender del ICU del dispositivo.
// Los ceros de la derecha se recortan: "120,0 ha" se lee peor que "120 ha".
export function formatearNumero(valor, decimales = 1) {
  // Solo número o texto numérico: Number([]) es 0 y Number(true) es 1, y un
  // array vacío de CouchDB no son cero hectáreas.
  if (typeof valor !== "number" && typeof valor !== "string") return "—";
  if (valor.trim && valor.trim() === "") return "—";
  const n = Number(valor);
  if (!Number.isFinite(n)) return "—";
  const d = Math.min(6, Math.max(0, Math.trunc(Number(decimales)) || 0));
  const txt = Math.abs(n).toFixed(d);
  const punto = txt.indexOf(".");
  let entera = punto === -1 ? txt : txt.slice(0, punto);
  const dec = (punto === -1 ? "" : txt.slice(punto + 1)).replace(/0+$/, "");
  entera = entera.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const cuerpo = dec ? `${entera},${dec}` : entera;
  return (n < 0 && Number(txt) !== 0 ? "-" : "") + cuerpo;
}

export function formatearHa(valor) {
  const s = formatearNumero(valor, 1);
  return s === "—" ? "—" : `${s} ha`;
}

export function formatearMm(valor) {
  const s = formatearNumero(valor, 1);
  return s === "—" ? "—" : `${s} mm`;
}

// Devuelve el número si es un número de verdad; si no, null. Los documentos
// vienen de CouchDB y un campo puede llegar en null, vacío o como texto.
function aNumero(valor) {
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  if (valor.trim && valor.trim() === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// armarCampana — pura: toma la respuesta cruda de GET /api/reportes/temporada
// y arma lo que la sección Campaña necesita pintar. No inventa nada: si el
// backend no manda un campo, queda en null y la UI no lo muestra.
export function armarCampana(respuesta) {
  const d = respuesta && typeof respuesta === "object" ? respuesta : {};
  const totales = d.totales && typeof d.totales === "object" ? d.totales : {};
  const crudos = Array.isArray(d.lotes) ? d.lotes : [];

  const lotes = crudos
    .filter((l) => l && typeof l === "object")
    .map((l) => {
      const trabajado = aNumero(l.trabajado_ha);
      const estimadas = aNumero(l.ha_estimadas);
      return {
        nombre: String(l.nombre ?? "").trim() || "Lote sin nombre",
        cultivo: typeof l.cultivo === "string" && l.cultivo.trim() ? l.cultivo.trim() : null,
        trabajado_ha: trabajado,
        lluvia_mm: aNumero(l.lluvia_mm),
        ha_estimadas: estimadas,
        // Avance = trabajado sobre lo planificado en el lote maestro. Es una
        // división entre dos datos del backend, no una proyección.
        avance_pct: trabajado != null && estimadas != null && estimadas > 0
          ? Math.round((trabajado / estimadas) * 100)
          : null,
      };
    });

  const trabajados = lotes
    .filter((l) => (l.trabajado_ha ?? 0) > 0)
    .sort((a, b) => b.trabajado_ha - a.trabajado_ha);

  // Agrupado por cultivo solo si alguien cargó el cultivo en el lote maestro;
  // una única bolsa "sin cultivo cargado" no le sirve a nadie.
  const mapa = new Map();
  for (const l of trabajados) {
    const clave = l.cultivo || "Sin cultivo cargado";
    const acum = mapa.get(clave) || { cultivo: clave, ha: 0, lotes: 0 };
    acum.ha += l.trabajado_ha;
    acum.lotes += 1;
    mapa.set(clave, acum);
  }
  const cultivos = trabajados.some((l) => l.cultivo)
    ? [...mapa.values()].sort((a, b) => b.ha - a.ha)
    : [];

  // El total lo manda el backend; si faltara o viniera roto, se suma acá para
  // no mostrar "—" cuando los lotes sí tienen hectáreas.
  const totalBackend = aNumero(totales.trabajado_ha);
  const totalHa = totalBackend != null
    ? totalBackend
    : trabajados.reduce((s, l) => s + l.trabajado_ha, 0);

  return {
    temporada: typeof d.temporada === "string" && d.temporada ? d.temporada : null,
    total_ha: totalHa,
    lluvia_mm: aNumero(totales.lluvia_mm),
    total_lotes: lotes.length,
    lotes_trabajados: trabajados.length,
    lotes_sin_trabajar: lotes.length - trabajados.length,
    lotes: trabajados,
    cultivos,
    // Sin lotes no hay nada que mostrar: la sección avisa en vez de pintar ceros.
    hay_datos: lotes.length > 0,
  };
}

function tile(numero, rotulo) {
  return `<div class="card">
    <div style="font-size:28px;font-weight:700;color:var(--ap-green)">${esc(numero)}</div>
    <p>${esc(rotulo)}</p>
  </div>`;
}

function filaUltimo(u) {
  const dot = DOT_POR_TIPO[u.tipo] || "";
  const contenido = `<span class="dot ${dot}"></span><span class="txt">${esc(u.texto)}</span><span class="val">${haceCuanto(u.ts)}</span>`;
  if (u.tipo === "lote" && u.lote)
    return `<li><a class="fila" href="#/lotes/${encodeURIComponent(u.lote)}" style="text-decoration:none;color:inherit">${contenido}</a></li>`;
  return `<li class="fila">${contenido}</li>`;
}

const TOPE_LOTES = 12; // en el celular, más de una docena de filas es scroll infinito

function filaLote(l) {
  const detalle = [
    l.cultivo,
    l.lluvia_mm != null && l.lluvia_mm > 0 ? formatearMm(l.lluvia_mm) + " de lluvia" : null,
    l.avance_pct != null ? `${formatearNumero(l.avance_pct, 0)} % de ${formatearHa(l.ha_estimadas)}` : null,
  ].filter(Boolean).join(" · ");
  return `<li class="fila">
    <span class="txt"><b>${esc(l.nombre)}</b>${detalle ? `<span>${esc(detalle)}</span>` : ""}</span>
    <span class="val">${esc(formatearHa(l.trabajado_ha))}</span>
  </li>`;
}

function filaCultivo(c) {
  return `<li class="fila">
    <span class="txt"><b>${esc(c.cultivo)}</b><span>${esc(`${formatearNumero(c.lotes, 0)} lote${c.lotes === 1 ? "" : "s"}`)}</span></span>
    <span class="val">${esc(formatearHa(c.ha))}</span>
  </li>`;
}

// Pinta SOLO la sección Campaña. Vive aparte del resumen de Inicio para que un
// reporte que falla o tarda no deje la pantalla en blanco.
function htmlCampana(estado) {
  const titulo = `<div class="titulo-seccion">Campaña</div>`;
  if (estado.paso === "cargando")
    return titulo + `<div class="card"><p>Buscando los acumulados de la campaña…</p></div>`;
  if (estado.paso === "error")
    return titulo + `<div class="card"><p>No se pudo traer el reporte de la campaña: ${esc(estado.mensaje || "error desconocido")}. El resto del Inicio está al día.</p></div>`;

  const v = estado.vista;
  if (!v || !v.hay_datos)
    return titulo + `<div class="card"><p>Todavía no hay lotes cargados en esta campaña.</p></div>`;

  const resumen = [
    `${formatearNumero(v.lotes_trabajados, 0)} lote${v.lotes_trabajados === 1 ? "" : "s"} trabajado${v.lotes_trabajados === 1 ? "" : "s"} de ${formatearNumero(v.total_lotes, 0)}`,
    v.lluvia_mm != null ? `${formatearMm(v.lluvia_mm)} de lluvia acumulada` : null,
  ].filter(Boolean).join(" · ");

  const visibles = v.lotes.slice(0, TOPE_LOTES);
  const resto = v.lotes.length - visibles.length;

  return `${titulo}
    <div class="card">
      <h3>${esc(formatearHa(v.total_ha))} trabajadas${v.temporada ? esc(" en " + v.temporada) : ""}</h3>
      <p>${esc(resumen)}</p>
    </div>
    ${v.cultivos.length ? `<div class="titulo-seccion">Por cultivo</div>
      <ul class="lista">${v.cultivos.map(filaCultivo).join("")}</ul>` : ""}
    <div class="titulo-seccion">Por lote</div>
    ${visibles.length
      ? `<ul class="lista">${visibles.map(filaLote).join("")}
          ${resto > 0 ? `<li class="fila"><span class="txt">y ${esc(formatearNumero(resto, 0))} lote${resto === 1 ? "" : "s"} más con menos hectáreas</span></li>` : ""}
          ${v.lotes_sin_trabajar > 0 ? `<li class="fila"><span class="txt">Lotes sin trabajar todavía</span><span class="pill">${esc(formatearNumero(v.lotes_sin_trabajar, 0))}</span></li>` : ""}
        </ul>`
      : `<div class="vacio">Ningún lote con hectáreas trabajadas en esta campaña.</div>`}`;
}

export async function montar(ctx, root) {
  root.classList.add("scroll");
  let vivo = true;
  let campana = { paso: "cargando", vista: null, mensaje: null };

  function pintarCampana() {
    const caja = root.querySelector("#campana");
    if (caja) caja.innerHTML = htmlCampana(campana);
  }

  async function cargarCampana() {
    try {
      // Mismo timeout largo que el resumen: el reporte reparsea coberturas.
      const r = await ctx.api.get("/api/reportes/temporada", { timeoutMs: 15000 });
      campana = { paso: "listo", vista: armarCampana(r.data), mensaje: null };
      // El cartel de "offline" lo maneja el resumen principal: si lo tocara
      // también la campaña, dos respuestas de distinta antigüedad se pisarían.
    } catch (e) {
      const m = e instanceof ErrorHttp && e.status === 400 ? "elegí un establecimiento arriba" : e.message;
      campana = { paso: "error", vista: null, mensaje: m };
    }
    if (vivo) pintarCampana();
  }

  async function cargar() {
    let r;
    try {
      // Timeout más largo: el primer hit del server (cache fría) puede tardar ~8 s.
      r = await ctx.api.get("/api/actividad/resumen", { timeoutMs: 15000 });
    } catch (e) {
      if (e instanceof ErrorHttp && e.status === 400) {
        root.innerHTML = `<div class="vacio">Elegí un establecimiento arriba</div>`;
      } else {
        root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
      }
      return;
    }
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const d = r.data;
    const ha = d.hectareas || {};
    const eq = d.equipos || {};
    const ll = d.lluvia || {};
    const num = (n) => Number(n || 0).toLocaleString("es-AR");

    const sinRep = eq.sin_reportar?.[0];
    const rotuloEquipos = sinRep
      ? `${sinRep.hostname} sin reportar hace ${(sinRep.hace_min || 0) < 60 ? (sinRep.hace_min || 0) + " min" : Math.round((sinRep.hace_min || 0) / 60) + " h"}`
      : "todos reportando";

    const rotuloLluvia = ll.ultima
      ? `última: ${diaMesCorto(ll.ultima.fecha)} · ${num(ll.ultima.mm)} mm`
      : "sin lluvias registradas";

    const ultimos = d.ultimos || [];

    root.innerHTML = `
      <div class="card">
        <h3>Temporada ${esc(d.temporada || "—")}</h3>
        <p>${mesCorto(d.rango?.desde)} – ${mesCorto(d.rango?.hasta)}</p>
      </div>
      ${d.alertas_activas > 0 ? `<div style="margin:0 12px 10px"><a class="pill err" href="#/alertas" style="text-decoration:none">${num(d.alertas_activas)} alerta${d.alertas_activas === 1 ? "" : "s"} activa${d.alertas_activas === 1 ? "" : "s"}</a></div>` : ""}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
        ${tile(num(ha.trabajadas) + " ha", `${num(ha.lotes)} lote${ha.lotes === 1 ? "" : "s"}`)}
        ${tile(num(ha.netas) + " ha", `repintado ${num(ha.repintado_pct)} %`)}
        ${tile(`${num(eq.online)} / ${num(eq.total)}`, rotuloEquipos)}
        ${tile(num(ll.mes_mm) + " mm", rotuloLluvia)}
      </div>
      <div class="titulo-seccion">Últimos movimientos</div>
      ${ultimos.length
        ? `<ul class="lista">${ultimos.map(filaUltimo).join("")}</ul>`
        : `<div class="vacio">Sin movimientos recientes.</div>`}
      <section id="campana">${htmlCampana(campana)}</section>`;
  }

  await cargar();
  // Sin await: el Inicio ya está en pantalla y la campaña se completa sola.
  cargarCampana();
  const timer = setInterval(cargar, REFRESCO_MS);
  const timerCampana = setInterval(cargarCampana, REFRESCO_CAMPANA_MS);
  return { desmontar() { vivo = false; clearInterval(timer); clearInterval(timerCampana); } };
}
