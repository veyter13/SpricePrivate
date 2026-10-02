"""
SpriceOverlay — ключ-сервер / админ-панель.  ВЕРСИЯ 3.2.

Что нового относительно v3:
  * Ключи создаются со СВОИМ ИМЕНЕМ: ввёл "vasya" -> ключ SPRC-VASYA.
  * Имя ключа (name) и заметку (note) можно РЕДАКТИРОВАТЬ прямо из таблицы.
  * ТЕГИ (tags) — вместо "бонусов" это ПОМЕТКИ-ПРИПИСКИ на ключ:
    vip / developer / owner / custom / tester. Чисто статусные метки,
    показываются владельцу в оверлее и в панели. Никаких "функциональных"
    плюх (streamproof/extended_range/multi_pc) — они убраны по просьбе.
  * Полностью перерисованный интерфейс: понятный, аккуратный, тёмная тема.
  * ПЕРЕВОД RU/EN — по умолчанию русский, кнопки RU/EN в шапке (cookie lang).
  * ТЕМЫ (7 шт.) — переключатель кружками-палитрами в шапке (cookie theme):
    Фиолет / Океан / Изумруд / Багровый / Закат / Полночь / Светлая.
  * Создание ключа НЕ перекидывает на другую страницу — ключ показывается
    в модалке прямо в панели (раньше нативная форма показывала сырой JSON).

КОНТРАКТ /verify СОВМЕСТИМ с v2 и лоадером 1.0.41+ (поля не удалены):
    {"success":bool,"message":str,"expires":str,
     "name":str,"tier":"STANDARD"|"VIP","perks":"a,b,c"}
  Поле "perks" теперь содержит ТЕГИ (CSV), а не бонусы. Лоадер/оверлей
  читают его как раньше (perks.dat) и рисуют метку владельца.

Запуск локально:
    pip install flask
    set SPRICE_ADMIN_PASSWORD=свой_пароль
    python panel_v3.py

Комментарии на русском (мандат оператора).
"""

import os
import re
import hmac
import hashlib
import json
import time
import sqlite3
import logging
import datetime
import secrets
import threading
from functools import wraps

from flask import (
    Flask,
    request,
    redirect,
    url_for,
    session,
    jsonify,
    render_template_string,
    send_file,
    abort,
)

# ============================================================================
#  Конфиг
# ============================================================================

ADMIN_PASSWORD = os.environ.get("SPRICE_ADMIN_PASSWORD", "mar142733")
SECRET_KEY = os.environ.get("SPRICE_SECRET") or secrets.token_hex(32)
HOST = os.environ.get("SPRICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPRICE_PORT", "5000"))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

OFFSETS_PATH = os.environ.get("SPRICE_OFFSETS", os.path.join(DATA_DIR, "offsets.json"))
BIN_PATH = os.environ.get("SPRICE_BIN", os.path.join(DATA_DIR, "SpriceOverlay.exe"))
VERSION_PATH = os.environ.get("SPRICE_VERSION", os.path.join(DATA_DIR, "version.txt"))

# ============================================================================
#  ТЕГИ ("приписки") — что можно навесить на ключ
#  Чисто статусные метки. Никаких функциональных бонусов.
#  Названия/описания — отдельно для EN и RU (для перевода интерфейса).
# ============================================================================

TAG_COLORS = {
    "owner":     "#fbbf24",
    "developer": "#38bdf8",
    "vip":       "#a78bfa",
    "tester":    "#34d399",
    "custom":    "#f472b6",
}

TAG_TITLES = {
    "en": {"owner": "Owner",     "developer": "Developer", "vip": "VIP",
           "tester": "Tester",    "custom": "Custom"},
    "ru": {"owner": "Владелец",  "developer": "Разработчик", "vip": "VIP",
           "tester": "Тестер",    "custom": "Кастом"},
}

TAG_DESCS = {
    "en": {
        "owner":     "Project owner — full access",
        "developer": "Developer / dev team",
        "vip":       "Special support / sponsor",
        "tester":    "Beta tester",
        "custom":    "Personal / custom key",
    },
    "ru": {
        "owner":     "Владелец проекта — полный доступ",
        "developer": "Разработчик / dev-команда",
        "vip":       "Спец. поддержка / спонсор",
        "tester":    "Бета-тестер",
        "custom":    "Персональный / кастомный ключ",
    },
}

TAG_ORDER = ["owner", "developer", "vip", "tester", "custom"]
TAG_CODES = set(TAG_TITLES["en"].keys())


def tags_from_str(s):
    if not s:
        return []
    return [p for p in str(s).split(",") if p.strip() and p.strip() in TAG_CODES]


def tags_to_str(items):
    clean = [p for p in (items or []) if p in TAG_CODES]
    # держим стабильный порядок, чтобы в базе не было мусора
    return ",".join([p for p in TAG_ORDER if p in clean])


def max_devices(_tag_list):
    # Бонус multi_pc убран — один ключ = один ПК.
    return 1


# ============================================================================
#  ПЕРЕВОД ИНТЕРФЕЙСА (RU / EN)
#  По умолчанию — русский. Переключатель языка — кнопки RU/EN в шапке.
# ============================================================================

STR = {
    "en": {
        "panel_title": "SPRICE — License panel",
        "login_title": "SPRICE // LOGIN",
        "subtitle": "License management",
        "db": "db",
        "logout": "Logout",
        "all_keys": "All keys",
        "active": "Active",
        "bound": "Bound to PC",
        "soon": "Expire ≤ 7 days",
        "expired": "Expired",
        "tagged": "Tagged",
        "create_license": "Create license",
        "license_name": "License name (yours)",
        "days": "Days (0 = ∞)",
        "count": "Count",
        "note": "Note",
        "note_ph": "optional",
        "d1": "1 day", "d7": "7 days", "d30": "30 days",
        "d90": "90 days", "d365": "365 days", "lifetime": "Lifetime ∞",
        "empty_name": "Empty name → random key",
        "tags": "Tags",
        "tags_hint": "(status label shown to the user)",
        "create_btn": "Create license",
        "licenses": "Licenses",
        "search_ph": "Search by name, key, HWID or note...",
        "f_all": "All", "f_active": "Active only", "f_disabled": "Disabled",
        "f_expired": "Expired", "f_bound": "Bound", "f_free": "Not bound",
        "f_tagged": "Tagged",
        "h_name": "Name", "h_key": "Key", "h_hwid": "HWID",
        "h_expires": "Expires", "h_tags": "Tags", "h_status": "Status",
        "copy": "copy", "none": "none", "b_expired": "expired",
        "b_lifetime": "∞ lifetime", "b_left": "d left", "b_disabled": "disabled",
        "b_active": "active", "edit": "Edit", "extend": "+30d",
        "reset_hwid": "Reset HWID", "enable": "Enable", "disable": "Disable",
        "del": "Del", "empty": "No licenses yet — create the first one above.",
        "update_channel": "Update channel",
        "upload_offsets": "Upload offsets.json",
        "upload_exe": "Upload SpriceOverlay.exe",
        "version": "version", "binary": "binary", "offsets": "offsets",
        "present": "present", "missing": "missing",
        "foot": "SPRICE license panel",
        "edit_license": "Edit license", "days_total": "Days total",
        "status": "Status", "cancel": "Cancel", "save": "Save",
        "license_created": "License created",
        "created_hint": "Copy and send to the user. The key is already active.",
        "close": "Close", "copy_all": "Copy all",
        "saved": "Saved", "created": "Created {n} license(s)",
        "neterr": "Network error", "allcopied": "All keys copied",
        "done": "Done", "del_q": "Delete {k}?", "error": "Error", "copied": "ok",
        "admin_access": "Admin access", "password": "Password",
        "password_ph": "password", "enter": "Enter", "wrong": "Wrong password",
        "lang_ru": "RU", "lang_en": "EN",
    },
    "ru": {
        "panel_title": "SPRICE — Панель лицензий",
        "login_title": "SPRICE // ВХОД",
        "subtitle": "Управление лицензиями",
        "db": "БД",
        "logout": "Выйти",
        "all_keys": "Всего ключей",
        "active": "Активные",
        "bound": "Привязаны",
        "soon": "Истекают ≤ 7 дн",
        "expired": "Просрочены",
        "tagged": "С тегами",
        "create_license": "Создать лицензию",
        "license_name": "Имя лицензии (ваше)",
        "days": "Дней (0 = ∞)",
        "count": "Кол-во",
        "note": "Заметка",
        "note_ph": "необязательно",
        "d1": "1 день", "d7": "7 дней", "d30": "30 дней",
        "d90": "90 дней", "d365": "365 дней", "lifetime": "Навсегда ∞",
        "empty_name": "Пустое имя → случайный ключ",
        "tags": "Теги",
        "tags_hint": "(статусная метка, видна пользователю)",
        "create_btn": "Создать лицензию",
        "licenses": "Лицензии",
        "search_ph": "Поиск по имени, ключу, HWID или заметке...",
        "f_all": "Все", "f_active": "Только активные", "f_disabled": "Отключённые",
        "f_expired": "Просроченные", "f_bound": "Привязанные", "f_free": "Не привязанные",
        "f_tagged": "С тегами",
        "h_name": "Имя", "h_key": "Ключ", "h_hwid": "HWID",
        "h_expires": "Истекает", "h_tags": "Теги", "h_status": "Статус",
        "copy": "копир.", "none": "нет", "b_expired": "просрочен",
        "b_lifetime": "∞ навсегда", "b_left": "дн. ост.", "b_disabled": "отключён",
        "b_active": "активен", "edit": "Изменить", "extend": "+30д",
        "reset_hwid": "Сброс HWID", "enable": "Включить", "disable": "Отключить",
        "del": "Удл", "empty": "Лицензий пока нет — создайте первую выше.",
        "update_channel": "Канал обновлений",
        "upload_offsets": "Загрузить offsets.json",
        "upload_exe": "Загрузить SpriceOverlay.exe",
        "version": "версия", "binary": "бинарь", "offsets": "оффсеты",
        "present": "есть", "missing": "нет",
        "foot": "Лицензионная панель SPRICE",
        "edit_license": "Изменить лицензию", "days_total": "Дней всего",
        "status": "Статус", "cancel": "Отмена", "save": "Сохранить",
        "license_created": "Лицензия создана",
        "created_hint": "Скопируйте и отправьте пользователю. Ключ уже активен.",
        "close": "Закрыть", "copy_all": "Копировать все",
        "saved": "Сохранено", "created": "Создано: {n}",
        "neterr": "Ошибка сети", "allcopied": "Все ключи скопированы",
        "done": "Готово", "del_q": "Удалить {k}?", "error": "Ошибка", "copied": "ок",
        "admin_access": "Доступ админа", "password": "Пароль",
        "password_ph": "пароль", "enter": "Войти", "wrong": "Неверный пароль",
        "lang_ru": "RU", "lang_en": "EN",
    },
}


def get_lang():
    """Язык интерфейса. По умолчанию — русский (если cookie нет/другой)."""
    l = (request.cookies.get("lang") or "ru")
    return "ru" if l == "ru" else "en"


def get_game():
    """Выбранная игра в админке (cookie `game`). По умолчанию — roblox.
    Влияет на то, какой раздел обновлений (канал апдейтов) видит админ
    и какие формы аплоада активны. Сами бинарники/оффсеты обеих игр
    всегда лежат на своих местах и управляются через соответствующие
    ключи в БД — переключатель только меняет «активный» раздел UI."""
    g = (request.cookies.get("game") or "roblox").strip().lower()
    return "cs2" if g == "cs2" else "roblox"


def _tr(key):
    return STR.get(get_lang(), STR["en"]).get(key, key)


# ============================================================================
#  База: ищем СУЩЕСТВУЮЩУЮ, чтобы деплой не подсунул пустую БД
# ============================================================================

