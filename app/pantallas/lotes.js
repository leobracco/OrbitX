export async function montar(ctx, root) {
  root.innerHTML = `<div class="vacio">Pantalla <b>lotes</b> — en construcción</div>`;
  return { desmontar() {} };
}
