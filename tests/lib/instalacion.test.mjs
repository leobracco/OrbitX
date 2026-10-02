// Perfil de instalación: lo que la pantalla baja de la nube después de que
// Agro Parallel la aprobó. Las claves de soporte/RustDesk salen UNA sola vez.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeDb } from "./fake-db.mjs";
const require = createRequire(import.meta.url);
const inst = require("../../lib/instalacion.js");

const cfg = (vals) => ({ async get(k) { return vals[k] || ""; } });
const base = () => fakeDb([
  { _id: "org_turpiales", tipo: "org", slug: "turpiales", nombre: "LOS PEQUEÑOS TURPIALES S.A.", cuit: "30606933122" },
  { _id: "firmware_PilotX_1.0.87", tipo: "firmware", producto: "PilotX", version: "1.0.87", hash_sha256: "ab".repeat(32), tamano_bytes: 201730160, ts: 5 },
  inst.nuevaInstalacion({ device_id: "OX-AAA", estab_slug: "turpiales", version: "1.0.87", kiosko: true, por: "usr_1", now: 1 }),
]);

test("idInstalacion", () => assert.equal(inst.idInstalacion("OX-1"), "instalacion_OX-1"));

test("primer perfil trae claves; el segundo no", async () => {
  const gdb = base();
  const c = cfg({ INSTALADOR_SOPORTE_PASS: "s3cr3t", INSTALADOR_RUSTDESK_PASS: "rd" });
  const p1 = await inst.armarPerfil({ gdb, cfg: c, deviceId: "OX-AAA", now: 10 });
  assert.equal(p1.cliente, "LOS PEQUEÑOS TURPIALES S.A.");
  assert.equal(p1.cuit, "30606933122");
  assert.equal(p1.sha256, "ab".repeat(32));
  assert.equal(p1.kiosko, true);
  assert.equal(p1.soporte_pass, "s3cr3t");
  assert.equal(p1.rustdesk_pass, "rd");
  const p2 = await inst.armarPerfil({ gdb, cfg: c, deviceId: "OX-AAA", now: 11 });
  assert.equal(p2.soporte_pass, undefined);
  assert.equal(p2.rustdesk_pass, undefined);
  assert.equal(p2.version, "1.0.87");
});

test("perfil trae RustDesk (servidor, clave y binario más nuevo) si está configurado", async () => {
  const gdb = base();
  await gdb.insert({ _id: "firmware_RustDesk_1.4.1", tipo: "firmware", producto: "RustDesk", version: "1.4.1", hash_sha256: "cd".repeat(32), ts: 9 });
  await gdb.insert({ _id: "firmware_RustDesk_1.3.0", tipo: "firmware", producto: "RustDesk", version: "1.3.0", hash_sha256: "ef".repeat(32), ts: 2 });
  const c = cfg({ INSTALADOR_SOPORTE_PASS: "s", INSTALADOR_RUSTDESK_HOST: "asistx.agroparallel.com", INSTALADOR_RUSTDESK_KEY: "k=" });
  const p = await inst.armarPerfil({ gdb, cfg: c, deviceId: "OX-AAA", now: 10 });
  assert.deepEqual(p.rustdesk, { host: "asistx.agroparallel.com", key: "k=", version: "1.4.1", sha256: "cd".repeat(32) });
});

test("perfil sin RustDesk configurado trae rustdesk null", async () => {
  const p = await inst.armarPerfil({ gdb: base(), cfg: cfg({ INSTALADOR_SOPORTE_PASS: "s" }), deviceId: "OX-AAA", now: 10 });
  assert.equal(p.rustdesk, null);
});

test("rustdesk_pass cae a soporte_pass si no está configurada", async () => {
  const p = await inst.armarPerfil({ gdb: base(), cfg: cfg({ INSTALADOR_SOPORTE_PASS: "s" }), deviceId: "OX-AAA", now: 10 });
  assert.equal(p.rustdesk_pass, "s");
});

test("sin clave de soporte configurada es 503 y no marca entregadas", async () => {
  const gdb = base();
  await assert.rejects(inst.armarPerfil({ gdb, cfg: cfg({}), deviceId: "OX-AAA", now: 10 }), e => e.status === 503);
  const doc = await gdb.get("instalacion_OX-AAA");
  assert.equal(doc.claves_entregadas, false);
});

test("sin instalación aprobada es 404", async () => {
  await assert.rejects(inst.armarPerfil({ gdb: base(), cfg: cfg({ INSTALADOR_SOPORTE_PASS: "s" }), deviceId: "OX-ZZZ", now: 10 }), e => e.status === 404);
});

test("versión sin binario en OTA es 409", async () => {
  const gdb = base();
  await gdb.insert(inst.nuevaInstalacion({ device_id: "OX-BBB", estab_slug: "turpiales", version: "9.9.9", kiosko: true, por: "u", now: 1 }));
  await assert.rejects(inst.armarPerfil({ gdb, cfg: cfg({ INSTALADOR_SOPORTE_PASS: "s" }), deviceId: "OX-BBB", now: 10 }), e => e.status === 409);
});

