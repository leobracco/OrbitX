// selector.js — Lista de opciones en un panel inferior (reemplaza al prompt()
// nativo). Devuelve una promesa con la opción elegida o null si se cancela.
// opciones: [{ valor, etiqueta, actual?: boolean }]
import { esc } from "./html.js";

export function elegirDeLista({ titulo, opciones }) {
  return new Promise((resolve) => {
    const capa = document.createElement("div");
    capa.className = "selector-capa";
    capa.innerHTML = `
      <div class="sheet selector" role="dialog" aria-label="${esc(titulo)}">
        <div class="handle"></div>
        <div class="titulo-seccion">${esc(titulo)}</div>
        <div class="cuerpo"><ul class="lista">${opciones.map((o, i) => `
          <li><button class="fila" data-i="${i}">
            <span class="dot ${o.actual ? "ok" : ""}"></span>
            <span class="txt"><b>${esc(o.etiqueta)}</b>${o.actual ? "<span>establecimiento actual</span>" : ""}</span>
            <span class="val">${o.actual ? "✓" : "›"}</span>
          </button></li>`).join("")}</ul></div>
        <div class="campo"><button class="btn secundario" data-cancelar style="width:100%">Cancelar</button></div>
      </div>`;
    function cerrar(valor) { capa.remove(); resolve(valor); }
    capa.addEventListener("click", (ev) => {
      if (ev.target === capa || ev.target.closest("[data-cancelar]")) return cerrar(null);
      const b = ev.target.closest("button[data-i]");
      if (b) cerrar(opciones[Number(b.dataset.i)] ?? null);
    });
    document.body.appendChild(capa);
  });
}
