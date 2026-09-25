'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
const DRIVER = DATABASE_URL ? 'pg' : 'sqlite';

let pool = null;
let sqlite = null;
let ready = null;

function toSqliteSql(sql) {
  let n = 0;
  return sql.replace(/\$(\d+)/g, () => {
    n += 1;
    return '?';
  });
}

function toSqliteParams(params) {
  return (params || []).map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
    return v;
  });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id              TEXT PRIMARY KEY,
     nickname        TEXT NOT NULL,
     nickname_lower  TEXT NOT NULL UNIQUE,
     email           TEXT NOT NULL,
     email_lower     TEXT NOT NULL UNIQUE,
     password_hash   TEXT NOT NULL,
     email_verified  INTEGER NOT NULL DEFAULT 0,
     role            TEXT NOT NULL DEFAULT 'customer',
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     last_login_at   TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS email_codes (
     id            TEXT PRIMARY KEY,
     user_id       TEXT,
     email_lower   TEXT NOT NULL,
     code_hash     TEXT NOT NULL,
     purpose       TEXT NOT NULL,
     expires_at    TEXT NOT NULL,
     attempts      INTEGER NOT NULL DEFAULT 0,
     max_attempts  INTEGER NOT NULL DEFAULT 5,
     consumed_at   TEXT,
     created_at    TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_codes_lookup ON email_codes (email_lower, purpose, created_at)`,

  `CREATE TABLE IF NOT EXISTS sessions (
     id          TEXT PRIMARY KEY,
     user_id     TEXT NOT NULL,
     token_hash  TEXT NOT NULL UNIQUE,
     remember    INTEGER NOT NULL DEFAULT 0,
     user_agent  TEXT,
     ip          TEXT,
     created_at  TEXT NOT NULL,
     expires_at  TEXT NOT NULL,
     revoked_at  TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)`,

  `CREATE TABLE IF NOT EXISTS orders (
     id             TEXT PRIMARY KEY,
     user_id        TEXT NOT NULL,
     product_id     TEXT NOT NULL,
     plan_idx       INTEGER NOT NULL,
     plan_duration  TEXT,
     price          TEXT,
     status         TEXT NOT NULL DEFAULT 'created',
     created_at     TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS events (
     id           TEXT PRIMARY KEY,
     kind         TEXT NOT NULL,
     user_id      TEXT,
     email_lower  TEXT,
     ip           TEXT,
     created_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind, created_at)`
];

async function init() {
  if (ready) return ready;
  ready = (async () => {
    if (DRIVER === 'pg') {
      const { Pool } = require('pg');
      const needSsl = !/localhost|127\.0\.0\.1/i.test(DATABASE_URL) && process.env.PGSSL !== 'disable';
      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: needSsl ? { rejectUnauthorized: false } : false,
        max: Number(process.env.PG_POOL_MAX || 5),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });
      pool.on('error', (e) => console.error('[db] ошибка пула:', e.message));
      for (const sql of SCHEMA) await pool.query(sql);
    } else {
      const { DatabaseSync } = require('node:sqlite');
      const file = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'sprice.db');
      if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
      sqlite = new DatabaseSync(file);
      sqlite.exec('PRAGMA journal_mode = WAL');
      sqlite.exec('PRAGMA foreign_keys = ON');
      sqlite.exec('PRAGMA busy_timeout = 5000');
      for (const sql of SCHEMA) sqlite.exec(sql);
    }
    console.log('[db] драйвер: ' + DRIVER + (DRIVER === 'sqlite' ? ' (локально; на Render будет Postgres)' : ''));
  })();
  return ready;
}

async function all(sql, params) {
  await init();
  if (DRIVER === 'pg') return (await pool.query(sql, params || [])).rows;
  return sqlite.prepare(toSqliteSql(sql)).all(...toSqliteParams(params));
}

async function get(sql, params) {
  const rows = await all(sql, params);
  return rows.length ? rows[0] : null;
}

async function run(sql, params) {
  await init();
  if (DRIVER === 'pg') {
    const r = await pool.query(sql, params || []);
    return { changes: r.rowCount };
  }
  const r = sqlite.prepare(toSqliteSql(sql)).run(...toSqliteParams(params));
  return { changes: Number(r.changes) };
}

async function tx(fn) {
  await init();
  if (DRIVER === 'pg') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn({
        all: async (s, p) => (await client.query(s, p || [])).rows,
        get: async (s, p) => {
          const r = await client.query(s, p || []);
          return r.rows.length ? r.rows[0] : null;
        },
        run: async (s, p) => ({ changes: (await client.query(s, p || [])).rowCount })
      });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }
  sqlite.exec('BEGIN');
  try {
    const out = await fn({
      all: async (s, p) => sqlite.prepare(toSqliteSql(s)).all(...toSqliteParams(p)),
      get: async (s, p) => {
        const r = sqlite.prepare(toSqliteSql(s)).all(...toSqliteParams(p));
        return r.length ? r[0] : null;
      },
      run: async (s, p) => ({ changes: Number(sqlite.prepare(toSqliteSql(s)).run(...toSqliteParams(p)).changes) })
    });
    sqlite.exec('COMMIT');
    return out;
  } catch (e) {
    try { sqlite.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

async function close() {
  if (pool) await pool.end();
  if (sqlite) sqlite.close();
}

const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

function reset() {
  ready = null;
}

module.exports = {
  DRIVER,
  init,
  all,
  get,
  run,
  tx,
  close,
  reset,
  uid,
  nowIso,
  SCHEMA,
  _toSqliteSql: toSqliteSql
};
