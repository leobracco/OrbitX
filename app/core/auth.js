// auth.js — Sesión de la app. El JWT dura 30 días y no hay refresh: ante un
// 401 se borra la sesión y se vuelve al login (la cola offline se conserva
// en IndexedDB, no acá). Cambiar de organización reemite el token.
const K_TOKEN = "orbitx.token";
const K_USER  = "orbitx.usuario";

export function crearAuth({ storage = globalThis.localStorage, fetchFn = globalThis.fetch, base = "" }) {
  async function llamar(ruta, body, conToken = true) {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const t = token();
    if (conToken && t) headers.Authorization = `Bearer ${t}`;
    const res = await fetchFn(base + ruta, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  function token() { return storage.getItem(K_TOKEN); }
  function usuario() {
    const raw = storage.getItem(K_USER);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { storage.removeItem(K_USER); return null; }
  }
  async function me() {
    const u = await llamar("/api/auth/me");
    storage.setItem(K_USER, JSON.stringify(u));
    return u;
  }
  async function login(email, password) {
    const r = await llamar("/api/auth/login", { email, password }, false);
    storage.setItem(K_TOKEN, r.token);
    try { return await me(); }
    catch (e) { logout(); throw e; }
  }
  async function cambiarOrg(orgSlug) {
    const r = await llamar("/api/auth/cambiar-org", { orgSlug });
    storage.setItem(K_TOKEN, r.token);
    await me();
  }
  function logout() { storage.removeItem(K_TOKEN); storage.removeItem(K_USER); }
  return { token, usuario, login, me, cambiarOrg, logout };
}
