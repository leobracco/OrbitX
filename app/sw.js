// sw.js — Service worker: cachea el shell (HTML, CSS, JS, íconos, Leaflet)
// para que la app abra sin señal, y compara version.json para detectar una
// versión nueva. Los datos NO se cachean acá: eso lo hace api.js en IndexedDB.
// Las llamadas a /api/ y /socket.io/ pasan de largo siempre.
const VERSION_URL = "/app/version.json";
let CACHE = "orbitx-app-desconocida";

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

async function versionActual() {
  try { const r = await fetch(VERSION_URL, { cache: "no-store" }); return (await r.json()).version; }
  catch { return null; }
}

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const v = await versionActual();
    CACHE = `orbitx-app-${v || "sin-version"}`;
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(u).catch(e => console.warn("[sw] no cacheó", u, e.message))));
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    const v = await versionActual();
    CACHE = `orbitx-app-${v || "sin-version"}`;
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
  if (url.pathname.startsWith("/api/") || (url.pathname.startsWith("/socket.io/") && !esScriptSocket) || url.pathname === VERSION_URL) return;
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

// Push: se completa en la Tarea 14.
