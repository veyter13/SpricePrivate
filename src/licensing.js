'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const PANEL_URL = (process.env.PANEL_URL || '').replace(/\/+$/, '');
const PANEL_SECRET = process.env.PANEL_SECRET || '';
const FUNPAY_GOLDEN_KEY = process.env.FUNPAY_GOLDEN_KEY || '';
const FUNPAY_DEV_ACCEPT = process.env.FUNPAY_DEV_ACCEPT === '1';

function normCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function gameForProduct(productId) {
  return String(productId || '').toLowerCase().indexOf('cs2') >= 0 ? 'cs2' : 'roblox';
}

function daysForPlan(planIdx) {
  const idx = Number(planIdx);
  if (idx === 1) return 30;
  if (idx === 2) return 7;
  return 0;
}

async function funpayLookup(code) {
  if (!FUNPAY_GOLDEN_KEY) {
    return { configured: FUNPAY_DEV_ACCEPT, paid: FUNPAY_DEV_ACCEPT, sale: null };
  }
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    action: 'getSales',
    dateFrom: now - 60 * 60 * 24 * 365,
    dateTo: now + 60
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch('https://funpay.com/api/', {
      method: 'POST',
      headers: { 'Golden-Key': FUNPAY_GOLDEN_KEY, 'Content-Type': 'application/json' },
      body,
      signal: ctl.signal
    });
    const data = await r.json();
    const resp = data && data.response ? data.response : {};
    const sales = Array.isArray(resp.sales) ? resp.sales : Array.isArray(data.sales) ? data.sales : [];
    const want = normCode(code);
    for (const s of sales) {
      const id = String(s.id || '');
      if (id && id === want) {
        const status = String(s.status || '').toLowerCase();
        const paid =
          Boolean(s.paid) || ['paid', 'closed', 'completed', 'done'].indexOf(status) >= 0;
        return { configured: true, paid, sale: s };
      }
    }
    return { configured: true, paid: false, sale: null };
  } catch (e) {
    return { configured: true, paid: false, sale: null, error: String(e && e.message) };
  } finally {
    clearTimeout(timer);
  }
}

async function issueKeyOnPanel({ owner, game, days, note }) {
  if (!PANEL_URL || !PANEL_SECRET) return { ok: false, error: 'panel_not_configured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(PANEL_URL + '/api/issue_key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': PANEL_SECRET },
      body: JSON.stringify({ owner, game, days, note }),
      signal: ctl.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data || data.ok !== true || !data.key) {
      return { ok: false, error: (data && data.error) || 'panel_error' };
    }
    return { ok: true, key: data.key, game: data.game || game };
  } catch (e) {
    return { ok: false, error: 'panel_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function bindKeyOnPanel(key, owner) {
  if (!PANEL_URL || !PANEL_SECRET) return { ok: false, error: 'panel_not_configured' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(PANEL_URL + '/api/bind_key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Secret': PANEL_SECRET },
      body: JSON.stringify({ key, owner }),
      signal: ctl.signal
    });
    const data = await r.json().catch(() => ({}));
    if (!data || data.ok !== true) return { ok: false, error: (data && data.error) || 'panel_error' };
    return { ok: true, key: data.key, game: data.game, expiresAt: data.expires_at };
  } catch (e) {
    return { ok: false, error: 'panel_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function keyInfoOnPanel(key) {
  if (!PANEL_URL || !PANEL_SECRET) return null;
  try {
    const r = await fetch(
      PANEL_URL + '/api/key_info?key=' + encodeURIComponent(key),
      { headers: { 'X-Api-Secret': PANEL_SECRET } }
    );
    const data = await r.json().catch(() => ({}));
    return data && data.ok ? data : null;
  } catch (e) {
    return null;
  }
}

// "YYYY-MM-DD HH:MM:SS" (UTC) -> ms. Панель отдаёт время без зоны.
function parseUtcMs(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? 0 : t;
}

// Живые данные панели по ключу: выключен ли тумблер и какой срок СЕЙЧАС.
// Панель может быть недоступна — тогда возвращаем null и живём на данных БД.
async function liveLicenseInfo(key) {
  if (!key) return null;
  const info = await keyInfoOnPanel(key);
  if (!info || info.ok !== true) return null;
  return {
    active: Number(info.active || 0) === 1,
    expiresAt: info.expires_at || '',
    hwid: info.hwid || ''
  };
}

function licenseView(row, locale, live) {
  const loc = locale === 'en' ? 'en' : 'ru';

  // Живые данные панели приоритетнее снимка в БД: именно они знают, выключен ли
  // ключ тумблером в панели и какой срок стоит сейчас (после продления).
  let expiresAt = row.expires_at && String(row.expires_at).length > 0
    ? String(row.expires_at)
    : '';
  let status = row.status || 'active';
  if (live) {
    if (live.expiresAt) expiresAt = String(live.expiresAt);
    if (live.active === false) status = 'disabled';
  }

  const ms = parseUtcMs(expiresAt);
  const now = Date.now();
  const expired = ms > 0 && ms < now;
  if (status === 'active' && expired) status = 'expired';

  // Ключ без даты = бессрочный (панель отдаёт "lifetime").
  const lifetime = !expiresAt;
  // Округляем вверх: 3 часа до конца — это ещё «1 день», иначе живой ключ
  // показывал бы «осталось 0 дней» и выглядел бы сломанным.
  const daysLeft = lifetime
    ? -1
    : (expired ? -Math.floor((now - ms) / 86400000)
               : Math.ceil((ms - now) / 86400000));

  return {
    id: row.id,
    key: row.key,
    productId: row.product_id,
    game: row.game,
    status,
    funpayCode: row.funpay_code,
    activatedAt: row.activated_at,
    createdAt: row.created_at,
    expiresAt,
    daysLeft,
    lifetime,
    live: !!live,
    locale: loc
  };
}

function makeLoaderToken() {
  return crypto.randomBytes(32).toString('base64url');
}

module.exports = {
  normCode,
  gameForProduct,
  daysForPlan,
  funpayLookup,
  issueKeyOnPanel,
  keyInfoOnPanel,
  bindKeyOnPanel,
  licenseView,
  liveLicenseInfo,
  makeLoaderToken
};
