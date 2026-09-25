'use strict';

/**
 * Проверка настроек почты.
 *
 * Запуск:
 *   npm run mail:check                    — проверить, что логин принимается
 *   npm run mail:check -- mail@mail.ru    — ещё и отправить тестовое письмо
 *
 * Читает .env, поэтому пароль нигде не нужно вводить руками.
 * Пароль в вывод не попадает — печатается только маска.
 */

require('dotenv').config();

const nodemailer = require('nodemailer');

const TARGET = (process.argv[2] || '').trim();
const HOST = (process.env.SMTP_HOST || '').trim();
const PORT = Number(process.env.SMTP_PORT || 587);
const SECURE = String(process.env.SMTP_SECURE || '') === 'true' || PORT === 465;
const USER = (process.env.SMTP_USER || '').trim();
const PASS_RAW = process.env.SMTP_PASS || '';
// Google показывает пароль приложения группами по 4 («abcd efgh ijkl mnop»), его часто
// копируют с пробелами. В SMTP пробелы — часть пароля, поэтому убираем их так же,
// как это делает src/mail.js, иначе проверка разойдётся с реальной отправкой.
const PASS = PASS_RAW.replace(/\s+/g, '');
const RESEND = (process.env.RESEND_API_KEY || '').trim();
const FROM = process.env.MAIL_FROM || 'Sprice Private <no-reply@sprice.local>';

const ok = (s) => console.log('  \u2713 ' + s);
const bad = (s) => console.log('  \u2717 ' + s);
const warn = (s) => console.log('  ! ' + s);
const info = (s) => console.log('    ' + s);

function mask(s) {
  if (!s) return '(пусто)';
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '*'.repeat(Math.max(3, s.length - 4)) + s.slice(-2) + '  (' + s.length + ' симв.)';
}

/**
 * Предполётная проверка формы пароля — до сети. Позволяет сказать «это обычный пароль,
 * а не пароль приложения» сразу, а не после невнятного 535 от Google.
 * Возвращает массив предупреждений (пустой = придраться не к чему).
 */
function passHints() {
  const out = [];
  if (!PASS) return out;
  if (PASS_RAW !== PASS) {
    out.push('в SMTP_PASS были пробелы — они убраны (пароль приложения Google показывается группами по 4)');
  }
  if (/^[A-Za-z0-9]{16}$/.test(PASS)) return out;
  if (PASS.length < 16) {
    out.push('пароль короче 16 символов — у пароля приложения Google ровно 16 латинских букв и цифр,');
    out.push('а это, судя по длине, обычный пароль от аккаунта. Для SMTP он не подходит.');
  } else if (!/^[A-Za-z0-9]+$/.test(PASS)) {
    out.push('в пароле есть символы кроме латинских букв и цифр — пароль приложения Google их не содержит');
  } else {
    out.push('длина пароля ' + PASS.length + ' символов, а у пароля приложения Google ровно 16');
  }
  out.push('получить: https://myaccount.google.com/apppasswords (нужна включённая двухэтапная аутентификация)');
  return out;
}

/** Понятная расшифровка типовых отказов SMTP */
function explain(err) {
  const m = String(err.message || '');
  if (/535|Username and Password not accepted|Invalid login/i.test(m)) {
    return [
      'Google отклонил логин. Причины по частоте:',
      '  1. Это обычный пароль от аккаунта — для SMTP он не подходит.',
      '     Нужен «пароль приложения» (16 символов): https://myaccount.google.com/apppasswords',
      '     В аккаунте должна быть включена двухэтапная аутентификация, иначе раздел недоступен.',
      '  2. Пароль приложения скопирован с пробелами — Google показывает его группами по 4,',
      '     но в SMTP_PASS пробелы нужно убрать.',
      '  3. Пароль приложения отозван (Google отзывает старые, если создан новый).'
    ].join('\n');
  }
  if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|timeout/i.test(m)) {
    return [
      'Сеть не пускает к ' + HOST + ':' + PORT + '.',
      '  Проверь интернет и что провайдер/файрвол не блокирует исходящий SMTP.',
      '  Если это Render и порт 465 закрыт — попробуй SMTP_PORT=587, SMTP_SECURE=false.'
    ].join('\n');
  }
  return '';
}

