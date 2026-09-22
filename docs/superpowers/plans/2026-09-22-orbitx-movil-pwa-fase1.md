# OrbitX Móvil PWA — Fase 1 · Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: usar `superpowers:subagent-driven-development` (recomendado) o `superpowers:executing-plans` para ejecutar este plan tarea por tarea. Los pasos usan casillas (`- [ ]`) para seguimiento.

**Objetivo:** Construir la PWA móvil de OrbitX (Fase 1: mapa en vivo, lotes, lluvias con carga offline, alertas con push, estado de equipos) servida en `/app` por el mismo Express, sin paso de build y con auto-actualización.

**Arquitectura:** Frontend vanilla ES modules en `OrbitX-Server/app/` que consume la API `/api/*` existente con JWT Bearer y socket.io. Toda lectura pasa por `core/api.js` (red con timeout → cache IndexedDB → fallback). Toda escritura offline pasa por la cola de `core/store.js` que `core/sync.js` drena al volver la señal. El único cambio de server es Web Push (VAPID): `lib/push.js`, `POST /api/auth/push-subscribe`, hook en `insertAlerta` y un cron de equipos caídos.

**Stack:** Node 22.15 / Express 5 / CouchDB (nano) / socket.io 4 · Frontend: ES modules nativos, Leaflet (ya en `public/js/leaflet.min.js` y `public/css/leaflet.min.css`), socket.io-client (servido por el server en `/socket.io/socket.io.js`), IndexedDB · Tests: `node:test` nativo · Push: `web-push`.

**Spec:** `docs/superpowers/specs/2026-09-21-orbitx-movil-pwa-fase1-design.md`

## Restricciones globales

- **Idioma:** todo texto visible, comentarios nuevos, logs y commits en castellano rioplatense.
- **Sin bundler ni framework.** ES modules nativos. `app/package.json` con `{"type":"module"}` para que Node los importe en tests.
- **Sin devDependencies nuevas.** Tests con `node --test`. La única dependencia nueva es `web-push` (producción).
- **Identidad visual:** tokens de `public/css/variables.css` — verde `#A4BA3E`, fondo `#1A1F25`, cards `#232830`, borde `#3D333B`, texto `#E6E6E6`, muted `#9AA3AD`, Inter, radio 8px.
- **Fechas visibles:** siempre `timeZone: "America/Argentina/Buenos_Aires"`.
- **No tocar el panel EJS existente** ni las rutas actuales, salvo lo enumerado: `server.js` (montar `/app`), `routes/auth.js` (agregar `push-subscribe`), `services/couchdb.js:insertAlerta` (hook push), `package.json` (script `test` + dep `web-push`).
- **Repo:** `G:\AgroParallel\Productos\OrbitX\Software\App_PC\OrbitX-Server`, rama `main`. Hay ~30 archivos modificados ajenos a este trabajo: **commitear siempre con rutas explícitas**, nunca `git add -A` ni `git add .`.
- **Umbrales:** equipo online = `ultimo_visto` < 2 min (criterio del server, `routes/devices.js:254`). Push de equipo caído = 15 min sin heartbeat, una vez por episodio.
- **Timeout de red:** 4000 ms. **Reintentos de cola:** máximo 3 fallos consecutivos, después se detiene y espera al usuario.
- **Formas de datos verificadas** (no inventar campos):
  - `POST /api/auth/login {email,password}` → `{ token, user:{ uid, nombre, email, avatar, rol_global, org_activa, memberships, prefs } }`
  - `GET /api/auth/me` → doc de usuario + `memberships`, `rol_efectivo`, `org_activa`
  - `POST /api/auth/cambiar-org { orgSlug }` → `{ token, orgSlug }`
  - `GET /api/tracking/live` → `[{ device_id, nombre, lat, lon, heading, speed, field, ts, age_sec, ... }]` (solo últimos 5 min)
  - socket `tracking:position` → `{ device_id, lat, lon, heading, speed, field, ts }`; auth por `io({ auth:{ token } })`; el server une al room `estab:<slug>` solo.
  - `GET /api/lotes` → `[{ _id, nombre, boundary:[[lat,lon],...]|null, fecha_inicio, fecha_fin?, cultivo?, ... }]`
  - `GET /api/alertas` → `[{ _id, nivel, ts_inicio, mensaje, resuelta?, ... }]`; `GET /api/alertas/historial` igual, hasta 100
  - `GET /api/lluvias` → `{ registros:[{ _id, fecha, mm, lote, nota, ... }], puede_editar }`; `POST /api/lluvias { fecha:'YYYY-MM-DD', mm, lote?, nota? }`
  - `GET /api/devices` → `[{ device_id, hostname, estab_slug, ultimo_visto, online, version, ... }]`

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `app/package.json` | `{"type":"module"}` — habilita ESM en tests de Node |
| `app/index.html` | Shell: login + contenedor de pantallas + nav |
| `app/app.css` | Estilos móviles sobre los tokens de OrbitX |
| `app/manifest.webmanifest` | Nombre, íconos, `display: standalone`, colores |
| `app/version.json` | `{ "version": "<hash>" }` que el SW compara |
| `app/sw.js` | Cache del shell, chequeo de versión, push handler |
| `app/main.js` | Bootstrap: sesión → permisos → nav → router por hash |
| `app/core/store.js` | IndexedDB (cache + cola) con backend inyectable |
| `app/core/api.js` | GET con timeout+cache fallback, POST directo |
| `app/core/permisos.js` | rol → pestañas |
| `app/core/sync.js` | drena la cola, corta a los 3 fallos |
| `app/core/auth.js` | login / me / cambiarOrg / logout |
| `app/core/socket.js` | socket.io con JWT |
| `app/core/push.js` | suscripción Web Push desde el cliente |
| `app/core/fecha.js` | formato de fechas TZ Argentina y "hace X" |
| `app/ui/nav.js` | barra de pestañas + franja offline + selector de org |
| `app/ui/sheet.js` | panel inferior arrastrable |
| `app/ui/toast.js` | avisos efímeros |
| `app/pantallas/{mapa,lotes,lluvias,alertas,equipos}.js` | una pantalla cada uno; exportan `montar(ctx, root)` |
| `app/icons/icon-192.png`, `icon-512.png` | íconos PWA |
| `lib/push.js` | Web Push server: VAPID, envío por org, selección de caídos |
| `routes/auth.js` | + `POST /api/auth/push-subscribe` |
| `services/couchdb.js` | `insertAlerta` dispara push best-effort |
| `server.js` | monta `/app`; cron equipos caídos cada 5 min |
| `tests/app/*.test.mjs` | store, api, permisos, sync, auth, fecha |
| `tests/lib/push.test.mjs` | `seleccionarCaidos` |

**Contrato de pantalla:** cada `pantallas/X.js` exporta `montar(ctx, root)` y devuelve `{ desmontar() }`. `ctx = { api, store, auth, sync, usuario, rol, toast, socket, nav }`.

---

### Tarea 1: Cimientos — montaje de `/app`, runner de tests, versión

**Archivos:**
- Create: `app/package.json`, `app/version.json`, `app/manifest.webmanifest`, `app/index.html` (placeholder), `tests/app/version.test.mjs`
- Modify: `server.js:175` (antes del static de `public`), `package.json` (script `test`)

**Interfaces:**
- Produce: ruta `/app/` servida como estático; comando `npm test`.

- [ ] **Paso 1: Test que falla — version.json válido**

`tests/app/version.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("app/version.json tiene un campo version no vacío", async () => {
  const raw = await readFile(new URL("../../app/version.json", import.meta.url), "utf8");
  const v = JSON.parse(raw);
  assert.equal(typeof v.version, "string");
  assert.ok(v.version.length >= 6, "version demasiado corta");
});
```

- [ ] **Paso 2: Agregar script y correr para ver que falla**

En `package.json`, dentro de `"scripts"`:
```json
"test": "node --test tests/"
```
Run: `npm test`
Expected: FAIL con `ENOENT ... app/version.json`

- [ ] **Paso 3: Crear los archivos base**

`app/package.json`:
```json
{ "type": "module", "private": true }
```

`app/version.json`:
```json
{ "version": "20260922-01" }
```

`app/manifest.webmanifest`:
```json
{
  "name": "OrbitX",
  "short_name": "OrbitX",
  "description": "Agro Parallel · el campo en vivo",
  "start_url": "/app/",
  "scope": "/app/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#121618",
  "theme_color": "#1A1F25",
  "lang": "es-AR",
  "icons": [
    { "src": "/app/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/app/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

`app/index.html` (placeholder, se reemplaza en Tarea 7):
```html
<!doctype html>
<html lang="es-AR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>OrbitX</title>
  <link rel="manifest" href="/app/manifest.webmanifest">
</head>
<body style="background:#121618;color:#E6E6E6;font-family:system-ui">
  <p style="padding:24px">OrbitX móvil — en construcción</p>
</body>
</html>
```

Íconos: copiar el logo de `public/img/brand/` a `app/icons/icon-192.png` e `icon-512.png` (cuadrados, con margen del 10 % para `maskable`). Si no hay PNG cuadrado, generar uno con el verde `#A4BA3E` sobre `#121618` con las letras "OX".

`server.js`, **antes** de la línea `app.use(express.static(path.join(__dirname, "public")));`:
```js
// ── App móvil (PWA) ───────────────────────────────────────
// Se sirve como estático puro: sin build, el service worker maneja la
// actualización. index.html y sw.js con no-cache para que la versión nueva
// llegue apenas se despliega; el resto lo cachea el SW.
app.use("/app", express.static(path.join(__dirname, "app"), {
  setHeaders(res, filePath) {
    if (/(index\.html|sw\.js|version\.json)$/.test(filePath))
      res.setHeader("Cache-Control", "no-cache, must-revalidate");
  },
}));
```

- [ ] **Paso 4: Correr el test y el server**

Run: `npm test`
Expected: `# pass 1`

Run: `node server.js` y en otra terminal `curl -s -o /dev/null -w "%{http_code}" http://localhost:PUERTO/app/`
Expected: `200`. Y `curl -sI http://localhost:PUERTO/app/version.json | grep -i cache-control` → `no-cache, must-revalidate`.

- [ ] **Paso 5: Commit**

```bash
git add app/package.json app/version.json app/manifest.webmanifest app/index.html app/icons/ tests/app/version.test.mjs server.js package.json
git commit -m "feat(app): montar /app como PWA estática + runner de tests nativo"
```

---

### Tarea 2: `core/store.js` — cache y cola sobre IndexedDB

**Archivos:**
- Create: `app/core/store.js`, `tests/app/store.test.mjs`

**Interfaces:**
- Produce:
  - `memBackend()` y `idbBackend(nombre = "orbitx-app")` → `{ get(k), set(k,v), del(k), keys(prefijo) }` (todas async)
  - `crearStore(backend)` → `{ cacheGet(clave) → {data,ts}|null, cacheSet(clave,data), colaAgregar({metodo,ruta,body}) → item, colaListar() → item[] por ts asc, colaActualizar(id,patch) → item, colaQuitar(id) }`
  - `item = { id:"tmp_<ts>_<rnd>", metodo, ruta, body, ts, intentos:0, estado:"pendiente"|"error", error:null }`

- [ ] **Paso 1: Test que falla**

`tests/app/store.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearStore, memBackend } from "../../app/core/store.js";

test("cacheSet/cacheGet guardan data con marca de tiempo", async () => {
  const s = crearStore(memBackend());
  await s.cacheSet("GET /api/lotes", [{ _id: "l1" }]);
  const r = await s.cacheGet("GET /api/lotes");
  assert.deepEqual(r.data, [{ _id: "l1" }]);
  assert.ok(Date.now() - r.ts < 1000);
});

test("cacheGet devuelve null si no hay nada", async () => {
  const s = crearStore(memBackend());
  assert.equal(await s.cacheGet("nada"), null);
});

test("la cola conserva el orden de llegada y asigna id temporal", async () => {
  const s = crearStore(memBackend());
  const a = await s.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 10 } });
  const b = await s.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 20 } });
  assert.match(a.id, /^tmp_/);
  assert.equal(a.estado, "pendiente");
  assert.equal(a.intentos, 0);
  const lista = await s.colaListar();
  assert.deepEqual(lista.map(i => i.body.mm), [10, 20]);
  assert.ok(a.ts <= b.ts);
});

test("colaActualizar aplica el patch y colaQuitar elimina", async () => {
  const s = crearStore(memBackend());
  const a = await s.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  const upd = await s.colaActualizar(a.id, { intentos: 2, estado: "error", error: "boom" });
  assert.equal(upd.intentos, 2);
  assert.equal(upd.error, "boom");
  await s.colaQuitar(a.id);
  assert.deepEqual(await s.colaListar(), []);
});
```

