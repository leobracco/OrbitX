"use strict";
// Validación de los datos editables de una org (nombre, CUIT).

function normalizarCuit(v) {
  const s = String(v ?? "").replace(/[\s-]/g, "");
  if (!s) return "";
  if (!/^\d{11}$/.test(s)) throw { status: 400, message: "CUIT inválido: tienen que ser 11 dígitos" };
  return s;
}

function validarCambiosOrg(body) {
  const cambios = {};
  if (body && body.nombre !== undefined) {
    const nombre = String(body.nombre).trim();
    if (!nombre) throw { status: 400, message: "El nombre no puede quedar vacío" };
    // U+FFFD = un acento que llegó roto (encoding de la consola). Mejor frenar.
    if (nombre.includes("�")) throw { status: 400, message: "El nombre tiene un carácter roto (�): revisá los acentos" };
    cambios.nombre = nombre.slice(0, 160);
  }
  if (body && body.cuit !== undefined) cambios.cuit = normalizarCuit(body.cuit);
  if (!Object.keys(cambios).length) throw { status: 400, message: "No hay nada para cambiar" };
  return cambios;
}

module.exports = { normalizarCuit, validarCambiosOrg };