def _candidate_db_paths():
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [
        os.environ.get("SPRICE_DB", ""),
        os.path.join(here, "keys.db"),
        os.path.join(here, "data", "keys.db"),
        os.path.join(here, "instance", "keys.db"),
        "/home/keyadmin/keys.db",
        "/home/keyadmin/mysite/keys.db",
        "/home/keyadmin/panel/keys.db",
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return os.path.join(here, "keys.db")


DB_PATH = _candidate_db_paths()
os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

LOG_PATH = os.path.join(os.path.dirname(DB_PATH), "panel_verify.log")
logging.basicConfig(filename=LOG_PATH, level=logging.INFO,
                    format="%(asctime)s %(message)s", encoding="utf-8")
log = logging.getLogger("sprice")

app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(hours=12),
)

# Функция перевода для шаблонов: {{ _('key') }}
app.jinja_env.globals["_"] = _tr


# ============================================================================
#  БД
# ============================================================================

def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _columns(conn, table="keys"):
    try:
        return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    except Exception:
        return set()


def init_db():
    conn = connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS keys (
                key           TEXT PRIMARY KEY,
                name          TEXT DEFAULT '',
                hwid          TEXT DEFAULT '',
                hwids         TEXT DEFAULT '',
                expires_at    TEXT DEFAULT '',
                expires_epoch INTEGER DEFAULT 0,
                created       TEXT DEFAULT '',
                note          TEXT DEFAULT '',
                perks         TEXT DEFAULT '',
                active        INTEGER DEFAULT 1,
                last_seen     TEXT DEFAULT '',
                fails         INTEGER DEFAULT 0
            )
            """
        )
        cols = _columns(conn)
        for col, ddl in (
            ("name", "ALTER TABLE keys ADD COLUMN name TEXT DEFAULT ''"),
            ("hwids", "ALTER TABLE keys ADD COLUMN hwids TEXT DEFAULT ''"),
            ("perks", "ALTER TABLE keys ADD COLUMN perks TEXT DEFAULT ''"),
            ("expires_at", "ALTER TABLE keys ADD COLUMN expires_at TEXT DEFAULT ''"),
            ("expires_epoch", "ALTER TABLE keys ADD COLUMN expires_epoch INTEGER DEFAULT 0"),
            ("active", "ALTER TABLE keys ADD COLUMN active INTEGER DEFAULT 1"),
            ("last_seen", "ALTER TABLE keys ADD COLUMN last_seen TEXT DEFAULT ''"),
            ("fails", "ALTER TABLE keys ADD COLUMN fails INTEGER DEFAULT 0"),
            ("note", "ALTER TABLE keys ADD COLUMN note TEXT DEFAULT ''"),
            ("created", "ALTER TABLE keys ADD COLUMN created TEXT DEFAULT ''"),
            # К какой игре привязан ключ: "roblox" или "cs2". Старые ключи -> roblox.
            ("game", "ALTER TABLE keys ADD COLUMN game TEXT DEFAULT 'roblox'"),
        ):
            if col not in cols:
                try:
                    conn.execute(ddl)
                except Exception:
                    pass
        try:
            conn.execute("CREATE INDEX IF NOT EXISTS idx_keys_hwid ON keys(hwid)")
        except Exception:
            pass

        # --- аккаунты сайта, сессии, заказы (FunPay) ---
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                login      TEXT UNIQUE,
                pw         TEXT DEFAULT '',
                email      TEXT DEFAULT '',
                created    TEXT DEFAULT '',
                last_login TEXT DEFAULT '',
                hwid       TEXT DEFAULT '',
                banned     INTEGER DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token   TEXT PRIMARY KEY,
                user_id INTEGER,
                created TEXT DEFAULT '',
                expires INTEGER DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS orders (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id   INTEGER,
                code      TEXT DEFAULT '',
                product   TEXT DEFAULT '',
                game      TEXT DEFAULT 'roblox',
                status    TEXT DEFAULT 'pending',
                key       TEXT DEFAULT '',
                price     TEXT DEFAULT '',
                created   TEXT DEFAULT '',
                activated TEXT DEFAULT ''
            )
        """)
        cols = _columns(conn, "keys")
        if "owner" not in cols:
            try:
                conn.execute("ALTER TABLE keys ADD COLUMN owner INTEGER DEFAULT 0")
            except Exception:
                pass
        if "owner_login" not in cols:
            try:
                conn.execute("ALTER TABLE keys ADD COLUMN owner_login TEXT DEFAULT ''")
            except Exception:
                pass
    finally:
        conn.close()

    _backfill()


def _backfill():
    """Пересчитывает старые строковые даты в epoch и поднимает hwids из hwid."""
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM keys").fetchall()
        conn.execute("BEGIN")
        for r in rows:
            ep = row_expiry_epoch(r)
            try:
                cur = int(r["expires_epoch"] or 0)
            except Exception:
                cur = 0
            updates = []
            params = []
            if ep != cur:
                updates.append("expires_epoch=?")
                params.append(ep)
                updates.append("expires_at=?")
                params.append(epoch_to_str(ep) if ep else "")
            try:
                hwids = r["hwids"] or ""
            except Exception:
                hwids = ""
            if not hwids:
                try:
                    hwids = r["hwid"] or ""
                except Exception:
                    hwids = ""
                updates.append("hwids=?")
                params.append(hwids)
            if updates:
                params.append(r["key"])
                conn.execute(f"UPDATE keys SET {','.join(updates)} WHERE key=?", params)
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
    finally:
        conn.close()


init_db()


# ============================================================================
#  Время
# ============================================================================

def now_epoch():
    return int(time.time())