- [ ] **Paso 2: Correr para ver que falla**

Run: `npm test`
Expected: FAIL `Cannot find module .../app/core/store.js`

- [ ] **Paso 3: Implementar**

`app/core/store.js`:
```js
// store.js — Persistencia local: cache de respuestas GET y cola de escrituras
// pendientes. El backend es inyectable: en el navegador es IndexedDB, en los
// tests un Map en memoria. Las claves de cache son "GET <ruta>"; las de cola
// "cola:<id>".

export function memBackend() {
  const m = new Map();
  return {
    async get(k)  { return m.has(k) ? m.get(k) : undefined; },
    async set(k, v) { m.set(k, v); },
    async del(k)  { m.delete(k); },
    async keys(prefijo) { return [...m.keys()].filter(k => k.startsWith(prefijo)); },
  };
}

export function idbBackend(nombre = "orbitx-app") {
  const STORE = "kv";
  let dbp = null;
  function abrir() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(nombre, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    return dbp;
  }
  function tx(modo, fn) {
    return abrir().then(db => new Promise((res, rej) => {
      const t = db.transaction(STORE, modo);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => res(r.result);
      t.onerror    = () => rej(t.error);
    }));
  }
  return {
    get(k)    { return tx("readonly",  s => s.get(k)); },
    set(k, v) { return tx("readwrite", s => s.put(v, k)); },
    del(k)    { return tx("readwrite", s => s.delete(k)); },
    async keys(prefijo) {
      const todas = await tx("readonly", s => s.getAllKeys());
      return todas.filter(k => typeof k === "string" && k.startsWith(prefijo));
    },
  };
}

export function crearStore(backend) {
  const PRE_COLA = "cola:";
  return {
    async cacheGet(clave) {
      const v = await backend.get("cache:" + clave);
      return v ?? null;
    },
    async cacheSet(clave, data) {
      await backend.set("cache:" + clave, { data, ts: Date.now() });
    },
    async colaAgregar({ metodo, ruta, body }) {
      const ts = Date.now();
      const item = {
        id: `tmp_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        metodo, ruta, body, ts, intentos: 0, estado: "pendiente", error: null,
      };
      await backend.set(PRE_COLA + item.id, item);
      return item;
    },
    async colaListar() {
      const ks = await backend.keys(PRE_COLA);
      const items = await Promise.all(ks.map(k => backend.get(k)));
      return items.filter(Boolean).sort((a, b) => a.ts - b.ts);
    },
    async colaActualizar(id, patch) {
      const actual = await backend.get(PRE_COLA + id);
      if (!actual) throw new Error(`Item de cola no encontrado: ${id}`);
      const nuevo = { ...actual, ...patch };
      await backend.set(PRE_COLA + id, nuevo);
      return nuevo;
    },
    async colaQuitar(id) { await backend.del(PRE_COLA + id); },
  };
}
```

- [ ] **Paso 4: Correr tests**

Run: `npm test`
Expected: `# pass 5`

- [ ] **Paso 5: Commit**

```bash
git add app/core/store.js tests/app/store.test.mjs
git commit -m "feat(app): store con cache de GETs y cola de escrituras sobre IndexedDB"
```

---

### Tarea 3: `core/api.js` — red con timeout y fallback a cache

**Archivos:**
- Create: `app/core/api.js`, `tests/app/api.test.mjs`

**Interfaces:**
- Consume: `crearStore` (Tarea 2).
- Produce: `ErrorSinDatos`, `ErrorHttp` (con `.status`, `.body`), `crearApi({ fetchFn, store, getToken, onNoAuth, timeoutMs = 4000, base = "" })` → `{ get(ruta) → { data, desdeCache, ts }, post(ruta, body) → any, del(ruta) → any }`.

- [ ] **Paso 1: Test que falla**

`tests/app/api.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearApi, ErrorSinDatos, ErrorHttp } from "../../app/core/api.js";
import { crearStore, memBackend } from "../../app/core/store.js";

const ok = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const falla = () => async () => { throw new TypeError("Failed to fetch"); };
const cuelga = () => (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("abort", "AbortError"))));
const status = (code, body = {}) => async () => new Response(JSON.stringify(body), { status: code });

function arma(fetchFn, extra = {}) {
  const store = crearStore(memBackend());
  const api = crearApi({ fetchFn, store, getToken: () => "tok", timeoutMs: 50, ...extra });
  return { api, store };
}

test("get con red OK devuelve data fresca y la cachea", async () => {
  const { api, store } = arma(ok([1, 2]));
  const r = await api.get("/api/lotes");
  assert.deepEqual(r.data, [1, 2]);
  assert.equal(r.desdeCache, false);
  assert.deepEqual((await store.cacheGet("GET /api/lotes")).data, [1, 2]);
});

test("get manda Authorization Bearer", async () => {
  let vistos;
  const { api } = arma(async (_u, opts) => { vistos = opts.headers; return new Response("[]", { status: 200 }); });
  await api.get("/api/lotes");
  assert.equal(vistos.Authorization, "Bearer tok");
});

test("get sin red devuelve el cache marcado desdeCache", async () => {
  const { api, store } = arma(falla());
  await store.cacheSet("GET /api/lotes", [9]);
  const r = await api.get("/api/lotes");
  assert.deepEqual(r.data, [9]);
  assert.equal(r.desdeCache, true);
  assert.ok(typeof r.ts === "number");
});

test("get que se cuelga más del timeout cae al cache", async () => {
  const { api, store } = arma(cuelga());
  await store.cacheSet("GET /api/lotes", [7]);
  const r = await api.get("/api/lotes");
  assert.equal(r.desdeCache, true);
});

test("get sin red y sin cache lanza ErrorSinDatos", async () => {
  const { api } = arma(falla());
  await assert.rejects(() => api.get("/api/lotes"), ErrorSinDatos);
});

test("401 llama onNoAuth y lanza ErrorHttp", async () => {
  let llamado = false;
  const { api } = arma(status(401), { onNoAuth: () => { llamado = true; } });
  await assert.rejects(() => api.get("/api/lotes"), (e) => e instanceof ErrorHttp && e.status === 401);
  assert.equal(llamado, true);
});

test("post no usa cache y devuelve el body; error trae status y body", async () => {
  const { api } = arma(ok({ ok: true, _id: "x" }));
  assert.deepEqual(await api.post("/api/lluvias", { mm: 5 }), { ok: true, _id: "x" });
  const { api: api2 } = arma(status(400, { error: "mm inválidos" }));
  await assert.rejects(() => api2.post("/api/lluvias", {}), (e) => e.status === 400 && e.body.error === "mm inválidos");
});
```

- [ ] **Paso 2: Correr para ver que falla**

Run: `npm test`
Expected: FAIL `Cannot find module .../app/core/api.js`

- [ ] **Paso 3: Implementar**

`app/core/api.js`:
```js
// api.js — Único punto de acceso HTTP de la app. GET: intenta red con
// timeout; si responde, cachea y devuelve; si falla o expira, devuelve el
// cache con su antigüedad. POST/DELETE: red directa, sin cache (la cola
// offline vive en sync.js, no acá). 401 → onNoAuth (sesión vencida).

export class ErrorSinDatos extends Error {
  constructor(ruta) { super(`Sin conexión y sin datos guardados para ${ruta}`); this.name = "ErrorSinDatos"; }
}
export class ErrorHttp extends Error {
  constructor(status, body, ruta) {
    super(body?.error || `HTTP ${status} en ${ruta}`);
    this.name = "ErrorHttp"; this.status = status; this.body = body;
  }
}

export function crearApi({ fetchFn = globalThis.fetch, store, getToken, onNoAuth = () => {}, timeoutMs = 4000, base = "" }) {
  async function pedir(metodo, ruta, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json" };
      const tok = getToken();
      if (tok) headers.Authorization = `Bearer ${tok}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchFn(base + ruta, {
        method: metodo, headers, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 401) { onNoAuth(); throw new ErrorHttp(401, data, ruta); }
      if (!res.ok) throw new ErrorHttp(res.status, data, ruta);
      return data;
    } finally { clearTimeout(timer); }
  }

  return {
    async get(ruta) {
      const clave = `GET ${ruta}`;
      try {
        const data = await pedir("GET", ruta);
        await store.cacheSet(clave, data);
        return { data, desdeCache: false, ts: Date.now() };
      } catch (e) {
        if (e instanceof ErrorHttp) throw e; // el server respondió: no es un problema de red
        const c = await store.cacheGet(clave);
        if (!c) throw new ErrorSinDatos(ruta);
        return { data: c.data, desdeCache: true, ts: c.ts };
      }
    },
    post(ruta, body) { return pedir("POST", ruta, body ?? {}); },
    del(ruta)        { return pedir("DELETE", ruta); },
  };
}
```

- [ ] **Paso 4: Correr tests**

Run: `npm test`
Expected: `# pass 12`

- [ ] **Paso 5: Commit**

```bash
git add app/core/api.js tests/app/api.test.mjs
git commit -m "feat(app): api con timeout, Bearer y fallback a cache"
```

---

### Tarea 4: `core/permisos.js` y `core/fecha.js`

**Archivos:**
- Create: `app/core/permisos.js`, `app/core/fecha.js`, `tests/app/permisos.test.mjs`, `tests/app/fecha.test.mjs`

**Interfaces:**
- Produce: `PESTANAS = ["mapa","lotes","lluvias","alertas","equipos"]`, `pestanasPara(rol) → string[]`, `puedeVer(rol, pestana) → bool`; `haceCuanto(ts, ahora = Date.now()) → "recién"|"hace 3 min"|"hace 2 h"|"hace 3 d"`, `fechaCorta(ts) → "22/09 14:05"`, `fechaISOHoy() → "YYYY-MM-DD"` (TZ Argentina).

- [ ] **Paso 1: Tests que fallan**

`tests/app/permisos.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pestanasPara, puedeVer, PESTANAS } from "../../app/core/permisos.js";

const TODAS = ["mapa", "lotes", "lluvias", "alertas", "equipos"];

test("roles con dispositivos ven las cinco pestañas", () => {
  for (const rol of ["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador"])
    assert.deepEqual(pestanasPara(rol), TODAS, rol);
});

test("viewer y member no ven Equipos (dispositivos: [])", () => {
  assert.deepEqual(pestanasPara("viewer"), ["mapa", "lotes", "lluvias", "alertas"]);
  assert.deepEqual(pestanasPara("member"), ["mapa", "lotes", "lluvias", "alertas"]);
});

test("rol desconocido o vacío cae al mínimo de viewer", () => {
  assert.deepEqual(pestanasPara(undefined), pestanasPara("viewer"));
  assert.deepEqual(pestanasPara("cualquiera"), pestanasPara("viewer"));
});

test("puedeVer y PESTANAS son consistentes", () => {
  assert.deepEqual(PESTANAS, TODAS);
  assert.equal(puedeVer("viewer", "equipos"), false);
  assert.equal(puedeVer("owner", "equipos"), true);
});
```

`tests/app/fecha.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { haceCuanto, fechaCorta, fechaISOHoy } from "../../app/core/fecha.js";

test("haceCuanto escala minutos, horas y días", () => {
  const ahora = 1_800_000_000_000;
  assert.equal(haceCuanto(ahora - 20_000, ahora), "recién");
  assert.equal(haceCuanto(ahora - 3 * 60_000, ahora), "hace 3 min");
  assert.equal(haceCuanto(ahora - 2 * 3_600_000, ahora), "hace 2 h");
  assert.equal(haceCuanto(ahora - 3 * 86_400_000, ahora), "hace 3 d");
});

test("fechaCorta usa TZ Argentina", () => {
  // 2026-09-22T17:05:00Z = 14:05 en Buenos Aires (UTC-3)
  assert.equal(fechaCorta(Date.UTC(2026, 8, 22, 17, 5)), "22/09 14:05");
});

test("fechaISOHoy devuelve YYYY-MM-DD", () => {
  assert.match(fechaISOHoy(), /^\d{4}-\d{2}-\d{2}$/);
});
```

