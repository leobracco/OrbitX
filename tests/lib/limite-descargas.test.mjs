import { test } from "node:test";
import assert from "node:assert/strict";
import { crearLimite, ipCliente } from "../../lib/limite-descargas.js";

function reloj(inicio = 1_000_000) { let t = inicio; return { ahora: () => t, avanzar: (ms) => { t += ms; } }; }

test("permite 20 descargas por hora y niega la 21", () => {
  const r = reloj();
  const lim = crearLimite({ limite: 20, ventanaMs: 3600_000, ahora: r.ahora });
  for (let i = 0; i < 20; i++) assert.equal(lim.permitir("1.1.1.1"), true, `descarga ${i + 1}`);
  assert.equal(lim.permitir("1.1.1.1"), false);
  assert.equal(lim.permitir("2.2.2.2"), true, "otra IP no comparte el cupo");
});

test("pasada la ventana vuelve a permitir", () => {
  const r = reloj();
  const lim = crearLimite({ limite: 2, ventanaMs: 1000, ahora: r.ahora });
  assert.equal(lim.permitir("a"), true); assert.equal(lim.permitir("a"), true); assert.equal(lim.permitir("a"), false);
  r.avanzar(1001);
  assert.equal(lim.permitir("a"), true);
});

test("barrer() borra las IPs sin descargas recientes", () => {
  const r = reloj();
  const lim = crearLimite({ ventanaMs: 1000, ahora: r.ahora });
  lim.permitir("a"); lim.permitir("b");
  assert.equal(lim.tamano(), 2);
  r.avanzar(500); lim.permitir("b");
  r.avanzar(600); lim.barrer();
  assert.equal(lim.tamano(), 1, "queda solo b, que descargó hace 600 ms");
});

test("con el Map lleno de IPs activas no crece: niega IPs nuevas hasta que venzan", () => {
  const r = reloj();
  const lim = crearLimite({ ventanaMs: 1000, maxIps: 3, ahora: r.ahora });
  for (const ip of ["a", "b", "c"]) assert.equal(lim.permitir(ip), true);
  assert.equal(lim.permitir("d"), false, "cuarta IP con el Map lleno");
  assert.equal(lim.tamano(), 3);
  r.avanzar(1001);
  assert.equal(lim.permitir("d"), true, "al vencer las otras, entra");
  assert.equal(lim.tamano(), 1);
});

test("ipCliente toma el ÚLTIMO salto de X-Forwarded-For y cae a req.ip", () => {
  assert.equal(ipCliente({ headers: { "x-forwarded-for": "6.6.6.6, 190.1.2.3" }, ip: "172.18.0.2" }), "190.1.2.3");
  assert.equal(ipCliente({ headers: { "x-forwarded-for": " 190.1.2.3 " }, ip: "172.18.0.2" }), "190.1.2.3");
  assert.equal(ipCliente({ headers: {}, ip: "172.18.0.2" }), "172.18.0.2");
});
