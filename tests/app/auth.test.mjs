import { test } from "node:test";
import assert from "node:assert/strict";
import { crearAuth } from "../../app/core/auth.js";

function memStorage() {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("login guarda token y usuario", async () => {
  const st = memStorage();
  const auth = crearAuth({ storage: st, fetchFn: async (u, o) => {
    if (u.endsWith("/api/auth/login")) { assert.equal(JSON.parse(o.body).email, "a@b.c"); return json({ token: "T1", user: { uid: "usr_1", nombre: "Ana" } }); }
    if (u.endsWith("/api/auth/me"))    return json({ _id: "usr_1", nombre: "Ana", rol_efectivo: "owner", org_activa: "campo1", memberships: [] });
    throw new Error("ruta inesperada " + u);
  }});
  const u = await auth.login("a@b.c", "x");
  assert.equal(auth.token(), "T1");
  assert.equal(u.rol_efectivo, "owner");
  assert.equal(auth.usuario().org_activa, "campo1");
});

test("login con credenciales malas lanza con el mensaje del server", async () => {
  const auth = crearAuth({ storage: memStorage(), fetchFn: async () => json({ error: "Credenciales inválidas" }, 401) });
  await assert.rejects(() => auth.login("a", "b"), /Credenciales inválidas/);
  assert.equal(auth.token(), null);
});

test("cambiarOrg reemplaza el token y recarga me", async () => {
  const st = memStorage(); st.setItem("orbitx.token", "T1");
  let meLlamado = 0;
  const auth = crearAuth({ storage: st, fetchFn: async (u, o) => {
    if (u.endsWith("/cambiar-org")) { assert.equal(o.headers.Authorization, "Bearer T1"); assert.equal(JSON.parse(o.body).orgSlug, "campo2"); return json({ token: "T2", orgSlug: "campo2" }); }
    if (u.endsWith("/me")) { meLlamado++; return json({ rol_efectivo: "viewer", org_activa: "campo2", memberships: [] }); }
  }});
  await auth.cambiarOrg("campo2");
  assert.equal(auth.token(), "T2");
  assert.equal(meLlamado, 1);
  assert.equal(auth.usuario().org_activa, "campo2");
});

test("logout limpia token y usuario", async () => {
  const st = memStorage(); st.setItem("orbitx.token", "T"); st.setItem("orbitx.usuario", "{}");
  const auth = crearAuth({ storage: st, fetchFn: async () => json({}) });
  auth.logout();
  assert.equal(auth.token(), null);
  assert.equal(auth.usuario(), null);
});

test("usuario() devuelve null si el storage tiene JSON corrupto", () => {
  const st = memStorage(); st.setItem("orbitx.usuario", "{esto no es json");
  const auth = crearAuth({ storage: st, fetchFn: async () => json({}) });
  assert.equal(auth.usuario(), null);
});

test("si me() falla después del login, no queda sesión a medias", async () => {
  const st = memStorage();
  const auth = crearAuth({ storage: st, fetchFn: async (u) => {
    if (u.endsWith("/login")) return json({ token: "T1", user: {} });
    if (u.endsWith("/me"))    return json({ error: "Servidor caído" }, 503);
  }});
  await assert.rejects(() => auth.login("a@b.c", "x"), /Servidor caído/);
  assert.equal(auth.token(), null);
  assert.equal(auth.usuario(), null);
});

test("login va sin Authorization y el me() posterior va con el Bearer nuevo", async () => {
  const headersVistos = {};
  const auth = crearAuth({ storage: memStorage(), fetchFn: async (u, o) => {
    if (u.endsWith("/login")) { headersVistos.login = o.headers; return json({ token: "T9", user: {} }); }
    if (u.endsWith("/me"))    { headersVistos.me = o.headers; return json({ rol_efectivo: "owner", org_activa: "c", memberships: [] }); }
  }});
  await auth.login("a@b.c", "x");
  assert.equal(headersVistos.login.Authorization, undefined);
  assert.equal(headersVistos.me.Authorization, "Bearer T9");
});

test("si me() falla al cambiar de org, se restaura el token anterior y el usuario no cambia", async () => {
  const st = memStorage();
  st.setItem("orbitx.token", "T1");
  st.setItem("orbitx.usuario", JSON.stringify({ org_activa: "campo1" }));
  const auth = crearAuth({ storage: st, fetchFn: async (u) => {
    if (u.endsWith("/cambiar-org")) return json({ token: "T2", orgSlug: "campo2" });
    if (u.endsWith("/me"))          return json({ error: "Servidor caído" }, 503);
  }});
  await assert.rejects(() => auth.cambiarOrg("campo2"), /Servidor caído/);
  assert.equal(auth.token(), "T1");
  assert.equal(auth.usuario().org_activa, "campo1");
});

test("login que no responde corta por timeout", async () => {
  const cuelga = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new DOMException("abort", "AbortError"))));
  const auth = crearAuth({ storage: memStorage(), fetchFn: cuelga, timeoutMs: 30 });
  await assert.rejects(() => auth.login("a@b.c", "x"), /Sin respuesta/);
  assert.equal(auth.token(), null);
});
