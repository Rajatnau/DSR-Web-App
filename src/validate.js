'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function str(value, field, { max = 500, required = false, trim = true } = {}) {
  let v = value == null ? '' : String(value);
  if (trim) v = v.trim();
  if (required && !v) throw badRequest(`${field} is required`);
  if (v.length > max) throw badRequest(`${field} must be ${max} characters or fewer`);
  return v;
}

function date(value, field) {
  const v = str(value, field, { required: true, max: 10 });
  if (!DATE_RE.test(v)) throw badRequest(`${field} must be in YYYY-MM-DD format`);
  // Reject things like 2025-02-30 that match the pattern but are not real dates.
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw badRequest(`${field} is not a valid date`);
  }
  return v;
}

function optionalDate(value, field) {
  if (value == null || value === '') return null;
  return date(value, field);
}

function hours(value, field = 'Hours') {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number`);
  if (n <= 0) throw badRequest(`${field} must be greater than 0`);
  if (n > 24) throw badRequest(`${field} cannot exceed 24`);
  // Quarter-hour granularity keeps the numbers clean and comparable.
  const rounded = Math.round(n * 4) / 4;
  if (Math.abs(rounded - n) > 1e-9) throw badRequest(`${field} must be in steps of 0.25`);
  return rounded;
}

function money(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be zero or a positive number`);
  return Math.round(n * 100) / 100;
}

function id(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${field} is required`);
  return n;
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on' ? 1 : 0;
}

function email(value, field = 'Email') {
  const v = str(value, field, { required: true, max: 120 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw badRequest(`${field} is not a valid email address`);
  return v;
}

function password(value, field = 'Password') {
  const v = String(value ?? '');
  if (v.length < 8) throw badRequest(`${field} must be at least 8 characters`);
  if (v.length > 200) throw badRequest(`${field} is too long`);
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) {
    throw badRequest(`${field} must contain at least one letter and one number`);
  }
  return v;
}

/** Wraps an async route so a thrown HttpError becomes a clean JSON response. */
function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = {
  HttpError,
  badRequest,
  str,
  date,
  optionalDate,
  hours,
  money,
  id,
  bool,
  email,
  password,
  asyncRoute,
};
