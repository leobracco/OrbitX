# Agenda de RustDesk servida por OrbitX

**Fecha:** 2026-10-06 · **Estado:** aprobado (usuario OrbitX + etiqueta por establecimiento)

## Problema

Para dar soporte remoto hay que buscar a mano el ID de RustDesk de cada PilotX (panel
Dispositivos, CRM o consulta a CouchDB). OrbitX ya tiene ese dato: cada PilotX lo reporta
en el heartbeat (`device_<id>.rustdesk_id`). El servidor RustDesk propio
(`asistx.agroparallel.com`, hbbs/hbbr OSS) no trae API de cuentas ni agenda.

## Solución

OrbitX hace de **API server** de RustDesk en `https://orbitx.agroparallel.com/rustdesk`.
En cada PC de soporte se carga una vez en RustDesk → Ajustes → Red → *API Server*, se
inicia sesión con el usuario de OrbitX y la agenda aparece con todos los equipos.

### Protocolo (verificado contra `rustdesk/rustdesk@master`, `ab_model.dart` / `user_model.dart`)

Se implementa la API **legacy**, la mínima que el cliente oficial acepta:

| Endpoint | Respuesta |
|---|---|
| `POST /api/login` `{username,password,…}` | `{type:"access_token", access_token, user:{name,display_name,email,note,status:1,is_admin}}` |
| `POST /api/currentUser` (Bearer) | `user` · 401 si el token no vale (el cliente cierra sesión) |
| `POST /api/logout` | `{}` |
| `GET /api/login-options` | `[]` (sin OIDC) |
| `POST /api/ab/personal` | **404** → el cliente pasa a modo legacy |
| `GET /api/ab` (Bearer) | `{data:"<JSON string {tags,peers,tag_colors}>"}` |
| `POST /api/ab` | `{error}`: la agenda es de solo lectura, la fuente de verdad es OrbitX |
| `POST /api/heartbeat`, `/api/sysinfo`, `/api/sysinfo_ver` | `{}` (el cliente los manda por tener API server propio) |

Errores siempre como `{error:"…"}`.

### Contenido de la agenda

- Un peer por `tipo:"device"` con `rustdesk_id`: `id`=rustdesk_id, `alias`=nombre del
  equipo en OrbitX, `hostname`, `platform:"Windows"`, `tags:[nombre del establecimiento]`
  (o `Sin asignar`).
- `tags`: un tag por establecimiento visible; `tag_colors` con color estable por nombre.
- El estado online/offline lo resuelve el cliente contra nuestro hbbs, no OrbitX.

### Quién entra y qué ve

- Login con email + contraseña de OrbitX (mismo `auth_service.login`, mismo rate limit
  que `/api/auth/login`). El token es el JWT normal de OrbitX (revocable con
  `token_version`).
- **superadmin** ve todos los equipos.
- **owner / admin_org** ven solo los equipos de sus establecimientos.
- El resto de los roles no puede iniciar sesión en la agenda (403).

## Fuera de alcance

API nueva de agendas compartidas, edición desde RustDesk, OIDC, auditoría de conexiones.

## Riesgo

El protocolo no está documentado y cambia entre versiones del cliente: probar con la
versión instalada en las PCs de soporte antes de darlo por bueno.
