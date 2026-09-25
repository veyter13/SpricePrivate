'use strict';

/**
 * Сквозной тест ФРОНТЕНДА: настоящий сервер + настоящий Chrome через CDP.
 *
 * Проверяет то, что не видно из тестов API: что формы реально отправляются,
 * что шаг с кодом появляется, что сессия переживает перезагрузку, что заказ
 * попадает в профиль, и что в консоли браузера нет ошибок.
 *
 * Запуск: node test/frontend.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9361;
const APP_PORT = 8781;
const BASE = 'http://127.0.0.1:' + APP_PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    failures.push(name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
    console.log('  ✗ ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  }
}

/* ── запуск приложения ── */
const dbFile = path.join(os.tmpdir(), 'sprice-fe-' + Date.now() + '.db');
let serverOut = '';
let app = null;

/**
 * Порт обязан быть свободен ДО старта.
 *
 * Иначе тест подключается к чужому серверу (например, к оставленному висеть
 * серверу предпросмотра), читает чужую базу и падает совершенно непонятно:
 * свой сервер не может занять порт, `serverOut` пустой, «кода нет в логе»,
 * регистрация уходит не туда. Лучше упасть сразу и с внятным текстом.
 */
function assertPortFree(port) {
  return new Promise((resolve) => {
    const srv = require('node:net').createServer();
    srv.once('error', (e) => resolve(e.code !== 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function startApp() {
  app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT),
      SQLITE_PATH: dbFile,
      CODE_PEPPER: 'frontend-test-pepper',
      NODE_ENV: 'test',
      RESEND_COOLDOWN_SEC: '2',
      DATABASE_URL: '',
      RESEND_API_KEY: '',
      SMTP_HOST: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  app.stdout.on('data', (d) => { serverOut += d.toString(); });
  app.stderr.on('data', (d) => { serverOut += d.toString(); });
}

/** Последний код подтверждения из логов сервера (DEV-режим почты) */
function lastCode() {
  const all = serverOut.match(/КОД:\s*(\d{6})/g) || [];
  if (!all.length) return null;
  return all[all.length - 1].replace(/\D/g, '');
}

/* ── CDP ── */
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0; const pending = new Map(); const events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else if (m.method) events.push(m);
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => resolve({
      events,
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

/** Общая обвязка для скриптов на странице */
const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const q = (s) => document.querySelector(s);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
  const submit = (f) => f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  /* Ждём, пока условие станет истинным — вместо слепых пауз.
     Возвращает true/false, не бросает. */
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (fn()) return true; } catch (e) {}
      await sleep(50);
    }
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

(async () => {
  let client = null;
  let chrome = null;

  /* Порт проверяем ДО старта — иначе тест незаметно уйдёт на чужой сервер */
  if (!(await assertPortFree(APP_PORT))) {
    console.log('\nПорт ' + APP_PORT + ' уже занят.');
    console.log('Скорее всего остался висеть сервер предпросмотра или прошлый прогон.');
    console.log('Останови его и запусти тест снова — иначе результаты будут врать.\n');
    process.exit(1);
  }
  startApp();

  try {
    /* ждём старта приложения */
    let up = false;
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) { up = true; break; } } catch (e) {}
      await sleep(300);
    }
    if (!up) { console.log('Сервер не поднялся:\n' + serverOut.slice(-1500)); process.exit(1); }
    console.log('\n─── 0. Сервер поднят ───');
    check('приложение отвечает на /healthz', true);

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sprice-chrome-'));
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--window-size=1440,1000',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, 'about:blank'
    ], { stdio: 'ignore' });

    client = await cdp(await findTarget());
    const { send, events } = client;
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');

    /* ошибки JS на странице ловим напрямую, а не только через Log */
    const PAGE_ERRORS = [];
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(3000);
    await run(send, `window.__errs = []; window.addEventListener('error', e => window.__errs.push(e.message + ' @' + e.lineno)); 'ok'`);

    /* ── 1. загрузка ── */
    console.log('\n─── 1. Загрузка страницы ───');
    const boot = await run(send, `(() => { ${HELPERS}
      return JSON.stringify({
        title: document.title,
        cards: document.querySelectorAll('[data-detail]').length,
        authOpenVisible: !$('authOpen').hidden,
        userMenuHidden: $('userMenu').hidden
      });
    })()`);
    check('страница загрузилась', boot && !boot.__error, boot);
    const b = boot && !boot.__error ? JSON.parse(boot) : {};
    check('5 карточек продуктов', b.cards === 5, b.cards);
    check('кнопка «Войти» видна, меню скрыто', b.authOpenVisible === true && b.userMenuHidden === true, b);

    /* ── 2. регистрация ── */
    console.log('\n─── 2. Регистрация через форму ───');
    const reg = await run(send, `(async () => { ${HELPERS}
      $('authOpen').click();
      await waitFor(() => $('authModal').classList.contains('active'));
      $('tabReg').click();
      await sleep(300);
      setVal($('regName'), 'frontuser');
      setVal($('regMail'), 'front@test.ru');
      setVal($('regPw'), 'FrontPass1');
      setVal($('regPw2'), 'FrontPass1');
      await sleep(150);
      submit($('regForm'));
      /* ждём именно появления панели кода, а не фиксированную паузу */
      const shown = await waitFor(() => !$('codeForm').hidden, 8000);
      await sleep(300);
      return JSON.stringify({
        shown,
        codeVisible: !$('codeForm').hidden,
        loginHidden: $('loginForm').hidden,
        regHidden: $('regForm').hidden,
        tabsHidden: document.querySelector('#authCard .auth__tabs').hidden,
        sub: $('authSub').textContent,
        lead: $('codeLead').textContent.slice(0, 80),
        cells: document.querySelectorAll('[data-code-cell]').length,
        btn: $('codeBtn').textContent,
        resend: $('codeResend').textContent
      });
    })()`);
    check('регистрация прошла без ошибок JS', reg && !reg.__error, reg);
    const r2 = reg && !reg.__error ? JSON.parse(reg) : {};
    check('появился шаг ввода кода', r2.codeVisible === true, r2);
    check('формы входа и регистрации скрыты', r2.loginHidden === true && r2.regHidden === true, r2);
    check('вкладки скрыты на шаге кода', r2.tabsHidden === true, r2);
    check('6 ячеек для цифр', r2.cells === 6, r2.cells);
    check('в подсказке указана почта', /front@test\.ru/.test(r2.lead || ''), r2.lead);
    check('кнопка подтверждения', r2.btn === 'Подтвердить', r2.btn);
    check('таймер повторной отправки идёт', /Заново через \d+ с/.test(r2.resend || ''), r2.resend);

    /* ── 3. письмо с кодом ── */
    console.log('\n─── 3. Письмо с кодом ───');
    const code = lastCode();
    check('сервер сформировал код (письмо в DEV-режиме)', /^\d{6}$/.test(String(code)), code);
    check('в логе есть письмо для нашей почты', /кому: front@test\.ru/.test(serverOut), true);

    /* ── 4. неверный код ── */
    console.log('\n─── 4. Неверный код ───');
    const wrong = await run(send, `(async () => { ${HELPERS}
      const cells = [...document.querySelectorAll('[data-code-cell]')];
      const bad = ${JSON.stringify(String(code))} === '000000' ? '111111' : '000000';
      cells.forEach((c, i) => { c.value = bad[i]; c.dispatchEvent(new Event('input', { bubbles: true })); });
      /* автоподстановка отправляет форму сама; ждём появления ошибки */
      await waitFor(() => !$('codeErr').hidden, 8000);
      await sleep(250);
      return JSON.stringify({
        stillOnCode: !$('codeForm').hidden,
        modalOpen: $('authModal').classList.contains('active'),
        errShown: !$('codeErr').hidden,
        errText: $('codeErrText').textContent,
        cellsEmpty: cells.every(c => !c.value)
      });
    })()`);
    check('неверный код не пускает дальше', wrong && !wrong.__error, wrong);
    const w = wrong && !wrong.__error ? JSON.parse(wrong) : {};
    check('остались на шаге кода', w.stillOnCode === true && w.modalOpen === true, w);
    check('показана ошибка про неверный код', w.errShown === true && /Неверный код/.test(w.errText || ''), w.errText);
    check('ячейки очищены после ошибки', w.cellsEmpty === true, w);

    /* ── 5. верный код ── */
    console.log('\n─── 5. Верный код ──');
    const ok = await run(send, `(async () => { ${HELPERS}
      const cells = [...document.querySelectorAll('[data-code-cell]')];
      const good = ${JSON.stringify(String(code))};
      cells.forEach((c, i) => { c.value = good[i]; c.dispatchEvent(new Event('input', { bubbles: true })); });
      await waitFor(() => !$('userMenu').hidden, 10000);
      await sleep(400);
      return JSON.stringify({
        modalClosed: !$('authModal').classList.contains('active'),
        loggedIn: !$('userMenu').hidden,
        authBtnHidden: $('authOpen').hidden,
        nick: $('userNm').textContent,
        mail: $('dropMail').textContent,
        toast: $('toasts').textContent.trim()
      });
    })()`);
    check('подтверждение принято', ok && !ok.__error, ok);
    const o = ok && !ok.__error ? JSON.parse(ok) : {};
    check('модалка закрылась', o.modalClosed === true, o);
    check('вошли в аккаунт', o.loggedIn === true, o);
    check('кнопка «Войти» скрыта', o.authBtnHidden === true, o);
    check('в шапке правильный ник', o.nick === 'frontuser', o.nick);
    check('в меню правильная почта', o.mail === 'front@test.ru', o.mail);
    check('показан тост о создании аккаунта', /Аккаунт создан/.test(o.toast || '') && /frontuser/.test(o.toast || ''), o.toast);

    /* ── 6. сессия после перезагрузки ── */
    console.log('\n─── 6. Сессия после перезагрузки ───');
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(3000);
    const sess = await run(send, `(async () => { ${HELPERS}
      await waitFor(() => !$('userMenu').hidden, 8000);
      return JSON.stringify({
        loggedIn: !$('userMenu').hidden,
        nick: $('userNm').textContent,
        tokenInStorage: Object.keys(localStorage).filter(k => /session|token/i.test(k)).join(',') || 'нет',
        cookiesReadable: document.cookie || 'пусто'
      });
    })()`);
    check('сессия восстановлена', sess && !sess.__error, sess);
    const s6 = sess && !sess.__error ? JSON.parse(sess) : {};
    check('после перезагрузки всё ещё вошли', s6.loggedIn === true, s6);
    check('ник подтянулся', s6.nick === 'frontuser', s6.nick);
    check('ТОКЕНА НЕТ в localStorage', s6.tokenInStorage === 'нет', s6.tokenInStorage);
    check('cookie сессии недоступна из JS (httpOnly)', s6.cookiesReadable === 'пусто', s6.cookiesReadable);

    /* ── 7. заказ ── */
    console.log('\n─── 7. Заказ ───');
    const order = await run(send, `(async () => { ${HELPERS}
      q('[data-product=matrixhub]').click();
      await waitFor(() => $('purchaseModal').classList.contains('active'));
      await sleep(300);
      const plans = [...document.querySelectorAll('.plan__dur')].map(e => e.textContent).join('/');
      const hint = $('modalAuthHintText').textContent;
      $('modalPay').click();
      /* ждём, пока счётчик заказов в меню обновится (значит POST /api/orders прошёл) */
      await waitFor(() => $('dropOrders').textContent === '1', 10000);
      $('modalClose').click();
      await sleep(400);
      return JSON.stringify({ plans, hint, badge: $('dropOrders').textContent });
    })()`);
    check('заказ оформлен без ошибок JS', order && !order.__error, order);
    const or = order && !order.__error ? JSON.parse(order) : {};
    check('в модалке видны тарифы', /1 Месяц/.test(or.plans || ''), or.plans);
    check('подсказка для вошедшего', /frontuser/.test(or.hint || ''), or.hint);
    check('счётчик заказов в меню обновился', or.badge === '1', or.badge);

    /* ── 8. профиль ── */
    console.log('\n─── 8. Профиль ───');
    const prof = await run(send, `(async () => { ${HELPERS}
      $('userBtn').click();
      await sleep(300);
      $('dropProfile').click();
      await waitFor(() => $('profileModal').classList.contains('active') && q('#orderList .order'), 8000);
      await sleep(300);
      const row = q('#orderList .order');
      return JSON.stringify({
        open: $('profileModal').classList.contains('active'),
        name: $('profileName').textContent,
        mail: $('profMail').textContent,
        orders: $('profOrders').textContent,
        spent: $('profSpent').textContent,
        days: $('profDays').textContent,
        orderName: row ? row.querySelector('.order__b b').textContent : '—',
        orderMeta: row ? row.querySelector('.order__b span').textContent : '—',
        orderPrice: row ? row.querySelector('.order__p').textContent : '—'
      });
    })()`);
    check('профиль открылся', prof && !prof.__error, prof);
    const p8 = prof && !prof.__error ? JSON.parse(prof) : {};
    check('в профиле правильный ник', p8.name === 'frontuser', p8.name);
    check('счётчик заказов = 1', p8.orders === '1', p8.orders);
    check('сумма посчитана сервером', p8.spent === '299\u00a0₽', p8.spent);
    check('дней с нами минимум 1', Number(p8.days) >= 1, p8.days);
    check('заказ MatrixHub в списке', p8.orderName === 'MatrixHub', p8.orderName);
    check('тариф и дата у заказа', /1 Месяц · /.test(p8.orderMeta || ''), p8.orderMeta);
    check('цена заказа', p8.orderPrice === '299\u00a0₽', p8.orderPrice);

    /* ── 9. английский язык ── */
    console.log('\n─── 9. Английский язык ──');
    const en = await run(send, `(async () => { ${HELPERS}
      const btn = q('.lang-switch__btn[data-lang=en]');
      const hadHandler = !!btn;
      btn.click();
      /* ждём, пока язык реально применится к документу */
      const applied = await waitFor(() => document.documentElement.lang === 'en', 5000);
      await sleep(500);
      const row = q('#orderList .order');
      return JSON.stringify({
        hadHandler,
        applied,
        lang: document.documentElement.lang,
        enBtnActive: q('.lang-switch__btn[data-lang=en]').classList.contains('active'),
        orderName: row ? row.querySelector('.order__b b').textContent : '—',
        orderMeta: row ? row.querySelector('.order__b span').textContent : '—',
        ordersLabel: document.querySelector('.profile__stat span').textContent,
        /* статические заглушки скрытых панелей тоже должны переводиться */
        staticTitles: { detailTitle: $('detailTitle').textContent, authSub: $('authSub').textContent },
        cyr: (() => {
          const skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1 };
          /* Считаем только ВИДИМЫЙ текст: скрытые панели (модалка покупки,
             карточка авторизации, страница продукта) держат текст, отрисованный
             в прошлом языке, и перерисовываются при следующем открытии —
             это не видно пользователю. Тост-контейнер транзитный: уже
             показанный тост язык не меняет. */
          const toasts = document.getElementById('toasts');
          const visible = (el) => {
            if (toasts && toasts.contains(el)) return false;
            if (typeof el.checkVisibility === 'function') {
              return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            }
            return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          };
          const out = [];
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) {
            const p = n.parentNode;
            if (!p || skip[p.nodeName]) continue;
            const txt = n.nodeValue.trim();
            if (txt && /[\\u0400-\\u04FF]/.test(txt) && visible(p)) {
              out.push((p.className || p.nodeName) + ': ' + txt.slice(0, 45));
            }
          }
          return out;
        })()
      });
    })()`);
    check('перевод профиля без ошибок', en && !en.__error, en);
    const e9 = en && !en.__error ? JSON.parse(en) : {};
    check('переключатель языка сработал', e9.applied === true && e9.lang === 'en', e9);
    check('активна кнопка EN', e9.enBtnActive === true, e9.enBtnActive);
    check('название заказа на английском', e9.orderName === 'MatrixHub', e9.orderName);
    check('тариф переведён на английский', /1 Month · /.test(e9.orderMeta || ''), e9.orderMeta);
    check('подписи статистики переведены', e9.ordersLabel === 'orders', e9.ordersLabel);
    check('заглушки скрытых панелей переведены',
      (e9.staticTitles || {}).detailTitle === 'Product' && (e9.staticTitles || {}).authSub === 'Sign in to keep your orders and history',
      e9.staticTitles);
    check('непереведённых видимых узлов нет', (e9.cyr || []).length === 0, e9.cyr);

    /* ── 10. шаг кода на английском ── */
    console.log('\n─── 10. Шаг кода на английском ───');
    const enCode = await run(send, `(async () => { ${HELPERS}
      $('profileClose').click();
      await sleep(400);
      $('userBtn').click();
      await sleep(250);
      $('dropLogout').click();
      await waitFor(() => $('userMenu').hidden, 6000);
      await sleep(200);
      $('authOpen').click();
      await waitFor(() => $('authModal').classList.contains('active'), 4000);
      await sleep(200);
      $('forgotBtn').click();
      await waitFor(() => !$('codeForm').hidden && !$('fCodeMail').hidden, 4000);
      await sleep(250);
      const state1 = { lead: $('codeLead').textContent.slice(0, 70), btn: $('codeBtn').textContent };
      setVal($('codeMail'), 'front@test.ru');
      submit($('codeForm'));
      /* ждём перехода на ввод кода: поле почты скрывается, появляются ячейки */
      await waitFor(() => !$('codeBox').hidden, 8000);
      await sleep(250);
      return JSON.stringify({
        state1,
        state2: { lead: $('codeLead').textContent.slice(0, 70), btn: $('codeBtn').textContent, resend: $('codeResend').textContent },
        errShown: !$('codeErr').hidden,
        loggedOut: $('userMenu').hidden
      });
    })()`);
    check('сброс пароля без ошибок JS', enCode && !enCode.__error, enCode);
    const ec = enCode && !enCode.__error ? JSON.parse(enCode) : {};
    check('после выхода меню скрыто', ec.loggedOut === true, ec);
    check('английский текст на шаге «введите почту»', /Enter the email of your account/.test((ec.state1 || {}).lead || ''), (ec.state1 || {}).lead);
    check('кнопка «Send the code»', (ec.state1 || {}).btn === 'Send the code', (ec.state1 || {}).btn);
    check('английский текст на шаге кода', /code was sent/.test((ec.state2 || {}).lead || ''), (ec.state2 || {}).lead);
    check('таймер на английском', /Resend in \d+s/.test((ec.state2 || {}).resend || ''), (ec.state2 || {}).resend);

    /* ── 11. вход после сброса ── */
    console.log('\n─── 11. Вход и выход ───');
    const login = await run(send, `(async () => { ${HELPERS}
      $('codeBack').click();
      await sleep(300);
      $('codeBack').click();
      await sleep(400);
      q('.lang-switch__btn[data-lang=ru]').click();
      await waitFor(() => document.documentElement.lang === 'ru', 4000);
      await sleep(300);
      $('authClose').click();
      await sleep(300);
      $('authOpen').click();
      await waitFor(() => $('authModal').classList.contains('active'), 4000);
      await sleep(200);
      setVal($('loginId'), 'frontuser');
      setVal($('loginPw'), 'FrontPass1');
      submit($('loginForm'));
      await waitFor(() => !$('userMenu').hidden, 10000);
      await sleep(300);
      const res = {
        loggedIn: !$('userMenu').hidden,
        nick: $('userNm').textContent,
        modalClosed: !$('authModal').classList.contains('active')
      };
      $('userBtn').click();
      await sleep(250);
      $('dropLogout').click();
      await waitFor(() => $('userMenu').hidden, 6000);
      await sleep(300);
      res.afterLogout = $('userMenu').hidden && !$('authOpen').hidden;
      res.loginPrefilled = $('loginId').value;
      return JSON.stringify(res);
    })()`);
    check('вход без ошибок JS', login && !login.__error, login);
    const l11 = login && !login.__error ? JSON.parse(login) : {};
    check('вход по нику и паролю прошёл', l11.loggedIn === true && l11.nick === 'frontuser', l11);
    check('после выхода вернулась кнопка «Войти»', l11.afterLogout === true, l11);
    check('ник подставлен в форму входа', l11.loginPrefilled === 'frontuser', l11.loginPrefilled);

    /* ── 12. консоль ── */
    console.log('\n─── 12. Ошибки ───');
    const pageErrs = await run(send, `JSON.stringify(window.__errs || [])`);
    const pe = JSON.parse(pageErrs || '[]');
    check('ошибок JS на странице нет', pe.length === 0, pe);

    const cerr = events
      .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map((e) => e.params.entry.text);
    /* Шаг 4 намеренно отправляет неверный код → сервер отвечает 400.
       Браузер пишет об этом в консоль как о сетевой ошибке. Это ожидаемо:
       отсеиваем ровно её и требуем, чтобы больше ничего не было. */
    const EXPECTED_400 = /Failed to load resource: the server responded with a status of 400/;
    const unexpected = cerr.filter((t) => !EXPECTED_400.test(t));
    check('ошибок в консоли браузера нет (кроме намеренного 400)', unexpected.length === 0, unexpected);
    check('намеренный 400 от неверного кода зафиксирован', cerr.some((t) => EXPECTED_400.test(t)), cerr);

    const serr = (serverOut.match(/\[ошибка\][^\n]*/g) || []);
    check('сервер не логировал ошибок', serr.length === 0, serr.slice(0, 3));
  } catch (e) {
    fail++;
    failures.push('ИСКЛЮЧЕНИЕ: ' + e.message);
    console.log('\nИСКЛЮЧЕНИЕ: ' + e.message);
    console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  } finally {
    if (client) client.close();
    if (chrome) chrome.kill();
    if (app) app.kill();
    try { fs.unlinkSync(dbFile); } catch (e) {}
  }

  console.log('\n' + '═'.repeat(52));
  console.log('  пройдено: ' + pass + '   провалено: ' + fail);
  if (fail) { console.log('\n  Провалы:'); failures.forEach((f) => console.log('   • ' + f)); }
  console.log('═'.repeat(52) + '\n');
  process.exit(fail ? 1 : 0);
})();
