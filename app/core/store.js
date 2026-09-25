// store.js — Persistencia local: cache de respuestas GET y cola de escrituras
// pendientes. El backend es inyectable: en el navegador es IndexedDB, en los
// tests un Map en memoria. Las claves de cache son "GET <ruta>"; las de cola
// "cola:<id>".

export function memBackend() {
  const m = new Map();
  return {
    async get(k)  { return m.has(k) ? m.get(k) : undefined; },
    async set(k, v) { m.set(k, v); },
    async del(k)  { m.delete(k); },
    async keys(prefijo) { return [...m.keys()].filter(k => k.startsWith(prefijo)); },
  };
}

export function idbBackend(nombre = "orbitx-app") {
  const STORE = "kv";
  let dbp = null;
  function abrir() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(nombre, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
    return dbp;
  }
  function tx(modo, fn) {
    return abrir().then(db => new Promise((res, rej) => {
      const t = db.transaction(STORE, modo);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => res(r.result);
      t.onerror    = () => rej(t.error);
    }));
  }
  return {
    get(k)    { return tx("readonly",  s => s.get(k)); },
    set(k, v) { return tx("readwrite", s => s.put(v, k)); },
    del(k)    { return tx("readwrite", s => s.delete(k)); },
    async keys(prefijo) {
      const todas = await tx("readonly", s => s.getAllKeys());
      return todas.filter(k => typeof k === "string" && k.startsWith(prefijo));
    },
  };
}

export function crearStore(backend) {
  const PRE_COLA = "cola:";
  return {
    async cacheGet(clave) {
      const v = await backend.get("cache:" + clave);
      return v ?? null;
    },
    async cacheSet(clave, data) {
      await backend.set("cache:" + clave, { data, ts: Date.now() });
    },
    async colaAgregar({ metodo, ruta, body }) {
      const ts = Date.now();
      const item = {
        id: `tmp_${ts}_${Math.random().toString(36).slice(2, 8)}`,
        metodo, ruta, body, ts, intentos: 0, estado: "pendiente", error: null,
      };
      await backend.set(PRE_COLA + item.id, item);
      return item;
    },
    async colaListar() {
      const ks = await backend.keys(PRE_COLA);
      const items = await Promise.all(ks.map(k => backend.get(k)));
      return items.filter(Boolean).sort((a, b) => a.ts - b.ts);
    },
    async colaActualizar(id, patch) {
      const actual = await backend.get(PRE_COLA + id);
      if (!actual) throw new Error(`Item de cola no encontrado: ${id}`);
      const nuevo = { ...actual, ...patch };
      await backend.set(PRE_COLA + id, nuevo);
      return nuevo;
    },
    async colaQuitar(id) { await backend.del(PRE_COLA + id); },
  };
}
