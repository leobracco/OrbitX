import { test } from "node:test";
import assert from "node:assert/strict";
import { armarResumen, firmaContornos, contornosCacheGet, contornosCacheSet, CONTORNOS_MS } from "../../services/actividad.js";
import { rangoTemporada } from "../../services/temporada.js";

const rango = rangoTemporada("2025/26");
// Dentro del rango (temporada 2025/26: 2025-09-01 a 2026-08-31)
const tsDentro1 = Date.parse("2025-10-05T12:00:00-03:00");
const tsDentro2 = Date.parse("2025-10-06T12:00:00-03:00"); // más nueva, mismo lote que tsDentro1
const tsDentro3 = Date.parse("2026-01-15T12:00:00-03:00");
// Fuera del rango
const tsFueraAntes = Date.parse("2025-08-20T12:00:00-03:00");
const tsFueraDespues = Date.parse("2026-09-15T12:00:00-03:00");

function stats(trabajado, neto) {
  return { trabajado_ha: trabajado, neto_ha: neto, repintado_ha: trabajado - neto, repintado_pct: 0, contorno_ha: 0, bloques: 1, resolucion_m: 1 };
}

test("armarResumen: suma trabajado/neto solo de coberturas dentro del rango, y de la más nueva por lote", () => {
  const coberturas = [
    { lote_nombre: "La Mariana 4 este", ts: tsDentro1, stats: stats(20, 18) },
    { lote_nombre: "La Mariana 4 este", ts: tsDentro2, stats: stats(34.6, 30) }, // gana esta (más nueva)
    { lote_nombre: "Lote 2", ts: tsDentro3, stats: stats(10, 9) },
    { lote_nombre: "Lote 3", ts: tsFueraAntes, stats: stats(100, 90) }, // fuera de rango, no debe sumar
    { lote_nombre: "Lote 4", ts: tsFueraDespues, stats: stats(50, 45) }, // fuera de rango, no debe sumar
  ];
  const r = armarResumen({ temporada: "2025/26", rango, coberturas, ahora: tsDentro3 });
  assert.equal(r.hectareas.trabajadas, 44.6); // 34.6 (gana la más nueva) + 10
  assert.equal(r.hectareas.netas, 39); // 30 + 9
  assert.equal(r.hectareas.lotes, 2); // "La Mariana 4 este" y "Lote 2" — lotes distintos en rango
});

test("armarResumen: equipos.online = ultimo_visto < 2 min, resto va a sin_reportar", () => {
  const ahora = Date.now();
  const devices = [
    { device_id: "d1", hostname: "VX-01", ultimo_visto: ahora - 60 * 1000 }, // 1 min: online
    { device_id: "d2", hostname: "VX-02", ultimo_visto: ahora - 4 * 60 * 60 * 1000 }, // 4 h: sin_reportar
  ];
  const r = armarResumen({ temporada: "2025/26", rango, coberturas: [], devices, ahora });
  assert.equal(r.equipos.total, 2);
  assert.equal(r.equipos.online, 1);
  assert.equal(r.equipos.sin_reportar.length, 1);
  assert.equal(r.equipos.sin_reportar[0].hostname, "VX-02");
  assert.equal(r.equipos.sin_reportar[0].hace_min, 240);
});

test("armarResumen: lluvia.mes_mm suma el mes calendario actual (TZ AR) y temporada_mm el rango", () => {
  const ahora = Date.parse("2026-01-15T12:00:00-03:00"); // enero 2026, dentro del rango 2025/26
  const lluvias = [
    { fecha: "2026-01-05", mm: 10 }, // mes actual, dentro del rango
    { fecha: "2026-01-20", mm: 15 }, // mes actual, dentro del rango
    { fecha: "2025-12-01", mm: 40 }, // dentro del rango pero no del mes actual
    { fecha: "2025-08-15", mm: 99 }, // fuera del rango (temporada anterior)
  ];
  const r = armarResumen({ temporada: "2025/26", rango, coberturas: [], lluvias, ahora });
  assert.equal(r.lluvia.mes_mm, 25); // 10 + 15
  assert.equal(r.lluvia.temporada_mm, 65); // 10 + 15 + 40
  assert.equal(r.lluvia.ultima.fecha, "2026-01-20"); // la de fecha más reciente de TODAS las lluvias
});

test("armarResumen: alertas_activas cuenta las no resueltas", () => {
  const alertas = [
    { ts_inicio: tsDentro1, mensaje: "Alerta 1", resuelta: false },
    { ts_inicio: tsDentro2, mensaje: "Alerta 2", resuelta: true },
    { ts_inicio: tsDentro3, mensaje: "Alerta 3" }, // sin campo resuelta = activa
  ];
  const r = armarResumen({ temporada: "2025/26", rango, coberturas: [], alertas, ahora: tsDentro3 });
  assert.equal(r.alertas_activas, 2);
});