(async () => {
  console.log('\n═══ Проверка почты ═══\n');

  if (RESEND) {
    ok('Задан RESEND_API_KEY — режим Resend (HTTP API), SMTP не используется');
    info('ключ: ' + mask(RESEND));
    info('адрес отправителя: ' + FROM);
    if (!TARGET) {
      console.log('\nУкажи адрес, чтобы отправить тестовое письмо: npm run mail:check -- mail@mail.ru\n');
      return;
    }
    await sendViaResend();
    return;
  }

  if (!HOST) {
    bad('Почта не настроена — включится DEV-режим');
    info('письма не уходят, код подтверждения печатается в логе сервера');
    info('задай SMTP_HOST + SMTP_USER + SMTP_PASS в .env, чтобы отправлять по-настоящему');
    console.log('');
    return;
  }

  console.log('Сервер:      ' + HOST + ':' + PORT + (SECURE ? '  (SSL)' : '  (STARTTLS)'));
  console.log('Логин:       ' + (USER || '(пусто)'));
  console.log('Пароль:      ' + mask(PASS));
  console.log('Отправитель: ' + FROM);
  console.log('');

  if (!USER || !PASS) {
    bad('Не задан SMTP_USER или SMTP_PASS — войти нечем');
    console.log('');
    process.exitCode = 1;
    return;
  }

  // Сначала придираемся к форме пароля — это дешевле, чем ловить 535 от Google.
  const hints = passHints();
  if (hints.length) {
    warn('пароль выглядит подозрительно:');
    hints.forEach(info);
    console.log('');
  }

  const t = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: { user: USER, pass: PASS },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000
  });

  console.log('1. Проверяю вход...');
  try {
    await t.verify();
    ok('сервер принял логин и пароль');
  } catch (e) {
    bad('войти не удалось: ' + String(e.message).split('\n')[0].slice(0, 200));
    const why = explain(e);
    if (why) console.log('\n' + why);
    console.log('');
    try { t.close(); } catch (_) {}
    process.exitCode = 1;
    return;
  }

  if (!TARGET) {
    console.log('\nЛогин рабочий. Хочешь проверить саму доставку — запусти:');
    console.log('  npm run mail:check -- mail@mail.ru\n');
    try { t.close(); } catch (_) {}
    return;
  }

  console.log('\n2. Отправляю тестовое письмо на ' + TARGET + '...');
  try {
    const r = await t.sendMail({
      from: FROM,
      to: TARGET,
      subject: 'Sprice Private — проверка почты',
      text: 'Это тестовое письмо. Если ты его видишь — почта настроена верно.',
      html:
        '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">' +
        '<p>Это тестовое письмо.</p>' +
        '<p>Если ты его видишь — почта настроена верно, и коды подтверждения будут доходить.</p>' +
        '</div>'
    });
    ok('письмо принято сервером');
    info('ответ: ' + (r.response || '').toString().split('\n')[0].slice(0, 160));
    info('не пришло за минуту — проверь папку «Спам»');
  } catch (e) {
    bad('отправить не удалось: ' + String(e.message).split('\n')[0].slice(0, 200));
    const why = explain(e);
    if (why) console.log('\n' + why);
    process.exitCode = 1;
  } finally {
    try { t.close(); } catch (_) {}
  }
  console.log('');
})();

async function sendViaResend() {
  console.log('\nОтправляю тестовое письмо на ' + TARGET + '...');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM,
        to: [TARGET],
        subject: 'Sprice Private — проверка почты',
        text: 'Это тестовое письмо. Если ты его видишь — почта настроена верно.'
      })
    });
    const body = await r.text();
    if (r.ok) {
      ok('письмо отправлено');
      info(body.slice(0, 200));
    } else {
      bad('Resend ответил ' + r.status + ': ' + body.slice(0, 300));
      if (r.status === 401) info('ключ неверный или отозван');
      if (r.status === 403) info('домен отправителя не подтверждён в Resend');
      process.exitCode = 1;
    }
  } catch (e) {
    bad('запрос не прошёл: ' + e.message);
    process.exitCode = 1;
  }
  console.log('');
}
