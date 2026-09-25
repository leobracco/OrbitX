// toast.js — Aviso efímero abajo de la pantalla.
export function toast(msg, tipo = "info", ms = 2800) {
  const cont = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.textContent = msg;
  cont.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
