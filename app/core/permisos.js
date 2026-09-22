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
