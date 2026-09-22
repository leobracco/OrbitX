// permisos.js — Traduce el rol efectivo (de /api/auth/me) a las pestañas
// visibles. Es filtrado de conveniencia: el server ya valida cada request con
// requirePermiso. Se deriva de PERMISOS en roles.js/middleware/auth.js:
// 'equipos' solo si el rol tiene lectura en 'dispositivos' (solo viewer no la
// tiene; member sí: dispositivos: ["r"]).

export const PESTANAS = ["mapa", "lotes", "lluvias", "alertas", "equipos"];

const SIN_EQUIPOS = ["mapa", "lotes", "lluvias", "alertas"];
const CON_DISPOSITIVOS = new Set(["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador", "member"]);

export function pestanasPara(rol) {
  return CON_DISPOSITIVOS.has(rol) ? [...PESTANAS] : [...SIN_EQUIPOS];
}

export function puedeVer(rol, pestana) {
  return pestanasPara(rol).includes(pestana);
}
