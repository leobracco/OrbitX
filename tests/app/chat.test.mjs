// chat.test.mjs — La parte pura de la pantalla Chat con PilotX: cómo se lee el
// doc `soporte_chat_<device_id>` que arma routes/soporte.js, qué estado de
// entrega se muestra y qué se manda al server.
//
// Los casos salen de la forma real del doc: mensajes viejos sin `ts`, mensajes
// nuestros que la pantalla del tractor todavía no levantó (`entregado:false`),
// y el tope de 4000 caracteres que el server aplica con slice()+trim().
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MSG, normalizarRol, etiquetaRol, normalizarMensaje, normalizarHilo,
  estadoEntrega, contarNoLeidos, tsUltimoOperario, ultimoMensaje,
  vistaPrevia, prepararTexto,
} from "../../app/pantallas/chat.js";

const T = 1_750_000_000_000;

// Hilo como lo devuelve GET /api/soporte/chat/:device
const HILO = {
  device_id: "PC-TRACTOR-01",
  bot_activo: false,
  mensajes: [
    { rol: "soporte",  texto: "¿Cómo viene?", ts: T,          entregado: true,  leido: false, por: "usr_leo" },
    { rol: "operario", texto: "Se me traba el piloto", ts: T + 60000, entregado: true, leido: false },
    { rol: "soporte",  texto: "Mirá el WAS", ts: T + 120000, entregado: false, leido: false, por: "usr_leo" },
  ],
};

test("el hilo se normaliza sin reordenar los mensajes", () => {
  const h = normalizarHilo(HILO);
  assert.equal(h.device_id, "PC-TRACTOR-01");
  assert.equal(h.bot_activo, false);
  assert.deepEqual(h.mensajes.map(m => m.rol), ["soporte", "operario", "soporte"]);
  assert.deepEqual(h.mensajes.map(m => m.propio), [true, false, true]);
});

test("hilo vacío y respuestas basura no rompen nada", () => {
  for (const entrada of [undefined, null, {}, { mensajes: null }, { mensajes: "no" }]) {
    const h = normalizarHilo(entrada);
    assert.deepEqual(h.mensajes, []);
    assert.equal(h.device_id, "");
    assert.equal(h.bot_activo, false);
  }
  assert.equal(ultimoMensaje(normalizarHilo({}).mensajes), null);
  assert.equal(contarNoLeidos([]), 0);
  assert.equal(tsUltimoOperario([]), 0);
  assert.equal(vistaPrevia(null), "Sin mensajes todavía");
});

test("un mensaje sin ts se marca en null y no inventa hora", () => {
  const m = normalizarMensaje({ rol: "operario", texto: "hola" });
  assert.equal(m.ts, null);
  assert.equal(m.entregado, false);
  assert.equal(m.leido, false);
  // ts que no es número tampoco pasa
  assert.equal(normalizarMensaje({ ts: "ayer" }).ts, null);
  assert.equal(normalizarMensaje({ ts: NaN }).ts, null);
  // un elemento que no es objeto no debe tirar
  assert.equal(normalizarMensaje("basura").texto, "");
});

test("rol desconocido no se confunde con el operario", () => {
  assert.equal(normalizarRol("operario"), "operario");
  assert.equal(normalizarRol("OPERARIO"), "operario");
  assert.equal(normalizarRol("bot"), "bot");
  assert.equal(normalizarRol(undefined), "soporte");
  assert.equal(normalizarRol("marciano"), "soporte");
  assert.equal(etiquetaRol("operario"), "Operario");
  assert.equal(etiquetaRol("bot"), "Bot");
});

test("un mensaje que la pantalla no levantó NO se muestra como entregado", () => {
  const [mio, delOperario, sinEntregar] = normalizarHilo(HILO).mensajes;
  assert.equal(estadoEntrega(mio), "entregado");
  assert.equal(estadoEntrega(sinEntregar), "sin entregar");
  // De los mensajes del operario no se muestra estado: llegan ya entregados.
  assert.equal(estadoEntrega(delOperario), "");
  assert.equal(estadoEntrega({ rol: "soporte", texto: "x", entregado: true, leido: true }), "leído");
  // También acepta el mensaje crudo del server, sin normalizar antes
  assert.equal(estadoEntrega({ rol: "soporte", texto: "x" }), "sin entregar");
});

