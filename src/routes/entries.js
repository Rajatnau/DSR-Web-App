'use strict';

const express = require('express');
const db = require('../db');
const v = require('../validate');
const config = require('../config');
const excel = require('../excel');
const { requireAuth } = require('../auth');
const { today, shiftDays } = require('../dates');

const router = express.Router();
router.use(requireAuth);

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

const SQL_ENTRIES_IN_RANGE = `
  SELECT e.id, e.entry_date, e.hours, e.description, e.ticket_ref, e.status,
         e.rate_snapshot, e.project_id, e.activity_id,
         p.code AS project_code, p.name AS project_name, p.is_billable,
         a.name AS activity_name
  FROM entries e
  JOIN projects p   ON p.id = e.project_id
  JOIN activities a ON a.id = e.activity_id
  WHERE e.user_id = ? AND e.entry_date BETWEEN ? AND ?
  ORDER BY e.entry_date DESC, e.id
`;

async function dayTotal(userId, entryDate, excludeId = 0) {
  const row = await db.get(
    'SELECT COALESCE(SUM(hours), 0) AS total FROM entries WHERE user_id = ? AND entry_date = ? AND id != ?',
    [userId, entryDate, excludeId]
  );
  return row.total;
}

const ownedEntry = (id, userId) =>
  db.get('SELECT * FROM entries WHERE id = ? AND user_id = ?', [id, userId]);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Validates the shared body of a create/update request. */
