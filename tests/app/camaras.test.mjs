// camaras.test.mjs — Las cuentas de la parte de cámaras de la pantalla Equipos.
// Los casos salen de lo que devuelve el server de verdad (routes/camaras.js):
// hoy NINGÚN equipo tiene cámaras registradas, así que el caso "vacío" es el
// que se ve en producción y tiene que quedar prolijo; el resto son las cámaras
// que el server igual rechaza (no Hikvision, desactivadas) y las respuestas a
// las que les falta algún campo.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contarCamaras, motivoCamara, normalizarCamaras, urlVideo, textoErrorHls,
} from "../../app/pantallas/equipos.js";

test("un equipo sin cámaras registradas no ofrece cámaras", () => {
  // Es el estado de hoy en producción: el doc del device ni trae `camaras`.
  assert.equal(contarCamaras({ device_id: "OX-1" }), 0);
  assert.equal(contarCamaras({ device_id: "OX-1", camaras: [] }), 0);
  assert.equal(contarCamaras({ device_id: "OX-1", camaras: null }), 0);
  assert.equal(contarCamaras(null), 0);
  assert.equal(contarCamaras(undefined), 0);
  // Con cámaras sí: el número sale de /api/devices, sin pedido extra.
  assert.equal(contarCamaras({ camaras: [{ idx: 1 }, { idx: 2 }] }), 2);
});

test("el motivo repite el criterio del server: solo Hikvision y activa", () => {
  // Cámara buena: sin motivo, se puede mirar.
  assert.equal(motivoCamara({ idx: 1, marca: "hikvision", activa: true }), "");
  // El stream de prueba del server no manda marca — y el server igual la deja.
  assert.equal(motivoCamara({ idx: 1, nombre: "Test cam", activa: true }), "");
  // Marca no soportada: el server contesta 403 en playback, no la ofrecemos.
  assert.equal(motivoCamara({ idx: 2, marca: "dahua", activa: false, motivo_inactiva: "marca_no_soportada" }),
    "marca dahua no soportada — por ahora solo Hikvision");
  assert.equal(motivoCamara({ idx: 3, marca: "desconocida", activa: false, motivo_inactiva: "marca_no_soportada" }),
    "marca desconocida no soportada — por ahora solo Hikvision");
  // Hikvision apagada desde PilotX.
  assert.equal(motivoCamara({ idx: 4, marca: "hikvision", activa: false, motivo_inactiva: "deshabilitada_por_usuario" }),
    "desactivada desde PilotX");
  // Hikvision apagada por un motivo que no conocemos: no inventamos.
  assert.equal(motivoCamara({ idx: 5, marca: "hikvision", activa: false, motivo_inactiva: "vaya_a_saber" }),
    "desactivada en el equipo");
  // Sin idx no hay path en MediaMTX: no se puede pedir video.
  assert.equal(motivoCamara({ marca: "hikvision", activa: true }), "el equipo no informó el número de cámara");
  assert.equal(motivoCamara({}), "el equipo no informó el número de cámara");
  assert.equal(motivoCamara(null), "el equipo no informó el número de cámara");
});

test("normalizarCamaras aguanta una respuesta vacía o sin campos", () => {
  for (const vacia of [null, undefined, {}, { ok: true, camaras: [] }, { camaras: "no-es-lista" }]) {
    const r = normalizarCamaras(vacia);
    assert.deepEqual(r.camaras, []);
    assert.equal(r.online, false);
    assert.equal(r.nombre, "");
  }
});

test("normalizarCamaras completa lo que el equipo no mandó", () => {
  const r = normalizarCamaras({
    ok: true,
    device: { id: "OX-TRACTOR-1", nombre: "Tractor 1", online: true },
    camaras: [
      { idx: 1, nombre: "Tolva", marca: "hikvision", activa: true, online: true },
      { idx: 2 },                                            // sin nombre ni marca ni estado
      { idx: 3, nombre: "Trasera", marca: "dahua", activa: false, motivo_inactiva: "marca_no_soportada" },
      { nombre: "Sin número", marca: "hikvision", activa: true },
      null,                                                  // fila rota en la base
    ],
  });

  assert.equal(r.nombre, "Tractor 1");
  assert.equal(r.online, true);
  assert.equal(r.camaras.length, 5);

  assert.deepEqual(r.camaras[0], { idx: 1, nombre: "Tolva", online: true, motivo: "", disponible: true });
  // Sin nombre se numera por posición; `activa` ausente cuenta como activa,
  // igual que lo trata el server (solo rechaza activa === false).
  assert.deepEqual(r.camaras[1], { idx: 2, nombre: "Cámara 2", online: false, motivo: "", disponible: true });
  assert.equal(r.camaras[2].disponible, false);
  assert.match(r.camaras[2].motivo, /dahua/);
  // Sin idx: no se puede armar el path, queda listada pero no mirable.
  assert.equal(r.camaras[3].idx, null);
  assert.equal(r.camaras[3].disponible, false);
  assert.deepEqual(r.camaras[4], { idx: null, nombre: "Cámara 5", online: false, motivo: "el equipo no informó el número de cámara", disponible: false });
});

test("el nombre del equipo cae al device_id si no hay nombre", () => {
  const r = normalizarCamaras({ device: { id: "OX-SIN-NOMBRE" }, camaras: [] });
  assert.equal(r.nombre, "OX-SIN-NOMBRE");
});

test("urlVideo solo acepta una firma que todavía vale", () => {
  const ahora = 1_700_000_000_000;
  const hls = "https://cam.agroparallel.com/OX-1_cam1/index.m3u8?exp=1&sig=abc";

  assert.equal(urlVideo({ ok: true, hls, expiresAt: ahora + 60_000 }, ahora), hls);
  // Respuesta vieja de cache: la firma venció, mejor avisar que mostrar negro.
  assert.equal(urlVideo({ ok: true, hls, expiresAt: ahora - 1 }, ahora), null);
  assert.equal(urlVideo({ ok: true, hls, expiresAt: ahora }, ahora), null);
  // Sin expiración declarada no la damos por vencida.
  assert.equal(urlVideo({ hls }, ahora), hls);
  assert.equal(urlVideo({ hls, expiresAt: "no-es-numero" }, ahora), hls);
  // Respuestas sin URL (error del server, RTSP solo, campo vacío).
  assert.equal(urlVideo({ ok: true, rtsp: "rtsp://..." }, ahora), null);
  assert.equal(urlVideo({ hls: "   " }, ahora), null);
  assert.equal(urlVideo({ hls: 42 }, ahora), null);
  assert.equal(urlVideo(null, ahora), null);
  assert.equal(urlVideo(undefined, ahora), null);
});

test("los errores de hls.js se cuentan en criollo y con qué hacer", () => {
  // El más común: el tractor no está publicando ese path en MediaMTX.
  assert.match(textoErrorHls("manifestLoadError"), /no está transmitiendo/);
  assert.match(textoErrorHls("manifestLoadTimeOut"), /no está transmitiendo/);
  assert.match(textoErrorHls("manifestIncompatibleCodecsError"), /teléfono/);
  assert.match(textoErrorHls("manifestParsingError"), /inválida/);
  // Uno que no conocemos: se muestra el código, no se lo esconde.
  assert.equal(textoErrorHls("bufferStalledError"), "Falló el video (bufferStalledError).");
  assert.equal(textoErrorHls(""), "Falló el video.");
  assert.equal(textoErrorHls(null), "Falló el video.");
});
