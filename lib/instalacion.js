"use strict";
// Doc instalacion_<device_id> (orbitx_global): qué aprobó Agro Parallel para
// una pantalla (org, versión, kiosko), el avance que reporta el instalador y
// el último diagnóstico de red. Funciones puras + gdb inyectado (testeable).

const ESTADOS = ["aprobada", "instalando", "instalado", "fallo"];
const MAX_PASOS = 80;
const MAX_RED_BYTES = 16 * 1024;

const idInstalacion = (deviceId) => `instalacion_${deviceId}`;

function nuevaInstalacion({ device_id, estab_slug, version, kiosko, por, now, previo }) {
  return {
    _id: idInstalacion(device_id),
    ...(previo?._rev ? { _rev: previo._rev } : {}),
    tipo: "instalacion",
    device_id, estab_slug, version, kiosko: !!kiosko,
    estado: "aprobada",
    claves_entregadas: false, claves_entregadas_at: null,
    pasos: [], red: null,
    aprobado_por: por, created_at: now, updated_at: now,
  };
}

// Servidor/clave pública de RustDesk (no son secretos) + el binario más nuevo
// subido al OTA como producto "RustDesk". null si falta algo: el instalador
// sigue sin soporte remoto y lo anota.
async function perfilRustdesk(gdb, cfg) {
  const host = await cfg.get("INSTALADOR_RUSTDESK_HOST");
  const key  = await cfg.get("INSTALADOR_RUSTDESK_KEY");
  if (!host || !key) return null;
  const r = await gdb.find({ selector: { tipo: "firmware", producto: "RustDesk" } }).catch(() => ({ docs: [] }));
  const ult = elegirUltimo(r.docs || []);
  if (!ult) return null;
  return { host, key, version: ult.version, sha256: ult.hash_sha256 };
}

async function armarPerfil({ gdb, cfg, deviceId, now }) {
  const inst = await gdb.get(idInstalacion(deviceId)).catch(() => null);
  if (!inst) throw { status: 404, message: "Esta pantalla no tiene una instalación aprobada" };
  const fw = await gdb.get(`firmware_PilotX_${inst.version}`).catch(() => null);
  if (!fw) throw { status: 409, message: `PilotX ${inst.version} no está en el OTA` };
  const org = await gdb.get(`org_${inst.estab_slug}`).catch(() => null);

  const perfil = {
    cliente: org?.nombre || inst.estab_slug,
    cuit: org?.cuit || "",
    estab_slug: inst.estab_slug,
    version: inst.version,
    sha256: fw.hash_sha256,
    tamano_bytes: fw.tamano_bytes,
    kiosko: !!inst.kiosko,
    rustdesk: await perfilRustdesk(gdb, cfg),
  };

  if (!inst.claves_entregadas) {
    const soporte = await cfg.get("INSTALADOR_SOPORTE_PASS");
    if (!soporte) throw { status: 503, message: "Falta INSTALADOR_SOPORTE_PASS en Configuración del sistema" };
    perfil.soporte_pass = soporte;
    perfil.rustdesk_pass = (await cfg.get("INSTALADOR_RUSTDESK_PASS")) || soporte;
    // Se marca ANTES de responder: si la respuesta se pierde, la pantalla
    // reintenta sin claves y el técnico las regenera re-aprobando.
    inst.claves_entregadas = true;
    inst.claves_entregadas_at = now;
    inst.updated_at = now;
    await gdb.insert(inst);
  }
  return perfil;
}

function agregarPaso(inst, { paso, msg, estado }, now) {
  inst.pasos = inst.pasos || [];
  inst.pasos.push({ t: now, paso: String(paso || "").slice(0, 40), msg: String(msg || "").slice(0, 300) });
  if (inst.pasos.length > MAX_PASOS) inst.pasos.splice(0, inst.pasos.length - MAX_PASOS);
  if (ESTADOS.includes(estado)) inst.estado = estado;
  inst.updated_at = now;
  return inst;
}

function guardarRed(inst, diag, now) {
  if (Buffer.byteLength(JSON.stringify(diag ?? null)) > MAX_RED_BYTES)
    throw { status: 413, message: "Diagnóstico de red demasiado grande" };
  inst.red = { ts: now, diag };
  inst.updated_at = now;
  return inst;
}

function elegirUltimo(docs) {
  if (!Array.isArray(docs) || !docs.length) return null;
  return [...docs].sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
}

module.exports = { ESTADOS, idInstalacion, nuevaInstalacion, armarPerfil, agregarPaso, guardarRed, elegirUltimo };
