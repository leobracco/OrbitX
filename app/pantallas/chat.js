// chat.js — Conversación con el operario que está adentro del tractor, en la
// pantalla de PilotX. Dos vistas:
//   #/chat              → los equipos de la org, con su última actividad
//   #/chat/<device_id>  → el hilo con ese equipo + campo para escribir
//
// Cómo viaja un mensaje (lo define routes/soporte.js, no lo inventamos acá):
// el server NO se conecta al tractor. Nosotros dejamos el mensaje en el doc
// `soporte_chat_<device_id>` con POST /api/soporte/chat/enviar; PilotX pregunta
// cada ~20 s con GET /chat/pendientes y, recién ahí, el mensaje queda
// `entregado`. Por eso un mensaje puede estar mandado y todavía no haberlo
// visto nadie: la UI lo dice con todas las letras en vez de mentir un tilde.
//
// El circuito es el mismo que usa el panel web (views/pages/soporte-chat.ejs):
// GET /api/soporte/chat/:device para leer el hilo entero y POST
// /api/soporte/chat/enviar para escribir. No hay endpoint nuevo ni websocket.
import { esc } from "../ui/html.js";
import { haceCuanto, fechaCorta } from "../core/fecha.js";
import { ErrorHttp } from "../core/api.js";

// ─────────────────────────────────────────────────────────────────────────
//  Parte pura (la que testea tests/app/chat.test.mjs)
// ─────────────────────────────────────────────────────────────────────────

// Espejo de MAX_MSG en routes/soporte.js. El server hace slice(0, MAX_MSG) y
// DESPUÉS trim(): si acá cortáramos distinto, el operario recibiría un texto
// que no es el que se ve en el celular.
export const MAX_MSG = 4000;

// Largo de la vista previa en la lista de equipos. Una fila no puede crecer.
const LARGO_PREVIA = 70;

// El server solo escribe estos tres roles ("operario" desde la pantalla,
// "soporte" desde el panel/celular, "bot" desde la capa 2 de IA). Cualquier
// otra cosa la tratamos como nuestra: lo único que NO se puede confundir es
// el operario, porque de eso dependen los no leídos.
export function normalizarRol(rol) {
  const r = String(rol || "").trim().toLowerCase();
  if (r === "operario") return "operario";
  if (r === "bot") return "bot";
  return "soporte";
}

export function etiquetaRol(rol) {
  const r = normalizarRol(rol);
  if (r === "operario") return "Operario";
  if (r === "bot") return "Bot";
  return "Soporte";
}

// Deja cada mensaje del doc en algo que la vista pueda pintar sin preguntarse
// si un campo vino. `ts` puede faltar en mensajes viejos: se deja en null y la
// hora se muestra como "—" (inventar un Date.now() sería mentir la hora).
export function normalizarMensaje(m) {
  const msg = m && typeof m === "object" ? m : {};
  const rol = normalizarRol(msg.rol);
  const ts = Number(msg.ts);
  const tipo = String(msg.tipo || "texto");
  return {
    rol,
    propio: rol !== "operario",          // lo escribimos nosotros (o el bot)
    texto: String(msg.texto ?? ""),
    ts: Number.isFinite(ts) ? ts : null,
    entregado: msg.entregado === true,
    leido: msg.leido === true,
    por: String(msg.por || ""),
    tipo,
    // Capa 2: el bot puede proponer cambios de configuración. El celular no
    // los acepta ni rechaza (eso pasa en la pantalla del tractor), pero sí
    // avisa que ese mensaje es una propuesta y cómo quedó.
    estadoPropuesta: tipo === "propuesta_config"
      ? String((msg.payload && msg.payload.estado) || "pendiente")
      : null,
  };
}

// Respuesta de GET /api/soporte/chat/:device →
//   { device_id, bot_activo, mensajes: [...] }
// NO se reordena por `ts`: el doc guarda los mensajes en orden de llegada y
// hay mensajes viejos sin `ts`; ordenar los mandaría a cualquier lado y
// rompería la conversación. El orden del array ES el orden de la charla.
export function normalizarHilo(resp) {
  const r = resp && typeof resp === "object" ? resp : {};
  const lista = Array.isArray(r.mensajes) ? r.mensajes : [];
  return {
    device_id: String(r.device_id || ""),
    bot_activo: r.bot_activo === true,
    mensajes: lista.map(normalizarMensaje),
  };
}

