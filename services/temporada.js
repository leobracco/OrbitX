"use strict";
// temporada.js — Temporada agrícola del hemisferio sur: del 1 de septiembre al
// 31 de agosto. Clave "AAAA/AA" (2026/27 = sep-2026 → ago-2027). Todo se calcula
// en hora Argentina para que un archivo del 31/8 a la noche no salte de campaña.
const TZ = "America/Argentina/Buenos_Aires";

function partesAR(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha + "T12:00:00-03:00" : fecha);
  if (Number.isNaN(d.getTime())) throw new Error("fecha inválida: " + fecha);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => Number(p.find(x => x.type === t).value);
  return { anio: g("year"), mes: g("month"), dia: g("day") };
}

function clave(anioInicio) { return `${anioInicio}/${String((anioInicio + 1) % 100).padStart(2, "0")}`; }

function temporadaDe(fecha) {
  const { anio, mes } = partesAR(fecha);
  return clave(mes >= 9 ? anio : anio - 1);
}

function esTemporadaValida(s) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(s || ""));
  return !!m && Number(m[2]) === (Number(m[1]) + 1) % 100;
}

function rangoTemporada(s) {
  if (!esTemporadaValida(s)) throw new Error("temporada inválida: " + s);
  const a = Number(s.slice(0, 4));
  const desde = `${a}-09-01`, hasta = `${a + 1}-08-31`;
  return { desde, hasta, desdeMs: Date.parse(desde + "T00:00:00-03:00"), hastaMs: Date.parse(hasta + "T23:59:59-03:00") };
}

function temporadaActual(ahora = new Date()) { return temporadaDe(ahora); }

module.exports = { temporadaDe, rangoTemporada, temporadaActual, esTemporadaValida };
