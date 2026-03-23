// scripts/debug_auth.js — Diagnóstico completo del sistema de auth
require("dotenv").config();
const nano   = require("nano");
const bcrypt = require("bcryptjs");

const COUCH_URL = process.env.COUCHDB_URL || "http://admin:password@localhost:5984";
const EMAIL_TEST = process.argv[2]; // node debug_auth.js tu@email.com

async function main() {
  const couch = nano(COUCH_URL);
  const db    = couch.db.use("orbitx_global");

  console.log("\n🔍 OrbitX Auth Debugger\n");

  // ── 1. Listar TODOS los documentos ──────────────────────
  console.log("── Documentos en orbitx_global ──────────────────");
  try {
    const all = await db.list({ include_docs: true });
    console.log(`Total docs: ${all.rows.length}\n`);
    for (const row of all.rows) {
      const d = row.doc;
      if (d._id.startsWith("_design")) {
        console.log(`  [design] ${d._id}`);
        continue;
      }
      const tipo = d.tipo || "sin-tipo";
      console.log(`  [${tipo}] ${d._id}`);
      if (tipo === "usuario") {
        console.log(`           email: ${d.email}`);
        console.log(`           rol:   ${d.rol_global}`);
        console.log(`           activo:${d.activo}`);
        console.log(`           hash:  ${d.password_hash ? d.password_hash.slice(0,20)+"..." : "NINGUNO"}`);
      }
    }
  } catch (e) {
    console.log("  ERROR listando docs:", e.message);
  }

  if (!EMAIL_TEST) {
    console.log("\n💡 Para testear un email específico:");
    console.log("   node scripts/debug_auth.js tu@email.com contraseña\n");
    return;
  }

  const PASSWORD_TEST = process.argv[3] || "";

  // ── 2. Buscar usuario por Mango find ────────────────────
  console.log(`\n── Buscar con db.find() → email: ${EMAIL_TEST} ──`);
  try {
    const r = await db.find({ selector: { tipo: "usuario", email: EMAIL_TEST } });
    if (r.docs.length === 0) {
      console.log("  ✗ No encontrado con Mango find");
    } else {
      console.log(`  ✓ Encontrado: ${r.docs[0]._id}`);
      const user = r.docs[0];
      if (PASSWORD_TEST) {
        const ok = await bcrypt.compare(PASSWORD_TEST, user.password_hash);
        console.log(`  Contraseña correcta: ${ok ? "✓ SÍ" : "✗ NO"}`);
      }
    }
  } catch (e) {
    console.log("  ERROR con find:", e.message);
  }

  // ── 3. Buscar con la vista CouchDB ────────────────────
  console.log(`\n── Buscar con vista auth/usuario_por_email ──`);
  try {
    const r = await db.view("auth", "usuario_por_email", {
      key: EMAIL_TEST, include_docs: true, reduce: false
    });
    if (r.rows.length === 0) {
      console.log("  ✗ No encontrado en la vista");
      console.log("  → La vista puede no estar actualizada o el design doc no existe");
    } else {
      console.log(`  ✓ Encontrado en vista: ${r.rows[0].doc._id}`);
      const user = r.rows[0].doc;
      if (PASSWORD_TEST) {
        const ok = await bcrypt.compare(PASSWORD_TEST, user.password_hash);
        console.log(`  Contraseña correcta: ${ok ? "✓ SÍ" : "✗ NO"}`);
      }
    }
  } catch (e) {
    console.log("  ERROR con vista:", e.message);
    if (e.message.includes("not_found")) {
      console.log("  → El design doc _design/auth no existe o la vista no está creada");
    }
  }

  // ── 4. Verificar design docs ─────────────────────────
  console.log(`\n── Design docs ──`);
  try {
    const dd = await db.get("_design/auth");
    console.log("  ✓ _design/auth existe");
    console.log("  Vistas:", Object.keys(dd.views || {}).join(", "));
  } catch (e) {
    console.log("  ✗ _design/auth NO existe — hay que recrearlo");
  }

  // ── 5. Verificar índices Mango ───────────────────────
  console.log(`\n── Índices Mango ──`);
  try {
    const idx = await db.getIndexes();
    idx.indexes.forEach(i => {
      if (i.type !== "special") console.log(`  [${i.type}] ${i.name}: ${JSON.stringify(i.def.fields)}`);
    });
  } catch (e) {
    console.log("  ERROR:", e.message);
  }

  console.log("\n");
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
