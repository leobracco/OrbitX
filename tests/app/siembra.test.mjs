// siembra.test.mjs — Las cuentas de la pantalla Siembra. Lo que se fija acá es
// el criterio con el que se le dice al dueño del campo "esto sembró bien" o
// "esto se fue de rango": si eso se equivoca, la pantalla miente sobre un lote
// ya sembrado y no hay vuelta atrás.
//
// Los casos borde salen de cómo llegan los datos de verdad: hoy en producción
// NO hay ningún lote de VistaX sincronizado, y las metas que escribió el VistaX
// viejo (vistax-server) solo tenían {id, nombre, startTs, endTs, totalSemillas}
// — sin densidad, sin fallas, sin dobles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { montar,
  TOLERANCIA_DEFECTO, aNumero, campoNumero, normalizarLotes, ordenarLotes,
  cuando, objetivoSiembra, densidadDeLote, fallasDeLote, doblesDeLote,
  estadoDensidad, alertasActivas, textoAlerta, resumenSiembra, motivoVacio,
} from "../../app/pantallas/siembra.js";

const PERFIL = {
  nombre: "sembradora.json",
  device_id: "PC-TRACTOR-1",
  ts: 1758800000000,
  config: { id: "imp1", nombre: "Agrometal 43", setup: { densidad_objetivo: 16, tolerancia_desvio: 20 } },
};

test("aNumero acepta lo que manda la base y descarta el resto", () => {
  assert.equal(aNumero(16), 16);
  assert.equal(aNumero(0), 0);
  assert.equal(aNumero("16.4"), 16.4);
  // PilotX puede escribir la coma decimal del locale es-AR
  assert.equal(aNumero("16,4"), 16.4);
  assert.equal(aNumero(""), null);
  assert.equal(aNumero("   "), null);
  assert.equal(aNumero("sin dato"), null);
  assert.equal(aNumero(null), null);
  assert.equal(aNumero(undefined), null);
  assert.equal(aNumero(NaN), null);
  assert.equal(aNumero(Infinity), null);
  assert.equal(aNumero({}), null);
  assert.equal(aNumero([]), null);
});

test("campoNumero toma el primer nombre que exista y sea numérico", () => {
  assert.equal(campoNumero({ b: 3 }, ["a", "b"]), 3);
  assert.equal(campoNumero({ a: null, b: 3 }, ["a", "b"]), 3);
  assert.equal(campoNumero({ a: "roto", b: 3 }, ["a", "b"]), 3);
  assert.equal(campoNumero({ a: 0, b: 3 }, ["a", "b"]), 0); // el cero es un dato
  assert.equal(campoNumero({}, ["a"]), null);
  assert.equal(campoNumero(null, ["a"]), null);
  assert.equal(campoNumero(undefined, ["a"]), null);
});

test("normalizarLotes soporta las dos formas que devuelve /api/vistax/lotes", () => {
  // sin paginación el router contesta un array pelado…
  assert.equal(normalizarLotes([{ lote_id: "lote_1" }]).length, 1);
  // …y con paginación un objeto
  assert.equal(normalizarLotes({ items: [{ lote_id: "a" }, { lote_id: "b" }], total: 2 }).length, 2);
  // el estado principal de hoy: no hay nada
  assert.deepEqual(normalizarLotes([]), []);
  assert.deepEqual(normalizarLotes(null), []);
  assert.deepEqual(normalizarLotes(undefined), []);
  assert.deepEqual(normalizarLotes({ error: "boom" }), []);
  // basura entre los items no debe llegar al render
  assert.deepEqual(normalizarLotes([null, "x", { lote_id: "a" }]), [{ lote_id: "a" }]);
});

test("cuando usa startTs y cae a ts_sync si la meta no tiene fecha de arranque", () => {
  assert.equal(cuando({ startTs: 1000 }), 1000);
  assert.equal(cuando({ ts_sync: 500 }), 500);
  assert.equal(cuando({ startTs: null, ts_sync: 500 }), 500);
  assert.equal(cuando({}), null);
});

