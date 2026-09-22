// sync.js — Drena la cola de escrituras pendientes cuando hay conexión.
// Reglas: se envía en orden de llegada; un fallo de red suma un intento y
// corta la pasada (el siguiente item casi seguro fallaría igual); al tercer
// fallo el item queda en "error" y espera acción del usuario; un rechazo
// del server (4xx/5xx) pasa a "error" de inmediato porque reintentar no lo
// arregla. Los items en "error" se reintentan solo a pedido (reintentar()).
import { ErrorHttp } from "./api.js";

const MAX_INTENTOS = 3;

export function crearSync({ store, api, onEvento = () => {} }) {
  let corriendo = false;

  async function drenar() {
    if (corriendo) return { enviados: 0, fallidos: 0, detenido: false };
    corriendo = true;
    const r = { enviados: 0, fallidos: 0, detenido: false };
    try {
      const cola = (await store.colaListar()).filter(i => i.estado === "pendiente");
      for (const item of cola) {
        try {
          const respuesta = await api.post(item.ruta, item.body);
          await store.colaQuitar(item.id);
          r.enviados++;
          onEvento({ tipo: "enviado", item, respuesta });
        } catch (e) {
          r.fallidos++;
          const intentos = item.intentos + 1;
          const rechazo = e instanceof ErrorHttp;
          const agotado = intentos >= MAX_INTENTOS;
          const patch = rechazo || agotado
            ? { intentos, estado: "error", error: e.body?.error || e.message }
            : { intentos, error: e.message };
          const actualizado = await store.colaActualizar(item.id, patch);
          onEvento({ tipo: "fallo", item: actualizado, error: e });
          r.detenido = true;
          onEvento({ tipo: "detenido", item: actualizado });
          break;
        }
      }
    } finally { corriendo = false; }
    return r;
  }

  async function reintentar(id) {
    await store.colaActualizar(id, { estado: "pendiente", intentos: 0, error: null });
    return drenar();
  }

  function escuchar(win = globalThis) {
    win.addEventListener?.("online", () => { drenar(); });
  }

  return { drenar, reintentar, escuchar };
}
