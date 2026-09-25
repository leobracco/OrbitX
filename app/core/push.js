// push.js — Suscripción Web Push desde el cliente. En iOS solo funciona si la
// app está instalada en la pantalla de inicio (iOS 16.4+): se detecta con
// display-mode standalone y se explica en vez de fallar callado.
function b64aUint8(b64) {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

export function estadoPush() {
  const esIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const instalada = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const soportado = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { soportado, instalada, esIOS, permiso: soportado ? Notification.permission : "unsupported" };
}

export async function suscripcionActual() {
  if (!("serviceWorker" in navigator)) return null;
  // serviceWorker.ready puede quedar pendiente para siempre si el SW no llegó
  // a activarse: no bloquear la UI por eso.
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 2000))]);
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function suscribirPush(api) {
  const st = estadoPush();
  if (!st.soportado) return { ok: false, motivo: "Este navegador no soporta notificaciones." };
  if (st.esIOS && !st.instalada) return { ok: false, motivo: "En iPhone, primero instalá la app: Compartir → Agregar a pantalla de inicio." };
  const { data } = await api.get("/api/auth/push-public-key");
  if (!data?.key) return { ok: false, motivo: "El servidor no tiene push configurado." };
  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") return { ok: false, motivo: "No diste permiso de notificaciones." };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aUint8(data.key) });
  try {
    await api.post("/api/auth/push-subscribe", { subscription: sub.toJSON() });
  } catch (e) {
    // El server no la aceptó (endpoint no permitido, etc.): no dejar una
    // suscripción activa en el navegador que el server desconoce.
    await sub.unsubscribe().catch(() => {});
    return { ok: false, motivo: e.body?.error || e.message || "El servidor rechazó la suscripción." };
  }
  return { ok: true };
}

export async function desuscribirPush(api) {
  const sub = await suscripcionActual();
  if (!sub) return;
  await api.post("/api/auth/push-unsubscribe", { endpoint: sub.endpoint }).catch((e) => console.warn("[push] no se pudo dar de baja en el server:", e.message));
  await sub.unsubscribe();
}
