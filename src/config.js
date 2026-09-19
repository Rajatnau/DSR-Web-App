'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Loads .env if present. Deliberately hand-rolled rather than using
 * process.loadEnvFile: PowerShell's `Set-Content -Encoding utf8` writes a BOM,
 * which would turn the first key into "﻿NODE_ENV" and silently leave the
 * app in development mode. Real environment variables always win, so a
 * container's settings are never clobbered by a stray file.
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
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(rootDir, 'data');

fs.mkdirSync(dataDir, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set when NODE_ENV=production');
}

module.exports = {
  isProduction,
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  rootDir,
  dataDir,
  dbFile: path.join(dataDir, 'dsr.db'),
  excelFile: path.join(dataDir, 'DSR.xlsx'),
  backupDir: path.join(dataDir, 'backups'),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
  // Set to 'true' when running behind an HTTPS reverse proxy (Render, Railway, nginx).
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Defaults on in production, but an explicit setting always wins: a Secure
  // cookie is never sent over plain HTTP, so a LAN deployment must be able to
  // turn it off or nobody can sign in.
  secureCookies:
    process.env.SECURE_COOKIES == null || process.env.SECURE_COOKIES === ''
      ? isProduction
      : process.env.SECURE_COOKIES === 'true',
  sessionHours: Number(process.env.SESSION_HOURS) || 12,
  // Bootstrap admin, only used the first time the database is created.
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@company.com',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
  // Guardrails for a single day's entries.
  maxHoursPerDay: Number(process.env.MAX_HOURS_PER_DAY) || 16,
  standardHoursPerDay: Number(process.env.STANDARD_HOURS_PER_DAY) || 8,
  currency: process.env.CURRENCY || 'INR',
};
