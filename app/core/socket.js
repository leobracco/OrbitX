// socket.js — Conexión socket.io autenticada con el JWT. El server une
// automáticamente al room estab:<slug> del token; no hay que pedir nada.
export function conectarSocket({ token, onPosicion, onEstado = () => {} }) {
  if (!globalThis.io) { console.warn("[socket] socket.io-client no cargó"); return null; }
  const s = globalThis.io("/", { auth: { token }, transports: ["websocket", "polling"], reconnectionDelayMax: 10000 });
  s.on("connect",    () => onEstado("conectado"));
  s.on("disconnect", () => onEstado("desconectado"));
  s.on("connect_error", (e) => { console.warn("[socket]", e.message); onEstado("error"); });
  s.on("tracking:position", (p) => onPosicion(p));
  return s;
}
