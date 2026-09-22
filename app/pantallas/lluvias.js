export async function montar(ctx, root) {
  root.innerHTML = `<div class="vacio">Pantalla <b>lluvias</b> — en construcción</div>`;
  return { desmontar() {} };
}
