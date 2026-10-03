'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PANEL_PORT = 8791;
const APP_PORT = 8792;
const CDP_PORT = 9362;
const BASE = 'http://127.0.0.1:' + APP_PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else {
    fail++;
    failures.push(name + (extra !== undefined ? ' \u2192 ' + JSON.stringify(extra) : ''));
    console.log('  \u2717 ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  }
}

const panelKeys = new Map();
let seq = 0;

function inDays(n) {
  const d = new Date(Date.now() + n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function seedKey(key, game, days, owner) {
  panelKeys.set(key, {
    key,
    game,
    active: 1,
    expires_at: inDays(days == null ? 30 : days),
    owner_login: owner || ''
  });
}

function startPanel() {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) {}
      const url = new URL(req.url, 'http://127.0.0.1:' + PANEL_PORT);
      if (url.pathname === '/api/issue_key') {
        const key = 'SPR-UI-' + String(++seq).padStart(3, '0');
        seedKey(key, body.game, body.days > 0 ? body.days : 30, body.owner);
        return send(200, { ok: true, key, game: body.game, days: body.days });
      }
      if (url.pathname === '/api/key_info') {
        const k = panelKeys.get(url.searchParams.get('key') || '');
        if (!k) return send(404, { ok: false, error: 'not_found' });
        return send(200, { ok: true, key: k.key, game: k.game, active: k.active, expires_at: k.expires_at, hwid: '' });
      }
      if (url.pathname === '/api/bind_key') {
        const k = panelKeys.get(body.key);
        if (!k) return send(404, { ok: false, error: 'key_not_found' });
        if (k.active !== 1) return send(403, { ok: false, error: 'key_disabled' });
        if (k.owner_login && k.owner_login !== body.owner) return send(409, { ok: false, error: 'key_already_bound' });
        k.owner_login = body.owner;
        return send(200, { ok: true, key: k.key, game: k.game, expires_at: k.expires_at, bound: true });
      }
      return send(404, { ok: false, error: 'not_found' });
    });
  });
  return new Promise((r) => srv.listen(PANEL_PORT, '127.0.0.1', () => r(srv)));
}

let serverOut = '';
const DB_FILE = path.join(os.tmpdir(), 'sprice-uigate-' + Date.now() + '.db');

function startApp() {
  return spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT),
      SQLITE_PATH: DB_FILE,
      CODE_PEPPER: 'ui-gate-pepper',
      NODE_ENV: 'test',
      PANEL_URL: 'http://127.0.0.1:' + PANEL_PORT,
      PANEL_SECRET: 'ui-secret',
      FUNPAY_DEV_ACCEPT: '1',
      DATABASE_URL: '',
      RESEND_API_KEY: '',
      SMTP_HOST: '',
      FUNPAY_GOLDEN_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function assertPortFree(port) {
  return new Promise((resolve) => {
    const srv = require('node:net').createServer();
    srv.once('error', (e) => resolve(e.code !== 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const myId = ++id; pending.set(myId, { res, rej });
          ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
          setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); } }, 40000);
        });
      },
      close() { ws.close(); }
    }));
  });
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      const pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) return pg.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(400);
  }
  throw new Error('CDP target не найден');
}

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await sleep(50); }
    return false;
  };