// Qué mostramos abajo de un mensaje nuestro. Honesto a propósito: mientras
// PilotX no lo haya levantado (`entregado`), la pantalla del tractor todavía
// no lo tiene, y eso NO se puede pintar como entregado. De los mensajes del
// operario no se muestra estado: llegan ya entregados por definición.
export function estadoEntrega(m) {
  const msg = m && typeof m === "object" && "propio" in m ? m : normalizarMensaje(m);
  if (!msg.propio) return "";
  if (msg.leido) return "leído";
  if (msg.entregado) return "entregado";
  return "sin entregar";
}

// Mensajes del operario que todavía no miramos. `leido` hoy nunca lo pone
// nadie en el server, así que el que manda de verdad es `desde`: el ts del
// último mensaje del operario que ya vimos en este teléfono (guardado local).
// Un mensaje sin `ts` no se puede comparar: cuenta solo cuando no hay marca
// previa, para no quedar avisando para siempre de algo ya leído.
export function contarNoLeidos(mensajes, desde = 0) {
  const marca = Number.isFinite(Number(desde)) ? Number(desde) : 0;
  return (Array.isArray(mensajes) ? mensajes : []).reduce((n, cru) => {
    const m = cru && typeof cru === "object" && "propio" in cru ? cru : normalizarMensaje(cru);
    if (m.propio || m.leido) return n;
    if (m.ts === null) return marca > 0 ? n : n + 1;
    return m.ts > marca ? n + 1 : n;
  }, 0);
}

// Hasta dónde llegamos a leer: el ts del último mensaje del operario. Se
// guarda local al abrir la conversación para que la lista deje de marcarla.
export function tsUltimoOperario(mensajes) {
  let t = 0;
  for (const cru of Array.isArray(mensajes) ? mensajes : []) {
    const m = cru && typeof cru === "object" && "propio" in cru ? cru : normalizarMensaje(cru);
    if (!m.propio && m.ts !== null && m.ts > t) t = m.ts;
  }
  return t;
}

export function ultimoMensaje(mensajes) {
  const lista = Array.isArray(mensajes) ? mensajes : [];
  if (!lista.length) return null;
  const cru = lista[lista.length - 1];
  return cru && typeof cru === "object" && "propio" in cru ? cru : normalizarMensaje(cru);
}

// Una línea para la fila del equipo: quién habló último y qué dijo.
export function vistaPrevia(m) {
  if (!m) return "Sin mensajes todavía";
  const msg = typeof m === "object" && "propio" in m ? m : normalizarMensaje(m);
  const limpio = msg.texto.replace(/\s+/g, " ").trim();
  const cuerpo = limpio
    ? (limpio.length > LARGO_PREVIA ? limpio.slice(0, LARGO_PREVIA - 1) + "…" : limpio)
    : (msg.tipo === "propuesta_config" ? "(propuesta de configuración)" : "(mensaje vacío)");
  return `${etiquetaRol(msg.rol)}: ${cuerpo}`;
}

// Deja el texto como lo va a guardar el server (mismo orden de operaciones) y
// dice si hay algo para mandar. Un textarea con espacios o enters es "vacío":
// el server lo rechaza con 400 y no tiene sentido hacer el viaje.
export function prepararTexto(crudo) {
  const original = String(crudo ?? "");
  const texto = original.slice(0, MAX_MSG).trim();
  if (!texto) {
    return { ok: false, texto: "", recortado: false, error: "Escribí un mensaje antes de enviar." };
  }
  return { ok: true, texto, recortado: original.length > MAX_MSG, error: "" };
}

// ─────────────────────────────────────────────────────────────────────────
//  Vista
// ─────────────────────────────────────────────────────────────────────────

// Cada cuánto se relee el hilo abierto. PilotX pregunta por mensajes nuevos
// cada ~20 s (routes/soporte.js) y postea los del operario al instante, así
// que refrescar más rápido que unos segundos no adelanta nada y sí gasta
// batería y datos del celular. 5 s: lo que tarda en aparecer la respuesta del
// operario se siente inmediato, y son 12 pedidos por minuto como techo.
const REFRESCO_HILO_MS = 5000;

// La lista de equipos pide un hilo POR equipo: es caro. Se refresca cada 60 s
// (igual que Equipos) y, como volver de una conversación remonta la pantalla,
// en la práctica siempre se ve fresca.
const REFRESCO_LISTA_MS = 60000;

