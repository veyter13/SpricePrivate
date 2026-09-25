'use strict';

/**
 * Записать пароль приложения Google в .env — так пароль не нужно передавать в чат.
 *
 * Запуск:
 *   npm run mail:set-pass -- "abcd efgh ijkl mnop"
 *   npm run mail:set-pass -- abcdefghijklmnop
 *
 * Что делает:
 *  - убирает пробелы (Google показывает пароль группами по 4, в SMTP пробелы ломают логин);
 *  - проверяет форму (16 латинских букв/цифр) и предупреждает, если это похоже
 *    на обычный пароль от аккаунта — для SMTP он не подходит;
 *  - обновляет строку SMTP_PASS в .env, не трогая остальные настройки;
 *  - печатает маску, а не сам пароль.
 *
 * Сам пароль попадает только в .env (файл в .gitignore) и никуда больше.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

const args = process.argv.slice(2).filter((a) => a !== '--force');
const FORCE = process.argv.includes('--force');
const RAW = (args[0] || '').trim();

function mask(s) {
  if (!s) return '(пусто)';
  if (s.length <= 4) return '***';
  return s.slice(0, 2) + '*'.repeat(Math.max(3, s.length - 4)) + s.slice(-2) + '  (' + s.length + ' симв.)';
}

if (!RAW) {
  console.log(`
Записать пароль приложения Google в .env.

  npm run mail:set-pass -- "abcd efgh ijkl mnop"

Где взять: https://myaccount.google.com/apppasswords
Нужна включённая двухэтапная аутентификация — без неё раздел недоступен.
Пароль показывается один раз, группами по 4 символа. Копируй как есть,
пробелы скрипт уберёт сам.
`);
  process.exit(0);
}

const PASS = RAW.replace(/\s+/g, '');

// ── проверка формы ─────────────────────────────────────────────────────────
// notes — просто пояснения, они запись НЕ блокируют.
// problems — реальные признаки того, что это не пароль приложения.
const notes = [];
const problems = [];
if (RAW !== PASS) notes.push('пробелы убраны (в SMTP они ломают логин — так и надо)');
if (!/^[A-Za-z0-9]{16}$/.test(PASS)) {
  if (PASS.length !== 16) {
    problems.push(
      'длина ' + PASS.length + ' символов, а у пароля приложения Google ровно 16 — ' +
        'похоже, это обычный пароль от аккаунта, для SMTP он не подходит'
    );
  } else {
    problems.push('в пароле есть символы кроме латинских букв и цифр — Google таких не выдаёт');
  }
}

if (notes.length) notes.forEach((n) => console.log('    ' + n));

if (problems.length) {
  console.log('\n  ! Проверь пароль:');
  problems.forEach((p) => console.log('    ' + p));
  console.log('    получить: https://myaccount.google.com/apppasswords');
  if (!FORCE) {
    console.log('\nНичего не записал. Если уверен, что пароль верный — повтори с --force.\n');
    process.exitCode = 1;
    return;
  }
  console.log('\n    --force: записываю как есть.\n');
}

// ── запись в .env ──────────────────────────────────────────────────────────
let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
const line = 'SMTP_PASS=' + PASS;

if (/^SMTP_PASS=.*$/m.test(env)) {
  env = env.replace(/^SMTP_PASS=.*$/m, line);
  console.log('\n  \u2713 SMTP_PASS обновлён в .env');
} else {
  if (env && !env.endsWith('\n')) env += '\n';
  env += line + '\n';
  console.log('\n  \u2713 SMTP_PASS добавлен в .env');
}

fs.writeFileSync(ENV_PATH, env, 'utf8');

// ── итог ───────────────────────────────────────────────────────────────────
const get = (k) => {
  const m = env.match(new RegExp('^' + k + '=(.*)$', 'm'));
  return m ? m[1].trim() : '';
};
console.log('    пароль:      ' + mask(PASS));
console.log('    сервер:      ' + (get('SMTP_HOST') || '(не задан)') + ':' + (get('SMTP_PORT') || '587'));
console.log('    логин:       ' + (get('SMTP_USER') || '(не задан)'));
console.log('    отправитель: ' + (get('MAIL_FROM') || '(не задан)'));
console.log('\nПроверить:  npm run mail:check -- твой@адрес.почта\n');
