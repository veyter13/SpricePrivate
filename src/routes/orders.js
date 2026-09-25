'use strict';

const express = require('express');
const db = require('../db');
const catalog = require('../catalog');
const { requireUser, optionalUser, ApiError, asyncRoute, logEvent } = require('./auth');

const DEDUP_WINDOW_MIN = Number(process.env.ORDER_DEDUP_MINUTES || 10);

const router = express.Router();

router.get(
  '/catalog',
  asyncRoute(async (req, res) => {
    const locale = req.query.lang === 'en' ? 'en' : 'ru';
    res.json({ ok: true, funpay: catalog.FUNPAY_URL, products: catalog.publicCatalog(locale) });
  })
);

function orderView(o, locale) {
  const loc = locale === 'en' ? 'en' : 'ru';
  const plan = catalog.getPlan(o.product_id, o.plan_idx);
  const product = catalog.getProduct(o.product_id);
  return {
    id: o.id,
    productId: o.product_id,
    productName: product ? product.name : o.product_id,
    planIdx: Number(o.plan_idx),
    planDuration: plan ? plan.duration[loc] : o.plan_duration,
    price: Number(o.price),
    priceText: catalog.formatPrice(Number(o.price)),
    status: o.status,
    createdAt: o.created_at
  };
}

router.post(
  '/orders',
  requireUser,
  asyncRoute(async (req, res) => {
    const productId = String((req.body && req.body.productId) || '');
    const planIdx = Number((req.body && req.body.planIdx) ?? 0);
    const locale = (req.body && req.body.locale) === 'en' ? 'en' : 'ru';

    const product = catalog.getProduct(productId);
    if (!product) throw new ApiError(400, 'product_unknown');
    const plan = catalog.getPlan(productId, planIdx);
    if (!plan) throw new ApiError(400, 'plan_unknown');

    if (Number(req.user.email_verified) !== 1) throw new ApiError(403, 'not_verified');

    const since = new Date(Date.now() - DEDUP_WINDOW_MIN * 60 * 1000).toISOString();
    const existing = await db.get(
      `SELECT * FROM orders
        WHERE user_id = $1 AND product_id = $2 AND plan_idx = $3 AND status != $4 AND created_at > $5
        ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, productId, planIdx, 'cancelled', since]
    );
    if (existing) {
      return res.json({ ok: true, deduped: true, order: orderView(existing, locale) });
    }

    const id = db.uid();
    await db.run(
      `INSERT INTO orders (id, user_id, product_id, plan_idx, plan_duration, price, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, req.user.id, productId, planIdx, plan.duration.ru, plan.price, 'created', db.nowIso()]
    );
    logEvent('order_created', { userId: req.user.id, emailLower: req.user.email_lower, ip: req.ip });

    const fresh = await db.get(`SELECT * FROM orders WHERE id = $1`, [id]);
    res.status(201).json({ ok: true, order: orderView(fresh, locale), funpay: catalog.FUNPAY_URL });
  })
);

router.get(
  '/orders',
  requireUser,
  asyncRoute(async (req, res) => {
    const locale = req.query.lang === 'en' ? 'en' : 'ru';
    const rows = await db.all(
      `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ ok: true, orders: rows.map((o) => orderView(o, locale)) });
  })
);

router.post(
  '/orders/:id/cancel',
  requireUser,
  asyncRoute(async (req, res) => {
    const row = await db.get(`SELECT * FROM orders WHERE id = $1 AND user_id = $2`, [
      String(req.params.id),
      req.user.id
    ]);
    if (!row) throw new ApiError(404, 'order_not_found');
    if (row.status === 'cancelled') return res.json({ ok: true, alreadyCancelled: true });

    await db.run(`UPDATE orders SET status = $1 WHERE id = $2`, ['cancelled', row.id]);
    logEvent('order_cancelled', { userId: req.user.id, emailLower: req.user.email_lower, ip: req.ip });
    res.json({ ok: true });
  })
);

router.get(
  '/profile',
  requireUser,
  asyncRoute(async (req, res) => {
    const locale = req.query.lang === 'en' ? 'en' : 'ru';

    const agg = await db.get(
      `SELECT COUNT(*) AS total, COALESCE(SUM(price), 0) AS spent
         FROM orders WHERE user_id = $1 AND status != $2`,
      [req.user.id, 'cancelled']
    );
    const orders = await db.all(
      `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.user.id]
    );

    const created = new Date(req.user.created_at).getTime();
    const days = Math.max(1, Math.ceil((Date.now() - created) / 86400000));
    const spent = Number(agg.spent);

    res.json({
      ok: true,
      user: {
        id: req.user.id,
        nickname: req.user.nickname,
        email: req.user.email,
        verified: Number(req.user.email_verified) === 1,
        createdAt: req.user.created_at
      },
      stats: {
        orders: Number(agg.total),
        days,
        spent,
        spentText: catalog.formatPrice(spent)
      },
      orders: orders.map((o) => orderView(o, locale))
    });
  })
);

module.exports = { router };
