import { test } from "node:test";
import assert from "node:assert/strict";
import { pestanasPara, pantallasPara, puedeVer, PESTANAS } from "../../app/core/permisos.js";

const TODAS = ["inicio", "mapa", "lotes", "siembra", "lluvias", "alertas", "equipos"];

test("roles con dispositivos ven todas las pestañas", () => {
  for (const rol of ["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador", "member"])
    assert.deepEqual(pestanasPara(rol), TODAS, rol);
});

test("viewer no ve Equipos (dispositivos: [])", () => {
  assert.deepEqual(pestanasPara("viewer"), ["inicio", "mapa", "lotes", "siembra", "lluvias", "alertas"]);
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

test("el chat es una pantalla válida sin ocupar pestaña en la barra", () => {
  // Se abre desde el ícono de arriba: si no estuviera en pantallasPara, el
  // router lo rebotaría a inicio; si estuviera en pestanasPara, sería la octava
  // pestaña de la barra de abajo y no entra en un celular.
  for (const rol of ["superadmin", "owner", "admin_org", "agronomo", "contratista", "operador", "member"]) {
    assert.ok(pantallasPara(rol).includes("chat"), rol);
    assert.ok(!pestanasPara(rol).includes("chat"), rol);
  }
});

test("viewer no llega al chat: no tiene lectura de dispositivos", () => {
  assert.ok(!pantallasPara("viewer").includes("chat"));
  assert.deepEqual(pantallasPara("viewer"), pestanasPara("viewer"));
});

test("pantallasPara incluye todas las pestañas del rol", () => {
  for (const rol of ["superadmin", "viewer", "cualquiera"])
    for (const p of pestanasPara(rol)) assert.ok(pantallasPara(rol).includes(p), `${rol}/${p}`);
});
