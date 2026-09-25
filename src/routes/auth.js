'use strict';

/**
 * Авторизация: регистрация → код на почту → подтверждение → сессия.
 *
 * Ключевые решения:
 *   - аккаунт создаётся СРАЗУ, но с email_verified = 0. Войти до подтверждения нельзя;
 *   - код живёт CODE_TTL_MINUTES минут, хранится как HMAC-хеш, максимум CODE_MAX_ATTEMPTS попыток;
 *   - повторная отправка: не чаще раза в 60 секунд и не больше 5 писем в час на адрес;
 *   - сессия — httpOnly cookie, в базе только SHA-256 хеш токена;
 *   - ответы на «занята почта» и «нет такого пользователя» не дают перечислять базу:
 *     на сброс пароля отвечаем одинаково независимо от существования адреса.
 */

const express = require('express');
const db = require('../db');
const sec = require('../security');
const mail = require('../mail');

const COOKIE = 'sprice_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === 'true'
  : process.env.NODE_ENV === 'production';

const RESEND_COOLDOWN_SEC = Number(process.env.RESEND_COOLDOWN_SEC || 60);
const RESEND_MAX_PER_HOUR = Number(process.env.RESEND_MAX_PER_HOUR || 5);

/* ─────────────────────────── ответы об ошибках ─────────────────────────── */

class ApiError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

const bad = (code, extra) => new ApiError(400, code, extra);

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/* ─────────────────────────── события (аудит) ─────────────────────────── */

function logEvent(kind, { userId, emailLower, ip } = {}) {
  return db
    .run(
      `INSERT INTO events (id, kind, user_id, email_lower, ip, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [db.uid(), kind, userId || null, emailLower || null, ip || null, db.nowIso()]
    )
    .catch(() => {});
}

/* ─────────────────────────── сессии ─────────────────────────── */

async function createSession(res, userId, remember, req) {
  const token = sec.randomToken(32);
  const expiresAt = sec.sessionExpiry(!!remember);
  await db.run(
    `INSERT INTO sessions (id, user_id, token_hash, remember, user_agent, ip, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      db.uid(),
      userId,
      sec.hashToken(token),
      remember ? 1 : 0,
      String(req.headers['user-agent'] || '').slice(0, 300),
      req.ip || null,
      db.nowIso(),
      expiresAt
    ]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    path: '/',
    maxAge: new Date(expiresAt).getTime() - Date.now()
  });
  return token;
}

async function revokeSession(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    await db.run(`UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2`, [
      db.nowIso(),
      sec.hashToken(token)
    ]);
  }
  res.clearCookie(COOKIE, { path: '/' });
}

