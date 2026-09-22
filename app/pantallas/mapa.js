export async function montar(ctx, root) {
  root.innerHTML = `<div class="vacio">Pantalla <b>mapa</b> — en construcción</div>`;
  return { desmontar() {} };
}
