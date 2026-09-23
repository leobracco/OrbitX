# OrbitX Sprint 2 — "ver → hacer" (diseño)

Fecha: 2026-09-23. Rama: `feature/sprint2-ver-hacer` (desde `feature/sprint1-sistema` 8f6804e).
Origen: análisis competitivo de Panorama (bloque "segundo") + prerrequisito técnico del Sprint 1.
Análisis técnico de base: `.superpowers/sdd/sprint2-analisis.md` (medido sobre la base de producción).

## Objetivo

Que OrbitX pase de mostrar el dato a actuar sobre él: stats de cobertura precalculadas en el sync,
zonas y prescripción generadas desde NDVI que QuantiX consuma, comparación de dos capas del mismo lote,
tokens de acceso por organización para terceros, e historial de notificaciones con marcar leídas.

## Alcance (en este orden)

0. **Stats de cobertura en el sync** (prerrequisito).
1. **Zonas y prescripción automáticas desde NDVI** (incluye persistir prescripciones en CouchDB).
2. **Comparar dos capas lado a lado** en el mapa del panel.
5. **Tokens de acceso por organización.**
6. **Historial de notificaciones con "marcar leídas".**

Fuera de alcance: cosecha, facturación, voz, integraciones norteamericanas, portal de distribuidor,
edición remota de configuración del piloto, importación de shapefile/ISOXML (sprint siguiente).

## Restricciones globales

- Castellano rioplatense en todo texto cliente-facing, comentarios, logs y commits. Rebranding:
  nunca "AgOpenGPS"/"AOG" → "PilotX"; "AgIO" → "CoreX"; "Teensy" → "CoreX ECU".
- Node 20 en producción, 1 vCPU / 1 GB compartido con ~25 apps: ningún trabajo sincrónico > 50 ms
  en el camino de un request; lo pesado va en cola de concurrencia 1 troceada con `setImmediate`.
- Sin dependencias nativas ni librerías de imagen/geo nuevas: `package.json` tiene 12 deps y así queda.
  PNG se decodifica con `zlib` nativo; la geometría es JS puro.
- Ningún `db.list({include_docs:true})` nuevo. Toda query nueva con índice Mango y `fields`.
- Fechas cliente-facing en TZ `America/Argentina/Buenos_Aires`.
- Archivos sucios del usuario (`routes/aog.js`, `middleware/auth.js`, `server.js`, `views/pages/mapa.ejs`,
  `views/partials/topbar.ejs`, `routes/panel.js`, `routes/lotes_maestro.js`) se tocan SOLO entre
  marcadores `// Sprint 2: <pieza>` … `// fin Sprint 2: <pieza>` (en EJS `<%# Sprint 2: <pieza> %>`),
  nunca se stagean por el implementador; el controlador arma los commits.
- Tests con `node --test` sobre lógica pura; sin mocks de CouchDB.
- Nunca escribir en la CouchDB de producción desde tests ni desde el desarrollo local.

## Pieza 0 — Stats de cobertura en el sync

- En `POST /api/aog/sync`, cuando el archivo es `sections_coverage`, después de responder `{ok:true}` se
  encola el cálculo de `calcularStats` (cola de concurrencia 1, dedupe por `_id`, versión `stats_ver`).
  El doc `aog_archivo` queda con `stats`, `stats_hash` (sha256 del contenido), `stats_ver` y
  `ts_trabajo` (= `ts`, que es la mtime del archivo en la PC según lo medido).
- Al archivar el doc anterior en `aog_historial`, se copian sus `stats` (costo cero).
- `netoRaster` gana una variante async troceada con `setImmediate` cada N bloques; la sincrónica queda
  para los callers actuales.
- `services/actividad.js` y `services/reportes.js` leen `stats` con `fields` (sin `contenido`); si un doc
  no tiene `stats` vigentes, se encola su cálculo y se lo omite hasta la próxima (no se parsea en el
  request). Se corrige `contorno_ha` (hoy siempre 0 por `boundary=null`).
- Script `scripts/backfill-stats-cobertura.js --org <slug> [--dry-run]` para los docs vigentes
  (390 en total); el historial NO se migra en bulk.

## Pieza 1 — Zonas y prescripción desde NDVI

- **Prescripciones pasan a CouchDB**: doc `tipo:"prescripcion"` en la DB de la org, un solo esquema de
  properties por zona: `{ zona: n, dosis: number, unidad: string, nombre: string }` + GeoJSON
  `FeatureCollection` en `geojson`, `lote_nombre`, `origen: "manual"|"ndvi"|"import"`, `estado`,
  `created_at`, `created_by`. La pantalla `prescripciones.ejs` migra lo que haya en `localStorage`
  una vez (al abrir, si hay docs locales que no existen en el server, los sube y marca migrados).
  `/api/prescripciones/pendientes` filtra por `subtipo` y marca `entregado` después de responder.
