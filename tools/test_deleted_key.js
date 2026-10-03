'use strict';

// Проверка того самого бага: ключ удалили в панели, а сайт продолжал писать
// «осталось 7 дней». Панель на удалённый ключ отвечает 404 {"ok":false,
// "error":"not_found"} — это НЕ то же самое, что «панель недоступна».
//
// Запуск:  node tools/test_deleted_key.js

process.env.PANEL_URL = process.env.PANEL_URL || 'https://panel.test';
process.env.PANEL_SECRET = process.env.PANEL_SECRET || 'test-secret';

const licensing = require('../src/licensing');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name);
  } else {
    fail++;
    console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : ''));
  }
}

// Ответ панели подменяем целиком: настоящий panel.test недоступен.
let panelHandler = () => ({ status: 200, body: { ok: true } });

global.fetch = async () => {
  const r = panelHandler();
  return {
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    json: async () => r.body
  };
};

const inDays = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return (
    d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds())
  );
};

// Строка БД — снимок на момент покупки: ключ «активен», до конца 7 дней.
const row = {
  id: 'lic-1',
  key: 'SPR-AAAA-BBBB-CCCC',
  product_id: 'spriceoverlay',
  game: 'cs2',
  status: 'active',
  funpay_code: 'ORDER-1',
  activated_at: '2026-09-01 10:00:00',
  created_at: '2026-09-01 10:00:00',
  expires_at: inDays(7)
};

(async () => {
  console.log('\n─── 1. Ключ удалён в панели (404 not_found) ───');
  {
    panelHandler = () => ({ status: 404, body: { ok: false, error: 'not_found' } });
    const live = await licensing.liveLicenseInfo(row.key);
    ok('liveLicenseInfo помечает ключ как отсутствующий', !!(live && live.missing), JSON.stringify(live));

    const v = licensing.licenseView(row, 'ru', live);
    ok('статус = deleted (а не active)', v.status === 'deleted', v.status);
    ok('флаг deleted выставлен', v.deleted === true);
    ok('срок обнулён, а не «7 дней»', v.expiresAt === '', JSON.stringify(v.expiresAt));
    ok('daysLeft = -1 (не 7)', v.daysLeft === -1, String(v.daysLeft));
    ok('lifetime = false', v.lifetime === false);
    ok('live = false', v.live === false);
  }

  console.log('\n─── 2. Панель недоступна (нет связи) ───');
  {
    panelHandler = () => { throw new Error('ECONNREFUSED'); };
    const live = await licensing.liveLicenseInfo(row.key);
    ok('liveLicenseInfo вернул null, а не «удалён»', live === null, JSON.stringify(live));

    const v = licensing.licenseView(row, 'ru', live);
    ok('остаёмся на данных БД: статус active', v.status === 'active', v.status);
    ok('daysLeft сохранился (7)', v.daysLeft === 7, String(v.daysLeft));
    ok('deleted = false', v.deleted === false);
  }

  console.log('\n─── 3. Панель ответила: ключ выключен тумблером ───');
  {
    panelHandler = () => ({
      status: 200,
      body: { ok: true, key: row.key, game: 'cs2', active: 0, expires_at: inDays(7), hwid: 'ABC' }
    });
    const live = await licensing.liveLicenseInfo(row.key);
    const v = licensing.licenseView(row, 'ru', live);
    ok('статус = disabled', v.status === 'disabled', v.status);
    ok('deleted = false (это не удаление)', v.deleted === false);
  }

  console.log('\n─── 4. Панель ответила: ключ продлили до 30 дней ───');
  {
    panelHandler = () => ({
      status: 200,
      body: { ok: true, key: row.key, game: 'cs2', active: 1, expires_at: inDays(30), hwid: 'ABC' }
    });
    const live = await licensing.liveLicenseInfo(row.key);
    const v = licensing.licenseView(row, 'ru', live);
    ok('статус = active', v.status === 'active', v.status);
    ok('дни взяты из панели (30), а не из БД (7)', v.daysLeft === 30, String(v.daysLeft));
    ok('live = true', v.live === true);
  }

  console.log('\n─── 5. Заявка ещё не выдана (PENDING-…) ───');
  {
    let called = 0;
    panelHandler = () => { called++; return { status: 404, body: { ok: false, error: 'not_found' } }; };
    const pend = Object.assign({}, row, { key: 'PENDING-ab12cd34', status: 'pending', expires_at: null });
    const live = await licensing.liveLicenseInfo(pend.key);
    ok('PENDING не считается удалённым', live === null, JSON.stringify(live));
    ok('панель по PENDING даже не опрашивается', called === 0, 'вызовов: ' + called);

    const v = licensing.licenseView(pend, 'ru', live);
    ok('статус остаётся pending', v.status === 'pending', v.status);
  }

  console.log('\n' + '='.repeat(52));
  console.log('  пройдено: ' + pass + '   провалено: ' + fail);
  console.log('='.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('тест упал: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
