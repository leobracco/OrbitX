# OrbitX Móvil — PWA, Fase 1

**Fecha:** 2026-09-21
**Estado:** aprobado, listo para plan de implementación
**Alcance:** primera fase de la app móvil de OrbitX para Android e iOS

---

## Objetivo

Dar acceso desde el celular a lo que hoy solo se puede mirar desde el panel de escritorio
de OrbitX, priorizando el uso en el campo: dónde están las máquinas, en qué lote, qué
llovió, qué alertas hay y qué equipo dejó de reportar.

Una sola aplicación sirve a los dos públicos —clientes (productores, contratistas) y
equipo interno de Agro Parallel— diferenciando por el sistema de roles que OrbitX ya
tiene.

---

## Decisiones tomadas

| Decisión | Elección | Motivo |
|---|---|---|
| Formato | PWA instalable, no apps de tienda | Una sola base para Android e iOS; se actualiza sola en cada deploy; sin cuenta Apple Developer ni reviews |
| Público | Ambos, misma app con permisos | OrbitX ya tiene 8 roles, matriz `PERMS` y multi-org; la infra existe |
| Alcance Fase 1 | Campo en vivo + estado de equipos | Máximo valor por trabajo invertido; sirve a los dos públicos desde el día uno |
| Offline | Datos cacheados + cola de escritura | En el lote no hay señal; hay que poder abrir la app y cargar una lluvia igual |
| Navegación | Mapa protagonista con panel arrastrable | Es lo que más se mira parado en el lote; en pantalla chica cada píxel cuenta |

---

## Punto de partida

Lo que ya existe y se reusa sin modificar:

- **API REST JSON completa** bajo `/api/*` con JWT Bearer (`middleware/auth.js` acepta
  header `Bearer`, cookie `orbitx_token` o `?token=`).
- **Tiempo real**: socket.io con `auth.socketMiddleware`, rooms por establecimiento
  (`estab:<slug>`), evento `tracking:position`.
- **Roles y permisos**: `roles.js` con 8 roles jerárquicos (`superadmin` 100 → `owner` 80
  → `admin_org` 70 → `agronomo` 50 → `contratista` 40 → `operador` 30 → `viewer`), matriz
  `PERMS` por recurso/acción, y `requirePermiso(recurso, accion)`.
- **Multi-org**: `POST /api/auth/cambiar-org` reemite el token con otra organización.
- **Leaflet autohospedado** en `public/lib/leaflet`, más `public/js/map_engine.js` y
  `public/js/tracking-mapa.js` con lógica de mapa ya resuelta.

Endpoints que consume la Fase 1, todos existentes:

| Endpoint | Uso |
|---|---|
| `GET /api/tracking/live` | Posición actual de todas las máquinas |
| socket `tracking:position` | Actualización en vivo |
| `GET /api/tracking/history/:deviceId` | Recorrido de una máquina |
| `GET /api/lotes`, `GET /api/lotes/:id` | Lista y detalle de lotes |
| `GET /api/lluvias`, `POST /api/lluvias` | Ver y cargar lluvias |
| `GET /api/alertas`, `GET /api/alertas/historial` | Alertas |
| `GET /api/devices` | Estado de los equipos |
| `GET /api/auth/me` | Rol y permisos del usuario |
| `POST /api/auth/cambiar-org` | Cambiar de establecimiento |

Lo que **no** existe y hay que construir del lado del server: el envío de push
(ver sección Push).

---

## Arquitectura

### Ubicación y despliegue

La app vive en `app/` dentro de OrbitX-Server y se sirve en `/app` con el mismo Express
que ya corre. **Sin paso de build**: ES modules nativos, sin bundler.

El flujo de actualización que pidió el usuario —"que se actualice en cada cambio"— se
resuelve así:

1. `app/version.json` contiene un hash de versión.
2. El service worker lo consulta al abrir la app y cada vez que vuelve a primer plano.
3. Si cambió, descarga el shell nuevo y muestra un aviso "hay una versión nueva".
4. El usuario toca y la app recarga con la versión nueva.