// Cuántos hilos se piden a la vez. Sin tope, una org con 30 equipos abre 30
// conexiones juntas y el celular las encola igual, pero con timeouts.
const PARALELO = 4;

// Marca local de hasta dónde leímos cada conversación. Vive en el store del
// teléfono porque el server no tiene dónde anotarlo: `leido` existe en el doc
// pero ningún endpoint lo pone en true.
const CLAVE_VISTO = "chat:visto";

async function leerVistos(ctx) {
  try { return (await ctx.store.cacheGet(CLAVE_VISTO))?.data || {}; }
  catch { return {}; }
}
async function guardarVisto(ctx, deviceId, ts) {
  if (!ts) return;
  try {
    const mapa = await leerVistos(ctx);
    if ((mapa[deviceId] || 0) >= ts) return;
    mapa[deviceId] = ts;
    await ctx.store.cacheSet(CLAVE_VISTO, mapa);
  } catch { /* si el store falla, el peor caso es volver a ver el aviso */ }
}

// Corre `fn` sobre `items` de a `PARALELO` y nunca lanza: un equipo que
// rebota (403 de otra org, 404 borrado) no puede dejar la lista sin pintar.
async function enTandas(items, fn) {
  const salida = [];
  for (let i = 0; i < items.length; i += PARALELO) {
    const tanda = items.slice(i, i + PARALELO);
    const rs = await Promise.all(tanda.map(x => fn(x).catch(() => null)));
    salida.push(...rs);
  }
  return salida;
}

function rutaHilo(deviceId) {
  return `/api/soporte/chat/${encodeURIComponent(deviceId)}`;
}

async function pedirEquipos(ctx) {
  // Siempre con ?estab=: para un superadmin, /api/devices sin filtro devuelve
  // los equipos de TODAS las orgs (mismo criterio que la pantalla Equipos).
  const org = ctx.usuario?.org_activa;
  const url = org ? `/api/devices?estab=${encodeURIComponent(org)}` : "/api/devices";
  return ctx.api.get(url);
}

// ── Vista 1: lista de equipos ────────────────────────────────────────────
async function montarLista(ctx, root) {
  root.classList.add("scroll");
  let vivo = true;

  async function cargar() {
    let r;
    try { r = await pedirEquipos(ctx); }
    catch (e) { if (vivo) root.innerHTML = `<div class="vacio">${esc(e.message)}</div>`; return; }
    if (!vivo) return;
    ctx.nav.setOffline(r.desdeCache, r.ts);

    const equipos = Array.isArray(r.data) ? r.data : [];
    const vistos = await leerVistos(ctx);
    const hilos = await enTandas(equipos, async (d) => {
      const h = await ctx.api.get(rutaHilo(d.device_id));
      return { device_id: d.device_id, hilo: normalizarHilo(h.data) };
    });
    if (!vivo) return;

    const porId = new Map();
    for (const h of hilos) if (h) porId.set(h.device_id, h.hilo);

    const filas = equipos.map((d) => {
      const hilo = porId.get(d.device_id);
      const msgs = hilo ? hilo.mensajes : [];
      const ultimo = ultimoMensaje(msgs);
      const sinLeer = contarNoLeidos(msgs, vistos[d.device_id] || 0);
      return {
        d, ultimo, sinLeer,
        ts: ultimo && ultimo.ts !== null ? ultimo.ts : 0,
        // Sin hilo pedido (falló el GET) no afirmamos "sin mensajes".
        conocido: !!hilo,
      };
    // Primero lo que espera respuesta, después la charla más reciente.
    }).sort((a, b) => (b.sinLeer > 0) - (a.sinLeer > 0) || b.ts - a.ts);

    const pendientes = filas.reduce((n, f) => n + (f.sinLeer > 0 ? 1 : 0), 0);

    root.innerHTML = `
      <div class="titulo-seccion">${filas.length} equipo${filas.length === 1 ? "" : "s"}${pendientes ? ` · ${pendientes} esperando respuesta` : ""}</div>
      <ul class="lista">${filas.map((f) => {
        const nombre = f.d.hostname || f.d.device_id;
        const cuando = f.ts ? haceCuanto(f.ts) : "";
        const detalle = f.conocido
          ? `${esc(vistaPrevia(f.ultimo))}${cuando ? " · " + esc(cuando) : ""}`
          : "No se pudo leer la conversación";
        return `<li><button class="fila" data-chat="${esc(f.d.device_id)}">
          <span class="dot ${f.d.online ? "ok" : (f.d.ultimo_visto ? "warn" : "")}"></span>
          <span class="txt"><b>${esc(nombre)}</b><span>${detalle}</span></span>
          <span class="val">${f.sinLeer ? `<span class="pill warn">${f.sinLeer} sin leer</span>` : "›"}</span>
        </button></li>`;
      }).join("")}</ul>
      ${filas.length ? "" : `<div class="vacio">No hay equipos asignados a este establecimiento.</div>`}
      <div class="card"><p>Lo que escribas le aparece al operario en la pantalla del tractor. PilotX pregunta por mensajes nuevos cada 20 segundos, así que puede tardar un poco en verlo.</p></div>`;
  }

  function alTocar(ev) {
    const b = ev.target.closest("[data-chat]");
    if (!b) return;
    location.hash = `#/chat/${encodeURIComponent(b.getAttribute("data-chat"))}`;
  }
  root.addEventListener("click", alTocar);

  await cargar();
  const timer = setInterval(cargar, REFRESCO_LISTA_MS);
  return {
    desmontar() {
      vivo = false;
      clearInterval(timer);
      root.removeEventListener("click", alTocar);
    },
  };
}