test("armarResumen: ultimos viene ordenado desc por ts, máximo 12, con los 4 tipos y lote en lote/lluvia", () => {
  const ahora = tsDentro3;
  const coberturas = [
    { lote_nombre: "La Mariana 4 este", ts: tsDentro1, stats: stats(34.6, 30) },
  ];
  const lluvias = [{ fecha: "2026-01-10", mm: 12, lote: "La Mariana 4" }];
  const alertas = [{ ts_inicio: tsDentro2, mensaje: "Sensor caído", resuelta: false }];
  const devices = [{ device_id: "d1", hostname: "VX-01", ultimo_visto: ahora - 30 * 1000 }]; // online

  const r = armarResumen({ temporada: "2025/26", rango, coberturas, lluvias, alertas, devices, ahora });

  const tipos = r.ultimos.map(e => e.tipo);
  assert.ok(tipos.includes("lote"));
  assert.ok(tipos.includes("lluvia"));
  assert.ok(tipos.includes("alerta"));
  assert.ok(tipos.includes("equipo"));
  assert.ok(r.ultimos.length <= 12);
  // orden desc por ts
  for (let i = 1; i < r.ultimos.length; i++) assert.ok(r.ultimos[i - 1].ts >= r.ultimos[i].ts);

  const evLote = r.ultimos.find(e => e.tipo === "lote");
  assert.equal(evLote.lote, "La Mariana 4 este");
  const evLluvia = r.ultimos.find(e => e.tipo === "lluvia");
  assert.equal(evLluvia.lote, "La Mariana 4");

  // más de 12 eventos: recorta a 12
  const muchasLluvias = Array.from({ length: 20 }, (_, i) => ({ fecha: `2026-01-${String(i + 1).padStart(2, "0")}`, mm: 1 }));
  const r2 = armarResumen({ temporada: "2025/26", rango, coberturas: [], lluvias: muchasLluvias, ahora });
  assert.equal(r2.ultimos.length, 12);
});

// ── Cache de contornos (I11) — lógica pura, sin CouchDB ──────
test("firmaContornos: cantidad + ts máximo, y es estable ante el orden", () => {
  const docs = [{ _id: "a", ts: 10 }, { _id: "b", ts: 50 }, { _id: "c", ts: 30 }];
  assert.equal(firmaContornos(docs), "3:50");
  assert.equal(firmaContornos([...docs].reverse()), "3:50");
  assert.equal(firmaContornos([]), "0:0");
  assert.equal(firmaContornos(null), "0:0");
  // ts faltante o basura cuenta como 0, pero el doc igual suma a la cantidad.
  assert.equal(firmaContornos([{ _id: "a" }, { _id: "b", ts: "x" }]), "2:0");
});

test("firmaContornos: un alta o una edición cambian la firma", () => {
  const base = [{ _id: "a", ts: 10 }, { _id: "b", ts: 20 }];
  assert.notEqual(firmaContornos([...base, { _id: "c", ts: 5 }]), firmaContornos(base));   // alta
  assert.notEqual(firmaContornos([{ _id: "a", ts: 10 }, { _id: "b", ts: 99 }]), firmaContornos(base)); // edición
  assert.notEqual(firmaContornos([{ _id: "a", ts: 10 }]), firmaContornos(base));           // baja
});

test("cache de contornos: devuelve el mapa con la misma firma y lo descarta si cambió", () => {
  const ahora = 1_700_000_000_000;
  const mapa = new Map([["Lote 1", 12.5]]);
  contornosCacheSet("org-test-1", "2:100", mapa, ahora);
  assert.equal(contornosCacheGet("org-test-1", "2:100", ahora), mapa);
  // Firma distinta (alguien dibujó o editó un boundary) → hay que reparsear.
  assert.equal(contornosCacheGet("org-test-1", "3:100", ahora), null);
  // Otra org no ve el cache de la primera.
  assert.equal(contornosCacheGet("org-test-2", "2:100", ahora), null);
});

test("cache de contornos: vence a los 30 min", () => {
  const ahora = 1_700_000_000_000;
  const mapa = new Map([["Lote 1", 1]]);
  contornosCacheSet("org-test-ttl", "1:1", mapa, ahora);
  assert.equal(contornosCacheGet("org-test-ttl", "1:1", ahora + CONTORNOS_MS - 1), mapa);
  assert.equal(contornosCacheGet("org-test-ttl", "1:1", ahora + CONTORNOS_MS), null);
});
