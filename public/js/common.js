'use strict';

/* Shared helpers used by every page. Loaded as a classic script (no modules)
   so it works from file-served static assets without a build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Escapes text before it goes into innerHTML. Every table cell uses this. */
function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });

  if (res.status === 401 && !location.pathname.endsWith('login.html')) {
    location.href = '/login.html?expired=1';
    throw new ApiError(401, 'Session expired');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, kind = 'info', ms = 4200) {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

const toastError = (err) => toast(err?.message || String(err), 'error', 6000);

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

let CURRENCY = 'INR';
const setCurrency = (c) => { CURRENCY = c || 'INR'; };

function money(n) {
  const value = Number(n) || 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: CURRENCY,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${CURRENCY} ${value.toFixed(0)}`;
  }
}

const hrs = (n) => `${(Number(n) || 0).toFixed(2)} h`;
const num = (n) => new Intl.NumberFormat().format(Number(n) || 0);

/** "2026-09-19" -> "Sat, 19 Sep 2026" without tripping over timezones. */
function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

function todayIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addDays(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(iso = todayIso()) {
  return `${iso.slice(0, 7)}-01`;
}

/* ------------------------------------------------------------------ */
/* Small UI utilities                                                  */
/* ------------------------------------------------------------------ */

/** Renders a labelled horizontal bar list into a container. */
function renderBars(container, rows, { labelKey, valueKey, format = hrs, alt = false }) {
  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="empty">No data for this period.</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  container.innerHTML = rows
    .map((r) => {
      const value = Number(r[valueKey]) || 0;
      const pct = Math.max(2, Math.round((value / max) * 100));
      return `
        <div class="bar-row">
          <div class="bar-label">${esc(r[labelKey])}</div>
          <div class="bar-value">${esc(format(value))}</div>
          <div class="bar-track"><div class="bar-fill${alt ? ' alt' : ''}" style="width:${pct}%"></div></div>
        </div>`;
    })
    .join('');
}

/** Disables a button while an async action runs, restoring its label after. */
async function withBusy(button, fn) {
  if (!button) return fn();
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function emptyRow(colspan, title, detail = '') {
  return `<tr><td colspan="${colspan}"><div class="empty"><strong>${esc(title)}</strong>${
    detail ? esc(detail) : ''
  }</div></td></tr>`;
}
