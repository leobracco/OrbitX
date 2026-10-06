// Agenda de RustDesk armada desde la base de OrbitX (lógica pura, sin I/O).
// La sirve routes/rustdesk.js con el formato legacy de /api/ab del cliente.
"use strict";

const ROLES_ADMIN = ["owner", "admin_org"];
const SIN_ASIGNAR = "Sin asignar";

function puedeUsarAgenda(rolGlobal, memberships = []) {
  if (rolGlobal === "superadmin") return true;
  return memberships.some(m => ROLES_ADMIN.includes(m.rol));
}

// null = sin filtro (superadmin ve todo)
function orgsVisibles(rolGlobal, memberships = []) {
  if (rolGlobal === "superadmin") return null;
  return memberships.filter(m => ROLES_ADMIN.includes(m.rol)).map(m => m.orgSlug);
}

// Color estable por nombre: el cliente espera ARGB como entero (siempre opaco).
function colorTag(nombre) {
  let h = 0;
  for (const ch of String(nombre)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = h % 360;
  const [r, g, b] = hslARgb(hue, 0.55, 0.45);
  return (0xFF000000 + (r << 16) + (g << 8) + b) >>> 0;
}

function hslARgb(h, s, l) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return [f(0), f(8), f(4)];
}

function armarAgenda({ devices, orgs, visibles }) {
  const nombreOrg = new Map(orgs.map(o => [o.slug, o.nombre || o.slug]));
  const peers = [];
  for (const d of devices) {
    if (!d.rustdesk_id) continue;
    const slug = d.estab_slug && d.estab_slug !== "unassigned" ? d.estab_slug : null;
    if (visibles && (!slug || !visibles.includes(slug))) continue;
    peers.push({
      id:       String(d.rustdesk_id),
      hash:     "",
      username: "",
      hostname: d.hostname || "",
      platform: "Windows",
      alias:    d.nombre || d.device_id || "",
      tags:     [slug ? (nombreOrg.get(slug) || slug) : SIN_ASIGNAR],
    });
  }
  peers.sort((a, b) => a.alias.localeCompare(b.alias, "es"));
  const tags = [...new Set(peers.flatMap(p => p.tags))].sort((a, b) => a.localeCompare(b, "es"));
  const tag_colors = JSON.stringify(Object.fromEntries(tags.map(t => [t, colorTag(t)])));
  return { tags, peers, tag_colors };
}

module.exports = { puedeUsarAgenda, orgsVisibles, armarAgenda, colorTag };
