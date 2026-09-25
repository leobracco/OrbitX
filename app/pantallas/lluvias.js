// lluvias.js — Historial de lluvias y carga de un registro nuevo. Si no hay
// señal (o el POST falla por red), el registro va a la cola y se muestra
// como "pendiente"; sync.js lo manda al volver la conexión. El botón de
// carga se muestra según `puede_editar` que devuelve el server.
import { fechaISOHoy } from "../core/fecha.js";
import { ErrorHttp } from "../core/api.js";
import { esc } from "../ui/html.js";

export async function montar(ctx, root) {
  root.classList.add("scroll");
  let lotes = [];

  async function pendientes() { return (await ctx.store.colaListar()).filter(i => i.ruta === "/api/lluvias"); }

  async function cargar() {
    let r;
    try { r = await ctx.api.get("/api/lluvias"); } catch (e) { r = { data: { registros: [], puede_editar: false }, desdeCache: true, ts: null }; ctx.toast(e.message, "error"); }
    try { lotes = (await ctx.api.get("/api/lotes")).data; } catch { /* sin lotes no pasa nada */ }
    ctx.nav.setOffline(r.desdeCache, r.ts);
    const pend = await pendientes();
    const regs = [...(r.data.registros || [])].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    root.innerHTML = `
      ${pend.length ? `<div class="titulo-seccion">Pendientes de enviar · ${pend.length}</div><ul class="lista">${pend.map(p => {
        const yaEnviado = /^Enviado/.test(p.error || "");
        return `<li class="fila"><span class="dot ${p.estado === "error" ? (yaEnviado ? "info" : "err") : "warn"}"></span>
          <span class="txt"><b>${esc(p.body.mm)} mm</b><span>${esc(p.body.fecha)}${p.body.lote ? " · " + esc(p.body.lote) : ""}${p.estado === "error" ? " · " + esc(p.error || "error") : " · esperando conexión"}</span></span>
          ${p.estado === "error" && !yaEnviado ? `<button class="btn secundario" data-reintentar="${esc(p.id)}" style="padding:6px 10px;font-size:12px">Reintentar</button>` : ""}
        </li>`;
      }).join("")}</ul>` : ""}
      <div class="titulo-seccion">Registradas</div>
      <ul class="lista">${regs.length ? regs.map(x => `<li class="fila"><span class="dot info"></span><span class="txt"><b>${esc(x.mm)} mm</b><span>${esc(x.fecha)}${x.lote ? " · " + esc(x.lote) : ""}${x.nota ? " · " + esc(x.nota) : ""}</span></span></li>`).join("") : `<li class="vacio">Sin lluvias registradas.</li>`}</ul>
      ${r.data.puede_editar ? `<button class="fab" id="fab" title="Cargar lluvia">+</button>` : ""}`;
    root.querySelectorAll("[data-reintentar]").forEach(b => b.addEventListener("click", async () => { await ctx.sync.reintentar(b.dataset.reintentar); cargar(); }));
    root.querySelector("#fab")?.addEventListener("click", formulario);
  }

  function formulario() {
    const ops = lotes.map(l => `<option value="${esc(l.nombre)}">${esc(l.nombre)}</option>`).join("");
    root.insertAdjacentHTML("beforeend", `
      <div class="sheet" id="form-lluvia" style="height:auto;max-height:90%"><div class="handle"></div><div class="cuerpo">
        <form id="f">
          <div class="campo"><label>Fecha</label><input name="fecha" type="date" value="${fechaISOHoy()}" required></div>
          <div class="campo"><label>Milímetros</label><input name="mm" type="number" inputmode="decimal" step="0.1" min="0" max="1000" placeholder="0" required></div>
          <div class="campo"><label>Lote (opcional)</label><select name="lote"><option value="">Todo el establecimiento</option>${ops}</select></div>
          <div class="campo"><label>Nota (opcional)</label><input name="nota" maxlength="200"></div>
          <div class="campo" style="display:flex;gap:8px"><button type="button" class="btn secundario" id="cancelar" style="flex:1">Cancelar</button><button type="submit" class="btn" style="flex:2">Guardar</button></div>
        </form></div></div>`);
    const sheet = root.querySelector("#form-lluvia");
    sheet.querySelector("#cancelar").addEventListener("click", () => sheet.remove());
    sheet.querySelector("#f").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const f = new FormData(ev.target);
        const body = { fecha: f.get("fecha"), mm: Number(f.get("mm")), lote: f.get("lote") || undefined, nota: f.get("nota") || undefined };
        try {
          await ctx.api.post("/api/lluvias", body);
          ctx.toast("Lluvia registrada", "ok");
        } catch (e) {
          if (e instanceof ErrorHttp) { ctx.toast(e.message, "error"); return; } // el server la rechazó: no encolar
          await ctx.store.colaAgregar({ metodo: "POST", ruta: "/api/lluvias", body });
          ctx.toast("Sin conexión: quedó pendiente y se envía sola", "ok");
        }
        sheet.remove(); cargar();
      } finally {
        btn.disabled = false;
      }
    });
  }

  await cargar();
  const alEnviar = () => cargar();
  window.addEventListener("online", alEnviar);
  return { desmontar() { window.removeEventListener("online", alEnviar); } };
}
