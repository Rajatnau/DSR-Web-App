'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');

/*
 * One small interface — all / get / run / batch — over two engines:
 *
 *  - PostgreSQL (postgres://…), e.g. Vercel's built-in Storage -> Postgres.
 *  - SQLite via libSQL: a local file (file:…) or a hosted Turso database
 *    (libsql://…).
 *
 * Route code writes one SQL dialect that both engines accept: `?` for
 * parameters (rewritten to $1, $2… for Postgres), `INSERT … ON CONFLICT DO
 * NOTHING`, `INSERT … RETURNING id`, and timestamps passed in from JavaScript
 * (nowUtc) rather than engine-specific functions like datetime('now').
 */

/* ------------------------------------------------------------------ */
/* Engines                                                             */
/* ------------------------------------------------------------------ */

// Arbitrary constant identifying "DSR schema setup" to pg_advisory_xact_lock.
const SCHEMA_LOCK_ID = 815311000;

function makePostgres() {
  const pg = require('pg');

  // COUNT(*) and BIGINT come back as strings by default (they can exceed
  // 2^53). Our counts and millisecond timestamps never do, so use numbers,
  // matching what SQLite returns.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

  const pool = new pg.Pool({
    connectionString: config.dbUrl,
    // Serverless: each warm function instance holds at most a couple of
    // connections, and lets idle ones go quickly so they don't pile up.
    max: config.isVercel ? 2 : 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => console.error('[db] idle Postgres client error:', err.message));

  // `?` -> `$1, $2, …`. None of the app's SQL has a literal question mark
  // inside a string, so a plain left-to-right swap is safe.
  const toPg = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };

  return {
    kind: 'postgres',
    async query(sql, args = []) {
      const res = await pool.query(toPg(sql), args);
      return { rows: res.rows, changes: res.rowCount ?? 0 };
    },
    async batch(statements) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const s of statements) await client.query(toPg(s.sql), s.args ?? []);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sqlScript) {
      await pool.query(sqlScript);
    },
    // Serialise schema setup across concurrent cold starts. Two instances
    // running CREATE TABLE IF NOT EXISTS at the same moment can still collide
    // in Postgres's catalog, so take a transaction-scoped advisory lock first.
    async execLocked(sqlScript) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_ID]);
        await client.query(sqlScript);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function makeLibsql() {
  const options = { url: config.dbUrl, authToken: config.dbAuthToken || undefined };

  // file: URLs need the native driver in '@libsql/client'. Requiring it loads
  // a platform binary via require(`@libsql/${target}`), a dynamic path that
  // Vercel's bundler cannot trace, so it is only required in this branch.
  // Remote URLs use '@libsql/client/web': plain JavaScript over HTTPS.
  let client;
  if (config.isFileDb) {
    fs.mkdirSync(path.dirname(path.resolve(config.dbUrl.slice('file:'.length))), { recursive: true });
    client = require('@libsql/client').createClient(options);
  } else {
    client = require('@libsql/client/web').createClient(options);
  }

  const toObjects = (rs) =>
    rs.rows.map((row) => {
      const obj = {};
      rs.columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });

  return {
    kind: 'sqlite',
    async query(sql, args = []) {
      const rs = await client.execute({ sql, args });
      return { rows: toObjects(rs), changes: rs.rowsAffected };
    },
    async batch(statements) {
      await client.batch(statements.map((s) => ({ sql: s.sql, args: s.args ?? [] })), 'write');
    },
    exec: (sqlScript) => client.executeMultiple(sqlScript),
    execLocked: (sqlScript) => client.executeMultiple(sqlScript),
    close: () => client.close(),
  };
}

const engine = config.isPostgres ? makePostgres() : makeLibsql();

/* ------------------------------------------------------------------ */
/* Public helpers                                                      */
/* ------------------------------------------------------------------ */

async function all(sql, args = []) {
  return (await engine.query(sql, args)).rows;
}

async function get(sql, args = []) {
  return (await engine.query(sql, args)).rows[0] ?? null;
}

/** For INSERT/UPDATE/DELETE. Use `INSERT … RETURNING id` + get() for new ids. */
async function run(sql, args = []) {
  const { changes } = await engine.query(sql, args);
  return { changes };
}

/** Runs several writes as one all-or-nothing transaction. */
async function batch(statements) {
  return engine.batch(statements);
}

/** "YYYY-MM-DD HH:MM:SS" in UTC — the same text format as the column defaults. */
function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

