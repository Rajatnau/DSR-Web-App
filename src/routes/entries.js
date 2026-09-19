'use strict';

const express = require('express');
const db = require('../db');
const v = require('../validate');
const config = require('../config');
const excel = require('../excel');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

/* ------------------------------------------------------------------ */
/* Statements                                                          */
/* ------------------------------------------------------------------ */

const qActiveProjects = db.prepare(
  'SELECT id, code, name, client, is_billable FROM projects WHERE is_active = 1 ORDER BY code'
);
const qActiveActivities = db.prepare(
  'SELECT id, name FROM activities WHERE is_active = 1 ORDER BY name'
);
const qProjectById = db.prepare('SELECT id, is_active FROM projects WHERE id = ?');
const qActivityById = db.prepare('SELECT id, is_active FROM activities WHERE id = ?');

const qEntriesInRange = db.prepare(`
  SELECT e.id, e.entry_date, e.hours, e.description, e.ticket_ref, e.status,
         e.rate_snapshot, e.project_id, e.activity_id,
         p.code AS project_code, p.name AS project_name, p.is_billable,
         a.name AS activity_name
  FROM entries e
  JOIN projects p   ON p.id = e.project_id
  JOIN activities a ON a.id = e.activity_id
  WHERE e.user_id = ? AND e.entry_date BETWEEN ? AND ?
  ORDER BY e.entry_date DESC, e.id
`);

const qDayTotal = db.prepare(
  'SELECT COALESCE(SUM(hours), 0) AS total FROM entries WHERE user_id = ? AND entry_date = ? AND id != ?'
);
const qEntryOwned = db.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?');

const insertEntry = db.prepare(`
  INSERT INTO entries (user_id, project_id, activity_id, entry_date, hours, rate_snapshot,
                       description, ticket_ref, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')
`);

const updateEntry = db.prepare(`
  UPDATE entries
     SET project_id = ?, activity_id = ?, entry_date = ?, hours = ?,
         description = ?, ticket_ref = ?, updated_at = datetime('now')
   WHERE id = ? AND user_id = ?
`);

const deleteEntry = db.prepare("DELETE FROM entries WHERE id = ? AND user_id = ? AND status = 'draft'");