test("ordenarLotes deja arriba el último trabajo y al fondo el que no tiene fecha", () => {
  const lotes = [
    { lote_id: "viejo", startTs: 1000 },
    { lote_id: "sin_fecha" },
    { lote_id: "nuevo", startTs: 3000 },
  ];
  assert.deepEqual(ordenarLotes(lotes).map((l) => l.lote_id), ["nuevo", "viejo", "sin_fecha"]);
  // no muta el array original
  assert.equal(lotes[0].lote_id, "viejo");
});

test("objetivoSiembra sale del perfil del implemento", () => {
  assert.deepEqual(objetivoSiembra(PERFIL), { densidad: 16, tolerancia: 20 });
  // sin perfil sincronizado (/api/vistax/perfil da 404) no hay con qué comparar
  assert.equal(objetivoSiembra(null), null);
  assert.equal(objetivoSiembra({}), null);
  assert.equal(objetivoSiembra({ config: {} }), null);
  // densidad en cero o negativa no es un objetivo
  assert.equal(objetivoSiembra({ config: { setup: { densidad_objetivo: 0 } } }), null);
  assert.equal(objetivoSiembra({ config: { setup: { densidad_objetivo: -4 } } }), null);
  // sin tolerancia cargada se usa la de fábrica del implemento
  assert.deepEqual(objetivoSiembra({ config: { setup: { densidad_objetivo: 20 } } }),
    { densidad: 20, tolerancia: TOLERANCIA_DEFECTO });
  assert.deepEqual(objetivoSiembra({ config: { setup: { densidad_objetivo: 20, tolerancia_desvio: 0 } } }),
    { densidad: 20, tolerancia: TOLERANCIA_DEFECTO });
});

test("densidad, fallas y dobles se leen con los dos juegos de nombres", () => {
  assert.equal(densidadDeLote({ densidad: 15 }), 15);
  assert.equal(densidadDeLote({ spmPromedio: 14.2 }), 14.2);
  assert.equal(densidadDeLote({ spm_promedio: "13,5" }), 13.5);
  // la meta que escribe el VistaX viejo no trae densidad
  assert.equal(densidadDeLote({ id: "lote_1", nombre: "La Loma", totalSemillas: 900000 }), null);
  assert.equal(fallasDeLote({ fallas: 12 }), 12);
  assert.equal(fallasDeLote({}), null);
  assert.equal(doblesDeLote({ dobles_total: 3 }), 3);
  assert.equal(doblesDeLote({}), null);
});

test("estadoDensidad decide si el lote se fue del objetivo", () => {
  const obj = { densidad: 16, tolerancia: 20 };
  assert.equal(estadoDensidad(16, obj).estado, "ok");
  // 12,8 es exactamente -20 %: el borde de la tolerancia entra
  assert.equal(estadoDensidad(12.8, obj).estado, "ok");
  assert.equal(estadoDensidad(19.2, obj).estado, "ok");
  assert.equal(estadoDensidad(12, obj).estado, "baja");
  assert.equal(estadoDensidad(21, obj).estado, "alta");
  // el desvío que se muestra en el chip
  assert.equal(Math.round(estadoDensidad(12, obj).desvio), -25);
  assert.equal(Math.round(estadoDensidad(20, obj).desvio), 25);
  // sembró cero: es una falla grave, no un "sin dato"
  assert.equal(estadoDensidad(0, obj).estado, "baja");
});

test("sin densidad o sin objetivo no se afirma nada", () => {
  const obj = { densidad: 16, tolerancia: 20 };
  assert.deepEqual(estadoDensidad(null, obj), { estado: "sin_dato", desvio: null });
  assert.deepEqual(estadoDensidad(undefined, obj), { estado: "sin_dato", desvio: null });
  assert.deepEqual(estadoDensidad(14, null), { estado: "sin_dato", desvio: null });
  assert.deepEqual(estadoDensidad(14, { densidad: 0, tolerancia: 20 }), { estado: "sin_dato", desvio: null });
  // tolerancia rota en el perfil: se cae a la de fábrica en vez de dividir por cero
  assert.equal(estadoDensidad(15, { densidad: 16, tolerancia: 0 }).estado, "ok");
});

