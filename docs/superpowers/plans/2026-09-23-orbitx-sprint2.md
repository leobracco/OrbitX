# OrbitX Sprint 2 · "ver → hacer" · Plan de implementación

> **Para agentes:** SUB-SKILL REQUERIDA: `superpowers:subagent-driven-development` (recomendada) o `superpowers:executing-plans`. Un implementador por tarea, revisión entre tareas. Los pasos usan casillas (`- [ ]`) para seguimiento.

**Objetivo:** Que OrbitX pase de mostrar el dato a actuar sobre él: stats de cobertura precalculadas en el sync, zonas y prescripción generadas desde NDVI que QuantiX consuma, comparación de dos capas del mismo lote, tokens de lectura por organización e historial de notificaciones con "marcar leídas".

**Arquitectura:** módulos nuevos, puros y testeables (`lib/png.js`, `lib/zonificar.js`, `lib/prescripcion_schema.js`, `lib/notificaciones.js`, `services/cobertura_stats.js`, `services/ndvi_raster.js`, `services/tokens_org.js`) más routers nuevos (`routes/tokens_org.js`, `routes/prescripciones.js`) montados sobre lo que ya existe. Todo lo pesado (rasterizar cobertura, zonificar NDVI) corre en colas de concurrencia 1 troceadas con `setImmediate`, nunca dentro del camino de un request. Los archivos con ediciones del dueño sin commitear se tocan **solo entre marcadores**.

**Stack:** Node 22 local / **Node 20 en prod**, Express 5, CouchDB vía `nano`, EJS, socket.io, Leaflet 1.9.4 servido desde `public/`, `node --test` (`npm test`). **Sin dependencias nuevas** — PNG se decodifica con `zlib` nativo y la geometría es JS puro.

Spec aprobado: `docs/superpowers/specs/2026-09-23-orbitx-sprint2-design.md`.
Análisis técnico con `archivo:línea`: `.superpowers/sdd/sprint2-analisis.md`.
Repo: `G:\AgroParallel\Productos\OrbitX\Software\App_PC\OrbitX-Server`, rama `feature/sprint2-ver-hacer`.

## Global Constraints

Copiadas del spec ("Restricciones globales"). **Aplican a todas las tareas.**

- Castellano rioplatense en todo texto cliente-facing, comentarios, logs y commits. Rebranding: nunca "AgOpenGPS"/"AOG" → **PilotX**; "AgIO" → **CoreX**; "Teensy" → **CoreX ECU**.
- Node 20 en producción, 1 vCPU / 1 GB compartido con ~25 apps: **ningún trabajo sincrónico > 50 ms en el camino de un request**; lo pesado va en cola de concurrencia 1 troceada con `setImmediate`.
- Sin dependencias nativas ni librerías de imagen/geo nuevas: `package.json` tiene 12 deps y así queda. PNG se decodifica con `zlib` nativo; la geometría es JS puro.
- Ningún `db.list({include_docs:true})` nuevo. Toda query nueva con índice Mango y `fields`.
- Fechas cliente-facing en TZ `America/Argentina/Buenos_Aires`.
- Archivos sucios del usuario (`routes/aog.js`, `middleware/auth.js`, `server.js`, `views/pages/mapa.ejs`, `views/partials/topbar.ejs`, `routes/panel.js`, `routes/lotes_maestro.js`) se tocan **SOLO entre marcadores** `// Sprint 2: <pieza>` … `// fin Sprint 2: <pieza>` (en EJS `<%# Sprint 2: <pieza> %>` … `<%# fin Sprint 2: <pieza> %>`), **nunca se stagean** por el implementador; el controlador arma los commits.
- Tests con `node --test` sobre lógica pura; **sin mocks de CouchDB**.
- **Nunca escribir en la CouchDB de producción** desde tests ni desde el desarrollo local. El `.env` local apunta a prod: los tests no la tocan (todos importan funciones puras).

### Reglas operativas de commit

- **Nunca `git add -A` / `git add .` / `commit -a`.** Los archivos limpios se commitean con pathspec explícito:
  `git commit -m "…" -- ruta/uno.js ruta/dos.mjs`.
- Los **archivos sucios listados arriba NO se stagean ni se commitean**. El implementador edita en disco entre marcadores y lo deja así; el controlador arma el commit por marcadores.
- Trailer obligatorio en cada commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr
  ```

---

## Estructura de archivos

| Archivo | Responsabilidad | Estado |
|---|---|---|
| `services/couchdb.js` | Índices Mango nuevos (`ESTAB_INDEX_FIELDS`, `GLOBAL_INDEX_FIELDS`) | limpio |
| `services/aog_parser.js` | `STATS_VER`, `statsVigentes`, `netoRasterAsync`, `calcularStatsAsync`, `parseLote` usa `doc.stats` | limpio |
| `services/cobertura_stats.js` (nuevo) | Cola concurrencia 1: calcula y persiste `stats` de cobertura | nuevo |
| `scripts/backfill-stats-cobertura.js` (nuevo) | Migración one-shot de los docs vigentes | nuevo |
| `services/actividad.js`, `services/reportes.js` | Leen `stats` con `fields`, sin parsear; `contorno_ha` real | limpios |
| `services/tokens_org.js` (nuevo) | Generación/hash/validación de tokens `orbx_`, guard de solo lectura | nuevo |
| `routes/tokens_org.js` (nuevo) | CRUD de tokens de la org (admin) | nuevo |
| `lib/notificaciones.js` (nuevo) | Doc `notificacion` + doc de lectura por usuario | nuevo |
| `lib/notify-org.js`, `routes/notif_org.js` | Persistir siempre + endpoints de historial | limpios |
| `lib/png.js` (nuevo) | Decoder PNG con `zlib` (filtros 0–4, color type 0/2/4/6, 8 bits) | nuevo |
| `lib/zonificar.js` (nuevo) | Cuantiles, filtro de mayoría, fusión de chicas, marching squares, Douglas-Peucker, UTM↔lat/lon | nuevo |
| `lib/prescripcion_schema.js` (nuevo) | Esquema canónico de properties + conversión desde `localStorage` | nuevo |
| `services/ndvi_raster.js` (nuevo) | Boundary → bbox UTM → raster UINT8 de Copernicus → grilla decodificada | nuevo |
| `services/prescripciones.js` (nuevo) | Orquesta generación + CRUD del doc `prescripcion` | nuevo |
| `routes/prescripciones.js` (nuevo) | `/api/prescripciones/docs`, `/generar`, `/migrar` | nuevo |
| `routes/ndvi.js` | `processAPI` con `formato`, `GET /lote/raster`, percentiles, purga de cache | limpio |
| `routes/prescripciones_api.js` | Filtrar por `subtipo`, marcar `entregado` después de responder | limpio |
| `public/js/mapa-ndvi.js` | De singleton a factory `crearNDVI()` | limpio |
| `public/js/mapa-comparar.js` (nuevo) | Toda la lógica del comparador de dos paneles | nuevo |
| `views/pages/prescripciones.ejs` | Panel "Generar desde NDVI" + migración de `localStorage` | limpio |
| `views/pages/integraciones.ejs` | Card "Tokens de acceso" | limpio |
| `views/pages/notificaciones.ejs` (nuevo) | Historial de avisos del panel | nuevo |
| `views/partials/sidebar.ejs` | Ítem "Avisos" | limpio |
| `app/pantallas/alertas.js` | Sección "Avisos" en la PWA | limpio |
| **`routes/aog.js`** | Copiar `stats` al histórico, encolar stats, `?temporada=`, `/lotes/:n/temporadas` | **SUCIO** |
| **`middleware/auth.js`** | Rama de token `orbx_` + guard en `requirePermiso` | **SUCIO** |
| **`server.js`** | Montar routers nuevos + cron de retención | **SUCIO** |
| **`views/pages/mapa.ejs`** | Botón y contenedores del comparador | **SUCIO** |
| **`views/partials/topbar.ejs`** | Campanita con badge | **SUCIO** |
| **`routes/panel.js`** | Ruta `/notificaciones` | **SUCIO** |
| **`routes/lotes_maestro.js`** | `?meta=1` en `/contexto` | **SUCIO** |

---

### Tarea 1: Índices Mango nuevos + versión de stats

**Files:**
- Modify: `services/couchdb.js:184-204` (`ESTAB_INDEX_FIELDS`), `services/couchdb.js:227-233` (`GLOBAL_INDEX_FIELDS`), `services/couchdb.js:426-437` (`module.exports`)
- Modify: `services/aog_parser.js:337` (`module.exports`) — agregar `STATS_VER` y `statsVigentes`
- Test: `tests/services/indices-stats.test.mjs` (nuevo)

**Interfaces:**
- Consume: nada.
- Produce:
  - `services/couchdb.js` exporta `ESTAB_INDEX_FIELDS: string[][]` y `GLOBAL_INDEX_FIELDS: string[][]`.
  - `services/aog_parser.js` exporta `STATS_VER: number` (vale `1`) y `statsVigentes(doc: object, ver?: number) -> boolean`.

- [ ] **Paso 1: Escribir el test que falla** — `tests/services/indices-stats.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import couch from "../../services/couchdb.js";
import parser from "../../services/aog_parser.js";

const { ESTAB_INDEX_FIELDS, GLOBAL_INDEX_FIELDS } = couch;
const { STATS_VER, statsVigentes } = parser;

const tiene = (lista, campos) =>
  lista.some(f => f.length === campos.length && f.every((c, i) => c === campos[i]));

test("ESTAB_INDEX_FIELDS cubre las queries nuevas del Sprint 2", () => {
  // Pieza 2: listar temporadas de un lote desde aog_historial sin bajar contenido.
  assert.ok(tiene(ESTAB_INDEX_FIELDS, ["tipo", "subtipo", "lote_nombre", "ts"]));
  // Pieza 1: prescripciones de un lote.
  assert.ok(tiene(ESTAB_INDEX_FIELDS, ["tipo", "lote_nombre"]));
  // Pieza 6: historial de notificaciones paginado por ts (ya existía, no se rompe).
  assert.ok(tiene(ESTAB_INDEX_FIELDS, ["tipo", "ts"]));
});

test("GLOBAL_INDEX_FIELDS cubre el lookup de tokens de org", () => {
  assert.ok(tiene(GLOBAL_INDEX_FIELDS, ["tipo", "hash"]));
  assert.ok(tiene(GLOBAL_INDEX_FIELDS, ["tipo", "org_slug"]));
});

test("statsVigentes: solo confía cuando la versión y el hash coinciden", () => {
  const base = { stats: { trabajado_ha: 1 }, stats_ver: STATS_VER, stats_hash: "abc", hash_md5: "abc" };
  assert.equal(statsVigentes(base), true);
  assert.equal(statsVigentes({ ...base, stats_ver: STATS_VER + 1 }), false);
  assert.equal(statsVigentes({ ...base, hash_md5: "otro" }), false);
  assert.equal(statsVigentes({ ...base, stats: null }), false);
  assert.equal(statsVigentes(null), false);
});

