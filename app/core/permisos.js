// permisos.js — Traduce el rol efectivo (de /api/auth/me) a las pestañas
// visibles. Es filtrado de conveniencia: el server ya valida cada request con
// requirePermiso. Se deriva de PERMISOS en roles.js/middleware/auth.js:
// 'equipos' solo si el rol tiene lectura en 'dispositivos' (solo viewer no la
// tiene; member sí: dispositivos: ["r"]).

export const PESTANAS = ["inicio", "mapa", "lotes", "siembra", "lluvias", "alertas", "equipos"];

// Siembra (VistaX) entra acá también: todos los roles tienen densidades:["read"].
const SIN_EQUIPOS = ["inicio", "mapa", "lotes", "siembra", "lluvias", "alertas"];
const CON_DISPOSITIVOS = new Set(["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador", "member"]);

export function pestanasPara(rol) {
  return CON_DISPOSITIVOS.has(rol) ? [...PESTANAS] : [...SIN_EQUIPOS];
}

// Pantallas que el router acepta aunque no tengan pestaña propia. El chat con
// PilotX se abre desde el ícono de la barra de arriba y desde un equipo, no
// desde la barra de abajo: son siete pestañas y en un celular no entra otra.
// Necesita lectura de dispositivos, igual que Equipos: se chatea con la
// pantalla de un tractor.
const SUELTAS = ["chat"];

export function pantallasPara(rol) {
  const base = pestanasPara(rol);
  return CON_DISPOSITIVOS.has(rol) ? [...base, ...SUELTAS] : base;
}

export function puedeVer(rol, pestana) {
  return pestanasPara(rol).includes(pestana);
}