def epoch_to_str(ep):
    if not ep:
        return ""
    return datetime.datetime.fromtimestamp(int(ep), datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


EXPIRY_COLS = ("expires_at", "expires", "expiry", "expires_on", "until")


def parse_expiry(value):
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else 0
    s = str(value).strip()
    if not s:
        return 0
    if s.isdigit():
        return int(s) if int(s) > 0 else 0
    s = s.replace("T", " ").replace("Z", "").strip()
    s = s.split(".")[0]
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%d.%m.%Y %H:%M:%S", "%d.%m.%Y"):
        try:
            dt = datetime.datetime.strptime(s, fmt)
            return int(dt.replace(tzinfo=datetime.timezone.utc).timestamp())
        except Exception:
            continue
    return -1


def row_expiry_epoch(row):
    if row is None:
        return 0
    d = dict(row)
    try:
        ep = int(d.get("expires_epoch") or 0)
    except Exception:
        ep = 0
    if ep > 0:
        return ep
    for col in EXPIRY_COLS:
        if col in d:
            s = str(d.get(col) or "").strip()
            if s:
                v = parse_expiry(s)
                if v >= 0:
                    return v
    return 0


# ============================================================================
#  Ключи
# ============================================================================

KEY_RE = re.compile(r"^[A-Z0-9-]{4,64}$")
NAME_RE = re.compile(r"[^A-Z0-9-]")


def norm_key(raw):
    s = (raw or "").strip().upper()
    s = re.sub(r"\s+", "", s)
    return "".join(ch for ch in s if ch.isprintable())


def make_key_from_name(name, prefix="SPRC"):
    """Ввёл 'vasya' -> 'SPRC-VASYA'. Ввёл 'MY-KEY' -> 'SPRC-MY-KEY'.
    Если имя уже начинается с префикса — не дублируем."""
    s = NAME_RE.sub("", (name or "").strip().upper().replace(" ", "-"))
    s = re.sub(r"-{2,}", "-", s).strip("-")
    if not s:
        return None
    if s.startswith(prefix + "-") or s == prefix:
        return s
    return f"{prefix}-{s}"


def random_key(prefix="SPRC"):
    abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    g = lambda: "".join(secrets.choice(abc) for _ in range(4))
    return f"{prefix}-{g()}-{g()}-{g()}-{g()}"


def key_exists(conn, key):
    r = conn.execute("SELECT 1 FROM keys WHERE key=? OR UPPER(key)=?", (key, key)).fetchone()
    return r is not None


# ============================================================================
#  Анти-брутфорс
# ============================================================================

_rate_lock = threading.Lock()
_rate = {}


def rate_limit(ip, limit, window):
    now = time.time()
    with _rate_lock:
        bucket = _rate.get(ip) or []
        bucket[:] = [t for t in bucket if now - t < window]
        if len(bucket) >= limit:
            _rate[ip] = bucket
            return False
        bucket.append(now)
        _rate[ip] = bucket
        if len(_rate) > 5000:
            _rate.clear()
    return True


def client_ip():
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.headers.get("X-Real-IP", request.remote_addr or "?")


def limited(limit, window, tag):
    def deco(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not rate_limit(tag + ":" + client_ip(), limit, window):
                log.info("RATE %s %s", tag, client_ip())
                return jsonify({"success": False, "message": "Too many requests - wait a bit"}), 429
            return fn(*args, **kwargs)
        return wrapper
    return deco


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("login"))
        return fn(*args, **kwargs)
    return wrapper


# ============================================================================
#  ТЕМЫ ОФОРМЛЕНИЯ (переключатель в шапке)
#  Каждая тема — набор CSS-переменных. По умолчанию — "violet".
# ============================================================================

THEMES = {
    "violet": {
        "en": "Violet", "ru": "Фиолет",
        "vars": {
            "bg": "#08080d", "bg2": "#0e0e16", "card": "#14141f", "card2": "#1a1a28",
            "line": "#24243a", "line2": "#30304c", "text": "#ececf6",
            "dim": "#9a9ac0", "dim2": "#6a6a8a",
            "accent": "#7c5cff", "accent2": "#a78bfa", "accent-d": "#4f46e5",
            "accentbg": "rgba(124,92,255,.14)",
            "glow1": "rgba(124,92,255,.18)", "glow2": "rgba(56,189,248,.10)",
            "input-bg": "#0d0d16", "mask": "rgba(4,4,10,.74)",
            "ok": "#34d399", "warn": "#fbbf24", "err": "#f87171", "info": "#38bdf8",
        },
    },
    "ocean": {
        "en": "Ocean", "ru": "Океан",
        "vars": {
            "bg": "#06101c", "bg2": "#0a1a2a", "card": "#0f2233", "card2": "#132a3f",
            "line": "#1c3a52", "line2": "#264a66", "text": "#e6f2fb",
            "dim": "#8fb3cc", "dim2": "#5f83a0",
            "accent": "#22a7f0", "accent2": "#5fd0ff", "accent-d": "#0b6fb0",
            "accentbg": "rgba(34,167,240,.14)",
            "glow1": "rgba(34,167,240,.20)", "glow2": "rgba(46,204,180,.10)",
            "input-bg": "#08182a", "mask": "rgba(3,10,20,.74)",
            "ok": "#34d399", "warn": "#fbbf24", "err": "#f87171", "info": "#38bdf8",
        },
    },
    "emerald": {
        "en": "Emerald", "ru": "Изумруд",
        "vars": {
            "bg": "#06110d", "bg2": "#0a1a14", "card": "#0f241c", "card2": "#133026",
            "line": "#1c4234", "line2": "#26543f", "text": "#e8f7ef",
            "dim": "#8fc2a8", "dim2": "#5f8a72",
            "accent": "#22c55e", "accent2": "#6ee7a8", "accent-d": "#15803d",
            "accentbg": "rgba(34,197,94,.14)",
            "glow1": "rgba(34,197,94,.18)", "glow2": "rgba(56,189,248,.08)",
            "input-bg": "#08170f", "mask": "rgba(3,10,7,.74)",
            "ok": "#34d399", "warn": "#fbbf24", "err": "#f87171", "info": "#38bdf8",
        },
    },
    "crimson": {
        "en": "Crimson", "ru": "Багровый",
        "vars": {
            "bg": "#0d0608", "bg2": "#170b0e", "card": "#221013", "card2": "#2c1519",
            "line": "#3d1e24", "line2": "#542a31", "text": "#f7e9ec",
            "dim": "#c99aa2", "dim2": "#8f6670",
            "accent": "#ef4444", "accent2": "#f87171", "accent-d": "#b91c1c",
            "accentbg": "rgba(239,68,68,.15)",
            "glow1": "rgba(239,68,68,.20)", "glow2": "rgba(251,146,60,.10)",
            "input-bg": "#170a0c", "mask": "rgba(12,3,5,.76)",
            "ok": "#34d399", "warn": "#fbbf24", "err": "#f87171", "info": "#38bdf8",
        },
    },
    "sunset": {
        "en": "Sunset", "ru": "Закат",
        "vars": {
            "bg": "#0f0a06", "bg2": "#1a120a", "card": "#241a10", "card2": "#2f2214",
            "line": "#402f1c", "line2": "#5a4326", "text": "#f7efe4",
            "dim": "#cbaa86", "dim2": "#93755a",
            "accent": "#f97316", "accent2": "#fbbf24", "accent-d": "#c2410c",
            "accentbg": "rgba(249,115,22,.15)",
            "glow1": "rgba(249,115,22,.20)", "glow2": "rgba(251,191,36,.10)",
            "input-bg": "#1a120a", "mask": "rgba(12,7,3,.76)",
            "ok": "#34d399", "warn": "#fbbf24", "err": "#f87171", "info": "#38bdf8",
        },
    },
    "midnight": {
        "en": "Midnight", "ru": "Полночь",
        "vars": {
            "bg": "#050507", "bg2": "#0a0a0e", "card": "#111116", "card2": "#16161d",
            "line": "#232330", "line2": "#33333f", "text": "#e6e6ee",
            "dim": "#9a9aa8", "dim2": "#66667a",
            "accent": "#8b8bff", "accent2": "#b3b3ff", "accent-d": "#5a5ad0",
            "accentbg": "rgba(139,139,255,.14)",
            "glow1": "rgba(139,139,255,.14)", "glow2": "rgba(120,120,180,.08)",
            "input-bg": "#0b0b10", "mask": "rgba(3,3,6,.8)",
            "ok": "#34d399", "warn": "#fbbf24", "err": "#f87171", "info": "#38bdf8",
        },
    },
    "light": {
        "en": "Light", "ru": "Светлая",
        "vars": {
            "bg": "#eef1f8", "bg2": "#ffffff", "card": "#ffffff", "card2": "#f4f6fc",
            "line": "#e0e4f0", "line2": "#cdd3e6", "text": "#181828",
            "dim": "#5b5b78", "dim2": "#8a8aa8",
            "accent": "#6d3bff", "accent2": "#7c5cff", "accent-d": "#4f46e5",
            "accentbg": "rgba(109,59,255,.10)",
            "glow1": "rgba(124,92,255,.12)", "glow2": "rgba(56,189,248,.10)",
            "input-bg": "#ffffff", "mask": "rgba(30,30,60,.45)",
            "ok": "#0f9d63", "warn": "#b7791f", "err": "#d64545", "info": "#0b82b8",
        },
    },
}

THEME_ORDER = ["violet", "ocean", "emerald", "crimson", "sunset", "midnight", "light"]


def get_theme():
    """Выбранная тема (cookie `theme`), по умолчанию violet."""
    t = (request.cookies.get("theme") or "violet")
    return t if t in THEMES else "violet"


def build_theme_css():
    """CSS-блоки для не-дефолтных тем: [data-theme="X"]{--var:...}."""
    out = []
    for code in THEME_ORDER:
        if code == "violet":
            continue  # дефолт уже прописан в :root
        decl = ";".join("--%s:%s" % (k, v) for k, v in THEMES[code]["vars"].items())
        out.append('[data-theme="%s"]{%s}' % (code, decl))
    return "\n".join(out)


def theme_swatches(lang):
    """Список кружков-палитр для шапки: (код, название, цвет1, цвет2)."""
    return [(c, THEMES[c][lang], THEMES[c]["vars"]["accent"], THEMES[c]["vars"]["accent-d"])
            for c in THEME_ORDER]


# ============================================================================
#  UI — современная тёмная тема (v3.1: чище, понятнее; v3.2: 7 тем)
# ============================================================================

STYLE = """
:root{
  --bg:#08080d; --bg2:#0e0e16; --card:#14141f; --card2:#1a1a28;
  --line:#24243a; --line2:#30304c;
  --text:#ececf6; --dim:#9a9ac0; --dim2:#6a6a8a;
  --accent:#7c5cff; --accent2:#a78bfa; --accent-d:#4f46e5; --accentbg:rgba(124,92,255,.14);
  --glow1:rgba(124,92,255,.18); --glow2:rgba(56,189,248,.10);
  --input-bg:#0d0d16; --mask:rgba(4,4,10,.74);
  --ok:#34d399; --warn:#fbbf24; --err:#f87171; --info:#38bdf8;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:
    radial-gradient(1200px 520px at 10% -10%, var(--glow1), transparent 60%),
    radial-gradient(1000px 460px at 95% -5%, var(--glow2), transparent 55%),
    var(--bg);
  color:var(--text); font:14px/1.55 "Segoe UI",system-ui,-apple-system,sans-serif;
  min-height:100vh; padding:30px 30px 64px;
}
.wrap{max-width:1180px;margin:0 auto}

/* --- шапка --- */
.head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:26px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;font-weight:800;font-size:20px;
  background:linear-gradient(140deg,var(--accent),var(--accent-d));color:#fff;box-shadow:0 10px 26px var(--accentbg)}
h1{margin:0;font-size:24px;letter-spacing:3px;font-weight:800}
h1 span{color:var(--accent2)}
.sub{color:var(--dim);font-size:10.5px;letter-spacing:2.2px;text-transform:uppercase;margin-top:3px}
.head-right{display:flex;align-items:center;gap:10px}
.pill{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 14px;
  font-size:12px;color:var(--dim)}
.pill b{color:var(--text);font-weight:600}

/* --- статистика --- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.stat{background:linear-gradient(160deg,var(--card2),var(--card));border:1px solid var(--line);
  border-radius:15px;padding:15px 17px;position:relative;overflow:hidden}
.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.9}
.stat.s-ok::before{background:var(--ok)} .stat.s-warn::before{background:var(--warn)}
.stat.s-err::before{background:var(--err)} .stat.s-info::before{background:var(--info)}
.stat .n{font-size:27px;font-weight:800;letter-spacing:-.5px;line-height:1.05}
.stat .l{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:1.4px;margin-top:5px}

/* --- карточки --- */
.card{background:linear-gradient(180deg,rgba(26,26,40,.7),rgba(20,20,31,.7));
  border:1px solid var(--line);border-radius:18px;padding:20px 22px;margin-bottom:20px;
  box-shadow:0 12px 34px rgba(0,0,0,.3)}
.card h2{margin:0 0 16px;font-size:11.5px;letter-spacing:2px;text-transform:uppercase;color:var(--dim)}

/* --- формы --- */
label{display:block;font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
input,select,textarea{background:var(--input-bg);border:1px solid var(--line2);color:var(--text);
  border-radius:10px;padding:10px 12px;outline:none;font:inherit;width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accentbg)}
.f{margin-bottom:13px}
.row{display:flex;gap:11px;flex-wrap:wrap;align-items:flex-end}
.row>.f{flex:1;min-width:130px;margin-bottom:0}
.row>.f.narrow{flex:0 0 112px}
button{background:linear-gradient(135deg,var(--accent),var(--accent-d));border:0;color:#fff;border-radius:10px;
  padding:11px 20px;cursor:pointer;font-weight:600;font:inherit;white-space:nowrap;
  box-shadow:0 5px 16px var(--accentbg);transition:transform .08s,filter .15s}
button:hover{filter:brightness(1.12)} button:active{transform:translateY(1px)}
button.ghost{background:transparent;border:1px solid var(--line2);color:var(--dim);box-shadow:none}
button.ghost:hover{color:var(--text);border-color:var(--accent)}
button.sm{padding:6px 12px;font-size:12px;border-radius:9px}
button.danger{background:linear-gradient(135deg,#ef4444,#b91c1c);box-shadow:0 5px 16px rgba(239,68,68,.28)}
button.block{width:100%}
.presets{display:flex;gap:7px;margin-top:9px;flex-wrap:wrap}
.chipbtn{background:var(--card2);border:1px solid var(--line2);color:var(--dim);border-radius:999px;
  padding:6px 13px;font-size:12px;cursor:pointer;box-shadow:none}
.chipbtn:hover{color:var(--text);border-color:var(--accent)}

/* --- теги (пилюли-переключатели) --- */
.tags{display:flex;gap:9px;flex-wrap:wrap}
.tag{display:inline-flex;align-items:center;gap:8px;background:var(--input-bg);border:1px solid var(--line2);
  border-radius:11px;padding:10px 14px;cursor:pointer;user-select:none;transition:border-color .15s,background .15s,box-shadow .15s}
.tag .dot{width:9px;height:9px;border-radius:50%}
.tag .tt{font-weight:600;font-size:13px}
.tag .td{color:var(--dim);font-size:11px;margin-top:1px}
.tag .tc{display:flex;flex-direction:column}
.tag.on{background:var(--accentbg);border-color:var(--accent);box-shadow:0 0 0 3px var(--accentbg)}
.tag .check{margin-left:2px;opacity:.25;font-weight:800;transition:opacity .15s}
.tag.on .check{opacity:1;color:var(--accent2)}

/* --- таблица --- */
.tools{display:flex;gap:11px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
.tools .grow{flex:1;min-width:230px}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
th{text-align:left;padding:11px 13px;color:var(--dim);font-weight:600;text-transform:uppercase;
  font-size:10px;letter-spacing:1.4px;border-bottom:1px solid var(--line)}
td{padding:12px 13px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:hover{background:var(--accentbg)}
tbody tr:last-child td{border-bottom:0}
.keycell{display:flex;align-items:center;gap:9px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:12.5px;letter-spacing:.4px}
.copy{background:transparent;border:1px solid var(--line2);color:var(--dim2);border-radius:7px;
  padding:3px 9px;font-size:11px;cursor:pointer;box-shadow:none}
.copy:hover{color:var(--accent2);border-color:var(--accent)}
.nm{font-weight:600}
.nt{color:var(--dim);font-size:11.5px}
.badge{display:inline-block;border-radius:999px;padding:3px 11px;font-size:11px;font-weight:600;
  border:1px solid transparent;white-space:nowrap}
.b-ok{background:rgba(52,211,153,.14);color:var(--ok);border-color:rgba(52,211,153,.3)}
.b-warn{background:rgba(251,191,36,.14);color:var(--warn);border-color:rgba(251,191,36,.3)}
.b-err{background:rgba(248,113,113,.14);color:var(--err);border-color:rgba(248,113,113,.3)}
.b-info{background:rgba(56,189,248,.13);color:var(--info);border-color:rgba(56,189,248,.3)}
.b-dim{background:rgba(154,154,192,.12);color:var(--dim);border-color:rgba(154,154,192,.25)}
.chips{display:flex;gap:5px;flex-wrap:wrap}
.chip{font-size:10.5px;font-weight:700;border-radius:7px;padding:3px 9px;border:1px solid}
.acts{display:flex;gap:6px;flex-wrap:wrap}
.empty{color:var(--dim);text-align:center;padding:38px 0}
.small{color:var(--dim);font-size:11.5px;margin-top:8px}

/* --- модалки --- */
.mask{position:fixed;inset:0;background:var(--mask);backdrop-filter:blur(5px);
  display:none;align-items:center;justify-content:center;z-index:50;padding:20px}
.mask.open{display:flex}
.modal{background:var(--card);border:1px solid var(--line2);border-radius:18px;padding:24px;
  width:min(640px,100%);max-height:90vh;overflow:auto;box-shadow:0 30px 80px rgba(0,0,0,.65)}
.modal h3{margin:0 0 4px;font-size:18px}
.modal .msub{color:var(--dim);font-size:12px;margin-bottom:18px}
.mfoot{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}

/* --- результат генерации --- */
.gen-list{display:flex;flex-direction:column;gap:10px;margin:6px 0 4px}
.gen-item{display:flex;align-items:center;gap:12px;background:var(--input-bg);border:1px solid var(--line2);
  border-radius:11px;padding:13px 15px}
.gen-item .gk{flex:1;font-family:ui-monospace,Consolas,monospace;font-size:15px;font-weight:600;letter-spacing:.5px}

/* --- тосты --- */
.toasts{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:10px;z-index:80}
.toast{background:var(--card2);border:1px solid var(--line2);border-left:3px solid var(--accent);
  border-radius:11px;padding:12px 16px;min-width:220px;box-shadow:0 14px 34px rgba(0,0,0,.4);
  font-size:13px;animation:tin .18s ease-out}
.toast.ok{border-left-color:var(--ok)} .toast.err{border-left-color:var(--err)}
@keyframes tin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

.foot{color:var(--dim2);font-size:11.5px;text-align:center;margin-top:28px}
.err{color:var(--err);font-size:13px;margin-top:10px}
.keyhint{color:var(--dim);font-size:11.5px;margin-top:6px}

/* --- переключатель языка --- */
.langswitch{display:flex;gap:4px;background:var(--input-bg);border:1px solid var(--line2);
  border-radius:999px;padding:3px}
.langswitch .lang{padding:6px 13px;font-size:12px;border-radius:999px;box-shadow:none;
  background:transparent;color:var(--dim);border:0}
.langswitch .lang.on{background:var(--accent);color:#fff}

/* --- переключатель тем (кружки-палитры) --- */
.themes{display:flex;gap:7px;align-items:center;background:var(--input-bg);
  border:1px solid var(--line2);border-radius:999px;padding:5px 9px}
.swatch{width:20px;height:20px;border-radius:50%;border:2px solid transparent;cursor:pointer;
  padding:0;box-shadow:0 2px 8px rgba(0,0,0,.35);transition:transform .1s,border-color .15s}
.swatch:hover{transform:scale(1.15)}
.swatch.on{border-color:var(--text)}
"""

# CSS-блоки остальных тем (violet уже в :root)
STYLE += "\n" + build_theme_css()

PAGE = """
<!doctype html><html lang="{{ lang }}" data-theme="{{ theme }}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ _('panel_title') }}</title><style>{{ style|safe }}</style></head><body>
<div class="wrap">

  <div class="head">
    <div class="brand">
      <div class="logo">S</div>
      <div>
        <h1>SPRI<span>CE</span>{% if game=='cs2' %} <em style="font-style:normal;color:var(--accent)">CS2</em>{% endif %}</h1>
        <div class="sub">{{ _('subtitle') }}{% if game=='cs2' %} &middot; CS2{% endif %}</div>
      </div>
    </div>
    <div class="head-right">
      <div class="themes">
        {% for code, name, c1, c2 in theme_swatches %}
        <button type="button" class="swatch {{ 'on' if theme==code else '' }}" title="{{name}}"
          data-theme="{{code}}" onclick="setTheme('{{code}}')" style="background:linear-gradient(135deg,{{c1}},{{c2}})"></button>
        {% endfor %}
      </div>
      <div class="langswitch">
        <button class="ghost sm lang {{ 'on' if lang=='ru' else '' }}" type="button" onclick="setLang('ru')">{{ _('lang_ru') }}</button>
        <button class="ghost sm lang {{ 'on' if lang=='en' else '' }}" type="button" onclick="setLang('en')">{{ _('lang_en') }}</button>
      </div>
      <div class="langswitch" title="Активная игра (канал обновлений и формы аплоада)">
        <a class="ghost sm lang {{ 'on' if game=='roblox' else '' }}" href="/" style="text-decoration:none">ROBLOX</a>
        <a class="ghost sm lang {{ 'on' if game=='cs2' else '' }}" href="/cs2" style="text-decoration:none">CS2</a>
      </div>
      <span class="pill">{{ _('db') }} <b>{{db}}</b></span>
      <form method="post" action="/logout"><button class="ghost sm" type="submit">{{ _('logout') }}</button></form>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><div class="n">{{stats.total}}</div><div class="l">{{ _('all_keys') }}</div></div>
    <div class="stat s-ok"><div class="n">{{stats.active}}</div><div class="l">{{ _('active') }}</div></div>
    <div class="stat s-info"><div class="n">{{stats.bound}}</div><div class="l">{{ _('bound') }}</div></div>
    <div class="stat s-warn"><div class="n">{{stats.soon}}</div><div class="l">{{ _('soon') }}</div></div>
    <div class="stat s-err"><div class="n">{{stats.expired}}</div><div class="l">{{ _('expired') }}</div></div>
    <div class="stat s-warn"><div class="n">{{stats.tagged}}</div><div class="l">{{ _('tagged') }}</div></div>
  </div>

  <!-- ---- генерация ---- -->
  <div class="card">
    <h2>{{ _('create_license') }}</h2>
    <form id="genform">
      <input type="hidden" name="game" value="{{ game }}">
      <div class="row">
        <div class="f">
          <label>{{ _('license_name') }}</label>
          <input name="key_name" id="key_name" placeholder="vasya &rarr; {{ 'CS2' if game=='cs2' else 'SPRC' }}-VASYA" autocomplete="off">
          <div class="keyhint" id="keyhint"></div>
        </div>
        <div class="f narrow"><label>{{ _('days') }}</label>
          <input name="days" id="days" type="number" value="30" min="0"></div>
        <div class="f narrow"><label>{{ _('count') }}</label>
          <input name="count" type="number" value="1" min="1" max="50"></div>
        <div class="f"><label>{{ _('note') }}</label>
          <input name="note" placeholder="{{ _('note_ph') }}"></div>
      </div>
      <div class="presets">
        <button type="button" class="chipbtn" data-days="1">{{ _('d1') }}</button>
        <button type="button" class="chipbtn" data-days="7">{{ _('d7') }}</button>
        <button type="button" class="chipbtn" data-days="30">{{ _('d30') }}</button>
        <button type="button" class="chipbtn" data-days="90">{{ _('d90') }}</button>
        <button type="button" class="chipbtn" data-days="365">{{ _('d365') }}</button>
        <button type="button" class="chipbtn" data-days="0">{{ _('lifetime') }}</button>
        <span class="pill" style="margin-left:auto">{{ _('empty_name') }}</span>
      </div>
      <h2 style="margin:20px 0 12px">{{ _('tags') }} <span style="text-transform:none;letter-spacing:0;color:var(--dim2);font-weight:400">{{ _('tags_hint') }}</span></h2>
      <div class="tags" id="tags">
        {% for code, title, desc, color in tags_def %}
        <label class="tag" data-code="{{code}}">
          <span class="dot" style="background:{{color}}"></span>
          <span class="tc"><span class="tt" style="color:{{color}}">{{title}}</span><span class="td">{{desc}}</span></span>
          <input type="checkbox" name="perk" value="{{code}}" hidden>
          <span class="check">&#10003;</span>
        </label>
        {% endfor %}
      </div>
      <div style="margin-top:20px"><button class="block" type="submit">{{ _('create_btn') }}</button></div>
    </form>
  </div>

  <!-- ---- таблица ---- -->
  <div class="card">
    <h2>{{ _('licenses') }}</h2>
    <div class="tools">
      <div class="grow"><input id="q" placeholder="{{ _('search_ph') }}"></div>
      <select id="flt" style="width:auto">
        <option value="">{{ _('f_all') }}</option>
        <option value="active">{{ _('f_active') }}</option>
        <option value="disabled">{{ _('f_disabled') }}</option>
        <option value="expired">{{ _('f_expired') }}</option>
        <option value="bound">{{ _('f_bound') }}</option>
        <option value="free">{{ _('f_free') }}</option>
        <option value="tagged">{{ _('f_tagged') }}</option>
      </select>
      <span class="pill" id="cnt"></span>
    </div>
    <div style="overflow-x:auto">
    <table id="tbl">
      <thead><tr>
        <th>{{ _('h_name') }}</th><th>{{ _('h_key') }}</th><th>{{ _('h_hwid') }}</th><th>{{ _('h_expires') }}</th>
        <th>{{ _('h_tags') }}</th><th>{{ _('h_status') }}</th><th></th>
      </tr></thead>
      <tbody>
      {% for k in keys %}
      <tr data-st="{{ 'disabled' if not k.active else ('expired' if k.expired else 'active') }}"
          data-bound="{{ '1' if k.hwids else '0' }}"
          data-tagged="{{ '1' if k.perk_list else '0' }}"
          data-search="{{ (k.name ~ ' ' ~ k.key ~ ' ' ~ k.hwids ~ ' ' ~ k.note)|lower }}">
        <td>
          <div class="nm">{{ k.name or '&mdash;' }}</div>
          {% if k.note %}<div class="nt">{{ k.note }}</div>{% endif %}
        </td>
        <td>
          <div class="keycell">
            <span class="mono">{{ k.key }}</span>
            <button type="button" class="copy" data-copy="{{ k.key }}">{{ _('copy') }}</button>
          </div>
        </td>
        <td class="mono dim">{{ k.hwid_short or '&mdash;' }}</td>
        <td>
          {% if k.expired %}<span class="badge b-err">{{ _('b_expired') }}</span>
          {% elif k.days_left is none %}<span class="badge b-info">{{ _('b_lifetime') }}</span>
          {% elif k.days_left <= 7 %}<span class="badge b-warn">{{ k.days_left }} {{ _('b_left') }}</span>
          {% else %}<span class="badge b-ok">{{ k.days_left }} {{ _('b_left') }}</span>{% endif %}
          <div class="nt" style="margin-top:3px">{{ k.expires or '' }}</div>
        </td>
        <td>
          {% if k.perk_list %}
          <div class="chips">
            {% for p in k.perk_list %}
            <span class="chip" style="color:{{ tags_map[p][2] }};border-color:{{ tags_map[p][2] }}55;
              background:{{ tags_map[p][2] }}1a">{{ tags_map[p][0] }}</span>
            {% endfor %}
          </div>
          {% else %}<span class="nt">{{ _('none') }}</span>{% endif %}
        </td>
        <td>
          {% if not k.active %}<span class="badge b-err">{{ _('b_disabled') }}</span>
          {% else %}<span class="badge b-ok">{{ _('b_active') }}</span>{% endif %}
        </td>
        <td>
          <div class="acts">
            <button class="sm" data-edit="{{ k.key }}">{{ _('edit') }}</button>
            <button class="sm ghost" data-act="extend" data-key="{{ k.key }}">{{ _('extend') }}</button>
            <button class="sm ghost" data-act="reset_hwid" data-key="{{ k.key }}">{{ _('reset_hwid') }}</button>
            <button class="sm ghost" data-act="toggle" data-key="{{ k.key }}">{{ _('enable') if not k.active else _('disable') }}</button>
            <button class="sm danger" data-act="delete" data-key="{{ k.key }}">{{ _('del') }}</button>
          </div>
        </td>
      </tr>
      {% endfor %}
      </tbody>
    </table>
    {% if not keys %}<div class="empty">{{ _('empty') }}</div>{% endif %}
    </div>
  </div>

  <!-- ---- канал обновлений ---- -->
  <div class="card">
    <h2>{{ _('update_channel') }}</h2>
    <div class="row">
      {# CS2: оффсеты вшиты в sprice.exe — форма загрузки оффсетов не нужна #}
      {% if game != 'cs2' %}
      <form method="post" action="/upload_offsets" enctype="multipart/form-data" class="f" style="flex:0 0 auto">
        <input type="file" name="file" style="width:auto">
        <button class="sm" style="margin-top:9px" type="submit">{{ _('upload_offsets') }}</button>
      </form>
      {% endif %}
      <form method="post" action="{{ '/cs2/upload_binary' if game=='cs2' else '/upload_binary' }}" enctype="multipart/form-data" class="f" style="flex:0 0 auto">
        <input type="file" name="file" style="width:auto">
        <button class="sm" style="margin-top:9px" type="submit">{{ 'Upload sprice.exe' if game=='cs2' else _('upload_exe') }}</button>
      </form>
    </div>
    <div class="nt" style="margin-top:12px">
      {{ _('version') }} <b>{{version}}</b> &nbsp;//&nbsp;
      {{ _('binary') }}: {{ _('present') if has_binary else _('missing') }}{% if game != 'cs2' %} &nbsp;//&nbsp;
      {{ _('offsets') }}: {{ _('present') if has_offsets else _('missing') }}{% endif %}
    </div>
  </div>

  <div class="foot">{{ _('foot') }}</div>
</div>

<!-- ---- модалка редактирования ---- -->
<div class="mask" id="mask">
  <div class="modal">
    <h3>{{ _('edit_license') }}</h3>
    <div class="msub mono" id="mkey"></div>
    <form id="mform">
      <input type="hidden" name="key" id="mkeyinput">
      <input type="hidden" name="game" value="{{ game }}">
      <div class="row">
        <div class="f"><label>{{ _('h_name') }}</label><input name="name" id="mname" autocomplete="off"></div>
        <div class="f"><label>{{ _('note') }}</label><input name="note" id="mnote" autocomplete="off"></div>
      </div>
      <div class="row" style="margin-top:13px">
        <div class="f narrow"><label>{{ _('days_total') }}</label><input name="days" type="number" id="mdays" min="0"></div>
        <div class="f"><label>{{ _('status') }}</label>
          <select name="active" id="mactive">
            <option value="1">{{ _('b_active') }}</option><option value="0">{{ _('b_disabled') }}</option>
          </select>
        </div>
      </div>
      <h2 style="margin:20px 0 12px">{{ _('tags') }}</h2>
      <div class="tags" id="mtags">
        {% for code, title, desc, color in tags_def %}
        <label class="tag" data-code="{{code}}">
          <span class="dot" style="background:{{color}}"></span>
          <span class="tc"><span class="tt" style="color:{{color}}">{{title}}</span><span class="td">{{desc}}</span></span>
          <input type="checkbox" name="perk" value="{{code}}" hidden>
          <span class="check">&#10003;</span>
        </label>
        {% endfor %}
      </div>
      <div class="mfoot">
        <button type="button" class="ghost" onclick="closeModal()">{{ _('cancel') }}</button>
        <button type="submit">{{ _('save') }}</button>
      </div>
    </form>
  </div>
</div>

<!-- ---- модалка результата генерации ---- -->
<div class="mask" id="genmask">
  <div class="modal">
    <h3>{{ _('license_created') }}</h3>
    <div class="msub">{{ _('created_hint') }}</div>
    <div class="gen-list" id="genlist"></div>
    <div class="mfoot">
      <button type="button" class="ghost" onclick="closeGen()">{{ _('close') }}</button>
      <button type="button" id="gencopyall">{{ _('copy_all') }}</button>
    </div>
  </div>
</div>

<div class="toasts" id="toasts"></div>

<script>
var T = {{ tjson|tojson }};
function tr(k){ return T[k] || k; }
function setLang(l){ document.cookie='lang='+l+';path=/;max-age=31536000'; location.reload(); }
function setTheme(t){ document.cookie='theme='+t+';path=/;max-age=31536000'; location.reload(); }
function setGame(g){ document.cookie='game='+g+';path=/;max-age=31536000'; location.reload(); }

var KEYS = {{ keys_json|tojson }};
var TAG_CODES = [{% for code, a, b, c in tags_def %}"{{code}}"{% if not loop.last %},{% endif %}{% endfor %}];

function toast(msg, kind){
  var t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  document.getElementById('toasts').appendChild(t);
  setTimeout(function(){ t.style.opacity = '0'; t.style.transition='opacity .3s'; setTimeout(function(){ t.remove(); }, 300); }, 2600);
}

/* переключение тегов (пилюль) */
function bindTags(container){
  container.querySelectorAll('.tag').forEach(function(el){
    el.addEventListener('click', function(){
      var cb = el.querySelector('input[type=checkbox]');
      cb.checked = !cb.checked;
      el.classList.toggle('on', cb.checked);
    });
  });
}
bindTags(document.getElementById('tags'));
bindTags(document.getElementById('mtags'));
function setTags(container, list){
  container.querySelectorAll('.tag').forEach(function(el){
    var on = list.indexOf(el.dataset.code) >= 0;
    el.querySelector('input[type=checkbox]').checked = on;
    el.classList.toggle('on', on);
  });
}
function getTags(container){
  var out = [];
  container.querySelectorAll('.tag input[type=checkbox]').forEach(function(cb){
    if (cb.checked) out.push(cb.value);
  });
  return out;
}

function closeModal(){ document.getElementById('mask').classList.remove('open'); }
function openModal(key){
  var k = null;
  for (var i=0;i<KEYS.length;i++){ if (KEYS[i].key === key){ k = KEYS[i]; break; } }
  if (!k) return;
  document.getElementById('mkey').textContent = k.key;
  document.getElementById('mkeyinput').value = k.key;
  document.getElementById('mname').value = k.name || '';
  document.getElementById('mnote').value = k.note || '';
  document.getElementById('mdays').value = k.days_total || 0;
  document.getElementById('mactive').value = k.active ? '1' : '0';
  setTags(document.getElementById('mtags'), k.perks || []);
  document.getElementById('mask').classList.add('open');
}
document.getElementById('mform').addEventListener('submit', function(e){
  e.preventDefault();
  var fd = new FormData(this);
  fetch('/edit', {method:'POST', body: fd})
    .then(function(){ toast(tr('saved'),'ok'); closeModal(); setTimeout(function(){ location.reload(); }, 350); })
    .catch(function(){ toast(tr('neterr'),'err'); });
});

/* живая подсказка ключа */
function previewKey(v){
  var s = (v||'').toUpperCase().replace(/[^A-Z0-9-]/g,'').replace(/\\s+/g,'').replace(/-+/g,'-').replace(/^-+|-+$/g,'');
  if (!s) return '';
  var PREFIX = '{{ 'CS2' if game=='cs2' else 'SPRC' }}';
  if (s.indexOf(PREFIX+'-')===0 || s===PREFIX) return s;
  return PREFIX+'-'+s;
}
var kn = document.getElementById('key_name'), kh = document.getElementById('keyhint');
kn.addEventListener('input', function(){ var p = previewKey(kn.value); kh.textContent = p ? ('→ '+p) : ''; });

/* пресеты срока */
document.querySelectorAll('.chipbtn').forEach(function(b){
  b.addEventListener('click', function(){ var inp = document.getElementById('days'); if (inp) inp.value = b.dataset.days; });
});

/* генерация — БЕЗ перехода на другую страницу: показываем модалку */
document.getElementById('genform').addEventListener('submit', function(e){
  e.preventDefault();
  var fd = new FormData(this);
  fetch('/generate', {method:'POST', body: fd})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j.ok){
        var list = document.getElementById('genlist'); list.innerHTML = '';
        (j.keys||[]).forEach(function(k){
          var row = document.createElement('div'); row.className = 'gen-item';
          row.innerHTML = '<span class="gk">'+k+'</span>';
          var b = document.createElement('button'); b.className='copy'; b.textContent=tr('copy');
          b.setAttribute('data-copy', k);
          bindCopy(b);
          row.appendChild(b); list.appendChild(row);
        });
        document.getElementById('genmask').classList.add('open');
        toast(tr('created').replace('{n}', (j.keys||[]).length),'ok');
        document.getElementById('genform').reset();
        kn.value=''; kh.textContent='';
        setTags(document.getElementById('tags'), []);
      } else {
        toast(j.error || tr('error'),'err');
      }
    })
    .catch(function(){ toast(tr('neterr'),'err'); });
});
function closeGen(){ document.getElementById('genmask').classList.remove('open'); }
document.getElementById('gencopyall').addEventListener('click', function(){
  var ks = (document.getElementById('genlist').textContent||'').split(tr('copy')).join(' ').trim();
  navigator.clipboard.writeText(ks).then(function(){ toast(tr('allcopied'),'ok'); });
});

/* копирование */
function bindCopy(b){
  b.addEventListener('click', function(){
    navigator.clipboard.writeText(b.dataset.copy).then(function(){
      var old=b.textContent; b.textContent=tr('copied'); setTimeout(function(){ b.textContent=old; }, 900);
    });
  });
}
document.querySelectorAll('.copy').forEach(bindCopy);

/* действия в таблице (extend / reset_hwid / toggle / delete) */
document.addEventListener('click', function(e){
  var t = e.target;
  if (t.dataset && t.dataset.edit){ openModal(t.dataset.edit); return; }
  var act = t.dataset && t.dataset.act;
  if (act){
    if (act === 'delete' && !confirm(tr('del_q').replace('{k}', t.dataset.key))) return;
    var fd = new FormData(); fd.append('key', t.dataset.key);
    if (act === 'extend') fd.append('days','30');
    fetch('/'+act, {method:'POST', body: fd})
      .then(function(){ toast(tr('done'),'ok'); setTimeout(function(){ location.reload(); }, 350); })
      .catch(function(){ toast(tr('neterr'),'err'); });
    return;
  }
});

/* фильтр / поиск */
document.getElementById('mask').addEventListener('click', function(e){ if (e.target===this) closeModal(); });
document.getElementById('genmask').addEventListener('click', function(e){ if (e.target===this) closeGen(); });
document.addEventListener('keydown', function(e){ if (e.key==='Escape'){ closeModal(); closeGen(); } });
var q = document.getElementById('q'), flt = document.getElementById('flt'), cnt = document.getElementById('cnt');
function applyFilter(){
  var s=(q.value||'').toLowerCase(), f=flt.value, shown=0;
  var rows=document.querySelectorAll('#tbl tbody tr');
  for (var i=0;i<rows.length;i++){
    var r=rows[i];
    var okS=!s||(r.dataset.search||'').indexOf(s)>=0;
    var okF=!f
      || (f==='tagged' && r.dataset.tagged==='1')
      || (f==='bound' && r.dataset.bound==='1')
      || (f==='free' && r.dataset.bound==='0')
      || (['active','disabled','expired'].indexOf(f)>=0 && r.dataset.st===f);
    var vis=okS&&okF; r.style.display=vis?'':'none'; if(vis) shown++;
  }
  cnt.textContent = shown+' / '+rows.length;
}
q.addEventListener('input', applyFilter);
flt.addEventListener('change', applyFilter);
applyFilter();
</script>
</body></html>
"""

LOGIN_PAGE = """
<!doctype html><html lang="{{ lang }}" data-theme="{{ theme }}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ _('login_title') }}</title><style>{{ style|safe }}</style></head><body>
<div class="wrap" style="max-width:400px;padding-top:14vh">
  <div class="brand" style="margin-bottom:22px">
    <div class="logo">S</div>
    <div><h1>SPRI<span>CE</span></h1><div class="sub">{{ _('admin_access') }}</div></div>
  </div>
  <div class="card">
    <form method="post">
      <div class="f"><label>{{ _('password') }}</label>
        <input type="password" name="password" placeholder="{{ _('password_ph') }}" autofocus></div>
      <button class="block" type="submit">{{ _('enter') }}</button>
    </form>
    {% if error %}<div class="err">{{error}}</div>{% endif %}
  </div>
  <div class="head-right" style="justify-content:center;margin-top:16px">
    <div class="themes">
      {% for code, name, c1, c2 in theme_swatches %}
      <button type="button" class="swatch {{ 'on' if theme==code else '' }}" title="{{name}}"
        onclick="setTheme('{{code}}')" style="background:linear-gradient(135deg,{{c1}},{{c2}})"></button>
      {% endfor %}
    </div>
    <div class="langswitch">
      <button class="ghost sm lang {{ 'on' if lang=='ru' else '' }}" type="button" onclick="setLang('ru')">{{ _('lang_ru') }}</button>
      <button class="ghost sm lang {{ 'on' if lang=='en' else '' }}" type="button" onclick="setLang('en')">{{ _('lang_en') }}</button>
    </div>
  </div>
</div>
<script>
function setLang(l){ document.cookie='lang='+l+';path=/;max-age=31536000'; location.reload(); }
function setTheme(t){ document.cookie='theme='+t+';path=/;max-age=31536000'; location.reload(); }
</script>
</body></html>
"""


# ============================================================================
#  Вспомогательное для таблицы
# ============================================================================

def load_keys_view(game="roblox"):
    """Собирает строки для таблицы: сроки, теги, короткий HWID.
    Показывает только ключи выбранной игры (cookie `game`)."""
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM keys WHERE COALESCE(game,'roblox')=? ORDER BY created DESC, key DESC",
            (game,),
        ).fetchall()
    finally:
        conn.close()

    now = now_epoch()
    out = []
    for r in rows:
        d = dict(r)
        ep = row_expiry_epoch(r)
        d["exp_epoch"] = ep
        d["expires"] = epoch_to_str(ep) if ep > 0 else ""
        d["expired"] = bool(ep > 0 and now > ep)
        d["days_left"] = None if ep <= 0 else max(0, (ep - now) // 86400)
        d["perk_list"] = tags_from_str(d.get("perks", ""))

        hwids = [h for h in (d.get("hwids") or "").split(",") if h]
        if not hwids:
            hwids = [d.get("hwid") or ""] if d.get("hwid") else []
        d["hwids"] = ",".join(hwids)
        d["hwid_short"] = (hwids[0][:10] + "…") if hwids and len(hwids[0]) > 10 else (hwids[0] if hwids else "")
        d["hwid_count"] = len(hwids)
        d["max_devices"] = max_devices(d["perk_list"])
        out.append(d)
    return out


def build_stats(rows):
    now = now_epoch()
    s = {"total": len(rows), "active": 0, "bound": 0, "soon": 0, "expired": 0, "tagged": 0}
    for k in rows:
        if k["active"]:
            s["active"] += 1
        if k["hwids"]:
            s["bound"] += 1
        if k["perk_list"]:
            s["tagged"] += 1
        ep = k["exp_epoch"]
        if ep > 0:
            if now > ep:
                s["expired"] += 1
            elif ep - now <= 7 * 86400:
                s["soon"] += 1
    return s


def keys_json_for_js(rows):
    """Список для JS. НЕ json.dumps — в шаблоне фильтр |tojson, который
    корректно эскейпит спецсимволы внутри <script>."""
    out = []
    for k in rows:
        ep = k["exp_epoch"]
        days_total = 0
        if ep > 0:
            days_total = max(0, (ep - now_epoch()) // 86400)
        out.append({
            "key": k["key"],
            "name": k.get("name") or "",
            "note": k.get("note") or "",
            "perks": k["perk_list"],
            "active": 1 if k["active"] else 0,
            "days_total": days_total,
        })
    return out


# ============================================================================
#  Админка
# ============================================================================

@app.route("/")
def index():
    """Панель ROBLOX (ключи только роблоксовской игры)."""
    return _render_index("roblox")


@app.route("/cs2")
def index_cs2():
    """Отдельная панель CS2: свой список ключей и свой канал обновлений."""
    return _render_index("cs2")


def _render_index(game):
    if not session.get("admin"):
        return redirect(url_for("login"))

    lang = get_lang()

    # Версия/наличие бинарника/оффсетов — для АКТИВНОЙ игры (переключатель в шапке).
    # cs2_* оставлены для возможного использования в сводке, сейчас не рисуем.
    active_version_path = CS2_VERSION_PATH if game == "cs2" else VERSION_PATH
    active_bin_path     = CS2_BIN_PATH     if game == "cs2" else BIN_PATH
    active_off_path     = CS2_OFFSETS_PATH if game == "cs2" else OFFSETS_PATH

    version = ""
    if os.path.exists(active_version_path):
        try:
            version = open(active_version_path, encoding="utf-8").read().strip()
        except Exception:
            version = ""

    rows = load_keys_view(game)
    tags_def = [(c, TAG_TITLES[lang][c], TAG_DESCS[lang][c], TAG_COLORS[c]) for c in TAG_ORDER]
    tags_map = {c: (TAG_TITLES[lang][c], TAG_DESCS[lang][c], TAG_COLORS[c]) for c in TAG_ORDER}
    return render_template_string(
        PAGE,
        style=STYLE,
        keys=rows,
        stats=build_stats(rows),
        tags_def=tags_def,
        tags_map=tags_map,
        keys_json=keys_json_for_js(rows),
        version=version or "—",
        has_binary=os.path.exists(active_bin_path),
        has_offsets=os.path.exists(active_off_path),
        cs2_version=(open(CS2_VERSION_PATH, encoding="utf-8").read().strip()
                     if os.path.exists(CS2_VERSION_PATH) else "—"),
        has_cs2_binary=os.path.exists(CS2_BIN_PATH),
        has_cs2_offsets=os.path.exists(CS2_OFFSETS_PATH),
        db=os.path.basename(DB_PATH),
        lang=lang,
        game=game,
        tjson=json.dumps(STR[lang], ensure_ascii=False),
        theme=get_theme(),
        theme_swatches=theme_swatches(lang),
    )


@app.route("/login", methods=["GET", "POST"])
@limited(limit=15, window=60, tag="login")
def login():
    error = None
    if request.method == "POST":
        if hmac.compare_digest(request.form.get("password", ""), ADMIN_PASSWORD):
            session["admin"] = True
            session.permanent = True
            log.info("ADMIN login ok from %s", client_ip())
            return redirect(url_for("index"))
        error = _tr("wrong")
        log.info("ADMIN login FAIL from %s", client_ip())
    return render_template_string(
        LOGIN_PAGE,
        style=STYLE,
        error=error,
        lang=get_lang(),
        theme=get_theme(),
        theme_swatches=theme_swatches(get_lang()),
    )


@app.route("/logout", methods=["POST", "GET"])
def logout():
    session.pop("admin", None)
    return redirect(url_for("login"))


@app.route("/generate", methods=["POST"])
@login_required
def generate():
    try:
        days = int(request.form.get("days", 30) or 30)
    except Exception:
        days = 30
    try:
        count = max(1, min(50, int(request.form.get("count", 1) or 1)))
    except Exception:
        count = 1
    note = (request.form.get("note", "") or "")[:200]
    custom = (request.form.get("key_name", "") or "").strip()
    tag_list = tags_from_str(",".join(request.form.getlist("perk")))
    tags_s = tags_to_str(tag_list)

    now = now_epoch()
    expires = now + days * 86400 if days > 0 else 0
    created_at = epoch_to_str(now)

    # Своё имя имеет смысл только для одного ключа: для пачки генерим случайные.
    if custom and count > 1:
        custom = ""

    # Свои ключи для каждой игры: у CS2 префикс CS2-, у Roblox SPRC-.
    kprefix = "CS2" if (request.form.get("game") or get_game()) == "cs2" else "SPRC"

    conn = connect()
    created = []
    err = None
    try:
        conn.execute("BEGIN")
        for _ in range(count):
            if custom:
                key = make_key_from_name(custom, kprefix)
                if not key:
                    err = "Bad name — use letters, digits and dashes"
                    break
                if key_exists(conn, key):
                    err = f"Key {key} already exists"
                    break
                name = custom
            else:
                key = random_key(kprefix)
                while key_exists(conn, key):
                    key = random_key(kprefix)
                name = ""
            conn.execute(
                "INSERT INTO keys (key, name, hwid, hwids, expires_at, expires_epoch,"
                " created, note, perks, active, game) VALUES (?,?,?,?,?,?,?,?,?,1,?)",
                (key, name, "", "", epoch_to_str(expires) if expires else "",
                 expires, created_at, note, tags_s,
                 (request.form.get("game") or get_game())),
            )
            created.append(key)
        conn.execute("COMMIT")
    except Exception:
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()

    if err:
        log.info("GENERATE failed: %s", err)
        return jsonify({"ok": False, "error": err}), 400

    log.info("GENERATE %s days=%d tags=%s", created, days, tags_s or "-")
    return jsonify({"ok": True, "keys": created})


@app.route("/edit", methods=["POST"])
@login_required
def edit():
    """Редактирование имени, заметки, тегов, срока и статуса."""
    key = norm_key(request.form.get("key", ""))
    name = (request.form.get("name", "") or "").strip()[:64]
    note = (request.form.get("note", "") or "").strip()[:200]
    tag_list = tags_from_str(",".join(request.form.getlist("perk")))
    tags_s = tags_to_str(tag_list)
    active = 1 if request.form.get("active", "1") == "1" else 0

    conn = connect()
    try:
        row = conn.execute("SELECT * FROM keys WHERE key=?", (key,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "key not found"}), 404

        try:
            days = int(request.form.get("days", 0) or 0)
        except Exception:
            days = 0
        exp = now_epoch() + days * 86400 if days > 0 else 0

        # Бонус multi_pc убран — ограничений на слоты нет, старые HWID оставляем как есть.
        hwids = [h for h in (row["hwids"] or row["hwid"] or "").split(",") if h]

        conn.execute(
            "UPDATE keys SET name=?, note=?, perks=?, active=?, expires_epoch=?,"
            " expires_at=?, hwids=? WHERE key=?",
            (name, note, tags_s, active, exp,
             epoch_to_str(exp) if exp else "", ",".join(hwids), key),
        )
        log.info("EDIT %s name=%r tags=%s days=%d active=%d", key, name, tags_s or "-", days, active)
    finally:
        conn.close()
    return redirect(url_for("index"))


@app.route("/extend", methods=["POST"])
@login_required
def extend():
    key = norm_key(request.form.get("key", ""))
    try:
        days = int(request.form.get("days", 30) or 30)
    except Exception:
        days = 30
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM keys WHERE key=?", (key,)).fetchone()
        if not row:
            return jsonify({"ok": False, "error": "key not found"}), 404
        cur = row_expiry_epoch(row)
        base = max(cur, now_epoch()) if cur > 0 else now_epoch()
        new_exp = base + days * 86400 if days > 0 else 0
        conn.execute("UPDATE keys SET expires_epoch=?, expires_at=? WHERE key=?",
                     (new_exp, epoch_to_str(new_exp) if new_exp else "", key))
        log.info("EXTEND %s +%dd", key, days)
    finally:
        conn.close()
    return redirect(url_for("index"))


@app.route("/reset_hwid", methods=["POST"])
@login_required
def reset_hwid():
    key = norm_key(request.form.get("key", ""))
    conn = connect()
    try:
        conn.execute("UPDATE keys SET hwid='', hwids='', fails=0 WHERE key=?", (key,))
        log.info("RESET HWID %s", key)
    finally:
        conn.close()
    return redirect(url_for("index"))


@app.route("/toggle", methods=["POST"])
@login_required
def toggle():
    key = norm_key(request.form.get("key", ""))
    conn = connect()
    try:
        row = conn.execute("SELECT active FROM keys WHERE key=?", (key,)).fetchone()
        if row:
            new = 0 if row["active"] else 1
            conn.execute("UPDATE keys SET active=? WHERE key=?", (new, key))
            log.info("TOGGLE %s -> %d", key, new)
    finally:
        conn.close()
    return redirect(url_for("index"))


@app.route("/delete", methods=["POST"])
@login_required
def delete():
    key = norm_key(request.form.get("key", ""))
    conn = connect()
    try:
        conn.execute("DELETE FROM keys WHERE key=?", (key,))
        log.info("DELETE %s", key)
    finally:
        conn.close()
    return redirect(url_for("index"))


@app.route("/export", methods=["GET"])
@login_required
def export():
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM keys").fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        out.append({
            "key": r["key"],
            "name": (r["name"] if "name" in r.keys() else "") or "",
            "hwid": r["hwid"] or "",
            "exp": row_expiry_epoch(r),
            "active": 1 if r["active"] else 0,
            "note": (r["note"] or "") if "note" in r.keys() else "",
            "perks": (r["perks"] or "") if "perks" in r.keys() else "",
        })
    resp = jsonify({"ok": True, "count": len(out), "keys": out})
    resp.headers["Content-Disposition"] = "attachment; filename=sprice_keys.json"
    return resp


