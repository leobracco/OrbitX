// scripts/crear_superadmin.js  v2
require("dotenv").config();
const nano   = require("nano");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const COUCH_URL = process.env.COUCHDB_URL || "http://admin:password@localhost:5984";

const EMAIL    = "TuEm,ilio";
const PASSWORD = "Tu pass?";
const NOMBRE   = "Nom,bre.";

async function main() {
  const couch = nano(COUCH_URL);

  try {
    const info = await couch.info();
    console.log("✓ CouchDB", info.version, "conectado");
  } catch (e) {
    console.error("✗ No se pudo conectar:", e.message);
    process.exit(1);
  }

  try {
    await couch.db.create("orbitx_global");
    console.log("✓ DB orbitx_global creada");
  } catch (e) {
    if (e.error === "file_exists") console.log("✓ DB ya existe");
    else { console.error("✗", e.message); process.exit(1); }
  }

  const db = couch.db.use("orbitx_global");
  const all = await db.list({ include_docs: true });
  const docs = all.rows.map(r => r.doc);
  console.log(`Docs en DB: ${docs.length}`);

  // Si ya existe con ese email: actualizar contraseña
  const existe = docs.find(d => d.tipo === "usuario" && d.email === EMAIL);
  if (existe) {
    console.log(`\n Usuario ya existe: ${existe._id}`);
    const hash = await bcrypt.hash(PASSWORD, 12);
    await db.insert({ ...existe, password_hash: hash, activo: true, updated_at: Date.now() });
    console.log("✓ Contraseña actualizada");
    done(); return;
  }

  // Design doc
  const DD = {
    _id: "_design/auth",
    views: {
      usuario_por_email: { map: `function(doc){ if(doc.tipo==='usuario'&&doc.email) emit(doc.email,null); }` },
      membresias_por_uid: { map: `function(doc){ if(doc.tipo==='membresia'&&doc.activa) emit(doc.uid,{orgSlug:doc.orgSlug,rol:doc.rol}); }` },
      miembros_por_org: { map: `function(doc){ if(doc.tipo==='membresia'&&doc.activa) emit(doc.orgSlug,{uid:doc.uid,rol:doc.rol}); }` }
    }
  };
  try {
    const ex = await db.get("_design/auth");
    await db.insert({ ...DD, _rev: ex._rev });
    console.log("✓ _design/auth actualizado");
  } catch(e) {
    if (e.error === "not_found") { await db.insert(DD); console.log("✓ _design/auth creado"); }
    else throw e;
  }

  const uid  = "superadmin_" + crypto.randomBytes(6).toString("hex");
  const hash = await bcrypt.hash(PASSWORD, 12);
  const now  = Date.now();

  await db.insert({
    _id: `usr_${uid}`, tipo: "usuario",
    nombre: NOMBRE, email: EMAIL, password_hash: hash,
    avatar_initials: NOMBRE.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase(),
    telefono: "", rol_global: "superadmin",
    email_verificado: true, activo: true, bloqueado: false,
    notificaciones: { push_token:null, push_tokens:[], alertas_criticas:true, resumen_diario:true, cierre_lote:true, hora_resumen:"19:00" },
    prefs: { idioma:"es", tema:"dark", org_activa:null },
    ultimo_login: null, login_count: 0, reset_token: null, reset_token_exp: null,
    created_at: now, updated_at: now
  });

  const ok = await bcrypt.compare(PASSWORD, hash);
  console.log(`✓ Superadmin creado: usr_${uid}`);
  console.log(`✓ Verificación bcrypt: ${ok ? "OK" : "FALLÓ"}`);
  done();
}

function done() {
  console.log("\n════════════════════════════════════");
  console.log("  Email:     ", EMAIL);
  console.log("  Password:  ", PASSWORD);
  console.log("  Login:      http://localhost:" + (process.env.PORT||4000) + "/login");
  console.log("════════════════════════════════════\n");
}

main().catch(e => { console.error("✗", e.message); process.exit(1); });
