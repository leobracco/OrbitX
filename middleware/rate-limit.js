// middleware/rate-limit.js — OrbitX · limiter in-memory, sin dependencias.
// O14 — Sin esto, /login y /reset-password permiten fuerza bruta de
// contraseñas/tokens sin freno. Corremos en instances:1 (ver ecosystem.json
// O10), así que un Map en proceso alcanza. Si algún día se pasa a cluster,
// migrar a un store compartido (redis).
"use strict";

// Ventana fija por clave. buckets: clave → { count, reset }.
function rateLimit({ windowMs = 60_000, max = 10, keyGenerator } = {}) {
  const buckets = new Map();

  // Limpieza periódica para no acumular claves vencidas sin techo.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }, windowMs);
  sweep.unref?.();

  const defaultKey = (req) =>
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  return (req, res, next) => {
    const key = (keyGenerator ? keyGenerator(req) : defaultKey(req)) || "unknown";
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.reset - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "Demasiados intentos, probá de nuevo en un rato", retry_after: retryAfter });
    }
    next();
  };
}

module.exports = { rateLimit };