`;

async function run(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    return { __error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  }
  return r.result.value;
}

function apiClient() {
  let cookie = '';
  return {
    cookie: () => cookie,
    async req(method, p, body) {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) { json = { _raw: text.slice(0, 200) }; }
      return { status: res.status, body: json };
    }
  };
}

(async () => {
  let panel = null, app = null, chrome = null, client = null, profile = null;
  try {
    for (const p of [PANEL_PORT, APP_PORT, CDP_PORT]) {
      if (!(await assertPortFree(p))) {
        console.log('\nПорт ' + p + ' занят — останови прошлый прогон или предпросмотр и запусти снова.\n');
        process.exit(1);
      }
    }

    panel = await startPanel();
    app = startApp();
    app.stdout.on('data', (d) => { serverOut += d.toString(); });
    app.stderr.on('data', (d) => { serverOut += d.toString(); });

    let up = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) { up = true; break; } } catch (e) {}
      await sleep(300);
    }
    if (!up) { console.log('сервер не поднялся:\n' + serverOut.slice(-1200)); process.exit(1); }

    const c = apiClient();
    const reg = await c.req('POST', '/api/auth/register', { nickname: 'uigate', email: 'uigate@test.ru', password: 'Passw0rd1', locale: 'ru' });
    const codes = serverOut.match(/КОД:\s*(\d{6})/g) || [];
    const devCode = reg.body.devCode || (codes.length ? codes[codes.length - 1].replace(/\D/g, '') : null);
    const ver = await c.req('POST', '/api/auth/verify', { email: 'uigate@test.ru', code: devCode, remember: true });
    const sessionCookie = c.cookie();

    console.log('\n─── 1. Аккаунт и браузер ───');
    check('аккаунт подтверждён', ver.status === 200 && ver.body.user.verified === true, ver.body);
    check('сессия получена', /sprice_session=/.test(sessionCookie), sessionCookie.slice(0, 30));

    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sprice-uigate-chrome-'));
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--window-size=1440,1000',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
    ], { stdio: 'ignore' });
    client = await cdp(await findTarget());
    const { send } = client;
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    await send('Network.setCookie', {
      name: sessionCookie.split('=')[0],
      value: sessionCookie.slice(sessionCookie.indexOf('=') + 1),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    });

    await send('Page.navigate', { url: BASE + '/' });
    await sleep(3500);
    await run(send, `window.__errs = []; window.addEventListener('error', e => window.__errs.push(e.message + ' @' + e.lineno)); 'ok'`);

    console.log('\n─── 2. Пока подписки нет, оплата Roblox открыта ───');
    const before = await run(send, `(async () => { ${HELPERS}
      q('[data-product=potassium]').click();
      await waitFor(() => $('purchaseModal').classList.contains('active'));
      await sleep(900);
      return JSON.stringify({
        cards: document.querySelectorAll('[data-product]').length,
        locked: $('modalPay').classList.contains('is-locked'),
        href: $('modalPay').getAttribute('href') || 'нет'
      });
    })()`);
    check('модалка открылась без ошибок JS', before && !before.__error, before);
    const b1 = before && !before.__error ? JSON.parse(before) : {};
    check('шесть карточек продуктов', b1.cards === 6, b1.cards);
    check('кнопка оплаты разблокирована', b1.locked === false, b1);
    check('у кнопки есть ссылка на FunPay', /funpay/.test(b1.href || ''), b1.href);

    console.log('\n─── 3. Выдаём активную подписку на Roblox ───');
    const act = await c.req('POST', '/api/keys/activate', { code: 'ORDER-UI-ROB', productId: 'potassium', planIdx: 1, locale: 'ru' });
    check('подписка выдана (201)', act.status === 201 && act.body.license.game === 'roblox', act.body);

    console.log('\n─── 4. Повторная оплата Roblox закрыта ───');
    const after = await run(send, `(async () => { ${HELPERS}
      $('modalClose').click();
      await sleep(400);
      q('[data-product=vector]').click();
      await waitFor(() => $('purchaseModal').classList.contains('active'));
      await waitFor(() => $('modalPay').classList.contains('is-locked'), 9000);
      await sleep(400);
      const blocked = {
        locked: $('modalPay').classList.contains('is-locked'),
        aria: $('modalPay').getAttribute('aria-disabled'),
        href: $('modalPay').getAttribute('href') || 'нет',
        hint: $('modalAuthHintText').textContent
      };
      $('modalPay').click();
      await sleep(900);
      return JSON.stringify({
        blocked,
        toast: $('toasts') ? $('toasts').textContent : '',
        stillOpen: $('purchaseModal').classList.contains('active')
      });
    })()`);
    check('проверка прошла без ошибок JS', after && !after.__error, after);
    const a4 = after && !after.__error ? JSON.parse(after) : {};
    const ab = a4.blocked || {};
    check('кнопка оплаты заблокирована', ab.locked === true && ab.aria === 'true', ab);
    check('ссылка на оплату снята', ab.href === 'нет', ab.href);
    check('подсказка объясняет причину', /активн.*подписк/i.test(ab.hint || ''), ab.hint);
    check('клик по оплате показывает уведомление', /активн.*подписк/i.test(a4.toast || ''), a4.toast);
    check('модалка не закрылась и на FunPay не ушла', a4.stillOpen === true, a4.stillOpen);

    console.log('\n─── 5. CS2 — другая игра, оплата открыта ───');
    const cs2 = await run(send, `(async () => { ${HELPERS}
      $('modalClose').click();
      await sleep(400);
      q('[data-product=spriceoverlaycs2]').click();
      await waitFor(() => $('purchaseModal').classList.contains('active'));
      await sleep(1200);
      return JSON.stringify({
        locked: $('modalPay').classList.contains('is-locked'),
        href: $('modalPay').getAttribute('href') || 'нет'
      });
    })()`);
    check('проверка CS2 без ошибок JS', cs2 && !cs2.__error, cs2);
    const c5 = cs2 && !cs2.__error ? JSON.parse(cs2) : {};
    check('CS2-оплата открыта (roblox не мешает)', c5.locked === false, c5);
    check('у CS2-кнопки есть ссылка', /funpay/.test(c5.href || ''), c5.href);

    console.log('\n─── 6. Окно активации ключа ───');
    seedKey('SPR-UI-ROB-KEY', 'roblox', 30, '');
    seedKey('SPR-UI-CS2-KEY', 'cs2', 30, '');
    const claim = await run(send, `(async () => { ${HELPERS}
      $('modalClose').click();
      await sleep(300);
      $('profActivate').click();
      await waitFor(() => $('claimModal').classList.contains('active'));
      await sleep(300);
      $('claimInput').value = 'SPR-UI-ROB-KEY';
      $('claimSubmit').click();
      await waitFor(() => $('claimErr').hidden === false, 9000);
      await sleep(300);
      const robErr = $('claimErr').textContent;
      $('claimInput').value = 'SPR-UI-CS2-KEY';
      $('claimSubmit').click();
      await sleep(2500);
      const afterClaim = {
        modalOpen: $('claimModal').classList.contains('active'),
        toast: $('toasts') ? $('toasts').textContent : ''
      };
      const probe = await fetch('/api/keys/mine?lang=ru', { credentials: 'same-origin' })
        .then(r => r.json()).catch(e => ({ err: String(e) }));
      return JSON.stringify({ robErr, afterClaim, probe });
    })()`);
    check('окно активации отработало без ошибок JS', claim && !claim.__error, claim);
    const c6 = claim && !claim.__error ? JSON.parse(claim) : {};
    check('roblox-ключ отклонён с понятным текстом', /активн.*подписк/i.test(c6.robErr || ''), c6.robErr);
    check('cs2-ключ принят, окно закрылось', (c6.afterClaim || {}).modalOpen === false, c6.afterClaim);
    check('уведомление об активации показано', /активирован|подтвержд/i.test(((c6.afterClaim || {}).toast) || ''), (c6.afterClaim || {}).toast);
    const games = (((c6.probe || {}).licenses) || []).map((l) => l.game).sort().join(',');
    check('в кабинете ровно roblox + cs2', games === 'cs2,roblox', games);
    check('ключ cs2 закреплён на панели', (panelKeys.get('SPR-UI-CS2-KEY') || {}).owner_login === 'uigate', panelKeys.get('SPR-UI-CS2-KEY'));
    check('roblox-ключ остался свободным', (panelKeys.get('SPR-UI-ROB-KEY') || {}).owner_login === '', panelKeys.get('SPR-UI-ROB-KEY'));

    console.log('\n─── 7. Ошибки JS за всю сессию ───');
    const errs = await run(send, 'JSON.stringify(window.__errs || [])');
    const parsed = errs && !errs.__error ? JSON.parse(errs) : ['<не прочиталось>'];
    check('в консоли страницы нет исключений', parsed.length === 0, parsed);
  } catch (e) {
    fail++;
    failures.push('ИСКЛЮЧЕНИЕ: ' + e.message);
    console.log('\nИСКЛЮЧЕНИЕ: ' + e.message);
    console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  } finally {
    try { if (client) client.close(); } catch (e) {}
    try { if (chrome) chrome.kill(); } catch (e) {}
    try { if (app) app.kill(); } catch (e) {}
    try { if (panel) panel.close(); } catch (e) {}
    await sleep(600);
    for (const f of [DB_FILE, DB_FILE + '-shm', DB_FILE + '-wal']) {
      try { fs.rmSync(f, { force: true }); } catch (e) {}
    }
    if (profile) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
    }
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
