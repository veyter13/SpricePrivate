'use strict';

process.env.SQLITE_PATH = ':memory:';
process.env.CODE_PEPPER = 'test-pepper-not-for-production';
process.env.NODE_ENV = 'test';
process.env.PANEL_URL = 'https://panel.test';
process.env.PANEL_SECRET = 'test-secret';
process.env.FUNPAY_DEV_ACCEPT = '1';
delete process.env.DATABASE_URL;
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.FUNPAY_GOLDEN_KEY;

const realFetch = global.fetch;
const panelKeys = new Map();
let seq = 0;

function inDays(n) {
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return (
    d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
  );
}

const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body
});

function seedKey(game, days, owner) {
  const key = 'SPR-TEST-' + String(++seq).padStart(3, '0');
  panelKeys.set(key, {
    key,
    game,
    active: 1,
    expires_at: inDays(days == null ? 30 : days),
    owner_login: owner || ''
  });
  return key;
}

global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.indexOf('https://panel.test') !== 0) return realFetch(url, opts);
  const path = u.slice('https://panel.test'.length);
  const body = opts && opts.body ? JSON.parse(opts.body) : {};

  if (path === '/api/issue_key') {
    const key = 'SPR-TEST-' + String(++seq).padStart(3, '0');
    panelKeys.set(key, {
      key,
      game: body.game,
      active: 1,
      expires_at: inDays(body.days > 0 ? body.days : 30),
      owner_login: body.owner || ''
    });
    return reply(200, { ok: true, key, game: body.game, days: body.days });
  }

  if (path.indexOf('/api/key_info') === 0) {
    const key = decodeURIComponent((path.split('key=')[1] || ''));
    const k = panelKeys.get(key);
    if (!k) return reply(404, { ok: false, error: 'not_found' });
    return reply(200, {
      ok: true,
      key: k.key,
      game: k.game,
      active: k.active,
      expires_at: k.expires_at,
      hwid: k.hwid || ''
    });
  }

  if (path === '/api/bind_key') {
    const k = panelKeys.get(body.key);
    if (!k) return reply(404, { ok: false, error: 'key_not_found' });
    if (k.active !== 1) return reply(403, { ok: false, error: 'key_disabled' });
    if (k.owner_login && k.owner_login !== body.owner) {
      return reply(409, { ok: false, error: 'key_already_bound' });
    }
    k.owner_login = body.owner;
    return reply(200, { ok: true, key: k.key, game: k.game, expires_at: k.expires_at, bound: true });
  }

  return reply(404, { ok: false, error: 'not_found' });
};

const licensing = require('../src/licensing');
const { app } = require('../server');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  \u2713 ' + name);
  } else {
    fail += 1;
    failures.push(name + (extra !== undefined ? ' \u2192 ' + JSON.stringify(extra) : ''));
    console.log('  \u2717 ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  }
}

function client(base) {
  let cookie = '';
  return {
    async req(method, path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const res = await realFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
      let json = null;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { _raw: text.slice(0, 200) }; }
      return { status: res.status, body: json };
    }
  };
}