async function readEntryBody(req) {
  const entryDate = v.date(req.body?.entryDate, 'Date');
  if (entryDate > today()) throw v.badRequest('You cannot log time against a future date');

  const projectId = v.id(req.body?.projectId, 'Project');
  const activityId = v.id(req.body?.activityId, 'Activity');

  const [project, activity] = await Promise.all([
    db.get('SELECT id, is_active FROM projects WHERE id = ?', [projectId]),
    db.get('SELECT id, is_active FROM activities WHERE id = ?', [activityId]),
  ]);

  if (!project) throw v.badRequest('Selected project does not exist');
  if (!project.is_active) throw v.badRequest('Selected project is closed');
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

async function assertDayCapacity(userId, entryDate, hours, excludeId = 0) {
  const total = await dayTotal(userId, entryDate, excludeId);
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

router.get('/lookups', v.asyncRoute(async (_req, res) => {
  const [projects, activities] = await Promise.all([
    db.all('SELECT id, code, name, client, is_billable FROM projects WHERE is_active = 1 ORDER BY code'),
    db.all('SELECT id, name FROM activities WHERE is_active = 1 ORDER BY name'),
  ]);
  res.json({
    projects,
    activities,
    today: today(),
    standardHoursPerDay: config.standardHoursPerDay,
    maxHoursPerDay: config.maxHoursPerDay,
    currency: config.currency,
  });
}));

router.get('/entries', v.asyncRoute(async (req, res) => {
  const to = v.optionalDate(req.query.to, 'To date') ?? today();
  const from = v.optionalDate(req.query.from, 'From date') ?? shiftDays(to, -30);
  if (from > to) throw v.badRequest('From date must not be after To date');

  const rows = await db.all(SQL_ENTRIES_IN_RANGE, [req.user.id, from, to]);
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
}));

router.post('/entries', v.asyncRoute(async (req, res) => {
  const body = await readEntryBody(req);
  await assertDayCapacity(req.user.id, body.entryDate, body.hours);

  const created = await db.get(
    `INSERT INTO entries (user_id, project_id, activity_id, entry_date, hours, rate_snapshot,
                          description, ticket_ref, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft') RETURNING id`,
    [
      req.user.id,
      body.projectId,
      body.activityId,
      body.entryDate,
      body.hours,
      req.user.hourly_rate,
      body.description,
      body.ticketRef,
    ]
  );

  excel.scheduleSync();
  res.status(201).json({ id: created.id });
}));

router.put('/entries/:id', v.asyncRoute(async (req, res) => {
  const entryId = v.id(req.params.id, 'Entry');
  const existing = await ownedEntry(entryId, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  if (existing.status === 'submitted') {
    return res
      .status(409)
      .json({ error: 'This day has been submitted. Ask an administrator to reopen it before editing.' });
  }

  const body = await readEntryBody(req);
  await assertDayCapacity(req.user.id, body.entryDate, body.hours, entryId);

  // status = 'draft' in the WHERE closes the gap where the day is submitted
  // between the check above and this write.
  const info = await db.run(
    `UPDATE entries
        SET project_id = ?, activity_id = ?, entry_date = ?, hours = ?,
            description = ?, ticket_ref = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'draft'`,
    [
      body.projectId,
      body.activityId,
      body.entryDate,
      body.hours,
      body.description,
      body.ticketRef,
      db.nowUtc(),
      entryId,
      req.user.id,
    ]
  );
  if (info.changes === 0) {
    return res.status(409).json({ error: 'This day was submitted while you were editing.' });
  }

  excel.scheduleSync();
  res.json({ ok: true });
}));

router.delete('/entries/:id', v.asyncRoute(async (req, res) => {
  const entryId = v.id(req.params.id, 'Entry');
  const existing = await ownedEntry(entryId, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Entry not found' });
  if (existing.status === 'submitted') {
    return res
      .status(409)
      .json({ error: 'Submitted entries cannot be deleted. Ask an administrator to reopen the day.' });
  }

  await db.run("DELETE FROM entries WHERE id = ? AND user_id = ? AND status = 'draft'", [
    entryId,
    req.user.id,
  ]);
  excel.scheduleSync();
  res.json({ ok: true });
}));

router.post('/entries/submit', v.asyncRoute(async (req, res) => {
  const entryDate = v.date(req.body?.date, 'Date');
  const total = await dayTotal(req.user.id, entryDate);
  if (total === 0) throw v.badRequest('There is nothing to submit for that date');

  const info = await db.run(
    "UPDATE entries SET status = 'submitted', updated_at = ? WHERE user_id = ? AND entry_date = ? AND status = 'draft'",
    [db.nowUtc(), req.user.id, entryDate]
  );
  if (info.changes === 0) throw v.badRequest('That day has already been submitted');

  excel.scheduleSync();
  res.json({ ok: true, submitted: info.changes, totalHours: Number(total.toFixed(2)) });
}));

/** Personal roll-ups for the dashboard strip on the employee's home screen. */
router.get('/summary/me', v.asyncRoute(async (req, res) => {
  const t = today();
  const weekStart = shiftDays(t, -6);
  const monthStart = `${t.slice(0, 7)}-01`;

  const sum = (from, to) =>
    db.get(
      'SELECT COALESCE(SUM(hours),0) AS hours, COUNT(*) AS entries FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ?',
      [req.user.id, from, to]
    );

  // Weekdays in the last seven days, most recent first.
  const recentWeekdays = [];
  for (let i = 1; i <= 7; i += 1) {
    const d = shiftDays(t, -i);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) recentWeekdays.push(d);
  }

  const [todaySum, week, month, byProject, logged] = await Promise.all([
    sum(t, t),
    sum(weekStart, t),
    sum(monthStart, t),
    db.all(
      `SELECT p.code, p.name, SUM(e.hours) AS hours
         FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.user_id = ? AND e.entry_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY hours DESC LIMIT 8`,
      [req.user.id, monthStart, t]
    ),
    // One query for all seven days instead of one per day: each round trip to
    // a hosted database costs real latency.
    db.all(
      'SELECT DISTINCT entry_date FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ?',
      [req.user.id, shiftDays(t, -7), shiftDays(t, -1)]
    ),
  ]);

  const loggedDays = new Set(logged.map((r) => r.entry_date));

  res.json({
    today: todaySum,
    week,
    month,
    byProject,
    missingDays: recentWeekdays.filter((d) => !loggedDays.has(d)),
    standardHoursPerDay: config.standardHoursPerDay,
  });
}));

module.exports = router;