test("nuevaInstalacion sobre una previa conserva _rev y resetea claves", () => {
  const previo = { _id: "instalacion_OX-1", _rev: "7-z", claves_entregadas: true, pasos: [{ t: 1 }] };
  const d = inst.nuevaInstalacion({ device_id: "OX-1", estab_slug: "x", version: "1.0.87", kiosko: false, por: "u", now: 2, previo });
  assert.equal(d._rev, "7-z");
  assert.equal(d.claves_entregadas, false);
  assert.deepEqual(d.pasos, []);
  assert.equal(d.estado, "aprobada");
});

test("agregarPaso acota a 80 y actualiza estado", () => {
  const d = inst.nuevaInstalacion({ device_id: "OX-1", estab_slug: "x", version: "1", kiosko: true, por: "u", now: 1 });
  for (let i = 0; i < 90; i++) inst.agregarPaso(d, { paso: "red", msg: "m" + i }, 100 + i);
  inst.agregarPaso(d, { paso: "kiosko", msg: "listo", estado: "instalado" }, 500);
  assert.equal(d.pasos.length, 80);
  assert.equal(d.pasos.at(-1).msg, "listo");
  assert.equal(d.estado, "instalado");
  assert.equal(d.updated_at, 500);
});

test("agregarPaso ignora estados desconocidos", () => {
  const d = inst.nuevaInstalacion({ device_id: "OX-1", estab_slug: "x", version: "1", kiosko: true, por: "u", now: 1 });
  inst.agregarPaso(d, { paso: "x", msg: "m", estado: "hackeado" }, 2);
  assert.equal(d.estado, "aprobada");
});

test("guardarRed guarda y rechaza > 16 KB", () => {
  const d = inst.nuevaInstalacion({ device_id: "OX-1", estab_slug: "x", version: "1", kiosko: true, por: "u", now: 1 });
  inst.guardarRed(d, { antes: { ok: false }, despues: { ok: true } }, 9);
  assert.deepEqual(d.red, { ts: 9, diag: { antes: { ok: false }, despues: { ok: true } } });
  assert.throws(() => inst.guardarRed(d, { x: "a".repeat(17000) }, 10), e => e.status === 413);
});

test("elegirUltimo toma el de mayor ts", () => {
  assert.equal(inst.elegirUltimo([{ version: "a", ts: 1 }, { version: "b", ts: 3 }, { version: "c", ts: 2 }]).version, "b");
  assert.equal(inst.elegirUltimo([]), null);
});

// actualizarDoc: reintento ante conflicto 409 (dos POST /progreso o /red concurrentes).
test("actualizarDoc reintenta ante conflicto 409 y conserva el cambio del otro escritor", async () => {
  const gdb = base();
  const origInsert = gdb.insert.bind(gdb);
  let insertCalls = 0;
  gdb.insert = async (doc) => {
    insertCalls++;
    if (insertCalls === 1) {
      // Otro escritor (otro POST concurrente) guarda primero, bumpeando el
      // _rev real en el store ANTES de que este insert llegue a correr.
      const fresco = await gdb.get("instalacion_OX-AAA");
      fresco.otro_campo = "cambio-concurrente";
      await origInsert(fresco);
    }
    return origInsert(doc);
  };
  const final = await inst.actualizarDoc(gdb, "OX-AAA", d => { d.mio = "mi-cambio"; });
  assert.equal(insertCalls, 2);
  assert.equal(final.otro_campo, "cambio-concurrente");
  assert.equal(final.mio, "mi-cambio");
  const guardado = await gdb.get("instalacion_OX-AAA");
  assert.equal(guardado.otro_campo, "cambio-concurrente");
  assert.equal(guardado.mio, "mi-cambio");
});

test("actualizarDoc: conflicto persistente rechaza con 409 tras 3 intentos (get llamado 3 veces)", async () => {
  const gdb = base();
  let getCalls = 0;
  const origGet = gdb.get.bind(gdb);
  gdb.get = async (id) => { getCalls++; return origGet(id); };
  gdb.insert = async () => { const e = new Error("conflict"); e.statusCode = 409; throw e; };
  await assert.rejects(
    inst.actualizarDoc(gdb, "OX-AAA", d => { d.mio = "x"; }),
    e => e.statusCode === 409
  );
  assert.equal(getCalls, 3);
});

test("actualizarDoc: sin instalación aprobada rechaza con 404", async () => {
  await assert.rejects(
    inst.actualizarDoc(base(), "OX-ZZZ", d => { d.mio = "x"; }),
    e => e.status === 404
  );
});

test("actualizarDoc: si fn tira (ej. guardarRed con payload > 16KB) no reintenta ni inserta", async () => {
  const gdb = base();
  let insertCalls = 0;
  const origInsert = gdb.insert.bind(gdb);
  gdb.insert = async (doc) => { insertCalls++; return origInsert(doc); };
  await assert.rejects(
    inst.actualizarDoc(gdb, "OX-AAA", d => inst.guardarRed(d, { x: "a".repeat(17000) }, 10)),
    e => e.status === 413
  );
  assert.equal(insertCalls, 0);
});