test("los no leídos son del operario, nunca los propios", () => {
  const msgs = normalizarHilo(HILO).mensajes;
  assert.equal(contarNoLeidos(msgs), 1);

  // Dos mensajes míos seguidos sin entregar no son "sin leer" mío.
  const soloMios = normalizarHilo({ mensajes: [
    { rol: "soporte", texto: "a", ts: T, entregado: false, leido: false },
    { rol: "bot",     texto: "b", ts: T + 1, entregado: false, leido: false },
  ] }).mensajes;
  assert.equal(contarNoLeidos(soloMios), 0);

  // Con marca local: lo anterior a la marca ya lo vimos.
  assert.equal(contarNoLeidos(msgs, T + 60000), 0);
  assert.equal(contarNoLeidos(msgs, T), 1);

  // `leido:true` (si algún día el server lo pone) tampoco cuenta.
  assert.equal(contarNoLeidos([{ rol: "operario", texto: "x", ts: T + 999999, leido: true }]), 0);
});

test("un mensaje del operario sin ts cuenta solo si nunca abrimos el hilo", () => {
  const viejos = [{ rol: "operario", texto: "sin ts" }];
  assert.equal(contarNoLeidos(viejos), 1);
  assert.equal(contarNoLeidos(viejos, T), 0);
});

test("la marca de leído es el ts del último mensaje del operario", () => {
  const msgs = normalizarHilo(HILO).mensajes;
  assert.equal(tsUltimoOperario(msgs), T + 60000);
  // Sin mensajes del operario no hay nada que marcar.
  assert.equal(tsUltimoOperario([{ rol: "soporte", texto: "a", ts: T }]), 0);
});

test("la vista previa dice quién habló y se recorta a una línea", () => {
  const largo = { rol: "operario", texto: "x".repeat(200), ts: T };
  const p = vistaPrevia(largo);
  assert.ok(p.startsWith("Operario: "));
  assert.ok(p.length < 100, `vista previa demasiado larga: ${p.length}`);
  assert.ok(p.endsWith("…"));
  // Los saltos de línea no rompen la fila
  assert.equal(vistaPrevia({ rol: "soporte", texto: "uno\n\ndos", ts: T }), "Soporte: uno dos");
  // Una propuesta del bot sin texto se nombra, no queda muda
  assert.equal(
    vistaPrevia(normalizarMensaje({ rol: "bot", texto: "", tipo: "propuesta_config", payload: { estado: "pendiente" } })),
    "Bot: (propuesta de configuración)");
});

test("una propuesta del bot se identifica con su estado", () => {
  const m = normalizarMensaje({ rol: "bot", texto: "Te propongo bajar el PWM", tipo: "propuesta_config", payload: { estado: "aceptada" } });
  assert.equal(m.estadoPropuesta, "aceptada");
  // Sin estado en el payload, es una propuesta pendiente
  assert.equal(normalizarMensaje({ tipo: "propuesta_config" }).estadoPropuesta, "pendiente");
  // Un mensaje de texto normal no es propuesta
  assert.equal(normalizarMensaje({ rol: "soporte", texto: "hola" }).estadoPropuesta, null);
});

test("no se manda un mensaje vacío ni uno de puros espacios", () => {
  for (const vacio of ["", "   ", "\n\n", "\t \n", undefined, null]) {
    const r = prepararTexto(vacio);
    assert.equal(r.ok, false, `debería rechazar ${JSON.stringify(vacio)}`);
    assert.equal(r.texto, "");
    assert.ok(r.error.length > 0);
  }
});

test("un texto larguísimo se recorta igual que el server", () => {
  const r = prepararTexto("a".repeat(MAX_MSG + 500));
  assert.equal(r.ok, true);
  assert.equal(r.texto.length, MAX_MSG);
  assert.equal(r.recortado, true);

  // Justo en el límite no se avisa de recorte
  const justo = prepararTexto("b".repeat(MAX_MSG));
  assert.equal(justo.recortado, false);
  assert.equal(justo.texto.length, MAX_MSG);

  // El server hace slice() y DESPUÉS trim(): los espacios del final del corte
  // se pierden, así que acá tiene que pasar lo mismo.
  const conEspacios = prepararTexto("c".repeat(MAX_MSG - 2) + "   fin");
  assert.equal(conEspacios.texto.length, MAX_MSG - 2);
  assert.equal(conEspacios.recortado, true);
});

test("el texto que se manda es el que se ve, sin espacios de borde", () => {
  const r = prepararTexto("  revisá el WAS  ");
  assert.equal(r.ok, true);
  assert.equal(r.texto, "revisá el WAS");
  assert.equal(r.recortado, false);
});
