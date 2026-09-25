'use strict';

/**
 * Сквозной тест бэкенда. Поднимает приложение в памяти на SQLite (:memory:),
 * прогоняет весь путь пользователя и все ключевые отказы.
 *
 * Запуск:  npm test
 * Почту настраивать не нужно — в DEV-режиме код подтверждения возвращается
 * прямо в ответе API (поле devCode) и печатается в логах.
 */

process.env.SQLITE_PATH = ':memory:';
process.env.CODE_PEPPER = 'test-pepper-not-for-production';
// Кулдаун читается модулем при загрузке, поменять его в рантайме нельзя — поэтому 5 секунд,
// прогон теста занимает меньше, и повторная отправка гарантированно попадает в окно.
process.env.RESEND_COOLDOWN_SEC = '5';
process.env.RESEND_MAX_PER_HOUR = '5';
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { app } = require('../server');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name);
  } else {
    fail += 1;
    failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  }
}

/** Клиент с собственной «банкой» cookie — fetch в Node её не хранит */
function client(base) {
  let cookie = '';
  return {
    getCookie: () => cookie,
    setCookie: (c) => { cookie = c; },
    async req(method, path, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setC.length) {
        cookie = setC.map((c) => c.split(';')[0]).join('; ');
      }
      let json = null;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = { _raw: text.slice(0, 200) }; }
      return { status: res.status, body: json };
    }
  };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const c = client(base);
  const other = client(base);

  try {
    /* ── 1. healthz ── */
    console.log('\n─── 1. Состояние сервера ───');
    const h = await c.req('GET', '/healthz');
    check('GET /healthz отвечает 200', h.status === 200, h.body);
    check('драйвер БД — sqlite (локальный режим)', h.body && h.body.db === 'sqlite', h.body);
    check('почта в DEV-режиме', h.body && h.body.mail === 'dev', h.body);
    check('каталог загружен: 5 продуктов', h.body && h.body.products === 5, h.body);

    /* ── 2. каталог ── */
    console.log('\n─── 2. Каталог ───');
    const cat = await c.req('GET', '/api/catalog?lang=ru');
    check('каталог отдаётся', cat.status === 200 && Array.isArray(cat.body.products), cat.body);
    const pot = (cat.body.products || []).find((p) => p.id === 'potassium');
    check('цены приходят числом', pot && typeof pot.plans[0].price === 'number', pot && pot.plans[0]);
    check('цена отформатирована: «899 ₽»', pot && pot.plans[0].priceText === '899\u00a0₽', pot && pot.plans[0].priceText);
    check('разряды разделены: «2 199 ₽»', pot && pot.plans[1].priceText === '2\u00a0199\u00a0₽', pot && pot.plans[1].priceText);
    const catEn = await c.req('GET', '/api/catalog?lang=en');
    const potEn = (catEn.body.products || []).find((p) => p.id === 'potassium');
    check('английские названия тарифов', potEn && potEn.plans[1].duration === 'Forever', potEn && potEn.plans[1]);

    /* ── 3. регистрация и её отказы ── */
    console.log('\n─── 3. Регистрация ───');
    const badNick = await c.req('POST', '/api/auth/register', { nickname: 'ab', email: 'a@b.ru', password: 'Passw0rd1' });
    check('короткий ник отклонён (400)', badNick.status === 400 && badNick.body.error === 'nickname_invalid', badNick.body);

    const badMail = await c.req('POST', '/api/auth/register', { nickname: 'tester', email: 'плохая-почта', password: 'Passw0rd1' });
    check('кривая почта отклонена (400)', badMail.status === 400 && badMail.body.error === 'email_invalid', badMail.body);

    const badPw = await c.req('POST', '/api/auth/register', { nickname: 'tester', email: 't@test.ru', password: '123' });
    check('короткий пароль отклонён (400)', badPw.status === 400 && badPw.body.error === 'password_short', badPw.body);

    const noDigit = await c.req('POST', '/api/auth/register', { nickname: 'tester', email: 't@test.ru', password: 'passwordonly' });
    check('пароль без цифры отклонён (400)', noDigit.status === 400 && noDigit.body.error === 'password_nodigit', noDigit.body);

    const reg = await c.req('POST', '/api/auth/register', { nickname: 'tester', email: 'T@Test.RU', password: 'Passw0rd1', locale: 'ru' });
    check('регистрация принята (201)', reg.status === 201 && reg.body.ok === true, reg.body);
    check('просят код подтверждения', reg.body.needCode === true, reg.body);
    check('код вернулся в DEV-режиме', /^\d{6}$/.test(String(reg.body.devCode || '')), reg.body.devCode);
    check('почта нормализована в нижний регистр', reg.body.email === 't@test.ru', reg.body.email);
    const code = reg.body.devCode;

    const dupMail = await other.req('POST', '/api/auth/register', { nickname: 'another', email: 't@test.ru', password: 'Passw0rd1' });
    check('занятая почта отклонена (409)', dupMail.status === 409 && dupMail.body.error === 'email_taken', dupMail.body);

    const dupNick = await other.req('POST', '/api/auth/register', { nickname: 'TESTER', email: 'new@test.ru', password: 'Passw0rd1' });
    check('занятый ник отклонён, регистр не важен (409)', dupNick.status === 409 && dupNick.body.error === 'nickname_taken', dupNick.body);

    /* ── 4. подтверждение кода ── */
    console.log('\n─── 4. Подтверждение кода ──');
    const wrong = await c.req('POST', '/api/auth/verify', { email: 't@test.ru', code: code === '000000' ? '111111' : '000000' });
    check('неверный код отклонён (400)', wrong.status === 400 && wrong.body.error === 'code_wrong', wrong.body);
    check('сообщают, сколько попыток осталось', wrong.body.attemptsLeft === 4, wrong.body);

    const meBefore = await c.req('GET', '/api/auth/me');
    check('до подтверждения сессии нет', meBefore.body.user === null, meBefore.body);

    const ver = await c.req('POST', '/api/auth/verify', { email: 't@test.ru', code, remember: true });
    check('верный код принят (200)', ver.status === 200 && ver.body.ok === true, ver.body);
    check('пользователь подтверждён', ver.body.user && ver.body.user.verified === true, ver.body.user);
    check('cookie сессии выставлена', /sprice_session=/.test(c.getCookie()), c.getCookie().slice(0, 40));
    check('в ответе нет хеша пароля', ver.body.user && !('password_hash' in ver.body.user), ver.body.user);

    const reused = await other.req('POST', '/api/auth/verify', { email: 't@test.ru', code });
    check('использованный код повторно не проходит', reused.status === 400 && reused.body.error === 'no_code', reused.body);

    /* ── 5. сессия ── */
    console.log('\n─── 5. Сессия ───');
    const me = await c.req('GET', '/api/auth/me');
    check('GET /me возвращает вошедшего', me.body.user && me.body.user.nickname === 'tester', me.body);
    const meAnon = await other.req('GET', '/api/auth/me');
    check('без cookie — пусто', meAnon.body.user === null, meAnon.body);

    /* ── 6. вход ── */
    console.log('\n─── 6. Вход ───');
    const loginBad = await other.req('POST', '/api/auth/login', { login: 'tester', password: 'WrongPass1' });
    check('неверный пароль отклонён (401)', loginBad.status === 401 && loginBad.body.error === 'invalid_credentials', loginBad.body);

    const loginNoUser = await other.req('POST', '/api/auth/login', { login: 'nobody', password: 'Passw0rd1' });
    check('несуществующий ник — тот же ответ (401)', loginNoUser.status === 401 && loginNoUser.body.error === 'invalid_credentials', loginNoUser.body);

    const loginByNick = await other.req('POST', '/api/auth/login', { login: 'tester', password: 'Passw0rd1', remember: false });
    check('вход по нику прошёл', loginByNick.status === 200 && loginByNick.body.user.nickname === 'tester', loginByNick.body);

    const other2 = client(base);
    const loginByMail = await other2.req('POST', '/api/auth/login', { login: 'T@TEST.RU', password: 'Passw0rd1' });
    check('вход по почте в верхнем регистре прошёл', loginByMail.status === 200, loginByMail.body);

    /* ── 7. заказы ── */
    console.log('\n─── 7. Заказы ───');
    const anonOrder = await client(base).req('POST', '/api/orders', { productId: 'potassium', planIdx: 0 });
    check('заказ без входа отклонён (401)', anonOrder.status === 401 && anonOrder.body.error === 'unauthorized', anonOrder.body);

    const badProduct = await c.req('POST', '/api/orders', { productId: 'несуществующий', planIdx: 0 });
    check('неизвестный продукт отклонён (400)', badProduct.status === 400 && badProduct.body.error === 'product_unknown', badProduct.body);

    const badPlan = await c.req('POST', '/api/orders', { productId: 'potassium', planIdx: 99 });
    check('несуществующий тариф отклонён (400)', badPlan.status === 400 && badPlan.body.error === 'plan_unknown', badPlan.body);

    // ключевая проверка: клиент присылает поддельную цену — сервер обязан её проигнорировать
    const order = await c.req('POST', '/api/orders', {
      productId: 'potassium', planIdx: 1, price: 1, priceText: '1 ₽', locale: 'ru'
    });
    check('заказ создан (201)', order.status === 201 && order.body.ok === true, order.body);
    check('ЦЕНА ВЗЯТА С СЕРВЕРА, а не из запроса', order.body.order.price === 2199, order.body.order);
    check('название тарифа на русском', order.body.order.planDuration === 'Навсегда', order.body.order);

    const dedup = await c.req('POST', '/api/orders', { productId: 'potassium', planIdx: 1, locale: 'ru' });
    check('повторный заказ в окне не дублируется', dedup.body.deduped === true, dedup.body);

    const orderEn = await c.req('POST', '/api/orders', { productId: 'vector', planIdx: 0, locale: 'en' });
    check('заказ на английском отдаёт английский тариф', orderEn.body.order.planDuration === '7 Days', orderEn.body.order);

    const listRu = await c.req('GET', '/api/orders?lang=ru');
    check('список заказов: 2 штуки', listRu.body.orders.length === 2, listRu.body.orders.length);
    check('заказы приходят с русскими тарифами', listRu.body.orders.some((o) => o.planDuration === 'Навсегда'), listRu.body.orders);

    const listEn = await c.req('GET', '/api/orders?lang=en');
    check('тот же список на английском', listEn.body.orders.some((o) => o.planDuration === 'Forever'), listEn.body.orders);

    /* ── 8. профиль ── */
    console.log('\n─── 8. Профиль ──');
    const prof = await c.req('GET', '/api/profile?lang=ru');
    check('профиль отдаётся', prof.status === 200 && prof.body.ok === true, prof.body);
    check('счётчик заказов = 2', prof.body.stats.orders === 2, prof.body.stats);
    check('сумма посчитана сервером: 2448 ₽', prof.body.stats.spent === 2448, prof.body.stats);
    check('сумма отформатирована', prof.body.stats.spentText === '2\u00a0448\u00a0₽', prof.body.stats.spentText);
    check('дней с нами минимум 1', prof.body.stats.days >= 1, prof.body.stats);
    check('почта подтверждена', prof.body.user.verified === true, prof.body.user);

    const anonProf = await client(base).req('GET', '/api/profile');
    check('профиль без входа отклонён (401)', anonProf.status === 401, anonProf.body);

    /* ── 9. антифлуд повторных писем ── */
    console.log('\n─── 9. Защита от флуда письмами ──');
    const again = await c.req('POST', '/api/auth/resend', { email: 't@test.ru', purpose: 'verify' });
    check('повторная отправка раньше времени отклонена (429)', again.status === 429 && again.body.error === 'too_soon', again.body);
    check('сообщают, через сколько секунд можно', typeof again.body.retryAfter === 'number' && again.body.retryAfter > 0, again.body);

    const unknownMail = await client(base).req('POST', '/api/auth/resend', { email: 'нет@такого.ru' });
    check('на незнакомый адрес отвечают так же (без перечисления базы)', unknownMail.status === 200 && unknownMail.body.ok === true, unknownMail.body);

    /* ── 10. выход ── */
    console.log('\n─── 10. Выход ───');
    const out = await c.req('POST', '/api/auth/logout');
    check('выход прошёл', out.status === 200 && out.body.ok === true, out.body);
    const afterOut = await c.req('GET', '/api/auth/me');
    check('после выхода сессии нет', afterOut.body.user === null, afterOut.body);

    /* ── 11. сброс пароля ── */
    console.log('\n─── 11. Сброс пароля ───');
    const rc = client(base);
    const req1 = await rc.req('POST', '/api/auth/reset/request', { email: 't@test.ru', locale: 'ru' });
    check('запрос сброса принят', req1.status === 200 && /^\d{6}$/.test(String(req1.body.devCode || '')), req1.body);
    const resetCode = req1.body.devCode;

    const resetBad = await rc.req('POST', '/api/auth/reset/confirm', { email: 't@test.ru', code: '000000', password: 'NewPass123' });
    check('неверный код сброса отклонён', resetBad.status === 400 && resetBad.body.error === 'code_wrong', resetBad.body);

    const resetOk = await rc.req('POST', '/api/auth/reset/confirm', { email: 't@test.ru', code: resetCode, password: 'NewPass123' });
    check('пароль сброшен по коду', resetOk.status === 200 && resetOk.body.ok === true, resetOk.body);

    const oldPw = await client(base).req('POST', '/api/auth/login', { login: 'tester', password: 'Passw0rd1' });
    check('старый пароль больше не работает', oldPw.status === 401, oldPw.body);

    const newPw = await client(base).req('POST', '/api/auth/login', { login: 'tester', password: 'NewPass123' });
    check('новый пароль работает', newPw.status === 200, newPw.body);

    /* ── 12. защита маршрутов ── */
    console.log('\n─── 12. Прочее ───');
    const nf = await client(base).req('GET', '/api/неизвестный');
    check('неизвестный API-путь → 404 JSON', nf.status === 404 && nf.body.error === 'not_found', nf.body);

    const head = await fetch(base + '/');
    check('главная страница отдаётся', head.status === 200, head.status);
    const html = await head.text();
    check('в HTML есть сайт Sprice Private', html.includes('Sprice Private'), html.length);
    check('заголовок безопасности nosniff', head.headers.get('x-content-type-options') === 'nosniff');
    check('версия Express не раскрывается', head.headers.get('x-powered-by') === null);
  } catch (e) {
    fail += 1;
    failures.push('ИСКЛЮЧЕНИЕ: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n'));
    console.log('\nИСКЛЮЧЕНИЕ: ' + e.message);
    console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  } finally {
    server.close();
  }

  console.log('\n' + '═'.repeat(52));
  console.log('  пройдено: ' + pass + '   провалено: ' + fail);
  if (fail) {
    console.log('\n  Провалы:');
    failures.forEach((f) => console.log('   • ' + f));
  }
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
