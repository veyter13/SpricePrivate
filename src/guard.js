'use strict';

// ============================================================================
//  Страж сайта: бан по IP за перебор и флуд
//  ---------------------------------------------------------------------------
//  express-rate-limit считает запросы, но ничего не помнит между окнами и
//  ничего не делает с тем, кто упорно перебирает пароли: 30 попыток в 10 минут,
//  потом окно сбрасывается — и так по кругу. Страж держит «штрафы» по IP и
//  после серии промахов закрывает доступ целиком на время.
//
//  Счётчики живут в памяти процесса. Render держит один инстанс, этого хватает;
//  после рестарта они обнуляются — перебор с нуля снова упирается в лимиты.
//
//  Настройки (Render -> Environment, все необязательные):
//    LOADER_SHARED_SECRET  общий секрет с лоадером (заголовок X-Loader-Key).
//                          Пока он задан, сайт доверяет заголовку
//                          X-Sprice-Real-IP от зеркала и считает лимиты по
//                          настоящему IP клиента, а не по адресу воркера.
//    LOADER_SECRET_ENFORCE =1 — жёстко требовать секрет: запросы без него
//                          получают 403. Включать ТОЛЬКО после того, как все
//                          юзеры обновили лоадер.
//    GUARD_BAN_AFTER       сколько промахов до бана (по умолчанию 12)
//    GUARD_BAN_MINUTES     на сколько минут банить (по умолчанию 30)
//    GUARD_WINDOW_MIN      окно накопления промахов (по умолчанию 15)
// ============================================================================

const crypto = require('node:crypto');

// Порог подобран так, чтобы человек с опечатками не пострадал (8 неверных
// паролей за 15 минут — это уже перебор, а не «рука дрогнула»).
const BAN_AFTER = Number(process.env.GUARD_BAN_AFTER || 16);
const BAN_MINUTES = Number(process.env.GUARD_BAN_MINUTES || 30);
const WINDOW_MIN = Number(process.env.GUARD_WINDOW_MIN || 15);
const MAX_ENTRIES = 20000;

const state = new Map(); // ip -> { n, first, until }

function eq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) {
    crypto.timingSafeEqual(A, A);
    return false;
  }
  return crypto.timingSafeEqual(A, B);
}

function wantSecret() {
  return String(process.env.LOADER_SHARED_SECRET || '');
}

// Подписан ли запрос общим секретом лоадера.
function loaderSecretOk(req) {
  const want = wantSecret();
  if (!want) return false;
  return eq(String(req.headers['x-loader-key'] || ''), want);
}

// Жёсткий режим: без секрета вход в лоадер закрыт.
function loaderSecretRequired() {
  return String(process.env.LOADER_SECRET_ENFORCE || '') === '1';
}

// Кто на самом деле пришёл.
//
// Через зеркало (Cloudflare Worker) запрос приходит с адреса воркера, а
// настоящий IP лежит в X-Sprice-Real-IP. Верить этому заголовку можно только
// вместе с секретом — иначе любой подставит чужой IP и обойдёт лимиты.
// Если пришло с зеркала, а секрет не совпал — IP недостоверен, и «штрафовать»
// за него никого нельзя (иначе один флудер забанил бы всех сразу).
function clientOf(req) {
  if (loaderSecretOk(req)) {
    const via = String(req.headers['x-sprice-real-ip'] || '').trim();
    if (via) return { ip: via, trusted: true };
  }
  if (req.headers['x-sprice-mirror']) {
    return { ip: 'mirror:' + String(req.ip || '?'), trusted: false };
  }
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return { ip: cf, trusted: true };
  return { ip: String(req.ip || (req.socket && req.socket.remoteAddress) || '?'), trusted: true };
}

function prune() {
  const now = Date.now();
  for (const [ip, e] of state) {
    if (e.until < now && now - e.first > WINDOW_MIN * 60000) state.delete(ip);
  }
  if (state.size > MAX_ENTRIES) state.clear();
}

function isBanned(ip) {
  const e = state.get(ip);
  return !!(e && e.until > Date.now());
}

function banLeftSec(ip) {
  const e = state.get(ip);
  if (!e || e.until <= Date.now()) return 0;
  return Math.ceil((e.until - Date.now()) / 1000);
}

// Начислить промах. weight=2 для заведомо злонамеренных действий (неверный
// пароль), 1 — для мягких (нет секрета, мусорный запрос).
function strike(req, weight = 1) {
  const c = clientOf(req);
  if (!c.trusted) return 0;
  const now = Date.now();
  let e = state.get(c.ip);
  if (!e || now - e.first > WINDOW_MIN * 60000) e = { n: 0, first: now, until: 0 };
  e.n += weight;
  if (e.n >= BAN_AFTER) {
    e.until = now + BAN_MINUTES * 60000;
    e.n = 0;
    e.first = now;
    console.warn('[страж] бан ' + c.ip + ' на ' + BAN_MINUTES + ' мин');
  }
  state.set(c.ip, e);
  if (state.size > MAX_ENTRIES) prune();
  return e.n;
}

// Успешный вход — снимаем накопленное.
function clear(req) {
  const c = clientOf(req);
  if (c.trusted) state.delete(c.ip);
}

function guard(req, res, next) {
  const c = clientOf(req);
  req.clientIp = c.ip;
  req.clientTrusted = c.trusted;

  // Бан закрывает только API. Страницы сайта остаются доступными: юзеру под
  // общим (NAT/провайдерским) IP нельзя запрещать читать сайт из-за чужого
  // перебора, а мониторингу хостинга — стучаться в /healthz.
  const p = req.path || '';
  if (p === '/healthz' || !p.startsWith('/api')) return next();

  if (c.trusted && isBanned(c.ip)) {
    res.setHeader('Retry-After', String(banLeftSec(c.ip)));
    return res.status(403).json({ error: 'banned', retryAfter: banLeftSec(c.ip) });
  }
  next();
}

// Проверка секрета лоадера. Возвращает null, если всё хорошо, иначе — ошибку
// для ответа.
function loaderSecretProblem(req) {
  if (!wantSecret()) return null; // секрет не настроен — проверять нечего
  if (loaderSecretOk(req)) return null;
  if (loaderSecretRequired()) return { status: 403, error: 'bad_loader_key' };
  return null; // мягкий режим: пропускаем, но факт логируется вызывающим
}

function stats() {
  let banned = 0;
  const now = Date.now();
  for (const e of state.values()) if (e.until > now) banned++;
  return { tracked: state.size, banned, banAfter: BAN_AFTER, banMinutes: BAN_MINUTES };
}

module.exports = {
  guard,
  strike,
  clear,
  isBanned,
  banLeftSec,
  clientOf,
  loaderSecretOk,
  loaderSecretProblem,
  stats
};
