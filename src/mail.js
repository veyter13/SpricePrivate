'use strict';

/**
 * Отправка писем с кодом подтверждения.
 *
 * Три режима, выбираются по переменным окружения (в порядке приоритета):
 *   1. RESEND_API_KEY  — HTTP API Resend, ничего ставить не надо, 3000 писем/мес бесплатно;
 *   2. SMTP_HOST       — обычный SMTP (Gmail app password, Brevo, Mailgun, свой сервер);
 *   3. ничего не задано — DEV-режим: письмо не уходит, код печатается в консоль сервера.
 *
 * DEV-режим сделан специально: локально почту настраивать не нужно, код видно в терминале.
 */

const nodemailer = require('nodemailer');

// Отправитель. Gmail (и большинство SMTP) требует, чтобы адрес в From совпадал
// с логином — иначе письмо уйдёт в спам или будет отклонено. Поэтому если
// MAIL_FROM не задан, берём его из SMTP_USER: меньше полей для настройки.
const FROM =
  process.env.MAIL_FROM ||
  (process.env.SMTP_USER
    ? 'Sprice Private <' + process.env.SMTP_USER + '>'
    : 'Sprice Private <no-reply@sprice.local>');
const REPLY_TO = process.env.MAIL_REPLY_TO || '';
const SITE = process.env.SITE_URL || 'https://spriceprivate.onrender.com';

let transporter = null;
let mode = 'dev';

function init() {
  if (process.env.RESEND_API_KEY) {
    mode = 'resend';
  } else if (process.env.SMTP_HOST) {
    mode = 'smtp';
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '') === 'true' || Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000
    });
  } else {
    mode = 'dev';
  }
  console.log('[mail] режим: ' + mode + (mode === 'dev' ? ' (письма не уходят, код печатается здесь)' : ''));
  return mode;
}

/* ─────────────────────────── тексты писем ─────────────────────────── */

const TEXT = {
  verify: {
    ru: {
      subject: 'Код подтверждения — Sprice Private',
      title: 'Подтверждение почты',
      lead: (n) => `Привет, ${n}! Введи этот код на сайте, чтобы активировать аккаунт.`,
      note: 'Если ты не регистрировался на Sprice Private — просто проигнорируй это письмо.'
    },
    en: {
      subject: 'Confirmation code — Sprice Private',
      title: 'Confirm your email',
      lead: (n) => `Hi ${n}! Enter this code on the site to activate your account.`,
      note: 'If you did not sign up for Sprice Private, just ignore this email.'
    }
  },
  reset: {
    ru: {
      subject: 'Сброс пароля — Sprice Private',
      title: 'Сброс пароля',
      lead: (n) => `Привет, ${n}! Введи этот код, чтобы задать новый пароль.`,
      note: 'Если ты не запрашивал сброс — проигнорируй письмо, пароль останется прежним.'
    },
    en: {
      subject: 'Password reset — Sprice Private',
      title: 'Reset your password',
      lead: (n) => `Hi ${n}! Enter this code to set a new password.`,
      note: 'If you did not request a reset, ignore this email — your password stays the same.'
    }
  }
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Письмо в стиле сайта: тёмный фон, градиент, код крупной моноширинной строкой */
function htmlTemplate({ title, lead, code, note, minutes }) {
  const digits = String(code).split('').map((d) =>
    `<span style="display:inline-block;width:44px;height:56px;line-height:56px;margin:0 4px;`
    + `background:#16161f;border:1px solid #2a2a3a;border-radius:12px;`
    + `font:700 28px/56px 'Courier New',monospace;color:#fff;text-align:center">${escapeHtml(d)}</span>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b0b10;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b10;padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#101018;border:1px solid #23232f;border-radius:18px;overflow:hidden">
        <tr><td style="height:4px;background:linear-gradient(90deg,#7c5cff,#c14bff,#ff4b8b)"></td></tr>
        <tr><td style="padding:32px 32px 8px">
          <div style="font:800 20px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;letter-spacing:-.4px">Sprice Private</div>
        </td></tr>
        <tr><td style="padding:8px 32px 0">
          <h1 style="margin:0 0 10px;font:700 24px/1.25 -apple-system,Segoe UI,Roboto,sans-serif;color:#fff">${escapeHtml(title)}</h1>
          <p style="margin:0;font:400 15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#9a9aae">${escapeHtml(lead)}</p>
        </td></tr>
        <tr><td align="center" style="padding:26px 32px 6px">${digits}</td></tr>
        <tr><td align="center" style="padding:0 32px 24px">
          <p style="margin:0;font:400 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#6f6f85">${
            minutes ? `Код действует ${escapeHtml(String(minutes))} минут.` : ''
          }</p>
        </td></tr>
        <tr><td style="padding:0 32px 28px">
          <div style="height:1px;background:#23232f;margin-bottom:18px"></div>
          <p style="margin:0 0 16px;font:400 13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#6f6f85">${escapeHtml(note)}</p>
          <a href="${escapeHtml(SITE)}" style="display:inline-block;padding:11px 20px;border-radius:11px;background:linear-gradient(90deg,#7c5cff,#c14bff);color:#fff;text-decoration:none;font:600 14px/1 -apple-system,Segoe UI,Roboto,sans-serif">Открыть сайт</a>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font:400 12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#4a4a5c">
        © 2026 Sprice Private · Это письмо отправлено автоматически
      </p>
    </td></tr>
  </table>
</body></html>`;
}

/* ─────────────────────────── отправка ─────────────────────────── */

async function sendCode({ to, nickname, code, purpose = 'verify', locale = 'ru' }) {
  const pack = (TEXT[purpose] || TEXT.verify)[locale] || (TEXT[purpose] || TEXT.verify).ru;
  const subject = pack.subject;
  const html = htmlTemplate({
    title: pack.title,
    lead: pack.lead(nickname || to),
    code,
    note: pack.note,
    minutes: Number(process.env.CODE_TTL_MINUTES || 10)
  });
  const text = `${pack.title}\n\n${pack.lead(nickname || to)}\n\nКод: ${code}\n\n${pack.note}\n${SITE}`;

  if (mode === 'dev') {
    console.log('\n' + '─'.repeat(56));
    console.log('  DEV-режим почты: письмо НЕ отправлено');
    console.log('  кому: ' + to);
    console.log('  тема: ' + subject);
    console.log('  КОД: ' + code);
    console.log('─'.repeat(56) + '\n');
    return { ok: true, dev: true, code };
  }

  if (mode === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        html,
        text,
        ...(REPLY_TO ? { reply_to: REPLY_TO } : {})
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Resend ' + res.status + ': ' + body.slice(0, 300));
    }
    return { ok: true, id: (await res.json().catch(() => ({}))).id };
  }

  const info = await transporter.sendMail({
    from: FROM,
    to,
    subject,
    html,
    text,
    ...(REPLY_TO ? { replyTo: REPLY_TO } : {})
  });
  return { ok: true, id: info.messageId };
}

module.exports = { init, sendCode, getMode: () => mode };
