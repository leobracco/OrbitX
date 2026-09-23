import { test } from "node:test";
import assert from "node:assert/strict";
import notis from "../../lib/notificaciones.js";

const { armarNotificacion, urlSegura, contarNoLeidas, estaLeida, compactarLectura, mergearLecturas } = notis;

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
  assert.match(n._id, /^notif_1700000000000_[a-f0-9]{8}$/);
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

test("armarNotificacion: url insegura se guarda como null", () => {
  const n = armarNotificacion("fin_tarea", { url: "javascript:alert(1)" }, 1);
  assert.equal(n.url, null);
});

test("urlSegura: solo rutas relativas del propio sitio", () => {
  assert.equal(urlSegura("/notificaciones"), "/notificaciones");
  assert.equal(urlSegura("/app/#/equipos"), "/app/#/equipos");
  assert.equal(urlSegura("//evil.com"), null);
  assert.equal(urlSegura("javascript:alert(1)"), null);
  assert.equal(urlSegura("https://x"), null);
  assert.equal(urlSegura(null), null);
  assert.equal(urlSegura(undefined), null);
  assert.equal(urlSegura(123), null);
  assert.equal(urlSegura(""), null);
  assert.equal(urlSegura("/" + "a".repeat(300)), null); // 301 chars, supera el máximo
  assert.equal(urlSegura("/" + "a".repeat(299)), "/" + "a".repeat(299)); // 300 chars, límite ok
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

test("mergearLecturas: union de ids, max de ts_hasta, compactado despues", () => {
  const remota = {
    _id: "notif_leidas_u1", _rev: "3-remoto",
    ts_hasta: 100, ids_leidas: ["nA", "nB"], ids_ts: { nA: 50, nB: 90 },
  };
  const local = {
    _id: "notif_leidas_u1", _rev: "2-viejo",
    ts_hasta: 50, ids_leidas: ["nC"], ids_ts: { nC: 120 },
  };
  const merged = mergearLecturas(remota, local);

  // se queda con el _rev remoto (el que hay que usar para el reintento)
  assert.equal(merged._rev, "3-remoto");
  // max de ts_hasta entre ambas
  assert.equal(merged.ts_hasta, 100);
  // union de ids marcados por las dos escrituras concurrentes, pero
  // compactado despues: nA (ts 50) y nB (ts 90) ya quedan cubiertos por
  // ts_hasta=100 y se caen; solo sobrevive nC (ts 120, > ts_hasta)
  assert.deepEqual(merged.ids_leidas, ["nC"]);
  assert.deepEqual(merged.ids_ts, { nC: 120 });
});

test("mergearLecturas: no pierde el marcado local si el remoto no lo tiene", () => {
  const remota = { _id: "notif_leidas_u1", _rev: "5-remoto", ts_hasta: 0, ids_leidas: ["x1"], ids_ts: { x1: 10 } };
  const local  = { _id: "notif_leidas_u1", _rev: "4-viejo",  ts_hasta: 0, ids_leidas: ["x2"], ids_ts: { x2: 20 } };
  const merged = mergearLecturas(remota, local);
  assert.deepEqual(new Set(merged.ids_leidas), new Set(["x1", "x2"]));
});

test("urlSegura rechaza la barra invertida (el navegador la lee como //)", () => {
  assert.equal(urlSegura("/" + String.fromCharCode(92) + "evil.com"), null);
});
