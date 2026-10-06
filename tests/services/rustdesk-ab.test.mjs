import { test } from "node:test";
import assert from "node:assert/strict";
import { puedeUsarAgenda, orgsVisibles, armarAgenda, colorTag } from "../../services/rustdesk_ab.js";

const orgs = [
  { slug: "el_susto", nombre: "El Susto" },
  { slug: "la_mariana", nombre: "La Mariana" },
];
const devices = [
  { device_id: "OX-1", nombre: "Gabriel Carrano", hostname: "CHINAMI", estab_slug: "el_susto", rustdesk_id: "485112824" },
  { device_id: "OX-2", nombre: "Pauny Mariana", hostname: "PC2", estab_slug: "la_mariana", rustdesk_id: "111222333" },
  { device_id: "OX-3", nombre: "Banco", hostname: "BANCO", estab_slug: null, rustdesk_id: "999888777" },
  { device_id: "OX-4", nombre: "Sin RustDesk", hostname: "PC4", estab_slug: "el_susto", rustdesk_id: null },
];

test("puedeUsarAgenda: superadmin siempre; owner/admin_org solo con membresía; el resto no", () => {
  assert.equal(puedeUsarAgenda("superadmin", []), true);
  assert.equal(puedeUsarAgenda("user", [{ orgSlug: "el_susto", rol: "owner" }]), true);
  assert.equal(puedeUsarAgenda("user", [{ orgSlug: "el_susto", rol: "admin_org" }]), true);
  assert.equal(puedeUsarAgenda("user", [{ orgSlug: "el_susto", rol: "operador" }]), false);
  assert.equal(puedeUsarAgenda("user", []), false);
});

test("orgsVisibles: superadmin → null (todas); owner → solo sus orgs con rol de admin", () => {
  assert.equal(orgsVisibles("superadmin", []), null);
  assert.deepEqual(
    orgsVisibles("user", [{ orgSlug: "el_susto", rol: "owner" }, { orgSlug: "la_mariana", rol: "viewer" }]),
    ["el_susto"]);
});

test("armarAgenda superadmin: todos los equipos con RustDesk, tag por establecimiento", () => {
  const ab = armarAgenda({ devices, orgs, visibles: null });
  assert.deepEqual(ab.peers.map(p => p.id).sort(), ["111222333", "485112824", "999888777"]);
  const carrano = ab.peers.find(p => p.id === "485112824");
  assert.equal(carrano.alias, "Gabriel Carrano");
  assert.equal(carrano.hostname, "CHINAMI");
  assert.equal(carrano.platform, "Windows");
  assert.deepEqual(carrano.tags, ["El Susto"]);
  assert.deepEqual(ab.peers.find(p => p.id === "999888777").tags, ["Sin asignar"]);
  assert.deepEqual(ab.tags, ["El Susto", "La Mariana", "Sin asignar"]);
  const colores = JSON.parse(ab.tag_colors);
  assert.equal(colores["El Susto"], colorTag("El Susto"));
});

test("armarAgenda owner: solo los equipos de sus establecimientos, sin los sin asignar", () => {
  const ab = armarAgenda({ devices, orgs, visibles: ["el_susto"] });
  assert.deepEqual(ab.peers.map(p => p.id), ["485112824"]);
  assert.deepEqual(ab.tags, ["El Susto"]);
});

test("armarAgenda: establecimiento sin doc de org usa el slug como tag", () => {
  const ab = armarAgenda({ devices: [{ ...devices[0], estab_slug: "nuevo_campo" }], orgs, visibles: null });
  assert.deepEqual(ab.peers[0].tags, ["nuevo_campo"]);
});

test("colorTag: ARGB opaco y estable", () => {
  const c = colorTag("El Susto");
  assert.equal(c, colorTag("El Susto"));
  assert.ok(c >= 0xFF000000 && c <= 0xFFFFFFFF);
});