No hace falta republicar nada en ninguna tienda.

### Stack

- JavaScript vanilla con ES modules — misma convención que el panel de OrbitX y que el
  CRM de Agro Parallel. Sin framework, sin bundler.
- Leaflet (ya autohospedado) para el mapa.
- socket.io-client para el tiempo real.
- IndexedDB mediante un wrapper propio (~60 líneas), sin librería externa.

### Módulos

```
app/
├── index.html              shell de la aplicación
├── sw.js                   service worker: cache del shell + estrategia de datos
├── manifest.webmanifest    nombre, íconos, display standalone, tema
├── version.json            hash de versión para la auto-actualización
├── core/
│   ├── api.js              fetch con JWT, timeout y fallback a cache
│   ├── store.js            IndexedDB: cache de GETs y cola de escrituras
│   ├── sync.js             drena la cola cuando vuelve la conexión
│   ├── auth.js             login, refresh de token, cambiar organización
│   ├── permisos.js         traduce rol de /api/auth/me a pestañas visibles
│   └── socket.js           conexión socket.io, room estab:<slug>
├── ui/
│   ├── nav.js              barra de pestañas + indicador de sin conexión
│   ├── sheet.js            panel inferior arrastrable
│   └── toast.js            avisos efímeros
└── pantallas/
    ├── mapa.js             mapa a pantalla completa con máquinas en vivo
    ├── lotes.js            lista y detalle de lotes
    ├── lluvias.js          historial y carga de lluvias
    ├── alertas.js          alertas activas e historial
    └── equipos.js          estado online/offline de dispositivos
```

Cada módulo de `core/` tiene una sola responsabilidad y se puede probar en aislamiento.
Las pantallas dependen de `core/` y de `ui/`, nunca entre sí.

### Interfaz

Estructura elegida: **mapa protagonista**. El mapa ocupa la pantalla completa y la lista
de máquinas sube desde abajo en un panel arrastrable (`ui/sheet.js`), que se puede
extender para ver la lista completa o bajar para despejar el campo. Debajo, una barra fija
de cinco pestañas: Mapa, Lotes, Lluvias, Alertas, Equipos.

Identidad visual: se reusan los tokens de `public/css/variables.css` — verde primario
`#A4BA3E`, fondo `#1A1F25`, cards `#232830`, tipografía Inter, radio de 8px. La app tiene
que verse parte de OrbitX, no una pieza aparte.

Estado de conexión: cuando los datos vienen del cache, una franja indica
"Sin conexión · datos de hace X".

---

## Datos y funcionamiento sin señal

### Lectura

Todo GET pasa por `core/api.js`:

1. Intenta la red con timeout de 4 segundos.
2. Si responde, guarda la respuesta en IndexedDB con su marca de tiempo y la devuelve.
3. Si falla o expira, devuelve lo último cacheado junto con su antigüedad, para que la
   pantalla pueda mostrar "actualizado hace X".
4. Si no hay nada cacheado, la pantalla muestra su estado vacío correspondiente.

### Escritura

La única escritura de la Fase 1 es `POST /api/lluvias`. Sin señal:

1. El registro se guarda en la cola de `core/store.js` con un id temporal.
2. La pantalla lo muestra en la lista marcado como "pendiente".
3. `core/sync.js` escucha el evento `online` y drena la cola en orden.
4. Al confirmarse, el id temporal se reemplaza por el `_id` real que devuelve el server.

No hay conflictos de edición porque una lluvia es un registro nuevo, no una modificación.
Si el server rechaza un envío, el registro queda en la cola marcado con el error y se
ofrece reintentar o descartar. La cola no reintenta indefinidamente: tras 3 fallos
consecutivos deja de intentar sola y espera acción del usuario.

### Límite conocido: mapa base sin señal

Las imágenes del mapa base (tiles satelitales) **no** se cachean. Guardar un área útil
excede el almacenamiento razonable de un teléfono y suele violar los términos de uso del
proveedor de tiles.

