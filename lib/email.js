// lib/email.js — Plantillas de email transaccional para el flujo de auth.
// Usa el SMTP global configurado en /config (lib/smtp.js).
"use strict";

const smtp = require("./smtp");
const cfg  = require("../services/config_sistema");

const VERDE = "#A4BA3E";
const BG_DEEP = "#121618";
const BG = "#1A1F25";
const CARD = "#232830";
const BORDER = "#3D333B";
const TEXT = "#E6E6E6";
const MUTED = "#9AA3AD";

// Wrapper HTML compartido por todas las plantillas.
function layout({ titulo, cuerpo }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:${BG_DEEP};font-family:Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:${TEXT}">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BG_DEEP};padding:40px 20px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:${BG};border:1px solid ${BORDER};border-radius:12px;overflow:hidden">

        <!-- Header -->
        <tr><td style="padding:24px 28px;border-bottom:1px solid ${BORDER}">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td style="font-size:20px;font-weight:700;color:${TEXT};letter-spacing:-0.3px">
                Orbit<span style="color:${VERDE}">X</span>
              </td>
              <td style="text-align:right;font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:1.5px">
                Agro Parallel
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Cuerpo -->
        <tr><td style="padding:28px;line-height:1.7;font-size:14px;color:${TEXT}">
          ${cuerpo}
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 28px;border-top:1px solid ${BORDER};font-size:11px;color:${MUTED};line-height:1.6">
          Agro Parallel · OrbitX Cloud<br>
          Si este mail no era para vos, ignoralo y listo.
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function btn(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0">
    <tr><td style="background:${VERDE};border-radius:8px">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;color:${BG_DEEP};font-weight:700;text-decoration:none;font-size:13px">
        ${escapeHtml(label)}
      </a>
    </td></tr>
  </table>`;
}

async function getBaseUrl() {
  return (await cfg.get("BASE_URL")) || process.env.BASE_URL || "http://localhost:4000";
}

function tryEnviar(opts, contexto) {
  return smtp.sendMail(opts).catch(e => {
    console.warn(`[Email] ${contexto || ""} no se envió:`, e.message);
    return { ok: false, error: e.message };
  });
}

// ── Registros ────────────────────────────────────────────────

async function enviarRegistroRecibido(user) {
  const cuerpo = `
    <h2 style="font-size:18px;color:${TEXT};margin:0 0 14px 0;font-weight:600">¡Hola ${escapeHtml((user.nombre || "").split(" ")[0])}!</h2>
    <p style="margin:0 0 12px 0">Recibimos tu solicitud para registrar <b style="color:${VERDE}">${escapeHtml(user.org_nombre || "tu establecimiento")}</b> en OrbitX.</p>
    <p style="margin:0 0 12px 0">Estamos revisando los datos del campo. En las próximas 24hs te confirmamos por mail cuando esté habilitado el acceso.</p>
    <p style="margin:0;color:${MUTED};font-size:12px">Si necesitás algo, respondé este mismo mail.</p>
  `;
  return tryEnviar({
    to:      user.email,
    subject: "Recibimos tu solicitud — OrbitX",
    html:    layout({ titulo: "Solicitud recibida", cuerpo }),
    text:    `Hola ${user.nombre}, recibimos tu solicitud para ${user.org_nombre}. Te confirmamos por mail en menos de 24 hs.`,
  }, "registro-recibido");
}

async function enviarRegistroAprobado(user, org) {
  const url = `${await getBaseUrl()}/login`;
  const cuerpo = `
    <h2 style="font-size:18px;color:${TEXT};margin:0 0 14px 0;font-weight:600">¡Bienvenido a OrbitX, ${escapeHtml((user.nombre || "").split(" ")[0])}!</h2>
    <p style="margin:0 0 12px 0">Tu cuenta de <b style="color:${VERDE}">${escapeHtml(org.nombre)}</b> ya está activa.</p>
    <p style="margin:0 0 6px 0">Entrá con tu email y la contraseña que elegiste al registrarte:</p>
    ${btn(url, "Ingresar al portal →")}
    <p style="margin:0;color:${MUTED};font-size:12px">Cualquier cosa, respondé este mail. Estamos para ayudarte.</p>
  `;
  return tryEnviar({
    to:      user.email,
    subject: "¡Tu cuenta de OrbitX está activa!",
    html:    layout({ titulo: "Cuenta activa", cuerpo }),
    text:    `Hola ${user.nombre}, tu cuenta de ${org.nombre} en OrbitX ya está activa. Ingresá en ${url}`,
  }, "registro-aprobado");
}

async function enviarRegistroRechazado(user, motivo) {
  const cuerpo = `
    <h2 style="font-size:18px;color:${TEXT};margin:0 0 14px 0;font-weight:600">Hola ${escapeHtml((user.nombre || "").split(" ")[0])},</h2>
    <p style="margin:0 0 12px 0">No pudimos aprobar tu solicitud para registrar <b>${escapeHtml(user.org_nombre)}</b>.</p>
    ${motivo ? `<p style="margin:0 0 12px 0;padding:12px 14px;background:${CARD};border-left:3px solid ${VERDE};border-radius:6px;color:${MUTED}"><b style="color:${TEXT}">Motivo:</b> ${escapeHtml(motivo)}</p>` : ""}
    <p style="margin:0;color:${MUTED};font-size:12px">Si pensás que fue un error, contestá este mail y lo revisamos.</p>
  `;
  return tryEnviar({
    to:      user.email,
    subject: "Sobre tu solicitud en OrbitX",
    html:    layout({ titulo: "Solicitud no aprobada", cuerpo }),
    text:    `Hola ${user.nombre}, no pudimos aprobar tu solicitud. ${motivo || ""}`,
  }, "registro-rechazado");
}

// ── Invitaciones a org ───────────────────────────────────────

async function enviarInvitacion(invitacion) {
  const url = `${await getBaseUrl()}/invitacion/${invitacion.token}`;
  const horas = Math.round((invitacion.expira_at - Date.now()) / 3600000);
  const cuerpo = `
    <h2 style="font-size:18px;color:${TEXT};margin:0 0 14px 0;font-weight:600">Te invitaron a ${escapeHtml(invitacion.orgNombre)}</h2>
    <p style="margin:0 0 12px 0"><b>${escapeHtml(invitacion.invitado_por_nombre || "Un admin")}</b> te sumó como <b style="color:${VERDE}">${escapeHtml(invitacion.rol_asignado)}</b> en OrbitX.</p>
    ${btn(url, "Aceptar invitación →")}
    <p style="margin:12px 0 0 0;color:${MUTED};font-size:12px">El link vence en ${horas}hs.</p>
  `;
  return tryEnviar({
    to:      invitacion.email_destino,
    subject: `Te invitaron a ${invitacion.orgNombre} — OrbitX`,
    html:    layout({ titulo: "Invitación", cuerpo }),
    text:    `Te invitaron a ${invitacion.orgNombre} como ${invitacion.rol_asignado}. Aceptá en: ${url}`,
  }, "invitacion");
}

// ── Reset password ───────────────────────────────────────────

async function enviarResetPassword(user, token) {
  const url = `${await getBaseUrl()}/reset-password/${token}`;
  const cuerpo = `
    <h2 style="font-size:18px;color:${TEXT};margin:0 0 14px 0;font-weight:600">Hola ${escapeHtml((user.nombre || "").split(" ")[0])}</h2>
    <p style="margin:0 0 12px 0">Recibimos un pedido para resetear la contraseña de tu cuenta en OrbitX. Si fuiste vos, hacé click acá:</p>
    ${btn(url, "Cambiar contraseña →")}
    <p style="margin:12px 0 0 0;color:${MUTED};font-size:12px">El link vence en 1 hora. Si no fuiste vos, ignorá este mail — tu contraseña actual sigue siendo la misma.</p>
  `;
  return tryEnviar({
    to:      user.email,
    subject: "Recuperar tu contraseña — OrbitX",
    html:    layout({ titulo: "Reset password", cuerpo }),
    text:    `Hola, cambiá tu contraseña en: ${url} (vence en 1 hora)`,
  }, "reset-password");
}

module.exports = {
  enviarRegistroRecibido,
  enviarRegistroAprobado,
  enviarRegistroRechazado,
  enviarInvitacion,
  enviarResetPassword,
};
