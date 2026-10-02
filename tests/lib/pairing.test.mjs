// Reglas del pairing por código. Lo crítico: un código que viene del
// instalador (pantalla nueva, sin dueño todavía) solo lo aprueba Agro
// Parallel; el pairing desde el menú de PilotX sigue como siempre.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const p = require("../../lib/pairing.js");

const SA    = { rol_global: "superadmin", estabSlug: null };
const OWNER = { rol_global: "user", estabSlug: "campo_x" };

test("validPairCode acepta 6 chars del alfabeto y rechaza confusos", () => {
  assert.equal(p.validPairCode("ABC234"), true);
  assert.equal(p.validPairCode("abc234"), true);
  assert.equal(p.validPairCode("ABCD1O"), false);
  assert.equal(p.validPairCode("ABC23"), false);
  assert.equal(p.validPairCode(null), false);
});

test("hashSecret es sha256 hex estable", () => {
  assert.equal(p.hashSecret("x"), p.hashSecret("x"));
  assert.match(p.hashSecret("x"), /^[0-9a-f]{64}$/);
});

test("instalador: owner no puede aprobar", () => {
  const r = p.decidirClaim({ intent: { origen: "instalador" }, user: OWNER, estabBody: "campo_x" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("instalador: superadmin tiene que elegir org", () => {
  const r = p.decidirClaim({ intent: { origen: "instalador" }, user: SA, estabBody: "" });
  assert.deepEqual([r.ok, r.status], [false, 400]);
});

test("instalador: superadmin con org aprueba", () => {
  const r = p.decidirClaim({ intent: { origen: "instalador" }, user: SA, estabBody: "campo_x" });
  assert.deepEqual(r, { ok: true, estab_slug: "campo_x" });
});

test("sin origen: owner vincula a su org (como hoy)", () => {
  const r = p.decidirClaim({ intent: {}, user: OWNER, estabBody: "otra" });
  assert.deepEqual(r, { ok: true, estab_slug: "campo_x" });
});

test("sin origen: sin org activa es 403 (como hoy)", () => {
  const r = p.decidirClaim({ intent: {}, user: { rol_global: "user" }, estabBody: "" });
  assert.deepEqual([r.ok, r.status], [false, 403]);
});

test("limpiarResumen deja solo campos conocidos y acota tamaños", () => {
  const r = p.limpiarResumen({
    hostname: "TABLET-1", windows: "Windows 11 Pro 23H2", instalacion_anterior: true, lotes: 12,
    malicioso: "x", adaptadores: Array.from({ length: 20 }, (_, i) => ({ nombre: "eth" + i, tipo: "ethernet", ip: "192.168.5." + i, internet: false, extra: 1 })),
  });
  assert.equal(r.malicioso, undefined);
  assert.equal(r.adaptadores.length, 8);
  assert.equal(r.adaptadores[0].extra, undefined);
  assert.equal(r.lotes, 12);
  assert.equal(p.limpiarResumen(null), null);
});

test("listarPendientes muestra solo instalador, sin reclamar y vigentes", () => {
  const now = 1_000_000;
  const m = new Map([
    ["AAAAAA", { origen: "instalador", device_id: "OX-1", ts: now - 1000, claimed: false }],
    ["BBBBBB", { origen: "instalador", device_id: "OX-2", ts: now - 1000, claimed: true }],
    ["CCCCCC", { device_id: "OX-3", ts: now - 1000, claimed: false }],
    ["DDDDDD", { origen: "instalador", device_id: "OX-4", ts: now - p.PAIRING_TTL_MS - 1, claimed: false }],
  ]);
  const l = p.listarPendientes(m, now);
  assert.deepEqual(l.map(x => x.code), ["AAAAAA"]);
  assert.equal(l[0].expira_en_ms, p.PAIRING_TTL_MS - 1000);
});
