import { test } from "node:test";
import assert from "node:assert/strict";
import notis from "../../lib/notificaciones.js";

const { armarNotificacion, contarNoLeidas, estaLeida, compactarLectura } = notis;

test("armarNotificacion: forma completa del doc", () => {
  const n = armarNotificacion("nodo_caido", { titulo: "Equipo sin reportar", cuerpo: "PC-3 hace 20 min", url: "/app/#/equipos" }, 1700000000000);
  assert.equal(n.tipo, "notificacion");
  assert.equal(n.evento, "nodo_caido");
  assert.equal(n.titulo, "Equipo sin reportar");
  assert.equal(n.cuerpo, "PC-3 hace 20 min");
  assert.equal(n.url, "/app/#/equipos");
  assert.equal(n.ts, 1700000000000);
  assert.equal(n.nivel, "info");
  assert.deepEqual(n.meta, {});
  assert.match(n._id, /^notif_1700000000000_[a-z0-9]{4}$/);
});

test("armarNotificacion: alerta_critica arranca en nivel critico", () => {
  assert.equal(armarNotificacion("alerta_critica", {}, 1).nivel, "critico");
  assert.equal(armarNotificacion("alerta_critica", { nivel: "ok" }, 1).nivel, "ok");
});

test("armarNotificacion: sin titulo usa el evento y recorta lo largo", () => {
  const n = armarNotificacion("fin_tarea", { cuerpo: "x".repeat(5000) }, 1);
  assert.equal(n.titulo, "fin_tarea");
  assert.equal(n.cuerpo.length, 2000);
});

test("estaLeida / contarNoLeidas con ts_hasta e ids sueltos", () => {
  const items = [
    { _id: "n3", ts: 300 },
    { _id: "n2", ts: 200 },
    { _id: "n1", ts: 100 },
  ];
  assert.equal(contarNoLeidas(items, null), 3);
  assert.equal(contarNoLeidas(items, { ts_hasta: 0, ids_leidas: [] }), 3);
  assert.equal(contarNoLeidas(items, { ts_hasta: 150, ids_leidas: [] }), 2);
  assert.equal(contarNoLeidas(items, { ts_hasta: 150, ids_leidas: ["n3"] }), 1);
  assert.equal(contarNoLeidas(items, { ts_hasta: 300, ids_leidas: [] }), 0);
  assert.equal(estaLeida({ _id: "n2", ts: 200 }, { ts_hasta: 200, ids_leidas: [] }), true);
  assert.equal(estaLeida({ _id: "n3", ts: 300 }, { ts_hasta: 200, ids_leidas: [] }), false);
});

test("compactarLectura: los ids anteriores a ts_hasta ya no hacen falta", () => {
  const l = compactarLectura({ ts_hasta: 200, ids_leidas: ["n1", "n2", "n3"], ids_ts: { n1: 100, n2: 200, n3: 300 } });
  assert.deepEqual(l.ids_leidas, ["n3"]);
  assert.deepEqual(l.ids_ts, { n3: 300 });
});