- **Raster NDVI**: `routes/ndvi.js` gana `GET /api/ndvi/lote/raster?lote=&fecha=&indice=` que pide a
  Copernicus (CDSE, credenciales en `config_sistema`) un PNG UINT8 en CRS métrico (UTM por longitud,
  EPSG:32719/32720/32721 según corresponda) con el evalscript FLOAT32 existente escalado a 0..255.
  Decoder propio `lib/png.js` (zlib nativo, filtros 0–4, 8 bits gris/RGB/RGBA).
- **Zonificación** `lib/zonificar.js`, JS puro y testeable: clasificación en N zonas (N = 3 por defecto,
  2..5) por cuantiles (k-means 1D como opción), filtro de mayoría 3×3, vectorización por marching
  squares, simplificación Douglas-Peucker (tolerancia = 1 píxel), descarte de polígonos < 0,5 ha (se
  funden con el vecino), reproyección UTM → lat/lon para el GeoJSON final. Cada zona sale con NDVI
  medio y área en ha.
- **UI**: en `prescripciones.ejs`, panel "Generar desde NDVI": lote, fecha disponible (de
  `/api/ndvi/fechas-disponibles`), N zonas, dosis por zona editable (precargada proporcional al NDVI:
  zona baja = dosis alta o baja según un selector "más insumo donde hay menos vigor / más vigor"),
  vista previa en el mapa, guardar → doc `prescripcion` con `origen:"ndvi"`.
- Cache en disco `.cache/ndvi` con tope de tamaño y purga (cron diario).

## Pieza 2 — Comparar dos capas lado a lado

- Botón "Comparar" en el mapa del panel: dos paneles Leaflet 1.9.4 sincronizados (centro/zoom, ~15
  líneas propias, sin plugin), mismo lote, selector de capa + fecha/temporada por panel.
- Toda la lógica nueva en `public/js/mapa-comparar.js`; `public/js/mapa-ndvi.js` pasa de singleton a
  factory. `mapa.ejs` solo recibe markup y arranque entre marcadores.
- Fase A (sin backend): NDVI fecha A vs B, índice A vs B. Fase B (depende de Pieza 0): cobertura
  temporada A vs B vía `?temporada=` en `/api/aog/mapa` y `GET /api/aog/lotes/:nombre/temporadas`.
- Se corrige el `?estab=` faltante en las llamadas del mapa para superadmin.

## Pieza 5 — Tokens de acceso por organización

- Doc `token_org` en `orbitx_global`: `{ hash (sha256), prefijo visible (8 chars), orgSlug, nombre,
  scopes: ["lectura"], vence_at, revocado, creado_por, ultimo_uso }`. El token en claro (`orbx_` + 40
  chars base64url) se muestra UNA vez al crearlo.
- `middleware/auth.js`: rama nueva antes de la de device, solo por `Authorization: Bearer orbx_…`
  (nunca por `?token=` ni cookie), fail-closed, `req.user = { isToken:true, estabSlug, rol:"viewer",
  memberships:[…] }`; `requirePermiso` lo acepta como lectura. Endpoints de escritura rechazan tokens
  (guard `soloLectura`: método distinto de GET → 403).
- Administración: `routes/tokens_org.js` (crear/listar/revocar, requiere admin de la org) y card en
  `views/pages/integraciones.ejs`.

## Pieza 6 — Historial de notificaciones

- `lib/notify-org.js:notify()` persiste un doc `tipo:"notificacion"` en la DB de la org
  `{ evento, titulo, cuerpo, ts, url? }` SIEMPRE, aunque no haya canal habilitado.
- Leídas: doc `notif_leidas_<uid>` con `ts_hasta` (todo lo anterior está leído) + `ids_leidas` para
  marcado individual. Endpoints en `routes/notif_org.js`: listar paginado, no leídas (badge), marcar
  una, marcar todas.
- UI: campanita con badge y dropdown en `topbar.ejs` (panel); sección "Avisos" en la pantalla
  Alertas de la PWA. Retención: purga > 180 días en cron diario.

## Criterios de aceptación

1. Tras un sync de cobertura, el doc tiene `stats` en < 30 s sin que el request tarde más que hoy; el
   resumen de actividad de La Flora responde en < 500 ms en frío.
2. Desde Prescripciones, elegir un lote y una fecha NDVI y obtener 3 zonas con dosis editables,
   guardarlas y que aparezcan en `/api/prescripciones/pendientes` para el equipo.
3. Las prescripciones existentes en el navegador quedan en CouchDB tras abrir la pantalla.
4. En el mapa, "Comparar" muestra el mismo lote en dos paneles sincronizados con NDVI de dos fechas y
   con cobertura de dos temporadas.
5. Un token `orbx_` creado desde Integraciones lee `/api/actividad/resumen` y `/api/lotes` de su org,
   recibe 403 en cualquier POST, y 401 al revocarlo o vencer.
6. Cada notificación enviada por evento aparece en la campanita del panel y en Avisos de la PWA; marcar
   leídas baja el badge.
7. `npm test` verde; sin dependencias nuevas.
