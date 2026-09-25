// html.js — Escape para interpolar valores de la base en innerHTML. Todo lo
// que venga de CouchDB (nombres de lotes, hostnames de PCs, notas) pasa por
// acá antes de entrar a una plantilla de string.
const MAPA = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => MAPA[c]);
}
