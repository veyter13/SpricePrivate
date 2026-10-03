'use strict';

const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const catalog = require('../catalog');
const sec = require('../security');
const licensing = require('../licensing');
const guard = require('../guard');
const { requireUser, ApiError, asyncRoute, logEvent, userFromRequest } = require('./auth');

const router = express.Router();

const LOADER_SESSION_DAYS = Number(process.env.LOADER_SESSION_DAYS || 30);

// Пауза на неудачном входе: перебор паролей становится в разы дороже, а
// человек с опечаткой ничего не замечает.
function failDelay() {
  const ms = 250 + Math.floor(Math.random() * 250);
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

async function userByLoaderToken(req) {
  const h = String(req.headers.authorization || '');
  const raw = h.toLowerCase().startsWith('bearer ')
    ? h.slice(7).trim()
    : String(req.headers['x-loader-token'] || '');
  if (!raw) return null;
  const row = await db.get(
    `SELECT s.user_id, s.expires_at, u.* FROM loader_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(raw)]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// Снимок из БД, БЕЗ опроса панели. Оставлен как быстрый/оффлайн-вариант и для
// тестов. В рабочих ответах пользователю и лоадеру НЕ используется: строка БД
// не знает ни про удаление ключа, ни про выключенный тумблер, ни про продление.
async function licensesOf(userId, locale) {
  const rows = await db.all(
    `SELECT * FROM licenses WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r) => licensing.licenseView(r, locale));
}