# ============================================================================
#  Проверка ключа (клиент — лоадер)
# ============================================================================

@app.route("/verify", methods=["POST", "GET"])
@limited(limit=60, window=60, tag="verify")
def verify():
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        data = {}
    form = request.form or {}

    def pick(name):
        for src in (data, form, request.args):
            v = src.get(name)
            if v:
                return str(v)
        return ""

    key = norm_key(pick("key"))
    hwid = (pick("hwid") or "").strip()
    ip = client_ip()

    if not key or not hwid:
        log.info("VERIFY %s missing", ip)
        return jsonify({"success": False, "message": "Missing key or HWID"}), 200

    conn = connect()
    try:
        row = (conn.execute("SELECT * FROM keys WHERE key=?", (key,)).fetchone()
               or conn.execute("SELECT * FROM keys WHERE UPPER(key)=?", (key,)).fetchone())
        if not row:
            log.info("VERIFY %s NOT FOUND %s", ip, key)
            return jsonify({"success": False, "message": "Key not found"}), 200

        if not row["active"]:
            log.info("VERIFY %s DISABLED %s", ip, key)
            return jsonify({"success": False, "message": "Key disabled"}), 200

        exp = row_expiry_epoch(row)
        if exp > 0 and now_epoch() > exp:
            try:
                conn.execute("UPDATE keys SET expires_epoch=? WHERE key=?", (exp, key))
            except Exception:
                pass
            log.info("VERIFY %s EXPIRED %s", ip, key)
            return jsonify({"success": False, "message": "Key subscription has expired"}), 200

        # --- привязка к железу (один ПК на ключ) --------------------
        tag_list = tags_from_str(row["perks"] if "perks" in row.keys() else "")
        limit = max_devices(tag_list)

        hwids = [h for h in (row["hwids"] or "").split(",") if h]
        if not hwids and (row["hwid"] or ""):
            hwids = [row["hwid"]]

        matched = False
        for h in hwids:
            if hmac.compare_digest(h, hwid):
                matched = True
                break

        if not matched:
            if len(hwids) < limit:
                hwids.append(hwid)
                conn.execute("BEGIN")
                conn.execute("UPDATE keys SET hwids=?, hwid=?, fails=0 WHERE key=?",
                             (",".join(hwids), hwids[0], key))
                conn.execute("UPDATE keys SET last_seen=? WHERE key=?", (epoch_to_str(now_epoch()), key))
                conn.execute("COMMIT")
                log.info("VERIFY %s BIND %s (%d/%d)", ip, key, len(hwids), limit)
            else:
                try:
                    conn.execute("UPDATE keys SET fails=COALESCE(fails,0)+1 WHERE key=?", (key,))
                except Exception:
                    pass
                log.info("VERIFY %s MISMATCH %s (%d/%d)", ip, key, len(hwids), limit)
                return jsonify({"success": False,
                                "message": "HWID mismatch! Key tied to another PC."}), 200
        else:
            try:
                conn.execute("UPDATE keys SET last_seen=? WHERE key=?", (epoch_to_str(now_epoch()), key))
            except Exception:
                pass
            log.info("VERIFY %s OK %s", ip, key)

        name = (row["name"] if "name" in row.keys() else "") or ""
        tier = "VIP" if ("owner" in tag_list or "vip" in tag_list or "developer" in tag_list) else "STANDARD"

        return jsonify({
            "success": True,
            "message": "OK",
            "name": name,
            "tier": tier,
            "game": (row["game"] if "game" in row.keys() else "") or "roblox",
            "perks": tags_to_str(tag_list),
            "expires": epoch_to_str(exp) if exp > 0 else "lifetime",
            "expires_at": epoch_to_str(exp) if exp > 0 else "",
            "hwid": hwid,
            "devices": f"{len(hwids)}/{limit}",
            "server_time": epoch_to_str(now_epoch()),
        }), 200
    except Exception:
        log.exception("VERIFY %s ERROR %s", ip, key)
        return jsonify({"success": False, "message": "Server error - try again later"}), 200
    finally:
        conn.close()