- [ ] **Paso 2: Correr para ver que fallan**

Run: `npm test`
Expected: FAIL por módulos inexistentes.

- [ ] **Paso 3: Implementar**

`app/core/permisos.js`:
```js
// permisos.js — Traduce el rol efectivo (de /api/auth/me) a las pestañas
// visibles. Es filtrado de conveniencia: el server ya valida cada request con
// requirePermiso. Se deriva de PERMS en roles.js: 'equipos' solo si el rol
// tiene lectura en 'dispositivos' (viewer y member no la tienen).

export const PESTANAS = ["mapa", "lotes", "lluvias", "alertas", "equipos"];

const SIN_EQUIPOS = ["mapa", "lotes", "lluvias", "alertas"];
const CON_DISPOSITIVOS = new Set(["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador"]);

export function pestanasPara(rol) {
  return CON_DISPOSITIVOS.has(rol) ? [...PESTANAS] : [...SIN_EQUIPOS];
}

export function puedeVer(rol, pestana) {
  return pestanasPara(rol).includes(pestana);
}
```

`app/core/fecha.js`:
```js
// fecha.js — Formatos de fecha para la UI. El server corre en UTC: TODO lo
// visible se formatea en hora Argentina.
const TZ = "America/Argentina/Buenos_Aires";

export function haceCuanto(ts, ahora = Date.now()) {
  const s = Math.max(0, Math.round((ahora - ts) / 1000));
  if (s < 60) return "recién";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function fechaCorta(ts) {
  const d = new Date(ts);
  const f = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(d);
  const h = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${f} ${h}`;
}

export function fechaISOHoy(ahora = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
  return p; // en-CA da YYYY-MM-DD
}
```

- [ ] **Paso 4: Correr tests**

Run: `npm test`
Expected: `# pass 19`

- [ ] **Paso 5: Commit**

```bash
git add app/core/permisos.js app/core/fecha.js tests/app/permisos.test.mjs tests/app/fecha.test.mjs
git commit -m "feat(app): permisos rol→pestañas y utilidades de fecha en TZ Argentina"
```

---

### Tarea 5: `core/sync.js` — drenar la cola con corte a los 3 fallos

**Archivos:**
- Create: `app/core/sync.js`, `tests/app/sync.test.mjs`

**Interfaces:**
- Consume: `store.colaListar/colaActualizar/colaQuitar` (T2), `api.post` y `ErrorHttp` (T3).
- Produce: `crearSync({ store, api, onEvento = () => {} })` → `{ drenar() → { enviados, fallidos, detenido }, reintentar(id) → drenar(), escuchar(win = window) }`. `reintentar` vuelve un item en `error` a `pendiente` con `intentos: 0` y drena. Eventos: `{ tipo:"enviado", item, respuesta }`, `{ tipo:"fallo", item, error }`, `{ tipo:"detenido", item }`.

- [ ] **Paso 1: Test que falla**

`tests/app/sync.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearSync } from "../../app/core/sync.js";
import { crearStore, memBackend } from "../../app/core/store.js";
import { ErrorHttp } from "../../app/core/api.js";

function arma(postImpl) {
  const store = crearStore(memBackend());
  const eventos = [];
  const sync = crearSync({ store, api: { post: postImpl }, onEvento: (e) => eventos.push(e) });
  return { store, sync, eventos };
}

test("envía en orden y quita de la cola lo confirmado", async () => {
  const enviados = [];
  const { store, sync, eventos } = arma(async (ruta, body) => { enviados.push(body.mm); return { _id: "real_" + body.mm }; });
  await store.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 1 } });
  await store.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body: { mm: 2 } });
  const r = await sync.drenar();
  assert.deepEqual(enviados, [1, 2]);
  assert.equal(r.enviados, 2);
  assert.deepEqual(await store.colaListar(), []);
  assert.equal(eventos.filter(e => e.tipo === "enviado").length, 2);
  assert.equal(eventos[0].respuesta._id, "real_1");
});

test("un fallo de red incrementa intentos y NO quita el item", async () => {
  const { store, sync } = arma(async () => { throw new TypeError("Failed to fetch"); });
  const it = await store.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  const r = await sync.drenar();
  assert.equal(r.fallidos, 1);
  const [q] = await store.colaListar();
  assert.equal(q.id, it.id);
  assert.equal(q.intentos, 1);
  assert.equal(q.estado, "pendiente");
});

test("al tercer fallo consecutivo marca error, emite detenido y no sigue con el resto", async () => {
  let llamadas = 0;
  const { store, sync, eventos } = arma(async () => { llamadas++; throw new TypeError("sin red"); });
  await store.colaAgregar({ metodo: "POST", ruta: "/a", body: {} });
  await store.colaAgregar({ metodo: "POST", ruta: "/b", body: {} });
  await sync.drenar(); await sync.drenar();
  const r = await sync.drenar();
  assert.equal(r.detenido, true);
  const [a, b] = await store.colaListar();
  assert.equal(a.estado, "error");
  assert.equal(a.intentos, 3);
  assert.equal(b.intentos, 0, "el segundo nunca se intentó porque el primero cortó");
  assert.equal(llamadas, 3);
  assert.equal(eventos.at(-1).tipo, "detenido");
});

test("un rechazo del server (4xx) marca error de inmediato sin agotar reintentos", async () => {
  const { store, sync, eventos } = arma(async () => { throw new ErrorHttp(400, { error: "mm inválidos" }, "/x"); });
  await store.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  const r = await sync.drenar();
  const [q] = await store.colaListar();
  assert.equal(q.estado, "error");
  assert.equal(q.error, "mm inválidos");
  assert.equal(r.detenido, true);
  assert.equal(eventos.at(-1).tipo, "detenido");
});

test("los items en estado error no se reintentan solos", async () => {
  let llamadas = 0;
  const { store, sync } = arma(async () => { llamadas++; return {}; });
  const it = await store.colaAgregar({ metodo: "POST", ruta: "/x", body: {} });
  await store.colaActualizar(it.id, { estado: "error", intentos: 3 });
  await sync.drenar();
  assert.equal(llamadas, 0);
});
```

- [ ] **Paso 2: Correr para ver que falla**

Run: `npm test`
Expected: FAIL `Cannot find module .../app/core/sync.js`

- [ ] **Paso 3: Implementar**

`app/core/sync.js`:
```js
// sync.js — Drena la cola de escrituras pendientes cuando hay conexión.
// Reglas: se envía en orden de llegada; un fallo de red suma un intento y
// corta la pasada (el siguiente item casi seguro fallaría igual); al tercer
// fallo el item queda en "error" y espera acción del usuario; un rechazo
// del server (4xx/5xx) pasa a "error" de inmediato porque reintentar no lo
// arregla. Los items en "error" se reintentan solo a pedido (reintentar()).
import { ErrorHttp } from "./api.js";

const MAX_INTENTOS = 3;

export function crearSync({ store, api, onEvento = () => {} }) {
  let corriendo = false;

  async function drenar() {
    if (corriendo) return { enviados: 0, fallidos: 0, detenido: false };
    corriendo = true;
    const r = { enviados: 0, fallidos: 0, detenido: false };
    try {
      const cola = (await store.colaListar()).filter(i => i.estado === "pendiente");
      for (const item of cola) {
        try {
          const respuesta = await api.post(item.ruta, item.body);
          await store.colaQuitar(item.id);
          r.enviados++;
          onEvento({ tipo: "enviado", item, respuesta });
        } catch (e) {
          r.fallidos++;
          const intentos = item.intentos + 1;
          const rechazo = e instanceof ErrorHttp;
          const agotado = intentos >= MAX_INTENTOS;
          const patch = rechazo || agotado
            ? { intentos, estado: "error", error: e.body?.error || e.message }
            : { intentos, error: e.message };
          const actualizado = await store.colaActualizar(item.id, patch);
          onEvento({ tipo: "fallo", item: actualizado, error: e });
          r.detenido = true;
          onEvento({ tipo: "detenido", item: actualizado });
          break;
        }
      }
    } finally { corriendo = false; }
    return r;
  }

  async function reintentar(id) {
    await store.colaActualizar(id, { estado: "pendiente", intentos: 0, error: null });
    return drenar();
  }

  function escuchar(win = globalThis) {
    win.addEventListener?.("online", () => { drenar(); });
  }

  return { drenar, reintentar, escuchar };
}
```

- [ ] **Paso 4: Correr tests**

Run: `npm test`
Expected: `# pass 24`

- [ ] **Paso 5: Commit**

```bash
git add app/core/sync.js tests/app/sync.test.mjs
git commit -m "feat(app): sync drena la cola offline y corta a los 3 fallos"
```

---

### Tarea 6: `core/auth.js` — sesión, `me`, cambio de organización

**Archivos:**
- Create: `app/core/auth.js`, `tests/app/auth.test.mjs`

**Interfaces:**
- Produce: `crearAuth({ storage, fetchFn = fetch, base = "" })` → `{ token(), usuario(), login(email, password) → user, me() → user, cambiarOrg(orgSlug), logout() }`. Claves de storage: `orbitx.token`, `orbitx.usuario`. `usuario()` devuelve el último `me()` guardado (con `rol_efectivo`, `org_activa`, `memberships`).

- [ ] **Paso 1: Test que falla**

`tests/app/auth.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { crearAuth } from "../../app/core/auth.js";

function memStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("login guarda token y usuario", async () => {
  const st = memStorage();
  const auth = crearAuth({ storage: st, fetchFn: async (u, o) => {
    if (u.endsWith("/api/auth/login")) { assert.equal(JSON.parse(o.body).email, "a@b.c"); return json({ token: "T1", user: { uid: "usr_1", nombre: "Ana" } }); }
    if (u.endsWith("/api/auth/me"))    return json({ _id: "usr_1", nombre: "Ana", rol_efectivo: "owner", org_activa: "campo1", memberships: [] });
    throw new Error("ruta inesperada " + u);
  }});
  const u = await auth.login("a@b.c", "x");
  assert.equal(auth.token(), "T1");
  assert.equal(u.rol_efectivo, "owner");
  assert.equal(auth.usuario().org_activa, "campo1");
});

test("login con credenciales malas lanza con el mensaje del server", async () => {
  const auth = crearAuth({ storage: memStorage(), fetchFn: async () => json({ error: "Credenciales inválidas" }, 401) });
  await assert.rejects(() => auth.login("a", "b"), /Credenciales inválidas/);
  assert.equal(auth.token(), null);
});

test("cambiarOrg reemplaza el token y recarga me", async () => {
  const st = memStorage(); st.setItem("orbitx.token", "T1");
  let meLlamado = 0;
  const auth = crearAuth({ storage: st, fetchFn: async (u, o) => {
    if (u.endsWith("/cambiar-org")) { assert.equal(o.headers.Authorization, "Bearer T1"); assert.equal(JSON.parse(o.body).orgSlug, "campo2"); return json({ token: "T2", orgSlug: "campo2" }); }
    if (u.endsWith("/me")) { meLlamado++; return json({ rol_efectivo: "viewer", org_activa: "campo2", memberships: [] }); }
  }});
  await auth.cambiarOrg("campo2");
  assert.equal(auth.token(), "T2");
  assert.equal(meLlamado, 1);
  assert.equal(auth.usuario().org_activa, "campo2");
});

test("logout limpia token y usuario", async () => {
  const st = memStorage(); st.setItem("orbitx.token", "T"); st.setItem("orbitx.usuario", "{}");
  const auth = crearAuth({ storage: st, fetchFn: async () => json({}) });
  auth.logout();
  assert.equal(auth.token(), null);
  assert.equal(auth.usuario(), null);
});
```

- [ ] **Paso 2: Correr para ver que falla**

Run: `npm test`
Expected: FAIL `Cannot find module .../app/core/auth.js`

- [ ] **Paso 3: Implementar**