// Same tables and columns in both engines; only the column types and the
// default-timestamp expression differ. Dates stay as 'YYYY-MM-DD' text so
// range filters and the Excel export behave identically everywhere.
function schema(kind) {
  const pgsql = kind === 'postgres';
  const id = pgsql ? 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const real = pgsql ? 'DOUBLE PRECISION' : 'REAL';
  const bigint = pgsql ? 'BIGINT' : 'INTEGER';
  const now = pgsql ? "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))" : "(datetime('now'))";

  return `
  CREATE TABLE IF NOT EXISTS users (
    id             ${id},
    employee_code  TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL,
    email          TEXT    NOT NULL UNIQUE,
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
    department     TEXT    NOT NULL DEFAULT '',
    hourly_rate    ${real} NOT NULL DEFAULT 0,
    is_active      INTEGER NOT NULL DEFAULT 1,
    must_reset     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT    NOT NULL DEFAULT ${now}
  );

  CREATE TABLE IF NOT EXISTS projects (
    id           ${id},
    code         TEXT    NOT NULL UNIQUE,
    name         TEXT    NOT NULL,
    client       TEXT    NOT NULL DEFAULT '',
    is_billable  INTEGER NOT NULL DEFAULT 1,
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT ${now}
  );

  CREATE TABLE IF NOT EXISTS activities (
    id         ${id},
    name       TEXT    NOT NULL UNIQUE,
    is_active  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS entries (
    id            ${id},
    user_id       INTEGER NOT NULL REFERENCES users(id),
    project_id    INTEGER NOT NULL REFERENCES projects(id),
    activity_id   INTEGER NOT NULL REFERENCES activities(id),
    entry_date    TEXT    NOT NULL,
    hours         ${real} NOT NULL CHECK (hours > 0 AND hours <= 24),
    -- The employee's hourly rate at the moment the entry was saved. Snapshotting
    -- it keeps historical project cost stable when someone's rate later changes.
    rate_snapshot ${real} NOT NULL DEFAULT 0,
    description   TEXT    NOT NULL DEFAULT '',
    ticket_ref    TEXT    NOT NULL DEFAULT '',
    status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
    created_at    TEXT    NOT NULL DEFAULT ${now},
    updated_at    TEXT    NOT NULL DEFAULT ${now}
  );

  CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, entry_date);
  CREATE INDEX IF NOT EXISTS idx_entries_date      ON entries(entry_date);
  CREATE INDEX IF NOT EXISTS idx_entries_project   ON entries(project_id);

  CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT PRIMARY KEY,
    data       TEXT    NOT NULL,
    expires_at ${bigint} NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `;
}

const DEFAULT_ACTIVITIES = [
  'Development',
  'Code Review',
  'Testing / QA',
  'Bug Fix',
  'Design / Architecture',
  'Requirement Analysis',
  'Meeting',
  'Documentation',
  'Deployment / Release',
  'Production Support',
  'Training / Learning',
  'Administrative',
  'Leave / Holiday',
];

async function init() {
  // Variable name only, never its value: makes "which database am I on?"
  // answerable from the hosting logs.
  console.log(
    `[db] Using ${config.isPostgres ? 'PostgreSQL' : config.isFileDb ? 'local SQLite file' : 'Turso (libSQL)'} ` +
      `from ${config.dbUrlSource}`
  );

  if (config.isFileDb) {
    // WAL keeps readers from blocking the writer. These pragmas are per
    // connection and only meaningful for a local SQLite file.
    await engine.query('PRAGMA journal_mode = WAL');
    await engine.query('PRAGMA busy_timeout = 5000');
    await engine.query('PRAGMA foreign_keys = ON');
  }

  await engine.execLocked(schema(engine.kind));

  // ON CONFLICT DO NOTHING throughout: on Vercel two cold starts can run this
  // at the same moment, and neither should fail because the other won.
  const { n } = await get('SELECT COUNT(*) AS n FROM activities');
  if (n === 0) {
    await batch(
      DEFAULT_ACTIVITIES.map((name) => ({
        sql: 'INSERT INTO activities (name) VALUES (?) ON CONFLICT DO NOTHING',
        args: [name],
      }))
    );
  }

  const { p } = await get('SELECT COUNT(*) AS p FROM projects');
  if (p === 0) {
    await run(
      'INSERT INTO projects (code, name, client, is_billable) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      ['INTERNAL', 'Internal / Non-billable', 'Internal', 0]
    );
  }

  const { u } = await get('SELECT COUNT(*) AS u FROM users');
  if (u === 0) {
    const created = await run(
      `INSERT INTO users (employee_code, name, email, password_hash, role, department, hourly_rate, must_reset)
       VALUES (?, ?, ?, ?, 'admin', ?, 0, 1) ON CONFLICT DO NOTHING`,
      [
        'ADMIN001',
        'System Administrator',
        config.seedAdminEmail.toLowerCase(),
        bcrypt.hashSync(config.seedAdminPassword, 12),
        'Management',
      ]
    );
    if (created.changes) {
      console.log(
        `[db] Seeded bootstrap admin: ${config.seedAdminEmail} — change this password on first login.`
      );
    }
  }

  await run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
}

let readyPromise = null;

/**
 * Resolves once the schema exists. Memoised so it runs once per process (once
 * per cold start on Vercel); a failure clears the memo so the next request
 * retries instead of the instance being stuck broken.
 */
function ready() {
  if (!readyPromise) {
    readyPromise = init().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

function close() {
  return engine.close();
}

module.exports = { all, get, run, batch, ready, close, nowUtc, kind: engine.kind };
