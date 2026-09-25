'use strict';

/**
 * Пароли, коды подтверждения, сессионные токены.
 *
 * Пароли — scrypt из встроенного node:crypto. Осознанно НЕ bcrypt:
 * у bcryptjs/argon2 нативная сборка, а на Render это лишний риск при деплое.
 * scrypt встроен в Node и не требует компиляции.
 *
 * Коды подтверждения хешируются HMAC-SHA256 с серверным секретом (CODE_PEPPER).
 * Простой SHA-256 для 6-значного кода бесполезен: всего 10^6 вариантов, такой
 * хеш перебирается мгновенно. С секретом дамп базы ничего не даёт без него.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const CODE_PEPPER = process.env.CODE_PEPPER || 'dev-pepper-change-me';
const CODE_TTL_MIN = Number(process.env.CODE_TTL_MINUTES || 10);
const CODE_MAX_ATTEMPTS = Number(process.env.CODE_MAX_ATTEMPTS || 5);
const CODE_LENGTH = 6;

/* ───────────────────────────── пароли ───────────────────────────── */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    hash.toString('base64')
  ].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p)
    });
  } catch (_) {
    return false;
  }
  return safeEqual(actual, expected);
}

/* ─────────────────────────── коды на почту ─────────────────────────── */

/** Шесть цифр, без ведущих нулей-заглушек — криптослучайные */
function makeCode() {
  const max = 10 ** CODE_LENGTH;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(CODE_LENGTH, '0');
}

function hashCode(code, purpose) {
  return crypto
    .createHmac('sha256', CODE_PEPPER)
    .update(String(code) + '|' + String(purpose))
    .digest('hex');
}

function codeExpiry() {
  return new Date(Date.now() + CODE_TTL_MIN * 60 * 1000).toISOString();
}

/* ─────────────────────────── сессии ─────────────────────────── */

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** В базе лежит только хеш токена: утечка дампа не даёт войти */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24 * 30);
const SESSION_TTL_HOURS_SHORT = Number(process.env.SESSION_TTL_HOURS_SHORT || 12);

function sessionExpiry(remember) {
  const hours = remember ? SESSION_TTL_HOURS : SESSION_TTL_HOURS_SHORT;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

/* ─────────────────────────── утилиты ─────────────────────────── */

/** Сравнение за постоянное время — чтобы по времени ответа нельзя было подбирать */
function safeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // всё равно сравниваем, чтобы не выдать длину
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function normalizeNickname(v) {
  return String(v || '').trim();
}

/** Ник — буквы (латиница и кириллица), цифры, _ - . и пробел, 3..20 символов.
 *  Регулярка ОБЯЗАНА совпадать с RE_NAME в public/index.html: если фронт пропустит
 *  ник, который сервер считает невалидным, пользователь получит ошибку без причины. */
function validNickname(nick) {
  return /^[A-Za-z0-9_.\-А-Яа-яЁё ]{3,20}$/.test(nick);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(email) && email.length <= 254;
}

/** Пароль: минимум 8 символов, есть буква и цифра */
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'short';
  if (pw.length > 200) return 'long';
  if (!/[A-Za-zА-Яа-я]/.test(pw)) return 'noletter';
  if (!/\d/.test(pw)) return 'nodigit';
  return null;
}

/** Публичное представление пользователя — пароль и хеши наружу не уходят никогда */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    nickname: u.nickname,
    email: u.email,
    verified: Number(u.email_verified) === 1,
    role: u.role,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at || null
  };
}

module.exports = {
  CODE_LENGTH,
  CODE_TTL_MIN,
  CODE_MAX_ATTEMPTS,
  hashPassword,
  verifyPassword,
  makeCode,
  hashCode,
  codeExpiry,
  randomToken,
  hashToken,
  sessionExpiry,
  safeEqual,
  normalizeEmail,
  normalizeNickname,
  validNickname,
  validEmail,
  passwordProblem,
  publicUser
};
