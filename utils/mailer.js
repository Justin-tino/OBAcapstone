/**
 * utils/mailer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single entry point for all outgoing mail (signup OTP, password reset link,
 * backup-download OTP).
 *
 * Transport order:
 *   1. Brevo HTTP API  — used whenever BREVO_API_KEY is set. This is the
 *      primary and recommended transport, because it is plain HTTPS on :443,
 *      which every PaaS host allows. Gmail's SMTP server on :587 is NOT
 *      reachable from Railway/Render/Fly: the TCP connection is silently
 *      dropped and nodemailer sits there until `connectionTimeout` fires,
 *      which is why OTP delivery failed in production while working locally.
 *   2. SMTP (nodemailer) — fallback when no Brevo key is configured, so local
 *      development keeps working with ordinary Gmail credentials.
 *
 * Why the transport is always logged: the old code reported success whenever
 * SMTP answered "250 accepted", even though a message sent with a non-canonical
 * `From:` address is then dropped before delivery. That produced "OTP sent"
 * with nothing in the inbox and no trace anywhere. Every send now prints the
 * transport and provider message id, so a missing email is always traceable.
 *
 * Usage:
 *   const { sendMail, transportName } = require('../utils/mailer');
 *   await sendMail({ to, toName, subject, text, html });
 *
 * Throws on failure with `err.transport`, `err.code` and `err.status` set, so
 * callers can distinguish a bad key (401/403) from an unverified sender (400)
 * or an exhausted daily quota (429).
 */
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// Lazily created so nodemailer is only required when the SMTP fallback is
// actually taken — with Brevo configured, nodemailer is never loaded.
let smtpTransport = null;
let smtpInitFailed = null;

function brevoKey() {
  return (process.env.BREVO_API_KEY || '').trim();
}

/**
 * Brevo rejects any sender that has not been verified in the Brevo account.
 * BREVO_SENDER_EMAIL exists so that address can be set independently of the
 * SMTP login, but defaulting to EMAIL_USER keeps local dev zero-config.
 */
function senderEmail() {
  return (process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER || '').trim();
}

function fromName() {
  return (process.env.MAIL_FROM_NAME || 'OBA System').trim();
}

/** Which transport a send would use right now — for diagnostics and /api/health. */
function transportName() {
  return brevoKey() ? 'brevo' : 'smtp';
}

/**
 * True when a transport is actually usable. The SMTP fallback additionally needs
 * EMAIL_USER + EMAIL_PASS; Brevo only needs the API key plus a sender address.
 * Callers use this to decide between "send an email" and "log the code so local
 * testing still works" — it must not be keyed on EMAIL_USER alone, because with
 * Brevo configured EMAIL_USER may legitimately be absent.
 */
function isConfigured() {
  if (brevoKey()) return Boolean(senderEmail());
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

/**
 * Brevo's transactional endpoint. Returns the parsed body on 2xx.
 * Throws an annotated Error otherwise.
 */
async function sendViaBrevo({ to, toName, subject, text, html }) {
  const from = senderEmail();
  if (!from) {
    const err = new Error('Brevo selected but no sender address is configured (set BREVO_SENDER_EMAIL or EMAIL_USER).');
    err.transport = 'brevo';
    err.code = 'ENOSENDER';
    throw err;
  }

  const res = await fetch(BREVO_ENDPOINT, {
    method: 'POST',
    headers: {
      'api-key': brevoKey(),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: fromName(), email: from },
      to: [{ email: to, name: toName || to }],
      subject,
      htmlContent: html || undefined,
      textContent: text || undefined,
    }),
  });

  const raw = await res.text();

  if (!res.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.message || parsed.code || raw;
    } catch (_) { /* non-JSON error body; keep the raw text */ }

    const err = new Error(`Brevo rejected the message (HTTP ${res.status}): ${detail}`);
    err.transport = 'brevo';
    err.code = 'EBREVO';
    err.status = res.status;
    // 429 means the account's daily send allowance is used up, which is a
    // completely different fix from a 401 bad key or a 400 unverified sender.
    if (res.status === 429) err.quota = true;
    throw err;
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

/** Nodemailer over SMTP — fallback path only. */
function getSmtpTransport() {
  if (smtpTransport) return smtpTransport;
  if (smtpInitFailed) throw smtpInitFailed;
  try {
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    return smtpTransport;
  } catch (err) {
    smtpInitFailed = new Error(
      'No Brevo key set and nodemailer could not be loaded for the SMTP fallback. ' +
      'Either set BREVO_API_KEY or install nodemailer. Cause: ' + err.message
    );
    smtpInitFailed.transport = 'smtp';
    smtpInitFailed.code = 'ENOTRANSPORT';
    throw smtpInitFailed;
  }
}

async function sendViaSmtp({ to, subject, text, html }) {
  const info = await getSmtpTransport().sendMail({
    from: `"${fromName()}" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
  return info;
}

/**
 * Send one message. Resolves only when a provider has accepted it.
 * @param {{to:string,toName?:string,subject:string,text?:string,html?:string}} opts
 */
async function sendMail(opts) {
  if (!opts || !opts.to) {
    const err = new Error('sendMail requires a `to` address.');
    err.code = 'ENO_RECIPIENT';
    throw err;
  }

  const via = transportName();

  if (via === 'brevo') {
    const info = await sendViaBrevo(opts);
    console.log(`[mail] brevo accepted -> ${opts.to} (messageId ${info.messageId || 'n/a'})`);
    return { transport: 'brevo', messageId: info.messageId || null };
  }

  const info = await sendViaSmtp(opts);
  console.log(`[mail] smtp accepted -> ${opts.to} (messageId ${info.messageId || 'n/a'})`);
  return { transport: 'smtp', messageId: info.messageId || null };
}

module.exports = { sendMail, transportName, isConfigured };
