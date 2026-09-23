# OrbitX Sprint 1 · Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: `superpowers:subagent-driven-development`. Un implementador por tarea, revisión por tarea, revisión final de rama. Pasos con casillas.

**Objetivo:** Inicio con actividad, reporte por temporada imprimible, notificaciones por evento y canal, click en el mapa, releases públicas y menú en 4 secciones. Spec: `docs/superpowers/specs/2026-09-23-orbitx-sprint1-design.md`. Análisis con `archivo:línea`: `.superpowers/sdd/sprint1-analisis.md`.

**Arquitectura:** routers nuevos y aislados (`routes/actividad.js`, `routes/reportes.js`, `routes/ota_publico.js`) sobre los servicios existentes (`services/aog_parser.js:calcularStats`, `services/couchdb.js`, `lib/notify-org.js`), un servicio puro nuevo (`services/temporada.js`), vistas EJS nuevas fuera del layout donde son públicas, y ediciones mínimas por anclas en los archivos sucios.

**Stack:** Node 22 local / **Node 20 en prod**, Express 5, CouchDB (nano), EJS, socket.io, `node --test` (`npm test`, 44 tests hoy). Sin dependencias nuevas.

## Restricciones globales

- Castellano rioplatense en texto visible, comentarios, logs y commits. Trailer de commit obligatorio:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr
  ```
- Repo `G:\AgroParallel\Productos\OrbitX\Software\App_PC\OrbitX-Server`, rama `feature/sprint1-sistema`. **Nunca `git add -A` / `git add .` / `commit -a`.** Solo rutas explícitas.
- **Archivos sucios** (ediciones del dueño sin commitear, que SÍ corren en prod): `routes/panel.js`, `routes/aog.js`, `routes/lotes_maestro.js`, `routes/tracking.js`, `server.js`, `views/pages/mapa.ejs`, `views/partials/sidebar.ejs`, `views/partials/topbar.ejs`, `lib/firmware.js`, `public/js/tracking-mapa.js`, `routes/auth.js`, `routes/devices.js`. Si una tarea los toca: editar el archivo EN DISCO, entre marcadores de comentario únicos, y **NO stagearlos**; el controlador arma el commit por marcadores. Los demás archivos se commitean normal.
- Ningún `find` con `$in` sobre `tipo`; ningún `db.list({include_docs:true})` nuevo. Consultas por `tipo` + campo indexado (`ESTAB_INDEX_FIELDS` / `GLOBAL_INDEX_FIELDS` en `services/couchdb.js:184-240`).
- Hay un `node server.js` del dueño en :5005 a veces: no matarlo ni levantar otro; verificar con `node --check` y `npm test`. El `.env` local apunta a la CouchDB de producción: **solo lectura** en cualquier prueba manual.
- Formas verificadas: `parseLote(docs)` → `{ nombre, origen, boundary, sections, ts_ultimo, stats }` con `stats = { trabajado_ha, neto_ha, repintado_ha, repintado_pct, contorno_ha, bloques, resolucion_m }` (`services/aog_parser.js:266-330`, export `calcularStats(sectionsTxt, boundaryLatLon)`). Docs de org: `aog_archivo` `{ tipo, es_lote:true, lote_nombre, subtipo: "boundary"|"boundary_kml"|"field_origin"|"sections_coverage", contenido, ts }`; `lote_maestro` `{ tipo, nombre, cultivo, temporada, ha_estimadas, updated_at }`; `lluvia_registro` `{ tipo, fecha:"YYYY-MM-DD", mm, lote, nota }`; `alerta` `{ tipo, nivel, ts_inicio, mensaje, resuelta }`. Global: `device` `{ tipo, device_id, hostname, estab_slug, ultimo_visto }`, `firmware` `{ tipo, producto, version, hash_sha256, tamano_bytes, changelog, ts }`.
- `lib/notify-org.js:notify(orgSlug, evento, { titulo, cuerpo })` con eventos `alerta_critica | fin_tarea | nodo_caido | reporte_diario | firmware_listo`; best-effort. `lib/push.js:notificarOrg(slug, { titulo, cuerpo, url })`.
- Auth: `middleware/auth.js` exporta `required`, `adminOnly`, `soloSuperadmin`; `req.user = { uid, rol_global, estabSlug, memberships }`; acepta Bearer, cookie `orbitx_token` y `?token=`.

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `services/temporada.js` (nuevo) | `temporadaDe(fecha)`, `rangoTemporada(clave)`, `temporadaActual()` — puro |
| `services/actividad.js` (nuevo) | `resumenActividad(slug, { temporada })` con cache 5 min; `armarResumen(...)` puro |
| `routes/actividad.js` (nuevo) | `GET /api/actividad/resumen` |
| `services/reportes.js` (nuevo) | `agregarTemporada(lotes, lluvias, rango)` puro |
| `routes/reportes.js` (nuevo) | `GET /api/reportes/temporada` (JSON) y `GET /reportes/temporada` (vista) |
| `views/reporte-temporada.ejs` (nuevo) | Vista imprimible standalone |
| `routes/ota_publico.js` (nuevo) | catálogo y descarga públicos con lista blanca y límite por IP |
| `views/releases.ejs` (nuevo) | Página pública de releases |
| `app/pantallas/inicio.js` (nuevo) | Pestaña Inicio de la PWA |
| `services/couchdb.js` | índices nuevos; hook `notify` en `insertAlerta` |
| `routes/ota.js` | hook `firmware_listo` |
| `server.js` (sucio) | montajes nuevos + hooks en los dos crons, por marcadores |
| `views/pages/dashboard.ejs` | tarjeta de actividad |
| `views/pages/mapa.ejs` (sucio) | popup en bloques de cobertura |
| `views/partials/sidebar.ejs` (sucio) | 4 secciones |
| `app/core/permisos.js`, `app/sw.js`, `app/ui/nav.js`, `app/version.json` | registrar Inicio |
| `tests/services/*.test.mjs` (nuevos) | temporada, actividad, reportes |

---

### Tarea 1: `services/temporada.js` (puro)

**Files:** Create `services/temporada.js`, `tests/services/temporada.test.mjs`.
**Interfaces → Produce:** `temporadaDe(fecha: Date|number|string) → "2026/27"`, `rangoTemporada("2026/27") → { desde: "2026-09-01", hasta: "2027-08-31", desdeMs, hastaMs }`, `temporadaActual(ahora = new Date()) → string`, `esTemporadaValida(s) → bool`. CommonJS (`module.exports`).

- [ ] **Paso 1: Test que falla** — `tests/services/temporada.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { temporadaDe, rangoTemporada, temporadaActual, esTemporadaValida } from "../../services/temporada.js";

test("temporadaDe: año agrícola sep→ago, hemisferio sur", () => {
  assert.equal(temporadaDe(new Date("2026-09-01T03:00:00Z")), "2026/27");
  assert.equal(temporadaDe(new Date("2026-08-31T23:00:00Z")), "2025/26");
  assert.equal(temporadaDe(new Date("2027-03-15T12:00:00Z")), "2026/27");
  assert.equal(temporadaDe(Date.UTC(2025, 11, 24)), "2025/26");
  assert.equal(temporadaDe("2026-01-10"), "2025/26");
});
test("rangoTemporada devuelve los límites y sus ms", () => {
  const r = rangoTemporada("2026/27");
  assert.equal(r.desde, "2026-09-01"); assert.equal(r.hasta, "2027-08-31");
  assert.ok(r.desdeMs < r.hastaMs);
  assert.equal(temporadaDe(r.desdeMs), "2026/27");
  assert.equal(temporadaDe(r.hastaMs), "2026/27");
});
test("esTemporadaValida acepta AAAA/AA y rechaza el resto", () => {
  assert.equal(esTemporadaValida("2026/27"), true);
  assert.equal(esTemporadaValida("2026/28"), false);
  assert.equal(esTemporadaValida("26/27"), false);
  assert.equal(esTemporadaValida(""), false);
});
test("temporadaActual usa la fecha dada", () => {
  assert.equal(temporadaActual(new Date("2026-09-23T15:00:00Z")), "2026/27");
});
```
- [ ] **Paso 2:** `npm test` → falla por módulo inexistente.
- [ ] **Paso 3: Implementar** `services/temporada.js`:
```js
"use strict";
// temporada.js — Temporada agrícola del hemisferio sur: del 1 de septiembre al
// 31 de agosto. Clave "AAAA/AA" (2026/27 = sep-2026 → ago-2027). Todo se calcula
// en hora Argentina para que un archivo del 31/8 a la noche no salte de campaña.
const TZ = "America/Argentina/Buenos_Aires";

function partesAR(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha + "T12:00:00-03:00" : fecha);
  if (Number.isNaN(d.getTime())) throw new Error("fecha inválida: " + fecha);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => Number(p.find(x => x.type === t).value);
  return { anio: g("year"), mes: g("month"), dia: g("day") };
}

function clave(anioInicio) { return `${anioInicio}/${String((anioInicio + 1) % 100).padStart(2, "0")}`; }

function temporadaDe(fecha) {
  const { anio, mes } = partesAR(fecha);
  return clave(mes >= 9 ? anio : anio - 1);
}

function esTemporadaValida(s) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(s || ""));
  return !!m && Number(m[2]) === (Number(m[1]) + 1) % 100;
}

function rangoTemporada(s) {
  if (!esTemporadaValida(s)) throw new Error("temporada inválida: " + s);
  const a = Number(s.slice(0, 4));
  const desde = `${a}-09-01`, hasta = `${a + 1}-08-31`;
  return { desde, hasta, desdeMs: Date.parse(desde + "T00:00:00-03:00"), hastaMs: Date.parse(hasta + "T23:59:59-03:00") };
}

function temporadaActual(ahora = new Date()) { return temporadaDe(ahora); }

module.exports = { temporadaDe, rangoTemporada, temporadaActual, esTemporadaValida };
```
- [ ] **Paso 4:** `npm test` → 48/48. **Paso 5:** `git add services/temporada.js tests/services/temporada.test.mjs && git commit -m "feat(temporada): temporada agrícola sep→ago con rango y validación"`.

---

### Tarea 2: Índices Mango nuevos

**Files:** Modify `services/couchdb.js:184-196` (limpio).
- [ ] Agregar a `ESTAB_INDEX_FIELDS`, al final de la lista, con comentario: `["tipo","ts_inicio"], // alertas: historial ordenado sin filtrar resuelta` y `["tipo","temporada"], // lote_maestro por temporada (reportes, actividad)`.
- [ ] `node --check services/couchdb.js`; `npm test` 48/48. `git add services/couchdb.js && git commit -m "feat(couchdb): índices tipo+ts_inicio y tipo+temporada"`.

---

### Tarea 3: `services/actividad.js` + `routes/actividad.js`

**Files:** Create `services/actividad.js`, `routes/actividad.js`, `tests/services/actividad.test.mjs`. Modify `server.js` (sucio: por marcador).
**Interfaces → Produce:** `armarResumen({ temporada, rango, coberturas, maestros, devices, lluvias, alertas, ahora })` puro → objeto de respuesta; `resumenActividad(slug, { temporada } = {})` con cache 5 min; `GET /api/actividad/resumen?temporada=2026/27` (auth `required`; org = `req.user.estabSlug`, o `?estab=` si superadmin).

Respuesta:
```json
{ "temporada": "2026/27", "rango": {"desde":"2026-09-01","hasta":"2027-08-31"},
  "hectareas": { "trabajadas": 123.4, "netas": 110.2, "repintado_pct": 10.7, "lotes": 8 },
  "equipos": { "total": 3, "online": 1, "sin_reportar": [{ "hostname":"...", "hace_min": 240 }] },
  "lluvia": { "mes_mm": 42, "temporada_mm": 310, "ultima": {"fecha":"2026-09-20","mm":12} },
  "alertas_activas": 2,
  "ultimos": [ { "ts": 1758600000000, "tipo": "lote", "texto": "La Mariana 4 este: 34,6 ha trabajadas" }, { "ts":..., "tipo":"lluvia","texto":"12 mm en La Mariana 4" }, { "ts":..., "tipo":"alerta","texto":"..." }, { "ts":..., "tipo":"equipo","texto":"VX-… volvió a reportar" } ],
  "generado": 1758600000000, "cache": false }
```
- [ ] **Paso 1: Test** `tests/services/actividad.test.mjs` sobre `armarResumen` (puro): (a) suma `trabajado_ha`/`neto_ha` solo de coberturas cuyo `ts` cae en el rango; (b) `equipos.online` = `ultimo_visto` < 2 min; `sin_reportar` = los demás con `ultimo_visto`; (c) `lluvia.mes_mm` suma registros del mes calendario actual (TZ AR) y `temporada_mm` los del rango; (d) `ultimos` ordenado desc por ts, máximo 12, con los 4 tipos; (e) `hectareas.lotes` = lotes distintos con cobertura en el rango. Fixtures en el test, sin CouchDB.
- [ ] **Paso 2:** falla. **Paso 3: Implementar** `services/actividad.js`:
```js
"use strict";
// actividad.js — Resumen de la operación para el Inicio (panel y app). Toma
// los archivos de cobertura de PilotX (calcularStats), equipos, lluvias y
// alertas de la org, y arma un objeto liviano. Parsear coberturas es caro:
// cache en memoria 5 min por org+temporada.
const db = require("./couchdb");
const { calcularStats } = require("./aog_parser");
const { temporadaActual, rangoTemporada, esTemporadaValida } = require("./temporada");
const TZ = "America/Argentina/Buenos_Aires";
const CACHE_MS = 5 * 60 * 1000, ONLINE_MS = 2 * 60 * 1000;
const _cache = new Map();

function mesAR(ts) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(new Date(ts)); }
const r1 = (n) => Math.round(n * 10) / 10;

function armarResumen({ temporada, rango, coberturas = [], maestros = [], devices = [], lluvias = [], alertas = [], ahora = Date.now() }) {
  const enRango = coberturas.filter(c => c.ts >= rango.desdeMs && c.ts <= rango.hastaMs && c.stats);
  const porLote = new Map();
  for (const c of enRango) { const prev = porLote.get(c.lote_nombre); if (!prev || c.ts > prev.ts) porLote.set(c.lote_nombre, c); }
  let trab = 0, neto = 0;
  for (const c of porLote.values()) { trab += c.stats.trabajado_ha || 0; neto += c.stats.neto_ha || 0; }
  const online = devices.filter(d => d.ultimo_visto && ahora - d.ultimo_visto < ONLINE_MS);
  const sinReportar = devices.filter(d => d.ultimo_visto && ahora - d.ultimo_visto >= ONLINE_MS)
    .map(d => ({ hostname: d.hostname || d.device_id, hace_min: Math.round((ahora - d.ultimo_visto) / 60000) }))
    .sort((a, b) => a.hace_min - b.hace_min);
  const mes = mesAR(ahora);
  const lluviasRango = lluvias.filter(l => l.fecha >= rango.desde && l.fecha <= rango.hasta);
  const ultimaLluvia = [...lluvias].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))[0] || null;
  const ultimos = [
    ...[...porLote.values()].map(c => ({ ts: c.ts, tipo: "lote", texto: `${c.lote_nombre}: ${r1(c.stats.trabajado_ha || 0)} ha trabajadas` })),
    ...lluvias.map(l => ({ ts: Date.parse(l.fecha + "T12:00:00-03:00"), tipo: "lluvia", texto: `${l.mm} mm${l.lote ? " en " + l.lote : ""}` })),
    ...alertas.map(a => ({ ts: a.ts_inicio || 0, tipo: "alerta", texto: a.mensaje || "Alerta" })),
    ...online.map(d => ({ ts: d.ultimo_visto, tipo: "equipo", texto: `${d.hostname || d.device_id} en línea` })),
  ].filter(e => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts).slice(0, 12);
  return {
    temporada, rango: { desde: rango.desde, hasta: rango.hasta },
    hectareas: { trabajadas: r1(trab), netas: r1(neto), repintado_pct: trab > 0 ? r1((trab - neto) / trab * 100) : 0, lotes: porLote.size },
    equipos: { total: devices.length, online: online.length, sin_reportar: sinReportar.slice(0, 5) },
    lluvia: { mes_mm: r1(lluvias.filter(l => (l.fecha || "").startsWith(mes)).reduce((s, l) => s + (Number(l.mm) || 0), 0)),
              temporada_mm: r1(lluviasRango.reduce((s, l) => s + (Number(l.mm) || 0), 0)),
              ultima: ultimaLluvia ? { fecha: ultimaLluvia.fecha, mm: ultimaLluvia.mm, lote: ultimaLluvia.lote || null } : null },
    alertas_activas: alertas.filter(a => !a.resuelta).length,
    ultimos, generado: ahora, cache: false,
  };
}

async function cargarCoberturas(estabDB) {
  // Solo los archivos de cobertura (uno por lote): contenido + ts. Índice ["tipo","es_lote","lote_nombre"].
  const r = await estabDB.find({ selector: { tipo: "aog_archivo", es_lote: true, subtipo: "sections_coverage" }, limit: 2000 });
  return (r.docs || []).map(d => ({ lote_nombre: d.lote_nombre, ts: d.ts || 0, stats: d.contenido ? calcularStats(d.contenido, null) : null }));
}

async function resumenActividad(slug, { temporada } = {}) {
  const temp = esTemporadaValida(temporada) ? temporada : temporadaActual();
  const key = `${slug}::${temp}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return { ...hit.data, cache: true };
  const estabDB = db.getDB(slug), globalDB = db.getDB("global");
  const [coberturas, maestros, devs, lluv, alertas] = await Promise.all([
    cargarCoberturas(estabDB),
    estabDB.find({ selector: { tipo: "lote_maestro" }, fields: ["nombre", "cultivo", "temporada"], limit: 2000 }).then(r => r.docs).catch(() => []),
    globalDB.find({ selector: { tipo: "device", estab_slug: slug }, fields: ["device_id", "hostname", "ultimo_visto"], limit: 500 }).then(r => r.docs).catch(() => []),
    estabDB.find({ selector: { tipo: "lluvia_registro" }, fields: ["fecha", "mm", "lote"], limit: 2000 }).then(r => r.docs).catch(() => []),
    db.getAlertasActivas(slug).catch(() => []),
  ]);
  const data = armarResumen({ temporada: temp, rango: rangoTemporada(temp), coberturas, maestros, devices: devs, lluvias: lluv, alertas });
  _cache.set(key, { ts: Date.now(), data });
  return data;
}

module.exports = { armarResumen, resumenActividad, ONLINE_MS };
```
`routes/actividad.js`:
```js
"use strict";
// GET /api/actividad/resumen?temporada=AAAA/AA[&estab=slug] — resumen de la
// operación para el Inicio del panel y de la app móvil. Superadmin puede pedir
// otra org con ?estab=; el resto solo la suya.
const router = require("express").Router();
const { resumenActividad } = require("../services/actividad");

router.get("/resumen", async (req, res) => {
  try {
    const esSA = req.user?.rol_global === "superadmin";
    const slug = (esSA && typeof req.query.estab === "string" && req.query.estab) ? req.query.estab : req.user?.estabSlug;
    if (!slug) return res.status(400).json({ error: "Sin establecimiento" });
    res.json(await resumenActividad(slug, { temporada: req.query.temporada }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
module.exports = router;
```
`server.js` (EN DISCO, sin stagear): después de la línea `app.use("/api/lluvias",        auth.required, routeLluvias);` insertar el bloque entre marcadores:
```js
// ── Sprint 1: actividad / reportes / releases ─────────────
app.use("/api/actividad", auth.required, require("./routes/actividad"));
// ── fin Sprint 1 ──────────────────────────────────────────
```
(las Tareas 6 y 9 agregan líneas DENTRO de ese bloque).
- [ ] **Paso 4:** `npm test` (≥ 53), `node --check server.js`. Prueba manual de solo lectura contra prod (token firmado en el droplet como en el sprint anterior) opcional: `GET /api/actividad/resumen?estab=la_flora`.
- [ ] **Paso 5:** `git add services/actividad.js routes/actividad.js tests/services/actividad.test.mjs && git commit -m "feat(actividad): resumen de la operación por temporada con cache"`. `server.js` queda sin stagear (marcador).

---

### Tarea 4: Tarjeta de actividad en el dashboard del panel

**Files:** Modify `views/pages/dashboard.ejs` (limpio).
- [ ] Insertar, **antes** de `<div class="g2">`, una tarjeta `<div class="card" id="card-actividad">` con cabecera "Actividad de la temporada <span id="act-temp"></span>" y cuerpo con 4 KPIs chicos (ha trabajadas, ha netas, equipos en línea/total, lluvia del mes) + lista `<ul id="act-ultimos">` de últimos eventos + estado "Cargando…". Estilos: reusar clases `card`, `card-head`, `card-title`, `kpi-grid`, `kpi`, `kpi-label`, `kpi-val`, `kpi-delta`, `td-main`, `td-dim`, `empty-state` (ya existen en `public/css/components.css`).
- [ ] Script inline al final del archivo: `fetch("/api/actividad/resumen", { credentials: "same-origin" })` (el JWT va en cookie `orbitx_token`); pintar con `textContent` (nunca innerHTML con datos); fechas con `toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })`; si el usuario no tiene org (superadmin en vista global) mostrar "Elegí un establecimiento arriba" y no llamar.
- [ ] Verificación: `node -e "require('ejs').compile(require('fs').readFileSync('views/pages/dashboard.ejs','utf8'))"` compila. Commit `views/pages/dashboard.ejs`.

---

### Tarea 5: Pestaña "Inicio" en la app móvil

**Files:** Create `app/pantallas/inicio.js`. Modify `app/core/permisos.js`, `tests/app/permisos.test.mjs`, `app/ui/nav.js`, `app/sw.js`, `app/main.js` (todos limpios).
- [ ] `permisos.js`: `PESTANAS = ["inicio","mapa","lotes","lluvias","alertas","equipos"]`; `SIN_EQUIPOS` gana `"inicio"` al principio; actualizar el test (Inicio la ven todos). `nav.js`: `ICONOS.inicio = "🏠"`, `ROTULOS.inicio = "Inicio"`. `main.js`: la pestaña por defecto pasa de `"mapa"` a `"inicio"` (`const pestana = partes[0] || "inicio"` y la redirección por permisos a `#/inicio`). `sw.js`: agregar `"/app/pantallas/inicio.js"` a `SHELL`.
- [ ] `app/pantallas/inicio.js` (contrato `montar(ctx, root)` → `{ desmontar }`): `ctx.api.get("/api/actividad/resumen")` → `{ data, desdeCache, ts }`; `nav.setOffline(desdeCache, ts)`; render con `esc()`: cabecera con temporada y rango; 4 "tiles" (`.card` con número grande: ha trabajadas, ha netas + repintado %, equipos en línea / total, lluvia del mes + última); lista "Últimos movimientos" con punto por tipo (`lote`→ok, `lluvia`→info, `alerta`→err, `equipo`→warn) y `haceCuanto(ts)`; cada ítem `lote` linkea a `#/lotes/<nombre>` (el texto empieza con el nombre: guardar `lote_nombre` aparte — agregar `lote` al objeto de `ultimos` en `armarResumen` si hace falta: `{ ts, tipo, texto, lote }`); refresco cada 5 min; `desmontar` limpia el intervalo.
- [ ] `npm run app:version`; `npm test`; commit `app/pantallas/inicio.js app/core/permisos.js tests/app/permisos.test.mjs app/ui/nav.js app/sw.js app/main.js app/version.json`.

---

### Tarea 6: `services/reportes.js` + `routes/reportes.js` (JSON)

**Files:** Create `services/reportes.js`, `routes/reportes.js`, `tests/services/reportes.test.mjs`. Modify `server.js` (marcador Sprint 1).
**Produce:** `agregarTemporada({ temporada, rango, maestros, coberturas, lluvias })` puro → `{ temporada, rango, lotes: [{ nombre, cultivo, temporada, ha_estimadas, trabajado_ha, neto_ha, repintado_ha, repintado_pct, bloques, ultimo_ts, lluvia_mm }], totales: { lotes, trabajado_ha, neto_ha, repintado_ha, lluvia_mm } }`; `reporteTemporada(slug, temporada)`; `GET /api/reportes/temporada?temporada=2025/26[&estab=]` (auth `required`).
- [ ] Test puro: un lote con cobertura en rango y otro fuera; `lluvia_mm` por lote = suma de `lluvia_registro` con `lote === nombre` y `fecha` en rango; los sin `lote` van a `totales.lluvia_mm` igual (lluvia general del establecimiento); `cultivo`/`ha_estimadas` del maestro si existe; un lote solo-maestro sin cobertura aparece con `trabajado_ha: null`; orden por `trabajado_ha` desc.
- [ ] Implementación: `reporteTemporada` reutiliza `cargarCoberturas` (exportarla desde `services/actividad.js`) y consulta `lote_maestro` (todos; filtrar en memoria por `temporada === temp || !temporada`) y `lluvia_registro` con selector `{ tipo:"lluvia_registro", fecha: { $gte: rango.desde, $lte: rango.hasta } }` (índice `["tipo","fecha"]`). Router igual al de actividad. En `server.js`, dentro del bloque Sprint 1: `app.use("/api/reportes", auth.required, require("./routes/reportes"));`.
- [ ] `npm test`; commit `services/reportes.js routes/reportes.js tests/services/reportes.test.mjs` (+ exportación en `services/actividad.js`).

---

### Tarea 7: Vista imprimible `/reportes/temporada`

**Files:** Create `views/reporte-temporada.ejs`. Modify `routes/reportes.js`, `server.js` (marcador).
- [ ] Ruta `router.get("/temporada/vista", ...)` en `routes/reportes.js` que arma el reporte y hace `res.render("reporte-temporada", { r, org: slug, temporadas: [actual, anterior, anteanterior] })`. En `server.js` (bloque Sprint 1): `app.use("/reportes", auth.required, require("./routes/reportes"));` — así `/reportes/temporada/vista` sirve la vista y `/api/reportes/temporada` el JSON con el mismo router.
- [ ] `views/reporte-temporada.ejs` standalone (sin `layout`): `<!doctype html>`, `<link rel="stylesheet" href="/css/variables.css">`, tipografía Inter del sistema, tabla de lotes (nombre, cultivo, ha estimadas, ha trabajadas, netas, repintado %, lluvia mm), fila de totales, cabecera con establecimiento / temporada / fecha de emisión (TZ AR) y un selector `<select>` de temporada que navega con `?temporada=`; botón "Imprimir / Guardar PDF" (`window.print()`); `@media print { .no-print { display:none } body { background:#fff; color:#000 } table { page-break-inside:auto } tr { page-break-inside:avoid } }`; `@page { size: A4; margin: 14mm }`. Todo valor con `<%= %>` (escapa solo).
- [ ] Verificación: compila con ejs; `curl` a `/reportes/temporada/vista` sin token → 401/redirect (protegida). Commit `views/reporte-temporada.ejs routes/reportes.js`.

---

### Tarea 8: Enganchar `notify-org` a los eventos reales

**Files:** Modify `services/couchdb.js` (`insertAlerta`, limpio), `routes/ota.js` (limpio, tras `notifyFirmwareSubido` ~l.101), `server.js` (sucio: cron caídos y cron 19:00, por anclas). Create `tests/lib/notify-org.test.mjs`.
- [ ] Test puro sobre `sanearNotif` de `lib/notify-org.js` (matriz por defecto, un evento apagado en un canal, entradas inválidas ignoradas).
- [ ] `insertAlerta`: junto al push existente, `require("../lib/notify-org").notify(slug, "alerta_critica", { titulo: \`Alerta ${data.nivel || ""}\`.trim(), cuerpo: data.mensaje || "Nueva alerta" }).catch(e => console.warn("[notify/alerta]", e.message))` (lazy require, dentro del mismo try). Solo si `!data.resuelta`.
- [ ] `routes/ota.js`: tras `notifyFirmwareSubido(...)`, para cada org que tenga devices del producto es caro; alcanza con notificar a todas las orgs activas (`db.getEstablecimientos()`) con `firmware_listo` `{ titulo: \`Nuevo firmware ${producto} ${version}\`, cuerpo: changelog || "" }` — best-effort, `Promise.allSettled`.
- [ ] `server.js` EN DISCO: en el cron de caídos, después de `await push.notificarOrg(d.estab_slug, {...})`, agregar `await require("./lib/notify-org").notify(d.estab_slug, "nodo_caido", { titulo: "Equipo sin reportar", cuerpo: \`${d.hostname || d.device_id} no reporta hace ${min} min\` }).catch(e => console.warn("[notify/caido]", e.message));` (dentro del try por device). En el cron de las 19:00, después de `io.to(\`estab:${e.slug}\`).emit("agraria:resumen_diario", {...});` agregar `require("./lib/notify-org").notify(e.slug, "reporte_diario", { titulo: \`Resumen diario · ${e.nombre}\`, cuerpo: typeof analisis === "string" ? analisis.slice(0, 1500) : JSON.stringify(analisis).slice(0, 1500) }).catch(err => console.warn("[notify/diario]", err.message));`. Marcar cada inserción con un comentario `// Sprint 1: notify-org` para que el controlador la ubique.
- [ ] `node --check` de los tres; `npm test`. Commit `services/couchdb.js routes/ota.js tests/lib/notify-org.test.mjs` (server.js sin stagear).

---

### Tarea 9: Releases públicas + flasheo público

**Files:** Create `routes/ota_publico.js`, `views/releases.ejs`. Modify `server.js` (marcador Sprint 1). No tocar `lib/firmware.js` (sucio) ni `routes/ota.js` más allá de la Tarea 8.
- [ ] `routes/ota_publico.js`: `PRODUCTOS_PUBLICOS = ["VistaX","QuantiX","FlowX","SectionX","ToolX","StormX"]`; `GET /` (catálogo: `globalDB.find({ selector: { tipo: "firmware" }, limit: 500 })` filtrado por lista blanca, campos `producto, version, tamano_bytes, changelog, ts, hash_sha256`, ordenado por ts desc, agrupado por producto `{ producto: [versiones…] }`); `GET /firmware/:producto/:version` → 404 si el producto no es público o no existe el doc; límite en memoria 20 descargas/IP/hora (Map ip → [ts…], `req.ip`, 429 con `{ error: "Demasiadas descargas, esperá una hora" }`); sirve el archivo con `res.download(ruta, \`${producto}-${version}.bin\`)` usando la ruta que ya calcula `lib/firmware.js` (`rutaBin(producto, version)` o el helper que exista: leerlo en disco y usar el nombre real); `GET /pagina` renderiza `views/releases.ejs` con el catálogo.
- [ ] `views/releases.ejs` standalone, pública: título "Software y firmware de PilotX", tokens de `variables.css`, una sección por producto con la versión más nueva destacada (fecha AR, tamaño en MB, notas con saltos de línea, botón Descargar, hash SHA-256 en `<code>`), versiones anteriores plegadas (`<details>`), y un enlace "Flashear por USB desde el navegador" a `/flash-publico/<producto-minúsculas>/` solo para los productos que tienen carpeta en `flash-app/` (flowx, quantix, quantix7, vistax).
- [ ] `server.js` (bloque Sprint 1): `app.use("/api/ota/publico", require("./routes/ota_publico"));` (SIN auth), `app.get("/releases", (req, res) => res.redirect("/api/ota/publico/pagina"));` y `app.use("/flash-publico", express.static(path.join(__dirname, "flash-app"), { index: "index.html" }));` — **ojo:** este mount debe ir ANTES de `app.use("/flash", ...)` y solo servir subcarpetas: para no exponer todo `flash-app/`, usar `express.static` por carpeta: `for (const p of ["flowx","quantix","quantix7","vistax"]) app.use(\`/flash-publico/${p}\`, express.static(path.join(__dirname, "flash-app", p)));`.
- [ ] Verificación: `curl` local (si hay server) o revisión estática; commit `routes/ota_publico.js views/releases.ejs`.

---

### Tarea 10: Click en bloques de cobertura (`mapa.ejs`)

**Files:** Modify `views/pages/mapa.ejs` (sucio, EN DISCO, sin stagear).
- [ ] Reemplazar el bloque `if (lote.sections?.length) { lote.sections.forEach(rect => { _layers.push(L.polygon(rect, {...}).addTo(_mapa)); }); }` (líneas ~364-371 en disco) por una versión que, por cada `rect` con índice `i`, crea el polígono, le hace `.bindPopup(...)` con: nombre del lote, "Bloque i+1 de N", y si `lote.stats` existe: "Trabajadas X ha · Netas Y ha · Repintado Z ha (P %)", más `cultivo`/`temporada` si la página ya tiene el maestro del lote a mano (si no, omitir). Texto escapado (usar una función `esc` local si no existe). Marcadores `// Sprint 1: popup de cobertura` / `// fin Sprint 1`. Además, `.on("mouseover")` que suba `weight` a 1.5 y `mouseout` que lo vuelva a 0.5.
- [ ] Verificación: compila con ejs; `git status --short views/pages/mapa.ejs` sigue ` M`. No commitear.

---

### Tarea 11: Sidebar en 4 secciones

**Files:** Modify `views/partials/sidebar.ejs` (sucio, EN DISCO, sin stagear).
- [ ] Reemplazar desde `<%- navGroup('principal', 'Principal',` hasta la línea `<%- navGroup('admin', 'Admin', _adminItems) %>` inclusive por cuatro grupos, manteniendo `navItem`, `navGroup`, `_nav`, `_adminItems` y las condiciones de rol que ya existen (leer el archivo en disco; el bloque de admin/superadmin usa variables ya definidas arriba, respetarlas):
  - `navGroup('campo', 'Campo', …)`: `/mapa 🗺 Mapa`, `/lotes 🌾 Lotes`, `/lluvias 🌧 Lluvias`, `/alertas ⚠ Alertas`, `/tracking 📍 Tracking`, `/prescripciones 📋 Prescripciones`, `/vistax 🌱 VistaX`, `/vistax-mapas 🗾 VistaX · Mapas`.
  - `navGroup('equipos', 'Equipos', …)`: `/dispositivos 📡 Dispositivos`, `/vehiculos 🚜 Vehículos`, `/camaras 📹 Cámaras`, `/configuraciones ⚙ Configuraciones`, `/firmwares 📦 Firmwares` (solo si el rol actual ya lo veía), `/flash/ ⚡ Flasheo USB` (ídem).
  - `navGroup('analisis', 'Análisis', …)`: `/dashboard ⊞ Inicio`, `/agraria ✦ agrarIA`, `/reportes/temporada/vista 📄 Reportes`, `/releases 🚀 Releases` (público, igual se lista).
  - `navGroup('admin', 'Administración', _adminItems)` con el mismo `_adminItems` que hoy (establecimientos, equipo, soporte, registros, usuarios, roles, integraciones, grupos, config, couchdb) — sin `firmwares`/`flash`, que pasan a Equipos con su misma condición de rol.
  Marcadores `<%# Sprint 1: menú en 4 secciones %>` al inicio y `<%# fin Sprint 1 %>` al final del bloque reemplazado.
- [ ] Verificación: compila con ejs. No commitear.

---

### Tarea 12: Commit de archivos sucios por marcadores, deploy y verificación

**Controlador (no subagente):**
- [ ] `server.js`: extraer el bloque entre `// ── Sprint 1: actividad / reportes / releases` y `// ── fin Sprint 1` + las dos inserciones `// Sprint 1: notify-org` de los crons; armar blob = base (`git show HEAD:server.js`) + bloques por anclas; commit. Igual para `views/pages/mapa.ejs` y `views/partials/sidebar.ejs` (bloques entre marcadores `Sprint 1`).
- [ ] Deploy por archivos con `md5sum` previo de prod vs. las copias `.superpowers/sdd/prod-*` (server.js, mapa.ejs, sidebar.ejs deben coincidir con lo analizado; si no, re-analizar). Artefacto de `server.js` = prod + bloques Sprint 1. `npm run app:version` antes de subir `app/`. `pm2 restart OrbitX`; smoke: `/api/actividad/resumen` (401 sin token), `/releases` 200 sin login, `/api/ota/publico/firmware/PilotX/1` 404, `/login` 200, logs sin `[router] ✕`.
- [ ] Criterios 1–7 del spec verificados (los de panel con el dueño logueado; los públicos con curl).
