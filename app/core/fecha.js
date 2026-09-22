// fecha.js — Formatos de fecha para la UI. El server corre en UTC: TODO lo
// visible se formatea en hora Argentina. Un timestamp inválido devuelve "—"
// en lugar de lanzar un error.
const TZ = "America/Argentina/Buenos_Aires";

export function haceCuanto(ts, ahora = Date.now()) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "—";
  const s = Math.max(0, Math.round((ahora - ts) / 1000));
  if (s < 60) return "recién";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

export function fechaCorta(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("es-AR", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const day = map.day.padStart(2, "0");
  const month = map.month.padStart(2, "0");
  const hour = map.hour.padStart(2, "0");
  const minute = map.minute.padStart(2, "0");
  return `${day}/${month} ${hour}:${minute}`;
}

export function fechaISOHoy(ahora = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ahora);
  return p; // en-CA da YYYY-MM-DD
}
