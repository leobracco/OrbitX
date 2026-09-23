// main.js — Bootstrap de la app: sesión → permisos → nav → router por hash.
// Las pantallas se cargan bajo demanda desde pantallas/<nombre>.js y reciben
// un ctx común. Registra el service worker y maneja el aviso de versión nueva.
import { crearStore, idbBackend } from "./core/store.js";
import { crearApi } from "./core/api.js";
import { crearAuth } from "./core/auth.js";
import { crearSync } from "./core/sync.js";
import { pestanasPara } from "./core/permisos.js";
import { conectarSocket } from "./core/socket.js";
import { crearNav } from "./ui/nav.js";
import { toast } from "./ui/toast.js";
import { elegirDeLista } from "./ui/selector.js";
import { esc } from "./ui/html.js";
import { desuscribirPush } from "./core/push.js";

const $ = (id) => document.getElementById(id);
const store = crearStore(idbBackend());
const auth  = crearAuth({});
const api   = crearApi({ store, getToken: () => auth.token(), onNoAuth: () => { auth.logout(); mostrarLogin("Tu sesión venció, ingresá de nuevo."); } });
const sync  = crearSync({ store, api, onEvento: (e) => {
  if (e.tipo === "enviado")  toast("Registro pendiente enviado", "ok");
  if (e.tipo === "detenido") toast(`No se pudo enviar: ${e.item.error || "sin conexión"}`, "error");
}});
sync.escuchar(window);

let ctx = null, actual = null, nav = null;

// Registrar listeners a nivel de módulo: solo actúan si hay sesión (ctx).
window.addEventListener("hashchange", () => { if (ctx) enrutar(); });
window.addEventListener("online",  () => { if (!ctx) return; nav.setOffline(false); enrutar(); });
window.addEventListener("offline", () => { if (ctx) nav.setOffline(true); });

function mostrarLogin(msg) {
  $("topbar").hidden = true; $("pantalla").hidden = true; $("nav").hidden = true;
  $("login").hidden = false;
  const err = $("login-error"); err.hidden = !msg; err.textContent = msg || "";
}

$("form-login").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = ev.target.querySelector("button"); btn.disabled = true;
  try { await auth.login(f.get("email"), f.get("password")); await arrancar(); }
  catch (e) { $("login-error").hidden = false; $("login-error").textContent = e.message; }
  finally { btn.disabled = false; }
});
$("btn-salir").addEventListener("click", async () => {
  if (!confirm("¿Cerrar sesión?")) return;
  actual?.desmontar?.(); actual = null;
  ctx?.socket?.disconnect();
  // Sin sesión no deben seguir llegando alertas de esta org a este teléfono.
  try { await desuscribirPush(api); } catch (e) { console.warn("[push] baja al salir:", e.message); }
  ctx = null;
  auth.logout();
  mostrarLogin();
});
$("btn-org").addEventListener("click", elegirOrg);

// Lista de establecimientos elegibles: el superadmin no tiene membresías,
// elige entre TODAS las orgs (/api/admin/orgs); el resto, entre sus membresías.
async function orgsElegibles(u) {
  if (u?.rol_global === "superadmin") {
    const { data } = await api.get("/api/admin/orgs");
    return (data || []).filter(o => o.activa !== false).map(o => ({ slug: o.slug, nombre: o.nombre || o.slug }));
  }
  return (u?.memberships || []).map(m => ({ slug: m.orgSlug, nombre: m.orgNombre || m.orgSlug }));
}

async function elegirOrg() {
  const u = auth.usuario();
  let orgs;
  try { orgs = await orgsElegibles(u); } catch (e) { toast(e.message, "error"); return; }
  if (orgs.length < 2 && u?.rol_global !== "superadmin") return;
  if (!orgs.length) { toast("No hay establecimientos para elegir", "error"); return; }
  const o = await elegirDeLista({
    titulo: "Elegí establecimiento",
    opciones: orgs.map(x => ({ valor: x.slug, etiqueta: x.nombre, actual: x.slug === u?.org_activa })),
  });
  if (!o || o.valor === u?.org_activa) return;
  try { await auth.cambiarOrg(o.valor); location.reload(); } catch (e) { toast(e.message, "error"); }
}

async function arrancar() {
  let usuario;
  try { usuario = await auth.me(); }
  catch (e) {
    usuario = auth.usuario(); // sin red: seguimos con lo guardado
    if (!usuario) return mostrarLogin(e.status === 401 ? "Tu sesión venció." : "Sin conexión y sin sesión guardada.");
  }
  const rol = usuario.rol_efectivo || usuario.rol_global || "viewer";
  $("login").hidden = true; $("topbar").hidden = false; $("pantalla").hidden = false;
  $("org-nombre").textContent = (usuario.memberships || []).find(m => m.orgSlug === usuario.org_activa)?.orgNombre || usuario.org_activa || "Elegir establecimiento ▾";
  // El nombre lindo de la org lo trae /api/admin/orgs (superadmin) — se completa
  // sin bloquear el arranque.
  if (usuario.rol_global === "superadmin" && usuario.org_activa)
    orgsElegibles(usuario).then(orgs => { const o = orgs.find(x => x.slug === usuario.org_activa); if (o) $("org-nombre").textContent = o.nombre; }).catch(() => {});

  nav = crearNav({ pestanas: pestanasPara(rol), onIr: (p) => { location.hash = `#/${p}`; } });
  const socket = conectarSocket({ token: auth.token(), onPosicion: (p) => ctx.onPosicion?.(p), onEstado: (s) => { if (s === "conectado") nav.setOffline(false); } });
  ctx = { api, store, auth, sync, usuario, rol, toast, socket, nav, onPosicion: null };

  if (!navigator.onLine) nav.setOffline(true);
  sync.drenar();
  await enrutar();
}

let generacion = 0;
async function enrutar() {
  const mia = ++generacion;
  const partes  = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const pestana = partes[0] || "inicio";
  const param   = partes[1] ? decodeURIComponent(partes[1]) : undefined;
  const permitidas = pestanasPara(ctx.rol);
  const destino = permitidas.includes(pestana) ? pestana : "inicio";
  if (destino !== pestana) { location.hash = `#/${destino}`; return; }
  actual?.desmontar?.(); ctx.onPosicion = null;
  const root = $("pantalla"); root.innerHTML = ""; root.className = "pantalla";
  nav.pestanaActiva(destino);
  try {
    const mod = await import(`./pantallas/${destino}.js`);
    const pantalla = await mod.montar(ctx, root, param);
    if (mia !== generacion) { pantalla?.desmontar?.(); return; } // llegó otro hash mientras montaba
    actual = pantalla;
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="vacio">No se pudo abrir esta pantalla.<br><small>${esc(e.message)}</small></div>`;
  }
}

// ── Service worker + aviso de versión nueva ─────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nuevo = reg.installing;
      nuevo?.addEventListener("statechange", () => {
        if (nuevo.state === "installed" && navigator.serviceWorker.controller) $("btn-actualizar").hidden = false;
      });
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update(); });
  });
  let recargando = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (recargando) return; recargando = true; location.reload(); });
  $("btn-actualizar").addEventListener("click", () => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.postMessage("SKIP_WAITING")));
}

if (auth.token()) arrancar(); else mostrarLogin();