// То же, но с опросом панели по каждому ключу: показывает реальное состояние
// (выключен тумблером / актуальный срок после продления). Запросы идут
// параллельно, а если панель молчит — остаются данные из БД.
async function licensesLive(userId, locale) {
  const rows = await db.all(
    `SELECT * FROM licenses WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return Promise.all(
    rows.map(async (r) => {
      const live = await licensing.liveLicenseInfo(r.key);
      return licensing.licenseView(r, locale, live);
    })
  );
}

async function assertNoActiveGame(userId, game, locale) {
  const list = await licensesLive(userId, locale);
  const clash = licensing.activeForGame(list, game);
  if (!clash) return;
  throw new ApiError(409, 'already_have_game', {
    game: licensing.normGame(game),
    until: clash.expiresAt || null
  });
}

router.get(
  '/keys/mine',
  requireUser,
  asyncRoute(async (req, res) => {
    const locale = req.query.lang === 'en' ? 'en' : 'ru';
    res.json({ ok: true, licenses: await licensesLive(req.user.id, locale) });
  })
);

router.post(
  '/keys/activate',
  requireUser,
  asyncRoute(async (req, res) => {
    const code = licensing.normCode((req.body && req.body.code) || '');
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';
    if (code.length < 4) throw new ApiError(400, 'code_short');
    if (Number(req.user.email_verified) !== 1) throw new ApiError(403, 'not_verified');

    const existing = await db.get(`SELECT * FROM licenses WHERE funpay_code = $1`, [code]);
    if (existing) {
      if (existing.user_id === req.user.id) {
        return res.json({
          ok: true,
          already: true,
          license: licensing.licenseView(existing, locale)
        });
      }
      throw new ApiError(409, 'code_used');
    }

    const check = await licensing.funpayLookup(code);
    if (check.configured && !check.paid) throw new ApiError(404, 'order_not_found');

    const productId = String((req.body && req.body.productId) || 'spriceoverlay');
    const planIdx = Number((req.body && req.body.planIdx) ?? 0);
    const game = licensing.gameForProduct(productId);
    const days = licensing.daysForPlan(planIdx);

    await assertNoActiveGame(req.user.id, game, locale);

    if (!check.configured) {
      const pendingId = db.uid();
      await db.run(
        `INSERT INTO licenses (id, user_id, key, product_id, game, status, funpay_code, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pendingId, req.user.id, 'PENDING-' + pendingId.slice(0, 8), productId, game, 'pending', code, db.nowIso()]
      );
      await logEvent('license_pending', { userId: req.user.id, emailLower: req.user.email_lower, ip: req.clientIp || req.ip });
      return res.json({ ok: true, pending: true, message: 'pending' });
    }

    const issued = await licensing.issueKeyOnPanel({
      owner: req.user.nickname,
      game,
      days,
      note: 'site:' + code
    });
    if (!issued.ok) throw new ApiError(502, issued.error || 'panel_error');

    const id = db.uid();
    const now = db.nowIso();
    const info = await licensing.keyInfoOnPanel(issued.key);
    await db.run(
      `INSERT INTO licenses (id, user_id, key, product_id, game, status, funpay_code, expires_at, activated_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        req.user.id,
        issued.key,
        productId,
        issued.game || game,
        'active',
        code,
        info && info.expires_at ? info.expires_at : null,
        now,
        now
      ]
    );
    await logEvent('license_issued', { userId: req.user.id, emailLower: req.user.email_lower, ip: req.clientIp || req.ip });

    const row = await db.get(`SELECT * FROM licenses WHERE id = $1`, [id]);
    res.status(201).json({ ok: true, license: licensing.licenseView(row, locale) });
  })
);

router.post(
  '/keys/claim',
  requireUser,
  asyncRoute(async (req, res) => {
    const key = String((req.body && req.body.key) || '').trim().toUpperCase().replace(/s+/g, '');
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';
    if (key.length < 6) throw new ApiError(400, 'key_short');
    if (Number(req.user.email_verified) !== 1) throw new ApiError(403, 'not_verified');

    const mine = await db.get('SELECT * FROM licenses WHERE key = $1', [key]);
    if (mine) {
      if (mine.user_id === req.user.id) {
        return res.json({ ok: true, already: true, license: licensing.licenseView(mine, locale) });
      }
      throw new ApiError(409, 'key_bound_to_other');
    }

    const keyInfo = await licensing.keyInfoOnPanel(key);
    let keyGame = '';
    if (keyInfo && keyInfo.ok === true) {
      if (Number(keyInfo.active || 0) !== 1) throw new ApiError(403, 'key_disabled');
      const keyExpiresMs = licensing.parseUtcMs(keyInfo.expires_at || '');
      if (keyExpiresMs && keyExpiresMs < Date.now()) throw new ApiError(403, 'key_expired');
      keyGame = licensing.normGame(keyInfo.game);
      await assertNoActiveGame(req.user.id, keyGame, locale);
    }

    const bound = await licensing.bindKeyOnPanel(key, req.user.nickname);
    if (!bound.ok) {
      const map = { key_not_found: 404, key_already_bound: 409, key_disabled: 403, key_expired: 403 };
      throw new ApiError(map[bound.error] || 502, bound.error || 'panel_error');
    }

    const game = licensing.normGame(bound.game || 'roblox');
    if (!keyGame) await assertNoActiveGame(req.user.id, game, locale);

    const id = db.uid();
    const now = db.nowIso();
    await db.run(
      'INSERT INTO licenses (id, user_id, key, product_id, game, status, expires_at, activated_at, created_at)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, req.user.id, bound.key, 'manual', game, 'active', bound.expiresAt || null, now, now]
    );
    await logEvent('license_claimed', { userId: req.user.id, emailLower: req.user.email_lower, ip: req.clientIp || req.ip });
    const row = await db.get('SELECT * FROM licenses WHERE id = $1', [id]);
    res.status(201).json({ ok: true, license: licensing.licenseView(row, locale) });
  })
);

router.get(
  '/licenses/:id/receipt',
  requireUser,
  asyncRoute(async (req, res) => {
    const row = await db.get(`SELECT * FROM licenses WHERE id = $1 AND user_id = $2`, [
      String(req.params.id),
      req.user.id
    ]);
    if (!row) throw new ApiError(404, 'not_found');
    const product = catalog.getProduct(row.product_id);
    res.json({
      ok: true,
      receipt: {
        number: 'SPR-' + String(row.id).replace(/-/g, '').slice(0, 10).toUpperCase(),
        nickname: req.user.nickname,
        email: req.user.email,
        product: product ? product.name : row.product_id,
        game: row.game,
        key: row.key,
        status: row.status,
        funpayCode: row.funpay_code,
        activatedAt: row.activated_at,
        createdAt: row.created_at
      }
    });
  })
);

router.post(
  '/loader/login',
  asyncRoute(async (req, res) => {
    // Общий секрет с лоадером (заголовок X-Loader-Key). Пока
    // LOADER_SHARED_SECRET не задан на хостинге — проверка выключена, старые
    // версии лоадера продолжают работать. Жёсткий режим включается
    // LOADER_SECRET_ENFORCE=1 (только после обновления всех юзеров).
    const secretProblem = guard.loaderSecretProblem(req);
    if (secretProblem) {
      guard.strike(req, 1);
      throw new ApiError(secretProblem.status, secretProblem.error);
    }
    if (process.env.LOADER_SHARED_SECRET && !guard.loaderSecretOk(req)) {
      console.warn('[лоадер] вход без секрета с ' + req.clientIp);
    }

    const login = String((req.body && (req.body.login || req.body.nickname || req.body.email)) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const hwid = String((req.body && req.body.hwid) || '').trim();
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';

    if (!login || !password) throw new ApiError(400, 'credentials_required');
    if (login.length > 254 || password.length > 200) throw new ApiError(400, 'credentials_required');

    const user = await db.get(
      `SELECT * FROM users WHERE nickname_lower = $1 OR email_lower = $1`,
      [login.toLowerCase()]
    );
    if (!user) {
      await failDelay();
      guard.strike(req, 2);
      await logEvent('loader_login_failed', { emailLower: login.toLowerCase(), ip: req.clientIp });
      throw new ApiError(401, 'invalid_credentials');
    }

    const ok = await sec.verifyPassword(password, user.password_hash);
    if (!ok) {
      await failDelay();
      guard.strike(req, 2);
      await logEvent('loader_login_failed', { userId: user.id, emailLower: user.email_lower, ip: req.clientIp });
      throw new ApiError(401, 'invalid_credentials');
    }
    if (Number(user.email_verified) !== 1) {
      guard.strike(req, 1);
      throw new ApiError(403, 'not_verified');
    }

    // Вход удался — снимаем накопленные промахи с этого IP.
    guard.clear(req);

    const token = licensing.makeLoaderToken();
    const now = db.nowIso();
    const expires = new Date(Date.now() + LOADER_SESSION_DAYS * 86400000).toISOString();
    await db.run(
      `INSERT INTO loader_sessions (id, user_id, token_hash, hwid, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [db.uid(), user.id, sha256(token), hwid, now, expires]
    );
    await db.run(`UPDATE users SET last_login_at = $1, updated_at = $1 WHERE id = $2`, [
      now,
      user.id
    ]);
    await logEvent('loader_login', { userId: user.id, emailLower: user.email_lower, ip: req.clientIp || req.ip });

    // Именно live-вариант: строка в БД — это снимок на момент покупки. Если
    // ключ удалили или выключили в панели, отдавать его лоадеру как «активный»
    // нельзя — иначе лоадер уходил на экран активации, хотя второй ключ жив.
    const licenses = await licensesLive(user.id, locale);
    const activeOne = licenses.filter((l) => l.status === 'active')[0] || null;
    res.json({
      ok: true,
      token,
      activeKey: activeOne ? activeOne.key : null,
      // Для каждой активной подписки сразу отдаём статус и остаток дней, чтобы
      // лоадер показал их ещё до опроса панели (и работал, если панель молчит).
      activeGames: licenses.filter((l) => l.status === 'active').map((l) => ({
        game: l.game,
        key: l.key,
        until: l.expiresAt || null,
        daysLeft: typeof l.daysLeft === 'number' ? l.daysLeft : -1,
        lifetime: !!l.lifetime,
        status: l.status
      })),
      activeGame: activeOne ? activeOne.game : null,
      activeUntil: activeOne ? (activeOne.expiresAt || null) : null,
      nickname: user.nickname,
      email: user.email,
      expiresAt: expires,
      licenses
    });
  })
);

router.get(
  '/loader/me',
  asyncRoute(async (req, res) => {
    const user = await userByLoaderToken(req);
    if (!user) throw new ApiError(401, 'unauthorized');
    const locale = req.query.lang === 'en' ? 'en' : 'ru';
    const licenses = await licensesLive(user.id, locale);
    res.json({ ok: true, nickname: user.nickname, email: user.email, licenses });
  })
);

router.get(
  '/loader/key',
  asyncRoute(async (req, res) => {
    const user = await userByLoaderToken(req);
    if (!user) throw new ApiError(401, 'unauthorized');
    const licenses = await licensesLive(user.id, 'ru');
    const active = licenses.filter((l) => l.status === 'active');
    if (active.length === 0) throw new ApiError(404, 'no_active_key');
    res.json({ ok: true, license: active[0] });
  })
);

module.exports = { router };