Sin señal, el mapa muestra los lotes, los límites y los recorridos dibujados en vectorial
sobre fondo liso. Para saber dónde está cada máquina respecto de cada lote, alcanza.

---

## Notificaciones push

Se implementa **Web Push con VAPID**, usando la librería `web-push` en el server.

### Cambio necesario en el server

`POST /api/auth/push-token` (routes/auth.js:93) hoy guarda strings sueltos en
`user.notificaciones.push_tokens`. Web Push necesita el objeto `subscription` completo
(`{ endpoint, keys: { p256dh, auth } }`).

Se agrega `POST /api/auth/push-subscribe` al lado, sin modificar ni eliminar el endpoint
existente, para no romper a ningún consumidor actual.

### Disparadores en Fase 1

- **Alerta nueva** generada por OrbitX.
- **Equipo que dejó de reportar durante 15 minutos.**

Sobre ese umbral: OrbitX ya considera un equipo offline cuando su `ultimo_visto` tiene más
de **2 minutos** (`routes/devices.js:254`). Ese criterio se reusa tal cual para el
indicador visual de la pestaña Equipos, pero **no** sirve para el push: cualquier bache de
señal en el campo dispararía una notificación. Por eso el push usa un umbral propio de 15
minutos, y solo notifica una vez por episodio —no repite hasta que el equipo vuelva a
reportar y se caiga de nuevo.

### Límite conocido: iPhone

En iOS el push solo funciona si el usuario instaló la app en la pantalla de inicio
(iOS 16.4 o superior). Desde una pestaña del navegador no llega ninguna notificación.

La app detecta esta situación y, en lugar de fallar en silencio, muestra las instrucciones
para instalarla. Tampoco hay GPS en segundo plano en iOS: la app solo reporta posición
mientras está abierta, algo que en Fase 1 no se usa (las posiciones las reportan los
equipos, no el teléfono).

---

## Permisos

`core/permisos.js` pide `GET /api/auth/me`, obtiene el rol y arma la navegación:

La tabla siguiente se deriva de la matriz `PERMS` real de `roles.js`, cuyos recursos son
`orgs, usuarios, establecimientos, lotes, densidades, alertas, dispositivos, backups_aog,
agraria, audit_log, facturacion, config_server`:

| Rol | `lotes` | `alertas` | `dispositivos` | Pestañas visibles |
|---|---|---|---|---|
| `superadmin`, `owner`, `admin_org` | read/write | read/write | read/write | Mapa, Lotes, Lluvias, Alertas, Equipos |
| `agronomo` | read | read | read | Mapa, Lotes, Lluvias, Alertas, Equipos (solo lectura) |
| `contratista` | read (asignados) | read/write | read (los suyos) | Mapa, Lotes, Lluvias, Alertas, Equipos |
| `operador` | read (lote activo) | read/write | read (el suyo) | Mapa, Lotes, Lluvias, Alertas, Equipos |
| `viewer` | read | read | **ninguno** | Mapa, Lotes, Lluvias (sin cargar), Alertas |

El caso a no pasar por alto es `viewer`, que tiene `dispositivos: []`: **no debe ver la
pestaña Equipos**.

### Las lluvias usan su propio control de permisos

`/api/lluvias` no pasa por `requirePermiso` ni tiene recurso en `PERMS`: lleva su propia
regla en `routes/lluvias.js:10`, `SOLO_LECTURA = ["viewer"]`. Es decir, **todos los roles
pueden cargar lluvias salvo `viewer`**, que solo lee. El comentario del código explica el
criterio: es data del propio campo y la suele cargar el operador o el contratista.

Además, `GET /api/lluvias` devuelve `{ registros, puede_editar }` —no un array pelado— así
que la app **usa ese `puede_editar`** para mostrar u ocultar el botón de carga, en vez de
recalcular la regla por su cuenta. Así, si el server cambia el criterio, la app lo sigue
sin tocar código.

La Fase 1 no modifica esta regla.

El filtrado del frontend es de conveniencia, no de seguridad: el backend ya valida cada
request con `requirePermiso`. La app solo evita mostrar lo que igual sería rechazado.