`app/core/auth.js`:
```js
// auth.js — Sesión de la app. El JWT dura 30 días y no hay refresh: ante un
// 401 se borra la sesión y se vuelve al login (la cola offline se conserva
// en IndexedDB, no acá). Cambiar de organización reemite el token.
const K_TOKEN = "orbitx.token";
const K_USER  = "orbitx.usuario";

export function crearAuth({ storage = globalThis.localStorage, fetchFn = globalThis.fetch, base = "" }) {
  async function llamar(ruta, body, conToken = true) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const t = token();
    if (conToken && t) headers.Authorization = `Bearer ${t}`;
    const res = await fetchFn(base + ruta, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  function token() { return storage.getItem(K_TOKEN); }
  function usuario() { const raw = storage.getItem(K_USER); return raw ? JSON.parse(raw) : null; }
  async function me() {
    const u = await llamar("/api/auth/me");
    storage.setItem(K_USER, JSON.stringify(u));
    return u;
  }
  async function login(email, password) {
    const r = await llamar("/api/auth/login", { email, password }, false);
    storage.setItem(K_TOKEN, r.token);
    return me();
  }
  async function cambiarOrg(orgSlug) {
    const r = await llamar("/api/auth/cambiar-org", { orgSlug });
    storage.setItem(K_TOKEN, r.token);
    await me();
  }
  function logout() { storage.removeItem(K_TOKEN); storage.removeItem(K_USER); }
  return { token, usuario, login, me, cambiarOrg, logout };
}
```

- [ ] **Paso 4: Correr tests**

Run: `npm test`
Expected: `# pass 28`

- [ ] **Paso 5: Commit**

```bash
git add app/core/auth.js tests/app/auth.test.mjs
git commit -m "feat(app): auth con login, me, cambio de org y logout"
```

---

### Tarea 7: Shell de la app — `index.html`, CSS, nav, sheet, toast, router y service worker

**Archivos:**
- Create: `app/app.css`, `app/main.js`, `app/ui/nav.js`, `app/ui/sheet.js`, `app/ui/toast.js`, `app/sw.js`, `app/core/socket.js`
- Modify: `app/index.html` (reemplaza el placeholder de T1)

**Interfaces:**
- Consume: T2–T6.
- Produce: `ctx` para pantallas (`{ api, store, auth, sync, usuario, rol, toast, socket, nav }`); `nav.setOffline(bool, ts)`, `nav.pestanaActiva(nombre)`; `crearSheet(el)` → `{ abrir(), cerrar(), setAltura("min"|"medio"|"max") }`; `toast(msg, tipo = "info"|"ok"|"error")`; `conectarSocket({ token, onPosicion, onEstado })` → socket. Router por hash: `#/mapa`, `#/lotes`, `#/lotes/<id>`, `#/lluvias`, `#/alertas`, `#/equipos`. Las pantallas se importan dinámicamente desde `pantallas/<nombre>.js`.

No hay tests unitarios (DOM); verificación manual al final.

- [ ] **Paso 1: `app/index.html`**

```html
<!doctype html>
<html lang="es-AR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1A1F25">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="OrbitX">
  <title>OrbitX</title>
  <link rel="manifest" href="/app/manifest.webmanifest">
  <link rel="apple-touch-icon" href="/app/icons/icon-192.png">
  <link rel="stylesheet" href="/css/variables.css">
  <link rel="stylesheet" href="/css/leaflet.min.css">
  <link rel="stylesheet" href="/app/app.css">
</head>
<body>
  <div id="franja" class="franja" hidden></div>

  <section id="login" class="login" hidden>
    <img src="/app/icons/icon-192.png" alt="" class="login-logo">
    <h1>OrbitX</h1>
    <form id="form-login">
      <input name="email" type="email" placeholder="Email" autocomplete="username" required>
      <input name="password" type="password" placeholder="Contraseña" autocomplete="current-password" required>
      <button type="submit">Ingresar</button>
      <p id="login-error" class="error" hidden></p>
    </form>
  </section>

  <header id="topbar" class="topbar" hidden>
    <button id="btn-org" class="org"><span class="org-l">Establecimiento</span><b id="org-nombre">—</b></button>
    <button id="btn-actualizar" class="icono" title="Hay una versión nueva" hidden>⟳</button>
    <button id="btn-salir" class="icono" title="Salir">⏻</button>
  </header>

  <main id="pantalla" class="pantalla" hidden></main>

  <nav id="nav" class="nav" hidden></nav>

  <div id="toasts" class="toasts"></div>

  <script src="/js/leaflet.min.js"></script>
  <script src="/socket.io/socket.io.js"></script>
  <script type="module" src="/app/main.js"></script>
</body>
</html>
```

- [ ] **Paso 2: `app/app.css`**

```css
/* app.css — Estilos móviles de OrbitX sobre los tokens de variables.css */
* { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
html, body { margin: 0; height: 100%; background: var(--ap-bg-deep); color: var(--ap-text); font-family: var(--ap-font); }
body { display: flex; flex-direction: column; height: 100dvh; overflow: hidden; }
button, input { font: inherit; }
[hidden] { display: none !important; }

.franja { flex: none; background: var(--ap-yellow-dim); color: var(--ap-yellow); font-size: 12px; text-align: center; padding: 6px 12px; padding-top: calc(6px + env(safe-area-inset-top)); }
.franja.error { background: var(--ap-red-dim); color: var(--ap-red); }

.topbar { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; padding-top: calc(8px + env(safe-area-inset-top)); background: var(--ap-bg); border-bottom: 1px solid var(--ap-border-soft); }
.topbar .org { flex: 1; text-align: left; background: none; border: 0; color: var(--ap-text); padding: 0; }
.topbar .org-l { display: block; font-size: 10px; color: var(--ap-muted-2); text-transform: uppercase; letter-spacing: .6px; }
.topbar .org b { font-size: 15px; color: var(--ap-green); }
.topbar .icono { background: var(--ap-card); border: 1px solid var(--ap-border); color: var(--ap-text); width: 36px; height: 36px; border-radius: var(--radius); font-size: 16px; }

.pantalla { flex: 1; min-height: 0; position: relative; overflow: hidden; }
.pantalla.scroll { overflow-y: auto; -webkit-overflow-scrolling: touch; }

.nav { flex: none; display: flex; background: var(--ap-bg); border-top: 1px solid var(--ap-border-soft); padding-bottom: env(safe-area-inset-bottom); }
.nav button { flex: 1; background: none; border: 0; color: var(--ap-muted-2); padding: 8px 0 6px; font-size: 10px; display: flex; flex-direction: column; align-items: center; gap: 2px; }
.nav button i { font-style: normal; font-size: 20px; }
.nav button.on { color: var(--ap-green); }
.nav button .badge { position: absolute; margin-left: 22px; margin-top: -2px; background: var(--ap-red); color: #fff; font-size: 9px; padding: 1px 5px; border-radius: 10px; }

.login { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; gap: 8px; }
.login-logo { width: 72px; height: 72px; border-radius: 16px; }
.login h1 { margin: 0 0 16px; color: var(--ap-green); font-size: 24px; }
.login form { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 10px; }
.login input, .campo input, .campo select, .campo textarea { width: 100%; background: var(--ap-card); border: 1px solid var(--ap-border); color: var(--ap-text); padding: 12px; border-radius: var(--radius); font-size: 16px; }
.login button, .btn { background: var(--ap-green); color: var(--ap-bg-deep); border: 0; padding: 13px; border-radius: var(--radius); font-weight: 600; font-size: 15px; }
.btn.secundario { background: var(--ap-card); color: var(--ap-text); border: 1px solid var(--ap-border); }
.btn.peligro { background: var(--ap-red-dim); color: var(--ap-red); border: 1px solid var(--ap-red); }
.error { color: var(--ap-red); font-size: 13px; margin: 0; }

.mapa { position: absolute; inset: 0; background: #171D1A; }
.leaflet-container { background: #171D1A; font-family: var(--ap-font); }
.chip-flotante { position: absolute; z-index: 500; top: 10px; left: 10px; display: flex; gap: 6px; }
.pill { display: inline-block; font-size: 11px; padding: 3px 9px; border-radius: 20px; font-weight: 600; background: var(--ap-card); color: var(--ap-muted); border: 1px solid var(--ap-border-soft); }
.pill.ok { background: var(--ap-green-dim); color: var(--ap-green); }
.pill.warn { background: var(--ap-yellow-dim); color: var(--ap-yellow); }
.pill.err { background: var(--ap-red-dim); color: var(--ap-red); }

.sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 600; background: var(--ap-bg); border-top: 1px solid var(--ap-border); border-radius: 14px 14px 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,.4); transition: transform .25s ease; display: flex; flex-direction: column; max-height: 85%; }
.sheet .handle { width: 36px; height: 4px; background: var(--ap-border); border-radius: 3px; margin: 8px auto; flex: none; }
.sheet .cuerpo { overflow-y: auto; flex: 1; min-height: 0; }

.lista { padding: 0; margin: 0; list-style: none; }
.fila { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--ap-border-soft); background: none; border-left: 0; border-right: 0; border-top: 0; width: 100%; text-align: left; color: inherit; }
.fila .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--ap-muted-2); }
.fila .dot.ok { background: var(--ap-green); } .fila .dot.warn { background: var(--ap-yellow); } .fila .dot.err { background: var(--ap-red); } .fila .dot.info { background: var(--ap-blue); }
.fila .txt { flex: 1; min-width: 0; }
.fila .txt b { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fila .txt span { font-size: 12px; color: var(--ap-muted); }
.fila .val { font-size: 12px; color: var(--ap-muted); font-weight: 600; white-space: nowrap; }

.card { background: var(--ap-card); border: 1px solid var(--ap-border-soft); border-radius: var(--radius); padding: 12px 14px; margin: 10px 12px; }
.card h3 { margin: 0 0 4px; font-size: 15px; }
.card p { margin: 0; font-size: 13px; color: var(--ap-muted); line-height: 1.45; }
.titulo-seccion { font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: var(--ap-muted-2); margin: 14px 14px 6px; }
.vacio { padding: 40px 24px; text-align: center; color: var(--ap-muted); font-size: 14px; }
.campo { margin: 10px 12px; } .campo label { display: block; font-size: 12px; color: var(--ap-muted); margin-bottom: 4px; }
.fab { position: absolute; right: 16px; bottom: 16px; width: 52px; height: 52px; border-radius: 50%; background: var(--ap-green); color: var(--ap-bg-deep); border: 0; font-size: 28px; box-shadow: 0 4px 14px var(--ap-green-glow); z-index: 10; }
.mini-mapa { height: 200px; border-radius: var(--radius); overflow: hidden; margin: 10px 12px; border: 1px solid var(--ap-border-soft); }

.toasts { position: fixed; left: 12px; right: 12px; bottom: calc(70px + env(safe-area-inset-bottom)); z-index: 1000; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.toast { background: var(--ap-card); border: 1px solid var(--ap-border); color: var(--ap-text); padding: 10px 14px; border-radius: var(--radius); font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.4); }
.toast.ok { border-color: var(--ap-green); } .toast.error { border-color: var(--ap-red); }

.marcador-maquina { width: 16px; height: 16px; border-radius: 50%; background: var(--ap-green); border: 2px solid var(--ap-bg-deep); box-shadow: 0 0 0 4px var(--ap-green-glow); }
.marcador-maquina.viejo { background: var(--ap-yellow); box-shadow: 0 0 0 4px var(--ap-yellow-dim); }
```

- [ ] **Paso 3: `app/ui/toast.js`, `app/ui/sheet.js`, `app/ui/nav.js`**

`app/ui/toast.js`:
```js
// toast.js — Aviso efímero abajo de la pantalla.
export function toast(msg, tipo = "info", ms = 2800) {
  const cont = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  cont.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
```

`app/ui/sheet.js`:
```js
// sheet.js — Panel inferior arrastrable (mapa protagonista). Tres alturas:
// min (solo el resumen), medio (lista), max (casi todo). Se arrastra desde
// el handle o el encabezado; un toque en el handle alterna min/medio.
const ALTURAS = { min: 0.22, medio: 0.48, max: 0.85 };

export function crearSheet(el) {
  let nivel = "medio";
  let y0 = null, h0 = 0;
  const cont = el.parentElement;

  function aplicar() {
    const h = Math.round(cont.clientHeight * ALTURAS[nivel]);
    el.style.height = h + "px";
    el.style.transform = "";
  }
  function setAltura(n) { nivel = n; aplicar(); }

  const handle = el.querySelector(".handle");
  handle.addEventListener("click", () => setAltura(nivel === "min" ? "medio" : "min"));
  const inicio = (e) => { y0 = (e.touches?.[0] ?? e).clientY; h0 = el.clientHeight; el.style.transition = "none"; };
  const mover = (e) => {
    if (y0 === null) return;
    const y = (e.touches?.[0] ?? e).clientY;
    const h = Math.max(60, Math.min(cont.clientHeight * ALTURAS.max, h0 + (y0 - y)));
    el.style.height = h + "px";
  };
  const fin = () => {
    if (y0 === null) return;
    el.style.transition = "";
    const frac = el.clientHeight / cont.clientHeight;
    nivel = frac < 0.33 ? "min" : frac < 0.65 ? "medio" : "max";
    y0 = null; aplicar();
  };
  handle.addEventListener("touchstart", inicio, { passive: true });
  el.addEventListener("touchmove", mover, { passive: true });
  el.addEventListener("touchend", fin);
  window.addEventListener("resize", aplicar);
  aplicar();
  return { setAltura, abrir: () => setAltura("medio"), cerrar: () => setAltura("min") };
}
```

