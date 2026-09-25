# Sprice Private

Магазин приватного софта и макросов: сайт + собственный сервер с аккаунтами,
подтверждением почты по коду и базой данных заказов.

## Что внутри

| Раздел | Описание |
|---|---|
| Каталог | 5 продуктов с иконками, тегами, ценами и тарифами |
| Страница продукта | Галерея скриншотов, «Что внутри», «Характеристики», выбор тарифа |
| Тарифы | Модалка с планами и переходом на оплату в FunPay |
| Аккаунты | Регистрация и вход, пароль — scrypt, сессия в httpOnly-cookie |
| Подтверждение почты | 6-значный код письмом, без него вход закрыт |
| Восстановление пароля | Код на почту → новый пароль |
| Профиль | История заказов, счётчики, сумма — считает сервер |
| Язык | Переключатель RU / EN, выбор сохраняется |
| Тема | Тёмная и светлая, выбор сохраняется |

## Стек

- **Node.js 22** + Express 4 — сервер и API.
- **PostgreSQL** в продакшене (Render), **SQLite** локально — один и тот же SQL,
  переключается по наличию `DATABASE_URL`. Своих нативных сборок нет.
- **nodemailer** (SMTP) или **Resend** (HTTP API) для писем.
- Фронтенд — один файл `public/index.html`, без сборки.

## Запуск локально

```bash
npm install
cp .env.example .env      # заполнять не обязательно — есть DEV-режим
npm start                 # http://localhost:3000
```

В DEV-режиме (не задан ни SMTP, ни Resend) письма не отправляются, а код
печатается в консоль сервера:

```
────────────────────────────────────────
  DEV-режим почты: письмо НЕ отправлено
  кому: mail@mail.ru
  тема: Подтверждение почты — Sprice Private
  КОД: 481920
────────────────────────────────────────
```

Данные локально лежат в `data/sprice.db` (SQLite).

## Тесты

```bash
npm test              # оба набора
node test/e2e.js      # 66 проверок API на SQLite в памяти
node test/frontend.js # 64 проверки реального UI в Chrome через CDP
```

`test/frontend.js` поднимает сервер, запускает headless Chrome, проходит путь
регистрация → код → заказ → профиль → смена языка → сброс пароля и падает,
если в консоли появилась хоть одна неожиданная ошибка.

## Деплой на Render

В репозитории есть `render.yaml` — Render сам создаст веб-сервис и базу.

1. Залей код на GitHub.
2. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
3. Выбери репозиторий. Render прочитает `render.yaml` и предложит создать:
   - `sprice-private` — веб-сервис (Node);
   - `sprice-db` — PostgreSQL.
4. Render сам подставит `DATABASE_URL` из базы, а `CODE_PEPPER` сгенерирует
   случайно. Нажми **Apply**.
5. Дождись первого деплоя и открой выданный адрес вида
   `https://sprice-private.onrender.com`.

### Переменные окружения

| Переменная | Зачем |
|---|---|
| `DATABASE_URL` | Подключение к PostgreSQL. Подставляется из базы Render |
| `CODE_PEPPER` | Секрет для HMAC-хеша кодов подтверждения |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Отправка через SMTP |
| `RESEND_API_KEY`, `MAIL_FROM` | Отправка через Resend (HTTP API) |
| `SITE_URL` | Адрес сайта — попадает в письма |
| `CODE_TTL_MINUTES` | Сколько минут живёт код (по умолчанию 10) |
| `CODE_MAX_ATTEMPTS` | Попыток ввода кода (по умолчанию 5) |
| `RESEND_COOLDOWN_SEC` | Пауза между повторными письмами (по умолчанию 60) |
| `RESEND_MAX_PER_HOUR` | Писем в час на один адрес (по умолчанию 5) |
| `FUNPAY_URL` | Ссылка на оплату |

### Почта: три способа

**1. Resend (проще всего).** Регистрация на [resend.com](https://resend.com),
подтверждение домена, затем в Render добавь `RESEND_API_KEY`. Если своего домена
нет — для теста работает `MAIL_FROM="Sprice <onboarding@resend.dev>"`.

**2. Gmail через пароль приложения.** Нужен домен Google и 2FA:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop   # пароль приложения, не обычный пароль
MAIL_FROM="Sprice Private <you@gmail.com>"
```

**3. Brevo / Mailgun / Yandex 360** — любой SMTP-провайдер, просто заполни
`SMTP_*`.

Пока ничего не задано, сайт работает: код видно в логах Render
(**Logs** → вкладка сервиса).

### Важно про Render

- Диск на Render **эфемерный**: файлы между деплоями и рестартами не сохраняются.
  Поэтому в продакшене используется PostgreSQL, а не SQLite. Если запустить без
  `DATABASE_URL`, сервер предупредит об этом в логе.
- Сервис на бесплатном плане засыпает после простоя — первый запрос после паузы
  будет медленнее.
- `healthCheckPath` — `/healthz`. Он же показывает, что поднялось:

```json
{ "ok": true, "db": "pg", "mail": "smtp", "products": 5, "uptime": 12.4 }
```

## API

| Метод | Путь | Что делает |
|---|---|---|
| `POST` | `/api/auth/register` | Создать аккаунт и отправить код |
| `POST` | `/api/auth/verify` | Подтвердить код → вход |
| `POST` | `/api/auth/resend` | Отправить код заново |
| `POST` | `/api/auth/login` | Вход по нику или почте |
| `POST` | `/api/auth/logout` | Выход |
| `GET` | `/api/auth/me` | Кто сейчас вошёл |
| `POST` | `/api/auth/reset/request` | Код для сброса пароля |
| `POST` | `/api/auth/reset/confirm` | Новый пароль по коду |
| `GET` | `/api/catalog` | Каталог с ценами |
| `POST` | `/api/orders` | Оформить заказ |
| `GET` | `/api/orders` | Мои заказы |
| `GET` | `/api/profile` | Профиль со статистикой |

Цены берутся **только** из `src/catalog.js` на сервере. Если клиент пришлёт
свою цену, она игнорируется — это покрыто тестом.

## Продукты

| ID | Название | Категория |
|---|---|---|
| `potassium` | Potassium | Executor |
| `vector` | Vector | External |
| `matrixhub` | MatrixHub | External |
| `spicemacro` | SpiceMacro | Macro |
| `spriceoverlay` | SpriceOverlay | External |

## Устройство

```
server.js          Express: статика, заголовки, лимиты, /healthz
src/db.js          Два драйвера (pg / node:sqlite) на одном SQL
src/security.js    scrypt, HMAC-коды, токены сессий
src/mail.js        Resend / SMTP / DEV-режим, шаблоны писем
src/catalog.js     Продукты и тарифы — источник истины по ценам
src/routes/        auth.js, orders.js
public/index.html  Весь фронтенд: разметка, стили, скрипт, словарь RU/EN
test/              e2e.js (API), frontend.js (UI в Chrome)
```

Фронтенд открывает страницу продукта по хешу `#p=<id>` — работает кнопка
«Назад». Язык переключается атрибутами `data-i18n*` и словарём `I18N`.

## Контакты

- Discord — [сервер сообщества](https://discord.gg/)
- FunPay — оплата

---

© 2026 Sprice Private. Автор: Sprice
