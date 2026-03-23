// public/js/auth.js
// ════════════════════════════════════════════════
//  OrbitX Auth Guard — incluir en index.html (dashboard)
//  Redirige a /login si no hay token válido
// ════════════════════════════════════════════════

const Auth = (() => {

  const TOKEN_KEY = "orbitx_token";
  const USER_KEY  = "orbitx_user";

  // ── Leer token ──────────────────────────────────
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  // ── Leer usuario cacheado ────────────────────────
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch { return null; }
  }

  // ── Decodificar JWT (sin verificar firma — solo lectura) ─
  function decodeToken(token) {
    try {
      const [, payload] = token.split(".");
      const padded = payload + "==".slice((payload.length % 4) || 4);
      return JSON.parse(atob(padded));
    } catch { return null; }
  }

  // ── Verificar si el token es válido y no expiró ──
  function isValid() {
    const token = getToken();
    if (!token) return false;
    const decoded = decodeToken(token);
    if (!decoded) return false;
    // Expirado
    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      logout(false);
      return false;
    }
    return true;
  }

  // ── Guard: llamar al inicio del dashboard ────────
  function guard() {
    if (!isValid()) {
      window.location.replace("/login");
      return false;
    }
    return true;
  }

  // ── Logout ───────────────────────────────────────
  function logout(redirect = true) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    if (redirect) window.location.replace("/login");
  }

  // ── Fetch autenticado ────────────────────────────
  // Wrapper sobre fetch que inyecta el Bearer token
  // y maneja 401 automáticamente
  async function apiFetch(url, opts = {}) {
    const token = getToken();
    const headers = {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
      ...(token ? { "Authorization": `Bearer ${token}` } : {})
    };

    const res = await fetch(url, { ...opts, headers });

    if (res.status === 401) {
      logout();
      throw new Error("Sesión expirada");
    }

    return res;
  }

  // ── GET helper ───────────────────────────────────
  async function get(url) {
    const res = await apiFetch(url);
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    return res.json();
  }

  // ── POST helper ──────────────────────────────────
  async function post(url, body) {
    const res = await apiFetch(url, {
      method: "POST",
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    return res.json();
  }

  // ── PATCH helper ─────────────────────────────────
  async function patch(url, body) {
    const res = await apiFetch(url, {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    return res.json();
  }

  // ── DELETE helper ────────────────────────────────
  async function del(url) {
    const res = await apiFetch(url, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    return res.json();
  }

  // ── Actualizar datos del usuario desde el servidor ─
  async function refreshUser() {
    try {
      const user = await get("/api/auth/me");
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      return user;
    } catch { return getUser(); }
  }

  // ── Cambiar org activa ───────────────────────────
  async function cambiarOrg(orgSlug) {
    const data = await post("/api/auth/cambiar-org", { orgSlug });
    localStorage.setItem(TOKEN_KEY, data.token);
    // Decodificar el nuevo token para actualizar user cache
    const decoded = decodeToken(data.token);
    const user    = getUser();
    if (user && decoded) {
      user.org_activa = orgSlug;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    }
    return data;
  }

  return {
    guard, getToken, getUser, decodeToken,
    isValid, logout, refreshUser, cambiarOrg,
    fetch: apiFetch, get, post, patch, del
  };
})();

// Auto-guard: si este script está en el dashboard, proteger inmediatamente
if (document.currentScript?.dataset?.guard === "true") {
  Auth.guard();
}
