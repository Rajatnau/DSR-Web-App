'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Loads .env if present. Deliberately hand-rolled rather than using
 * process.loadEnvFile: PowerShell's `Set-Content -Encoding utf8` writes a BOM,
 * which would turn the first key into "﻿NODE_ENV" and silently leave the
 * app in development mode. Real environment variables always win, so a
 * platform's settings are never clobbered by a stray file.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;

  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key || Object.hasOwn(process.env, key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const rootDir = path.join(__dirname, '..');
const isProduction = process.env.NODE_ENV === 'production';

// Vercel sets VERCEL=1 in every build and function. Its filesystem is read-only
// apart from /tmp and nothing written there survives, so anything that needs a
// disk has to be switched off or pointed at a hosted service.
const isVercel = Boolean(process.env.VERCEL);

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, 'data');

// Where the data lives, picked in this order:
//  1. DATABASE_URL, then POSTGRES_URL — postgres://… for PostgreSQL (what
//     Vercel's Storage -> Postgres / Neon injects), or libsql://… for Turso.
//  2. A *prefixed* Postgres variable such as DSR_DB_DATABASE_URL or
//     MYDB_POSTGRES_URL. Vercel's "Connect Project" dialog lets you type a
//     prefix, and it is easy to end up with one; recognising it saves having
//     to rename variables by hand. Only postgres:// values count, and the
//     *_UNPOOLED / *_NON_POOLING variants are skipped because the pooled URL
//     is the right one for serverless.
//  3. TURSO_DATABASE_URL — Turso.
//  4. Nothing set -> local SQLite file.
// Postgres found by any route wins over Turso: connecting a Postgres database
// is taken as the intent to use it.
function findPrefixedPostgres() {
  const isPg = (v) => /^postgres(ql)?:\/\//i.test(v || '');
  const keys = Object.keys(process.env).sort();
  for (const suffix of ['_DATABASE_URL', '_POSTGRES_URL']) {
    const key = keys.find((k) => k.endsWith(suffix) && isPg(process.env[k]));
    if (key) return key;
  }
  return null;
}

const dbUrlSource =
  (process.env.DATABASE_URL && 'DATABASE_URL') ||
  (process.env.POSTGRES_URL && 'POSTGRES_URL') ||
  findPrefixedPostgres() ||
  (process.env.TURSO_DATABASE_URL && 'TURSO_DATABASE_URL') ||
  null;
const explicitDbUrl = dbUrlSource ? process.env[dbUrlSource] : '';
const dbAuthToken = process.env.DATABASE_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || '';

if (isVercel && !explicitDbUrl) {
  throw new Error(
    'No database configured. In Vercel open Storage -> Create Database -> Postgres (Neon) and ' +
      'connect it to this project, which adds DATABASE_URL, then redeploy. (Turso also works: ' +
      'set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.) A local SQLite file would be wiped every ' +
      'time the function is recycled.'
  );
}

// libSQL wants forward slashes, including on Windows.
const dbUrl = explicitDbUrl || `file:${path.join(dataDir, 'dsr.db').replace(/\\/g, '/')}`;
const isPostgres = /^postgres(ql)?:\/\//i.test(dbUrl);

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === 'true';
}

module.exports = {
  isProduction,
  isVercel,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  rootDir,
  dataDir,
  dbUrl,
  dbAuthToken,
  isFileDb: dbUrl.startsWith('file:'),
  isPostgres,
  // Name (never the value) of the variable the database URL came from.
  dbUrlSource: dbUrlSource || 'local file',
  excelFile: path.join(dataDir, 'DSR.xlsx'),
  backupDir: path.join(dataDir, 'backups'),
  // Keep data/DSR.xlsx rewritten after every change. Needs a persistent disk,
  // so it is off on Vercel, where the workbook is built on download instead.
  excelFileSync: flag('EXCEL_FILE_SYNC', !isVercel),
  // Optional secret that unlocks /api/export/dsr.xlsx?token=... so Excel Power
  // Query or Power BI can refresh without a browser session.
  exportToken: process.env.EXPORT_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  // Behind an HTTPS proxy (Vercel, Render, nginx) Express needs this to see
  // the real client IP and protocol. Vercel always has one in front.
  trustProxy: flag('TRUST_PROXY', isVercel),
  // Defaults on in production, but an explicit setting always wins: a Secure
  // cookie is never sent over plain HTTP, so a LAN deployment must be able to
  // turn it off or nobody can sign in.
  secureCookies: flag('SECURE_COOKIES', isProduction),
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  // Bootstrap admin, only used the first time the database is created.
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@company.com',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
  // Guardrails for a single day's entries.
  maxHoursPerDay: Number(process.env.MAX_HOURS_PER_DAY) || 16,
  standardHoursPerDay: Number(process.env.STANDARD_HOURS_PER_DAY) || 8,
  currency: process.env.CURRENCY || 'INR',
  // IANA zone that defines "today" for the team, e.g. Asia/Kolkata. Needed on
  // Vercel, whose clock is UTC and which does not let you set TZ. Falls back
  // to the machine's own zone.
  timeZone:
    process.env.APP_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
};

try {
  new Intl.DateTimeFormat('en-CA', { timeZone: module.exports.timeZone });
} catch {
  throw new Error(`APP_TIMEZONE "${module.exports.timeZone}" is not a valid IANA timezone (e.g. Asia/Kolkata)`);
}