El selector de organización aparece únicamente si el usuario tiene más de una organización
disponible.

---

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Sin conexión | Franja "Sin conexión · datos de hace X"; la app sigue navegable con cache |
| Token vencido (401) | No hay endpoint de refresh: el JWT dura 30 días (`auth_service.js:80`). Ante un 401, `auth.js` borra la sesión y muestra el login **conservando la cola pendiente** en IndexedDB |
| 403 sin permiso | La pantalla no debería ser alcanzable; si igual ocurre, mensaje claro y vuelta al mapa |
| Cache vacío y sin red | Estado vacío explicando que hace falta conexión la primera vez |
| Falla al enviar de la cola | El registro queda marcado con el error; se ofrece reintentar o descartar |
| Socket caído | Reconexión automática; mientras tanto, refresco por polling cada 30 s |

---

## Tests

Se usa el runner **nativo de Node** (`node:test` con `node --test`), no Jest. OrbitX hoy no
tiene tests ni una sola `devDependency`, y el server corre en un droplet de 1 GB: el runner
nativo evita sumar Jest y su árbol de dependencias por cuatro archivos de test. Node 22.15
ya lo soporta completo.

Se prueba la lógica que no necesita navegador:

- `core/store.js` — encolar, drenar en orden, deduplicar, marcar fallidos.
- `core/permisos.js` — cada rol produce la navegación correcta.
- `core/api.js` — devuelve cache cuando la red falla; respeta el timeout; marca antigüedad.
- `core/sync.js` — reintenta en orden y se detiene tras 3 fallos.

Las pantallas y el service worker se verifican a mano sobre dispositivos reales (ver
Criterios de aceptación).

---

## Criterios de aceptación

1. La app se instala en la pantalla de inicio en un iPhone y en un Android reales, y abre
   en pantalla completa con su ícono.
2. Un cambio desplegado en el server aparece en el teléfono sin reinstalar nada.
3. Con el modo avión activado, la app abre y muestra los últimos datos con su antigüedad.
4. Una lluvia cargada en modo avión se envía sola al restablecer la conexión.
5. El mapa muestra las máquinas moviéndose en vivo vía socket.io.
6. Una alerta nueva llega como notificación push en Android, y en iPhone con la app
   instalada en la pantalla de inicio.
7. Un usuario con rol `viewer` no ve la pestaña Equipos, y un `operador` solo ve su propio
   dispositivo y su lote activo.
8. La pestaña Equipos marca online a los equipos cuyo `ultimo_visto` tiene menos de 2
   minutos, igual que el panel de escritorio.

---

## Fuera de alcance en esta fase

Quedan para fases siguientes, sobre esta misma base:

- **Agronomía**: NDVI e índices satelitales, prescripciones, lotes-maestro, chat agraria.
- **Fierros**: firmwares y OTA, VistaX, sincronización con AOG/PilotX.
- **Video**: cámaras WebRTC (requiere tratamiento propio por el consumo y por el
  comportamiento de WebRTC en PWA sobre iOS).
- **Soporte**: soporte-chat.
- **Gestión**: usuarios, roles, grupos, equipo, establecimientos, vehículos,
  integraciones, config, registros, couchdb. Esta categoría probablemente nunca tenga
  sentido en un teléfono y puede quedar solo en el panel de escritorio.

---

## Riesgos

| Riesgo | Mitigación |
|---|---|
| iOS limita el push a apps instaladas | La app detecta y guía la instalación en lugar de fallar callada |
| iOS purga datos de sitios sin uso | Las PWA instaladas en pantalla de inicio están exentas; se documenta en el instructivo |
| Sin mapa base offline | Se muestran lotes y recorridos vectoriales; se comunica la limitación al usuario |
| Sin bundler, muchos módulos = muchos requests | Se sirven con HTTP/2 y se cachean en el service worker tras la primera carga |
| El repo tiene 30 archivos modificados sin commitear | El trabajo de la app va en `app/`, carpeta nueva, sin tocar lo existente salvo el endpoint de push |