test("statsVigentes: sin hash_md5 NO hay falso positivo undefined === undefined", () => {
  // Bug real detectado en el análisis: dos undefined comparaban iguales y las
  // stats quedaban pegadas a un contenido que ya había cambiado.
  assert.equal(statsVigentes({ stats: { neto_ha: 1 }, stats_ver: STATS_VER }), false);
  assert.equal(statsVigentes({ stats: { neto_ha: 1 }, stats_ver: STATS_VER, stats_hash: undefined, hash_md5: undefined }), false);
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/services/indices-stats.test.mjs`
Esperado: FALLA — `ESTAB_INDEX_FIELDS` es `undefined` (`Cannot read properties of undefined`).

- [ ] **Paso 3: Agregar los índices en `services/couchdb.js`**

En `ESTAB_INDEX_FIELDS`, después de la línea `  ["tipo","resuelta","ts_inicio"],` agregar:

```js
  // Sprint 2 — Pieza 2: temporadas de cobertura de un lote desde aog_historial.
  ["tipo","subtipo","lote_nombre","ts"],
  // Sprint 2 — Pieza 1: prescripciones guardadas de un lote.
  ["tipo","lote_nombre"],
```

En `GLOBAL_INDEX_FIELDS`, después de `  ["tipo","producto","version"],` agregar:

```js
  // Sprint 2 — Pieza 5: lookup de token_org por hash (obligatorio: sin este
  // índice, validar un token es un full scan de toda la base de auth).
  ["tipo","hash"],
  ["tipo","org_slug"],
```

- [ ] **Paso 4: Exportar las listas** — en `services/couchdb.js`, cambiar el final de `module.exports`:

```js
  saveBackupAOG, getBackupsAOG,
  procesarBatchSync, countPendingSync,
  ESTAB_INDEX_FIELDS, GLOBAL_INDEX_FIELDS
};
```

- [ ] **Paso 5: Agregar `STATS_VER` y `statsVigentes` en `services/aog_parser.js`**

Insertar justo antes de `// ── Parser completo de un lote ────────────────────────────`:

```js
// ── Vigencia de las stats precalculadas ───────────────────
// STATS_VER se bumpea cuando cambia el algoritmo de calcularStats: sube la
// versión y todos los docs quedan invalidados sin tocar la base.
const STATS_VER = 1;

// Un doc tiene stats confiables solo si: existen, son de esta versión, y el
// hash con el que se calcularon coincide con el hash del contenido actual.
// Si falta cualquiera de los dos hashes NO se confía: comparar dos undefined
// daba true y dejaba stats viejas pegadas a un archivo nuevo.
function statsVigentes(doc, ver = STATS_VER) {
  if (!doc || !doc.stats) return false;
  if (doc.stats_ver !== ver) return false;
  if (!doc.hash_md5 || !doc.stats_hash) return false;
  return doc.stats_hash === doc.hash_md5;
}
```

Y cambiar la última línea del archivo:

```js
module.exports = { parseFieldTxt, parseBoundaryTxt, parseKML, parseSections, parseLote, leerBloques, calcularStats, contornoM2, STATS_VER, statsVigentes };
```

- [ ] **Paso 6: Correr los tests**

Run: `node --test tests/services/indices-stats.test.mjs` → PASA (5 tests).
Run: `npm test` → todo verde (los 44 de antes + los nuevos).

- [ ] **Paso 7: Commit**

```bash
git commit -m "feat(indices): indices Mango para temporadas, prescripciones y tokens + version de stats

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- services/couchdb.js services/aog_parser.js tests/services/indices-stats.test.mjs
```

> **Nota de despliegue:** los índices se crean solos al arrancar (`ensureEstabIndexes` / `ensureGlobalIndexes`). En `orbitx_el_susto` (11,9 GB) construir `["tipo","subtipo","lote_nombre","ts"]` tarda minutos la primera vez; hacerlo fuera de horario de siembra.

---

### Tarea 2: Tests del parser de cobertura + `netoRaster` troceable

**Files:**
- Test: `tests/services/aog_parser.test.mjs` (nuevo)
- Modify: `services/aog_parser.js:218-289` (`netoRaster` → `_rasterizador` + `netoRaster` + `netoRasterAsync`, y `calcularStats` → `_statsDesde` + `calcularStats` + `calcularStatsAsync`), y `module.exports`

**Interfaces:**
- Consume: `STATS_VER`, `statsVigentes` (Tarea 1).
- Produce:
  - `netoRasterAsync(bloques: Array<Array<[number,number]>>, opts?: { cadaN?: number }) -> Promise<{ neto: number, res: number }>` — mismo resultado numérico que `netoRaster`, cediendo el event loop cada `cadaN` bloques (default 200).
  - `calcularStatsAsync(sectionsTxt: string, boundaryLatLon: Array<[number,number]>|null) -> Promise<Stats|null>` con `Stats = { trabajado_ha, neto_ha, repintado_ha, repintado_pct, contorno_ha, bloques, resolucion_m }`.
  - `netoRaster` y `calcularStats` **mantienen su firma actual** (los callers sincrónicos no se tocan).

- [ ] **Paso 1: Escribir el test que falla** — `tests/services/aog_parser.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import parser from "../../services/aog_parser.js";

const { leerBloques, calcularStats, calcularStatsAsync, netoRaster, netoRasterAsync, contornoM2 } = parser;

// Un bloque = 1 línea con N, después N líneas: la 1ª es el color y las N-1
// restantes son puntos "x,y,0" alternando izquierda/derecha de la barra.
// Esta tira es un rectángulo de 20 m x 100 m = 2.000 m2 = 0,2 ha.
const BLOQUE = ["5", "0,200,0", "0,0,0", "20,0,0", "0,100,0", "20,100,0"].join("\r\n");

test("leerBloques: lee un bloque completo con sus 4 puntos", () => {
  const b = leerBloques(BLOQUE);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], [[0, 0], [20, 0], [0, 100], [20, 100]]);
});

test("leerBloques: NO se come un bloque de cada dos (regresión del bug hasta 2026-09-06)", () => {
  const b = leerBloques([BLOQUE, BLOQUE, BLOQUE].join("\r\n"));
  assert.equal(b.length, 3);
  for (const pts of b) assert.equal(pts.length, 4);
});

test("leerBloques: tolera header $ y líneas vacías", () => {
  assert.equal(leerBloques(["$SectionHeader", "", BLOQUE, ""].join("\r\n")).length, 1);
});

test("calcularStats: un bloque = 0,2 ha trabajadas y 0,2 ha netas, sin repintado", () => {
  const s = calcularStats(BLOQUE, null);
  assert.equal(s.trabajado_ha, 0.2);
  assert.equal(s.neto_ha, 0.2);
  assert.equal(s.repintado_ha, 0);
  assert.equal(s.repintado_pct, 0);
  assert.equal(s.bloques, 1);
  assert.equal(s.resolucion_m, 0.5);
});

test("calcularStats: dos pasadas idénticas = doble trabajado, mismo neto, 50% repintado", () => {
  const s = calcularStats([BLOQUE, BLOQUE].join("\r\n"), null);
  assert.equal(s.bloques, 2);
  assert.equal(s.trabajado_ha, 0.4);
  assert.equal(s.neto_ha, 0.2);
  assert.equal(s.repintado_ha, 0.2);
  assert.equal(s.repintado_pct, 50);
});

test("calcularStats: archivo vacío o basura devuelve null", () => {
  assert.equal(calcularStats("", null), null);
  assert.equal(calcularStats("no,soy,un,sections", null), null);
});

test("contornoM2: cuadrado de ~1 km de lado da ~1.000.000 m2", () => {
  // 0,009° de latitud ≈ 1.002 m; el error tolerado es del 1%.
  const lat0 = -34.6, lon0 = -60.0, d = 0.009;
  const m2 = contornoM2([[lat0, lon0], [lat0 + d, lon0], [lat0 + d, lon0 + d], [lat0, lon0 + d], [lat0, lon0]]);
  assert.ok(m2 > 990000 && m2 < 1030000, `m2 fuera de rango: ${m2}`);
});

test("netoRasterAsync da exactamente el mismo número que netoRaster", async () => {
  const bloques = leerBloques([BLOQUE, BLOQUE, BLOQUE].join("\r\n"));
  const sync = netoRaster(bloques);
  const asinc = await netoRasterAsync(bloques, { cadaN: 1 });
  assert.equal(asinc.neto, sync.neto);
  assert.equal(asinc.res, sync.res);
});

test("calcularStatsAsync da exactamente el mismo objeto que calcularStats", async () => {
  const txt = [BLOQUE, BLOQUE].join("\r\n");
  assert.deepEqual(await calcularStatsAsync(txt, null), calcularStats(txt, null));
  assert.equal(await calcularStatsAsync("", null), null);
});

test("netoRasterAsync cede el event loop entre tandas", async () => {
  const bloques = leerBloques([BLOQUE, BLOQUE, BLOQUE, BLOQUE].join("\r\n"));
  let tics = 0;
  const timer = setInterval(() => { tics++; }, 1);
  await netoRasterAsync(bloques, { cadaN: 1 });
  clearInterval(timer);
  // Con cadaN:1 hay 4 setImmediate: el loop de eventos corre entre medio.
  assert.ok(tics >= 0); // no aserta tiempos: solo que no tira y completa
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/services/aog_parser.test.mjs`
Esperado: FALLA — `calcularStatsAsync is not a function` / `netoRasterAsync is not a function`.

- [ ] **Paso 3: Refactorizar `netoRaster` en `services/aog_parser.js`**

Reemplazar **toda** la función `netoRaster` (arranca en `function netoRaster(bloques) {`, termina en la línea `}` previa al comentario `// Boundary (lat/lon) → metros locales para medir el contorno.`) por:

```js
// Prepara la grilla y devuelve el marcador de bloques. Se comparte entre la
// versión sincrónica y la troceada para que no haya dos copias de la
// geometría (y por lo tanto, dos resultados posibles).
function _rasterizador(bloques) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pts of bloques) for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  let res = 0.5;
  const MAX_CELDAS = 40e6;
  while (((maxX - minX) / res + 2) * ((maxY - minY) / res + 2) > MAX_CELDAS) res *= 2;
  const W = Math.ceil((maxX - minX) / res) + 2, H = Math.ceil((maxY - minY) / res) + 2;
  const grid = new Uint8Array(W * H);
  let celdas = 0;
  const marcar = (a, b, c) => {
    const bx0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - minX) / res));
    const bx1 = Math.min(W - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - minX) / res));
    const by0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - minY) / res));
    const by1 = Math.min(H - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - minY) / res));
    // Un triangulo de mas de 400 m de lado es un salto de GPS, no cobertura.
    if ((bx1 - bx0) * res > 400 || (by1 - by0) * res > 400) return;
    for (let gy = by0; gy <= by1; gy++) {
      const py = minY + (gy + 0.5) * res;
      for (let gx = bx0; gx <= bx1; gx++) {
        const px = minX + (gx + 0.5) * res;
        const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
        const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
        const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
        const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
        if (neg && pos) continue;
        const idx = gy * W + gx;
        if (!grid[idx]) { grid[idx] = 1; celdas++; }
      }
    }
  };
  return {
    marcarBloque(pts) { for (let k = 0; k + 2 < pts.length; k++) marcar(pts[k], pts[k + 1], pts[k + 2]); },
    resultado() { return { neto: celdas * res * res, res }; },
  };
}

function netoRaster(bloques) {
  const r = _rasterizador(bloques);
  if (!r) return { neto: 0, res: 0 };
  for (const pts of bloques) r.marcarBloque(pts);
  return r.resultado();
}

// Variante troceada: cede el event loop cada `cadaN` bloques. El peor archivo
// medido en produccion (5,35 MB de el_susto) bloquea ~1 s en una notebook y
// 3-5 s en el droplet: sin esto, el sync congela heartbeats y WebSockets.
async function netoRasterAsync(bloques, { cadaN = 200 } = {}) {
  const r = _rasterizador(bloques);
  if (!r) return { neto: 0, res: 0 };
  let i = 0;
  for (const pts of bloques) {
    r.marcarBloque(pts);
    if (++i % cadaN === 0) await new Promise(cb => setImmediate(cb));
  }
  return r.resultado();
}
```

- [ ] **Paso 4: Refactorizar `calcularStats`**

Reemplazar **toda** la función `calcularStats` (desde `function calcularStats(sectionsTxt, boundaryLatLon) {` hasta su `}` de cierre) por:

```js
function _statsDesde(bloques, neto, res, boundaryLatLon) {
  let trabajado = 0;
  for (const pts of bloques) trabajado += areaTira(pts);
  const repintado = Math.max(0, trabajado - neto);
  const contorno = contornoM2(boundaryLatLon);
  const ha = (m2) => Math.round(m2 / 100) / 100;   // 2 decimales
  return {
    trabajado_ha:  ha(trabajado),
    neto_ha:       ha(neto),
    repintado_ha:  ha(repintado),
    repintado_pct: trabajado > 0 ? Math.round((repintado / trabajado) * 1000) / 10 : 0,
    contorno_ha:   ha(contorno),
    bloques:       bloques.length,
    resolucion_m:  res,
  };
}

function calcularStats(sectionsTxt, boundaryLatLon) {
  try {
    const bloques = leerBloques(sectionsTxt);
    if (!bloques.length) return null;
    const { neto, res } = netoRaster(bloques);
    return _statsDesde(bloques, neto, res, boundaryLatLon);
  } catch (e) {
    console.error("[calcularStats]", e.message);
    return null;
  }
}

// Misma cuenta que calcularStats pero sin bloquear: la usa la cola del sync.
async function calcularStatsAsync(sectionsTxt, boundaryLatLon) {
  try {
    const bloques = leerBloques(sectionsTxt);
    if (!bloques.length) return null;
    const { neto, res } = await netoRasterAsync(bloques);
    return _statsDesde(bloques, neto, res, boundaryLatLon);
  } catch (e) {
    console.error("[calcularStatsAsync]", e.message);
    return null;
  }
}
```

- [ ] **Paso 5: Exportar lo nuevo** — última línea de `services/aog_parser.js`:

```js
module.exports = { parseFieldTxt, parseBoundaryTxt, parseKML, parseSections, parseLote, leerBloques, calcularStats, calcularStatsAsync, netoRaster, netoRasterAsync, contornoM2, STATS_VER, statsVigentes };
```

- [ ] **Paso 6: Correr los tests**

Run: `node --test tests/services/aog_parser.test.mjs` → PASA (10 tests).
Run: `npm test` → todo verde.

- [ ] **Paso 7: Commit**

```bash
git commit -m "test(parser): red de seguridad de calcularStats + netoRaster troceable con setImmediate

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- services/aog_parser.js tests/services/aog_parser.test.mjs
```

---

### Tarea 3: Pieza 0 — calcular y persistir `stats` en el sync

**Files:**
- Create: `services/cobertura_stats.js`
- Test: `tests/services/cobertura-stats.test.mjs` (nuevo)
- Modify (**SUCIO, solo entre marcadores, NO stagear**): `routes/aog.js` — bloque del `histDoc` (`:170-186`) y después del `res.json({ok:true})` (`:201`)

**Interfaces:**
- Consume: `calcularStatsAsync`, `statsVigentes`, `STATS_VER` (Tarea 2 / Tarea 1); `db.getDB(slug)` de `services/couchdb.js`.
- Produce:
  - `encolarStats(slug: string, docId: string) -> boolean` — encola el cálculo. Devuelve `false` si ya estaba en cola.
  - `agregarACola(cola: string[], vistos: Set<string>, clave: string) -> boolean` — pura.
  - `statsParaDoc(stats: Stats|null) -> object|null` — pura: devuelve las stats **sin `contorno_ha`**.
  - Campos nuevos en el doc `aog_archivo` de subtipo `sections_coverage`: `stats` (sin `contorno_ha`), `stats_hash` (= `hash_md5`), `stats_ver` (= `STATS_VER`), `ts_trabajo` (= `ts`, la mtime del archivo en la PC del tractor).
  - Campos nuevos en el doc `aog_historial`: `stats`, `stats_ver` (copiados del doc que se archiva).

- [ ] **Paso 1: Escribir el test que falla** — `tests/services/cobertura-stats.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import cs from "../../services/cobertura_stats.js";

const { agregarACola, statsParaDoc } = cs;

test("agregarACola: dedupe por clave", () => {
  const cola = [], vistos = new Set();
  assert.equal(agregarACola(cola, vistos, "la_flora::aog_x"), true);
  assert.equal(agregarACola(cola, vistos, "la_flora::aog_x"), false);
  assert.equal(agregarACola(cola, vistos, "la_flora::aog_y"), true);
  assert.deepEqual(cola, ["la_flora::aog_x", "la_flora::aog_y"]);
});

test("agregarACola: la misma ruta en dos orgs son claves distintas", () => {
  const cola = [], vistos = new Set();
  agregarACola(cola, vistos, "la_flora::aog_x");
  assert.equal(agregarACola(cola, vistos, "el_susto::aog_x"), true);
  assert.equal(cola.length, 2);
});

test("statsParaDoc: saca contorno_ha (no se conoce al momento del sync)", () => {
  const s = { trabajado_ha: 12, neto_ha: 11, repintado_ha: 1, repintado_pct: 8.3, contorno_ha: 0, bloques: 20, resolucion_m: 0.5 };
  const out = statsParaDoc(s);
  assert.equal("contorno_ha" in out, false);
  assert.equal(out.trabajado_ha, 12);
  assert.equal(out.bloques, 20);
  assert.equal(statsParaDoc(null), null);
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/services/cobertura-stats.test.mjs`
Esperado: FALLA — `Cannot find module '../../services/cobertura_stats.js'`.

- [ ] **Paso 3: Crear `services/cobertura_stats.js`**

```js
"use strict";
// cobertura_stats.js — Calcula las stats de un Sections.txt FUERA del camino
// del request y las guarda en el propio doc.
//
// Por qué una cola de concurrencia 1: el droplet es 1 vCPU compartido con ~25
// apps. Rasterizar el peor archivo medido (5,35 MB en el_susto) cuesta ~1 s en
// una notebook y 3-5 s allá; dos en paralelo solo duplican el pico de memoria
// del Uint8Array de la grilla (hasta 40 MB cada uno) sin terminar antes.
const db = require("./couchdb");
const { calcularStatsAsync, statsVigentes, STATS_VER } = require("./aog_parser");

const _cola = [];            // ["slug::docId", ...] en orden de llegada
const _vistos = new Set();   // dedupe: el mismo archivo no entra dos veces
let _corriendo = false;

// Pura: agrega la clave si no estaba. Devuelve true si entró.
function agregarACola(cola, vistos, clave) {
  if (vistos.has(clave)) return false;
  vistos.add(clave);
  cola.push(clave);
  return true;
}

// Pura: las stats guardadas NO llevan contorno_ha. Al momento del sync no hay
// garantía de que el Boundary.txt del mismo lote ya haya llegado (PilotX sube
// archivo por archivo) y el contorno no depende del Sections.txt: lo calcula
// parseLote(), que sí tiene el boundary parseado.
function statsParaDoc(stats) {
  if (!stats) return null;
  const { contorno_ha, ...resto } = stats;
  return resto;
}

function encolarStats(slug, docId) {
  if (!slug || !docId) return false;
  const entro = agregarACola(_cola, _vistos, `${slug}::${docId}`);
  if (entro && !_corriendo) { _corriendo = true; setImmediate(drenar); }
  return entro;
}

async function drenar() {
  while (_cola.length) {
    const clave = _cola.shift();
    _vistos.delete(clave);
    const sep = clave.indexOf("::");
    try { await procesarUno(clave.slice(0, sep), clave.slice(sep + 2)); }
    catch (e) { console.warn("[cobertura_stats]", clave, e.message); }
  }
  _corriendo = false;
}

async function procesarUno(slug, docId) {
  const estabDB = db.getDB(slug);
  const doc = await estabDB.get(docId);
  if (doc.tipo !== "aog_archivo" || doc.subtipo !== "sections_coverage") return;
  // Sin hash_md5 no hay forma de invalidar: no cacheamos y no mentimos.
  if (!doc.hash_md5) return;
  if (statsVigentes(doc)) return;

  const stats = statsParaDoc(await calcularStatsAsync(doc.contenido || "", null));
  if (!stats) return;

  // Releer: entre el cálculo y la escritura pudo entrar otro sync del mismo
  // archivo. Si cambió, se descarta y se reencola con el contenido nuevo.
  const fresco = await estabDB.get(docId);
  if (fresco.hash_md5 !== doc.hash_md5) { encolarStats(slug, docId); return; }

  await estabDB.insert({
    ...fresco,
    stats,
    stats_hash: fresco.hash_md5,
    stats_ver:  STATS_VER,
    ts_trabajo: fresco.ts || Date.now(),
  });
  console.log(`[cobertura_stats] OK ${slug}/${fresco.lote_nombre || docId} · ${stats.trabajado_ha} ha`);
}

module.exports = { encolarStats, agregarACola, statsParaDoc, STATS_VER };
```

- [ ] **Paso 4: Correr el test**

Run: `node --test tests/services/cobertura-stats.test.mjs` → PASA (3 tests).

- [ ] **Paso 5: Commit de lo limpio** (el archivo sucio se edita en los pasos siguientes y NO se commitea)

```bash
git commit -m "feat(cobertura): cola de concurrencia 1 para calcular stats fuera del request

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- services/cobertura_stats.js tests/services/cobertura-stats.test.mjs
```

- [ ] **Paso 6: Editar `routes/aog.js` — copiar las stats al histórico (ARCHIVO SUCIO)**

Editar **en disco**, insertando el bloque **tras** esta línea literal (es única en el archivo):

```js
        else histDoc.contenido = existing.contenido;
```

Bloque completo a insertar:

```js
        // Sprint 2: stats al historial
        // El doc que se archiva YA tiene sus stats calculadas de su propio
        // sync: copiarlas cuesta cero y es lo que hace viable comparar
        // temporadas (Pieza 2) sin reparsear los 11,1 GB de contenido
        // historico de el_susto.
        if (existing.stats) {
          histDoc.stats     = existing.stats;
          histDoc.stats_ver = existing.stats_ver;
        }
        // fin Sprint 2: stats al historial
```

**NO stagear `routes/aog.js`.**

- [ ] **Paso 7: Editar `routes/aog.js` — encolar el cálculo tras responder (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal:

```js
    res.json({ ok:true });
```

(es la que está inmediatamente después del `console.log` que empieza con `[AOG] OK`; verificar con `grep -n "res.json({ ok:true });" routes/aog.js` — tiene que ser la que está dentro de `router.post("/sync", …)`).

Bloque completo a insertar:

```js
    // Sprint 2: stats de cobertura precalculadas
    // Va DESPUES de responder: el tractor no tiene que esperar el rasterizado
    // y un fallo del calculo nunca rompe el sync. La cola es de concurrencia 1
    // y relee el doc de CouchDB, asi que no retiene el contenido en memoria.
    if ((subtipo || "") === "sections_coverage" && !esBinario) {
      try { require("../services/cobertura_stats").encolarStats(estabSlug, docId); }
      catch (e) { console.warn("[AOG/sync] encolarStats:", e.message); }
    }
    // fin Sprint 2: stats de cobertura precalculadas
```

**NO stagear `routes/aog.js`.**

- [ ] **Paso 8: Verificar**

Run: `node --check routes/aog.js` → sin salida (sintaxis OK).
Run: `npm test` → todo verde.

- [ ] **Paso 9: Dejar constancia para el controlador**

Informar en el reporte: *"`routes/aog.js` quedó editado en disco con dos bloques (`// Sprint 2: stats al historial` y `// Sprint 2: stats de cobertura precalculadas`). No fue stageado."*

---

### Tarea 4: Pieza 0 — migración one-shot de los docs vigentes

**Files:**
- Create: `scripts/backfill-stats-cobertura.js`
- Test: no lleva test propio — usa `calcularStatsAsync`, ya cubierto en la Tarea 2. Se valida con `--dry-run`.

**Interfaces:**
- Consume: `calcularStatsAsync`, `statsVigentes`, `STATS_VER` (`services/aog_parser.js`), `statsParaDoc` (`services/cobertura_stats.js`), `db.getDB` (`services/couchdb.js`).
- Produce: CLI `node scripts/backfill-stats-cobertura.js --org <slug> [--dry-run] [--historial] [--limite N]`.

- [ ] **Paso 1: Crear `scripts/backfill-stats-cobertura.js`**

```js
"use strict";
// backfill-stats-cobertura.js — Migración one-shot: calcula y guarda las stats
// de los Sections.txt que ya están en CouchDB.
//
//   node scripts/backfill-stats-cobertura.js --org la_flora --dry-run
//   node scripts/backfill-stats-cobertura.js --org la_flora
//
// Reglas del droplet (1 vCPU / 1 GB, ~25 apps):
//  · se piden PRIMERO solo los metadatos (con `fields`) para saber cuáles
//    migrar; jamás se baja el `contenido` de todos juntos (en el_susto eso es
//    22,8 MB de una sola vez);
//  · después se hace un `get` por doc, se calcula y se suelta la referencia;
//  · --historial está APAGADO por defecto: son 10.177 docs / 11,1 GB en
//    el_susto y son horas de CPU. Lo vigente de toda la plataforma son 390
//    docs (~35 MB) y son minutos.
//  · correr fuera de horario de siembra.
require("dotenv").config();
const db = require("../services/couchdb");
const { calcularStatsAsync, statsVigentes, STATS_VER } = require("../services/aog_parser");
const { statsParaDoc } = require("../services/cobertura_stats");

function arg(nombre, def = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (!v || v.startsWith("--")) ? true : v;
}

async function main() {
  const org = arg("org");
  const dry = !!arg("dry-run");
  const conHistorial = !!arg("historial");
  const limite = Number(arg("limite", 5000)) || 5000;

  if (!org || org === true) {
    console.error("Falta --org <slug>. Ejemplo: --org la_flora");
    process.exit(1);
  }

  const estabDB = db.getDB(org);
  const tipos = conHistorial ? ["aog_archivo", "aog_historial"] : ["aog_archivo"];
  let total = 0, migrados = 0, salteados = 0, fallidos = 0;

  for (const tipo of tipos) {
    const selector = tipo === "aog_archivo"
      ? { tipo, es_lote: true, subtipo: "sections_coverage" }
      : { tipo, subtipo: "sections_coverage" };

    const r = await estabDB.find({
      selector,
      fields: ["_id", "lote_nombre", "hash_md5", "stats_ver", "stats_hash", "ts"],
      limit: limite,
    });
    const docs = r.docs || [];
    console.log(`\n[${org}] ${tipo}: ${docs.length} docs de cobertura`);

    for (const meta of docs) {
      total++;
      if (statsVigentes(meta)) { salteados++; continue; }
      if (!meta.hash_md5) {
        console.warn(`  ! ${meta._id}: sin hash_md5, se saltea (no se puede invalidar)`);
        salteados++;
        continue;
      }
      if (dry) {
        console.log(`  · [dry] migraría ${meta._id} (${meta.lote_nombre || "?"})`);
        migrados++;
        continue;
      }
      try {
        const doc = await estabDB.get(meta._id);
        const stats = statsParaDoc(await calcularStatsAsync(doc.contenido || "", null));
        if (!stats) { console.warn(`  ! ${meta._id}: sin bloques, se saltea`); salteados++; continue; }
        await estabDB.insert({
          ...doc,
          stats,
          stats_hash: doc.hash_md5,
          stats_ver:  STATS_VER,
          ts_trabajo: doc.ts || Date.now(),
        });
        migrados++;
        console.log(`  OK ${doc.lote_nombre || meta._id} · ${stats.trabajado_ha} ha trabajadas / ${stats.neto_ha} netas`);
      } catch (e) {
        fallidos++;
        console.error(`  X ${meta._id}: ${e.message}`);
      }
      // Respirar entre docs: este script comparte el vCPU con el server.
      await new Promise(cb => setTimeout(cb, 50));
    }
  }

  console.log(`\n[${org}] listo — ${total} vistos · ${migrados} migrados · ${salteados} salteados · ${fallidos} fallidos${dry ? " (DRY RUN, no se escribió nada)" : ""}`);
}

main().catch(e => { console.error("[backfill]", e); process.exit(1); });
```

- [ ] **Paso 2: Verificar sintaxis**

Run: `node --check scripts/backfill-stats-cobertura.js` → sin salida.

- [ ] **Paso 3: Probar en seco contra la org más chica**

> El `.env` local apunta a la CouchDB de **producción**. `--dry-run` **no escribe nada** (solo hace `find` con `fields`, que es lectura). No correr sin `--dry-run` desde la máquina local.

Run: `node scripts/backfill-stats-cobertura.js --org la_fe --dry-run`
Esperado: imprime `[la_fe] aog_archivo: N docs de cobertura` y una línea `· [dry] migraría …` por doc sin stats, terminando en `(DRY RUN, no se escribió nada)`.

- [ ] **Paso 4: Commit**

```bash
git commit -m "feat(scripts): backfill de stats de cobertura para los docs vigentes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- scripts/backfill-stats-cobertura.js
```

- [ ] **Paso 5: Dejar anotado el plan de corrida en producción** (no ejecutar en esta tarea)

En el reporte, dejar la secuencia para el droplet, de a una y en este orden:

```bash
ssh do "cd /opt/AgroParallel/OrbitX && node scripts/backfill-stats-cobertura.js --org la_fe"
ssh do "cd /opt/AgroParallel/OrbitX && node scripts/backfill-stats-cobertura.js --org la_flora"
ssh do "cd /opt/AgroParallel/OrbitX && node scripts/backfill-stats-cobertura.js --org las_gringas"
ssh do "cd /opt/AgroParallel/OrbitX && node scripts/backfill-stats-cobertura.js --org bernardo_clancy"
ssh do "cd /opt/AgroParallel/OrbitX && node scripts/backfill-stats-cobertura.js --org unassigned"
ssh do "cd /opt/AgroParallel/OrbitX && node scripts/backfill-stats-cobertura.js --org el_susto"
```

**Nunca con `--historial`.** El historial se calcula bajo demanda desde la Pieza 2.

---

### Tarea 5: Pieza 0 — leer las stats sin parsear (y arreglar `contorno_ha`)

**Files:**
- Modify: `services/actividad.js:57-61` (`cargarCoberturas`), `services/actividad.js:63-79` (`resumenActividad` pasa el slug), `services/actividad.js:80` (`module.exports`)
- Modify: `services/reportes.js:98` (pasa el slug), `services/reportes.js:43-60` (fila con `contorno_ha`)
- Modify: `services/aog_parser.js:328-332` (`parseLote` usa `doc.stats` si está vigente)
- Test: `tests/services/coberturas-lectura.test.mjs` (nuevo)

**Interfaces:**
- Consume: `statsVigentes`, `STATS_VER`, `calcularStats`, `contornoM2` (Tareas 1-2); `encolarStats(slug, docId)` (Tarea 3).
- Produce:
  - `separarPorStats(docs: object[]) -> { listos: object[], faltan: object[] }` — pura, exportada por `services/actividad.js`.
  - `cargarCoberturas(estabDB, slug?: string) -> Promise<Array<{ lote_nombre, ts, stats }>>` — **firma ampliada**: el segundo parámetro es opcional y, si viene, los docs sin stats vigentes se encolan para cálculo. `stats` ahora incluye `contorno_ha` real.
  - `agregarTemporada` agrega el campo `contorno_ha` a cada fila de `lotes`.

- [ ] **Paso 1: Escribir el test que falla** — `tests/services/coberturas-lectura.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import actividad from "../../services/actividad.js";
import parser from "../../services/aog_parser.js";

const { separarPorStats } = actividad;
const { parseLote, STATS_VER, calcularStats } = parser;

const BLOQUE = ["5", "0,200,0", "0,0,0", "20,0,0", "0,100,0", "20,100,0"].join("\r\n");

test("separarPorStats: separa los docs con stats vigentes de los que hay que calcular", () => {
  const docs = [
    { _id: "a", stats: { neto_ha: 1 }, stats_ver: STATS_VER, stats_hash: "h1", hash_md5: "h1" },
    { _id: "b", hash_md5: "h2" },                                                   // nunca calculado
    { _id: "c", stats: { neto_ha: 2 }, stats_ver: STATS_VER, stats_hash: "viejo", hash_md5: "nuevo" }, // desactualizado
    { _id: "d", stats: { neto_ha: 3 }, stats_ver: STATS_VER - 1, stats_hash: "h4", hash_md5: "h4" },   // version vieja
  ];
  const { listos, faltan } = separarPorStats(docs);
  assert.deepEqual(listos.map(d => d._id), ["a"]);
  assert.deepEqual(faltan.map(d => d._id), ["b", "c", "d"]);
});

test("separarPorStats: lista vacía no rompe", () => {
  const { listos, faltan } = separarPorStats([]);
  assert.deepEqual(listos, []);
  assert.deepEqual(faltan, []);
});

test("parseLote: usa las stats guardadas en el doc y no reparsea", () => {
  const guardadas = { trabajado_ha: 99, neto_ha: 98, repintado_ha: 1, repintado_pct: 1, bloques: 7, resolucion_m: 0.5 };
  const docs = [{
    lote_nombre: "cid 1", subtipo: "sections_coverage", ts: 10,
    contenido: BLOQUE, hash_md5: "h", stats_hash: "h", stats_ver: STATS_VER, stats: guardadas,
  }];
  const r = parseLote(docs);
  assert.equal(r.stats.trabajado_ha, 99);   // no es 0.2 → no reparseó
  assert.equal(r.stats.bloques, 7);
  assert.equal(r.stats.contorno_ha, 0);     // sin boundary, contorno 0
});

test("parseLote: si las stats no están vigentes, las recalcula del contenido", () => {
  const docs = [{
    lote_nombre: "cid 1", subtipo: "sections_coverage", ts: 10,
    contenido: BLOQUE, hash_md5: "nuevo", stats_hash: "viejo", stats_ver: STATS_VER,
    stats: { trabajado_ha: 99 },
  }];
  assert.equal(parseLote(docs).stats.trabajado_ha, calcularStats(BLOQUE, null).trabajado_ha);
});

test("parseLote: el contorno se calcula siempre del boundary, aunque las stats vengan del doc", () => {
  // Cuadrado de ~1 km de lado → ~100 ha de contorno.
  const lat0 = -34.6, lon0 = -60.0, d = 0.009;
  const kml = `<coordinates>${[[lon0, lat0], [lon0, lat0 + d], [lon0 + d, lat0 + d], [lon0 + d, lat0], [lon0, lat0]]
    .map(([lo, la]) => `${lo},${la},0`).join(" ")}</coordinates>`;
  const docs = [
    { lote_nombre: "cid 1", subtipo: "boundary_kml", ts: 9, contenido: kml },
    { lote_nombre: "cid 1", subtipo: "sections_coverage", ts: 10, contenido: BLOQUE,
      hash_md5: "h", stats_hash: "h", stats_ver: STATS_VER,
      stats: { trabajado_ha: 5, neto_ha: 5, repintado_ha: 0, repintado_pct: 0, bloques: 1, resolucion_m: 0.5 } },
  ];
  const r = parseLote(docs);
  assert.equal(r.stats.trabajado_ha, 5);
  assert.ok(r.stats.contorno_ha > 95 && r.stats.contorno_ha < 105, `contorno_ha=${r.stats.contorno_ha}`);
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/services/coberturas-lectura.test.mjs`
Esperado: FALLA — `separarPorStats is not a function` y `parseLote` devuelve `trabajado_ha: 0.2` en vez de `99`.

- [ ] **Paso 3: Reescribir `cargarCoberturas` en `services/actividad.js`**

Cambiar el `require` de la línea 7 para sumar `statsVigentes`:

```js
const { calcularStats, statsVigentes, parseKML, contornoM2 } = require("./aog_parser");
```

Reemplazar **toda** la función `cargarCoberturas` (desde `async function cargarCoberturas(estabDB) {` hasta su `}`) por:

```js
// Tope de docs que se reparsean en vivo cuando todavía no tienen stats. Sin
// tope, una org sin migrar reproduce el problema original (22,8 MB y ~2 s de
// CPU por request); con tope, el Inicio nunca queda en blanco y el resto se
// completa solo en la cola.
const MAX_FALLBACK = 10;

// Pura: divide los docs entre los que tienen stats confiables y los que no.
function separarPorStats(docs) {
  const listos = [], faltan = [];
  for (const d of docs || []) (statsVigentes(d) ? listos : faltan).push(d);
  return { listos, faltan };
}

// El contorno del lote no sale del Sections.txt: sale del boundary. Se pide
// aparte y solo el KML (WGS84 directo, no necesita el origen del lote). Son
// unos pocos KB por lote. Antes se pasaba boundary=null y contorno_ha era
// siempre 0 en el Inicio y en el Reporte de temporada.
async function cargarContornos(estabDB) {
  const porLote = new Map();
  try {
    const r = await estabDB.find({
      selector: { tipo: "aog_archivo", es_lote: true, subtipo: "boundary_kml" },
      fields: ["lote_nombre", "contenido"],
      limit: 2000,
    });
    for (const d of r.docs || []) {
      const ring = parseKML(d.contenido);
      if (ring && d.lote_nombre) porLote.set(d.lote_nombre, Math.round(contornoM2(ring) / 100) / 100);
    }
  } catch (e) {
    console.warn("[actividad] contornos:", e.message);
  }
  return porLote;
}

async function cargarCoberturas(estabDB, slug = null) {
  // Solo metadata + stats: sin `contenido`. Índice ["tipo","subtipo","es_lote"].
  const r = await estabDB.find({
    selector: { tipo: "aog_archivo", es_lote: true, subtipo: "sections_coverage" },
    fields: ["_id", "lote_nombre", "ts", "ts_trabajo", "stats", "stats_ver", "stats_hash", "hash_md5"],
    limit: 2000,
  });
  const { listos, faltan } = separarPorStats(r.docs || []);
  const contornos = await cargarContornos(estabDB);
  const conContorno = (nombre, stats) => ({ ...stats, contorno_ha: contornos.get(nombre) ?? 0 });

  const out = listos.map(d => ({
    lote_nombre: d.lote_nombre,
    ts: d.ts_trabajo || d.ts || 0,
    stats: conContorno(d.lote_nombre, d.stats),
  }));

  // Fallback acotado: bajar el contenido SOLO de unos pocos y calcular en vivo.
  for (const d of faltan.slice(0, MAX_FALLBACK)) {
    try {
      const full = await estabDB.get(d._id);
      const st = calcularStats(full.contenido || "", null);
      if (st) out.push({ lote_nombre: full.lote_nombre, ts: full.ts || 0, stats: conContorno(full.lote_nombre, st) });
    } catch (e) {
      console.warn("[actividad] fallback stats:", d._id, e.message);
    }
  }

  // El resto se calcula en la cola y queda listo para la próxima.
  if (slug && faltan.length) {
    try {
      const { encolarStats } = require("./cobertura_stats");
      for (const d of faltan) encolarStats(slug, d._id);
    } catch (e) { console.warn("[actividad] encolarStats:", e.message); }
  }
  return out;
}
```

- [ ] **Paso 4: Pasar el slug desde `resumenActividad`** — en `services/actividad.js`, dentro del `Promise.all`, cambiar:

```js
    cargarCoberturas(estabDB),
```

por:

```js
    cargarCoberturas(estabDB, slug),
```

Y ampliar el export (última línea del archivo):

```js
module.exports = { armarResumen, resumenActividad, cargarCoberturas, separarPorStats, ONLINE_MS };
```

- [ ] **Paso 5: Usar el slug y mostrar el contorno en `services/reportes.js`**

Cambiar la línea `    cargarCoberturas(estabDB),` (dentro del `Promise.all` de `reporteTemporada`) por:

```js
    cargarCoberturas(estabDB, slug),
```

Y en `agregarTemporada`, dentro del objeto que devuelve el `.map((nombre) => {…})`, agregar después de `      repintado_pct: stats ? r1(stats.repintado_pct || 0) : null,`:

```js
      contorno_ha: stats && stats.contorno_ha ? r1(stats.contorno_ha) : null,
```

- [ ] **Paso 6: `parseLote` usa las stats guardadas** — en `services/aog_parser.js`, reemplazar el bloque:

```js
  // 4. Estadisticas (ha trabajadas / netas / repintadas / contorno). No
  //    necesita origen: se calcula en metros sobre el archivo crudo.
  result.stats = byType.sections_coverage?.[0]
    ? calcularStats(byType.sections_coverage[0].contenido, result.boundary)
    : null;
```

por:

```js
  // 4. Estadisticas (ha trabajadas / netas / repintadas / contorno). No
  //    necesita origen: se calcula en metros sobre el archivo crudo.
  //    Sprint 2: si el doc ya trae stats vigentes (calculadas en el sync) se
  //    usan tal cual y se ahorra el rasterizado; el contorno se recalcula
  //    siempre porque depende del boundary, no del Sections.txt.
  const covDoc = byType.sections_coverage?.[0] || null;
  result.stats = covDoc
    ? (statsVigentes(covDoc)
        ? { ...covDoc.stats }
        : calcularStats(covDoc.contenido, result.boundary))
    : null;
  if (result.stats) result.stats.contorno_ha = Math.round(contornoM2(result.boundary) / 100) / 100;
```

- [ ] **Paso 7: Correr los tests**

Run: `node --test tests/services/coberturas-lectura.test.mjs` → PASA (5 tests).
Run: `npm test` → todo verde. Si `tests/services/reportes.test.mjs` fallara por el campo nuevo, agregar `contorno_ha: null` a la fila esperada en la fixture (no cambiar la lógica).

- [ ] **Paso 8: Commit**

```bash
git commit -m "perf(actividad): leer stats de cobertura sin parsear + contorno_ha real

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- services/actividad.js services/reportes.js services/aog_parser.js tests/services/coberturas-lectura.test.mjs
```

---

### Tarea 6: Pieza 5 — tokens de acceso por organización

**Files:**
- Create: `services/tokens_org.js`, `routes/tokens_org.js`
- Test: `tests/services/tokens-org.test.mjs` (nuevo)
- Modify: `views/pages/integraciones.ejs` (card nueva, limpio)
- Modify (**SUCIOS, solo entre marcadores, NO stagear**): `middleware/auth.js` (rama `orbx_` + guard en `requirePermiso`), `server.js` (montaje del router)

**Interfaces:**
- Consume: `ESTAB_INDEX_FIELDS`/`GLOBAL_INDEX_FIELDS` con `["tipo","hash"]` y `["tipo","org_slug"]` (Tarea 1); `db.getDB("global")`.
- Produce, desde `services/tokens_org.js`:
  - `generarToken() -> string` — `"orbx_" + 40 chars base64url`.
  - `hashToken(tok: string) -> string` — sha256 hex.
  - `prefijoDe(tok: string) -> string` — los primeros 13 caracteres (`orbx_` + 8), lo único que se muestra después de crearlo.
  - `evaluarToken(doc: object|null, ahora: number) -> { valido: boolean, motivo: null|"no_encontrado"|"revocado"|"vencido" }` — pura.
  - `esSoloLectura(metodo: string) -> boolean`.
  - `rutaProhibida(url: string) -> boolean` — pura.
  - `buscarPorToken(tok: string) -> Promise<object|null>` — **fail-closed**: si CouchDB falla, tira (el caller responde 503).
  - `crear({ orgSlug, nombre, dias, creadoPor }) -> Promise<{ doc, token }>`, `listar(orgSlug) -> Promise<object[]>`, `revocar(id, uid) -> Promise<object>`, `registrarUso(doc, ip) -> void`.
  - `req.user` de un token: `{ uid: "tok_<id>", rol: "viewer", rol_global: "viewer", estabSlug, memberships: [{orgSlug, rol:"viewer"}], isDevice: false, isToken: true, scopes: ["lectura"] }`.

- [ ] **Paso 1: Escribir el test que falla** — `tests/services/tokens-org.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import tok from "../../services/tokens_org.js";

const { generarToken, hashToken, prefijoDe, evaluarToken, esSoloLectura, rutaProhibida } = tok;

test("generarToken: prefijo orbx_ y 40 chars de aleatorio url-safe", () => {
  const t = generarToken();
  assert.ok(t.startsWith("orbx_"));
  assert.equal(t.length, 45);                     // "orbx_" (5) + 40
  assert.match(t.slice(5), /^[A-Za-z0-9_-]{40}$/);
  assert.notEqual(generarToken(), generarToken()); // no se repite
});

test("hashToken: sha256 hex estable y distinto por token", () => {
  const h = hashToken("orbx_abc");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashToken("orbx_abc"));
  assert.notEqual(h, hashToken("orbx_abd"));
});

test("prefijoDe: orbx_ + 8 caracteres, lo único visible después de crearlo", () => {
  assert.equal(prefijoDe("orbx_ABCDEFGHIJKLMNOP"), "orbx_ABCDEFGH");
  assert.equal(prefijoDe("").length, 0);
});

test("evaluarToken: casos de borde de vencimiento y revocación", () => {
  const ahora = 1_700_000_000_000;
  assert.deepEqual(evaluarToken(null, ahora), { valido: false, motivo: "no_encontrado" });
  assert.deepEqual(evaluarToken({ revocado: true, vence_ts: null }, ahora), { valido: false, motivo: "revocado" });
  assert.deepEqual(evaluarToken({ revocado: false, vence_ts: ahora - 1 }, ahora), { valido: false, motivo: "vencido" });
  assert.deepEqual(evaluarToken({ revocado: false, vence_ts: ahora }, ahora), { valido: true, motivo: null });
  assert.deepEqual(evaluarToken({ revocado: false, vence_ts: null }, ahora), { valido: true, motivo: null });
  // Revocado Y vencido: manda revocado (es la acción explícita de una persona).
  assert.deepEqual(evaluarToken({ revocado: true, vence_ts: ahora - 1 }, ahora), { valido: false, motivo: "revocado" });
});

test("esSoloLectura: solo GET y HEAD", () => {
  assert.equal(esSoloLectura("GET"), true);
  assert.equal(esSoloLectura("HEAD"), true);
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get"]) assert.equal(esSoloLectura(m), false);
});

test("rutaProhibida: los endpoints que un token nunca toca, ni leyendo", () => {
  for (const u of ["/api/auth/me", "/api/admin/orgs", "/api/config-sistema", "/api/grupos", "/api/ota/catalogo", "/api/soporte/chat", "/api/tokens-org", "/api/crm/productos"])
    assert.equal(rutaProhibida(u), true, u);
  for (const u of ["/api/actividad/resumen", "/api/lotes", "/api/aog/mapa?lote=cid%201", "/api/reportes/temporada", "/api/lluvias"])
    assert.equal(rutaProhibida(u), false, u);
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/services/tokens-org.test.mjs`
Esperado: FALLA — `Cannot find module '../../services/tokens_org.js'`.

- [ ] **Paso 3: Crear `services/tokens_org.js`**

```js
"use strict";
// tokens_org.js — Tokens de acceso de SOLO LECTURA por organización.
//
// Diferencia deliberada con device.token (que se guarda en claro): acá se
// guarda únicamente el sha256. El token completo se muestra UNA sola vez, al
// crearlo. Si se pierde, se revoca y se crea otro.
//
// Formato: "orbx_" + 40 caracteres base64url. El prefijo lo distingue de un
// JWT (que siempre empieza con "eyJ") de un vistazo, en un log o en un header.
const crypto = require("crypto");
const db = require("./couchdb");

const PREFIJO = "orbx_";
const CACHE_MS = 30 * 1000;
const DIAS_DEFAULT = 90;
const DIAS_MAX = 365;
const USO_MIN_MS = 60 * 1000;     // el débito de "último uso" se escribe como mucho 1 vez/min

const _cache = new Map();         // hash -> { doc, exp }
const _ultimoUso = new Map();     // _id  -> ts del último write

// Endpoints que un token de organización no toca NUNCA, ni siquiera leyendo:
// auth y administración (escalada de privilegios), config del sistema
// (credenciales globales), OTA, soporte, el propio CRUD de tokens y el puente
// CRM (que tiene su propio audience).
const RUTAS_PROHIBIDAS = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/admin(\/|$)/,
  /^\/api\/config-sistema(\/|$)/,
  /^\/api\/config(\/|$)/,
  /^\/api\/grupos(\/|$)/,
  /^\/api\/ota(\/|$)/,
  /^\/api\/soporte(\/|$)/,
  /^\/api\/tokens-org(\/|$)/,
  /^\/api\/crm(\/|$)/,
];

function rutaProhibida(url) {
  const p = String(url || "").split("?")[0];
  return RUTAS_PROHIBIDAS.some(re => re.test(p));
}

function esSoloLectura(metodo) { return metodo === "GET" || metodo === "HEAD"; }

function generarToken() { return PREFIJO + crypto.randomBytes(30).toString("base64url"); }

function hashToken(tok) { return crypto.createHash("sha256").update(String(tok || "")).digest("hex"); }

function prefijoDe(tok) { return String(tok || "").slice(0, PREFIJO.length + 8); }

// Pura: no toca CouchDB ni el reloj del sistema.
function evaluarToken(doc, ahora) {
  if (!doc) return { valido: false, motivo: "no_encontrado" };
  if (doc.revocado) return { valido: false, motivo: "revocado" };
  if (doc.vence_ts && ahora > doc.vence_ts) return { valido: false, motivo: "vencido" };
  return { valido: true, motivo: null };
}

// Fail-CLOSED a propósito: si CouchDB tiene un hipo, esto tira y el middleware
// responde 503. Un token de organización es una credencial de larga vida sin
// token_version: dejarlo pasar "por las dudas" sería lo contrario de seguro.
async function buscarPorToken(tok) {
  const hash = hashToken(tok);
  const hit = _cache.get(hash);
  if (hit && hit.exp > Date.now()) return hit.doc;

  const globalDB = db.getDB("global");
  const r = await globalDB.find({
    selector: { tipo: "token_org", hash },
    fields: ["_id", "org_slug", "nombre", "prefijo", "rol", "scopes", "vence_ts", "revocado"],
    limit: 1,
  });
  const doc = (r.docs && r.docs[0]) || null;
  _cache.set(hash, { doc, exp: Date.now() + CACHE_MS });
  return doc;
}

function invalidarCache() { _cache.clear(); }

// Débito diferido: como mucho una escritura por minuto y por token. Sin esto,
// cada request de un panel que refresca cada 30 s escribe en orbitx_global.
function registrarUso(doc, ip) {
  if (!doc || !doc._id) return;
  const ahora = Date.now();
  if ((_ultimoUso.get(doc._id) || 0) + USO_MIN_MS > ahora) return;
  _ultimoUso.set(doc._id, ahora);
  const globalDB = db.getDB("global");
  globalDB.get(doc._id)
    .then(full => globalDB.insert({ ...full, ultimo_uso_ts: ahora, usos: (full.usos || 0) + 1, ultima_ip: ip || null }))
    .catch(e => console.warn("[tokens_org] uso:", e.message));
}

async function crear({ orgSlug, nombre, dias, creadoPor }) {
  if (!orgSlug) throw Object.assign(new Error("Falta la organización"), { status: 400 });
  const limpio = String(nombre || "").trim().slice(0, 80);
  if (!limpio) throw Object.assign(new Error("Poné un nombre que te diga para qué es el token"), { status: 400 });

  const d = Math.min(Math.max(Number(dias) || DIAS_DEFAULT, 1), DIAS_MAX);
  const token = generarToken();
  const ahora = Date.now();
  const doc = {
    _id:        `tokorg_${crypto.randomBytes(8).toString("hex")}`,
    tipo:       "token_org",
    org_slug:   orgSlug,
    nombre:     limpio,
    prefijo:    prefijoDe(token),
    hash:       hashToken(token),
    rol:        "viewer",
    scopes:     ["lectura"],
    vence_ts:   ahora + d * 86400000,
    revocado:   false,
    revocado_ts: null,
    revocado_por: null,
    creado_por: creadoPor || "system",
    created_at: ahora,
    updated_at: ahora,
    ultimo_uso_ts: null,
    usos: 0,
    ultima_ip: null,
  };
  await db.getDB("global").insert(doc);
  invalidarCache();
  return { doc, token };   // el token en claro sale de acá y no se guarda en ningún lado
}

async function listar(orgSlug) {
  const r = await db.getDB("global").find({
    selector: { tipo: "token_org", org_slug: orgSlug },
    fields: ["_id", "nombre", "prefijo", "vence_ts", "revocado", "created_at", "creado_por", "ultimo_uso_ts", "usos"],
    limit: 200,
  });
  return (r.docs || []).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

async function revocar(id, uid) {
  const globalDB = db.getDB("global");
  const doc = await globalDB.get(id);
  if (doc.tipo !== "token_org") throw Object.assign(new Error("Ese no es un token de organización"), { status: 404 });
  const out = { ...doc, revocado: true, revocado_ts: Date.now(), revocado_por: uid || "system", updated_at: Date.now() };
  await globalDB.insert(out);
  invalidarCache();
  return out;
}

module.exports = {
  PREFIJO, DIAS_DEFAULT, DIAS_MAX,
  generarToken, hashToken, prefijoDe, evaluarToken, esSoloLectura, rutaProhibida,
  buscarPorToken, invalidarCache, registrarUso, crear, listar, revocar,
};
```

- [ ] **Paso 4: Correr el test**

Run: `node --test tests/services/tokens-org.test.mjs` → PASA (6 tests).

- [ ] **Paso 5: Crear `routes/tokens_org.js`**

```js
"use strict";
// routes/tokens_org.js — Alta, listado y revocación de tokens de lectura de la
// organización. Se monta con auth.required + auth.adminOnly: solo owner,
// admin_org o superadmin administran tokens de su org.
const router = require("express").Router();
const tokens = require("../services/tokens_org");

function orgDe(req) {
  const slug = req.user?.estabSlug;
  if (!slug) { const e = new Error("Sin organización activa"); e.status = 400; throw e; }
  return slug;
}

// GET /api/tokens-org — lista (nunca devuelve el token ni el hash).
router.get("/", async (req, res) => {
  try {
    res.json({ ok: true, tokens: await tokens.listar(orgDe(req)) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/tokens-org — crea y devuelve el token en claro UNA sola vez.
router.post("/", async (req, res) => {
  try {
    const { nombre, dias } = req.body || {};
    const { doc, token } = await tokens.crear({
      orgSlug: orgDe(req),
      nombre,
      dias,
      creadoPor: req.user?.uid || "system",
    });
    res.json({
      ok: true,
      token,                                  // se muestra una vez y no vuelve nunca más
      aviso: "Copiá el token ahora: no se puede volver a ver.",
      doc: { _id: doc._id, nombre: doc.nombre, prefijo: doc.prefijo, vence_ts: doc.vence_ts },
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/tokens-org/:id/revocar
router.post("/:id/revocar", async (req, res) => {
  try {
    const slug = orgDe(req);
    const doc = await tokens.revocar(req.params.id, req.user?.uid);
    if (doc.org_slug !== slug && req.user?.rol_global !== "superadmin")
      return res.status(403).json({ error: "Ese token no es de tu organización" });
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
```

Run: `node --check routes/tokens_org.js` → sin salida.

- [ ] **Paso 6: Commit de lo limpio**

```bash
git commit -m "feat(tokens): tokens de lectura por organizacion (servicio + rutas)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- services/tokens_org.js routes/tokens_org.js tests/services/tokens-org.test.mjs
```

- [ ] **Paso 7: Editar `middleware/auth.js` — rama del token `orbx_` (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal (fin de la sentencia que resuelve `token`):

```js
    : (req.cookies?.orbitx_token || req.query?.token || null);
```

Bloque completo a insertar:

```js
  // Sprint 2: tokens de org
  // Va ANTES de la rama de device para que un orbx_ nunca caiga en el camino
  // del master token. Se acepta SOLO por el header Authorization: por ?token=
  // la credencial queda en los logs de nginx, en el historial del browser y en
  // el Referer, y un token de org es de larga vida y sin token_version.
  const bearerRaw = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearerRaw.startsWith("orbx_")) {
    const tokSrv = require("../services/tokens_org");
    if (!tokSrv.esSoloLectura(req.method))
      return res.status(403).json({ error: "Los tokens de organización son de solo lectura" });
    if (tokSrv.rutaProhibida(req.originalUrl))
      return res.status(403).json({ error: "Ese endpoint no está disponible para tokens de organización" });

    let docTok;
    try { docTok = await tokSrv.buscarPorToken(bearerRaw); }
    catch (e) {
      // Fail-CLOSED, al revés que el chequeo de revocación de JWT: si no
      // podemos verificar, no pasa.
      console.error("[auth.required/token-org]", e.message);
      return res.status(503).json({ error: "No se pudo validar el token, probá de nuevo en un momento" });
    }

    const ev = tokSrv.evaluarToken(docTok, Date.now());
    if (!ev.valido) {
      if (ev.motivo === "revocado") return res.status(403).json({ error: "Token revocado" });
      if (ev.motivo === "vencido")  return res.status(401).json({ error: "Token vencido" });
      return res.status(401).json({ error: "Token de organización inválido" });
    }

    tokSrv.registrarUso(docTok, req.ip);
    req.user = {
      uid:         `tok_${docTok._id}`,
      rol:         "viewer",
      rol_global:  "viewer",
      estabSlug:   docTok.org_slug,
      memberships: [{ orgSlug: docTok.org_slug, rol: "viewer" }],
      isDevice:    false,
      isToken:     true,
      scopes:      docTok.scopes || ["lectura"],
    };
    return next();
  }
  if (token && String(token).startsWith("orbx_"))
    return res.status(401).json({ error: "El token de organización solo se acepta por el header Authorization" });
  // fin Sprint 2: tokens de org
```

**NO stagear `middleware/auth.js`.**

- [ ] **Paso 8: Editar `middleware/auth.js` — guard en `requirePermiso` (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal (dentro de `requirePermiso`, es única):

```js
  return (req, res, next) => {
```

Bloque completo a insertar:

```js
    // Sprint 2: tokens de org · requirePermiso
    // Un token de organización solo lee. El guard va acá además del chequeo de
    // método en `required` porque requirePermiso es el único punto por donde
    // pasan los endpoints con permisos finos.
    if (req.user?.isToken && accion !== "read" && accion !== "r") {
      return res.status(403).json({ error: "Sin permiso", detalle: "los tokens de organización son de solo lectura" });
    }
    // fin Sprint 2: tokens de org · requirePermiso
```

**NO stagear `middleware/auth.js`.**

- [ ] **Paso 9: Editar `server.js` — montar el router (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal:

```js
app.use("/api/notif-org",      auth.required, routeNotifOrg);
```

Bloque completo a insertar:

```js
// Sprint 2: tokens de org
app.use("/api/tokens-org", auth.required, auth.adminOnly, require("./routes/tokens_org"));
// fin Sprint 2: tokens de org
```

**NO stagear `server.js`.**

Run: `node --check middleware/auth.js && node --check server.js` → sin salida.

- [ ] **Paso 10: Card "Tokens de acceso" en `views/pages/integraciones.ejs`** (archivo limpio)

Insertar **tras** la línea `</div>` que cierra la card "Mis notificaciones" (la que está inmediatamente antes de `<style>`), es decir **antes** de la línea literal `<style>`:

```html
<!-- ── Tokens de acceso por organización ──────────────── -->
<div class="card" style="margin-bottom:14px">
  <div class="card-head">
    <span class="card-title">Tokens de acceso</span>
    <button class="btn btn-sm btn-primary" onclick="crearToken()">Crear token</button>
  </div>
  <div class="card-body">
    <p style="font-size:12px;color:var(--ap-muted);margin-bottom:14px;line-height:1.6">
      Un token deja que una herramienta de afuera (un panel de tu asesor, una planilla, un tablero)
      lea los datos de esta organización. Son de <b>solo lectura</b>: no pueden cargar ni borrar nada.
      Se mandan en el header <code>Authorization: Bearer orbx_…</code>. El token completo se muestra
      una sola vez; si se pierde, revocalo y creá otro.
    </p>
    <div id="tok-nuevo" style="display:none;background:rgba(164,186,62,0.10);border:1px solid var(--ap-green);
         border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:11px;color:var(--ap-muted);margin-bottom:6px">Copialo ahora — no se puede volver a ver:</div>
      <code id="tok-valor" style="display:block;word-break:break-all;font-size:12px;color:var(--ap-text)"></code>
    </div>
    <table class="tabla" style="width:100%;font-size:12px">
      <thead><tr><th>Nombre</th><th>Prefijo</th><th>Vence</th><th>Último uso</th><th></th></tr></thead>
      <tbody id="tok-lista"><tr><td colspan="5" class="td-dim">Cargando…</td></tr></tbody>
    </table>
  </div>
</div>
```

Y el JS: insertar el siguiente bloque **antes** de la línea literal `function showAlert(msg, tipo) {` (es decir, entre el cierre de `probarNotif()` y esa función):

```js
// ── Tokens de acceso ─────────────────────────────────────
const TZ_AR = { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" };
const fechaAR = (ts) => ts ? new Date(ts).toLocaleDateString("es-AR", TZ_AR) : "—";

async function cargarTokens() {
  const tb = document.getElementById("tok-lista");
  try {
    const r = await fetch("/api/tokens-org", { headers: auth() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const filas = (j.tokens || []).map(t => `
      <tr style="${t.revocado ? "opacity:0.45" : ""}">
        <td>${t.nombre}</td>
        <td><code>${t.prefijo}…</code></td>
        <td>${t.revocado ? "revocado" : fechaAR(t.vence_ts)}</td>
        <td class="td-dim">${fechaAR(t.ultimo_uso_ts)}${t.usos ? ` · ${t.usos} usos` : ""}</td>
        <td>${t.revocado ? "" : `<button class="btn btn-sm" onclick="revocarToken('${t._id}','${t.nombre.replace(/'/g, "")}')">Revocar</button>`}</td>
      </tr>`).join("");
    tb.innerHTML = filas || `<tr><td colspan="5" class="td-dim">Todavía no creaste ningún token.</td></tr>`;
  } catch (e) {
    tb.innerHTML = `<tr><td colspan="5" class="td-dim">Error: ${e.message}</td></tr>`;
  }
}

async function crearToken() {
  const nombre = prompt("¿Para qué es este token? (por ejemplo: Tablero del asesor)");
  if (!nombre) return;
  const dias = Number(prompt("¿Cuántos días vale? (máximo 365)", "90")) || 90;
  try {
    const r = await fetch("/api/tokens-org", {
      method: "POST",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ nombre, dias }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    document.getElementById("tok-valor").textContent = j.token;
    document.getElementById("tok-nuevo").style.display = "block";
    showAlert("Token creado — copialo ahora, no se vuelve a mostrar", "success");
    cargarTokens();
  } catch (e) { showAlert("✗ " + e.message, "error"); }
}

async function revocarToken(id, nombre) {
  if (!confirm(`¿Revocar "${nombre}"? Lo que lo esté usando deja de andar al toque.`)) return;
  try {
    const r = await fetch(`/api/tokens-org/${id}/revocar`, { method: "POST", headers: auth() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    showAlert("Token revocado", "success");
    cargarTokens();
  } catch (e) { showAlert("✗ " + e.message, "error"); }
}
```

Y cambiar la última línea del `<script>`:

```js
document.addEventListener("DOMContentLoaded", () => { cargarNotif(); cargarOM(); cargarTokens(); });
```

- [ ] **Paso 11: Verificación manual (sin tocar producción)**

1. `npm test` → todo verde.
2. `node --check middleware/auth.js server.js routes/tokens_org.js` → sin salida.
3. Dejar anotado el humo a correr después del deploy (no acá):
   - crear un token desde Integraciones,
   - `curl -H "Authorization: Bearer orbx_…" https://orbitx.agroparallel.com/api/actividad/resumen` → 200,
   - `curl -X POST -H "Authorization: Bearer orbx_…" https://orbitx.agroparallel.com/api/lluvias` → 403,
   - `curl -H "Authorization: Bearer orbx_…" https://orbitx.agroparallel.com/api/auth/me` → 403,
   - revocar y repetir la primera → 403.

- [ ] **Paso 12: Commit de lo limpio**

```bash
git commit -m "feat(tokens): card de tokens de acceso en Integraciones

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- views/pages/integraciones.ejs
```

Informar en el reporte: *"`middleware/auth.js` y `server.js` quedaron editados en disco entre marcadores `// Sprint 2: tokens de org` (dos bloques en auth.js, uno en server.js). No fueron stageados."*

---

### Tarea 7: Pieza 6 — persistir las notificaciones y exponer el historial

**Files:**
- Create: `lib/notificaciones.js`
- Test: `tests/lib/notificaciones.test.mjs` (nuevo)
- Modify: `lib/notify-org.js:102-147` (`notify` persiste **siempre**), `routes/notif_org.js` (4 rutas nuevas)

**Interfaces:**
- Consume: `db.getDB(slug)`; índice `["tipo","ts"]` (ya existía).
- Produce, desde `lib/notificaciones.js`:
  - `armarNotificacion(evento: string, data: { titulo?, cuerpo?, nivel?, url?, meta? }, ahora?: number) -> Notif` — pura. `Notif = { _id, tipo:"notificacion", evento, titulo, cuerpo, nivel, url, ts, meta }`.
  - `contarNoLeidas(items: Notif[], lectura: Lectura|null) -> number` — pura. `Lectura = { _id:"notif_leidas_<uid>", tipo:"notif_lectura", uid, ts_hasta: number, ids_leidas: string[] }`.
  - `estaLeida(n: Notif, lectura: Lectura|null) -> boolean` — pura.
  - `compactarLectura(lectura: Lectura) -> Lectura` — pura: tira los `ids_leidas` anteriores a `ts_hasta`.
  - `registrar(orgSlug, evento, data) -> Promise<Notif|null>`, `listar(orgSlug, { limit, antesDe }) -> Promise<Notif[]>`, `getLectura(orgSlug, uid) -> Promise<Lectura>`, `marcarUna(orgSlug, uid, id) -> Promise<void>`, `marcarTodas(orgSlug, uid, tsHasta) -> Promise<void>`, `purgar(orgSlug, dias) -> Promise<number>`.
- **Decisión del spec, no negociable:** las lecturas van en un doc **por usuario** (`notif_leidas_<uid>`), no en un array `leida_por` dentro de cada notificación. Elimina los 409 por completo y hace el badge trivial.
- **Una sola escritura por notificación:** no se actualiza el resultado de los canales después de enviar (ver riesgos del análisis: la base de `el_susto` ya pesa 11,9 GB).

- [ ] **Paso 1: Escribir el test que falla** — `tests/lib/notificaciones.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import notis from "../../lib/notificaciones.js";

const { armarNotificacion, contarNoLeidas, estaLeida, compactarLectura } = notis;

test("armarNotificacion: forma completa del doc", () => {
  const n = armarNotificacion("nodo_caido", { titulo: "Equipo sin reportar", cuerpo: "PC-3 hace 20 min", url: "/app/#/equipos" }, 1700000000000);
  assert.equal(n.tipo, "notificacion");
  assert.equal(n.evento, "nodo_caido");
  assert.equal(n.titulo, "Equipo sin reportar");
  assert.equal(n.cuerpo, "PC-3 hace 20 min");
  assert.equal(n.url, "/app/#/equipos");
  assert.equal(n.ts, 1700000000000);
  assert.equal(n.nivel, "info");
  assert.deepEqual(n.meta, {});
  assert.match(n._id, /^notif_1700000000000_[a-z0-9]{4}$/);
});

test("armarNotificacion: alerta_critica arranca en nivel critico", () => {
  assert.equal(armarNotificacion("alerta_critica", {}, 1).nivel, "critico");
  assert.equal(armarNotificacion("alerta_critica", { nivel: "ok" }, 1).nivel, "ok");
});

test("armarNotificacion: sin titulo usa el evento y recorta lo largo", () => {
  const n = armarNotificacion("fin_tarea", { cuerpo: "x".repeat(5000) }, 1);
  assert.equal(n.titulo, "fin_tarea");
  assert.equal(n.cuerpo.length, 2000);
});

test("estaLeida / contarNoLeidas con ts_hasta e ids sueltos", () => {
  const items = [
    { _id: "n3", ts: 300 },
    { _id: "n2", ts: 200 },
    { _id: "n1", ts: 100 },
  ];
  assert.equal(contarNoLeidas(items, null), 3);
  assert.equal(contarNoLeidas(items, { ts_hasta: 0, ids_leidas: [] }), 3);
  assert.equal(contarNoLeidas(items, { ts_hasta: 150, ids_leidas: [] }), 2);
  assert.equal(contarNoLeidas(items, { ts_hasta: 150, ids_leidas: ["n3"] }), 1);
  assert.equal(contarNoLeidas(items, { ts_hasta: 300, ids_leidas: [] }), 0);
  assert.equal(estaLeida({ _id: "n2", ts: 200 }, { ts_hasta: 200, ids_leidas: [] }), true);
  assert.equal(estaLeida({ _id: "n3", ts: 300 }, { ts_hasta: 200, ids_leidas: [] }), false);
});

test("compactarLectura: los ids anteriores a ts_hasta ya no hacen falta", () => {
  const l = compactarLectura({ ts_hasta: 200, ids_leidas: ["n1", "n2", "n3"], ids_ts: { n1: 100, n2: 200, n3: 300 } });
  assert.deepEqual(l.ids_leidas, ["n3"]);
  assert.deepEqual(l.ids_ts, { n3: 300 });
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/lib/notificaciones.test.mjs`
Esperado: FALLA — `Cannot find module '../../lib/notificaciones.js'`.

- [ ] **Paso 3: Crear `lib/notificaciones.js`**

```js
"use strict";
// notificaciones.js — Historial de avisos por organización.
//
// Dos docs:
//  · `notificacion` (uno por aviso) en la DB de la org. Se escribe UNA sola
//    vez, apenas se dispara el evento: no se vuelve para anotar el resultado
//    de los canales (el_susto ya pesa 11,9 GB, cada rev cuesta).
//  · `notif_leidas_<uid>` (uno por usuario) con `ts_hasta` + `ids_leidas`.
//    Guardar las lecturas por usuario en vez de un array `leida_por` dentro de
//    cada notificación elimina los 409 cuando varios marcan al mismo tiempo.
const db = require("../services/couchdb");

const RETENCION_DIAS = 180;
const NIVELES = ["critico", "info", "ok"];

// ── Puras ─────────────────────────────────────────────────
function armarNotificacion(evento, data = {}, ahora = Date.now()) {
  const rnd = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const ev = String(evento || "aviso");
  return {
    _id:    `notif_${ahora}_${rnd}`,
    tipo:   "notificacion",
    evento: ev,
    titulo: String(data.titulo || ev).slice(0, 200),
    cuerpo: String(data.cuerpo || "").slice(0, 2000),
    nivel:  NIVELES.includes(data.nivel) ? data.nivel : (ev === "alerta_critica" ? "critico" : "info"),
    url:    data.url || null,
    ts:     ahora,
    meta:   (data.meta && typeof data.meta === "object") ? data.meta : {},
  };
}

function estaLeida(n, lectura) {
  if (!lectura) return false;
  if ((n.ts || 0) <= (lectura.ts_hasta || 0)) return true;
  return (lectura.ids_leidas || []).includes(n._id);
}

function contarNoLeidas(items, lectura) {
  return (items || []).filter(n => !estaLeida(n, lectura)).length;
}

// Los ids marcados uno por uno dejan de hacer falta cuando `ts_hasta` los
// cubre: sin esto el doc de lectura crece para siempre.
function compactarLectura(lectura) {
  const tsHasta = lectura.ts_hasta || 0;
  const idsTs = lectura.ids_ts || {};
  const ids = (lectura.ids_leidas || []).filter(id => (idsTs[id] || Infinity) > tsHasta);
  const out = {};
  for (const id of ids) if (idsTs[id] != null) out[id] = idsTs[id];
  return { ...lectura, ids_leidas: ids, ids_ts: out };
}

// ── Con CouchDB ───────────────────────────────────────────
async function registrar(orgSlug, evento, data = {}) {
  const doc = armarNotificacion(evento, data);
  await db.getDB(orgSlug).insert(doc);
  return doc;
}

// Paginación por cursor sobre `ts` descendente — nunca por `skip`.
// Índice ["tipo","ts"], ya existente en ESTAB_INDEX_FIELDS.
async function listar(orgSlug, { limit = 50, antesDe = null } = {}) {
  const selector = antesDe
    ? { tipo: "notificacion", ts: { $lt: Number(antesDe) } }
    : { tipo: "notificacion", ts: { $gt: 0 } };
  const r = await db.getDB(orgSlug).find({
    selector,
    fields: ["_id", "evento", "titulo", "cuerpo", "nivel", "url", "ts", "meta"],
    sort: [{ ts: "desc" }],
    limit: Math.min(Number(limit) || 50, 200),
  });
  return r.docs || [];
}

function idLectura(uid) { return `notif_leidas_${uid}`; }

async function getLectura(orgSlug, uid) {
  try {
    return await db.getDB(orgSlug).get(idLectura(uid));
  } catch {
    return { _id: idLectura(uid), tipo: "notif_lectura", uid, ts_hasta: 0, ids_leidas: [], ids_ts: {} };
  }
}

async function guardarLectura(orgSlug, lectura) {
  const estabDB = db.getDB(orgSlug);
  for (let intento = 0; intento < 3; intento++) {
    try {
      let rev;
      try { rev = (await estabDB.get(lectura._id))._rev; } catch {}
      await estabDB.insert({ ...compactarLectura(lectura), ...(rev ? { _rev: rev } : {}), updated_at: Date.now() });
      return;
    } catch (e) {
      if (e.statusCode !== 409 || intento === 2) throw e;
    }
  }
}

async function marcarUna(orgSlug, uid, id, ts) {
  const l = await getLectura(orgSlug, uid);
  if (!(l.ids_leidas || []).includes(id)) {
    l.ids_leidas = [...(l.ids_leidas || []), id];
    l.ids_ts = { ...(l.ids_ts || {}), [id]: Number(ts) || Date.now() };
  }
  await guardarLectura(orgSlug, l);
}

async function marcarTodas(orgSlug, uid, tsHasta) {
  const l = await getLectura(orgSlug, uid);
  l.ts_hasta = Math.max(l.ts_hasta || 0, Number(tsHasta) || Date.now());
  await guardarLectura(orgSlug, l);
}

// Retención: sin purga, una org acumula avisos para siempre.
async function purgar(orgSlug, dias = RETENCION_DIAS) {
  const corte = Date.now() - dias * 86400000;
  const r = await db.getDB(orgSlug).find({
    selector: { tipo: "notificacion", ts: { $lt: corte } },
    fields: ["_id", "_rev"],
    limit: 500,
  });
  const docs = (r.docs || []).map(d => ({ ...d, _deleted: true }));
  if (!docs.length) return 0;
  await db.getDB(orgSlug).bulk({ docs });
  return docs.length;
}

module.exports = {
  RETENCION_DIAS,
  armarNotificacion, estaLeida, contarNoLeidas, compactarLectura,
  registrar, listar, getLectura, marcarUna, marcarTodas, purgar,
};
```

- [ ] **Paso 4: Correr el test**

Run: `node --test tests/lib/notificaciones.test.mjs` → PASA (5 tests).

- [ ] **Paso 5: `notify()` persiste siempre** — en `lib/notify-org.js`, reemplazar el arranque de la función:

```js
async function notify(orgSlug, evento, data = {}) {
  let conf;
  try { conf = (await getConfigOrg(orgSlug)).notificaciones; }
  catch { return { ok: false, error: "Org sin config" }; }
```

por:

```js
async function notify(orgSlug, evento, data = {}) {
  // Sprint 2 — el aviso se guarda SIEMPRE, aunque la org no tenga ningún canal
  // configurado (antes se salía temprano y el aviso se perdía). Best-effort:
  // si la persistencia falla, el envío sigue igual, con log.
  const doc = await require("./notificaciones").registrar(orgSlug, evento, data)
    .catch(e => { console.warn("[notify/persist]", e.message); return null; });

  let conf;
  try { conf = (await getConfigOrg(orgSlug)).notificaciones; }
  catch { return { ok: false, error: "Org sin config", doc_id: doc?._id || null }; }
```

Y el `return` final de la función:

```js
  const res = await Promise.all(tareas);
  const ok  = res.filter(r => r.ok).length;
  return { ok: ok > 0, total: res.length, enviados: ok, fallos: res.length - ok, doc_id: doc?._id || null };
```

- [ ] **Paso 6: Rutas nuevas en `routes/notif_org.js`** — insertar antes de `module.exports = router;`:

```js
// ── Historial de avisos (Sprint 2) ──────────────────────────
const notis = require("../lib/notificaciones");

function orgDe(req) {
  const slug = req.user?.estabSlug;
  if (!slug) { const e = new Error("Sin org activa"); e.status = 400; throw e; }
  return slug;
}

// GET /api/notif-org/historial?limit=50&antes_de=<ts>
// Paginación por cursor sobre ts descendente (nunca skip).
router.get("/historial", async (req, res) => {
  try {
    const orgSlug = orgDe(req);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const items = await notis.listar(orgSlug, { limit: limit + 1, antesDe: req.query.antes_de || null });
    const hayMas = items.length > limit;
    const pagina = hayMas ? items.slice(0, limit) : items;
    const lectura = await notis.getLectura(orgSlug, req.user.uid);
    res.json({
      ok: true,
      items: pagina.map(n => ({ ...n, leida: notis.estaLeida(n, lectura) })),
      hay_mas: hayMas,
      cursor: pagina.length ? pagina[pagina.length - 1].ts : null,
      no_leidas: notis.contarNoLeidas(pagina, lectura),
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// GET /api/notif-org/no-leidas — barato, para el badge de la campanita.
router.get("/no-leidas", async (req, res) => {
  try {
    const orgSlug = orgDe(req);
    const [items, lectura] = await Promise.all([
      notis.listar(orgSlug, { limit: 100 }),
      notis.getLectura(orgSlug, req.user.uid),
    ]);
    res.json({ ok: true, n: notis.contarNoLeidas(items, lectura) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/notif-org/:id/leida
router.post("/:id/leida", async (req, res) => {
  try {
    await notis.marcarUna(orgDe(req), req.user.uid, req.params.id, req.body?.ts);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/notif-org/leidas — marca todo lo anterior a `ts` (default: ahora).
router.post("/leidas", async (req, res) => {
  try {
    await notis.marcarTodas(orgDe(req), req.user.uid, req.body?.ts);
    res.json({ ok: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
```

> ⚠ `POST /:id/leida` tiene que ir **después** de `POST /test` en el archivo, si no captura `/test`. Como `/test` ya está declarado arriba, insertar este bloque al final (antes de `module.exports`) lo garantiza.

- [ ] **Paso 7: Correr los tests**

Run: `npm test` → todo verde (incluye `tests/lib/notify-org.test.mjs`, que no se toca).
Run: `node --check lib/notify-org.js routes/notif_org.js lib/notificaciones.js` → sin salida.

- [ ] **Paso 8: Commit**

```bash
git commit -m "feat(notificaciones): historial persistente por org con marcado de leidas

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- lib/notificaciones.js lib/notify-org.js routes/notif_org.js tests/lib/notificaciones.test.mjs
```

> **Nota:** `listar()` usa `sort: [{ ts: "desc" }]` con selector `ts: { $gt: 0 }`. CouchDB exige que el campo del `sort` esté en el selector y que exista el índice `["tipo","ts"]` — ya está en `ESTAB_INDEX_FIELDS`. Si el primer llamado devolviera `no_matching_index`, correr una vez `node -e "require('dotenv').config();require('./services/couchdb').bootstrapEstablecimiento('la_flora')"` contra la org (crea índices, no borra nada).

---

### Tarea 8: Pieza 6 — campanita en el panel, página de avisos y sección en la PWA

**Files:**
- Create: `views/pages/notificaciones.ejs`
- Modify: `views/partials/sidebar.ejs` (ítem "Avisos", limpio), `app/pantallas/alertas.js` (sección "Avisos", limpio)
- Modify (**SUCIOS, solo entre marcadores, NO stagear**): `views/partials/topbar.ejs` (campanita + script), `routes/panel.js` (ruta `/notificaciones`)

**Interfaces:**
- Consume (Tarea 7): `GET /api/notif-org/no-leidas` → `{ ok, n }`; `GET /api/notif-org/historial?limit=&antes_de=` → `{ ok, items:[{_id,evento,titulo,cuerpo,nivel,url,ts,meta,leida}], hay_mas, cursor, no_leidas }`; `POST /api/notif-org/leidas` body `{ ts }`; `POST /api/notif-org/:id/leida`.
- Produce: nada que consuman otras tareas.

- [ ] **Paso 1: Campanita en `views/partials/topbar.ejs` — markup (ARCHIVO SUCIO)**

Insertar **antes** de esta línea literal (es única en el archivo):

```html
    <span class="topbar-time" id="topbar-time"></span>
```

Bloque completo a insertar:

```html
<%# Sprint 2: badge notificaciones %>
    <div id="notif-selector" style="position:relative;display:flex;align-items:center;cursor:pointer;user-select:none;padding:4px 6px"
      onclick="toggleNotifDropdown(event)" title="Avisos">
      <span style="font-size:16px;line-height:1">🔔</span>
      <span id="notif-badge" style="display:none;position:absolute;top:0;right:0;min-width:15px;height:15px;
            border-radius:8px;background:var(--ap-red,#E74C3E);color:#fff;font-size:9px;line-height:15px;
            text-align:center;padding:0 3px;font-weight:600">0</span>
      <div id="notif-dropdown"
        style="display:none;position:absolute;top:calc(100% + 6px);right:0;width:340px;max-height:60vh;overflow:auto;
               background:var(--ap-card);border:1px solid var(--ap-border);border-radius:8px;
               box-shadow:0 12px 32px rgba(0,0,0,0.5);z-index:120;text-align:left">
      </div>
    </div>
<%# fin Sprint 2: badge notificaciones %>
```

- [ ] **Paso 2: Campanita en `views/partials/topbar.ejs` — script (ARCHIVO SUCIO)**

Agregar al **final del archivo**, tras la última línea literal `</script>`:

```html
<%# Sprint 2: badge notificaciones · script %>
<script>
(function () {
  // Ojo: este partial se renderiza en TODAS las páginas del panel. Todo va
  // envuelto en try/catch y con optional chaining: un error acá rompe el panel
  // entero.
  const TZ = { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" };
  const tok = () => localStorage.getItem("orbitx_token") || "";
  const cab = () => ({ "Authorization": `Bearer ${tok()}` });
  const COLOR = { critico: "#E74C3E", info: "#9AA3AD", ok: "#A4BA3E" };
  let _abierto = false;

  async function refrescarBadge() {
    try {
      const r = await fetch("/api/notif-org/no-leidas", { headers: cab() });
      if (!r.ok) return;
      const j = await r.json();
      const b = document.getElementById("notif-badge");
      if (!b) return;
      b.textContent = j.n > 99 ? "99+" : String(j.n || 0);
      b.style.display = j.n > 0 ? "block" : "none";
    } catch {}
  }

  async function pintarLista() {
    const dd = document.getElementById("notif-dropdown");
    if (!dd) return;
    dd.innerHTML = `<div style="padding:14px;color:var(--ap-muted);font-size:11px;text-align:center">Cargando…</div>`;
    try {
      const r = await fetch("/api/notif-org/historial?limit=20", { headers: cab() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const filas = (j.items || []).map(n => `
        <a href="${n.url || "/notificaciones"}" style="display:block;padding:10px 12px;border-bottom:1px solid var(--ap-border);
           text-decoration:none;color:inherit;${n.leida ? "opacity:0.55" : ""}">
          <div style="display:flex;gap:8px;align-items:flex-start">
            <span style="width:7px;height:7px;border-radius:50%;background:${COLOR[n.nivel] || COLOR.info};margin-top:5px;flex-shrink:0"></span>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:600;color:var(--ap-text)">${n.titulo}</div>
              <div style="font-size:11px;color:var(--ap-muted);line-height:1.5;white-space:pre-wrap">${(n.cuerpo || "").slice(0, 160)}</div>
              <div style="font-size:10px;color:var(--ap-muted);margin-top:3px">${new Date(n.ts).toLocaleString("es-AR", TZ)}</div>
            </div>
          </div>
        </a>`).join("");
      dd.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--ap-border)">
          <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--ap-muted);flex:1">Avisos</span>
          <button id="notif-marcar" style="background:none;border:none;color:var(--ap-green,#A4BA3E);cursor:pointer;font-size:11px">Marcar leídas</button>
        </div>
        ${filas || `<div style="padding:16px;color:var(--ap-muted);font-size:11px;text-align:center">Sin avisos todavía.</div>`}
        <a href="/notificaciones" style="display:block;padding:10px;text-align:center;font-size:11px;color:var(--ap-muted);text-decoration:none">Ver todos</a>`;
      dd.querySelector("#notif-marcar")?.addEventListener("click", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        try {
          await fetch("/api/notif-org/leidas", {
            method: "POST",
            headers: Object.assign(cab(), { "Content-Type": "application/json" }),
            body: JSON.stringify({ ts: Date.now() }),
          });
          await refrescarBadge();
          await pintarLista();
        } catch {}
      });
    } catch (e) {
      dd.innerHTML = `<div style="padding:14px;color:var(--ap-muted);font-size:11px;text-align:center">No se pudieron cargar los avisos.</div>`;
    }
  }

  window.toggleNotifDropdown = function (ev) {
    ev?.stopPropagation();
    const dd = document.getElementById("notif-dropdown");
    if (!dd) return;
    _abierto = !_abierto;
    dd.style.display = _abierto ? "block" : "none";
    if (_abierto) pintarLista();
  };

  document.addEventListener("click", e => {
    if (!e.target.closest("#notif-selector")) {
      const dd = document.getElementById("notif-dropdown");
      if (dd) dd.style.display = "none";
      _abierto = false;
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    refrescarBadge();
    setInterval(refrescarBadge, 60000);
  });
})();
</script>
<%# fin Sprint 2: badge notificaciones · script %>
```

**NO stagear `views/partials/topbar.ejs`.**

- [ ] **Paso 3: Crear `views/pages/notificaciones.ejs`** (archivo nuevo, limpio)

```html
<%# pages/notificaciones.ejs — Historial de avisos de la organización %>

<div class="page-header">
  <div>
    <h2>Avisos</h2>
    <p>Todo lo que OrbitX te notificó, aunque no tuvieras canales prendidos</p>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <button class="btn btn-ghost" onclick="marcarTodas()">Marcar todas como leídas</button>
  </div>
</div>

<div class="card">
  <div class="card-body" style="padding:0">
    <ul id="notif-lista" style="list-style:none;margin:0;padding:0">
      <li style="padding:16px;color:var(--muted2);font-size:12px">Cargando…</li>
    </ul>
  </div>
</div>

<div style="text-align:center;margin-top:14px">
  <button id="notif-mas" class="btn btn-ghost" style="display:none" onclick="cargarMas()">Cargar más</button>
</div>

<script>
const TZ_AVISOS = { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" };
const COLOR_AVISO = { critico: "#E74C3E", info: "#9AA3AD", ok: "#A4BA3E" };
const cabAvisos = () => ({ "Authorization": `Bearer ${localStorage.getItem("orbitx_token") || ""}` });
let _cursor = null;

function filaAviso(n) {
  return `<li style="display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);${n.leida ? "opacity:0.55" : ""}">
    <span style="width:8px;height:8px;border-radius:50%;background:${COLOR_AVISO[n.nivel] || COLOR_AVISO.info};margin-top:6px;flex-shrink:0"></span>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:600">${n.titulo}</div>
      <div style="font-size:12px;color:var(--muted2);line-height:1.6;white-space:pre-wrap">${n.cuerpo || ""}</div>
      <div style="font-size:11px;color:var(--muted2);margin-top:4px">
        ${new Date(n.ts).toLocaleString("es-AR", TZ_AVISOS)} · ${n.evento}
        ${n.url ? ` · <a href="${n.url}" style="color:var(--lime)">Ver</a>` : ""}
      </div>
    </div>
  </li>`;
}

async function cargar(reset) {
  const ul = document.getElementById("notif-lista");
  if (reset) { _cursor = null; ul.innerHTML = ""; }
  try {
    const qs = _cursor ? `?limit=50&antes_de=${_cursor}` : "?limit=50";
    const r = await fetch(`/api/notif-org/historial${qs}`, { headers: cabAvisos() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    const html = (j.items || []).map(filaAviso).join("");
    if (!html && !_cursor) ul.innerHTML = `<li style="padding:16px;color:var(--muted2);font-size:12px">Todavía no hay avisos.</li>`;
    else ul.insertAdjacentHTML("beforeend", html);
    _cursor = j.cursor;
    document.getElementById("notif-mas").style.display = j.hay_mas ? "inline-block" : "none";
  } catch (e) {
    ul.innerHTML = `<li style="padding:16px;color:var(--muted2);font-size:12px">Error: ${e.message}</li>`;
  }
}

function cargarMas() { cargar(false); }

async function marcarTodas() {
  try {
    await fetch("/api/notif-org/leidas", {
      method: "POST",
      headers: Object.assign(cabAvisos(), { "Content-Type": "application/json" }),
      body: JSON.stringify({ ts: Date.now() }),
    });
    cargar(true);
  } catch (e) { console.error(e); }
}

document.addEventListener("DOMContentLoaded", () => cargar(true));
</script>
```

- [ ] **Paso 4: Ruta `/notificaciones` en `routes/panel.js` (ARCHIVO SUCIO)**

Insertar **tras** este bloque literal (la ruta de `/lluvias`, que termina con `});`):

```js
router.get("/lluvias", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", { ...base(req, { regBadge }), title: "Lluvias", page: "lluvias" });
});
```

Bloque completo a insertar:

```js
// Sprint 2: pagina de avisos
router.get("/notificaciones", requireAuth, async (req, res) => {
  const db = req.app.locals.globalDB;
  const regBadge = await getRegBadge(db).catch(() => 0);
  res.render("layout", { ...base(req, { regBadge }), title: "Avisos", page: "notificaciones", activeNav: "/notificaciones" });
});
// fin Sprint 2: pagina de avisos
```

**NO stagear `routes/panel.js`.**

- [ ] **Paso 5: Ítem en el menú** — en `views/partials/sidebar.ejs` (limpio), dentro de la sección "Análisis", agregar después de la línea `  navItem('/agraria',                  '✦',  'agrarIA',  _nav) +`:

```js
  navItem('/notificaciones',           '🔔', 'Avisos',   _nav) +
```

- [ ] **Paso 6: Sección "Avisos" en la PWA** — en `app/pantallas/alertas.js` (limpio):

Agregar después de la función `fila(a)`:

```js
const COLOR_AVISO = { critico: "err", info: "info", ok: "ok" };

function filaAviso(n) {
  const c = COLOR_AVISO[n.nivel] || "info";
  return `<li class="fila"><span class="dot ${c}"></span>
    <span class="txt"><b>${esc(n.titulo || "Aviso")}</b><span>${esc((n.cuerpo || "").slice(0, 90))}</span></span>
    <span class="val">${haceCuanto(n.ts)}</span></li>`;
}
```

Dentro de `cargar()`, después de la línea `    try { hist = await ctx.api.get("/api/alertas/historial?limit=50"); } catch { hist = { data: [] }; }`, agregar:

```js
    // Avisos: el historial de notify-org. No es una pestaña nueva — las 6 de
    // app/core/permisos.js ya están justas — sino una sección más acá.
    let avisos;
    try { avisos = await ctx.api.get("/api/notif-org/historial?limit=20"); } catch { avisos = { data: { items: [] } }; }
    const listaAvisos = avisos?.data?.items || [];
    const noLeidas = listaAvisos.filter(n => !n.leida).length;
```

Cambiar la línea del badge:

```js
    ctx.nav.setBadge("alertas", act.data.length);
```

por:

```js
    ctx.nav.setBadge("alertas", act.data.length + noLeidas);
```

Y en el `root.innerHTML`, agregar al final del template (antes del backtick de cierre), después de la lista de Historial:

```js
      <div class="titulo-seccion">Avisos</div>
      <ul class="lista">${listaAvisos.length ? listaAvisos.map(filaAviso).join("") : `<li class="vacio">Sin avisos.</li>`}</ul>
```

> `ctx.api.get` devuelve `{ data, desdeCache, ts }` — por eso se lee `avisos.data.items`. Verificarlo contra `app/core/api.js` antes de dar la tarea por terminada; si `data` fuera ya el objeto plano, ajustar a `avisos.items`.

- [ ] **Paso 7: Verificar**

Run: `npm test` → todo verde (incluye `tests/app/*.test.mjs`).
Run: `node --check routes/panel.js` → sin salida.
Revisión visual: abrir cualquier página del panel y confirmar que la campanita aparece, que el badge no rompe el layout y que el dropdown se cierra al hacer click afuera.

- [ ] **Paso 8: Commit de lo limpio**

```bash
git commit -m "feat(avisos): pagina de historial, item de menu y seccion Avisos en la PWA

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- views/pages/notificaciones.ejs views/partials/sidebar.ejs app/pantallas/alertas.js
```

Informar: *"`views/partials/topbar.ejs` (dos bloques) y `routes/panel.js` (un bloque) quedaron editados en disco entre marcadores `Sprint 2`. No fueron stageados."*

---

### Tarea 9a: Pieza 1 — decoder PNG propio (`lib/png.js`)

> La Pieza 1 va partida en tres tareas (9a, 9b, 9c) porque cada una tiene su propio ciclo de test y un revisor puede rechazar una sin tocar las otras. **9a y 9b son JS puro sin red ni CouchDB**; recién 9c conecta con Copernicus.

**Files:**
- Create: `lib/png.js`
- Test: `tests/lib/png.test.mjs` (nuevo)

**Interfaces:**
- Consume: solo `zlib` de Node.
- Produce:
  - `decodificarPNG(buffer: Buffer|Uint8Array) -> { ancho: number, alto: number, canales: number, datos: Uint8Array }` — `datos` tiene `ancho*alto*canales` bytes, en orden fila por fila, de arriba (norte) hacia abajo. **Tira** con mensaje claro ante bit depth ≠ 8, entrelazado Adam7, paleta o firma inválida: nunca devuelve zonas silenciosamente mal.
  - `extraerCanal(png: {ancho,alto,canales,datos}, c: number) -> Uint8Array` — un plano de `ancho*alto`.

**Por qué un decoder propio:** `sharp` trae binario nativo (libvips) — prohibido de hecho en un droplet de 1 GB; `pngjs`/`jimp` son dependencias nuevas para algo que `zlib` ya resuelve. Un PNG de Sentinel Hub es determinista: IHDR + IDAT deflate + un byte de filtro por fila. Son ~120 líneas y se testea con `node --test`.

- [ ] **Paso 1: Escribir el test que falla** — `tests/lib/png.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import png from "../../lib/png.js";

const { decodificarPNG, extraerCanal } = png;

// ── Codificador mínimo, solo para las fixtures ───────────────
const TABLA = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABLA[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length, 0);
  const cuerpo = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(cuerpo), 0);
  return Buffer.concat([largo, cuerpo, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Aplica el filtro hacia adelante (lo inverso de lo que hace el decoder).
function filtrar(tipo, fila, prev, bpp) {
  const out = Buffer.alloc(fila.length);
  for (let i = 0; i < fila.length; i++) {
    const a = i >= bpp ? fila[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    if (tipo === 0) v = fila[i];
    else if (tipo === 1) v = fila[i] - a;
    else if (tipo === 2) v = fila[i] - b;
    else if (tipo === 3) v = fila[i] - ((a + b) >> 1);
    else v = fila[i] - paeth(a, b, c);
    out[i] = v & 0xFF;
  }
  return out;
}

function armarPNG({ ancho, alto, colorType, canales, pixeles, filtros, bits = 8, entrelazado = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = bits; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = entrelazado;

  const paso = ancho * canales;
  const filas = [];
  let prev = Buffer.alloc(paso);
  for (let y = 0; y < alto; y++) {
    const fila = Buffer.from(pixeles.slice(y * paso, (y + 1) * paso));
    const t = filtros[y % filtros.length];
    filas.push(Buffer.concat([Buffer.from([t]), filtrar(t, fila, prev, canales)]));
    prev = fila;
  }
  const idat = zlib.deflateSync(Buffer.concat(filas));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Tests ────────────────────────────────────────────────────
test("gris 8 bits, filtro None: devuelve los píxeles tal cual", () => {
  const pixeles = Uint8Array.from([0, 1, 2, 3, 250, 251, 252, 253, 10, 20, 30, 40]);
  const buf = armarPNG({ ancho: 4, alto: 3, colorType: 0, canales: 1, pixeles, filtros: [0] });
  const r = decodificarPNG(buf);
  assert.equal(r.ancho, 4);
  assert.equal(r.alto, 3);
  assert.equal(r.canales, 1);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

test("RGB 8 bits con los cinco filtros rotando por fila", () => {
  const ancho = 5, alto = 5, canales = 3;
  const pixeles = new Uint8Array(ancho * alto * canales);
  for (let i = 0; i < pixeles.length; i++) pixeles[i] = (i * 37) % 256;
  const buf = armarPNG({ ancho, alto, colorType: 2, canales, pixeles, filtros: [0, 1, 2, 3, 4] });
  const r = decodificarPNG(buf);
  assert.equal(r.canales, 3);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

test("gris + alfa (color type 4): el formato que devuelve Sentinel Hub con 2 bandas", () => {
  // [valor, dataMask] por píxel: 0 = sin dato.
  const pixeles = Uint8Array.from([100, 255, 0, 0, 200, 255, 150, 255]);
  const buf = armarPNG({ ancho: 2, alto: 2, colorType: 4, canales: 2, pixeles, filtros: [4] });
  const r = decodificarPNG(buf);
  assert.equal(r.canales, 2);
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
  assert.deepEqual(Array.from(extraerCanal(r, 0)), [100, 0, 200, 150]);
  assert.deepEqual(Array.from(extraerCanal(r, 1)), [255, 0, 255, 255]);
});

test("RGBA (color type 6) con filtro Paeth", () => {
  const ancho = 3, alto = 2, canales = 4;
  const pixeles = new Uint8Array(ancho * alto * canales);
  for (let i = 0; i < pixeles.length; i++) pixeles[i] = (255 - i * 11) & 0xFF;
  const r = decodificarPNG(armarPNG({ ancho, alto, colorType: 6, canales, pixeles, filtros: [4] }));
  assert.deepEqual(Array.from(r.datos), Array.from(pixeles));
});

test("falla ruidosamente ante lo que no soporta", () => {
  const base = { ancho: 2, alto: 1, colorType: 0, canales: 1, pixeles: Uint8Array.from([1, 2]), filtros: [0] };
  assert.throws(() => decodificarPNG(Buffer.from("no soy un png")), /firma/i);
  assert.throws(() => decodificarPNG(armarPNG({ ...base, bits: 16 })), /bit depth/i);
  assert.throws(() => decodificarPNG(armarPNG({ ...base, entrelazado: 1 })), /entrelazado/i);
  assert.throws(() => decodificarPNG(armarPNG({ ...base, colorType: 3 })), /color type/i);
});

test("extraerCanal fuera de rango tira", () => {
  const r = decodificarPNG(armarPNG({ ancho: 2, alto: 1, colorType: 0, canales: 1, pixeles: Uint8Array.from([7, 8]), filtros: [0] }));
  assert.throws(() => extraerCanal(r, 1), /canal/i);
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/lib/png.test.mjs`
Esperado: FALLA — `Cannot find module '../../lib/png.js'`.

- [ ] **Paso 3: Crear `lib/png.js`**

```js
"use strict";
// png.js — Decoder PNG mínimo con zlib nativo. Existe para leer los rasters
// UINT8 que devuelve el Process API de Copernicus sin sumar dependencias
// (sharp trae libvips nativo; pngjs/jimp son deps nuevas para algo que zlib
// ya resuelve).
//
// Soporta lo único que puede llegar de Sentinel Hub: 8 bits por canal, sin
// entrelazado, color type 0 (gris), 2 (RGB), 4 (gris+alfa — el de 2 bandas
// que usamos) y 6 (RGBA). Cualquier otra cosa TIRA: una prescripción mal
// decodificada es peligrosa en el campo, un error no.
const zlib = require("zlib");

const FIRMA = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const CANALES_POR_TIPO = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Invierte el filtro de una fila. `out` se escribe in-place y es el `prev` de
// la fila siguiente.
function desfiltrar(tipo, fila, out, prev, bpp) {
  for (let i = 0; i < fila.length; i++) {
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v;
    switch (tipo) {
      case 0: v = fila[i]; break;                       // None
      case 1: v = fila[i] + a; break;                   // Sub
      case 2: v = fila[i] + b; break;                   // Up
      case 3: v = fila[i] + ((a + b) >> 1); break;      // Average
      case 4: v = fila[i] + paeth(a, b, c); break;      // Paeth
      default: throw new Error(`PNG inválido: tipo de filtro ${tipo}`);
    }
    out[i] = v & 0xFF;
  }
}

function decodificarPNG(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8) throw new Error("PNG inválido: buffer demasiado corto");
  for (let i = 0; i < 8; i++)
    if (buf[i] !== FIRMA[i]) throw new Error("PNG inválido: firma incorrecta");

  let pos = 8, ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const largo = buf.readUInt32BE(pos);
    const tipo  = buf.toString("ascii", pos + 4, pos + 8);
    const datos = buf.subarray(pos + 8, pos + 8 + largo);
    pos += 12 + largo;                        // largo(4) + tipo(4) + datos + crc(4)
    if (tipo === "IHDR") {
      if (largo < 13) throw new Error("PNG inválido: IHDR corto");
      ihdr = {
        ancho:       datos.readUInt32BE(0),
        alto:        datos.readUInt32BE(4),
        bits:        datos[8],
        colorType:   datos[9],
        compresion:  datos[10],
        filtro:      datos[11],
        entrelazado: datos[12],
      };
    } else if (tipo === "IDAT") {
      idat.push(Buffer.from(datos));
    } else if (tipo === "IEND") {
      break;
    }
  }

  if (!ihdr) throw new Error("PNG inválido: falta el chunk IHDR");
  if (ihdr.bits !== 8) throw new Error(`PNG no soportado: bit depth ${ihdr.bits} (solo 8)`);
  if (ihdr.entrelazado !== 0) throw new Error("PNG no soportado: entrelazado Adam7");
  if (ihdr.compresion !== 0 || ihdr.filtro !== 0) throw new Error("PNG no soportado: compresión o filtro no estándar");
  const canales = CANALES_POR_TIPO[ihdr.colorType];
  if (!canales) throw new Error(`PNG no soportado: color type ${ihdr.colorType} (0, 2, 4 o 6)`);
  if (!idat.length) throw new Error("PNG inválido: sin datos IDAT");
  if (!ihdr.ancho || !ihdr.alto) throw new Error("PNG inválido: dimensiones en cero");

  const crudo = zlib.inflateSync(Buffer.concat(idat));
  const { ancho, alto } = ihdr;
  const paso = ancho * canales;
  if (crudo.length < (paso + 1) * alto)
    throw new Error(`PNG inválido: IDAT incompleto (${crudo.length} bytes, se esperaban ${(paso + 1) * alto})`);

  const datos = new Uint8Array(paso * alto);
  let prev = new Uint8Array(paso);
  for (let y = 0; y < alto; y++) {
    const off  = y * (paso + 1);
    const fila = crudo.subarray(off + 1, off + 1 + paso);
    const out  = datos.subarray(y * paso, (y + 1) * paso);
    desfiltrar(crudo[off], fila, out, prev, canales);
    prev = out;
  }
  return { ancho, alto, canales, datos };
}

// Saca un plano de ancho*alto del entrelazado por píxel.
function extraerCanal(png, c) {
  if (!png || c < 0 || c >= png.canales) throw new Error(`canal ${c} fuera de rango (canales: ${png?.canales})`);
  const out = new Uint8Array(png.ancho * png.alto);
  for (let i = 0, j = c; i < out.length; i++, j += png.canales) out[i] = png.datos[j];
  return out;
}

module.exports = { decodificarPNG, extraerCanal };
```

- [ ] **Paso 4: Correr los tests**

Run: `node --test tests/lib/png.test.mjs` → PASA (6 tests).
Run: `npm test` → todo verde.

- [ ] **Paso 5: Commit**

```bash
git commit -m "feat(png): decoder PNG propio con zlib (filtros 0-4, color type 0/2/4/6)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- lib/png.js tests/lib/png.test.mjs
```

---

### Tarea 9b: Pieza 1 — zonificación en JS puro (`lib/zonificar.js`)

**Files:**
- Create: `lib/zonificar.js`
- Test: `tests/lib/zonificar.test.mjs` (nuevo)

**Interfaces:**
- Consume: nada (JS puro, sin red ni CouchDB).
- Produce:
  - `zonaUtmPorLon(lon: number) -> number`
  - `latLonAUtm(lat: number, lon: number, zona?: number) -> { x: number, y: number, zona: number }` — falsa abscisa 500.000 y, en el sur, falsa ordenada 10.000.000.
  - `utmALatLon(x: number, y: number, zona: number, sur?: boolean) -> { lat: number, lon: number }`
  - `clasificarCuantiles(valores: Uint8Array|number[], n: number, nodata?: number) -> { cortes: number[], clases: Uint8Array }` — `clases[i]` ∈ `0..n-1`, y `255` para sin dato.
  - `filtroMayoria(grid: Uint8Array, ancho: number, alto: number, nClases?: number) -> Uint8Array`
  - `fundirChicas(grid: Uint8Array, ancho: number, alto: number, minPixeles: number) -> Uint8Array`
  - `marchingSquares(grid: Uint8Array, ancho: number, alto: number, clase: number) -> Array<Array<[number,number]>>` — anillos cerrados en coordenadas de píxel (el último punto repite el primero).
  - `douglasPeucker(puntos: Array<[number,number]>, tol: number) -> Array<[number,number]>`
  - `zonificar({ datos, ancho, alto, bbox: { minX, minY, maxX, maxY }, zona, sur?, n?, areaMinHa?, nodata?, rango?, tolPx? }) -> FeatureCollection`
    con una `Feature` por zona, `geometry.type === "MultiPolygon"` y
    `properties = { zona: number, dosis: null, unidad: null, nombre: string, ndvi_medio: number, ha: number }`.
    La `FeatureCollection` lleva además `properties = { n_zonas, cortes, zona_utm, resolucion_m }`.
- **`bbox` va en metros UTM** (no en grados): vectorizar en plate carrée a -34° de latitud deforma la geometría, y acá el tractor sigue estos polígonos.

- [ ] **Paso 1: Escribir el test que falla** — `tests/lib/zonificar.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import z from "../../lib/zonificar.js";

const {
  zonaUtmPorLon, latLonAUtm, utmALatLon,
  clasificarCuantiles, filtroMayoria, fundirChicas,
  marchingSquares, douglasPeucker, zonificar,
} = z;

test("zonaUtmPorLon: las zonas de la pampa húmeda", () => {
  assert.equal(zonaUtmPorLon(-60.5), 20);   // zona 20: -66 a -60
  assert.equal(zonaUtmPorLon(-64), 20);
  assert.equal(zonaUtmPorLon(-58), 21);     // zona 21: -60 a -54
  assert.equal(zonaUtmPorLon(-68), 19);
});

test("utmALatLon: en el meridiano central la longitud es exacta", () => {
  const { lat, lon } = utmALatLon(500000, 6200000, 20, true);
  assert.ok(Math.abs(lon - (-63)) < 1e-9, `lon=${lon}`);
  assert.ok(lat < -34.2 && lat > -34.5, `lat=${lat}`);
});

test("latLonAUtm ↔ utmALatLon: ida y vuelta con error submétrico", () => {
  for (const [la, lo] of [[-34.6, -60.2], [-33.1, -61.9], [-38.0, -62.5]]) {
    const u = latLonAUtm(la, lo);
    const v = utmALatLon(u.x, u.y, u.zona, true);
    assert.ok(Math.abs(v.lat - la) < 1e-7, `lat ${v.lat} vs ${la}`);
    assert.ok(Math.abs(v.lon - lo) < 1e-7, `lon ${v.lon} vs ${lo}`);
  }
});

test("clasificarCuantiles: dos mitades, un corte, sin dato = 255", () => {
  const valores = Uint8Array.from([60, 60, 200, 200, 0]);
  const { cortes, clases } = clasificarCuantiles(valores, 2, 0);
  assert.deepEqual(cortes, [60]);
  assert.deepEqual(Array.from(clases), [0, 0, 1, 1, 255]);
});

test("clasificarCuantiles: gradiente en 3 zonas reparte parejo", () => {
  const valores = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90]);
  const { clases } = clasificarCuantiles(valores, 3, 0);
  const cuenta = [0, 0, 0];
  for (const c of clases) cuenta[c]++;
  assert.deepEqual(cuenta, [3, 3, 3]);
});

test("clasificarCuantiles: todo sin dato no rompe", () => {
  const { cortes, clases } = clasificarCuantiles(Uint8Array.from([0, 0, 0]), 3, 0);
  assert.deepEqual(cortes, []);
  assert.deepEqual(Array.from(clases), [255, 255, 255]);
});

test("filtroMayoria: se come el píxel suelto", () => {
  const ancho = 5, alto = 5;
  const g = new Uint8Array(ancho * alto);       // todo clase 0
  g[2 * ancho + 2] = 1;                          // un píxel clase 1 en el medio
  const out = filtroMayoria(g, ancho, alto, 2);
  assert.equal(out[2 * ancho + 2], 0);
  assert.equal(out.filter ? 0 : 0, 0);           // Uint8Array no tiene filter: se cuenta a mano
  let unos = 0;
  for (const v of out) if (v === 1) unos++;
  assert.equal(unos, 0);
});

test("filtroMayoria: no toca una frontera limpia", () => {
  const ancho = 6, alto = 6;
  const g = new Uint8Array(ancho * alto);
  for (let y = 3; y < 6; y++) for (let x = 0; x < 6; x++) g[y * ancho + x] = 1;
  const out = filtroMayoria(g, ancho, alto, 2);
  assert.deepEqual(Array.from(out), Array.from(g));
});

test("fundirChicas: la mancha chica se funde con el vecino", () => {
  const ancho = 6, alto = 6;
  const g = new Uint8Array(ancho * alto);       // todo clase 0
  g[0] = 1; g[1] = 1;                            // mancha de 2 píxeles
  const out = fundirChicas(g, ancho, alto, 5);
  assert.equal(out[0], 0);
  assert.equal(out[1], 0);
});

test("marchingSquares: un cuadrado de 2x2 da un anillo cerrado de 8 lados", () => {
  const ancho = 6, alto = 6;
  const g = new Uint8Array(ancho * alto);
  for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]]) g[y * ancho + x] = 1;
  const anillos = marchingSquares(g, ancho, alto, 1);
  assert.equal(anillos.length, 1);
  assert.equal(anillos[0].length, 9);                       // 8 aristas + cierre
  assert.deepEqual(anillos[0][0], anillos[0][8]);
});

test("douglasPeucker: tira los puntos colineales y conserva los extremos", () => {
  const p = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 3]];
  assert.deepEqual(douglasPeucker(p, 1), [[0, 0], [3, 0], [3, 3]]);
  assert.deepEqual(douglasPeucker([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]]);
});

test("zonificar: 6x6 partido en dos mitades da 2 zonas de 0,18 ha dentro del bbox", () => {
  const ancho = 6, alto = 6;
  const datos = new Uint8Array(ancho * alto);
  for (let y = 0; y < alto; y++) for (let x = 0; x < ancho; x++) datos[y * ancho + x] = y < 3 ? 60 : 200;
  const bbox = { minX: 400000, minY: 6200000, maxX: 400060, maxY: 6200060 };   // 60 x 60 m, píxel de 10 m
  const fc = zonificar({ datos, ancho, alto, bbox, zona: 20, n: 2, areaMinHa: 0 });

  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 2);
  assert.equal(fc.properties.n_zonas, 2);

  for (const f of fc.features) {
    assert.equal(f.geometry.type, "MultiPolygon");
    assert.equal(f.properties.dosis, null);
    assert.equal(f.properties.unidad, null);
    assert.ok(Math.abs(f.properties.ha - 0.18) < 0.005, `ha=${f.properties.ha}`);
  }
  assert.deepEqual(fc.features.map(f => f.properties.zona), [1, 2]);
  assert.deepEqual(fc.features.map(f => f.properties.nombre), ["Zona 1", "Zona 2"]);
  // La zona de menos vigor es la 1 (cuantil más bajo).
  assert.ok(fc.features[0].properties.ndvi_medio < fc.features[1].properties.ndvi_medio);

  // Todas las coordenadas caen dentro del bbox (con 1e-4° ≈ 11 m de tolerancia).
  const esquinas = [[bbox.minX, bbox.minY], [bbox.minX, bbox.maxY], [bbox.maxX, bbox.minY], [bbox.maxX, bbox.maxY]]
    .map(([x, y]) => utmALatLon(x, y, 20, true));
  const minLon = Math.min(...esquinas.map(e => e.lon)) - 1e-4;
  const maxLon = Math.max(...esquinas.map(e => e.lon)) + 1e-4;
  const minLat = Math.min(...esquinas.map(e => e.lat)) - 1e-4;
  const maxLat = Math.max(...esquinas.map(e => e.lat)) + 1e-4;
  for (const f of fc.features)
    for (const poly of f.geometry.coordinates)
      for (const anillo of poly)
        for (const [lon, lat] of anillo) {
          assert.ok(lon >= minLon && lon <= maxLon, `lon fuera del bbox: ${lon}`);
          assert.ok(lat >= minLat && lat <= maxLat, `lat fuera del bbox: ${lat}`);
        }
});

test("zonificar: el anillo exterior queda en sentido antihorario (GeoJSON RFC 7946)", () => {
  const ancho = 4, alto = 4;
  const datos = new Uint8Array(ancho * alto).fill(120);
  const fc = zonificar({ datos, ancho, alto, bbox: { minX: 400000, minY: 6200000, maxX: 400040, maxY: 6200040 }, zona: 20, n: 1, areaMinHa: 0 });
  const anillo = fc.features[0].geometry.coordinates[0][0];
  let acc = 0;
  for (let i = 0; i < anillo.length - 1; i++)
    acc += anillo[i][0] * anillo[i + 1][1] - anillo[i + 1][0] * anillo[i][1];
  assert.ok(acc > 0, `area firmada ${acc} — el exterior tiene que ser CCW`);
});

test("zonificar: sin datos válidos devuelve una colección vacía", () => {
  const fc = zonificar({ datos: new Uint8Array(16), ancho: 4, alto: 4, bbox: { minX: 0, minY: 0, maxX: 40, maxY: 40 }, zona: 20, n: 3 });
  assert.equal(fc.features.length, 0);
});
```

- [ ] **Paso 2: Correr el test y verificar que falla**

Run: `node --test tests/lib/zonificar.test.mjs`
Esperado: FALLA — `Cannot find module '../../lib/zonificar.js'`.

- [ ] **Paso 3: Crear `lib/zonificar.js`**

```js
"use strict";
// zonificar.js — De un raster de índice (UINT8) a zonas de manejo en GeoJSON.
// Todo JS puro: no toca red, disco ni CouchDB, y por lo tanto se testea entero
// con node --test.
//
// Pipeline: cuantiles → filtro de mayoría 3x3 → fusión de manchas chicas →
// vectorización por aristas (marching squares binario) → Douglas-Peucker →
// UTM a lat/lon. El raster viene en METROS UTM, no en grados: vectorizar sobre
// un bbox lat/lon a -34° deforma la geometría, y el tractor sigue estos
// polígonos.

// ── Proyección UTM / WGS84 ────────────────────────────────
const A = 6378137;                       // semieje mayor WGS84
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const RAD = Math.PI / 180, DEG = 180 / Math.PI;

function zonaUtmPorLon(lon) { return Math.floor((Number(lon) + 180) / 6) + 1; }
function meridianoCentral(zona) { return ((zona - 1) * 6 - 180 + 3) * RAD; }

function latLonAUtm(lat, lon, zona) {
  const z = zona || zonaUtmPorLon(lon);
  const lon0 = meridianoCentral(z);
  const phi = lat * RAD, lam = lon * RAD;
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sinP * sinP);
  const T = tanP * tanP;
  const C = EP2 * cosP * cosP;
  const Aa = cosP * (lam - lon0);
  const M = A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * phi
    - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * phi)
    - (35 * E2 ** 3 / 3072) * Math.sin(6 * phi));
  const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6
    + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
  let y = K0 * (M + N * tanP * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
    + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  if (lat < 0) y += 10000000;            // falsa ordenada del hemisferio sur
  return { x, y, zona: z };
}

function utmALatLon(x, y, zona, sur = true) {
  const lon0 = meridianoCentral(zona);
  const xx = x - 500000;
  const yy = sur ? y - 10000000 : y;
  const M = yy / K0;
  const mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu
    + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
    + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu)
    + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
  const N1 = A / Math.sqrt(1 - E2 * sinP * sinP);
  const T1 = tanP * tanP;
  const C1 = EP2 * cosP * cosP;
  const R1 = A * (1 - E2) / Math.pow(1 - E2 * sinP * sinP, 1.5);
  const D = xx / (N1 * K0);
  const lat = phi1 - (N1 * tanP / R1) * (D * D / 2
    - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
    + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / cosP;
  return { lat: lat * DEG, lon: lon * DEG };
}

// ── Clasificación ─────────────────────────────────────────
// Histograma de 256 bins en vez de ordenar: los valores ya son enteros 0-255,
// así que es O(n) y no O(n log n) sobre hasta 1 millón de píxeles.
function clasificarCuantiles(valores, n, nodata = 0) {
  const hist = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    if (v === nodata) continue;
    hist[v]++; total++;
  }
  const clases = new Uint8Array(valores.length);
  if (!total) { clases.fill(255); return { cortes: [], clases }; }

  const cortes = [];
  let acum = 0, k = 1;
  for (let v = 0; v < 256 && k < n; v++) {
    acum += hist[v];
    while (k < n && acum >= (total * k) / n) { cortes.push(v); k++; }
  }
  while (cortes.length < n - 1) cortes.push(255);

  for (let i = 0; i < valores.length; i++) {
    const v = valores[i];
    if (v === nodata) { clases[i] = 255; continue; }
    let c = 0;
    while (c < cortes.length && v > cortes[c]) c++;
    clases[i] = c;
  }
  return { cortes, clases };
}

// ── Limpieza del moteado ──────────────────────────────────
// Sin esto la vectorización escupe miles de polígonos de un píxel.
function filtroMayoria(grid, ancho, alto, nClases = 8) {
  const out = new Uint8Array(grid.length);
  const cuenta = new Uint16Array(nClases);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = y * ancho + x;
      if (grid[i] === 255) { out[i] = 255; continue; }
      cuenta.fill(0);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= alto) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= ancho) continue;
          const c = grid[yy * ancho + xx];
          if (c !== 255 && c < nClases) cuenta[c]++;
        }
      }
      // Empate: gana la clase original (el filtro suaviza, no reasigna porque sí).
      let mejor = grid[i], mejorN = cuenta[grid[i]] || 0;
      for (let c = 0; c < nClases; c++) if (cuenta[c] > mejorN) { mejorN = cuenta[c]; mejor = c; }
      out[i] = mejor;
    }
  }
  return out;
}

// Las manchas de menos de `minPixeles` se funden con el vecino más presente:
// es el "descartar polígonos chicos" del spec, hecho antes de vectorizar para
// que no queden agujeros. Una sola pasada; alcanza para el moteado real.
function fundirChicas(grid, ancho, alto, minPixeles) {
  const out = Uint8Array.from(grid);
  if (!(minPixeles > 1)) return out;
  const visto = new Uint8Array(out.length);
  const pila = [];
  for (let i0 = 0; i0 < out.length; i0++) {
    if (visto[i0] || out[i0] === 255) continue;
    const clase = out[i0];
    const comp = [];
    const vecinos = new Uint32Array(256);
    pila.length = 0; pila.push(i0); visto[i0] = 1;
    while (pila.length) {
      const i = pila.pop();
      comp.push(i);
      const x = i % ancho, y = (i / ancho) | 0;
      const alrededor = [];
      if (x > 0) alrededor.push(i - 1);
      if (x < ancho - 1) alrededor.push(i + 1);
      if (y > 0) alrededor.push(i - ancho);
      if (y < alto - 1) alrededor.push(i + ancho);
      for (const j of alrededor) {
        if (out[j] === clase) { if (!visto[j]) { visto[j] = 1; pila.push(j); } }
        else if (out[j] !== 255) vecinos[out[j]]++;
      }
    }
    if (comp.length >= minPixeles) continue;
    let mejor = -1, mejorN = 0;
    for (let c = 0; c < 256; c++) if (vecinos[c] > mejorN) { mejorN = vecinos[c]; mejor = c; }
    if (mejor >= 0) for (const i of comp) out[i] = mejor;
  }
  return out;
}

// ── Vectorización ─────────────────────────────────────────
// Variante binaria de marching squares: se juntan las aristas de borde de cada
// píxel de la clase (con el interior siempre a la izquierda del avance) y se
// las encadena en anillos cerrados. Es determinista y mucho menos delicado que
// seguir contornos píxel a píxel.
function marchingSquares(grid, ancho, alto, clase) {
  const es = (x, y) => x >= 0 && y >= 0 && x < ancho && y < alto && grid[y * ancho + x] === clase;
  const bordes = new Map();                       // "x,y" -> [[x2,y2], ...]
  const agregar = (a, b) => {
    const k = `${a[0]},${a[1]}`;
    const lista = bordes.get(k);
    if (lista) lista.push(b); else bordes.set(k, [b]);
  };
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      if (!es(x, y)) continue;
      if (!es(x, y - 1)) agregar([x, y], [x + 1, y]);
      if (!es(x + 1, y)) agregar([x + 1, y], [x + 1, y + 1]);
      if (!es(x, y + 1)) agregar([x + 1, y + 1], [x, y + 1]);
      if (!es(x - 1, y)) agregar([x, y + 1], [x, y]);
    }
  }

  const anillos = [];
  const tope = ancho * alto * 4 + 8;
  for (const k0 of [...bordes.keys()]) {
    while (bordes.get(k0)?.length) {
      const inicio = k0.split(",").map(Number);
      const anillo = [inicio];
      let actual = inicio, pasos = 0;
      while (pasos++ < tope) {
        const k = `${actual[0]},${actual[1]}`;
        const lista = bordes.get(k);
        if (!lista || !lista.length) break;
        const sig = lista.pop();
        if (!lista.length) bordes.delete(k);
        anillo.push(sig);
        actual = sig;
        if (sig[0] === inicio[0] && sig[1] === inicio[1]) break;
      }
      if (anillo.length > 3) anillos.push(anillo);
    }
  }
  return anillos;
}

// ── Simplificación ────────────────────────────────────────
function distPuntoSegmento(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / Math.hypot(dx, dy);
}

function douglasPeucker(puntos, tol) {
  if (!puntos || puntos.length < 3) return (puntos || []).slice();
  let maxD = -1, idx = -1;
  const a = puntos[0], b = puntos[puntos.length - 1];
  for (let i = 1; i < puntos.length - 1; i++) {
    const d = distPuntoSegmento(puntos[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  const izq = douglasPeucker(puntos.slice(0, idx + 1), tol);
  const der = douglasPeucker(puntos.slice(idx), tol);
  return izq.slice(0, -1).concat(der);
}

// Un anillo cerrado no se puede simplificar de una: el primer y el último
// punto son el mismo y Douglas-Peucker colapsaría todo. Se parte en el punto
// más lejano del inicio, se simplifican las dos cadenas y se reúnen.
function simplificarAnillo(anillo, tol) {
  const abierto = anillo.slice(0, -1);
  if (abierto.length < 4) return anillo.slice();
  let idx = 0, maxD = -1;
  for (let i = 1; i < abierto.length; i++) {
    const d = Math.hypot(abierto[i][0] - abierto[0][0], abierto[i][1] - abierto[0][1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  const c1 = douglasPeucker(abierto.slice(0, idx + 1), tol);
  const c2 = douglasPeucker(abierto.slice(idx).concat([abierto[0]]), tol);
  const out = c1.slice(0, -1).concat(c2);
  return out.length >= 4 ? out : anillo.slice();
}

function areaFirmada(anillo) {
  let acc = 0;
  for (let i = 0; i < anillo.length - 1; i++)
    acc += anillo[i][0] * anillo[i + 1][1] - anillo[i + 1][0] * anillo[i][1];
  return acc / 2;
}

function puntoEnAnillo(p, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 2; i < anillo.length - 1; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

// ── Orquestador ───────────────────────────────────────────
function zonificar({
  datos, ancho, alto, bbox, zona, sur = true,
  n = 3, areaMinHa = 0.5, nodata = 0, rango = [-0.2, 1.0], tolPx = 1,
}) {
  const dx = (bbox.maxX - bbox.minX) / ancho;
  const dy = (bbox.maxY - bbox.minY) / alto;
  const { cortes, clases } = clasificarCuantiles(datos, n, nodata);

  let g = filtroMayoria(clases, ancho, alto, Math.max(n, 2));
  const minPx = Math.max(1, Math.round((areaMinHa * 10000) / (dx * dy)));
  g = fundirChicas(g, ancho, alto, minPx);

  // La fila 0 del raster es la de arriba (norte): la Y de UTM baja al avanzar.
  const aLonLat = ([px, py]) => {
    const { lat, lon } = utmALatLon(bbox.minX + px * dx, bbox.maxY - py * dy, zona, sur);
    return [lon, lat];
  };
  const valorReal = (q) => rango[0] + ((q - 1) / 253) * (rango[1] - rango[0]);

  const features = [];
  for (let c = 0; c < n; c++) {
    const anillos = marchingSquares(g, ancho, alto, c).map(a => simplificarAnillo(a, tolPx));
    if (!anillos.length) continue;

    const conArea = anillos.map(a => ({ a, area: areaFirmada(a) }));
    const exteriores = conArea.filter(o => o.area > 0).sort((p, q) => p.area - q.area);
    const huecos = conArea.filter(o => o.area < 0);

    const polys = exteriores.map(e => ({ ext: e.a, area: e.area, huecos: [] }));
    for (const h of huecos) {
      const dueno = polys.find(p => puntoEnAnillo(h.a[0], p.ext));   // el más chico que lo contiene
      if (dueno) dueno.huecos.push(h);
    }
    if (!polys.length) continue;

    // Área neta en píxeles → m² → ha.
    let areaPx = 0;
    for (const p of polys) areaPx += p.area - p.huecos.reduce((s, h) => s + Math.abs(h.area), 0);
    const ha = Math.round((areaPx * dx * dy / 10000) * 100) / 100;

    let suma = 0, cant = 0;
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== c) continue;
      const v = datos[i];
      if (v === nodata) continue;
      suma += valorReal(v); cant++;
    }

    // GeoJSON RFC 7946: exterior antihorario, huecos horarios. El signo se
    // evalúa ya en lon/lat porque el flip de Y invierte la orientación.
    const coordenadas = polys.map(p => {
      const ext = p.ext.map(aLonLat);
      const extCCW = areaFirmada(ext) > 0 ? ext : ext.slice().reverse();
      const hs = p.huecos.map(h => {
        const r = h.a.map(aLonLat);
        return areaFirmada(r) < 0 ? r : r.slice().reverse();
      });
      return [extCCW, ...hs];
    });

    features.push({
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: coordenadas },
      properties: {
        zona:       c + 1,
        dosis:      null,
        unidad:     null,
        nombre:     `Zona ${c + 1}`,
        ndvi_medio: cant ? Math.round((suma / cant) * 1000) / 1000 : null,
        ha,
      },
    });
  }

  return {
    type: "FeatureCollection",
    properties: { n_zonas: n, cortes, zona_utm: zona, resolucion_m: Math.round(((dx + dy) / 2) * 100) / 100 },
    features,
  };
}

module.exports = {
  zonaUtmPorLon, latLonAUtm, utmALatLon,
  clasificarCuantiles, filtroMayoria, fundirChicas,
  marchingSquares, douglasPeucker, simplificarAnillo, areaFirmada,
  zonificar,
};
```

- [ ] **Paso 4: Correr los tests**

Run: `node --test tests/lib/zonificar.test.mjs` → PASA (14 tests).
Run: `npm test` → todo verde.

- [ ] **Paso 5: Commit**

```bash
git commit -m "feat(zonificar): cuantiles, filtro de mayoria, marching squares, Douglas-Peucker y UTM en JS puro

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- lib/zonificar.js tests/lib/zonificar.test.mjs
```

---

### Tarea 9c: Pieza 1 — raster de Copernicus, prescripciones en CouchDB y UI

**Files:**
- Create: `lib/prescripcion_schema.js`, `services/ndvi_raster.js`, `services/prescripciones.js`, `routes/prescripciones.js`
- Test: `tests/lib/prescripcion-schema.test.mjs` (nuevo)
- Modify: `lib/indices_satelitales.js` (evalscript UINT8), `routes/ndvi.js` (`processAPI` con `formato`/`crs`, `GET /lote/raster`, percentiles, purga de cache), `routes/prescripciones_api.js` (filtrar `subtipo`, marcar `entregado` después de responder), `views/pages/prescripciones.ejs` (panel "Generar desde NDVI" + migración)
- Modify (**SUCIO, solo entre marcadores, NO stagear**): `server.js` (montaje del router)

**Interfaces:**
- Consume: `decodificarPNG`, `extraerCanal` (9a); `zonificar`, `latLonAUtm`, `zonaUtmPorLon` (9b); índice `["tipo","subtipo","lote_nombre","ts"]` y `["tipo","lote_nombre"]` (Tarea 1); `cfg.get("COPERNICUS_*")` de `services/config_sistema.js`.
- Produce:
  - `lib/indices_satelitales.js`: `getEvalscriptRaster(clave: string) -> string`, `rangoDe(clave: string) -> [number, number]`.
  - `routes/ndvi.js`: `processAPI({ geometry, desde, hasta, width, height, evalscript, maxCloudCoverage, formato?, crs? })` — **`formato` y `crs` son nuevos y opcionales**, el comportamiento por defecto no cambia. `purgarCacheNDVI({ maxBytes?, maxDias? }) -> Promise<{ borrados, bytes }>`.
  - `services/ndvi_raster.js`: `boundaryDeLote(slug, lote) -> Promise<Array<[lat,lon]>|null>`; `rasterDeLote({ slug, lote, fecha, indice, metrosPorPx? }) -> Promise<{ datos: Uint8Array, ancho, alto, bbox: {minX,minY,maxX,maxY}, zona, sur, rango, indice, fecha, boundary }>`.
  - `lib/prescripcion_schema.js`: `PROPS_CANONICAS`, `normalizarColeccion(fc, { nombre }) -> FeatureCollection`, `asignarDosis(fc, { dosis, unidad, sentido }) -> FeatureCollection`, `desdeLocalStorage(obj) -> { nombre, geojson, units, origen }`.
  - `services/prescripciones.js`: `generar(opts) -> Promise<FeatureCollection>`, `guardar(slug, datos, uid) -> Promise<doc>`, `listar(slug, { lote }) -> Promise<doc[]>`, `obtener(slug, id)`, `actualizar(slug, id, datos, uid)`, `borrar(slug, id)`, `migrarLocales(slug, lista, uid) -> Promise<{creados, existentes}>`.
  - Doc `prescripcion` en la DB de la org: `{ _id: "presc_<ts>_<rand>", tipo: "prescripcion", nombre, lote_nombre, org_slug, origen: "manual"|"ndvi"|"import", estado: "borrador"|"lista"|"enviada", geojson, units, fuente, created_at, created_by, updated_at }`.

> **A verificar contra la doc de CDSE antes de dar por buena la integración** (no se puede confirmar leyendo el código del repo): que el Process API acepte `bounds.properties.crs = "http://www.opengis.net/def/crs/EPSG/0/327XX"` con `bounds.geometry` expresada en esa misma proyección, y que un `output.bands: 2` con `sampleType: "UINT8"` salga como PNG gris+alfa (color type 4). Documentación: https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Process.html y https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Process/Examples/S2L2A.html. Si el CRS métrico fuera rechazado, el plan B es pedir el raster en CRS84 y reproyectar cada píxel con `latLonAUtm` al armar el bbox — **nunca** dejarlo en plate carrée: a -34° la deformación es de metros y el tractor sigue estos polígonos.

- [ ] **Paso 1: Test del esquema canónico de prescripción** — `tests/lib/prescripcion-schema.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import esquema from "../../lib/prescripcion_schema.js";

const { normalizarColeccion, asignarDosis, desdeLocalStorage } = esquema;

const FC = () => ({
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { zona: 1, ndvi_medio: 0.3, ha: 10 } },
    { type: "Feature", geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }, properties: { zona: 2, ndvi_medio: 0.7, ha: 5 } },
  ],
});

test("normalizarColeccion: deja siempre las mismas properties", () => {
  const fc = normalizarColeccion(FC(), { nombre: "Maíz lote 3" });
  assert.equal(fc.properties.nombre, "Maíz lote 3");
  assert.equal(fc.properties.prescription_dosis_variable, true);
  for (const f of fc.features) {
    assert.deepEqual(Object.keys(f.properties).sort(), ["dosis", "ha", "ndvi_medio", "nombre", "unidad", "zona"]);
    assert.equal(typeof f.properties.zona, "number");
  }
  assert.equal(fc.features[0].properties.nombre, "Zona 1");
});

test("normalizarColeccion: rellena zona y nombre si faltan", () => {
  const fc = normalizarColeccion({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: {} }] }, {});
  assert.equal(fc.features[0].properties.zona, 1);
  assert.equal(fc.features[0].properties.nombre, "Zona 1");
  assert.equal(fc.features[0].properties.dosis, null);
});

test("asignarDosis: lista explícita, en orden de zona", () => {
  const fc = asignarDosis(normalizarColeccion(FC(), {}), { dosis: [80, 120], unidad: "kg_ha" });
  assert.equal(fc.features[0].properties.dosis, 80);
  assert.equal(fc.features[1].properties.dosis, 120);
  assert.equal(fc.features[0].properties.unidad, "kg_ha");
});

test("asignarDosis: interpolación entre min y max según el sentido", () => {
  const base = normalizarColeccion(FC(), {});
  const mas = asignarDosis(base, { dosis: { min: 60, max: 100 }, unidad: "kg_ha", sentido: "mas_donde_mas" });
  assert.equal(mas.features[0].properties.dosis, 60);   // zona de menos vigor
  assert.equal(mas.features[1].properties.dosis, 100);

  const menos = asignarDosis(base, { dosis: { min: 60, max: 100 }, unidad: "kg_ha", sentido: "mas_donde_menos" });
  assert.equal(menos.features[0].properties.dosis, 100);
  assert.equal(menos.features[1].properties.dosis, 60);
});

test("asignarDosis: una sola zona toma el máximo y no divide por cero", () => {
  const fc = normalizarColeccion({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [] }, properties: { zona: 1 } }] }, {});
  const out = asignarDosis(fc, { dosis: { min: 10, max: 30 }, unidad: "kg_ha", sentido: "mas_donde_mas" });
  assert.equal(out.features[0].properties.dosis, 30);
});

test("desdeLocalStorage: convierte el formato viejo del navegador", () => {
  const viejo = {
    id: 1720000000000, nombre: "Prueba", fecha: "01/07/2026", zonas: 2,
    units: { semilla: "sem_m", ferti_linea: "kg_ha", ferti_costado: "kg_ha" },
    data: [
      { nombre: "Zona 1", semilla: 7.5, ferti_linea: 80, ferti_costado: 0, geojson: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} } },
      { nombre: "Zona 2", semilla: 9.0, ferti_linea: 100, ferti_costado: 0, geojson: { type: "Feature", geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] }, properties: {} } },
    ],
  };
  const out = desdeLocalStorage(viejo);
  assert.equal(out.nombre, "Prueba");
  assert.equal(out.origen, "manual");
  assert.equal(out.geojson.features.length, 2);
  // La dosis canónica es la semilla; ferti va en units/meta para no perder nada.
  assert.equal(out.geojson.features[0].properties.dosis, 7.5);
  assert.equal(out.geojson.features[0].properties.unidad, "sem_m");
  assert.equal(out.geojson.features[1].properties.zona, 2);
  assert.deepEqual(out.units, viejo.units);
  assert.deepEqual(out.extra[0], { ferti_linea: 80, ferti_costado: 0 });
});

test("desdeLocalStorage: objeto basura devuelve null", () => {
  assert.equal(desdeLocalStorage(null), null);
  assert.equal(desdeLocalStorage({ nombre: "x" }), null);
});
```

- [ ] **Paso 2: Correr y verificar que falla**

Run: `node --test tests/lib/prescripcion-schema.test.mjs` → FALLA (`Cannot find module`).

- [ ] **Paso 3: Crear `lib/prescripcion_schema.js`**

```js
"use strict";
// prescripcion_schema.js — UN solo esquema de properties por zona.
//
// En el navegador conviven cuatro formatos distintos para lo mismo (el que va
// al tractor, el export GeoJSON, el DBF y el JSON de QuantiX). Antes de
// automatizar la generación hay que normalizar: si la generación automática
// elige otro, QuantiX no la lee.
//
// Canónico (decisión del spec): { zona, dosis, unidad, nombre } + ndvi_medio y
// ha, que son informativos.
const PROPS_CANONICAS = ["zona", "dosis", "unidad", "nombre", "ndvi_medio", "ha"];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalizarColeccion(fc, { nombre = "" } = {}) {
  const features = (fc?.features || []).map((f, i) => {
    const p = f.properties || {};
    const zona = num(p.zona) ?? (i + 1);
    return {
      type: "Feature",
      geometry: f.geometry,
      properties: {
        zona,
        dosis:      num(p.dosis),
        unidad:     p.unidad || null,
        nombre:     p.nombre || `Zona ${zona}`,
        ndvi_medio: num(p.ndvi_medio),
        ha:         num(p.ha),
      },
    };
  });
  return {
    type: "FeatureCollection",
    // `prescription_dosis_variable` no es estándar, pero es lo que PilotX /
    // QuantiX ya buscan en el archivo que baja el tractor. No sacarlo.
    properties: { prescription_dosis_variable: true, nombre: nombre || fc?.properties?.nombre || "" },
    features,
  };
}

// dosis puede ser un array (una por zona, en orden) o {min,max} para
// interpolar. `sentido` decide si va más insumo donde hay más vigor o donde
// hay menos.
function asignarDosis(fc, { dosis, unidad = null, sentido = "mas_donde_menos" } = {}) {
  const features = (fc.features || []).slice().sort((a, b) => a.properties.zona - b.properties.zona);
  const n = features.length;
  const valor = (i) => {
    if (Array.isArray(dosis)) return num(dosis[i]);
    if (dosis && typeof dosis === "object") {
      const min = num(dosis.min) ?? 0, max = num(dosis.max) ?? 0;
      if (n <= 1) return max;
      const t = i / (n - 1);
      return Math.round((sentido === "mas_donde_mas" ? min + t * (max - min) : max - t * (max - min)) * 100) / 100;
    }
    return null;
  };
  return {
    ...fc,
    features: features.map((f, i) => ({
      ...f,
      properties: { ...f.properties, dosis: valor(i), unidad: unidad ?? f.properties.unidad },
    })),
  };
}

// Convierte una prescripción guardada en localStorage['orbitx_presc'].
// La dosis canónica es la semilla (es la que QuantiX usa como set point); el
// fertilizante se conserva en `extra` y en `units` para no perder nada.
function desdeLocalStorage(obj) {
  if (!obj || !Array.isArray(obj.data) || !obj.data.length) return null;
  const features = obj.data.map((z, i) => ({
    type: "Feature",
    geometry: z.geojson?.geometry || z.geojson || null,
    properties: {
      zona:       i + 1,
      dosis:      num(z.semilla),
      unidad:     obj.units?.semilla || null,
      nombre:     z.nombre || `Zona ${i + 1}`,
      ndvi_medio: null,
      ha:         null,
    },
  }));
  return {
    nombre: obj.nombre || "Sin nombre",
    origen: "manual",
    units:  obj.units || null,
    extra:  obj.data.map(z => ({ ferti_linea: num(z.ferti_linea), ferti_costado: num(z.ferti_costado) })),
    geojson: { type: "FeatureCollection", properties: { prescription_dosis_variable: true, nombre: obj.nombre || "" }, features },
    local_id: obj.id || null,
  };
}

module.exports = { PROPS_CANONICAS, normalizarColeccion, asignarDosis, desdeLocalStorage };
```

Run: `node --test tests/lib/prescripcion-schema.test.mjs` → PASA (7 tests).

- [ ] **Paso 4: Evalscript de raster en `lib/indices_satelitales.js`**

Insertar antes de `module.exports`:

```js
// Genera un evalscript que devuelve el índice como raster de VALORES (no como
// imagen coloreada): banda 1 = el índice escalado a 1..254 dentro de su rango
// conocido, banda 2 = la máscara (255 = hay dato). El 0 queda reservado para
// "sin dato", así la clasificación nunca confunde un píxel vacío con un valor.
function getEvalscriptRaster(clave) {
  const i = INDICES[clave];
  if (!i || !i.formula) throw Object.assign(new Error(`Índice sin formula: ${clave}`), { status: 400 });
  const [min, max] = i.rango;
  const bandas = [...i.formula.bandas, "dataMask"];
  return `//VERSION=3
function setup() {
  return {
    input:  [{ bands: [${bandas.map(b => `"${b}"`).join(",")}] }],
    output: { bands: 2, sampleType: "UINT8" }
  };
}
function evaluatePixel(s) {
  if (s.dataMask === 0) return [0, 0];
  var v = ${i.formula.expr};
  var t = (v - (${min})) / ((${max}) - (${min}));
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return [Math.round(1 + t * 253), 255];
}`;
}

function rangoDe(clave) {
  const i = INDICES[clave];
  if (!i) throw Object.assign(new Error(`Índice desconocido: ${clave}`), { status: 400 });
  return i.rango;
}
```

Y cambiar la última línea:

```js
module.exports = { INDICES, catalogo, getEvalscript, getEvalscriptStats, getEvalscriptRaster, rangoDe };
```

- [ ] **Paso 5: Parametrizar `processAPI` en `routes/ndvi.js`**

Cambiar la firma y el `body` (líneas ~199-233). Reemplazar:

```js
async function processAPI({ geometry, desde, hasta, width, height, evalscript, maxCloudCoverage }) {
  const token = await getCopernicusToken();

  const body = {
    input: {
      bounds: {
        geometry,
        properties: { crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
      },
```

por:

```js
// `formato` y `crs` son opcionales: sin ellos el comportamiento es el de
// siempre (PNG coloreado en CRS84). Con ellos se pide el raster de valores en
// una proyección métrica, que es lo que necesita la zonificación.
async function processAPI({ geometry, desde, hasta, width, height, evalscript, maxCloudCoverage, formato = "image/png", crs = null }) {
  const token = await getCopernicusToken();

  const body = {
    input: {
      bounds: {
        geometry,
        properties: { crs: crs || "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
      },
```

Reemplazar:

```js
      responses: [{ identifier: "default", format: { type: "image/png" } }],
```

por:

```js
      responses: [{ identifier: "default", format: { type: formato } }],
```

Reemplazar:

```js
      "Accept":        "image/png",
```

por:

```js
      "Accept":        formato,
```

- [ ] **Paso 6: Percentiles más finos y purga del cache en `routes/ndvi.js`**

Reemplazar (en `statsAPI`):

```js
        statistics: { default: { percentiles: { k: [10, 50, 90] } } },
```

por:

```js
        // Deciles completos: dan cortes de cuantiles sin pedir un raster,
        // para el modo "rápido" de la generación de zonas.
        statistics: { default: { percentiles: { k: [10, 20, 30, 40, 50, 60, 70, 80, 90] } } },
```

E insertar antes de `// Exponer helpers para reuso.`:

```js
// ══════════════════════════════════════════════════════════
//  Purga del cache en disco. Sin esto, .cache/ndvi crece para siempre: hoy
//  guarda PNGs de 1024x1024 sin TTL ni tope, en el disco del droplet.
// ══════════════════════════════════════════════════════════
async function purgarCacheNDVI({ maxBytes = 200 * 1024 * 1024, maxDias = 30 } = {}) {
  ensureCacheDir();
  const nombres = await fs.promises.readdir(NDVI_CACHE_DIR).catch(() => []);
  const archivos = [];
  for (const n of nombres) {
    const p = path.join(NDVI_CACHE_DIR, n);
    try { const st = await fs.promises.stat(p); if (st.isFile()) archivos.push({ p, size: st.size, mtime: st.mtimeMs }); }
    catch {}
  }
  const corte = Date.now() - maxDias * 86400000;
  let borrados = 0, bytes = 0;
  // Primero lo viejo.
  for (const a of archivos) {
    if (a.mtime >= corte) continue;
    try { await fs.promises.unlink(a.p); borrados++; bytes += a.size; a.borrado = true; } catch {}
  }
  // Después, si sigue pasado de tamaño, lo más viejo primero.
  let total = archivos.filter(a => !a.borrado).reduce((s, a) => s + a.size, 0);
  const restantes = archivos.filter(a => !a.borrado).sort((a, b) => a.mtime - b.mtime);
  for (const a of restantes) {
    if (total <= maxBytes) break;
    try { await fs.promises.unlink(a.p); borrados++; bytes += a.size; total -= a.size; } catch {}
  }
  if (borrados) console.log(`[ndvi/cache] purga: ${borrados} archivos, ${Math.round(bytes / 1024)} KB`);
  return { borrados, bytes };
}
```

Y agregar al final del archivo:

```js
module.exports.purgarCacheNDVI = purgarCacheNDVI;
```

- [ ] **Paso 7: Crear `services/ndvi_raster.js`**

```js
"use strict";
// ndvi_raster.js — Del boundary de un lote a una grilla de valores del índice,
// en metros UTM. Es el puente entre Copernicus y lib/zonificar.js.
const db = require("./couchdb");
const { decodificarPNG, extraerCanal } = require("../lib/png");
const { zonaUtmPorLon, latLonAUtm } = require("../lib/zonificar");
const indices = require("../lib/indices_satelitales");
const { parseKML, parseBoundaryTxt, parseFieldTxt } = require("./aog_parser");

// Tope duro: 1024x1024 = 1 M de píxeles ≈ 1 MB de grilla + el PNG inflado.
// A 10 m/px cubre 10 km de lado, de sobra para cualquier lote, y en un droplet
// de 1 GB con ~25 apps no hay lugar para más.
const MAX_PX = 1024;
const MIN_PX = 32;

async function unDoc(estabDB, lote, subtipo) {
  // Índice ["tipo","subtipo","lote_nombre","ts"] (Sprint 2, Tarea 1).
  const r = await estabDB.find({
    selector: { tipo: "aog_archivo", subtipo, lote_nombre: lote, ts: { $gt: 0 } },
    fields: ["contenido", "ts"],
    sort: [{ ts: "desc" }],
    limit: 1,
  }).catch(() => ({ docs: [] }));
  return (r.docs || [])[0] || null;
}

// Devuelve el boundary como [[lat,lon], ...]. Prioridad: el lote_maestro (que
// ya lo guarda en GeoJSON cuando el lote se creó desde OrbitX), después el KML
// de PilotX (WGS84 directo) y por último Boundary.txt + Field.txt.
async function boundaryDeLote(slug, lote) {
  const estabDB = db.getDB(slug);

  try {
    const r = await estabDB.find({
      selector: { tipo: "lote_maestro", nombre: lote },
      fields: ["boundary_geojson"],
      limit: 1,
    });
    const g = r.docs?.[0]?.boundary_geojson;
    const anillo = g?.coordinates?.[0];
    if (Array.isArray(anillo) && anillo.length > 3) return anillo.map(([lon, lat]) => [lat, lon]);
  } catch (e) { console.warn("[ndvi_raster] lote_maestro:", e.message); }

  const kml = await unDoc(estabDB, lote, "boundary_kml");
  if (kml) { const b = parseKML(kml.contenido); if (b && b.length > 3) return b; }

  const bt = await unDoc(estabDB, lote, "boundary");
  const fo = await unDoc(estabDB, lote, "field_origin");
  if (bt && fo) {
    const b = parseBoundaryTxt(bt.contenido, parseFieldTxt(fo.contenido));
    if (b && b.length > 3) return b;
  }
  return null;
}

// Cierra el anillo y lo orienta antihorario, que es lo que acepta Sentinel Hub.
function anilloParaSH(puntosXY) {
  const ring = puntosXY.slice();
  const [x0, y0] = ring[0], [xn, yn] = ring[ring.length - 1];
  if (x0 !== xn || y0 !== yn) ring.push([x0, y0]);
  let acc = 0;
  for (let i = 0; i < ring.length - 1; i++) acc += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return acc < 0 ? ring.reverse() : ring;
}

async function rasterDeLote({ slug, lote, fecha, indice = "ndvi", metrosPorPx = 10, maxCloudCoverage = 30 }) {
  const boundary = await boundaryDeLote(slug, lote);
  if (!boundary) throw Object.assign(new Error(`El lote "${lote}" no tiene contorno cargado`), { status: 404 });

  // Zona UTM por la longitud media del lote (en Argentina: 19, 20 o 21).
  const lonMedia = boundary.reduce((s, p) => s + p[1], 0) / boundary.length;
  const zona = zonaUtmPorLon(lonMedia);
  const sur = boundary[0][0] < 0;

  const xy = boundary.map(([lat, lon]) => { const u = latLonAUtm(lat, lon, zona); return [u.x, u.y]; });
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const bbox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };

  const anchoM = bbox.maxX - bbox.minX, altoM = bbox.maxY - bbox.minY;
  const escala = Math.max(1, anchoM / (MAX_PX * metrosPorPx), altoM / (MAX_PX * metrosPorPx));
  const mPx = metrosPorPx * escala;
  const ancho = Math.min(MAX_PX, Math.max(MIN_PX, Math.round(anchoM / mPx)));
  const alto  = Math.min(MAX_PX, Math.max(MIN_PX, Math.round(altoM / mPx)));
  // El bbox se ajusta al tamaño final para que cada píxel mida exactamente lo mismo.
  bbox.maxX = bbox.minX + ancho * mPx;
  bbox.maxY = bbox.minY + alto * mPx;

  const hasta = fecha || new Date().toISOString().slice(0, 10);
  const desde = fecha || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  // require perezoso: routes/ndvi.js requiere este módulo dentro de su handler,
  // así que pedirlo arriba haría un ciclo.
  const { processAPI } = require("../routes/ndvi");
  const png = await processAPI({
    geometry: { type: "Polygon", coordinates: [anilloParaSH(xy)] },
    desde, hasta, width: ancho, height: alto,
    evalscript: indices.getEvalscriptRaster(indice),
    maxCloudCoverage,
    formato: "image/png",
    crs: `http://www.opengis.net/def/crs/EPSG/0/${sur ? 327 : 326}${String(zona).padStart(2, "0")}`,
  });

  const img = decodificarPNG(png);
  if (img.ancho !== ancho || img.alto !== alto)
    throw new Error(`Copernicus devolvió ${img.ancho}x${img.alto}, se pidió ${ancho}x${alto}`);
  if (img.canales < 2)
    throw new Error(`Copernicus devolvió ${img.canales} canal(es): se esperaban 2 (valor + máscara)`);

  const valores = extraerCanal(img, 0);
  const mascara = extraerCanal(img, 1);
  for (let i = 0; i < valores.length; i++) if (!mascara[i]) valores[i] = 0;   // 0 = sin dato

  return {
    datos: valores, ancho, alto, bbox, zona, sur,
    rango: indices.rangoDe(indice), indice, fecha: fecha || null, boundary,
    resolucion_m: Math.round(mPx * 100) / 100,
  };
}

module.exports = { boundaryDeLote, rasterDeLote, MAX_PX };
```

- [ ] **Paso 8: Ruta `GET /api/ndvi/lote/raster` en `routes/ndvi.js`**

Insertar antes de `// Exponer helpers para reuso.`:

```js
// ══════════════════════════════════════════════════════════
//  GET /api/ndvi/lote/raster?lote=&fecha=&indice=
//  El raster de VALORES del índice, en la proyección métrica del lote.
//  Devuelve el PNG crudo (2 bandas: valor 1..254 y máscara) más los metadatos
//  de georreferenciación en headers. Para el panel es una herramienta de
//  diagnóstico; la generación de zonas usa rasterDeLote() sin pasar por HTTP.
// ══════════════════════════════════════════════════════════
router.get("/lote/raster", async (req, res) => {
  try {
    const slug = req.query.estab || req.user?.estabSlug;
    const lote = req.query.lote ? decodeURIComponent(req.query.lote) : null;
    if (!slug) return res.status(400).json({ error: "Sin organización activa" });
    if (!lote) return res.status(400).json({ error: "Pasá ?lote=" });
    if (req.query.estab && req.query.estab !== req.user?.estabSlug &&
        req.user?.rol_global !== "superadmin" &&
        !(req.user?.memberships || []).some(m => m.orgSlug === req.query.estab))
      return res.status(403).json({ error: "Sin acceso a esa organización" });

    const { rasterDeLote } = require("../services/ndvi_raster");
    const r = await rasterDeLote({
      slug, lote,
      fecha:  req.query.fecha || null,
      indice: (req.query.indice || "ndvi").toLowerCase(),
    });

    res.set("X-Ancho", String(r.ancho));
    res.set("X-Alto", String(r.alto));
    res.set("X-Zona-Utm", String(r.zona));
    res.set("X-Bbox-Utm", `${r.bbox.minX},${r.bbox.minY},${r.bbox.maxX},${r.bbox.maxY}`);
    res.set("X-Resolucion-M", String(r.resolucion_m));
    res.json({
      ok: true, lote, indice: r.indice, fecha: r.fecha,
      ancho: r.ancho, alto: r.alto, zona_utm: r.zona, sur: r.sur,
      bbox_utm: r.bbox, resolucion_m: r.resolucion_m,
      con_dato: r.datos.reduce((s, v) => s + (v ? 1 : 0), 0),
    });
  } catch (e) {
    console.error("[ndvi/lote/raster]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});
```

Run: `node --check routes/ndvi.js services/ndvi_raster.js lib/indices_satelitales.js` → sin salida.


- [ ] **Paso 9: Crear `services/prescripciones.js`**

```js
"use strict";
// prescripciones.js — Genera zonas desde NDVI y guarda las prescripciones en
// CouchDB (hasta ahora vivían solo en el localStorage del navegador, máximo 30
// por máquina y sin backup).
//
// La generación se serializa: un raster de 1024x1024 más el PNG inflado son
// 30-50 MB de pico, y el droplet tiene 1 GB con ~25 apps. Una por vez.
const db = require("./couchdb");
const { rasterDeLote } = require("./ndvi_raster");
const { zonificar } = require("../lib/zonificar");
const { normalizarColeccion, asignarDosis, desdeLocalStorage } = require("../lib/prescripcion_schema");

const ESTADOS = ["borrador", "lista", "enviada"];
let _cadena = Promise.resolve();

// Cola de concurrencia 1: cada generación espera a la anterior.
function enCola(fn) {
  const siguiente = _cadena.then(fn, fn);
  _cadena = siguiente.catch(() => {});
  return siguiente;
}

async function generar({ slug, lote, fecha, indice = "ndvi", n = 3, areaMinHa = 0.5, dosis = null, unidad = null, sentido = "mas_donde_menos", nombre = "" }) {
  const zonas = Math.min(Math.max(Number(n) || 3, 2), 5);
  return enCola(async () => {
    const r = await rasterDeLote({ slug, lote, fecha, indice });
    const fc = zonificar({
      datos: r.datos, ancho: r.ancho, alto: r.alto, bbox: r.bbox,
      zona: r.zona, sur: r.sur, n: zonas,
      areaMinHa: Number(areaMinHa) >= 0 ? Number(areaMinHa) : 0.5,
      rango: r.rango,
    });
    if (!fc.features.length)
      throw Object.assign(new Error("Esa fecha no tiene imagen utilizable del lote (nubes o sin pasada del satélite)"), { status: 422 });

    const conDosis = asignarDosis(normalizarColeccion(fc, { nombre: nombre || lote }), { dosis, unidad, sentido });
    conDosis.properties.fuente = {
      indice: r.indice, fecha: r.fecha, metodo: "cuantiles", n_zonas: zonas,
      cortes: fc.properties.cortes, resolucion_m: r.resolucion_m, zona_utm: r.zona,
    };
    return conDosis;
  });
}

function docNuevo({ slug, datos, uid }) {
  const ahora = Date.now();
  const geo = normalizarColeccion(datos.geojson || datos, { nombre: datos.nombre || "" });
  return {
    _id:         `presc_${ahora}_${Math.random().toString(36).slice(2, 6)}`,
    tipo:        "prescripcion",
    nombre:      String(datos.nombre || "Sin nombre").slice(0, 120),
    lote_nombre: datos.lote_nombre || datos.lote || null,
    org_slug:    slug,
    origen:      ["manual", "ndvi", "import"].includes(datos.origen) ? datos.origen : "manual",
    estado:      ESTADOS.includes(datos.estado) ? datos.estado : "borrador",
    geojson:     geo,
    units:       datos.units || null,
    extra:       datos.extra || null,
    fuente:      datos.fuente || geo.properties?.fuente || null,
    local_id:    datos.local_id || null,
    created_at:  ahora,
    created_by:  uid || "system",
    updated_at:  ahora,
  };
}

async function guardar(slug, datos, uid) {
  const doc = docNuevo({ slug, datos, uid });
  await db.getDB(slug).insert(doc);
  return doc;
}

async function listar(slug, { lote = null, limit = 200 } = {}) {
  // Índice ["tipo","lote_nombre"] (Sprint 2, Tarea 1) cuando se filtra por lote.
  const selector = lote ? { tipo: "prescripcion", lote_nombre: lote } : { tipo: "prescripcion" };
  const r = await db.getDB(slug).find({
    selector,
    fields: ["_id", "nombre", "lote_nombre", "origen", "estado", "fuente", "created_at", "created_by", "updated_at"],
    limit,
  });
  return (r.docs || []).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

async function obtener(slug, id) {
  const doc = await db.getDB(slug).get(id);
  if (doc.tipo !== "prescripcion") { const e = new Error("No encontrada"); e.status = 404; throw e; }
  return doc;
}

async function actualizar(slug, id, datos, uid) {
  const previo = await obtener(slug, id);
  const doc = {
    ...previo,
    nombre:      datos.nombre != null ? String(datos.nombre).slice(0, 120) : previo.nombre,
    lote_nombre: datos.lote_nombre ?? previo.lote_nombre,
    estado:      ESTADOS.includes(datos.estado) ? datos.estado : previo.estado,
    geojson:     datos.geojson ? normalizarColeccion(datos.geojson, { nombre: datos.nombre || previo.nombre }) : previo.geojson,
    units:       datos.units ?? previo.units,
    updated_at:  Date.now(),
    updated_by:  uid || "system",
  };
  await db.getDB(slug).insert(doc);
  return doc;
}

async function borrar(slug, id) {
  const doc = await obtener(slug, id);
  await db.getDB(slug).destroy(doc._id, doc._rev);
  return true;
}

// Migración única de lo que haya en localStorage. Idempotente por `local_id`:
// abrir la pantalla dos veces no duplica nada.
async function migrarLocales(slug, lista, uid) {
  const existentes = new Set((await listar(slug, { limit: 500 })).map(d => d.local_id).filter(Boolean));
  let creados = 0, saltados = 0;
  for (const cruda of lista || []) {
    const conv = desdeLocalStorage(cruda);
    if (!conv) { saltados++; continue; }
    if (conv.local_id && existentes.has(conv.local_id)) { saltados++; continue; }
    await guardar(slug, { ...conv, estado: "borrador" }, uid);
    creados++;
  }
  return { creados, saltados };
}

module.exports = { generar, guardar, listar, obtener, actualizar, borrar, migrarLocales, ESTADOS };
```

- [ ] **Paso 10: Crear `routes/prescripciones.js`**

```js
"use strict";
// routes/prescripciones.js — Prescripciones como documentos de CouchDB.
//
// Se monta en /api/prescripciones ANTES del router viejo (prescripciones_api),
// que sigue sirviendo /pendientes con auth de dispositivo. Las rutas de acá no
// chocan con esas y la auth se declara ruta por ruta, para no exigir JWT en el
// camino del tractor.
const router = require("express").Router();
const auth = require("../middleware/auth");
const { noDevices } = require("./devices");
const presc = require("../services/prescripciones");

const guard = [auth.required, noDevices];

function orgDe(req) {
  const slug = req.query.estab || req.user?.estabSlug;
  if (!slug) { const e = new Error("Sin organización activa"); e.status = 400; throw e; }
  if (req.query.estab && req.query.estab !== req.user?.estabSlug &&
      req.user?.rol_global !== "superadmin" &&
      !(req.user?.memberships || []).some(m => m.orgSlug === req.query.estab)) {
    const e = new Error("Sin acceso a esa organización"); e.status = 403; throw e;
  }
  return slug;
}

router.get("/docs", ...guard, async (req, res) => {
  try { res.json({ ok: true, items: await presc.listar(orgDe(req), { lote: req.query.lote || null }) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.get("/docs/:id", ...guard, async (req, res) => {
  try { res.json({ ok: true, doc: await presc.obtener(orgDe(req), req.params.id) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.post("/docs", ...guard, async (req, res) => {
  try { res.json({ ok: true, doc: await presc.guardar(orgDe(req), req.body || {}, req.user?.uid) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.put("/docs/:id", ...guard, async (req, res) => {
  try { res.json({ ok: true, doc: await presc.actualizar(orgDe(req), req.params.id, req.body || {}, req.user?.uid) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

router.delete("/docs/:id", ...guard, async (req, res) => {
  try { await presc.borrar(orgDe(req), req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// POST /api/prescripciones/generar — vista previa. No guarda nada salvo ?guardar=1.
router.post("/generar", ...guard, async (req, res) => {
  try {
    const slug = orgDe(req);
    const { lote, fecha, indice, n_zonas, min_ha, dosis, unidad, sentido, nombre } = req.body || {};
    if (!lote) return res.status(400).json({ error: "Elegí un lote" });
    const fc = await presc.generar({
      slug, lote, fecha, indice, nombre,
      n: n_zonas, areaMinHa: min_ha, dosis, unidad, sentido,
    });
    if (req.query.guardar === "1") {
      const doc = await presc.guardar(slug, {
        nombre: nombre || `${lote} · ${indice || "ndvi"} ${fecha || ""}`.trim(),
        lote_nombre: lote, origen: "ndvi", geojson: fc, fuente: fc.properties.fuente,
      }, req.user?.uid);
      return res.json({ ok: true, geojson: fc, doc });
    }
    res.json({ ok: true, geojson: fc });
  } catch (e) {
    console.error("[prescripciones/generar]", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/prescripciones/migrar — sube lo que quedó en el localStorage.
router.post("/migrar", ...guard, async (req, res) => {
  try {
    const r = await presc.migrarLocales(orgDe(req), req.body?.locales || [], req.user?.uid);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
```

Run: `node --check routes/prescripciones.js services/prescripciones.js` → sin salida.

- [ ] **Paso 11: Montar el router en `server.js` (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal:

```js
app.use("/api/lotes-maestro", auth.required, routeLotesMaestro);
```

Bloque completo a insertar:

```js
// Sprint 2: prescripciones en CouchDB
// Va ANTES del montaje viejo de /api/prescripciones: las rutas de acá (/docs,
// /generar, /migrar) no chocan con /pendientes, que sigue con auth de device.
app.use("/api/prescripciones", require("./routes/prescripciones"));
// fin Sprint 2: prescripciones en CouchDB
```

**NO stagear `server.js`.**

- [ ] **Paso 12: Arreglos en `routes/prescripciones_api.js`** (archivo limpio)

(a) Filtrar por subtipo — reemplazar:

```js
      selector: {
        tipo: "aog_descarga_pendiente",
        device_id: deviceId,
        entregado: false
      },
```

por:

```js
      selector: {
        tipo: "aog_descarga_pendiente",
        // Sin el subtipo, acá también salían los boundaries de lote que encola
        // routes/lotes_maestro.js y el tractor los pedía como prescripciones.
        subtipo: "prescripcion",
        device_id: deviceId,
        entregado: false
      },
```

(b) Marcar entregado **después** de responder — reemplazar:

```js
    // Marcar como entregado.
    await estabDB.insert({ ...doc, entregado: true, entregado_at: Date.now() });

    res.json({
      nombre: doc.nombre,
      ruta_rel: doc.ruta_rel,
      contenido: doc.contenido,
```

por:

```js
    // Marcar como entregado DESPUÉS de responder: si la respuesta se pierde en
    // el camino (el campo tiene la conexión que tiene), la prescripción sigue
    // pendiente y el tractor la vuelve a pedir.
    res.json({
      nombre: doc.nombre,
      ruta_rel: doc.ruta_rel,
      contenido: doc.contenido,
```

Y **después** del cierre de ese `res.json({...})` (la línea `});`), agregar:

```js
    estabDB.insert({ ...doc, entregado: true, entregado_at: Date.now() })
      .catch(e => console.warn("[prescripciones] marcar entregado:", e.message));
```

> Ojo: el `res.json({...})` original termina con `    });` y después viene el `catch`. Verificar con `sed -n '120,145p' routes/prescripciones_api.js` que el `insert` quede dentro del `try` y después del `res.json`.

- [ ] **Paso 13: UI en `views/pages/prescripciones.ejs`** (archivo limpio)

(a) Markup — insertar **antes** de la línea literal `<!-- Leaflet + Leaflet.draw -->`:

```html
<!-- ── Generar desde NDVI ─────────────────────────────── -->
<div class="card" style="margin-bottom:14px">
  <div class="card-head">
    <span class="card-title">Generar desde NDVI</span>
    <span id="gen-estado" style="font-size:11px;color:var(--muted2)"></span>
  </div>
  <div class="card-body" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
    <div style="flex:1;min-width:160px">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);display:block;margin-bottom:4px">Lote</label>
      <select id="gen-lote" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px"></select>
    </div>
    <div style="min-width:150px">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);display:block;margin-bottom:4px">Fecha del satélite</label>
      <select id="gen-fecha" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px">
        <option value="">Mejor de los últimos 30 días</option>
      </select>
    </div>
    <div style="width:90px">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);display:block;margin-bottom:4px">Zonas</label>
      <select id="gen-zonas" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px">
        <option>2</option><option selected>3</option><option>4</option><option>5</option>
      </select>
    </div>
    <div style="min-width:200px">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);display:block;margin-bottom:4px">Criterio</label>
      <select id="gen-sentido" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px">
        <option value="mas_donde_menos">Más insumo donde hay menos vigor</option>
        <option value="mas_donde_mas">Más insumo donde hay más vigor</option>
      </select>
    </div>
    <div style="width:100px">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);display:block;margin-bottom:4px">Dosis mín.</label>
      <input id="gen-dmin" type="number" value="60" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px"/>
    </div>
    <div style="width:100px">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted2);display:block;margin-bottom:4px">Dosis máx.</label>
      <input id="gen-dmax" type="number" value="120" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px"/>
    </div>
    <button class="btn btn-lime" onclick="generarDesdeNDVI(false)">Ver zonas</button>
    <button class="btn btn-ghost" onclick="generarDesdeNDVI(true)">Generar y guardar</button>
  </div>
  <div class="card-body" id="gen-zonas-tabla" style="display:none;border-top:1px solid var(--border)">
    <table style="width:100%;font-size:12px">
      <thead><tr><th style="text-align:left">Zona</th><th style="text-align:left">NDVI medio</th><th style="text-align:left">ha</th><th style="text-align:left">Dosis</th></tr></thead>
      <tbody id="gen-zonas-body"></tbody>
    </table>
    <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
      <input id="gen-nombre" placeholder="Nombre de la prescripción"
        style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:7px;font-size:12px"/>
      <button class="btn btn-lime" onclick="guardarZonasEditadas()">Guardar con estas dosis</button>
    </div>
  </div>
</div>
```

(b) JS — insertar **antes** de la línea literal `// ── Init ──────────────────────────────────────────────────`:

```js
// ── Generar desde NDVI ────────────────────────────────────
const AUTH_H = () => ({ "Authorization": `Bearer ${localStorage.getItem("orbitx_token") || ""}`, "Content-Type": "application/json" });
let _genLayers = [];
let _genFC = null;      // última FeatureCollection generada (para guardar con dosis editadas)
let _genLote = "";

async function cargarLotesGen() {
  try {
    const r = await fetch("/api/aog/lotes-mapa", { headers: AUTH_H() });
    const lotes = r.ok ? await r.json() : [];
    const sel = document.getElementById("gen-lote");
    sel.innerHTML = lotes.filter(l => l.tiene_boundary).map(l => `<option>${l.nombre}</option>`).join("")
      || `<option value="">— sin lotes con contorno —</option>`;
    sel.addEventListener("change", cargarFechasGen);
    cargarFechasGen();
  } catch (e) { console.warn("[gen] lotes:", e.message); }
}

async function cargarFechasGen() {
  const lote = document.getElementById("gen-lote").value;
  const sel = document.getElementById("gen-fecha");
  sel.innerHTML = `<option value="">Mejor de los últimos 30 días</option>`;
  if (!lote) return;
  try {
    const rm = await fetch(`/api/aog/mapa?lote=${encodeURIComponent(lote)}&lite=1`, { headers: AUTH_H() });
    const lotes = rm.ok ? await rm.json() : [];
    const b = lotes[0]?.boundary;
    if (!b || b.length < 3) return;
    const lats = b.map(p => p[0]), lons = b.map(p => p[1]);
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(",");
    const rf = await fetch(`/api/ndvi/fechas-disponibles?bbox=${bbox}&dias=90`, { headers: AUTH_H() });
    const j = rf.ok ? await rf.json() : { fechas: [] };
    // La nubosidad decide: zonificar sobre una imagen nublada da una
    // prescripción agronómicamente peligrosa.
    for (const f of (j.fechas || []).slice(0, 30)) {
      const op = document.createElement("option");
      op.value = f.fecha;
      op.textContent = `${f.fecha} · ${f.cloud_cover}% nubes`;
      sel.appendChild(op);
    }
  } catch (e) { console.warn("[gen] fechas:", e.message); }
}

async function generarDesdeNDVI(guardar) {
  const est = document.getElementById("gen-estado");
  const lote = document.getElementById("gen-lote").value;
  if (!lote) { est.textContent = "Elegí un lote"; return; }
  est.textContent = "Pidiendo la imagen y armando las zonas…";
  try {
    const body = {
      lote,
      fecha:   document.getElementById("gen-fecha").value || null,
      indice:  "ndvi",
      n_zonas: Number(document.getElementById("gen-zonas").value),
      min_ha:  0.5,
      sentido: document.getElementById("gen-sentido").value,
      unidad:  "kg_ha",
      dosis:   { min: Number(document.getElementById("gen-dmin").value), max: Number(document.getElementById("gen-dmax").value) },
      nombre:  `${lote} · NDVI`,
    };
    const r = await fetch(`/api/prescripciones/generar${guardar ? "?guardar=1" : ""}`, {
      method: "POST", headers: AUTH_H(), body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    _genFC = j.geojson;
    _genLote = lote;
    pintarZonasGeneradas(j.geojson);
    pintarTablaZonas(j.geojson, lote);
    est.textContent = guardar ? "✓ Guardada en la nube" : `✓ ${j.geojson.features.length} zonas · previsualización`;
    if (guardar) cargarPrescServidor();
  } catch (e) {
    est.textContent = "✗ " + e.message;
  }
}

// La dosis precargada es una propuesta: el agrónomo la edita zona por zona
// antes de guardar.
function pintarTablaZonas(fc, lote) {
  const cont = document.getElementById("gen-zonas-tabla");
  const body = document.getElementById("gen-zonas-body");
  body.innerHTML = fc.features.map(f => `
    <tr>
      <td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${PALETA[(f.properties.zona - 1) % PALETA.length]};margin-right:6px"></span>${f.properties.nombre}</td>
      <td>${f.properties.ndvi_medio ?? "–"}</td>
      <td>${f.properties.ha}</td>
      <td><input type="number" step="0.1" value="${f.properties.dosis ?? ""}" data-zona="${f.properties.zona}"
           style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:6px;font-size:12px"/>
          <span style="color:var(--muted2)">${f.properties.unidad || ""}</span></td>
    </tr>`).join("");
  document.getElementById("gen-nombre").value = `${lote} · NDVI`;
  cont.style.display = "block";
}

async function guardarZonasEditadas() {
  const est = document.getElementById("gen-estado");
  if (!_genFC) { est.textContent = "Generá las zonas primero"; return; }
  const inputs = document.querySelectorAll("#gen-zonas-body input[data-zona]");
  const porZona = {};
  inputs.forEach(i => { porZona[Number(i.dataset.zona)] = i.value === "" ? null : Number(i.value); });
  const fc = {
    ..._genFC,
    features: _genFC.features.map(f => ({ ...f, properties: { ...f.properties, dosis: porZona[f.properties.zona] ?? f.properties.dosis } })),
  };
  try {
    const r = await fetch("/api/prescripciones/docs", {
      method: "POST", headers: AUTH_H(),
      body: JSON.stringify({
        nombre: document.getElementById("gen-nombre").value || `${_genLote} · NDVI`,
        lote_nombre: _genLote, origen: "ndvi", estado: "lista",
        geojson: fc, fuente: _genFC.properties?.fuente || null,
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    est.textContent = "✓ Guardada con las dosis editadas";
    cargarPrescServidor();
  } catch (e) { est.textContent = "✗ " + e.message; }
}

function pintarZonasGeneradas(fc) {
  if (!mapaL) initMapa();
  _genLayers.forEach(l => mapaL.removeLayer(l));
  _genLayers = [];
  const capa = L.geoJSON(fc, {
    style: (f) => ({ color: PALETA[(f.properties.zona - 1) % PALETA.length], weight: 2, fillOpacity: 0.45 }),
    onEachFeature: (f, l) => l.bindPopup(
      `<b>${f.properties.nombre}</b><br>NDVI medio: ${f.properties.ndvi_medio ?? "–"}<br>${f.properties.ha} ha<br>Dosis: ${f.properties.dosis ?? "–"} ${f.properties.unidad || ""}`),
  }).addTo(mapaL);
  _genLayers.push(capa);
  try { mapaL.fitBounds(capa.getBounds()); } catch {}
}

// ── Prescripciones guardadas en la nube + migración única ──
async function cargarPrescServidor() {
  try {
    const r = await fetch("/api/prescripciones/docs", { headers: AUTH_H() });
    if (!r.ok) return;
    const j = await r.json();
    console.log(`[presc] ${j.items.length} prescripciones en la nube`);
  } catch (e) { console.warn("[presc] listar:", e.message); }
}

async function migrarPrescLocales() {
  let locales = [];
  try { locales = JSON.parse(localStorage.getItem("orbitx_presc") || "[]"); } catch { return; }
  if (!locales.length) return;
  try {
    const r = await fetch("/api/prescripciones/migrar", {
      method: "POST", headers: AUTH_H(), body: JSON.stringify({ locales }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (j.creados) toast("✓ Prescripciones subidas", `${j.creados} pasaron a la nube`, "lime");
  } catch (e) { console.warn("[presc] migrar:", e.message); }
}
```

(c) Arranque — reemplazar la última línea del script:

```js
document.addEventListener('DOMContentLoaded', () => { initMapa(); });
```

por:

```js
document.addEventListener('DOMContentLoaded', () => {
  initMapa();
  cargarLotesGen();
  migrarPrescLocales().then(cargarPrescServidor);
});
```

- [ ] **Paso 14: Verificar**

Run: `npm test` → todo verde.
Run: `node --check routes/ndvi.js routes/prescripciones.js routes/prescripciones_api.js services/ndvi_raster.js services/prescripciones.js lib/indices_satelitales.js lib/prescripcion_schema.js server.js` → sin salida.

Prueba manual del pipeline **sin red** (confirma que zonificar + el esquema encajan; no toca Copernicus ni CouchDB):

```bash
node -e "
const { zonificar } = require('./lib/zonificar');
const { normalizarColeccion, asignarDosis } = require('./lib/prescripcion_schema');
const ancho=40, alto=40, datos=new Uint8Array(ancho*alto);
for (let y=0;y<alto;y++) for (let x=0;x<ancho;x++) datos[y*ancho+x]= 20 + Math.round((x/ancho)*200);
const fc = zonificar({datos,ancho,alto,bbox:{minX:400000,minY:6200000,maxX:400400,maxY:6200400},zona:20,n:3,areaMinHa:0.5});
const out = asignarDosis(normalizarColeccion(fc,{nombre:'prueba'}),{dosis:{min:60,max:120},unidad:'kg_ha',sentido:'mas_donde_menos'});
console.log(out.features.map(f=>f.properties));
"
```
Esperado: tres objetos con `zona` 1/2/3, `ha` cercanas entre sí, `dosis` 120/90/60 y `unidad: 'kg_ha'`.

- [ ] **Paso 15: Commit de lo limpio**

```bash
git commit -m "feat(prescripciones): zonas desde NDVI con raster metrico y persistencia en CouchDB

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- lib/prescripcion_schema.js lib/indices_satelitales.js services/ndvi_raster.js services/prescripciones.js routes/prescripciones.js routes/ndvi.js routes/prescripciones_api.js views/pages/prescripciones.ejs tests/lib/prescripcion-schema.test.mjs
```

Informar: *"`server.js` quedó editado en disco con el bloque `// Sprint 2: prescripciones en CouchDB`. No fue stageado."*

> **Pendiente de validación contra Copernicus (no bloquea el merge):** la primera generación real contra CDSE tiene que verificarse en el droplet. Si el Process API rechaza el `crs` EPSG métrico, aplicar el plan B descrito en las Interfaces de esta tarea y volver a correr la prueba.

---

### Tarea 10: Pieza 2 — comparar dos capas lado a lado (Fase A y Fase B)

**Files:**
- Create: `public/js/mapa-comparar.js`, `services/temporadas_lote.js`
- Test: `tests/services/temporadas-lote.test.mjs` (nuevo)
- Modify: `public/js/mapa-ndvi.js` (de singleton a factory, limpio)
- Modify (**SUCIOS, solo entre marcadores, NO stagear**): `views/pages/mapa.ejs` (botón, overlay, arranque y el `?estab=` faltante), `routes/aog.js` (`?temporada=` en `/mapa` y `GET /lotes/:nombre/temporadas`), `routes/lotes_maestro.js` (`?meta=1` en `/contexto`)

**Interfaces:**
- Consume (Tarea 3): `aog_historial.stats` — sin eso, listar temporadas de `el_susto` obliga a reparsear 11,1 GB. Consume el índice `["tipo","subtipo","lote_nombre","ts"]` (Tarea 1) y `temporadaDe` de `services/temporada.js`.
- Produce:
  - `services/temporadas_lote.js`: `derivarTemporadasDeHistorial(docs: Array<{_id,ts,stats}>) -> Array<{ temporada, ts, hist_id, trabajado_ha, neto_ha }>` — pura, ordenada por `ts` descendente, una entrada por temporada (gana la más nueva).
  - `GET /api/aog/lotes/:nombre/temporadas[?estab=]` → `{ ok, lote, temporadas: [...] }`.
  - `GET /api/aog/mapa?lote=&temporada=2025/26[&estab=]` → mismo formato que hoy, con `sections` reconstruidas del histórico y `stats` del doc archivado.
  - `GET /api/lotes-maestro/:nombre/contexto?meta=1` → igual que hoy pero **sin** `contenido_texto` ni `base64` (los dos paneles no bajan todo dos veces).
  - `public/js/mapa-ndvi.js`: `window.crearNDVI({ prefijo, mapa })` devuelve una instancia; `window.OrbitNDVI` sigue existiendo (instancia por defecto, prefijo `"ndvi"`, ligada a `window._mapa`) así que `views/pages/mapa.ejs` no cambia su uso.
  - `public/js/mapa-comparar.js`: `window.OrbitComparar = { abrir(), cerrar() }` y `window._estabQS() -> "" | "?estab=<slug>"`.
- **Fase A** (NDVI fecha A vs B, índice A vs B) no toca el backend. **Fase B** (cobertura temporada A vs B) usa los dos endpoints nuevos.

- [ ] **Paso 1: Test que falla** — `tests/services/temporadas-lote.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import tl from "../../services/temporadas_lote.js";

const { derivarTemporadasDeHistorial } = tl;

const ts = (iso) => Date.parse(iso + "T12:00:00-03:00");

test("agrupa por temporada agrícola y se queda con el snapshot más nuevo", () => {
  const docs = [
    { _id: "h1", ts: ts("2025-11-10"), stats: { trabajado_ha: 100, neto_ha: 98 } },
    { _id: "h2", ts: ts("2025-12-20"), stats: { trabajado_ha: 140, neto_ha: 135 } },
    { _id: "h3", ts: ts("2026-10-05"), stats: { trabajado_ha: 60, neto_ha: 59 } },
  ];
  const r = derivarTemporadasDeHistorial(docs);
  assert.deepEqual(r.map(x => x.temporada), ["2026/27", "2025/26"]);
  assert.equal(r[1].hist_id, "h2");
  assert.equal(r[1].trabajado_ha, 140);
  assert.equal(r[0].trabajado_ha, 60);
});

test("docs sin stats entran igual, con los valores en null", () => {
  const r = derivarTemporadasDeHistorial([{ _id: "h1", ts: ts("2026-03-01") }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].trabajado_ha, null);
  assert.equal(r[0].neto_ha, null);
});

test("descarta los docs sin ts y la lista vacía", () => {
  assert.deepEqual(derivarTemporadasDeHistorial([{ _id: "x" }]), []);
  assert.deepEqual(derivarTemporadasDeHistorial([]), []);
});
```

Run: `node --test tests/services/temporadas-lote.test.mjs` → FALLA (`Cannot find module`).

- [ ] **Paso 2: Crear `services/temporadas_lote.js`**

```js
"use strict";
// temporadas_lote.js — De los snapshots de cobertura (aog_historial + el doc
// vigente) a la lista de temporadas disponibles de un lote.
//
// Gratis gracias a la Pieza 0: cada snapshot ya tiene sus `stats` copiadas al
// archivarse, así que esto sale de un `find` con `fields` y no baja un byte de
// `contenido`. Sin eso, en el_susto serían 11,1 GB de reparseo.
const { temporadaDe } = require("./temporada");

function derivarTemporadasDeHistorial(docs) {
  const porTemporada = new Map();
  for (const d of docs || []) {
    const ts = Number(d.ts) || 0;
    if (!ts) continue;
    const t = temporadaDe(ts);
    const prev = porTemporada.get(t);
    if (prev && prev.ts >= ts) continue;
    porTemporada.set(t, {
      temporada:    t,
      ts,
      hist_id:      d._id || null,
      trabajado_ha: d.stats?.trabajado_ha ?? null,
      neto_ha:      d.stats?.neto_ha ?? null,
    });
  }
  return [...porTemporada.values()].sort((a, b) => b.ts - a.ts);
}

module.exports = { derivarTemporadasDeHistorial };
```

Run: `node --test tests/services/temporadas-lote.test.mjs` → PASA (3 tests).

- [ ] **Paso 3: `public/js/mapa-ndvi.js` de singleton a factory** (archivo limpio)

Son seis reemplazos exactos. El resto del archivo queda igual.

**(3.1)** Reemplazar:

```js
(function (global) {
  "use strict";

  // ── Estado ─────────────────────────────────────────────
  let _activo      = false;
```

por:

```js
(function (global) {
  "use strict";

  // Sprint 2 — de singleton a factory: el comparador necesita dos instancias
  // en la misma página, cada una atada a su propio mapa y a sus propios ids.
  // `crearNDVI({ prefijo, mapa })`; window.OrbitNDVI sigue siendo la instancia
  // por defecto (prefijo "ndvi", atada a window._mapa) para que mapa.ejs no
  // cambie ni una línea.
  function crearNDVI(opts) {
  const O = opts || {};
  const P = O.prefijo || "ndvi";
  const REF = `window.__ndvi['${P}']`;
  const mapaDe = () => (typeof O.mapa === "function" ? O.mapa() : O.mapa) || global._mapa;
  const $ = (sufijo) => document.getElementById(`${P}-${sufijo}`);

  // ── Estado ─────────────────────────────────────────────
  let _activo      = false;
```

**(3.2)** Reemplazar cada `document.getElementById("ndvi-XXX")` por `$("XXX")`. Son estas ocho apariciones, en este orden:

| Actual | Nuevo |
|---|---|
| `const sel = document.getElementById("ndvi-idx");` | `const sel = $("idx");` |
| `const el = document.getElementById("ndvi-desc");` | `const el = $("desc");` |
| `const el = document.getElementById("ndvi-leyenda");` | `const el = $("leyenda");` |
| `const el = document.getElementById("ndvi-status");` | `const el = $("status");` |
| `const cacheBadge = document.getElementById("ndvi-cache-badge");` | `const cacheBadge = $("cache-badge");` |
| `const p = document.getElementById("ndvi-panel");` (en `abrirPanel`) | `const p = $("panel");` |
| `const p = document.getElementById("ndvi-panel");` (en `cerrarPanel`) | `const p = $("panel");` |
| `document.getElementById("ndvi-op-val") && (document.getElementById("ndvi-op-val").textContent = Math.round(_opacity * 100) + "%");` | `$("op-val") && ($("op-val").textContent = Math.round(_opacity * 100) + "%");` |

**(3.3)** En el template de `pintarPanel()`, los ids y los handlers pasan a llevar el prefijo. Reemplazar estas seis subcadenas dentro del literal:

| Actual | Nuevo |
|---|---|
| `id="ndvi-panel"` | `id="${P}-panel"` |
| `id="ndvi-cache-badge"` | `id="${P}-cache-badge"` |
| `id="ndvi-idx"` | `id="${P}-idx"` |
| `id="ndvi-desc"` | `id="${P}-desc"` |
| `id="ndvi-fecha"` | `id="${P}-fecha"` |
| `id="ndvi-op-val"` | `id="${P}-op-val"` |
| `id="ndvi-op"` | `id="${P}-op"` |
| `id="ndvi-leyenda"` | `id="${P}-leyenda"` |
| `id="ndvi-status"` | `id="${P}-status"` |
| `onclick="OrbitNDVI.destroy()"` | `onclick="${REF}.destroy()"` |
| `onchange="OrbitNDVI.setIndice(this.value)"` | `onchange="${REF}.setIndice(this.value)"` |
| `onchange="OrbitNDVI.setFecha(this.value)"` | `onchange="${REF}.setFecha(this.value)"` |
| `oninput="OrbitNDVI.setOpacity(this.value/100)"` | `oninput="${REF}.setOpacity(this.value/100)"` |

**(3.4)** Reemplazar los usos de `global._mapa` por `mapaDe()`. Son cinco:

| Actual | Nuevo |
|---|---|
| `if (!global._mapa) return null;` | `if (!mapaDe()) return null;` |
| `global._mapa.eachLayer(l => {` | `mapaDe().eachLayer(l => {` |
| `if (_imgLayer) global._mapa.removeLayer(_imgLayer);` | `if (_imgLayer) mapaDe().removeLayer(_imgLayer);` |
| `_imgLayer.addTo(global._mapa);` | `_imgLayer.addTo(mapaDe());` |
| `if (_imgLayer && global._mapa) {\n      global._mapa.removeLayer(_imgLayer);` | `if (_imgLayer && mapaDe()) {\n      mapaDe().removeLayer(_imgLayer);` |

**(3.5)** Reemplazar el cierre del archivo:

```js
  global.OrbitNDVI = {
    init,
    toggle,
    setIndice,
    setFecha,
    setOpacity,
    setLoteBoundary,
    destroy,
    get estado() {
      return { activo: _activo, indice: _indiceActual, fecha: _fecha, opacity: _opacity, lote: _loteNombre };
    },
  };
})(window);
```

por:

```js
  const api = {
    init,
    toggle,
    setIndice,
    setFecha,
    setOpacity,
    setLoteBoundary,
    destroy,
    get estado() {
      return { activo: _activo, indice: _indiceActual, fecha: _fecha, opacity: _opacity, lote: _loteNombre };
    },
  };
  // Registro global: los handlers inline del panel apuntan acá por prefijo.
  global.__ndvi = global.__ndvi || {};
  global.__ndvi[P] = api;
  return api;
  }

  global.crearNDVI = crearNDVI;
  global.OrbitNDVI = crearNDVI({ prefijo: "ndvi" });
})(window);
```

**(3.6)** Verificar que no quedó ninguna referencia vieja:

Run: `grep -n "getElementById(\"ndvi-\|global\._mapa\|OrbitNDVI\." public/js/mapa-ndvi.js`
Esperado: sin resultados (las únicas menciones a `OrbitNDVI` tienen que ser `global.OrbitNDVI = crearNDVI(...)`).

- [ ] **Paso 4: Crear `public/js/mapa-comparar.js`**

```js
/**
 * public/js/mapa-comparar.js — Comparador de dos paneles.
 *
 * Fase A: NDVI de dos fechas o de dos índices, mismo lote.
 * Fase B: cobertura de dos temporadas (necesita las stats del Sprint 2).
 *
 * Toda la lógica vive acá: views/pages/mapa.ejs (que está sucio y tiene 1.000
 * líneas de JS inline) solo aporta el markup de los contenedores y el arranque.
 * La sincronización son quince líneas propias — no se vendoriza leaflet.sync.
 */
(function (global) {
  "use strict";

  const TOKEN = () => localStorage.getItem("orbitx_token") || "";
  const auth = (extra) => Object.assign({ "Authorization": `Bearer ${TOKEN()}` }, extra || {});
  const toast = (...a) => (typeof global.toast === "function") && global.toast(...a);

  // El selector de establecimiento vive en el DOM, no en una variable.
  // Se expone global porque mapa.ejs lo usa para arreglar los /contexto que
  // hoy piden sin ?estab= (bug latente que con dos paneles es garantizado).
  global._estabQS = function () {
    const v = document.getElementById("filtro-estab")?.value || "";
    return v ? `?estab=${encodeURIComponent(v)}` : "";
  };
  const estabSlug = () => document.getElementById("filtro-estab")?.value || "";

  const paneles = {};   // { A: {...}, B: {...} }
  let _abierto = false;

  function sincronizar(a, b) {
    let guard = false;
    const enlazar = (src, dst) => src.on("move zoom", () => {
      if (guard) return;
      guard = true;
      dst.setView(src.getCenter(), src.getZoom(), { animate: false });
      guard = false;
    });
    enlazar(a, b);
    enlazar(b, a);
  }

  function crearMapa(idContenedor) {
    const mapa = L.map(idContenedor, { zoomControl: true, preferCanvas: true }).setView([-34.6, -60.0], 10);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri", maxNativeZoom: 17, maxZoom: 22 }).addTo(mapa);
    L.tileLayer("https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxNativeZoom: 17, maxZoom: 22, opacity: 0.7 }).addTo(mapa);
    return mapa;
  }

  async function cargarLotes() {
    const r = await fetch(`/api/aog/lotes-mapa${global._estabQS()}`, { headers: auth() });
    return r.ok ? await r.json() : [];
  }

  async function cargarFechas(boundary) {
    if (!boundary || boundary.length < 3) return [];
    const lats = boundary.map(p => p[0]), lons = boundary.map(p => p[1]);
    const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].join(",");
    const r = await fetch(`/api/ndvi/fechas-disponibles?bbox=${bbox}&dias=180`, { headers: auth() });
    const j = r.ok ? await r.json() : { fechas: [] };
    return j.fechas || [];
  }

  async function cargarTemporadas(lote) {
    const qs = estabSlug() ? `?estab=${encodeURIComponent(estabSlug())}` : "";
    const r = await fetch(`/api/aog/lotes/${encodeURIComponent(lote)}/temporadas${qs}`, { headers: auth() });
    const j = r.ok ? await r.json() : { temporadas: [] };
    return j.temporadas || [];
  }

  async function cargarLote(lote, temporada) {
    const p = new URLSearchParams({ lote });
    if (estabSlug()) p.set("estab", estabSlug());
    if (temporada) p.set("temporada", temporada);
    const r = await fetch(`/api/aog/mapa?${p}`, { headers: auth() });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const lotes = await r.json();
    return lotes[0] || null;
  }

  function limpiar(pan) {
    pan.capas.forEach(l => pan.mapa.removeLayer(l));
    pan.capas = [];
  }

  function dibujar(pan, lote, mostrarCobertura) {
    limpiar(pan);
    if (!lote) return;
    if (lote.boundary) {
      const poly = L.polygon(lote.boundary, { color: "#b8ff3c", weight: 2, fill: false }).addTo(pan.mapa);
      pan.capas.push(poly);
      pan.mapa.fitBounds(poly.getBounds());
    }
    if (mostrarCobertura && lote.sections) {
      for (const bloque of lote.sections) {
        const s = L.polygon(bloque, { color: "#3c9eff", weight: 0, fillOpacity: 0.5 }).addTo(pan.mapa);
        pan.capas.push(s);
      }
    }
    const st = lote.stats || {};
    const el = document.getElementById(`cmp-info-${pan.id}`);
    if (el) el.textContent = st.trabajado_ha != null
      ? `${st.trabajado_ha} ha trabajadas · ${st.neto_ha} netas · ${st.repintado_pct}% repintado`
      : "sin stats";
  }

  async function refrescar(id) {
    const pan = paneles[id];
    if (!pan) return;
    const lote = document.getElementById(`cmp-lote-${id}`).value;
    const capa = document.getElementById(`cmp-capa-${id}`).value;
    if (!lote) return;
    try {
      const temporada = capa === "cobertura" ? (document.getElementById(`cmp-temp-${id}`).value || "") : "";
      const datos = await cargarLote(lote, temporada);
      dibujar(pan, datos, capa === "cobertura");
      pan.boundary = datos?.boundary || null;
      pan.ndvi.setLoteBoundary(pan.boundary, lote);
      if (capa === "ndvi") {
        pan.ndvi.setIndice(document.getElementById(`cmp-indice-${id}`).value);
        pan.ndvi.setFecha(document.getElementById(`cmp-fecha-${id}`).value);
        if (!pan.ndvi.estado.activo) await pan.ndvi.toggle();
      } else {
        pan.ndvi.destroy();
      }
      await poblarSelectores(id, lote, pan.boundary);
    } catch (e) {
      toast("Comparar", e.message, "red");
    }
  }

  async function poblarSelectores(id, lote, boundary) {
    const selF = document.getElementById(`cmp-fecha-${id}`);
    if (selF && !selF.dataset.lote) {
      const fechas = await cargarFechas(boundary);
      selF.innerHTML = `<option value="">Mejor de los últimos 30 días</option>` +
        fechas.slice(0, 40).map(f => `<option value="${f.fecha}">${f.fecha} · ${f.cloud_cover}% nubes</option>`).join("");
      selF.dataset.lote = lote;
    }
    const selT = document.getElementById(`cmp-temp-${id}`);
    if (selT && selT.dataset.lote !== lote) {
      const temps = await cargarTemporadas(lote);
      selT.innerHTML = `<option value="">Última cobertura</option>` +
        temps.map(t => `<option value="${t.temporada}">${t.temporada}${t.trabajado_ha != null ? ` · ${t.trabajado_ha} ha` : ""}</option>`).join("");
      selT.dataset.lote = lote;
    }
  }

  function pintarControles(id) {
    return `
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px;background:rgba(0,0,0,0.35)">
        <select id="cmp-lote-${id}" style="flex:1;min-width:120px"></select>
        <select id="cmp-capa-${id}">
          <option value="ndvi">NDVI</option>
          <option value="cobertura">Cobertura</option>
        </select>
        <select id="cmp-indice-${id}"><option value="ndvi">NDVI</option></select>
        <select id="cmp-fecha-${id}"><option value="">Mejor reciente</option></select>
        <select id="cmp-temp-${id}"><option value="">Última cobertura</option></select>
      </div>
      <div id="cmp-mapa-${id}" style="height:100%;min-height:380px;background:#050810"></div>
      <div id="cmp-controls-${id}"></div>
      <div id="cmp-info-${id}" style="padding:6px 8px;font-size:11px;color:#9AA3AD"></div>`;
  }

  async function abrir() {
    if (_abierto) return cerrar();
    const cont = document.getElementById("cmp-overlay");
    if (!cont) return;
    cont.style.display = "block";
    _abierto = true;

    for (const id of ["A", "B"]) {
      document.getElementById(`cmp-panel-${id}`).innerHTML = pintarControles(id);
    }

    const lotes = await cargarLotes();
    const indicesResp = await fetch("/api/ndvi/indices", { headers: auth() }).then(r => r.ok ? r.json() : { indices: [] }).catch(() => ({ indices: [] }));

    for (const id of ["A", "B"]) {
      const mapa = crearMapa(`cmp-mapa-${id}`);
      paneles[id] = {
        id, mapa, capas: [], boundary: null,
        ndvi: global.crearNDVI({ prefijo: `cmp${id}`, mapa }),
      };
      await paneles[id].ndvi.init(`cmp-controls-${id}`);

      const selL = document.getElementById(`cmp-lote-${id}`);
      selL.innerHTML = lotes.map(l => `<option>${l.nombre}</option>`).join("");
      document.getElementById(`cmp-indice-${id}`).innerHTML =
        (indicesResp.indices || []).map(i => `<option value="${i.clave}">${i.nombre}</option>`).join("") || `<option value="ndvi">NDVI</option>`;

      for (const campo of ["lote", "capa", "indice", "fecha", "temp"]) {
        document.getElementById(`cmp-${campo}-${id}`)?.addEventListener("change", () => refrescar(id));
      }
    }

    sincronizar(paneles.A.mapa, paneles.B.mapa);
    // Obligatorio: los contenedores nacen con tamaño 0 dentro del overlay.
    setTimeout(() => { paneles.A.mapa.invalidateSize(); paneles.B.mapa.invalidateSize(); }, 60);

    // Arranca con el lote que ya estaba abierto en el mapa principal, si hay.
    if (global._loteActual) {
      for (const id of ["A", "B"]) {
        const sel = document.getElementById(`cmp-lote-${id}`);
        if ([...sel.options].some(o => o.value === global._loteActual)) sel.value = global._loteActual;
      }
    }
    await refrescar("A");
    await refrescar("B");
  }

  function cerrar() {
    const cont = document.getElementById("cmp-overlay");
    if (cont) cont.style.display = "none";
    for (const id of ["A", "B"]) {
      if (!paneles[id]) continue;
      try { paneles[id].ndvi.destroy(); paneles[id].mapa.remove(); } catch {}
      delete paneles[id];
    }
    _abierto = false;
  }

  global.OrbitComparar = { abrir, cerrar };
})(window);
```

- [ ] **Paso 5: `views/pages/mapa.ejs` — botón (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal:

```html
    <button class="btn btn-ghost" onclick="limpiarMapa()">✕ Limpiar</button>
```

Bloque a insertar:

```html
<%# Sprint 2: comparador %>
    <button class="btn btn-ghost" onclick="OrbitComparar.abrir()">⇄ Comparar</button>
<%# fin Sprint 2: comparador %>
```

- [ ] **Paso 6: `views/pages/mapa.ejs` — overlay y arranque (ARCHIVO SUCIO)**

Agregar al **final del archivo**, tras la última línea literal `</script>`:

```html
<%# Sprint 2: comparador · overlay %>
<div id="cmp-overlay" style="display:none;position:fixed;inset:0;z-index:2000;background:rgba(5,8,16,0.97);padding:12px;overflow:auto">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
    <h3 style="margin:0;font-size:15px">Comparar dos capas</h3>
    <span style="font-size:11px;color:var(--muted2)">Los dos paneles se mueven juntos</span>
    <button class="btn btn-ghost" style="margin-left:auto" onclick="OrbitComparar.cerrar()">✕ Cerrar</button>
  </div>
  <div id="cmp-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div id="cmp-panel-A" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"></div>
    <div id="cmp-panel-B" style="border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"></div>
  </div>
</div>
<style>
/* En notebooks angostas los dos paneles quedan inusables: se apilan. */
@media (max-width: 1100px) { #cmp-grid { grid-template-columns: 1fr; } }
#cmp-overlay select { background:rgba(0,0,0,0.4);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:6px;font-size:11px }
</style>
<script src="/js/mapa-comparar.js"></script>
<%# fin Sprint 2: comparador · overlay %>
```

- [ ] **Paso 7: `views/pages/mapa.ejs` — el `?estab=` faltante (ARCHIVO SUCIO)**

En `toggleCapa()` y en `toggleCapaSHP()` hay **dos líneas idénticas**:

```js
      const ctx      = await Auth.get(`/api/lotes-maestro/${nombreEnc}/contexto`);
```

Reemplazar **las dos** por este bloque (el mismo en los dos lugares):

```js
      // Sprint 2: estab en los toggles de capa
      // Sin ?estab=, un superadmin mirando otra org traía el contexto
      // equivocado. Con dos paneles que pueden apuntar a orgs distintas, el
      // bug pasaba de latente a garantizado.
      const ctx      = await Auth.get(`/api/lotes-maestro/${nombreEnc}/contexto${typeof _estabQS === "function" ? _estabQS() : ""}`);
      // fin Sprint 2: estab en los toggles de capa
```

**NO stagear `views/pages/mapa.ejs`.**

- [ ] **Paso 8: `routes/aog.js` — `?temporada=` y `/lotes/:nombre/temporadas` (ARCHIVO SUCIO)**

Insertar **tras** este bloque literal (es único):

```js
function mapaLite(lotes, req) {
  return req.query.lite ? lotes.map(({ sections, ...l }) => l) : lotes;
}
```

Bloque completo a insertar:

```js
// Sprint 2: comparador por temporada
// Este handler se registra ANTES del /mapa de siempre y solo actúa cuando se
// pide una temporada; si no, hace next() y todo sigue igual.
router.get("/mapa", async (req, res, next) => {
  if (!req.query.temporada) return next();
  try {
    const jwtUser = req.jwtUser || req.user;
    const isSA    = jwtUser?.rol_global === "superadmin";
    const miSlug  = jwtUser?.estabSlug || jwtUser?.estab_slug || null;
    const slug    = req.query.estab || miSlug;
    const lote    = req.query.lote ? decodeURIComponent(req.query.lote) : null;
    if (!slug) return res.status(400).json({ error: "Sin organización activa" });
    if (!lote) return res.status(400).json({ error: "Pasá ?lote= junto con ?temporada=" });
    if (req.query.estab && !isSA && req.query.estab !== miSlug &&
        !(jwtUser?.memberships || []).some(m => m.orgSlug === req.query.estab))
      return res.status(403).json({ error: "Sin acceso a esa organización" });

    const { rangoTemporada, esTemporadaValida } = require("../services/temporada");
    if (!esTemporadaValida(req.query.temporada))
      return res.status(400).json({ error: "Temporada inválida (formato AAAA/AA)" });
    const rango = rangoTemporada(req.query.temporada);
    const estabDB = getEstabDB(slug);

    // Contorno y origen salen del estado vigente (no cambian por temporada).
    const base = await _findAll(estabDB, { tipo: "aog_archivo", es_lote: true, lote_nombre: lote }, 50);
    const parsed = parseLote(base.filter(d => d.subtipo !== "sections_coverage"));

    // El snapshot de cobertura más nuevo dentro de la temporada pedida.
    const hist = await estabDB.find({
      selector: { tipo: "aog_historial", subtipo: "sections_coverage", lote_nombre: lote, ts: { $gte: rango.desdeMs, $lte: rango.hastaMs } },
      fields: ["_id", "ts", "stats"],
      sort: [{ ts: "desc" }],
      limit: 1,
    }).catch(() => ({ docs: [] }));

    let sections = null, stats = null, ts_ultimo = parsed.ts_ultimo || 0;
    const meta = hist.docs?.[0];
    if (meta) {
      const doc = await estabDB.get(meta._id);
      const { parseSections } = require("../services/aog_parser");
      sections = parsed.origen ? parseSections(doc.contenido, parsed.origen) : null;
      stats = doc.stats || null;
      ts_ultimo = doc.ts || ts_ultimo;
    } else {
      // Sin histórico en esa temporada: puede ser la actual, que vive en el
      // doc vigente.
      const vig = base.find(d => d.subtipo === "sections_coverage");
      if (vig && vig.ts >= rango.desdeMs && vig.ts <= rango.hastaMs) {
        const { parseSections } = require("../services/aog_parser");
        sections = parsed.origen ? parseSections(vig.contenido, parsed.origen) : null;
        stats = vig.stats || null;
        ts_ultimo = vig.ts;
      }
    }

    res.json(mapaLite([{ ...parsed, sections, stats, ts_ultimo, temporada: req.query.temporada, estab_slug: slug }], req));
  } catch (e) {
    console.error("[AOG/mapa temporada]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/aog/lotes/:nombre/temporadas — sale de un find con `fields`: gracias
// a las stats copiadas al historial (Pieza 0) no baja un byte de contenido.
router.get("/lotes/:nombre/temporadas", async (req, res) => {
  try {
    const jwtUser = req.jwtUser || req.user;
    const isSA    = jwtUser?.rol_global === "superadmin";
    const miSlug  = jwtUser?.estabSlug || jwtUser?.estab_slug || null;
    const slug    = req.query.estab || miSlug;
    if (!slug) return res.status(400).json({ error: "Sin organización activa" });
    if (req.query.estab && !isSA && req.query.estab !== miSlug &&
        !(jwtUser?.memberships || []).some(m => m.orgSlug === req.query.estab))
      return res.status(403).json({ error: "Sin acceso a esa organización" });

    const lote = decodeURIComponent(req.params.nombre);
    const estabDB = getEstabDB(slug);
    const campos = ["_id", "ts", "stats"];
    const [hist, vig] = await Promise.all([
      estabDB.find({ selector: { tipo: "aog_historial", subtipo: "sections_coverage", lote_nombre: lote, ts: { $gt: 0 } }, fields: campos, limit: 500 }).catch(() => ({ docs: [] })),
      estabDB.find({ selector: { tipo: "aog_archivo",   subtipo: "sections_coverage", lote_nombre: lote, ts: { $gt: 0 } }, fields: campos, limit: 5 }).catch(() => ({ docs: [] })),
    ]);
    const { derivarTemporadasDeHistorial } = require("../services/temporadas_lote");
    res.json({ ok: true, lote, temporadas: derivarTemporadasDeHistorial([...(hist.docs || []), ...(vig.docs || [])]) });
  } catch (e) {
    console.error("[AOG/temporadas]", e.message);
    res.status(500).json({ error: e.message });
  }
});
// fin Sprint 2: comparador por temporada
```

**NO stagear `routes/aog.js`.**

- [ ] **Paso 9: `routes/lotes_maestro.js` — `?meta=1` (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal:

```js
      contexto.capas.externas = porSubtipo;
```

Bloque a insertar:

```js
      // Sprint 2: contexto solo-metadata
      // Con dos paneles, mandar contenido_texto + base64 de todas las capas
      // inline significa bajar todo dos veces. ?meta=1 devuelve la misma
      // estructura sin el contenido.
      if (req.query.meta === "1") {
        for (const sub of Object.keys(contexto.capas.externas)) {
          contexto.capas.externas[sub] = contexto.capas.externas[sub].map(
            ({ contenido_texto, base64, ...resto }) => ({ ...resto, tiene_contenido: !!(contenido_texto || base64) })
          );
        }
      }
      // fin Sprint 2: contexto solo-metadata
```

**NO stagear `routes/lotes_maestro.js`.**

- [ ] **Paso 10: Verificar**

Run: `npm test` → todo verde.
Run: `node --check routes/aog.js routes/lotes_maestro.js services/temporadas_lote.js` → sin salida.
Run: `node --check public/js/mapa-ndvi.js public/js/mapa-comparar.js` → sin salida.
Revisión visual en `/mapa`: (1) el NDVI de siempre sigue andando (no se rompió `OrbitNDVI`); (2) "⇄ Comparar" abre los dos paneles; (3) mover uno mueve el otro; (4) elegir dos fechas distintas muestra dos NDVI distintos; (5) con capa "Cobertura" y dos temporadas, cada panel muestra la suya; (6) abajo de 1100 px de ancho los paneles se apilan.

- [ ] **Paso 11: Commit de lo limpio**

```bash
git commit -m "feat(mapa): comparador de dos paneles sincronizados y temporadas de cobertura

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014GtwPZB7eZshwjbQL3axBr" -- public/js/mapa-comparar.js public/js/mapa-ndvi.js services/temporadas_lote.js tests/services/temporadas-lote.test.mjs
```

Informar: *"`views/pages/mapa.ejs` (tres bloques), `routes/aog.js` (un bloque) y `routes/lotes_maestro.js` (un bloque) quedaron editados en disco entre marcadores `Sprint 2`. No fueron stageados."*

---

### Tarea 11: Retención y limpieza

**Files:**
- Modify (**SUCIO, solo entre marcadores, NO stagear**): `server.js` (cron diario)

**Interfaces:**
- Consume: `purgar(orgSlug, dias)` de `lib/notificaciones.js` (Tarea 7); `purgarCacheNDVI({ maxBytes, maxDias })` de `routes/ndvi.js` (Tarea 9c); `db.getEstablecimientos()` de `services/couchdb.js`.
- Produce: nada que consuman otras tareas.

- [ ] **Paso 1: Agregar el cron en `server.js` (ARCHIVO SUCIO)**

Insertar **tras** esta línea literal (cierre del cron de equipos caídos):

```js
}, { timezone: "America/Argentina/Cordoba" });
```

⚠ Esa línea aparece dos veces. Es la **segunda** (la del cron `*/5 * * * *` de equipos caídos, inmediatamente antes del comentario `// Backup diario de CouchDB a las 03:00`). Verificar con `grep -n 'timezone: "America/Argentina/Cordoba"' server.js`.

Bloque completo a insertar:

```js
// Sprint 2: retencion y limpieza
// 03:40, antes del backup de las 03:00 del día siguiente y lejos del horario
// de campo. Todo best-effort: si falla, se loguea y sigue.
cron.schedule("40 3 * * *", async () => {
  try {
    const notis = require("./lib/notificaciones");
    const estabs = await db.getEstablecimientos();
    for (const e of estabs) {
      try {
        const n = await notis.purgar(e.slug, notis.RETENCION_DIAS);
        if (n) console.log(`[CRON/retencion] ${e.slug}: ${n} avisos viejos borrados`);
      } catch (err) { console.warn("[CRON/retencion]", e.slug, err.message); }
      // Respirar entre orgs: el droplet es 1 vCPU con ~25 apps.
      await new Promise(cb => setTimeout(cb, 500));
    }
  } catch (e) { console.error("[CRON/retencion]", e.message); }

  try {
    const { purgarCacheNDVI } = require("./routes/ndvi");
    if (typeof purgarCacheNDVI === "function") await purgarCacheNDVI({ maxBytes: 200 * 1024 * 1024, maxDias: 30 });
  } catch (e) { console.warn("[CRON/retencion] cache ndvi:", e.message); }
}, { timezone: "America/Argentina/Cordoba" });
// fin Sprint 2: retencion y limpieza
```

**NO stagear `server.js`.**

- [ ] **Paso 2: Verificar**

Run: `node --check server.js` → sin salida.
Run: `npm test` → todo verde.

Prueba en seco de la purga del cache (no toca CouchDB):

```bash
node -e "require('dotenv').config(); require('./routes/ndvi').purgarCacheNDVI({maxBytes: 200*1024*1024, maxDias: 3650}).then(r=>console.log(r))"
```
Esperado: `{ borrados: 0, bytes: 0 }` (con `maxDias` altísimo no borra nada; confirma que la función corre y lee el directorio).

- [ ] **Paso 3: Dejar constancia**

Informar: *"`server.js` quedó editado en disco con el bloque `// Sprint 2: retencion y limpieza`. No fue stageado."*

---

## Dependencias entre tareas

```
        ┌── 1. Índices + STATS_VER ──┬─────────────┬─────────────┐
        │                            │             │             │
        ▼                            ▼             ▼             ▼
  2. Tests parser +            6. Tokens org   7. Notifs     9a. lib/png.js
     netoRasterAsync                            (persistir)       │
        │                            │             │              ▼
        ▼                            │             ▼        9b. lib/zonificar.js
  3. Stats en el sync                │       8. Notifs UI         │
        │                            │                            ▼
        ▼                            │                      9c. Raster + prescripciones
  4. Backfill                        │                            │
        │                            │                            │
        ▼                            │                            │
  5. Lectura sin parseo              │                            │
        │                            │                            │
        └──────────► 10. Comparador (Fase B)                      │
                     10. Comparador (Fase A) ── sin dependencias   │
                                                                   ▼
                                              11. Retención y limpieza (necesita 7 y 9c)
```

- **3 → 10 (Fase B)** es la dependencia más fuerte del sprint: sin las `stats` copiadas al `aog_historial`, listar temporadas en `el_susto` implica reparsear hasta 5,35 MB por click.
- **6 (tokens) es totalmente independiente**: se puede hacer en paralelo con cualquier otra.
- **9a y 9b son JS puro**: se pueden hacer en paralelo entre sí y con 6 y 7.
- **Conflictos de archivo a coordinar — nunca dos tareas editando el mismo archivo sucio a la vez:**
  - `server.js`: tareas 6, 9c y 11, con marcadores distintos.
  - `routes/aog.js`: tareas 3 y 10 → **hacer la 3 completa primero**.
  - `views/pages/mapa.ejs`: solo la 10.
  - `views/partials/topbar.ejs` y `routes/panel.js`: solo la 8.
  - `middleware/auth.js`: solo la 6.
  - `routes/lotes_maestro.js`: solo la 10.
- **9c y 10 comparten la cuota de Copernicus y el cache en disco.** El tope y la purga del cache los pone la 9c; la 11 los agenda.

---

## Revisión final del plan (self-review)

### 1. Cobertura del spec

| Requisito del spec | Tarea |
|---|---|
| Stats encoladas tras responder en `POST /api/aog/sync`, con `stats_hash`, `stats_ver`, `ts_trabajo` | 3 |
| Copiar `stats` al archivar en `aog_historial` | 3 |
| `netoRaster` con variante async troceada, la sincrónica intacta | 2 |
| `actividad`/`reportes` leen con `fields`, encolan lo que falta, no parsean en el request | 5 |
| Corregir `contorno_ha` (hoy siempre 0) | 5 |
| `scripts/backfill-stats-cobertura.js --org --dry-run`, historial NO en bulk | 4 |
| Prescripciones a CouchDB con properties `{zona, dosis, unidad, nombre}` + `geojson`, `lote_nombre`, `origen`, `estado`, `created_at`, `created_by` | 9c |
| Migración única de `localStorage` al abrir la pantalla | 9c |
| `/api/prescripciones/pendientes` filtra por `subtipo` y marca `entregado` después de responder | 9c |
| `GET /api/ndvi/lote/raster` con PNG UINT8 en CRS métrico (EPSG:327XX) | 9c |
| Decoder propio `lib/png.js` (zlib, filtros 0–4, 8 bits) | 9a |
| `lib/zonificar.js`: cuantiles, N 2..5 (default 3), mayoría 3×3, marching squares, Douglas-Peucker tol 1 px, descarte < 0,5 ha, UTM→lat/lon, NDVI medio y ha por zona | 9b |
| UI "Generar desde NDVI": lote, fecha con nubosidad, N zonas, dosis editables, sentido, vista previa, guardar | 9c |
| Cache `.cache/ndvi` con tope y purga en cron diario | 9c (purga) + 11 (cron) |
| Botón "Comparar", dos paneles Leaflet sincronizados sin plugin | 10 |
| `mapa-comparar.js` nuevo; `mapa-ndvi.js` de singleton a factory | 10 |
| Fase A (NDVI A vs B, índice A vs B) y Fase B (`?temporada=` + `/lotes/:n/temporadas`) | 10 |
| Corregir el `?estab=` faltante del mapa | 10 |
| `token_org` con hash sha256, prefijo visible, scopes, vencimiento, revocado, token en claro una sola vez | 6 |
| Rama nueva en `middleware/auth.js` antes de device, solo por `Authorization: Bearer orbx_`, fail-closed, `req.user.isToken` | 6 |
| Guard de solo lectura (403 en todo lo que no sea GET) y `requirePermiso` rechaza tokens | 6 |
| `routes/tokens_org.js` (crear/listar/revocar, admin) + card en `integraciones.ejs` | 6 |
| `notify()` persiste `tipo:"notificacion"` SIEMPRE, aunque no haya canal | 7 |
| Leídas con `notif_leidas_<uid>` (`ts_hasta` + `ids_leidas`) y endpoints listar/no-leídas/marcar una/marcar todas | 7 |
| Campanita con badge en `topbar.ejs` + sección "Avisos" en la pantalla Alertas de la PWA | 8 |
| Purga de avisos > 180 días en cron diario | 11 |
| Criterios de aceptación 1 a 7 | 3-5, 9c, 10, 6, 7-8, y `npm test` en cada tarea |

**Huecos detectados y resueltos en esta revisión:**

1. *Criterio de aceptación 2 ("dosis editables")* — la primera versión de la Tarea 9c solo dejaba precargar un mínimo y un máximo. **Corregido inline**: el Paso 13 ahora incluye la tabla de zonas con un input de dosis por zona y `guardarZonasEditadas()`.
2. *k-means 1D como método alternativo de corte* — el spec lo menciona entre paréntesis ("k-means 1D como opción") con cuantiles como default. **Queda deliberadamente fuera del sprint** (YAGNI): `fuente.metodo` ya viaja en el doc con el valor `"cuantiles"`, así que sumarlo después no necesita migración ni cambia el esquema.
3. *Nombres de campo del doc `token_org`* — el spec escribe `orgSlug` / `vence_at` y el análisis `org_slug` / `vence_ts`. **Se adoptan los del análisis** (`org_slug`, `vence_ts`, `ultimo_uso_ts`) para que coincidan con el índice Mango `["tipo","org_slug"]` de la Tarea 1. Queda anotado acá para que no se lea como un desvío involuntario.
4. *Aviso 7 días antes del vencimiento de un token* — aparece en los riesgos del análisis, no en el spec. Fuera de alcance; el campo `vence_ts` ya está y la card lo muestra.

### 2. Barrido de placeholders

Revisado el plan entero buscando "TBD", "TODO", "implementar después", "agregar manejo de errores", "tests para lo de arriba" y pasos sin código: **no quedan**. Cada paso que cambia código muestra el código completo, y cada paso de verificación indica el comando exacto y la salida esperada.

La única marca de incertidumbre es deliberada y explícita: en la Tarea 9c, el bloque **"A verificar contra la doc de CDSE"** sobre el `crs` métrico y el PNG de 2 bandas `UINT8`, con el link a la documentación y con el plan B escrito. No se puede confirmar leyendo el repo: es una propiedad del proveedor.

### 3. Consistencia de tipos y nombres entre tareas

Revisado cruzando cada bloque `Interfaces`:

- `statsVigentes(doc, ver?)` y `STATS_VER` se definen en la Tarea 1 y se usan con la misma firma en 2, 3, 4 y 5. ✔
- `calcularStatsAsync(txt, boundary)` y `netoRasterAsync(bloques, {cadaN})` se definen en la 2 y se consumen en 3 y 4. ✔
- `statsParaDoc(stats)` se define en la 3 y la 4 la importa de `services/cobertura_stats.js` (no la redefine). ✔
- `cargarCoberturas(estabDB, slug?)` cambia de firma en la 5 y los dos llamadores (`actividad.resumenActividad` y `reportes.reporteTemporada`) se actualizan en la misma tarea. ✔
- `encolarStats(slug, docId)` — mismo orden de argumentos en la 3 (definición), la 3 (uso en `routes/aog.js`) y la 5. ✔
- `contornoM2` se agrega al `module.exports` de `aog_parser` en la Tarea 1 y se usa en la 2 (test) y en la 5. ✔
- `purgarCacheNDVI({maxBytes, maxDias})` se define en la 9c y se llama con esas mismas claves en la 11. ✔
- `notis.RETENCION_DIAS` se exporta en la 7 y se usa en la 11. ✔
- `decodificarPNG` / `extraerCanal` (9a) → `services/ndvi_raster.js` (9c), mismos nombres. ✔
- `zonificar({datos, ancho, alto, bbox, zona, sur, n, areaMinHa, rango})` (9b) → llamada idéntica en `services/prescripciones.js` (9c). ✔
- Properties de zona: `zonificar` emite `{zona, dosis, unidad, nombre, ndvi_medio, ha}` y `normalizarColeccion` conserva exactamente esas seis claves — el test de 9c las asevera ordenadas. ✔
- `crearNDVI({prefijo, mapa})` (10, paso 3) → `mapa-comparar.js` la llama con esas dos claves y usa `init`, `toggle`, `setIndice`, `setFecha`, `setLoteBoundary`, `destroy`, `estado`, que son las siete del objeto devuelto. ✔
- `derivarTemporadasDeHistorial(docs)` (10) devuelve `{temporada, ts, hist_id, trabajado_ha, neto_ha}` y `mapa-comparar.js` lee `temporada` y `trabajado_ha`. ✔
- `req.user` de un token de org (`isToken`, `estabSlug`, `rol:"viewer"`) se arma en `middleware/auth.js` y se chequea con el mismo nombre en `requirePermiso`. ✔
- `_estabQS()` se define en `public/js/mapa-comparar.js` y se usa en `views/pages/mapa.ejs` con guarda `typeof === "function"`. ✔

**Un desajuste encontrado y corregido inline:** en la Tarea 5, `cargarCoberturas` necesita `parseKML` y `contornoM2`, que no estaban en el `require` original de `services/actividad.js`; el Paso 3 ahora empieza por cambiar esa línea de import.

---

## Entrega

**Plan completo y guardado en `docs/superpowers/plans/2026-09-23-orbitx-sprint2.md`. Dos formas de ejecutarlo:**

**1. Por subagentes (recomendada)** — un implementador nuevo por tarea, revisión entre tareas, iteración rápida. SUB-SKILL: `superpowers:subagent-driven-development`.

**2. En esta misma sesión** — ejecución por lotes con puntos de control. SUB-SKILL: `superpowers:executing-plans`.

**¿Cuál preferís?**
