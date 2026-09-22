// nav.js — Barra de pestañas (según permisos), franja de estado offline y
// badge de alertas.
import { haceCuanto } from "../core/fecha.js";

const ICONOS = { mapa: "🗺️", lotes: "🌾", lluvias: "🌧️", alertas: "🔔", equipos: "📡" };
const ROTULOS = { mapa: "Mapa", lotes: "Lotes", lluvias: "Lluvias", alertas: "Alertas", equipos: "Equipos" };

export function crearNav({ pestanas, onIr }) {
  const nav = document.getElementById("nav");
  const franja = document.getElementById("franja");
  nav.innerHTML = "";
  const btns = {};
  for (const p of pestanas) {
    const b = document.createElement("button");
    b.innerHTML = `<i>${ICONOS[p]}</i>${ROTULOS[p]}`;
    b.addEventListener("click", () => onIr(p));
    nav.appendChild(b); btns[p] = b;
  }
  nav.hidden = false;
  return {
    pestanaActiva(nombre) { for (const [k, b] of Object.entries(btns)) b.classList.toggle("on", k === nombre); },
    setOffline(esta, ts) {
      franja.hidden = !esta;
      franja.className = "franja";
      if (esta) franja.textContent = ts ? `Sin conexión · datos de ${haceCuanto(ts)}` : "Sin conexión";
    },
    setAviso(texto, tipo = "") { franja.hidden = !texto; franja.className = `franja ${tipo}`; if (texto) franja.textContent = texto; },
    setBadge(pestana, n) {
      const b = btns[pestana]; if (!b) return;
      b.querySelector(".badge")?.remove();
      if (n > 0) { const s = document.createElement("span"); s.className = "badge"; s.textContent = n > 99 ? "99+" : n; b.appendChild(s); }
    },
  };
}