async function userFromRequest(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  const s = await db.get(
    `SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sec.hashToken(token)]
  );
  if (!s) return null;
  if (s.expires_at <= db.nowIso()) {
    await db.run(`UPDATE sessions SET revoked_at = $1 WHERE id = $2`, [db.nowIso(), s.id]);
    return null;
  }
  const u = await db.get(`SELECT * FROM users WHERE id = $1`, [s.user_id]);
  return u || null;
}

/** Пропускает только вошедших */
const requireUser = asyncRoute(async (req, res, next) => {
  const u = await userFromRequest(req);
  if (!u) throw new ApiError(401, 'unauthorized');
  req.user = u;
  next();
});

/** Пускает всех, но подставляет req.user если вошёл */
const optionalUser = asyncRoute(async (req, res, next) => {
  req.user = await userFromRequest(req);
  next();
});

/* ─────────────────────────── коды на почту ─────────────────────────── */

async function issueCode({ user, purpose, locale }) {
  const emailLower = user.email_lower;

  const last = await db.get(
    `SELECT created_at FROM email_codes WHERE email_lower = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [emailLower, purpose]
  );
  if (last) {
    const ageSec = (Date.now() - new Date(last.created_at).getTime()) / 1000;
    if (ageSec < RESEND_COOLDOWN_SEC) {
      throw new ApiError(429, 'too_soon', { retryAfter: Math.ceil(RESEND_COOLDOWN_SEC - ageSec) });
    }
  }

  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db.get(
    `SELECT COUNT(*) AS n FROM email_codes WHERE email_lower = $1 AND purpose = $2 AND created_at > $3`,
    [emailLower, purpose, hourAgo]
  );
  if (Number(recent.n) >= RESEND_MAX_PER_HOUR) {
    throw new ApiError(429, 'too_many_codes');
  }

  // прошлые неиспользованные коды гасим — активным остаётся только последний
  await db.run(
    `UPDATE email_codes SET consumed_at = $1 WHERE email_lower = $2 AND purpose = $3 AND consumed_at IS NULL`,
    [db.nowIso(), emailLower, purpose]
  );

  const code = sec.makeCode();
  await db.run(
    `INSERT INTO email_codes (id, user_id, email_lower, code_hash, purpose, expires_at, attempts, max_attempts, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      db.uid(),
      user.id,
      emailLower,
      sec.hashCode(code, purpose),
      purpose,
      sec.codeExpiry(),
      0,
      sec.CODE_MAX_ATTEMPTS,
      db.nowIso()
    ]
  );

  const sent = await mail.sendCode({
    to: user.email,
    nickname: user.nickname,
    code,
    purpose,
    locale: locale === 'en' ? 'en' : 'ru'
  });

  // в DEV-режиме отдаём код наружу, чтобы можно было протестировать без почты
  return { sent, devCode: sent && sent.dev ? code : undefined };
}

/** Проверяет код и гасит его. Бросает ApiError с понятным кодом. */
async function consumeCode({ emailLower, code, purpose }) {
  const row = await db.get(
    `SELECT * FROM email_codes
      WHERE email_lower = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [emailLower, purpose]
  );
  if (!row) throw bad('no_code');
  if (row.expires_at <= db.nowIso()) throw bad('code_expired');
  if (Number(row.attempts) >= Number(row.max_attempts)) throw bad('code_attempts');

  const ok = sec.safeEqual(sec.hashCode(code, purpose), row.code_hash);
  if (!ok) {
    const attempts = Number(row.attempts) + 1;
    await db.run(`UPDATE email_codes SET attempts = $1 WHERE id = $2`, [attempts, row.id]);
    const left = Math.max(0, Number(row.max_attempts) - attempts);
    if (left === 0) throw bad('code_attempts');
    throw bad('code_wrong', { attemptsLeft: left });
  }

  await db.run(`UPDATE email_codes SET consumed_at = $1 WHERE id = $2`, [db.nowIso(), row.id]);
  return row;
}

/* ─────────────────────────── роутер ─────────────────────────── */

const router = express.Router();