const submitDay = db.prepare(
  "UPDATE entries SET status = 'submitted', updated_at = datetime('now') WHERE user_id = ? AND entry_date = ? AND status = 'draft'"
);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function today() {
  // Use the server's local calendar day; a DSR is a human workday, not a UTC one.
  const d = new Date();
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

function shiftDays(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Validates the shared body of a create/update request. */
function readEntryBody(req) {
  const entryDate = v.date(req.body?.entryDate, 'Date');
  if (entryDate > today()) throw v.badRequest('You cannot log time against a future date');

  const projectId = v.id(req.body?.projectId, 'Project');
  const activityId = v.id(req.body?.activityId, 'Activity');

  const project = qProjectById.get(projectId);
  if (!project) throw v.badRequest('Selected project does not exist');
  if (!project.is_active) throw v.badRequest('Selected project is closed');

  const activity = qActivityById.get(activityId);
  if (!activity) throw v.badRequest('Selected activity does not exist');
  if (!activity.is_active) throw v.badRequest('Selected activity is no longer in use');

  return {
    entryDate,
    projectId,
    activityId,
    hours: v.hours(req.body?.hours),
    description: v.str(req.body?.description, 'Task description', { required: true, max: 1000 }),
    ticketRef: v.str(req.body?.ticketRef, 'Ticket / reference', { max: 60 }),
  };
}

function assertDayCapacity(userId, entryDate, hours, excludeId = 0) {
  const { total } = qDayTotal.get(userId, entryDate, excludeId);
  const next = total + hours;
  if (next > config.maxHoursPerDay) {
    throw v.badRequest(
      `That would put ${entryDate} at ${next.toFixed(2)} hours, over the ${config.maxHoursPerDay}-hour daily limit. Logged so far: ${total.toFixed(2)}.`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

router.get('/lookups', (_req, res) => {
  res.json({
    projects: qActiveProjects.all(),
    activities: qActiveActivities.all(),
    today: today(),
    standardHoursPerDay: config.standardHoursPerDay,
    maxHoursPerDay: config.maxHoursPerDay,
    currency: config.currency,
  });
});

router.get('/entries', (req, res, next) => {
  try {
    const to = v.optionalDate(req.query.to, 'To date') ?? today();
    const from = v.optionalDate(req.query.from, 'From date') ?? shiftDays(to, -30);
    if (from > to) throw v.badRequest('From date must not be after To date');

    const rows = qEntriesInRange.all(req.user.id, from, to);
    const totalHours = rows.reduce((s, r) => s + r.hours, 0);

    // Day-level roll-up so the UI can show per-day totals and lock state.
    const byDate = new Map();
    for (const r of rows) {
      const d = byDate.get(r.entry_date) ?? { date: r.entry_date, hours: 0, entries: 0, submitted: true };
      d.hours += r.hours;
      d.entries += 1;
      if (r.status !== 'submitted') d.submitted = false;
      byDate.set(r.entry_date, d);
    }

    res.json({
      from,
      to,
      entries: rows,
      totalHours: Number(totalHours.toFixed(2)),
      days: [...byDate.values()].map((d) => ({ ...d, hours: Number(d.hours.toFixed(2)) })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/entries', (req, res, next) => {
  try {
    const body = readEntryBody(req);
    assertDayCapacity(req.user.id, body.entryDate, body.hours);

    const info = insertEntry.run(
      req.user.id,
      body.projectId,
      body.activityId,
      body.entryDate,
      body.hours,
      req.user.hourly_rate,
      body.description,
      body.ticketRef
    );

    excel.scheduleSync();
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    next(err);
  }
});

router.put('/entries/:id', (req, res, next) => {
  try {
    const entryId = v.id(req.params.id, 'Entry');
    const existing = qEntryOwned.get(entryId, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Entry not found' });
    if (existing.status === 'submitted') {
      return res
        .status(409)
        .json({ error: 'This day has been submitted. Ask an administrator to reopen it before editing.' });
    }

    const body = readEntryBody(req);
    assertDayCapacity(req.user.id, body.entryDate, body.hours, entryId);

    updateEntry.run(
      body.projectId,
      body.activityId,
      body.entryDate,
      body.hours,
      body.description,
      body.ticketRef,
      entryId,
      req.user.id
    );

    excel.scheduleSync();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/entries/:id', (req, res, next) => {
  try {
    const entryId = v.id(req.params.id, 'Entry');
    const existing = qEntryOwned.get(entryId, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Entry not found' });
    if (existing.status === 'submitted') {
      return res
        .status(409)
        .json({ error: 'Submitted entries cannot be deleted. Ask an administrator to reopen the day.' });
    }

    deleteEntry.run(entryId, req.user.id);
    excel.scheduleSync();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/entries/submit', (req, res, next) => {
  try {
    const entryDate = v.date(req.body?.date, 'Date');
    const { total } = qDayTotal.get(req.user.id, entryDate, 0);
    if (total === 0) throw v.badRequest('There is nothing to submit for that date');

    const info = submitDay.run(req.user.id, entryDate);
    if (info.changes === 0) throw v.badRequest('That day has already been submitted');

    excel.scheduleSync();
    res.json({ ok: true, submitted: info.changes, totalHours: Number(total.toFixed(2)) });
  } catch (err) {
    next(err);
  }
});

/** Personal roll-ups for the dashboard strip on the employee's home screen. */
router.get('/summary/me', (req, res) => {
  const t = today();
  const weekStart = shiftDays(t, -6);
  const monthStart = `${t.slice(0, 7)}-01`;

  const sum = (from, to) =>
    db
      .prepare(
        'SELECT COALESCE(SUM(hours),0) AS hours, COUNT(*) AS entries FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ?'
      )
      .get(req.user.id, from, to);

  const byProject = db
    .prepare(
      `SELECT p.code, p.name, SUM(e.hours) AS hours
         FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.user_id = ? AND e.entry_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY hours DESC LIMIT 8`
    )
    .all(req.user.id, monthStart, t);

  const missing = [];
  for (let i = 1; i <= 7; i += 1) {
    const d = shiftDays(t, -i);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue; // skip weekends
    const { total } = qDayTotal.get(req.user.id, d, 0);
    if (total === 0) missing.push(d);
  }

  res.json({
    today: sum(t, t),
    week: sum(weekStart, t),
    month: sum(monthStart, t),
    byProject,
    missingDays: missing,
    standardHoursPerDay: config.standardHoursPerDay,
  });
});

module.exports = router;
