'use strict';

/**
 * Sprice Private — сервер.
 *
 * Один процесс отдаёт и API, и сайт: на Render это Web Service без отдельного
 * фронтенд-хостинга. Порт берётся из process.env.PORT (Render задаёт его сам).
 */

require('dotenv').config();

// node:sqlite помечен экспериментальным и сыплет предупреждением при каждом старте.
// Гасим только его, остальные предупреждения Node оставляем видимыми.
const originalEmit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  return originalEmit.call(process, warning, ...rest);
};

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const db = require('./src/db');
const mail = require('./src/mail');
const authRoutes = require('./src/routes/auth');
const orderRoutes = require('./src/routes/orders');
const catalog = require('./src/catalog');

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();

// Render держит приложение за своим прокси: без этого req.ip будет всегда 127.0.0.1,
// а rate limit начнёт банить всех сразу, и secure-cookie не выставится.
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ─────────────────────────── базовые middleware ─────────────────────────── */

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* ─────────────────────────── ограничение частоты ─────────────────────────── */

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MIN || 120),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited' }
});

// На вход/регистрацию — заметно строже, чтобы не перебирали пароли
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited' }
});

app.use('/api', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/verify', authLimiter);
app.use('/api/auth/reset/request', authLimiter);

/* ─────────────────────────── маршруты ─────────────────────────── */

app.get('/healthz', async (req, res) => {
  try {
    await db.init();
    res.json({
      ok: true,
      db: db.DRIVER,
      mail: mail.getMode(),
      products: catalog.IDS.length,
      uptime: Math.round(process.uptime())
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'db_unavailable', message: e.message });
  }
});

app.use('/api/auth', authRoutes.router);
app.use('/api', orderRoutes.router);

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

/* ─────────────────────────── статика ─────────────────────────── */

app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.html$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    }
  })
);

// Сайт одностраничный, навигация через hash — любой неизвестный путь отдаёт index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ─────────────────────────── ошибки ─────────────────────────── */

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const body = { error: err.code || 'server_error' };
  if (err.extra) Object.assign(body, err.extra);
  if (status >= 500) {
    console.error('[ошибка]', req.method, req.originalUrl, '-', err.message);
    if (!IS_PROD) body.detail = err.stack;
  }
  res.status(status).json(body);
});

/* ─────────────────────────── запуск ─────────────────────────── */

let server = null;

async function start() {
  await db.init();
  mail.init();
  server = app.listen(PORT, () => {
    console.log('');
    console.log('  Sprice Private');
    console.log('  адрес:   http://localhost:' + PORT);
    console.log('  база:    ' + db.DRIVER);
    console.log('  почта:   ' + mail.getMode());
    warnProdMisconfig();
    console.log('');
  });
}

/**
 * На Render диск эфемерный: SQLite потеряется при следующем деплое или рестарте.
 * Если проект запущен как production без DATABASE_URL — это почти наверняка
 * ошибка настройки, о ней надо кричать в логах, а не молчать.
 */
function warnProdMisconfig() {
  if (!IS_PROD) return;
  const warn = (msg) => console.warn('  [!] ' + msg);
  if (db.DRIVER === 'sqlite') {
    warn('NODE_ENV=production, но DATABASE_URL не задан — данные лежат в SQLite.');
    warn('На Render файловая система эфемерная: аккаунты и заказы исчезнут при');
    warn('рестарте. Подключите Postgres и задайте DATABASE_URL.');
  }
  if (mail.getMode() === 'dev') {
    warn('Почта в DEV-режиме: письма не отправляются, код печатается в этот лог.');
    warn('Задайте RESEND_API_KEY или SMTP_HOST, иначе пользователи не получат код.');
  }
  if (!process.env.CODE_PEPPER) {
    warn('CODE_PEPPER не задан — коды подписываются встроенным значением по умолчанию.');
  }
}

async function shutdown(signal) {
  console.log('\n[' + signal + '] останавливаюсь...');
  if (server) await new Promise((r) => server.close(r));
  await db.close().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((e) => {
    console.error('Не удалось запустить сервер:', e);
    process.exit(1);
  });
}

module.exports = { app, start };
