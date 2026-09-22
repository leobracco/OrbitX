import { test } from "node:test";
import assert from "node:assert/strict";
import { pestanasPara, puedeVer, PESTANAS } from "../../app/core/permisos.js";

const TODAS = ["mapa", "lotes", "lluvias", "alertas", "equipos"];

test("roles con dispositivos ven las cinco pestañas", () => {
  for (const rol of ["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador", "member"])
    assert.deepEqual(pestanasPara(rol), TODAS, rol);
});

test("viewer no ve Equipos (dispositivos: [])", () => {
  assert.deepEqual(pestanasPara("viewer"), ["mapa", "lotes", "lluvias", "alertas"]);
});

test("rol desconocido o vacío cae al mínimo de viewer", () => {
  assert.deepEqual(pestanasPara(undefined), pestanasPara("viewer"));
  assert.deepEqual(pestanasPara("cualquiera"), pestanasPara("viewer"));
});

test("puedeVer y PESTANAS son consistentes", () => {
  assert.deepEqual(PESTANAS, TODAS);
  assert.equal(puedeVer("viewer", "equipos"), false);
  assert.equal(puedeVer("owner", "equipos"), true);
});
