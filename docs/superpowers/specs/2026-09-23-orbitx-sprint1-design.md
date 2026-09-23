# OrbitX Sprint 1 — "sistema completo": Inicio, reporte, notificaciones, mapa, releases, menú

**Fecha:** 2026-09-23 · **Estado:** aprobado (decisión del dueño: "los 5 de primero + Inicio reordenado")
**Origen:** análisis competitivo frente a Panorama (Precision Planting) y análisis técnico `.superpowers/sdd/sprint1-analisis.md`.
**Rama:** `feature/sprint1-sistema` (desde `feature/app-movil-pwa`).

## Objetivo

Que OrbitX deje de ser "un mapa con módulos sueltos" y se lea como un sistema: abre resumiendo la operación, produce un reporte que se puede mostrar a terceros, avisa por el canal que cada org eligió, deja consultar el mapa tocándolo, publica sus releases, y tiene un menú con cuatro secciones claras.

## Alcance (seis piezas)

| # | Pieza | Qué entrega |
|---|---|---|
| 1 | **Inicio con actividad** | Un endpoint `GET /api/actividad/resumen` (por org, temporada actual) y su uso en el dashboard del panel y en una pestaña "Inicio" nueva de la app móvil: ha trabajadas / netas / lotes de la temporada, equipos en línea, lluvia acumulada del mes, alertas activas y los últimos eventos (lote sincronizado, lluvia cargada, alerta, equipo que volvió a reportar). |
| 2 | **Reporte por temporada** | `GET /api/reportes/temporada` (por org y temporada) + vista HTML imprimible `/reportes/temporada` con `@media print`: por lote nombre, cultivo, ha estimadas, ha trabajadas / netas / repintado, lluvias del período; totales; "Guardar como PDF" del navegador. Sin `pdfkit`/`puppeteer`. |
| 3 | **Notificaciones por evento y canal** | Enganchar la matriz existente `lib/notify-org.js` (Telegram / WhatsApp / email por org, configurable en Integraciones) a los eventos reales: `alerta_critica`, `nodo_caido`, `reporte_diario`, `firmware_listo`. Hoy solo la usa el botón de prueba. |
| 4 | **Click en el mapa → registro** | En `views/pages/mapa.ejs`, tocar un bloque de cobertura muestra: lote, bloque N de M, ha trabajadas / netas / repintado del lote, cultivo y temporada. Con los datos de hoy no hay fecha/velocidad por pasada (el formato `sections_coverage` no las trae): se documenta como Fase 2 del pipeline PilotX→OrbitX. |
| 5 | **Releases públicas de PilotX** | Página pública `/releases` (sin login, fuera del layout) con versiones, notas y descarga de los productos curados, más `/flash-publico` con las carpetas de ESP Web Tools que ya tienen manifest. Endpoints `GET /api/ota/publico` y `GET /api/ota/publico/firmware/:producto/:version` con lista blanca de productos y límite de descargas por IP. `/flash` (con login) no se toca. |
| 6 | **Menú en 4 secciones** | `views/partials/sidebar.ejs` reagrupado: **Campo** (mapa, lotes, lluvias, alertas, tracking, prescripciones, VistaX, VistaX·mapas), **Equipos** (dispositivos, vehículos, cámaras, configuraciones, firmwares, flasheo), **Análisis** (Inicio, agrarIA, Reportes), **Administración** (establecimientos, equipo, soporte, registros, usuarios, roles, integraciones, grupos, config, CouchDB). Los guards por ruta no cambian. |

## Decisiones

- **Temporada** = año agrícola del hemisferio sur: del 1 de septiembre al 31 de agosto. Clave `"2026/27"` para fechas entre 2026-09-01 y 2027-08-31. `services/temporada.js` la deriva de una fecha y da el rango; el campo libre `lote_maestro.temporada` se respeta si existe, si no se deriva del `ts` de los archivos de PilotX del lote.
- **Hectáreas trabajadas** salen de `calcularStats()` de `services/aog_parser.js` (ya en producción: `trabajado_ha, neto_ha, repintado_ha, repintado_pct, contorno_ha, bloques`). El local estaba atrasado respecto de prod en ese archivo; se sincronizó el 2026-09-23 antes de este sprint.
- **Sin full scans**: ninguna consulta nueva usa `$in` sobre `tipo` ni `db.list({include_docs:true})`. Se agregan a `ESTAB_INDEX_FIELDS` los índices `["tipo","ts_inicio"]` y `["tipo","temporada"]`. El resumen de actividad se cachea en memoria 5 minutos por org (el parseo de coberturas es caro).
- **Productos públicos** en releases: lista blanca `VistaX, QuantiX, FlowX, SectionX, ToolX, StormX` (firmwares ESP32). Quedan fuera `PilotX` (ZIP de hasta 300 MB), `PilotXParche`, `PilotXAndroid`, `CoreX-ECU` y cualquier otro interno. Descargas públicas: máximo 20 por IP por hora, en memoria.
- **Notificaciones**: la matriz por org es la fuente de verdad (Integraciones → Notificaciones). El push de la app móvil sigue en paralelo para alerta y equipo caído. Best-effort siempre: un fallo de canal nunca aborta el evento.
- **Panel y app móvil comparten endpoints**: el dashboard del panel consume `/api/actividad/resumen` desde el navegador (JWT en cookie, ya aceptado por `middleware/auth.js`), igual que la app. Así el resumen se construye una vez.
- **Archivos con ediciones locales sin commitear** (`routes/panel.js`, `routes/aog.js`, `routes/lotes_maestro.js`, `routes/tracking.js`, `server.js`, `views/pages/mapa.ejs`, `views/partials/sidebar.ejs`, `views/partials/topbar.ejs`, `lib/firmware.js`, `public/js/tracking-mapa.js`): se editan **en disco** (lo que corre en prod) y se commitean por marcadores como en el sprint anterior. Se evita tocarlos cuando hay una alternativa: por eso `actividad`, `reportes` y `ota publico` viven en routers propios.

## Fuera de alcance

Comparación de capas lado a lado, importación shapefile/ISOXML, zonas automáticas, asistente con herramientas, portal de distribuidor, edición remota de configuración, fecha/velocidad por pasada (requiere cambiar el pipeline en PilotX), unificar `push_token` legacy, VAPID desde el panel.

## Criterios de aceptación

1. Con La Flora activa, `/api/actividad/resumen` responde en < 2 s (cache) con ha trabajadas > 0, equipos y últimos eventos; el dashboard y la pestaña Inicio los muestran.
2. `/reportes/temporada?temporada=2025/26` de La Flora imprime desde Chrome como PDF con los lotes de esa temporada y totales.
3. Una alerta nueva que llega por sync dispara Telegram/WhatsApp/email según la matriz de la org (probado con el botón de prueba y con una alerta real).
4. En `/mapa`, tocar un bloque de cobertura abre el popup con bloque N/M y las hectáreas del lote.
5. `https://orbitx.agroparallel.com/releases` abre sin login, lista solo productos curados, y descarga un `.bin`; `/api/ota/publico/firmware/PilotX/…` responde 404.
6. El sidebar muestra las 4 secciones para un `owner` y las secciones de administración solo con los ítems que su rol ya podía abrir.
7. `npm test` pasa con los tests nuevos de temporada, resumen de actividad (puro) y agregación del reporte (puro).