`app/ui/nav.js`:
```js
// nav.js — Barra de pestañas (según permisos), franja de estado offline y
// badge de alertas.
import { haceCuanto } from "../core/fecha.js";

const ICONOS = { mapa: "🗺️", lotes: "🌾", lluvias: "🌧️", alertas: "🔔", equipos: "📡" };
const ROTULOS = { mapa: "Mapa", lotes: "Lotes", lluvias: "Lluvias", alertas: "Alertas", equipos: "Equipos" };

export function crearNav({ pestanas, onIr }) {
  const nav = document.getElementById("nav");
  const franja = document.getElementById("franja");
  nav.innerHTML = "";
  const btns = {};
  for (const p of pestanas) {
    const b = document.createElement("button");
    b.innerHTML = `<i>${ICONOS[p]}</i>${ROTULOS[p]}`;
    b.addEventListener("click", () => onIr(p));
    nav.appendChild(b); btns[p] = b;
  }
  nav.hidden = false;
  return {
    pestanaActiva(nombre) { for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === nombre); },
    setOffline(esta, ts) {
      franja.hidden = !esta;
      franja.className = "franja";
      if (esta) franja.textContent = ts ? `Sin conexión · datos de ${haceCuanto(ts)}` : "Sin conexión";
    },
    setAviso(texto, tipo = "") { franja.hidden = !texto; franja.className = `franja ${tipo}`; if (texto) franja.textContent = texto; },
    setBadge(pestana, n) {
      const b = btns[pestana]; if (!b) return;
      b.querySelector(".badge")?.remove();
      if (n > 0) { const s = document.createElement("span"); s.className = "badge"; s.textContent = n > 99 ? "99+" : n; b.appendChild(s); }
    },
  };
}
```

- [ ] **Paso 4: `app/core/socket.js`**

```js
// socket.js — Conexión socket.io autenticada con el JWT. El server une
// automáticamente al room estab:<slug> del token; no hay que pedir nada.
export function conectarSocket({ token, onPosicion, onEstado = () => {} }) {
  if (!globalThis.io) { console.warn("[socket] socket.io-client no cargó"); return null; }
  const s = globalThis.io("/", { auth: { token }, transports: ["websocket", "polling"], reconnectionDelayMax: 10000 });
  s.on("connect",    () => onEstado("conectado"));
  s.on("disconnect", () => onEstado("desconectado"));
  s.on("connect_error", (e) => { console.warn("[socket]", e.message); onEstado("error"); });
  s.on("tracking:position", (p) => onPosicion(p));
  return s;
}
```

- [ ] **Paso 5: `app/main.js`**

```js
// main.js — Bootstrap de la app: sesión → permisos → nav → router por hash.
// Las pantallas se cargan bajo demanda desde pantallas/<nombre>.js y reciben
// un ctx común. Registra el service worker y maneja el aviso de versión nueva.
import { crearStore, idbBackend } from "./core/store.js";
import { crearApi, ErrorHttp } from "./core/api.js";
import { crearAuth } from "./core/auth.js";
import { crearSync } from "./core/sync.js";
import { pestanasPara } from "./core/permisos.js";
import { conectarSocket } from "./core/socket.js";
import { crearNav } from "./ui/nav.js";
import { toast } from "./ui/toast.js";

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
$("btn-salir").addEventListener("click", () => { if (confirm("¿Cerrar sesión?")) { ctx?.socket?.disconnect(); auth.logout(); mostrarLogin(); } });
$("btn-org").addEventListener("click", elegirOrg);

async function elegirOrg() {
  const u = auth.usuario(); const ms = u?.memberships || [];
  if (ms.length < 2) return;
  const opciones = ms.map((m, i) => `${i + 1}) ${m.orgNombre || m.orgSlug}`).join("\n");
  const r = prompt(`Elegí establecimiento:\n${opciones}`, "1");
  const m = ms[parseInt(r, 10) - 1]; if (!m) return;
  try { await auth.cambiarOrg(m.orgSlug); location.reload(); } catch (e) { toast(e.message, "error"); }
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
  $("org-nombre").textContent = (usuario.memberships || []).find(m => m.orgSlug === usuario.org_activa)?.orgNombre || usuario.org_activa || "Sin establecimiento";

  nav = crearNav({ pestanas: pestanasPara(rol), onIr: (p) => { location.hash = `#/${p}`; } });
  const socket = conectarSocket({ token: auth.token(), onPosicion: (p) => ctx.onPosicion?.(p), onEstado: (s) => { if (s === "conectado") nav.setOffline(false); } });
  ctx = { api, store, auth, sync, usuario, rol, toast, socket, nav, onPosicion: null };

  window.addEventListener("hashchange", enrutar);
  window.addEventListener("online",  () => { nav.setOffline(false); enrutar(); });
  window.addEventListener("offline", () => nav.setOffline(true));
  if (!navigator.onLine) nav.setOffline(true);
  sync.drenar();
  await enrutar();
}

