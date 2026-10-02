'use strict';

const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const catalog = require('../catalog');
const sec = require('../security');
const licensing = require('../licensing');
const { requireUser, ApiError, asyncRoute, logEvent, userFromRequest } = require('./auth');

const router = express.Router();

const LOADER_SESSION_DAYS = Number(process.env.LOADER_SESSION_DAYS || 30);

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

async function licensesOf(userId, locale) {
  const rows = await db.all(
    `SELECT * FROM licenses WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r) => licensing.licenseView(r, locale));
}

router.get(
  '/keys/mine',
  requireUser,
  asyncRoute(async (req, res) => {
    const locale = req.query.lang === 'en' ? 'en' : 'ru';
    res.json({ ok: true, licenses: await licensesOf(req.user.id, locale) });
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

    if (!check.configured) {
      const pendingId = db.uid();
      await db.run(
        `INSERT INTO licenses (id, user_id, key, product_id, game, status, funpay_code, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pendingId, req.user.id, 'PENDING-' + pendingId.slice(0, 8), productId, game, 'pending', code, db.nowIso()]
      );
      await logEvent('license_pending', req.user.id, req.user.email_lower, req.ip);
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
    await logEvent('license_issued', req.user.id, req.user.email_lower, req.ip);

    const row = await db.get(`SELECT * FROM licenses WHERE id = $1`, [id]);
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
    const login = String((req.body && (req.body.login || req.body.nickname || req.body.email)) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const hwid = String((req.body && req.body.hwid) || '').trim();
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';

    if (!login || !password) throw new ApiError(400, 'credentials_required');

    const user = await db.get(
      `SELECT * FROM users WHERE nickname_lower = $1 OR email_lower = $1`,
      [login.toLowerCase()]
    );
    if (!user) throw new ApiError(401, 'invalid_credentials');

    const ok = await sec.verifyPassword(password, user.password_hash);
    if (!ok) throw new ApiError(401, 'invalid_credentials');
    if (Number(user.email_verified) !== 1) throw new ApiError(403, 'not_verified');

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
    await logEvent('loader_login', user.id, user.email_lower, req.ip);

    const licenses = await licensesOf(user.id, locale);
    res.json({
      ok: true,
      token,
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
    const licenses = await licensesOf(user.id, locale);
    res.json({ ok: true, nickname: user.nickname, email: user.email, licenses });
  })
);

router.get(
  '/loader/key',
  asyncRoute(async (req, res) => {
    const user = await userByLoaderToken(req);
    if (!user) throw new ApiError(401, 'unauthorized');
    const licenses = await licensesOf(user.id, 'ru');
    const active = licenses.filter((l) => l.status === 'active');
    if (active.length === 0) throw new ApiError(404, 'no_active_key');
    res.json({ ok: true, license: active[0] });
  })
);

module.exports = { router };