test("alertasActivas se queda con las que siguen abiertas", () => {
  const lista = [
    { mensaje: "Surco 4 tapado", ts: 3 },
    { mensaje: "Surco 1 tapado", ts: 2, resuelta: true },
    { mensaje: "Tolva baja", ts: 1, resuelto: true },
  ];
  assert.deepEqual(alertasActivas(lista).map((a) => a.mensaje), ["Surco 4 tapado"]);
  // el endpoint devuelve [] cuando no hay docs vistax_alertas
  assert.deepEqual(alertasActivas([]), []);
  assert.deepEqual(alertasActivas(null), []);
  assert.deepEqual(alertasActivas({ error: "boom" }), []);
  assert.deepEqual(alertasActivas([null, undefined, "x"]), []);
});

test("textoAlerta siempre da algo que mostrar", () => {
  assert.equal(textoAlerta({ mensaje: "Surco 4 tapado" }), "Surco 4 tapado");
  assert.equal(textoAlerta({ texto: "Tolva baja" }), "Tolva baja");
  assert.equal(textoAlerta({}), "Alerta de siembra");
  assert.equal(textoAlerta(null), "Alerta de siembra");
});

test("resumenSiembra con el establecimiento vacío — el caso de hoy en producción", () => {
  const r = resumenSiembra({ lotes: [], alertas: [], objetivo: null });
  assert.equal(r.hay, false);
  assert.equal(r.total, 0);
  assert.equal(r.ultimo, null);
  assert.equal(r.ultimoTs, null);
  assert.equal(r.fueraDeRango, 0);
  assert.deepEqual(r.alertas, []);
  // ni siquiera llamado con argumentos debe romper
  const vacio = resumenSiembra();
  assert.equal(vacio.hay, false);
  assert.equal(vacio.ultimo, null);
});

test("resumenSiembra elige el último trabajo y cuenta lo que se fue de rango", () => {
  const lotes = [
    { lote_id: "l1", nombre: "La Loma", startTs: 1000, densidad: 16 },
    { lote_id: "l2", nombre: "El Bajo", startTs: 5000, densidad: 11 },
    { lote_id: "l3", nombre: "Sin medir", startTs: 2000 },
  ];
  const objetivo = objetivoSiembra(PERFIL);
  const r = resumenSiembra({ lotes, alertas: [{ mensaje: "Surco 4" }], objetivo });
  assert.equal(r.hay, true);
  assert.equal(r.total, 3);
  assert.equal(r.ultimo.nombre, "El Bajo");
  assert.equal(r.ultimoTs, 5000);
  assert.equal(r.alertas.length, 1);
  // solo El Bajo (11 vs 16 = -31 %); el que no tiene densidad NO se cuenta
  assert.equal(r.fueraDeRango, 1);
});

test("resumenSiembra sin perfil no marca ningún lote fuera de rango", () => {
  const lotes = [{ lote_id: "l1", startTs: 1, densidad: 3 }];
  assert.equal(resumenSiembra({ lotes, alertas: [], objetivo: null }).fueraDeRango, 0);
});

test("motivoVacio explica en castellano por qué no hay nada", () => {
  assert.match(motivoVacio({ status: 403 }), /permiso/i);
  assert.match(motivoVacio({ status: 404 }), /Todavía no hay datos de siembra/i);
  assert.match(motivoVacio({ status: 401 }), /sesión/i);
  assert.match(motivoVacio({ status: 500 }), /servidor/i);
  assert.match(motivoVacio({ status: 502 }), /servidor/i);
  assert.match(motivoVacio({ name: "ErrorSinDatos", message: "Sin conexión y sin datos guardados para /x" }), /Sin conexión/i);
  // un error cualquiera conserva su mensaje antes que quedar mudo
  assert.equal(motivoVacio({ message: "Falló la red" }), "Falló la red");
  assert.match(motivoVacio(null), /No se pudieron leer los datos de siembra/);
  assert.match(motivoVacio({}), /No se pudieron leer los datos de siembra/);
});

