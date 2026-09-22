// sw.js — Service worker: cachea el shell (HTML, CSS, JS, íconos, Leaflet)
// para que la app abra sin señal. Los datos NO se cachean acá: eso lo hace
// api.js en IndexedDB. Las llamadas a /api/ y /socket.io/ pasan de largo siempre.
// La versión va como literal acá: cada deploy la bumpea (junto con
// app/version.json, un test verifica que coincidan). Así el nombre del cache
// es constante aunque el navegador recicle el SW, y cambiar la versión cambia
// los bytes de sw.js → el navegador detecta la actualización.
const VERSION = "20260922-03";
const CACHE   = `orbitx-app-${VERSION}`;

const SHELL = [
  "/app/", "/app/index.html", "/app/app.css", "/app/main.js", "/app/manifest.webmanifest",
  "/app/core/store.js", "/app/core/api.js", "/app/core/auth.js", "/app/core/sync.js",
  "/app/core/permisos.js", "/app/core/fecha.js", "/app/core/socket.js", "/app/core/push.js",
  "/app/ui/nav.js", "/app/ui/sheet.js", "/app/ui/toast.js", "/app/ui/html.js",
  "/app/pantallas/mapa.js", "/app/pantallas/lotes.js", "/app/pantallas/lluvias.js",
  "/app/pantallas/alertas.js", "/app/pantallas/equipos.js",
  "/app/icons/icon-192.png", "/app/icons/icon-512.png",
  "/css/variables.css", "/css/leaflet.min.css", "/js/leaflet.min.js", "/socket.io/socket.io.js",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(u).catch(e => console.warn("[sw] no cacheó", u, e.message))));
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("orbitx-app-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (ev) => { if (ev.data === "SKIP_WAITING") self.skipWaiting(); });

self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (ev.request.method !== "GET") return;
  // /socket.io/ son conexiones (websocket/polling) y no se interceptan; el
  // script cliente /socket.io/socket.io.js sí es parte del shell y se cachea.
  const esScriptSocket = url.pathname === "/socket.io/socket.io.js";
  if (url.pathname.startsWith("/api/") || (url.pathname.startsWith("/socket.io/") && !esScriptSocket) || url.pathname === "/app/version.json") return;
  if (url.origin !== location.origin) return; // tiles del mapa: nunca se cachean acá
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(ev.request, { ignoreSearch: true, ignoreVary: true });
    if (hit) return hit;
    try {
      const res = await fetch(ev.request);
      if (res.ok && (url.pathname.startsWith("/app/") || esScriptSocket)) c.put(ev.request, res.clone());
      return res;
    } catch {
      if (ev.request.mode === "navigate") return (await c.match("/app/index.html")) || Response.error();
      return Response.error();
    }
  })());
});

self.addEventListener("push", (ev) => {
  let p = {};
  try { p = ev.data?.json() || {}; } catch { p = { titulo: "OrbitX", cuerpo: ev.data?.text() || "" }; }
  ev.waitUntil(self.registration.showNotification(p.titulo || "OrbitX", {
    body: p.cuerpo || "", icon: "/app/icons/icon-192.png", badge: "/app/icons/icon-192.png",
    data: { url: p.url || "/app/" }, tag: p.url || "orbitx", renotify: true,
  }));
});

self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  const url = ev.notification.data?.url || "/app/";
  ev.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(cs => {
    const abierta = cs.find(c => c.url.includes("/app/"));
    if (abierta) { abierta.navigate(url); return abierta.focus(); }
    return self.clients.openWindow(url);
  }));
});
