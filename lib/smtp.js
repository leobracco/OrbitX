// lib/smtp.js — SMTP global del server (verificación de email + reset password).
// Las orgs configuran su propio SMTP en /integraciones (lib aparte).
"use strict";

const cfg = require("../services/config_sistema");

let nodemailer = null;
try { nodemailer = require("nodemailer"); }
catch { /* instalar con `npm install nodemailer` cuando quieran usarlo */ }

async function buildTransport() {
  if (!nodemailer) throw new Error("Falta instalar nodemailer (npm install nodemailer)");

  const host    = await cfg.get("SMTP_HOST");
  const port    = parseInt(await cfg.get("SMTP_PORT") || "587", 10);
  const secure  = (await cfg.get("SMTP_SECURE") || "false") === "true";
  const user    = await cfg.get("SMTP_USER");
  const pass    = await cfg.get("SMTP_PASS");

  if (!host || !user || !pass)
    throw new Error("SMTP global sin configurar — andá a /config");

  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
  });
}

async function sendMail({ to, subject, text, html }) {
  const transport = await buildTransport();
  const from      = await cfg.get("SMTP_FROM") || `Agro Parallel <${await cfg.get("SMTP_USER")}>`;
  const info = await transport.sendMail({ from, to, subject, text, html });
  return { ok: true, message_id: info.messageId };
}

module.exports = { sendMail };