// ── Smoke del render ────────────────────────────────────────
// montar() no toca el DOM más que para setear innerHTML, así que alcanza con
// un root y un window de mentira. Lo que se prueba acá es que los tres caminos
// que puede tomar la pantalla —vacío, con lotes, y el endpoint caído— dibujen
// algo y no exploten, porque el vacío es el estado que hoy ve todo el mundo.
function falsoRoot() {
  return { html: "", clases: [], classList: { add(c) { this.clases ??= []; } }, set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; } };
}
function falsoCtx(respuestas) {
  return {
    usuario: { org_activa: "las-gringas" },
    nav: { setOffline() {}, setBadge() {} },
    api: {
      async get(ruta) {
        const r = respuestas[Object.keys(respuestas).find((k) => ruta.startsWith(k))];
        if (r === undefined) { const e = new Error("HTTP 404"); e.status = 404; throw e; }
        if (r instanceof Error) throw r;
        return { data: r, desdeCache: false, ts: Date.now() };
      },
    },
  };
}
// Monta, desmonta y devuelve el HTML dibujado. El desmontar va acá adentro a
// propósito: si el timer de 60 s de la pantalla quedara vivo, el runner de
// tests no terminaría nunca.
async function dibujar(ctx, root, loteId) {
  const previo = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const p = await montar(ctx, root, loteId);
    p.desmontar();
    return root.innerHTML;
  } finally { globalThis.window = previo; }
}

test("montar: sin datos de VistaX muestra el vacío explicado, no un error", async () => {
  const html = await dibujar(falsoCtx({ "/api/vistax/lotes": [] }), falsoRoot());
  assert.match(html, /Todavía no hay datos de siembra/);
  assert.match(html, /VistaX/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("montar: sin establecimiento activo pide elegir uno", async () => {
  const ctx = falsoCtx({}); ctx.usuario = {};
  assert.match(await dibujar(ctx, falsoRoot()), /Elegí un establecimiento/);
});

test("montar: el endpoint caído explica el motivo, no deja un spinner", async () => {
  const err = new Error("HTTP 403"); err.status = 403;
  assert.match(await dibujar(falsoCtx({ "/api/vistax/lotes": err }), falsoRoot()), /permiso/i);
});

test("montar: con lotes dibuja resumen, chip fuera de rango y links al detalle", async () => {
  const ctx = falsoCtx({
    "/api/vistax/lotes": [
      { lote_id: "lote_1", nombre: "El Bajo", cultivo: "Soja", startTs: 1758800000000, totalSemillas: 912345, densidad: 11 },
      { lote_id: "lote_2", nombre: "La Loma", startTs: 1758700000000 },
    ],
    "/api/vistax/perfil": PERFIL,
    "/api/vistax/alertas": [],
  });
  const html = await dibujar(ctx, falsoRoot());
  assert.match(html, /Último trabajo de siembra/);
  assert.match(html, /El Bajo/);
  assert.match(html, /pill warn/);          // densidad fuera del objetivo
  assert.match(html, /#\/siembra\/lote_1/); // se puede abrir el detalle
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("montar: un nombre de lote con HTML se escapa", async () => {
  const ctx = falsoCtx({ "/api/vistax/lotes": [{ lote_id: "l1", nombre: "<img src=x onerror=alert(1)>", startTs: 1 }] });
  const html = await dibujar(ctx, falsoRoot());
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("montar: el detalle de un lote sin archivos lo dice y ofrece volver", async () => {
  const html = await dibujar(falsoCtx({}), falsoRoot(), "lote_999");
  assert.match(html, /no tiene datos de siembra sincronizados/);
  assert.match(html, /#\/siembra/);
});

test("montar: el detalle muestra los datos que existen y no inventa los que faltan", async () => {
  const ctx = falsoCtx({
    "/api/vistax/lote/": { lote_id: "lote_1", meta: { nombre: "El Bajo", cultivo: "Soja", startTs: 1758800000000, totalSemillas: 912345, densidad: 11 }, densidad: { disponible: true }, semillas: null, alertas: null },
    "/api/vistax/perfil": PERFIL,
  });
  const html = await dibujar(ctx, falsoRoot(), "lote_1");
  assert.match(html, /El Bajo/);
  assert.match(html, /por debajo del objetivo/);
  assert.match(html, /Mapa de densidad/);
  // no llegó el GeoJSON de semillas: ese renglón no se dibuja
  assert.doesNotMatch(html, /Semillas georreferenciadas/);
  assert.doesNotMatch(html, /undefined|NaN/);
});