/** POST /api/auth/register */
router.post(
  '/register',
  asyncRoute(async (req, res) => {
    const nickname = sec.normalizeNickname(req.body && req.body.nickname);
    const email = sec.normalizeEmail(req.body && req.body.email);
    const password = String((req.body && req.body.password) || '');
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';

    if (!sec.validNickname(nickname)) throw bad('nickname_invalid');
    if (!sec.validEmail(email)) throw bad('email_invalid');
    const pwProblem = sec.passwordProblem(password);
    if (pwProblem) throw bad('password_' + pwProblem);

    const emailTaken = await db.get(`SELECT id FROM users WHERE email_lower = $1`, [email]);
    if (emailTaken) throw new ApiError(409, 'email_taken');

    const nickTaken = await db.get(`SELECT id FROM users WHERE nickname_lower = $1`, [
      nickname.toLowerCase()
    ]);
    if (nickTaken) throw new ApiError(409, 'nickname_taken');

    const id = db.uid();
    const ts = db.nowIso();
    await db.run(
      `INSERT INTO users (id, nickname, nickname_lower, email, email_lower, password_hash, email_verified, role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, nickname, nickname.toLowerCase(), email, email, await sec.hashPassword(password), 0, 'customer', ts, ts]
    );

    const user = await db.get(`SELECT * FROM users WHERE id = $1`, [id]);
    logEvent('register', { userId: id, emailLower: email, ip: req.ip });

    // Письмо может не уйти: почта не настроена либо хостинг закрывает исходящий SMTP.
    // Тогда аккаунт уже вставлен, и повторная попытка упрётся в «email_taken» — человек
    // останется заперт с неподтверждённым аккаунтом и без кода. Поэтому откатываем вставку.
    let devCode;
    try {
      ({ devCode } = await issueCode({ user, purpose: 'verify', locale }));
    } catch (e) {
      await db.run(`DELETE FROM email_codes WHERE user_id = $1`, [id]).catch(() => {});
      await db.run(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
      throw e;
    }

    res.status(201).json({
      ok: true,
      needCode: true,
      purpose: 'verify',
      email: user.email,
      nickname: user.nickname,
      devCode
    });
  })
);

/** POST /api/auth/verify — подтверждение почты кодом, сразу выдаём сессию */
router.post(
  '/verify',
  asyncRoute(async (req, res) => {
    const email = sec.normalizeEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    const remember = !!(req.body && req.body.remember);
    if (!code) throw bad('code_empty');

    const user = await db.get(`SELECT * FROM users WHERE email_lower = $1`, [email]);
    if (!user) throw bad('no_code');

    await consumeCode({ emailLower: email, code, purpose: 'verify' });

    if (Number(user.email_verified) !== 1) {
      await db.run(`UPDATE users SET email_verified = $1, updated_at = $2 WHERE id = $3`, [
        1,
        db.nowIso(),
        user.id
      ]);
    }
    await db.run(`UPDATE users SET last_login_at = $1 WHERE id = $2`, [db.nowIso(), user.id]);
    await createSession(res, user.id, remember, req);
    logEvent('verify', { userId: user.id, emailLower: email, ip: req.ip });

    const fresh = await db.get(`SELECT * FROM users WHERE id = $1`, [user.id]);
    res.json({ ok: true, user: sec.publicUser(fresh) });
  })
);

/** POST /api/auth/resend — повторная отправка кода */
router.post(
  '/resend',
  asyncRoute(async (req, res) => {
    const email = sec.normalizeEmail(req.body && req.body.email);
    const purpose = (req.body && req.body.purpose) === 'reset' ? 'reset' : 'verify';
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';

    const user = await db.get(`SELECT * FROM users WHERE email_lower = $1`, [email]);
    // Не раскрываем, есть ли такой адрес: отвечаем «ок» в любом случае
    if (!user) {
      logEvent('resend_unknown', { emailLower: email, ip: req.ip });
      return res.json({ ok: true, needCode: true, email, purpose, silent: true });
    }

    const { devCode } = await issueCode({ user, purpose, locale });
    logEvent('resend', { userId: user.id, emailLower: email, ip: req.ip });
    res.json({ ok: true, needCode: true, email: user.email, nickname: user.nickname, purpose, devCode });
  })
);

/** POST /api/auth/login */
router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const login = String((req.body && req.body.login) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const remember = !!(req.body && req.body.remember);
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';
    if (!login || !password) throw bad('invalid_credentials');

    const isEmail = login.includes('@');
    const user = isEmail
      ? await db.get(`SELECT * FROM users WHERE email_lower = $1`, [sec.normalizeEmail(login)])
      : await db.get(`SELECT * FROM users WHERE nickname_lower = $1`, [login.toLowerCase()]);

    if (!user) {
      logEvent('login_fail', { emailLower: isEmail ? sec.normalizeEmail(login) : null, ip: req.ip });
      throw new ApiError(401, 'invalid_credentials');
    }

    const ok = await sec.verifyPassword(password, user.password_hash);
    if (!ok) {
      logEvent('login_fail', { userId: user.id, emailLower: user.email_lower, ip: req.ip });
      throw new ApiError(401, 'invalid_credentials');
    }

    // пароль верный, но почта не подтверждена — отправляем код и просим подтвердить
    if (Number(user.email_verified) !== 1) {
      let devCode;
      try {
        ({ devCode } = await issueCode({ user, purpose: 'verify', locale }));
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'too_soon') throw e;
      }
      logEvent('login_unverified', { userId: user.id, emailLower: user.email_lower, ip: req.ip });
      return res.json({
        ok: true,
        needCode: true,
        purpose: 'verify',
        email: user.email,
        nickname: user.nickname,
        devCode
      });
    }

    await db.run(`UPDATE users SET last_login_at = $1 WHERE id = $2`, [db.nowIso(), user.id]);
    await createSession(res, user.id, remember, req);
    logEvent('login', { userId: user.id, emailLower: user.email_lower, ip: req.ip });
    res.json({ ok: true, user: sec.publicUser(user) });
  })
);

/** POST /api/auth/logout */
router.post(
  '/logout',
  asyncRoute(async (req, res) => {
    const u = await userFromRequest(req);
    await revokeSession(req, res);
    if (u) logEvent('logout', { userId: u.id, emailLower: u.email_lower, ip: req.ip });
    res.json({ ok: true });
  })
);

/** GET /api/auth/me */
router.get(
  '/me',
  asyncRoute(async (req, res) => {
    const u = await userFromRequest(req);
    res.json({ ok: true, user: sec.publicUser(u) });
  })
);

/** POST /api/auth/reset/request — запрос кода для сброса пароля */
router.post(
  '/reset/request',
  asyncRoute(async (req, res) => {
    const email = sec.normalizeEmail(req.body && req.body.email);
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';
    if (!sec.validEmail(email)) throw bad('email_invalid');

    const user = await db.get(`SELECT * FROM users WHERE email_lower = $1`, [email]);
    let devCode;
    if (user) {
      try {
        ({ devCode } = await issueCode({ user, purpose: 'reset', locale }));
        logEvent('reset_request', { userId: user.id, emailLower: email, ip: req.ip });
      } catch (e) {
        if (!(e instanceof ApiError) || (e.code !== 'too_soon' && e.code !== 'too_many_codes')) throw e;
        throw e;
      }
    } else {
      logEvent('reset_unknown', { emailLower: email, ip: req.ip });
    }
    // Ответ одинаковый независимо от того, есть адрес в базе или нет
    res.json({ ok: true, needCode: true, purpose: 'reset', email, devCode });
  })
);

/** POST /api/auth/reset/confirm — новый пароль по коду */
router.post(
  '/reset/confirm',
  asyncRoute(async (req, res) => {
    const email = sec.normalizeEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').trim();
    const password = String((req.body && req.body.password) || '');

    const pwProblem = sec.passwordProblem(password);
    if (pwProblem) throw bad('password_' + pwProblem);

    const user = await db.get(`SELECT * FROM users WHERE email_lower = $1`, [email]);
    if (!user) throw bad('no_code');

    await consumeCode({ emailLower: email, code, purpose: 'reset' });

    await db.run(`UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3`, [
      await sec.hashPassword(password),
      db.nowIso(),
      user.id
    ]);
    // все старые сессии гасим — пароль сменился
    await db.run(`UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL`, [
      db.nowIso(),
      user.id
    ]);
    logEvent('reset_done', { userId: user.id, emailLower: email, ip: req.ip });
    res.json({ ok: true });
  })
);

/** POST /api/auth/password — смена пароля из профиля */
router.post(
  '/password',
  requireUser,
  asyncRoute(async (req, res) => {
    const current = String((req.body && req.body.current) || '');
    const next = String((req.body && req.body.password) || '');
    const pwProblem = sec.passwordProblem(next);
    if (pwProblem) throw bad('password_' + pwProblem);

    const ok = await sec.verifyPassword(current, req.user.password_hash);
    if (!ok) throw new ApiError(401, 'invalid_credentials');

    await db.run(`UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3`, [
      await sec.hashPassword(next),
      db.nowIso(),
      req.user.id
    ]);
    logEvent('password_change', { userId: req.user.id, emailLower: req.user.email_lower, ip: req.ip });
    res.json({ ok: true });
  })
);

module.exports = { router, requireUser, optionalUser, ApiError, asyncRoute, logEvent, userFromRequest };
