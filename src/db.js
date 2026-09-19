'use strict';

const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const config = require('./config');

const db = new DatabaseSync(config.dbFile);

// WAL keeps readers from blocking the writer, which matters once a few people
// submit their DSR at the same time.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_code  TEXT    NOT NULL UNIQUE,
      name           TEXT    NOT NULL,
      email          TEXT    NOT NULL UNIQUE,
      password_hash  TEXT    NOT NULL,
      role           TEXT    NOT NULL DEFAULT 'employee' CHECK (role IN ('employee','admin')),
      department     TEXT    NOT NULL DEFAULT '',
      hourly_rate    REAL    NOT NULL DEFAULT 0,
      is_active      INTEGER NOT NULL DEFAULT 1,
      must_reset     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT    NOT NULL UNIQUE,
      name         TEXT    NOT NULL,
      client       TEXT    NOT NULL DEFAULT '',
      is_billable  INTEGER NOT NULL DEFAULT 1,
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      is_active  INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      project_id  INTEGER NOT NULL REFERENCES projects(id),
      activity_id INTEGER NOT NULL REFERENCES activities(id),
      entry_date  TEXT    NOT NULL,
      hours       REAL    NOT NULL CHECK (hours > 0 AND hours <= 24),
      -- The employee's hourly rate at the moment the entry was saved. Snapshotting
      -- it keeps historical project cost stable when someone's rate later changes.
      rate_snapshot REAL  NOT NULL DEFAULT 0,
      description TEXT    NOT NULL DEFAULT '',
      ticket_ref  TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, entry_date);
    CREATE INDEX IF NOT EXISTS idx_entries_date      ON entries(entry_date);
    CREATE INDEX IF NOT EXISTS idx_entries_project   ON entries(project_id);

    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      data       TEXT    NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  `);
}

function seedIfEmpty() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM activities').get();
  if (n === 0) {
    const insert = db.prepare('INSERT INTO activities (name) VALUES (?)');
    for (const name of [
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
    ]) {
      insert.run(name);
    }
  }

  const { p } = db.prepare('SELECT COUNT(*) AS p FROM projects').get();
  if (p === 0) {
    db.prepare(
      'INSERT INTO projects (code, name, client, is_billable) VALUES (?, ?, ?, ?)'
    ).run('INTERNAL', 'Internal / Non-billable', 'Internal', 0);
  }

  const { u } = db.prepare('SELECT COUNT(*) AS u FROM users').get();
  if (u === 0) {
    db.prepare(
      `INSERT INTO users (employee_code, name, email, password_hash, role, department, hourly_rate, must_reset)
       VALUES (?, ?, ?, ?, 'admin', ?, 0, 1)`
    ).run(
      'ADMIN001',
      'System Administrator',
      config.seedAdminEmail.toLowerCase(),
      bcrypt.hashSync(config.seedAdminPassword, 12),
      'Management'
    );
    console.log(
      `[db] Seeded bootstrap admin: ${config.seedAdminEmail} — change this password on first login.`
    );
  }
}

migrate();
seedIfEmpty();

module.exports = db;
