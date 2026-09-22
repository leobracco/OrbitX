// sheet.js — Panel inferior arrastrable (mapa protagonista). Tres alturas:
// min (solo el resumen), medio (lista), max (casi todo). Se arrastra desde
// el handle o el encabezado; un toque en el handle alterna min/medio.
const ALTURAS = { min: 0.22, medio: 0.48, max: 0.85 };

export function crearSheet(el) {
  let nivel = "medio";
  let y0 = null, h0 = 0;
  const cont = el.parentElement;

  function aplicar() {
    const h = Math.round(cont.clientHeight * ALTURAS[nivel]);
    el.style.height = h + "px";
    el.style.transform = "";
  }
  function setAltura(n) { nivel = n; aplicar(); }

  const handle = el.querySelector(".handle");
  handle.addEventListener("click", () => setAltura(nivel === "min" ? "medio" : "min"));
  const inicio = (e) => { y0 = (e.touches?.[0] ?? e).clientY; h0 = el.clientHeight; el.style.transition = "none"; };
  const mover = (e) => {
    if (y0 === null) return;
    const y = (e.touches?.[0] ?? e).clientY;
    const h = Math.max(60, Math.min(cont.clientHeight * ALTURAS.max, h0 + (y0 - y)));
    el.style.height = h + "px";
  };
  const fin = () => {
    if (y0 === null) return;
    el.style.transition = "";
    const frac = el.clientHeight / cont.clientHeight;
    nivel = frac < 0.33 ? "min" : frac < 0.65 ? "medio" : "max";
    y0 = null; aplicar();
  };
  handle.addEventListener("touchstart", inicio, { passive: true });
  el.addEventListener("touchmove", mover, { passive: true });
  el.addEventListener("touchend", fin);
  window.addEventListener("resize", aplicar);
  aplicar();
  return { setAltura, abrir: () => setAltura("medio"), cerrar: () => setAltura("min") };
}
