import { test } from "node:test";
import assert from "node:assert/strict";
import tok from "../../services/tokens_org.js";

const { generarToken, hashToken, prefijoDe, evaluarToken, esSoloLectura, rutaProhibida } = tok;

test("generarToken: prefijo orbx_ y 40 chars de aleatorio url-safe", () => {
  const t = generarToken();
  assert.ok(t.startsWith("orbx_"));
  assert.equal(t.length, 45);                     // "orbx_" (5) + 40
  assert.match(t.slice(5), /^[A-Za-z0-9_-]{40}$/);
  assert.notEqual(generarToken(), generarToken()); // no se repite
});

test("hashToken: sha256 hex estable y distinto por token", () => {
  const h = hashToken("orbx_abc");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashToken("orbx_abc"));
  assert.notEqual(h, hashToken("orbx_abd"));
});

test("prefijoDe: orbx_ + 8 caracteres, lo único visible después de crearlo", () => {
  assert.equal(prefijoDe("orbx_ABCDEFGHIJKLMNOP"), "orbx_ABCDEFGH");
  assert.equal(prefijoDe("").length, 0);
});

test("evaluarToken: casos de borde de vencimiento y revocación", () => {
  const ahora = 1_700_000_000_000;
  assert.deepEqual(evaluarToken(null, ahora), { valido: false, motivo: "no_encontrado" });
  assert.deepEqual(evaluarToken({ revocado: true, vence_ts: null }, ahora), { valido: false, motivo: "revocado" });
  assert.deepEqual(evaluarToken({ revocado: false, vence_ts: ahora - 1 }, ahora), { valido: false, motivo: "vencido" });
  assert.deepEqual(evaluarToken({ revocado: false, vence_ts: ahora }, ahora), { valido: true, motivo: null });
  assert.deepEqual(evaluarToken({ revocado: false, vence_ts: null }, ahora), { valido: true, motivo: null });
  // Revocado Y vencido: manda revocado (es la acción explícita de una persona).
  assert.deepEqual(evaluarToken({ revocado: true, vence_ts: ahora - 1 }, ahora), { valido: false, motivo: "revocado" });
});

test("esSoloLectura: solo GET y HEAD", () => {
  assert.equal(esSoloLectura("GET"), true);
  assert.equal(esSoloLectura("HEAD"), true);
  for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get"]) assert.equal(esSoloLectura(m), false);
});

test("rutaProhibida: los endpoints que un token nunca toca, ni leyendo", () => {
  for (const u of ["/api/auth/me", "/api/admin/orgs", "/api/config-sistema", "/api/grupos", "/api/ota/catalogo", "/api/soporte/chat", "/api/tokens-org", "/api/crm/productos"])
    assert.equal(rutaProhibida(u), true, u);
  for (const u of ["/api/actividad/resumen", "/api/lotes", "/api/aog/mapa?lote=cid%201", "/api/reportes/temporada", "/api/lluvias"])
    assert.equal(rutaProhibida(u), false, u);
});