// ── Vista 2: la conversación ─────────────────────────────────────────────
function htmlMensaje(m) {
  const mio = m.propio;
  const estado = estadoEntrega(m);
  const propuesta = m.estadoPropuesta
    ? ` <span class="pill">propuesta ${esc(m.estadoPropuesta)}</span>`
    : "";
  return `<div class="card" style="max-width:86%;${mio ? "margin-left:auto" : "margin-right:auto"}">
    <p style="white-space:pre-wrap;word-break:break-word;color:var(--ap-text)">${esc(m.texto) || "<i>(sin texto)</i>"}</p>
    <p style="margin-top:6px;font-size:11px">${esc(etiquetaRol(m.rol))} · ${esc(fechaCorta(m.ts))}${estado ? " · " + esc(estado) : ""}${propuesta}</p>
  </div>`;
}

async function montarConversacion(ctx, root, deviceId) {
  let vivo = true;

  // El nombre lindo sale de /api/devices (cacheado); si no llega, el id no
  // miente ni bloquea la conversación.
  let nombre = deviceId;

  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.innerHTML = `
    <div class="titulo-seccion" style="display:flex;align-items:center;gap:8px;flex:none">
      <a href="#/chat" style="color:var(--ap-green);text-decoration:none">‹ Equipos</a>
      <span data-titulo style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nombre)}</span>
      <span data-estado style="text-transform:none;letter-spacing:0"></span>
    </div>
    <div data-hilo style="flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch">
      <div class="vacio">Buscando la conversación…</div>
    </div>
    <form data-form class="campo" style="flex:none;display:flex;gap:8px;align-items:flex-end">
      <textarea data-texto rows="1" maxlength="${MAX_MSG}" placeholder="Escribile al operario…" style="flex:1;resize:none;max-height:120px"></textarea>
      <button class="btn" type="submit" style="flex:none;padding:13px 16px">Enviar</button>
    </form>`;

  const elHilo   = root.querySelector("[data-hilo]");
  const elEstado = root.querySelector("[data-estado]");
  const elTitulo = root.querySelector("[data-titulo]");
  const form     = root.querySelector("[data-form]");
  const texto    = root.querySelector("[data-texto]");

  // Firma del contenido pintado: si no cambió nada, no se vuelve a escribir el
  // DOM. Redibujar cada 5 s le corta la selección de texto al que está
  // copiando un número de serie del mensaje del operario.
  let firma = null;
  let primeraVez = true;

  function pintar(hilo, desdeCache, tsCache) {
    const nueva = JSON.stringify(hilo.mensajes.map(m => [m.rol, m.texto, m.ts, m.entregado, m.leido, m.estadoPropuesta]));
    elEstado.textContent = desdeCache
      ? `guardado ${haceCuanto(tsCache)}`
      : (hilo.bot_activo ? "bot IA activo" : "");
    if (nueva === firma) return;

    // ¿Estaba mirando el final? Si se fue para arriba a leer algo viejo, no le
    // robamos el scroll cuando entra un mensaje nuevo.
    const alFondo = primeraVez ||
      (elHilo.scrollHeight - elHilo.scrollTop - elHilo.clientHeight) < 60;

    elHilo.innerHTML = hilo.mensajes.length
      ? hilo.mensajes.map(htmlMensaje).join("")
      : `<div class="vacio">Todavía no hay mensajes con este equipo.<br><small>Escribile: le va a aparecer en la pantalla del tractor.</small></div>`;
    firma = nueva;
    if (alFondo) elHilo.scrollTop = elHilo.scrollHeight;
    primeraVez = false;
  }

  async function refrescar() {
    let r;
    try { r = await ctx.api.get(rutaHilo(deviceId)); }
    catch (e) {
      if (!vivo) return;
      if (e instanceof ErrorHttp) {
        // 403 (equipo de otra org) y 404 (equipo inexistente) no se arreglan
        // reintentando: se dice qué pasó y se deja de insistir en silencio.
        elHilo.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
        firma = null;
        return;
      }
      elEstado.textContent = "sin conexión";
      return;
    }
    if (!vivo) return;
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const hilo = normalizarHilo(r.data);
    pintar(hilo, r.desdeCache, r.ts);
    // Abrir la conversación es leerla: se anota hasta dónde para que la lista
    // no siga marcando estos mensajes como pendientes.
    await guardarVisto(ctx, deviceId, tsUltimoOperario(hilo.mensajes));
  }

  async function enviar(ev) {
    ev.preventDefault();
    const prep = prepararTexto(texto.value);
    if (!prep.ok) { ctx.toast(prep.error, "error"); return; }
    if (prep.recortado) ctx.toast(`El mensaje se recortó a ${MAX_MSG} caracteres`, "error");

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      // Sin red NO se encola. Un mensaje de chat no es un registro de lluvia:
      // sync.js lo mandaría solo media hora después, cuando el operario ya
      // resolvió el problema o se bajó del tractor, y le llegaría una pregunta
      // fuera de contexto que parece una orden nueva. Es preferible avisar
      // ahora y dejarle el texto escrito para reintentar con señal.
      if (!navigator.onLine) throw new TypeError("sin conexión");
      await ctx.api.post("/api/soporte/chat/enviar", { device_id: deviceId, texto: prep.texto });
      texto.value = "";
      texto.style.height = "auto";
      await refrescar();
    } catch (e) {
      if (e instanceof ErrorHttp) {
        // 400 mensaje vacío, 403 equipo de otra org, 404 equipo no encontrado.
        ctx.toast(e.message, "error");
      } else {
        ctx.toast("Sin conexión: el mensaje NO se envió. Queda escrito para reintentar.", "error");
      }
    } finally {
      if (vivo) btn.disabled = false;
    }
  }
  form.addEventListener("submit", enviar);

  // El textarea crece con el texto: un mensaje de tres renglones no se escribe
  // a ciegas en una sola línea.
  function crecer() {
    texto.style.height = "auto";
    texto.style.height = Math.min(texto.scrollHeight, 120) + "px";
  }
  texto.addEventListener("input", crecer);

  // Con la app en segundo plano no se pide nada: el celular está en el bolsillo
  // y el hilo se relee apenas vuelve a la pantalla.
  function alVolver() { if (!document.hidden) refrescar(); }
  document.addEventListener("visibilitychange", alVolver);

  ctx.api.get(ctx.usuario?.org_activa
    ? `/api/devices?estab=${encodeURIComponent(ctx.usuario.org_activa)}`
    : "/api/devices")
    .then((r) => {
      if (!vivo) return;
      const d = (Array.isArray(r.data) ? r.data : []).find(x => x.device_id === deviceId);
      if (d) { nombre = d.hostname || d.device_id; elTitulo.textContent = nombre; }
    })
    .catch(() => { /* el id alcanza para conversar */ });

  await refrescar();
  const timer = setInterval(() => { if (!document.hidden) refrescar(); }, REFRESCO_HILO_MS);

  return {
    desmontar() {
      vivo = false;
      clearInterval(timer);
      form.removeEventListener("submit", enviar);
      texto.removeEventListener("input", crecer);
      document.removeEventListener("visibilitychange", alVolver);
      // main.js resetea className e innerHTML de la raíz, pero no los estilos
      // en línea: sin esto, la pantalla siguiente hereda el flex column.
      root.removeAttribute("style");
    },
  };
}

export async function montar(ctx, root, param) {
  const deviceId = String(param || "").trim();
  return deviceId ? montarConversacion(ctx, root, deviceId) : montarLista(ctx, root);
}