async function enrutar() {
  const partes  = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const pestana = partes[0] || "mapa";
  const param   = partes[1] ? decodeURIComponent(partes[1]) : undefined;
  const permitidas = pestanasPara(ctx.rol);
  const destino = permitidas.includes(pestana) ? pestana : "mapa";
  if (destino !== pestana) { location.hash = `#/${destino}`; return; }
  actual?.desmontar?.(); ctx.onPosicion = null;
  const root = $("pantalla"); root.innerHTML = ""; root.className = "pantalla";
  nav.pestanaActiva(destino);
  try {
    const mod = await import(`./pantallas/${destino}.js`);
    actual = await mod.montar(ctx, root, param);
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="vacio">No se pudo abrir esta pantalla.<br><small>${e.message}</small></div>`;
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
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
  $("btn-actualizar").addEventListener("click", () => navigator.serviceWorker.getRegistration().then(r => r?.waiting?.postMessage("SKIP_WAITING")));
}

if (auth.token()) arrancar(); else mostrarLogin();
```

- [ ] **Paso 6: `app/sw.js`**

```js
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
  "/app/ui/nav.js", "/app/ui/sheet.js", "/app/ui/toast.js",
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
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/") || url.pathname === VERSION_URL) return;
  if (url.origin !== location.origin) return; // tiles del mapa: nunca se cachean acá
  ev.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(ev.request, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(ev.request);
      if (res.ok && url.pathname.startsWith("/app/")) c.put(ev.request, res.clone());
      return res;
    } catch {
      if (ev.request.mode === "navigate") return (await c.match("/app/index.html")) || Response.error();
      return Response.error();
    }
  })());
});

// Push: se completa en la Tarea 14.
```

- [ ] **Paso 7: Pantallas placeholder para que el router no rompa**

Crear `app/pantallas/mapa.js`, `lotes.js`, `lluvias.js`, `alertas.js`, `equipos.js` con este contenido (cada uno con su nombre):
```js
export async function montar(ctx, root) {
  root.innerHTML = `<div class="vacio">Pantalla <b>NOMBRE</b> — en construcción</div>`;
  return { desmontar() {} };
}
```
Y `app/core/push.js` vacío por ahora:
```js
// push.js — se implementa en la Tarea 14.
export async function suscribirPush() { return { ok: false, motivo: "no implementado" }; }
```

- [ ] **Paso 8: Verificación manual**

1. `node server.js`; abrir `http://localhost:PUERTO/app/` en Chrome con DevTools → Toggle device toolbar (iPhone 13).
2. Loguearse con un usuario real. Debe aparecer la topbar con el nombre del establecimiento y la nav con las pestañas según rol (probar con un `viewer`: sin Equipos).
3. Tocar cada pestaña: cambia el hash y el placeholder. Escribir a mano `#/equipos` con un viewer → redirige a `#/mapa`.
4. DevTools → Application → Service Workers: registrado, `Status: activated`. Cache Storage: `orbitx-app-20260922-01` con los archivos del shell.
5. Network → Offline. Recargar: la app abre (shell desde cache), franja "Sin conexión".
6. Cambiar `app/version.json` a `20260922-02`, volver a Online, cambiar de pestaña de la ventana y volver: aparece el botón ⟳. Tocarlo → recarga con la versión nueva (Cache Storage muestra solo `-02`).
7. Lighthouse → PWA: "Installable" en verde.

- [ ] **Paso 9: Commit**

```bash
git add app/index.html app/app.css app/main.js app/sw.js app/ui/ app/core/socket.js app/core/push.js app/pantallas/
git commit -m "feat(app): shell PWA con login, nav por permisos, router por hash y service worker"
```

---

### Tarea 8: Pantalla Mapa — máquinas en vivo y lotes

**Archivos:**
- Modify: `app/pantallas/mapa.js` (reemplaza el placeholder)

**Interfaces:**
- Consume: `ctx.api.get("/api/tracking/live")`, `ctx.api.get("/api/lotes")`, `ctx.onPosicion` (setea el handler para `tracking:position`), `crearSheet`, `haceCuanto`.
- Produce: nada para otras tareas.

- [ ] **Paso 1: Implementar**

`app/pantallas/mapa.js`:
```js
// mapa.js — Mapa a pantalla completa con las máquinas en vivo y los límites
// de los lotes. Arranca con /api/tracking/live (últimos 5 min) y después se
// actualiza por socket. Sin señal: lotes y últimas posiciones desde cache
// sobre fondo liso (los tiles no se cachean, ver spec).
import { crearSheet } from "../ui/sheet.js";
import { haceCuanto } from "../core/fecha.js";

const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const VIEJO_MS = 2 * 60 * 1000; // sin dato hace >2 min → marcador amarillo (mismo criterio que devices.js:254)

export async function montar(ctx, root) {
  root.innerHTML = `
    <div id="mapa" class="mapa"></div>
    <div class="chip-flotante" id="chips"></div>
    <div class="sheet" id="sheet"><div class="handle"></div><div class="cuerpo"><ul class="lista" id="lista-maq"></ul></div></div>`;

  const mapa = L.map("mapa", { zoomControl: false, attributionControl: false }).setView([-34.6, -60.9], 7);
  L.tileLayer(TILES, { maxZoom: 18 }).addTo(mapa);
  const capaLotes = L.layerGroup().addTo(mapa);
  const marcadores = new Map(); // device_id → { marker, datos }
  const sheet = crearSheet(root.querySelector("#sheet"));
  let timer = null, primerEncuadre = true;

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
  function pintarLista() {
    const ul = root.querySelector("#lista-maq"); ul.innerHTML = "";
    const items = [...marcadores.values()].map(m => m.datos).sort((a, b) => b.ts - a.ts);
    let activas = 0, viejas = 0;
    for (const d of items) {
      const viejo = Date.now() - d.ts > VIEJO_MS; viejo ? viejas++ : activas++;
      const li = document.createElement("li");
      li.innerHTML = `<button class="fila"><span class="dot ${viejo ? "warn" : "ok"}"></span>
        <span class="txt"><b>${d.nombre || d.device_id}</b><span>${d.field ? "Lote " + d.field + " · " : ""}${(d.speed ?? 0).toFixed(1)} km/h</span></span>
        <span class="val">${haceCuanto(d.ts)}</span></button>`;
      li.querySelector("button").addEventListener("click", () => { mapa.setView([d.lat, d.lon], 16); sheet.cerrar(); });
      ul.appendChild(li);
    }
    if (!items.length) ul.innerHTML = `<li class="vacio">Ninguna máquina reportó en los últimos 5 minutos.</li>`;
    root.querySelector("#chips").innerHTML = `<span class="pill ok">${activas} activas</span>${viejas ? `<span class="pill warn">${viejas} sin dato</span>` : ""}`;
  }
  async function cargar() {
    try {
      const [live, lotes] = await Promise.all([ctx.api.get("/api/tracking/live"), ctx.api.get("/api/lotes")]);
      ctx.nav.setOffline(live.desdeCache, live.ts);
      for (const d of live.data) upsertMaquina(d);
      capaLotes.clearLayers();
      const bounds = [];
      for (const l of lotes.data) if (Array.isArray(l.boundary) && l.boundary.length > 2) {
        L.polygon(l.boundary, { color: "#A4BA3E", weight: 1.5, fillOpacity: 0.08 }).bindTooltip(l.nombre, { permanent: false }).addTo(capaLotes);
        bounds.push(...l.boundary);
      }
      for (const m of marcadores.values()) bounds.push(m.marker.getLatLng());
      if (primerEncuadre && bounds.length) { mapa.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 }); primerEncuadre = false; }
      pintarLista();
    } catch (e) { ctx.toast(e.message, "error"); }
  }

  ctx.onPosicion = (p) => { upsertMaquina({ ...p, nombre: marcadores.get(p.device_id)?.datos.nombre }); pintarLista(); };
  await cargar();
  timer = setInterval(() => { if (!ctx.socket?.connected) cargar(); else pintarLista(); }, 30000); // sin socket → polling; con socket → solo refresca "hace X"

  return { desmontar() { clearInterval(timer); ctx.onPosicion = null; mapa.remove(); } };
}
```

- [ ] **Paso 2: Verificación manual**

1. Abrir `#/mapa` con una org que tenga tracking activo (o publicar una posición de prueba con un device token: `POST /api/tracking/position`).
2. Ver el marcador verde, el lote dibujado y la fila en el sheet. Arrastrar el sheet: sube y baja en tres alturas; tocar una fila centra el mapa.
3. Publicar otra posición → el marcador se mueve sin recargar (socket).
4. Network → Offline y recargar: aparece la franja "Sin conexión · datos de hace X", los lotes y marcadores siguen, el fondo queda liso.

- [ ] **Paso 3: Commit**

```bash
git add app/pantallas/mapa.js
git commit -m "feat(app): pantalla Mapa con máquinas en vivo por socket y lotes"
```

---

### Tarea 9: Pantalla Equipos

**Archivos:**
- Modify: `app/pantallas/equipos.js`

**Interfaces:**
- Consume: `ctx.api.get("/api/devices")` → `[{ device_id, hostname, ultimo_visto, online, version, estab_slug }]`.

- [ ] **Paso 1: Implementar**

`app/pantallas/equipos.js`:
```js
// equipos.js — Estado de los dispositivos de la org. "online" lo decide el
// server (ultimo_visto < 2 min); acá solo se muestra.
import { haceCuanto } from "../core/fecha.js";

export async function montar(ctx, root) {
  root.classList.add("scroll");
  async function cargar() {
    let r;
    try { r = await ctx.api.get("/api/devices"); } catch (e) { root.innerHTML = `<div class="vacio">${e.message}</div>`; return; }
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const eq = [...r.data].sort((a, b) => (b.online - a.online) || ((b.ultimo_visto || 0) - (a.ultimo_visto || 0)));
    const on = eq.filter(d => d.online).length;
    root.innerHTML = `
      <div class="titulo-seccion">${on} en línea · ${eq.length - on} sin reportar</div>
      <ul class="lista">${eq.map(d => `
        <li class="fila">
          <span class="dot ${d.online ? "ok" : (d.ultimo_visto ? "warn" : "")}"></span>
          <span class="txt"><b>${d.hostname || d.device_id}</b><span>${d.version ? "v" + d.version + " · " : ""}${d.ultimo_visto ? "visto " + haceCuanto(d.ultimo_visto) : "nunca reportó"}</span></span>
          <span class="val">${d.online ? "en línea" : "—"}</span>
        </li>`).join("")}</ul>
      ${eq.length ? "" : `<div class="vacio">No hay equipos asignados a este establecimiento.</div>`}`;
  }
  await cargar();
  const timer = setInterval(cargar, 60000);
  return { desmontar() { clearInterval(timer); } };
}
```

- [ ] **Paso 2: Verificación manual**

Con un `owner`: la lista muestra los equipos de la org, los que hicieron heartbeat hace <2 min en verde. Con un `viewer`: la pestaña no existe y `#/equipos` redirige a mapa.

- [ ] **Paso 3: Commit**

```bash
git add app/pantallas/equipos.js
git commit -m "feat(app): pantalla Equipos con estado en línea"
```

---

### Tarea 10: Pantalla Lotes (lista + detalle)

**Archivos:**
- Modify: `app/pantallas/lotes.js`

**Interfaces:**
- Consume: `ctx.api.get("/api/lotes")`, `ctx.api.get("/api/lotes/<id>")`, `ctx.api.get("/api/lluvias?lote=<nombre>")` → `{ registros }`. Router pasa `param` = id del lote para `#/lotes/<id>`.

- [ ] **Paso 1: Implementar**

`app/pantallas/lotes.js`:
```js
// lotes.js — Lista de lotes de la org y detalle con mini mapa del límite y
// las últimas lluvias registradas en ese lote.
import { fechaCorta } from "../core/fecha.js";

export async function montar(ctx, root, id) {
  root.classList.add("scroll");
  return id ? detalle(ctx, root, id) : lista(ctx, root);
}

async function lista(ctx, root) {
  let r;
  try { r = await ctx.api.get("/api/lotes"); } catch (e) { root.innerHTML = `<div class="vacio">${e.message}</div>`; return { desmontar() {} }; }
  ctx.nav.setOffline(r.desdeCache, r.ts);
  root.innerHTML = r.data.length ? `<ul class="lista">${r.data.map(l => `
    <li><a class="fila" href="#/lotes/${encodeURIComponent(l._id)}" style="text-decoration:none">
      <span class="dot ${l.fecha_fin ? "" : "ok"}"></span>
      <span class="txt"><b>${l.nombre || l._id}</b><span>${l.cultivo || "sin cultivo"}${l.fecha_inicio ? " · " + fechaCorta(l.fecha_inicio) : ""}</span></span>
      <span class="val">${Array.isArray(l.boundary) ? "▸" : "sin límite"}</span>
    </a></li>`).join("")}</ul>` : `<div class="vacio">Todavía no hay lotes sincronizados desde PilotX.</div>`;
  return { desmontar() {} };
}

async function detalle(ctx, root, id) {
  let r, mapa = null;
  try { r = await ctx.api.get(`/api/lotes/${encodeURIComponent(id)}`); } catch (e) { root.innerHTML = `<div class="vacio">${e.message}</div>`; return { desmontar() {} }; }
  const l = r.data;
  ctx.nav.setOffline(r.desdeCache, r.ts);
  root.innerHTML = `
    <div class="card"><a href="#/lotes" style="color:var(--ap-muted);font-size:13px;text-decoration:none">‹ Lotes</a>
      <h3>${l.nombre || id}</h3><p>${l.cultivo || "sin cultivo"}${l.fecha_inicio ? " · desde " + fechaCorta(l.fecha_inicio) : ""}${l.fecha_fin ? " · hasta " + fechaCorta(l.fecha_fin) : " · en curso"}</p></div>
    ${Array.isArray(l.boundary) && l.boundary.length > 2 ? `<div class="mini-mapa" id="mini"></div>` : `<div class="card"><p>Este lote no tiene límite dibujado.</p></div>`}
    <div class="titulo-seccion">Lluvias en este lote</div><ul class="lista" id="lluvias-lote"><li class="vacio">Cargando…</li></ul>`;
  if (root.querySelector("#mini")) {
    mapa = L.map("mini", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}").addTo(mapa);
    const poly = L.polygon(l.boundary, { color: "#A4BA3E", weight: 2, fillOpacity: 0.12 }).addTo(mapa);
    mapa.fitBounds(poly.getBounds(), { padding: [10, 10] });
  }
  try {
    const ll = await ctx.api.get(`/api/lluvias?lote=${encodeURIComponent(l.nombre || "")}`);
    const regs = (ll.data.registros || []).slice(0, 10);
    root.querySelector("#lluvias-lote").innerHTML = regs.length ? regs.map(x => `<li class="fila"><span class="dot info"></span><span class="txt"><b>${x.mm} mm</b><span>${x.fecha}${x.nota ? " · " + x.nota : ""}</span></span></li>`).join("") : `<li class="vacio">Sin lluvias registradas.</li>`;
  } catch { root.querySelector("#lluvias-lote").innerHTML = `<li class="vacio">Sin conexión para traer lluvias.</li>`; }
  return { desmontar() { mapa?.remove(); } };
}
```

- [ ] **Paso 2: Verificación manual**

Lista con los lotes de la org; tocar uno abre el detalle con el polígono y las lluvias filtradas por nombre; "‹ Lotes" vuelve. Offline: ambas vistas salen del cache si ya se visitaron.

- [ ] **Paso 3: Commit**

```bash
git add app/pantallas/lotes.js
git commit -m "feat(app): pantalla Lotes con lista, detalle y mini mapa"
```

---

### Tarea 11: Pantalla Alertas

**Archivos:**
- Modify: `app/pantallas/alertas.js`

**Interfaces:**
- Consume: `ctx.api.get("/api/alertas")` (activas) y `ctx.api.get("/api/alertas/historial?limit=50")` → `[{ _id, nivel, ts_inicio, mensaje, resuelta }]`; `ctx.nav.setBadge("alertas", n)`.

- [ ] **Paso 1: Implementar**

`app/pantallas/alertas.js`:
```js
// alertas.js — Alertas activas arriba, historial abajo. Solo lectura en Fase 1
// (el server no expone resolver por API todavía).
import { fechaCorta, haceCuanto } from "../core/fecha.js";

const COLOR = { critico: "err", critica: "err", alto: "err", alta: "err", medio: "warn", media: "warn", bajo: "info", baja: "info" };

function fila(a) {
  const c = COLOR[String(a.nivel || "").toLowerCase()] || "warn";
  return `<li class="fila"><span class="dot ${c}"></span>
    <span class="txt"><b>${a.mensaje || "Alerta"}</b><span>${a.nivel || ""}${a.lote ? " · " + a.lote : ""} · ${fechaCorta(a.ts_inicio)}</span></span>
    <span class="val">${a.resuelta ? "resuelta" : haceCuanto(a.ts_inicio)}</span></li>`;
}

export async function montar(ctx, root) {
  root.classList.add("scroll");
  async function cargar() {
    let act, hist;
    try { act = await ctx.api.get("/api/alertas"); } catch (e) { root.innerHTML = `<div class="vacio">${e.message}</div>`; return; }
    try { hist = await ctx.api.get("/api/alertas/historial?limit=50"); } catch { hist = { data: [] }; }
    ctx.nav.setOffline(act.desdeCache, act.ts);
    ctx.nav.setBadge("alertas", act.data.length);
    const activasIds = new Set(act.data.map(a => a._id));
    const pasadas = hist.data.filter(a => !activasIds.has(a._id));
    root.innerHTML = `
      <div class="titulo-seccion">Activas · ${act.data.length}</div>
      <ul class="lista">${act.data.length ? act.data.map(fila).join("") : `<li class="vacio">Sin alertas activas. 👌</li>`}</ul>
      <div class="titulo-seccion">Historial</div>
      <ul class="lista">${pasadas.length ? pasadas.map(fila).join("") : `<li class="vacio">Sin historial.</li>`}</ul>`;
  }
  await cargar();
  const timer = setInterval(cargar, 60000);
  return { desmontar() { clearInterval(timer); } };
}
```

- [ ] **Paso 2: Verificación manual**

Con una org con alertas: activas arriba con punto por nivel, historial abajo, badge rojo en la pestaña con el número de activas.

- [ ] **Paso 3: Commit**

```bash
git add app/pantallas/alertas.js
git commit -m "feat(app): pantalla Alertas con activas, historial y badge"
```

---

### Tarea 12: Pantalla Lluvias con carga offline

**Archivos:**
- Modify: `app/pantallas/lluvias.js`

**Interfaces:**
- Consume: `ctx.api.get("/api/lluvias")` → `{ registros, puede_editar }`; `ctx.api.post("/api/lluvias", { fecha, mm, lote, nota })`; `ctx.store.colaAgregar/colaListar`; `ctx.sync.drenar/reintentar`; `fechaISOHoy`.

- [ ] **Paso 1: Implementar**

`app/pantallas/lluvias.js`:
```js
// lluvias.js — Historial de lluvias y carga de un registro nuevo. Si no hay
// señal (o el POST falla por red), el registro va a la cola y se muestra
// como "pendiente"; sync.js lo manda al volver la conexión. El botón de
// carga se muestra según `puede_editar` que devuelve el server.
import { fechaISOHoy } from "../core/fecha.js";
import { ErrorHttp } from "../core/api.js";

export async function montar(ctx, root) {
  root.classList.add("scroll");
  let lotes = [];

  async function pendientes() { return (await ctx.store.colaListar()).filter(i => i.ruta === "/api/lluvias"); }

  async function cargar() {
    let r;
    try { r = await ctx.api.get("/api/lluvias"); } catch (e) { r = { data: { registros: [], puede_editar: false }, desdeCache: true, ts: null }; ctx.toast(e.message, "error"); }
    try { lotes = (await ctx.api.get("/api/lotes")).data; } catch { /* sin lotes no pasa nada */ }
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const pend = await pendientes();
    const regs = [...(r.data.registros || [])].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    root.innerHTML = `
      ${pend.length ? `<div class="titulo-seccion">Pendientes de enviar · ${pend.length}</div><ul class="lista">${pend.map(p => `
        <li class="fila"><span class="dot ${p.estado === "error" ? "err" : "warn"}"></span>
          <span class="txt"><b>${p.body.mm} mm</b><span>${p.body.fecha}${p.body.lote ? " · " + p.body.lote : ""}${p.estado === "error" ? " · " + (p.error || "error") : " · esperando conexión"}</span></span>
          ${p.estado === "error" ? `<button class="btn secundario" data-reintentar="${p.id}" style="padding:6px 10px;font-size:12px">Reintentar</button>` : ""}
        </li>`).join("")}</ul>` : ""}
      <div class="titulo-seccion">Registradas</div>
      <ul class="lista">${regs.length ? regs.map(x => `<li class="fila"><span class="dot info"></span><span class="txt"><b>${x.mm} mm</b><span>${x.fecha}${x.lote ? " · " + x.lote : ""}${x.nota ? " · " + x.nota : ""}</span></span></li>`).join("") : `<li class="vacio">Sin lluvias registradas.</li>`}</ul>
      ${r.data.puede_editar ? `<button class="fab" id="fab" title="Cargar lluvia">+</button>` : ""}`;
    root.querySelectorAll("[data-reintentar]").forEach(b => b.addEventListener("click", async () => { await ctx.sync.reintentar(b.dataset.reintentar); cargar(); }));
    root.querySelector("#fab")?.addEventListener("click", formulario);
  }

  function formulario() {
    const ops = lotes.map(l => `<option value="${l.nombre}">${l.nombre}</option>`).join("");
    root.insertAdjacentHTML("beforeend", `
      <div class="sheet" id="form-lluvia" style="height:auto;max-height:90%"><div class="handle"></div><div class="cuerpo">
        <form id="f">
          <div class="campo"><label>Fecha</label><input name="fecha" type="date" value="${fechaISOHoy()}" required></div>
          <div class="campo"><label>Milímetros</label><input name="mm" type="number" inputmode="decimal" step="0.1" min="0" max="1000" placeholder="0" required></div>
          <div class="campo"><label>Lote (opcional)</label><select name="lote"><option value="">Todo el establecimiento</option>${ops}</select></div>
          <div class="campo"><label>Nota (opcional)</label><input name="nota" maxlength="200"></div>
          <div class="campo" style="display:flex;gap:8px"><button type="button" class="btn secundario" id="cancelar" style="flex:1">Cancelar</button><button type="submit" class="btn" style="flex:2">Guardar</button></div>
        </form></div></div>`);
    const sheet = root.querySelector("#form-lluvia");
    sheet.querySelector("#cancelar").addEventListener("click", () => sheet.remove());
    sheet.querySelector("#f").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const body = { fecha: f.get("fecha"), mm: Number(f.get("mm")), lote: f.get("lote") || undefined, nota: f.get("nota") || undefined };
      try {
        await ctx.api.post("/api/lluvias", body);
        ctx.toast("Lluvia registrada", "ok");
      } catch (e) {
        if (e instanceof ErrorHttp) { ctx.toast(e.message, "error"); return; } // el server la rechazó: no encolar
        await ctx.store.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body });
        ctx.toast("Sin conexión: quedó pendiente y se envía sola", "ok");
      }
      sheet.remove(); cargar();
    });
  }

  await cargar();
  const alEnviar = () => cargar();
  window.addEventListener("online", alEnviar);
  return { desmontar() { window.removeEventListener("online", alEnviar); } };
}
```

- [ ] **Paso 2: Verificación manual**

1. Con un `owner`: aparece el FAB +; cargar 12 mm hoy → toast "Lluvia registrada", aparece en la lista.
2. Con un `viewer`: sin FAB.
3. Network → Offline; cargar 5 mm → toast "quedó pendiente", sección "Pendientes de enviar" con punto amarillo.
4. Volver a Online → en unos segundos toast "Registro pendiente enviado" y el registro pasa a "Registradas".
5. Forzar un rechazo (mm = -1 con el input editado en DevTools) → toast con "mm inválidos" y NO se encola.

- [ ] **Paso 3: Commit**

```bash
git add app/pantallas/lluvias.js
git commit -m "feat(app): pantalla Lluvias con carga offline y cola de pendientes"
```

---

### Tarea 13: Server — Web Push (VAPID), endpoint de suscripción, hook de alertas y cron de equipos caídos

**Archivos:**
- Create: `lib/push.js`, `tests/lib/push.test.mjs`
- Modify: `package.json` (dep `web-push`), `routes/auth.js` (después de `push-token`, ~línea 102), `services/couchdb.js:335-338` (`insertAlerta`), `server.js` (bloque CRON, ~línea 307), `.env.example` si existe (si no, documentar en el commit)

**Interfaces:**
- Produce: `lib/push.js` → `{ configurado() → bool, seleccionarCaidos(devices, ahora, umbralMs = 15*60*1000) → devices[], enviarAUsuarios(uidsDocIds, payload), notificarOrg(orgSlug, payload) }`. Payload: `{ titulo, cuerpo, url }`. Suscripciones en `usr_<id>.notificaciones.push_subs[]` (máx 5, dedupe por `endpoint`). Marca de episodio en el device: `caido_notificado_ts`.
- Env nuevas: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (ej. `mailto:info@agroparallel.com`).

- [ ] **Paso 1: Test que falla — selección de equipos caídos**

`tests/lib/push.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { seleccionarCaidos } from "../../lib/push.js";

const MIN = 60_000;
const ahora = 1_800_000_000_000;

test("selecciona los que no reportan hace más de 15 min y aún no fueron notificados en este episodio", () => {
  const devs = [
    { device_id: "a", ultimo_visto: ahora - 20 * MIN },                                     // caído, nunca notificado → sí
    { device_id: "b", ultimo_visto: ahora - 5 * MIN },                                      // reciente → no
    { device_id: "c", ultimo_visto: ahora - 40 * MIN, caido_notificado_ts: ahora - 20 * MIN }, // ya notificado después del último heartbeat → no
    { device_id: "d", ultimo_visto: ahora - 20 * MIN, caido_notificado_ts: ahora - 60 * MIN }, // notificado ANTES del último heartbeat → episodio nuevo → sí
    { device_id: "e", ultimo_visto: null },                                                 // nunca reportó → no (no es una caída)
  ];
  assert.deepEqual(seleccionarCaidos(devs, ahora).map(d => d.device_id), ["a", "d"]);
});

test("respeta el umbral pasado por parámetro", () => {
  const devs = [{ device_id: "a", ultimo_visto: ahora - 3 * MIN }];
  assert.equal(seleccionarCaidos(devs, ahora, 2 * MIN).length, 1);
  assert.equal(seleccionarCaidos(devs, ahora, 5 * MIN).length, 0);
});
```

- [ ] **Paso 2: Correr para ver que falla**

Run: `npm test`
Expected: FAIL `Cannot find module .../lib/push.js` (o error de import ESM sobre CJS: ver paso 3, `lib/push.js` exporta con `module.exports` y Node lo importa igual como default+named).

- [ ] **Paso 3: Instalar `web-push` e implementar**

Run: `npm install web-push@^3.6.7`

`lib/push.js`:
```js
// push.js — Web Push (VAPID) para la app móvil. Best-effort siempre: si no
// hay claves configuradas o falla el envío, se loguea y se sigue. Las
// suscripciones viven en usr_<id>.notificaciones.push_subs (máx 5 por
// usuario, sin duplicar endpoint). Una suscripción que devuelve 404/410 se
// borra del usuario.
const webpush = require("web-push");

const PUB  = process.env.VAPID_PUBLIC_KEY  || "";
const PRIV = process.env.VAPID_PRIVATE_KEY || "";
const SUBJ = process.env.VAPID_SUBJECT     || "mailto:info@agroparallel.com";
let listo = false;
if (PUB && PRIV) { try { webpush.setVapidDetails(SUBJ, PUB, PRIV); listo = true; } catch (e) { console.warn("[push] VAPID inválido:", e.message); } }

function configurado() { return listo; }

// Puro y testeable: dispositivos que llevan más de `umbralMs` sin reportar y
// cuya última notificación (si hubo) es anterior al último heartbeat, o sea,
// un episodio nuevo. Los que nunca reportaron no cuentan como caída.
function seleccionarCaidos(devices, ahora = Date.now(), umbralMs = 15 * 60 * 1000) {
  return devices.filter(d =>
    typeof d.ultimo_visto === "number" &&
    ahora - d.ultimo_visto > umbralMs &&
    !(typeof d.caido_notificado_ts === "number" && d.caido_notificado_ts > d.ultimo_visto)
  );
}

async function enviarAUsuarios(uids, payload) {
  if (!listo || !uids.length) return { enviados: 0 };
  const db = require("../services/couchdb").getDB("global");
  let enviados = 0;
  for (const uid of uids) {
    let u; try { u = await db.get(uid); } catch { continue; }
    const subs = u.notificaciones?.push_subs || [];
    if (!subs.length) continue;
    const vivas = [];
    for (const s of subs) {
      try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); enviados++; vivas.push(s); }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) console.log("[push] suscripción vencida, se borra", uid); else { console.warn("[push]", uid, e.statusCode, e.message); vivas.push(s); } }
    }
    if (vivas.length !== subs.length) { try { await db.insert({ ...u, notificaciones: { ...u.notificaciones, push_subs: vivas }, updated_at: Date.now() }); } catch {} }
  }
  return { enviados };
}

async function notificarOrg(orgSlug, payload) {
  if (!listo) return { enviados: 0 };
  const { getMiembros } = require("../services/auth_service"); // lazy: evita ciclo couchdb→push→auth_service→couchdb
  const miembros = await getMiembros(orgSlug);
  return enviarAUsuarios(miembros.map(m => m.uid), payload);
}

module.exports = { configurado, seleccionarCaidos, enviarAUsuarios, notificarOrg, VAPID_PUBLIC_KEY: PUB };
```

`routes/auth.js`, agregar **después** del handler de `push-token` (mantenerlo intacto):
```js
// ── Web Push (app móvil) ────────────────────────────────
// Guarda la suscripción completa {endpoint, keys} que necesita web-push.
// Distinto de /push-token (strings de FCM/Expo), que se deja como está.
router.get("/push-public-key", (req, res) => {
  const { VAPID_PUBLIC_KEY, configurado } = require("../lib/push");
  res.json({ key: configurado() ? VAPID_PUBLIC_KEY : null });
});
router.post("/push-subscribe", required, async (req, res) => {
  try {
    const sub = req.body?.subscription;
    if (!sub || typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth)
      return res.status(400).json({ error: "subscription inválida" });
    const db   = req.app.locals.globalDB;
    const user = await db.get(`usr_${req.user.uid}`);
    const previas = (user.notificaciones?.push_subs || []).filter(s => s.endpoint !== sub.endpoint);
    const push_subs = [...previas, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: String(req.headers["user-agent"] || "").slice(0, 120), ts: Date.now() }].slice(-5);
    await db.insert({ ...user, notificaciones: { ...user.notificaciones, push_subs }, updated_at: Date.now() });
    res.json({ ok: true, total: push_subs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/push-unsubscribe", required, async (req, res) => {
  try {
    const endpoint = req.body?.endpoint;
    const db   = req.app.locals.globalDB;
    const user = await db.get(`usr_${req.user.uid}`);
    const push_subs = (user.notificaciones?.push_subs || []).filter(s => s.endpoint !== endpoint);
    await db.insert({ ...user, notificaciones: { ...user.notificaciones, push_subs }, updated_at: Date.now() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

`services/couchdb.js`, reemplazar `insertAlerta`:
```js
async function insertAlerta(slug, data) {
  const id = `alert_${Date.now()}_${data.bajada_id||0}`;
  const r  = await upsert(getDB(slug), id, { ...data, tipo:"alerta", synced_at:Date.now() });
  // Push a la app móvil, best-effort: nunca bloquea ni falla el sync.
  try {
    const push = require("../lib/push");
    if (push.configurado() && !data.resuelta)
      push.notificarOrg(slug, { titulo: `Alerta ${data.nivel || ""}`.trim(), cuerpo: data.mensaje || "Nueva alerta en el campo", url: "/app/#/alertas" })
          .catch(e => console.warn("[push/alerta]", e.message));
  } catch (e) { console.warn("[push/alerta]", e.message); }
  return r;
}
```

`server.js`, agregar en el bloque `// ── CRON` (después del cron de las 19:00):
```js
// Equipos caídos → push a la org, cada 5 min. Umbral 15 min (no 2: un bache
// de señal en el campo no merece notificación). Una vez por episodio: se
// marca caido_notificado_ts en el device y no se repite hasta que vuelva a
// reportar y se caiga de nuevo.
cron.schedule("*/5 * * * *", async () => {
  const push = require("./lib/push");
  if (!push.configurado()) return;
  try {
    const globalDB = db.getDB("global");
    const r = await globalDB.find({ selector: { tipo: "device", estab_slug: { $gt: null } }, limit: 500 });
    const ahora = Date.now();
    for (const d of push.seleccionarCaidos(r.docs, ahora)) {
      const min = Math.round((ahora - d.ultimo_visto) / 60000);
      await push.notificarOrg(d.estab_slug, { titulo: "Equipo sin reportar", cuerpo: `${d.hostname || d.device_id} no reporta hace ${min} min`, url: "/app/#/equipos" });
      await globalDB.insert({ ...d, caido_notificado_ts: ahora });
    }
  } catch (e) { console.error("[CRON/caidos]", e.message); }
}, { timezone: "America/Argentina/Cordoba" });
```

Generar claves VAPID una sola vez (local) y guardarlas en el `.env` del droplet:
```bash
npx web-push generate-vapid-keys
```
Agregar al `.env` (NO commitear): `VAPID_PUBLIC_KEY=...`, `VAPID_PRIVATE_KEY=...`, `VAPID_SUBJECT=mailto:info@agroparallel.com`.

- [ ] **Paso 4: Correr tests**

Run: `npm test`
Expected: `# pass 30`

Run: `node server.js` → sin errores de require. `curl -s localhost:PUERTO/api/auth/push-public-key` → `{"key":"B..."}` (o `null` si el `.env` local no tiene claves).

- [ ] **Paso 5: Commit**

```bash
git add lib/push.js tests/lib/push.test.mjs routes/auth.js services/couchdb.js server.js package.json package-lock.json
git commit -m "feat(push): Web Push VAPID — suscripción, push por alerta nueva y cron de equipos caídos"
```

---

### Tarea 14: Cliente — suscripción push, handler en el SW y detección de iOS

**Archivos:**
- Modify: `app/core/push.js`, `app/sw.js` (agregar handlers), `app/pantallas/alertas.js` (tarjeta de activación), `app/main.js` (una línea)

**Interfaces:**
- Consume: `GET /api/auth/push-public-key`, `POST /api/auth/push-subscribe`, `POST /api/auth/push-unsubscribe` (T13).
- Produce: `estadoPush() → { soportado, instalada, esIOS, permiso, suscripto }`, `suscribirPush(api) → { ok, motivo? }`, `desuscribirPush(api)`.

- [ ] **Paso 1: `app/core/push.js`**

```js
// push.js — Suscripción Web Push desde el cliente. En iOS solo funciona si la
// app está instalada en la pantalla de inicio (iOS 16.4+): se detecta con
// display-mode standalone y se explica en vez de fallar callado.
function b64aUint8(b64) {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export function estadoPush() {
  const esIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const instalada = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const soportado = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { soportado, instalada, esIOS, permiso: soportado ? Notification.permission : "unsupported" };
}

export async function suscripcionActual() {
  const reg = await navigator.serviceWorker?.ready;
  return reg?.pushManager.getSubscription() ?? null;
}

export async function suscribirPush(api) {
  const st = estadoPush();
  if (!st.soportado) return { ok: false, motivo: "Este navegador no soporta notificaciones." };
  if (st.esIOS && !st.instalada) return { ok: false, motivo: "En iPhone, primero instalá la app: Compartir → Agregar a pantalla de inicio." };
  const { data } = await api.get("/api/auth/push-public-key");
  if (!data?.key) return { ok: false, motivo: "El servidor no tiene push configurado." };
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") return { ok: false, motivo: "No diste permiso de notificaciones." };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aUint8(data.key) });
  await api.post("/api/auth/push-subscribe", { subscription: sub.toJSON() });
  return { ok: true };
}

export async function desuscribirPush(api) {
  const sub = await suscripcionActual();
  if (!sub) return;
  await api.post("/api/auth/push-unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
```

- [ ] **Paso 2: Handlers en `app/sw.js`** (reemplazar el comentario final)

```js
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
```

- [ ] **Paso 3: Tarjeta de activación en `app/pantallas/alertas.js`**

Agregar al inicio de `montar`, antes de `cargar()`:
```js
import { estadoPush, suscribirPush, desuscribirPush, suscripcionActual } from "../core/push.js";
// ...
async function tarjetaPush() {
  const st = estadoPush();
  const sub = st.soportado ? await suscripcionActual() : null;
  const texto = sub ? "Notificaciones activadas en este teléfono."
    : st.esIOS && !st.instalada ? "Para recibir alertas en iPhone, instalá la app: Compartir → Agregar a pantalla de inicio."
    : "Recibí las alertas y los equipos caídos como notificación.";
  return `<div class="card" id="card-push"><h3>Notificaciones</h3><p>${texto}</p>
    ${st.soportado && !(st.esIOS && !st.instalada) ? `<button class="btn ${sub ? "secundario" : ""}" id="btn-push" style="margin-top:10px;width:100%">${sub ? "Desactivar" : "Activar notificaciones"}</button>` : ""}</div>`;
}
```
y en `cargar()`, anteponer `await tarjetaPush()` al `root.innerHTML` y enganchar:
```js
root.querySelector("#btn-push")?.addEventListener("click", async (ev) => {
  ev.target.disabled = true;
  try {
    if (await suscripcionActual()) { await desuscribirPush(ctx.api); ctx.toast("Notificaciones desactivadas", "ok"); }
    else { const r = await suscribirPush(ctx.api); ctx.toast(r.ok ? "Notificaciones activadas" : r.motivo, r.ok ? "ok" : "error"); }
  } catch (e) { ctx.toast(e.message, "error"); }
  cargar();
});
```

- [ ] **Paso 4: Verificación manual**

1. Chrome desktop: `#/alertas` → "Activar notificaciones" → aceptar permiso → toast "activadas". En CouchDB, `usr_<id>.notificaciones.push_subs` tiene 1 entrada.
2. Provocar una alerta (sync desde PilotX o `POST /api/sync` con un doc `tipo:"alerta"` de prueba) → llega la notificación; al tocarla abre `/app/#/alertas`.
3. Detener el heartbeat de un device y esperar hasta 20 min → llega "Equipo sin reportar"; el device queda con `caido_notificado_ts`; en los 5 min siguientes NO se repite.
4. Android real (Chrome, instalada): igual que 1–2.
5. iPhone real: desde Safari sin instalar, la tarjeta muestra la instrucción y no hay botón; instalada en pantalla de inicio (iOS ≥ 16.4), el botón aparece y la notificación llega.

- [ ] **Paso 5: Commit**

```bash
git add app/core/push.js app/sw.js app/pantallas/alertas.js
git commit -m "feat(app): suscripción Web Push con detección de iOS y handlers en el service worker"
```

---

### Tarea 15: Deploy al droplet y verificación en dispositivos reales

**Archivos:** ninguno nuevo. Despliega lo commiteado.

**Contexto del droplet (CLAUDE.md global):** app PM2 `OrbitX`, carpeta `/opt/AgroParallel/OrbitX`, 1 GB de RAM (no correr builds; acá no hay build). Subir con `scp`, nunca `git pull` de un repo con 30 archivos sucios sin revisarlo.

- [ ] **Paso 1: Subir archivos**

```bash
cd G:/AgroParallel/Productos/OrbitX/Software/App_PC/OrbitX-Server
scp -r app do:/opt/AgroParallel/OrbitX/
scp lib/push.js do:/opt/AgroParallel/OrbitX/lib/push.js
scp routes/auth.js do:/opt/AgroParallel/OrbitX/routes/auth.js
scp services/couchdb.js do:/opt/AgroParallel/OrbitX/services/couchdb.js
scp server.js package.json package-lock.json do:/opt/AgroParallel/OrbitX/
```
⚠️ Antes de subir `routes/auth.js`, `services/couchdb.js` y `server.js`, correr `ssh do "cd /opt/AgroParallel/OrbitX && md5sum routes/auth.js services/couchdb.js server.js"` y comparar con `git show HEAD~N:<archivo> | md5sum` de la versión base local: si el droplet tiene cambios que el repo local no, **parar y reconciliar** antes (mismo problema que apareció con el CRM el 2026-09-21).

- [ ] **Paso 2: Dependencia y claves**

```bash
ssh do "cd /opt/AgroParallel/OrbitX && npm install --omit=dev --no-audit --no-fund web-push@^3.6.7"
ssh do "grep -q VAPID_PUBLIC_KEY /opt/AgroParallel/OrbitX/.env || echo 'FALTA agregar VAPID_* al .env'"
```
Agregar las tres variables `VAPID_*` al `.env` del droplet (con el editor, no por chat).

- [ ] **Paso 3: Reiniciar y verificar**

```bash
ssh do "pm2 restart OrbitX --update-env && sleep 3 && pm2 logs OrbitX --lines 20 --nostream"
curl -s -o /dev/null -w "%{http_code}\n" https://orbitx.agroparallel.com/app/
curl -s https://orbitx.agroparallel.com/api/auth/push-public-key
curl -sI https://orbitx.agroparallel.com/app/sw.js | grep -i "cache-control"
```
Expected: `200`, `{"key":"B..."}`, `Cache-Control: no-cache, must-revalidate`. Sin `[router] ✕` ni errores de require en los logs.

- [ ] **Paso 4: Criterios de aceptación del spec, en dispositivos reales**

| # | Criterio | Cómo se verifica |
|---|---|---|
| 1 | Se instala en iPhone y Android y abre en pantalla completa con ícono | Safari → Compartir → Agregar a pantalla de inicio; Chrome → menú → Instalar app |
| 2 | Un cambio desplegado aparece sin reinstalar | Cambiar `version.json` + un texto visible, `scp`, abrir la app: botón ⟳, tocar, ver el cambio |
| 3 | Con modo avión abre y muestra últimos datos con antigüedad | Franja "Sin conexión · datos de hace X" en Mapa, Lotes, Lluvias, Alertas |
| 4 | Lluvia cargada en modo avión se envía sola al volver | Sección "Pendientes" → al quitar modo avión, toast "enviado" y pasa a "Registradas" |
| 5 | Máquinas se mueven en vivo | Con un PilotX reportando, el marcador se mueve sin recargar |
| 6 | Alerta nueva llega como push (Android; iPhone instalada) | Provocar alerta; la notificación aparece y abre `#/alertas` |
| 7 | `viewer` no ve Equipos; `operador` ve solo su dispositivo y lote activo | Loguear con cada rol |
| 8 | Equipos marca online < 2 min igual que el panel | Comparar la pestaña con `/dispositivos` del panel |

- [ ] **Paso 5: Cerrar**

Anotar en `docs/superpowers/specs/2026-09-21-orbitx-movil-pwa-fase1-design.md` el estado "EN VIVO <fecha>" y cualquier desvío encontrado en dispositivos reales. Commit:
```bash
git add docs/superpowers/specs/2026-09-21-orbitx-movil-pwa-fase1-design.md
git commit -m "docs: OrbitX móvil Fase 1 en vivo — resultado de la verificación en dispositivos"
```