@app.route("/ping", methods=["GET", "POST"])
def ping():
    return jsonify({"ok": True, "pong": True, "time": epoch_to_str(now_epoch())})


# ============================================================================
#  Канал обновлений
# ============================================================================

@app.route("/offsets.json", methods=["GET"])
def offsets_json():
    if not os.path.exists(OFFSETS_PATH):
        abort(404)
    return send_file(OFFSETS_PATH, mimetype="application/json")


@app.route("/version", methods=["GET"])
def version():
    if os.path.exists(VERSION_PATH):
        try:
            return open(VERSION_PATH, encoding="utf-8").read().strip()
        except Exception:
            pass
    return "1.0.0"


@app.route("/download", methods=["GET"])
def download():
    if not os.path.exists(BIN_PATH):
        abort(404)
    return send_file(BIN_PATH, as_attachment=True, download_name="SpriceOverlay.exe")


@app.route("/upload_offsets", methods=["POST"])
@login_required
def upload_offsets():
    file = request.files.get("file")
    if not file:
        return redirect(url_for("index"))
    os.makedirs(os.path.dirname(OFFSETS_PATH) or ".", exist_ok=True)
    file.save(OFFSETS_PATH)
    return redirect(url_for("index"))


@app.route("/upload_binary", methods=["POST"])
@login_required
def upload_binary():
    file = request.files.get("file")
    if not file:
        return redirect(url_for("index"))
    os.makedirs(os.path.dirname(BIN_PATH) or ".", exist_ok=True)
    file.save(BIN_PATH)
    with open(VERSION_PATH, "w", encoding="utf-8") as f:
        f.write(datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S"))
    return redirect(url_for("index"))


# ============================================================================

CS2_DIR = os.path.join(DATA_DIR, "cs2")
CS2_OFFSETS_PATH = os.path.join(CS2_DIR, "offsets.json")
CS2_VERSION_PATH = os.path.join(CS2_DIR, "version.txt")
CS2_BIN_PATH = os.path.join(CS2_DIR, "sprice.exe")
os.makedirs(CS2_DIR, exist_ok=True)

@app.route("/cs2/version")
def cs2_version():
    return open(CS2_VERSION_PATH).read().strip() if os.path.exists(CS2_VERSION_PATH) else "1.0.0"

@app.route("/roblox/version")
def roblox_version():
    return version()


# Канонические префиксные роуты для нового лоадера: /roblox/* и /cs2/*.
# Старые непрефиксные /offsets.json, /download, /version оставлены для совместимости
# с ранее задеплоенным лоадером (если панель уже в продакшне — не ломаем его).

@app.route("/roblox/offsets.json", methods=["GET"])
def roblox_offsets_json():
    if not os.path.exists(OFFSETS_PATH):
        abort(404)
    return send_file(OFFSETS_PATH, mimetype="application/json")


@app.route("/roblox/download", methods=["GET"])
def roblox_download():
    if not os.path.exists(BIN_PATH):
        abort(404)
    return send_file(BIN_PATH, as_attachment=True, download_name="SpriceOverlay.exe")


@app.route("/cs2/offsets.json", methods=["GET"])
def cs2_offsets_json():
    if not os.path.exists(CS2_OFFSETS_PATH):
        abort(404)
    return send_file(CS2_OFFSETS_PATH, mimetype="application/json")


@app.route("/cs2/download", methods=["GET"])
def cs2_download():
    if not os.path.exists(CS2_BIN_PATH):
        abort(404)
    return send_file(CS2_BIN_PATH, as_attachment=True, download_name="sprice.exe")


@app.route("/cs2/upload_offsets", methods=["POST"])
@login_required
def cs2_upload_offsets():
    file = request.files.get("file")
    if not file:
        return redirect(url_for("index"))
    os.makedirs(os.path.dirname(CS2_OFFSETS_PATH) or ".", exist_ok=True)
    file.save(CS2_OFFSETS_PATH)
    return redirect(url_for("index"))


@app.route("/cs2/upload_binary", methods=["POST"])
@login_required
def cs2_upload_binary():
    file = request.files.get("file")
    if not file:
        return redirect(url_for("index"))
    os.makedirs(os.path.dirname(CS2_BIN_PATH) or ".", exist_ok=True)
    file.save(CS2_BIN_PATH)
    with open(CS2_VERSION_PATH, "w", encoding="utf-8") as f:
        f.write(datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S"))
    return redirect(url_for("index"))


# ============================================================================
#  АККАУНТЫ, FUNPAY-АКТИВАЦИЯ, API ДЛЯ САЙТА И ЛОАДЕРА
# ----------------------------------------------------------------------------
#  Флоу: регистрация на сайте -> покупка на FunPay -> активация кода в кабинете
#  -> сервер выдаёт ключ (и пишет чек) -> скачивание лоадера -> в лоадере вход
#  по логину/паролю -> затем запрос ключа.
# ============================================================================

SESSION_DAYS = int(os.environ.get("SPRICE_SESSION_DAYS", "30"))


def _hash_pw(password, salt=None):
    """PBKDF2-SHA256, соль в начале строки."""
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 120000)
    return salt + ":" + dk.hex()


def _check_pw(password, stored):
    try:
        salt = stored.split(":", 1)[0]
    except Exception:
        return False
    try:
        return hmac.compare_digest(_hash_pw(password, salt), stored)
    except Exception:
        return False


def _new_token():
    return secrets.token_urlsafe(32)


def _bearer():
    h = request.headers.get("Authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return (request.headers.get("X-Auth-Token") or request.args.get("token") or "").strip()


def _user_by_token(conn, token):
    if not token:
        return None
    return conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id "
        "WHERE s.token=? AND (s.expires=0 OR s.expires>?)",
        (token, int(time.time())),
    ).fetchone()


def _api_json(data, status=200):
    resp = jsonify(data)
    resp.status_code = status
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Auth-Token"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def api_preflight(_any):
    return _api_json({"ok": True})


def funpay_lookup(code):
    """Ищет заказ в FunPay (нужен FUNPAY_GOLDEN_KEY продавца).
    True — оплачен; False — не найден/не оплачен; None — интеграция не настроена."""
    gk = os.environ.get("FUNPAY_GOLDEN_KEY", "").strip()
    if not gk:
        return None, None
    try:
        import urllib.request
        now = int(time.time())
        body = json.dumps({
            "action": "getSales",
            "dateFrom": now - 60 * 60 * 24 * 365,
            "dateTo": now + 60,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://funpay.com/api/",
            data=body,
            headers={"Golden-Key": gk, "Content-Type": "application/json",
                     "User-Agent": "sprice-site/1.0"},
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
        sales = []
        resp = data.get("response") if isinstance(data, dict) else None
        if isinstance(resp, dict):
            sales = resp.get("sales") or []
        if not sales and isinstance(data, dict):
            sales = data.get("sales") or []
        want = norm_key(code)
        for it in sales:
            oid = str(it.get("id") or "")
            if oid and (oid == want or oid == str(code).strip()):
                status = str(it.get("status") or "").lower()
                paid = bool(it.get("paid")) or status in ("paid", "closed", "completed", "done")
                return bool(paid), it
        return False, None
    except Exception as e:
        return None, {"error": str(e)}


def _product_game(text):
    t = (text or "").lower()
    if "cs2" in t or "кс2" in t or "counter" in t or "sprice.exe" in t:
        return "cs2"
    return "roblox"


def _issue_key(conn, user_id, game, note):
    """Создаёт ключ для аккаунта."""
    prefix = "CS2" if game == "cs2" else "SPRC"
    key = random_key(prefix)
    for _ in range(20):
        if not key_exists(conn, key):
            break
        key = random_key(prefix)
    now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO keys (key, name, hwid, hwids, expires_at, expires_epoch,"
        " created, note, perks, active, game, owner) VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
        (key, "", "", "", "", 0, now, note or "", "", game, user_id),
    )
    return key


@app.route("/api/register", methods=["POST"])
def api_register():
    d = request.get_json(silent=True) or request.form
    login = (d.get("login") or "").strip()
    pw = d.get("password") or ""
    email = (d.get("email") or "").strip()
    if len(login) < 3 or len(login) > 32:
        return _api_json({"ok": False, "error": "логин: 3..32 символа"}, 400)
    if not re.match(r"^[A-Za-z0-9_.-]+$", login):
        return _api_json({"ok": False, "error": "только латиница, цифры, . _ -"}, 400)
    if len(pw) < 6:
        return _api_json({"ok": False, "error": "пароль минимум 6 символов"}, 400)
    conn = connect()
    try:
        if conn.execute("SELECT 1 FROM users WHERE login=?", (login,)).fetchone():
            return _api_json({"ok": False, "error": "логин занят"}, 409)
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("INSERT INTO users (login, pw, email, created) VALUES (?,?,?,?)",
                     (login, _hash_pw(pw), email, now))
        uid = conn.execute("SELECT id FROM users WHERE login=?", (login,)).fetchone()["id"]
        token = _new_token()
        conn.execute("INSERT INTO sessions (token, user_id, created, expires) VALUES (?,?,?,?)",
                     (token, uid, now, int(time.time()) + SESSION_DAYS * 86400))
        return _api_json({"ok": True, "token": token, "login": login, "user_id": uid})
    finally:
        conn.close()


@app.route("/api/login", methods=["POST"])
def api_login():
    d = request.get_json(silent=True) or request.form
    login = (d.get("login") or "").strip()
    pw = d.get("password") or ""
    hwid = (d.get("hwid") or "").strip()
    conn = connect()
    try:
        u = conn.execute("SELECT * FROM users WHERE login=?", (login,)).fetchone()
        if not u or not _check_pw(pw, u["pw"]):
            return _api_json({"ok": False, "error": "неверный логин или пароль"}, 401)
        if u["banned"]:
            return _api_json({"ok": False, "error": "аккаунт заблокирован"}, 403)
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("UPDATE users SET last_login=?, hwid=? WHERE id=?",
                     (now, hwid or u["hwid"], u["id"]))
        token = _new_token()
        conn.execute("INSERT INTO sessions (token, user_id, created, expires) VALUES (?,?,?,?)",
                     (token, u["id"], now, int(time.time()) + SESSION_DAYS * 86400))
        return _api_json({"ok": True, "token": token, "login": u["login"], "user_id": u["id"]})
    finally:
        conn.close()


@app.route("/api/loader_login", methods=["POST"])
def api_loader_login():
    """Вход из лоадера: логин/пароль -> токен (лоадер запоминает)."""
    d = request.get_json(silent=True) or request.form
    login = (d.get("login") or "").strip()
    pw = d.get("password") or ""
    hwid = (d.get("hwid") or "").strip()
    conn = connect()
    try:
        u = conn.execute("SELECT * FROM users WHERE login=?", (login,)).fetchone()
        if not u or not _check_pw(pw, u["pw"]):
            return _api_json({"ok": False, "error": "Неверный логин или пароль"}, 401)
        if u["banned"]:
            return _api_json({"ok": False, "error": "Аккаунт заблокирован"}, 403)
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("UPDATE users SET last_login=?, hwid=? WHERE id=?",
                     (now, hwid or u["hwid"], u["id"]))
        token = _new_token()
        conn.execute("INSERT INTO sessions (token, user_id, created, expires) VALUES (?,?,?,?)",
                     (token, u["id"], now, int(time.time()) + SESSION_DAYS * 86400))
        keys = conn.execute(
            "SELECT key, game, expires_at, active FROM keys WHERE owner=? ORDER BY created DESC",
            (u["id"],),
        ).fetchall()
        return _api_json({"ok": True, "token": token, "login": u["login"], "user_id": u["id"],
                          "keys": [dict(k) for k in keys]})
    finally:
        conn.close()


@app.route("/api/me", methods=["GET", "POST"])
def api_me():
    conn = connect()
    try:
        u = _user_by_token(conn, _bearer())
        if not u:
            return _api_json({"ok": False, "error": "unauthorized"}, 401)
        keys = conn.execute(
            "SELECT key, game, expires_at, active, hwid, note, created FROM keys "
            "WHERE owner=? ORDER BY created DESC", (u["id"],)).fetchall()
        orders = conn.execute(
            "SELECT id, code, product, game, status, key, price, created, activated "
            "FROM orders WHERE user_id=? ORDER BY id DESC", (u["id"],)).fetchall()
        return _api_json({"ok": True, "login": u["login"], "email": u["email"],
                          "created": u["created"],
                          "keys": [dict(k) for k in keys],
                          "orders": [dict(o) for o in orders]})
    finally:
        conn.close()


@app.route("/api/activate", methods=["POST"])
def api_activate():
    conn = connect()
    try:
        u = _user_by_token(conn, _bearer())
        if not u:
            return _api_json({"ok": False, "error": "unauthorized"}, 401)
        d = request.get_json(silent=True) or request.form
        code = norm_key(d.get("code") or "")
        if len(code) < 4:
            return _api_json({"ok": False, "error": "укажи код заказа FunPay"}, 400)

        ex = conn.execute("SELECT * FROM orders WHERE code=?", (code,)).fetchone()
        if ex:
            if ex["user_id"] == u["id"]:
                return _api_json({"ok": True, "key": ex["key"], "status": ex["status"],
                                  "already": True, "game": ex["game"]})
            return _api_json({"ok": False, "error": "этот код уже активирован"}, 409)

        ok, info = funpay_lookup(code)
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

        if ok is True:
            product = str((info or {}).get("description") or (info or {}).get("title") or "sprice")
            price = str((info or {}).get("price") or "")
            game = _product_game(product)
            key = _issue_key(conn, u["id"], game, "funpay:" + code)
            conn.execute(
                "INSERT INTO orders (user_id, code, product, game, status, key, price, created, activated)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (u["id"], code, product, game, "activated", key, price, now, now))
            return _api_json({"ok": True, "key": key, "game": game, "status": "activated",
                              "product": product, "price": price, "activated": now})

        if ok is False:
            return _api_json({"ok": False, "error": "заказ не найден или не оплачен"}, 404)

        conn.execute(
            "INSERT INTO orders (user_id, code, product, game, status, key, price, created)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (u["id"], code, "", "roblox", "pending", "", "", now))
        return _api_json({"ok": True, "status": "pending",
                          "message": "Заявка отправлена — ключ выдаст администратор"})
    finally:
        conn.close()


@app.route("/api/receipt/<int:oid>", methods=["GET"])
def api_receipt(oid):
    conn = connect()
    try:
        u = _user_by_token(conn, _bearer())
        if not u:
            return _api_json({"ok": False, "error": "unauthorized"}, 401)
        o = conn.execute("SELECT * FROM orders WHERE id=? AND user_id=?", (oid, u["id"])).fetchone()
        if not o:
            return _api_json({"ok": False, "error": "чек не найден"}, 404)
        return _api_json({"ok": True, "receipt": {
            "number": "SPR-%06d" % o["id"], "login": u["login"], "code": o["code"],
            "product": o["product"], "game": o["game"], "status": o["status"],
            "key": o["key"], "price": o["price"], "created": o["created"],
            "activated": o["activated"], "service": "Sprice Private"}})
    finally:
        conn.close()


@app.route("/orders", methods=["GET"])
@login_required
def admin_orders():
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT o.*, u.login AS ulogin FROM orders o LEFT JOIN users u ON u.id=o.user_id"
            " ORDER BY o.id DESC LIMIT 200").fetchall()
        out = [dict(r) for r in rows]
    finally:
        conn.close()
    return jsonify({"ok": True, "orders": out})


@app.route("/orders/approve", methods=["POST"])
@login_required
def admin_order_approve():
    d = request.get_json(silent=True) or {}
    oid = request.form.get("id") or d.get("id")
    game = (request.form.get("game") or d.get("game") or "roblox").strip().lower()
    if game not in ("roblox", "cs2"):
        game = "roblox"
    conn = connect()
    try:
        o = conn.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
        if not o:
            return jsonify({"ok": False, "error": "нет заявки"}), 404
        key = o["key"] or _issue_key(conn, o["user_id"], game, "order:" + str(o["id"]))
        now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("UPDATE orders SET status='activated', key=?, game=?, activated=? WHERE id=?",
                     (key, game, now, oid))
        return jsonify({"ok": True, "key": key})
    finally:
        conn.close()



# ============================================================================
#  СЕРВЕРНЫЙ API ДЛЯ САЙТА (spriceprivate.com)
# ----------------------------------------------------------------------------
#  Сайт после оплаты FunPay просит панель выдать ключ. Защищено общим секретом
#  SPRICE_API_SECRET (env), заголовок X-Api-Secret.
# ============================================================================

SPRICE_API_SECRET_DEFAULT = "3ba2a0313b51a9671ef2b94065e27d305b01f72147a18ba0"


def _api_secret_ok():
    want = os.environ.get("SPRICE_API_SECRET", "").strip() or SPRICE_API_SECRET_DEFAULT
    if not want:
        return False
    got = (request.headers.get("X-Api-Secret") or request.headers.get("x-api-secret") or "").strip()
    return hmac.compare_digest(got, want)


@app.route("/api/issue_key", methods=["POST"])
def api_issue_key():
    """Создаёт ключ для владельца (аккаунт сайта). Сайт -> панель."""
    if not _api_secret_ok():
        return _api_json({"ok": False, "error": "forbidden"}, 403)
    d = request.get_json(silent=True) or request.form
    owner_login = (d.get("owner") or "").strip()
    game = (d.get("game") or "roblox").strip().lower()
    if game not in ("roblox", "cs2"):
        game = "roblox"
    days = int(d.get("days") or 0)
    note = (d.get("note") or "").strip()[:200]
    conn = connect()
    try:
        uid = 0
        if owner_login:
            u = conn.execute("SELECT id FROM users WHERE login=?", (owner_login,)).fetchone()
            if u:
                uid = u["id"]
        key = _issue_key(conn, uid, game, note)
        if days > 0:
            exp = int(time.time()) + days * 86400
            conn.execute("UPDATE keys SET expires_epoch=?, expires_at=? WHERE key=?",
                         (exp, epoch_to_str(exp), key))
        return _api_json({"ok": True, "key": key, "game": game, "days": days})
    finally:
        conn.close()


@app.route("/api/key_info", methods=["GET"])
def api_key_info():
    """Информация о ключе (для сайта)."""
    if not _api_secret_ok():
        return _api_json({"ok": False, "error": "forbidden"}, 403)
    key = norm_key(request.args.get("key") or "")
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM keys WHERE key=?", (key,)).fetchone()
        if not r:
            return _api_json({"ok": False, "error": "not_found"}, 404)
        return _api_json({"ok": True, "key": r["key"], "game": r["game"],
                          "active": int(r["active"] or 0),
                          "expires_at": r["expires_at"], "hwid": r["hwid"] or ""})
    finally:
        conn.close()



@app.route("/api/bind_key", methods=["POST"])
def api_bind_key():
    """Привязка ключа (купленного на FunPay) к аккаунту сайта.
    Тело: {key, owner}. Если ключ свободен — привязываем; если уже привязан
    к этому же владельцу — ок; к другому — отказ."""
    if not _api_secret_ok():
        return _api_json({"ok": False, "error": "forbidden"}, 403)
    d = request.get_json(silent=True) or request.form
    key = norm_key(d.get("key") or "")
    owner_login = (d.get("owner") or "").strip()
    if not key:
        return _api_json({"ok": False, "error": "key_required"}, 400)
    conn = connect()
    try:
        r = conn.execute("SELECT * FROM keys WHERE key=?", (key,)).fetchone()
        if not r:
            return _api_json({"ok": False, "error": "key_not_found"}, 404)
        if int(r["active"] or 0) != 1:
            return _api_json({"ok": False, "error": "key_disabled"}, 403)
        exp = int(r["expires_epoch"] or 0)
        if exp and exp < int(time.time()):
            return _api_json({"ok": False, "error": "key_expired"}, 403)

        uid = 0
        if owner_login:
            u = conn.execute("SELECT id FROM users WHERE login=?", (owner_login,)).fetchone()
            if u:
                uid = u["id"]

        # Ключ мог быть привязан к логину сайта (owner_login) или к аккаунту панели (owner)
        cur_login = (r["owner_login"] or "").strip() if "owner_login" in r.keys() else ""
        cur_owner = int(r["owner"] or 0)
        if cur_login and owner_login and cur_login.lower() != owner_login.lower():
            return _api_json({"ok": False, "error": "key_already_bound"}, 409)
        if cur_owner and uid and cur_owner != uid:
            return _api_json({"ok": False, "error": "key_already_bound"}, 409)

        if owner_login and cur_login.lower() != owner_login.lower():
            conn.execute("UPDATE keys SET owner_login=? WHERE key=?", (owner_login, key))
        if uid and cur_owner != uid:
            conn.execute("UPDATE keys SET owner=? WHERE key=?", (uid, key))

        return _api_json({"ok": True, "key": r["key"], "game": r["game"],
                          "expires_at": r["expires_at"],
                          "bound": bool(owner_login or uid)})
    finally:
        conn.close()


if __name__ == "__main__":
    print(f"[SPRICE] panel on http://{HOST}:{PORT}  db={DB_PATH}")
    app.run(host=HOST, port=PORT, debug=False)
