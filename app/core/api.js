// api.js — Único punto de acceso HTTP de la app. GET: intenta red con
// timeout; si responde, cachea y devuelve; si falla o expira, devuelve el
// cache con su antigüedad. POST/DELETE: red directa, sin cache (la cola
// offline vive en sync.js, no acá). 401 → onNoAuth (sesión vencida).

export class ErrorSinDatos extends Error {
  constructor(ruta) { super(`Sin conexión y sin datos guardados para ${ruta}`); this.name = "ErrorSinDatos"; }
}
export class ErrorHttp extends Error {
  constructor(status, body, ruta) {
    super(body?.error || `HTTP ${status} en ${ruta}`);
    this.name = "ErrorHttp"; this.status = status; this.body = body;
  }
}

export function crearApi({ fetchFn = globalThis.fetch, store, getToken, onNoAuth = () => {}, timeoutMs = 4000, base = "" }) {
  async function pedir(metodo, ruta, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { Accept: "application/json" };
      const tok = getToken();
      if (tok) headers.Authorization = `Bearer ${tok}`;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchFn(base + ruta, {
        method: metodo, headers, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (res.status === 401) { onNoAuth(); throw new ErrorHttp(401, data, ruta); }
      if (!res.ok) throw new ErrorHttp(res.status, data, ruta);
      return data;
    } finally { clearTimeout(timer); }
  }

  return {
    async get(ruta) {
      const clave = `GET ${ruta}`;
      try {
        const data = await pedir("GET", ruta);
        await store.cacheSet(clave, data);
        return { data, desdeCache: false, ts: Date.now() };
      } catch (e) {
        if (e instanceof ErrorHttp) throw e; // el server respondió: no es un problema de red
        const c = await store.cacheGet(clave);
        if (!c) throw new ErrorSinDatos(ruta);
        return { data: c.data, desdeCache: true, ts: c.ts };
      }
    },
    post(ruta, body) { return pedir("POST", ruta, body ?? {}); },
    del(ruta)        { return pedir("DELETE", ruta); },
  };
}