(async () => {
  console.log('\n─── 1. Чистая логика игры ───');
  {
    check('gameForProduct: potassium → roblox', licensing.gameForProduct('potassium') === 'roblox');
    check('gameForProduct: spicemacro → roblox', licensing.gameForProduct('spicemacro') === 'roblox');
    check('gameForProduct: spriceoverlaycs2 → cs2', licensing.gameForProduct('spriceoverlaycs2') === 'cs2');
    check('gameForProduct: пусто → roblox', licensing.gameForProduct('') === 'roblox');
    check('normGame: CS2 в верхнем регистре → cs2', licensing.normGame('CS2') === 'cs2');
    check('sameGame: cs2 == CS2', licensing.sameGame('cs2', 'CS2') === true);
    check('sameGame: roblox != cs2', licensing.sameGame('roblox', 'cs2') === false);

    const list = [
      { key: 'A', game: 'roblox', status: 'active' },
      { key: 'B', game: 'cs2', status: 'expired' },
      { key: 'C', game: 'roblox', status: 'deleted' },
      { key: 'D', game: 'roblox', status: 'disabled' },
      { key: 'E', game: 'cs2', status: 'pending' }
    ];
    check('activeForGame находит активный roblox', (licensing.activeForGame(list, 'roblox') || {}).key === 'A');
    check('activeForGame не считает expired', licensing.activeForGame(list, 'cs2') === null);
    check('activeForGame на пустом списке → null', licensing.activeForGame([], 'roblox') === null);
    check('activeForGame терпит мусор вместо списка', licensing.activeForGame(null, 'roblox') === null);
  }

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const c = client(base);

  try {
    console.log('\n─── 2. Аккаунт ───');
    const reg = await c.req('POST', '/api/auth/register', {
      nickname: 'duptest', email: 'dup@test.ru', password: 'Passw0rd1', locale: 'ru'
    });
    check('регистрация принята', reg.status === 201, reg.body);
    const ver = await c.req('POST', '/api/auth/verify', { email: 'dup@test.ru', code: reg.body.devCode });
    check('почта подтверждена', ver.status === 200 && ver.body.user.verified === true, ver.body);

    console.log('\n─── 3. Первая подписка на Roblox ───');
    const first = await c.req('POST', '/api/keys/activate', {
      code: 'ORDER-ROB-1', productId: 'potassium', planIdx: 1, locale: 'ru'
    });
    check('код FunPay активирован (201)', first.status === 201 && first.body.ok === true, first.body);
    check('игра определена как roblox', first.body.license && first.body.license.game === 'roblox', first.body.license);
    const robKey1 = first.body.license && first.body.license.key;

    const mine1 = await c.req('GET', '/api/keys/mine?lang=ru');
    check('в кабинете одна подписка', (mine1.body.licenses || []).length === 1, mine1.body.licenses);

    console.log('\n─── 4. Вторая подписка на Roblox запрещена ───');
    const dup = await c.req('POST', '/api/keys/activate', {
      code: 'ORDER-ROB-2', productId: 'vector', planIdx: 0, locale: 'ru'
    });
    check('отказ 409', dup.status === 409, dup.body);
    check('код ошибки already_have_game', dup.body.error === 'already_have_game', dup.body);
    check('в отказе указана игра', dup.body.game === 'roblox', dup.body);

    const mine2 = await c.req('GET', '/api/keys/mine?lang=ru');
    check('вторая строка не появилась', (mine2.body.licenses || []).length === 1, mine2.body.licenses);

    const again = await c.req('POST', '/api/keys/activate', {
      code: 'ORDER-ROB-1', productId: 'potassium', planIdx: 1, locale: 'ru'
    });
    check('тот же код второй раз — идемпотентно (already)', again.status === 200 && again.body.already === true, again.body);

    console.log('\n─── 5. Подписка на CS2 — другая игра, разрешена ───');
    const cs2 = await c.req('POST', '/api/keys/activate', {
      code: 'ORDER-CS2-1', productId: 'spriceoverlaycs2', planIdx: 1, locale: 'ru'
    });
    check('cs2 активирован (201)', cs2.status === 201, cs2.body);
    check('игра определена как cs2', cs2.body.license && cs2.body.license.game === 'cs2', cs2.body.license);

    const mine3 = await c.req('GET', '/api/keys/mine?lang=ru');
    check('теперь две подписки (roblox + cs2)', (mine3.body.licenses || []).length === 2, mine3.body.licenses);

    console.log('\n─── 6. Привязка ключа (claim) по живой подписке ───');
    const freeRob = seedKey('roblox', 30, '');
    const claimRob = await c.req('POST', '/api/keys/claim', { key: freeRob, locale: 'ru' });
    check('roblox-ключ не привязан: 409', claimRob.status === 409, claimRob.body);
    check('код ошибки already_have_game', claimRob.body.error === 'already_have_game', claimRob.body);
    check('ключ на панели НЕ израсходован', (panelKeys.get(freeRob) || {}).owner_login === '', panelKeys.get(freeRob));

    const freeCs2 = seedKey('cs2', 30, '');
    const claimCs2 = await c.req('POST', '/api/keys/claim', { key: freeCs2, locale: 'ru' });
    check('cs2-ключ тоже отклонён (cs2 уже активен)', claimCs2.status === 409, claimCs2.body);
    check('и он тоже не привязан', (panelKeys.get(freeCs2) || {}).owner_login === '');

    const mine4 = await c.req('GET', '/api/keys/mine?lang=ru');
    check('отказы не создали строк', (mine4.body.licenses || []).length === 2, mine4.body.licenses);

    console.log('\n─── 7. Старая подписка истекла — новая разрешена ───');
    panelKeys.get(robKey1).expires_at = inDays(-2);
    const mine5 = await c.req('GET', '/api/keys/mine?lang=ru');
    const robRow = (mine5.body.licenses || []).find((l) => l.key === robKey1);
    check('сайт видит подписку как истёкшую', robRow && robRow.status === 'expired', robRow);

    const claimRob2 = await c.req('POST', '/api/keys/claim', { key: freeRob, locale: 'ru' });
    check('после истечения roblox-ключ привязывается (201)', claimRob2.status === 201, claimRob2.body);
    check('ключ закреплён за аккаунтом', (panelKeys.get(freeRob) || {}).owner_login === 'duptest', panelKeys.get(freeRob));

    const freeRobX = seedKey('roblox', 30, '');
    const claimRobX = await c.req('POST', '/api/keys/claim', { key: freeRobX, locale: 'ru' });
    check('а второй roblox-ключ сразу уже нельзя (409)', claimRobX.status === 409, claimRobX.body);
    check('и он остался свободным', (panelKeys.get(freeRobX) || {}).owner_login === '', panelKeys.get(freeRobX));

    console.log('\n─── 8. Ключ удалён в панели — место освобождается ───');
    panelKeys.delete(freeRob);
    const mine6 = await c.req('GET', '/api/keys/mine?lang=ru');
    const gone = (mine6.body.licenses || []).find((l) => l.key === freeRob);
    check('сайт видит подписку как удалённую', gone && gone.status === 'deleted', gone);

    const after = await c.req('POST', '/api/keys/activate', {
      code: 'ORDER-ROB-2', productId: 'vector', planIdx: 0, locale: 'ru'
    });
    check('после удаления код FunPay на roblox снова проходит (201)', after.status === 201, after.body);
    check('и игра в строке roblox', after.body.license && after.body.license.game === 'roblox', after.body.license);

    const freeRob3 = seedKey('roblox', 30, '');
    const claimRob5 = await c.req('POST', '/api/keys/claim', { key: freeRob3, locale: 'ru' });
    check('но третий roblox-ключ опять нельзя (409)', claimRob5.status === 409, claimRob5.body);

    const freeCs2b = seedKey('cs2', 30, '');
    const claimCs2b = await c.req('POST', '/api/keys/claim', { key: freeCs2b, locale: 'ru' });
    check('cs2 всё ещё занят, ключ отклонён (409)', claimCs2b.status === 409, claimCs2b.body);

    console.log('\n─── 9. Ключ, которого нет в панели ───');
    const ghost = await c.req('POST', '/api/keys/claim', { key: 'SPR-NOSUCH-KEY-1', locale: 'ru' });
    check('несуществующий ключ → 404', ghost.status === 404 && ghost.body.error === 'key_not_found', ghost.body);

    console.log('\n─── 10. Выключенный ключ не выдаёт себя за свободный ───');
    const offKey = seedKey('cs2', 30, '');
    panelKeys.get(offKey).active = 0;
    const off = await c.req('POST', '/api/keys/claim', { key: offKey, locale: 'ru' });
    check('выключенный ключ → 403 key_disabled', off.status === 403 && off.body.error === 'key_disabled', off.body);
  } catch (e) {
    fail += 1;
    failures.push('ИСКЛЮЧЕНИЕ: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    console.log('\nИСКЛЮЧЕНИЕ: ' + e.message);
    console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  } finally {
    server.close();
  }

  console.log('\n' + '\u2550'.repeat(52));
  console.log('  пройдено: ' + pass + '   провалено: ' + fail);
  if (fail) {
    console.log('\n  Провалы:');
    failures.forEach((f) => console.log('   \u2022 ' + f));
  }
  console.log('\u2550'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
