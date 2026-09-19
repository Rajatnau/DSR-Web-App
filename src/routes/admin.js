'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../validate');
const config = require('../config');
const excel = require('../excel');
const { requireAdmin } = require('../auth');
const { today } = require('../dates');

const router = express.Router();
router.use(requireAdmin);

const isUniqueViolation = (err) => /UNIQUE/i.test(String(err?.message));

function defaultRange(req) {
  const to = v.optionalDate(req.query.to, 'To date') ?? today();
  const from = v.optionalDate(req.query.from, 'From date') ?? `${to.slice(0, 7)}-01`;
  if (from > to) throw v.badRequest('From date must not be after To date');
  return { from, to };
}

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

router.get('/users', v.asyncRoute(async (_req, res) => {
  const users = await db.all(`
    SELECT u.id, u.employee_code, u.name, u.email, u.role, u.department,
           u.hourly_rate, u.is_active, u.must_reset, u.created_at,
           COALESCE(SUM(e.hours), 0) AS total_hours
    FROM users u LEFT JOIN entries e ON e.user_id = u.id
    GROUP BY u.id ORDER BY u.is_active DESC, u.employee_code
  `);
  res.json({ users });
}));

router.post('/users', v.asyncRoute(async (req, res) => {
  const employeeCode = v.str(req.body?.employeeCode, 'Employee code', { required: true, max: 30 }).toUpperCase();
  const name = v.str(req.body?.name, 'Name', { required: true, max: 120 });
  const email = v.email(req.body?.email);
  const password = v.password(req.body?.password, 'Temporary password');
  const role = req.body?.role === 'admin' ? 'admin' : 'employee';
  const department = v.str(req.body?.department, 'Department', { max: 80 });
  const hourlyRate = v.money(req.body?.hourlyRate, 'Hourly rate');

  try {
    const info = await db.run(
      `INSERT INTO users (employee_code, name, email, password_hash, role, department, hourly_rate, must_reset)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [employeeCode, name, email, await bcrypt.hash(password, 12), role, department, hourlyRate]
    );
    excel.scheduleSync();
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    if (isUniqueViolation(err)) throw v.badRequest('That employee code or email is already registered');
    throw err;
  }
}));

router.put('/users/:id', v.asyncRoute(async (req, res) => {
  const userId = v.id(req.params.id, 'User');
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const name = v.str(req.body?.name, 'Name', { required: true, max: 120 });
  const department = v.str(req.body?.department, 'Department', { max: 80 });
  const hourlyRate = v.money(req.body?.hourlyRate, 'Hourly rate');
  const role = req.body?.role === 'admin' ? 'admin' : 'employee';
  const isActive = v.bool(req.body?.isActive);

  if (user.id === req.user.id && !isActive) {
    throw v.badRequest('You cannot deactivate your own account');
  }

  // Never let the last active administrator lock everyone out.
  const losingAdmin = user.role === 'admin' && user.is_active && (role !== 'admin' || !isActive);
  if (losingAdmin) {
    const { n } = await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1");
    if (n <= 1) throw v.badRequest('This is the only active administrator — promote someone else first');
  }

  await db.run(
    'UPDATE users SET name = ?, department = ?, hourly_rate = ?, role = ?, is_active = ? WHERE id = ?',
    [name, department, hourlyRate, role, isActive, userId]
  );

  excel.scheduleSync();
  res.json({ ok: true });
}));

router.post('/users/:id/reset-password', v.asyncRoute(async (req, res) => {
  const userId = v.id(req.params.id, 'User');
  const password = v.password(req.body?.password, 'Temporary password');
  const info = await db.run('UPDATE users SET password_hash = ?, must_reset = 1 WHERE id = ?', [
    await bcrypt.hash(password, 12),
    userId,
  ]);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

router.get('/projects', v.asyncRoute(async (_req, res) => {
  const projects = await db.all(`
    SELECT p.id, p.code, p.name, p.client, p.is_billable, p.is_active, p.created_at,
           COALESCE(SUM(e.hours), 0)                   AS total_hours,
           COALESCE(SUM(e.hours * e.rate_snapshot), 0) AS total_cost
    FROM projects p LEFT JOIN entries e ON e.project_id = p.id
    GROUP BY p.id ORDER BY p.is_active DESC, p.code
  `);
  res.json({ projects });
}));

router.post('/projects', v.asyncRoute(async (req, res) => {
  const code = v.str(req.body?.code, 'Project code', { required: true, max: 30 }).toUpperCase();
  const name = v.str(req.body?.name, 'Project name', { required: true, max: 150 });
  const client = v.str(req.body?.client, 'Client', { max: 120 });
  const isBillable = v.bool(req.body?.isBillable);

  try {
    const info = await db.run(
      'INSERT INTO projects (code, name, client, is_billable) VALUES (?, ?, ?, ?)',
      [code, name, client, isBillable]
    );
    excel.scheduleSync();
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    if (isUniqueViolation(err)) throw v.badRequest('A project with that code already exists');
    throw err;
  }
}));

router.put('/projects/:id', v.asyncRoute(async (req, res) => {
  const projectId = v.id(req.params.id, 'Project');
  const name = v.str(req.body?.name, 'Project name', { required: true, max: 150 });
  const client = v.str(req.body?.client, 'Client', { max: 120 });
  const isBillable = v.bool(req.body?.isBillable);
  const isActive = v.bool(req.body?.isActive);

  const info = await db.run(
    'UPDATE projects SET name = ?, client = ?, is_billable = ?, is_active = ? WHERE id = ?',
    [name, client, isBillable, isActive, projectId]
  );
  if (info.changes === 0) return res.status(404).json({ error: 'Project not found' });

  excel.scheduleSync();
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Activities                                                          */
/* ------------------------------------------------------------------ */

router.get('/activities', v.asyncRoute(async (_req, res) => {
  const activities = await db.all(`
    SELECT a.id, a.name, a.is_active, COUNT(e.id) AS uses
      FROM activities a LEFT JOIN entries e ON e.activity_id = a.id
     GROUP BY a.id ORDER BY a.is_active DESC, a.name
  `);
  res.json({ activities });
}));

router.post('/activities', v.asyncRoute(async (req, res) => {
  const name = v.str(req.body?.name, 'Activity name', { required: true, max: 80 });
  try {
    const info = await db.run('INSERT INTO activities (name) VALUES (?)', [name]);
    excel.scheduleSync();
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (err) {
    if (isUniqueViolation(err)) throw v.badRequest('That activity already exists');
    throw err;
  }
}));

router.put('/activities/:id', v.asyncRoute(async (req, res) => {
  const activityId = v.id(req.params.id, 'Activity');
  const name = v.str(req.body?.name, 'Activity name', { required: true, max: 80 });
  const isActive = v.bool(req.body?.isActive);
  const info = await db.run('UPDATE activities SET name = ?, is_active = ? WHERE id = ?', [
    name,
    isActive,
    activityId,
  ]);
  if (info.changes === 0) return res.status(404).json({ error: 'Activity not found' });
  excel.scheduleSync();
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* All entries + moderation                                           */
/* ------------------------------------------------------------------ */

router.get('/entries', v.asyncRoute(async (req, res) => {
  const { from, to } = defaultRange(req);

  const clauses = ['e.entry_date BETWEEN ? AND ?'];
  const params = [from, to];

  if (req.query.userId) {
    clauses.push('e.user_id = ?');
    params.push(v.id(req.query.userId, 'Employee'));
  }
  if (req.query.projectId) {
    clauses.push('e.project_id = ?');
    params.push(v.id(req.query.projectId, 'Project'));
  }
  if (req.query.status === 'draft' || req.query.status === 'submitted') {
    clauses.push('e.status = ?');
    params.push(req.query.status);
  }

  const rows = await db.all(
    `SELECT e.id, e.entry_date, e.hours, e.rate_snapshot, e.description, e.ticket_ref, e.status,
            e.hours * e.rate_snapshot AS cost,
            u.id AS user_id, u.employee_code, u.name AS employee_name, u.department,
            p.code AS project_code, p.name AS project_name, p.is_billable,
            a.name AS activity_name
       FROM entries e
       JOIN users u      ON u.id = e.user_id
       JOIN projects p   ON p.id = e.project_id
       JOIN activities a ON a.id = e.activity_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY e.entry_date DESC, u.employee_code, e.id
      LIMIT 2000`,
    params
  );

  res.json({
    from,
    to,
    entries: rows,
    totalHours: Number(rows.reduce((s, r) => s + r.hours, 0).toFixed(2)),
    totalCost: Number(rows.reduce((s, r) => s + r.cost, 0).toFixed(2)),
    truncated: rows.length === 2000,
  });
}));

router.post('/entries/reopen', v.asyncRoute(async (req, res) => {
  const userId = v.id(req.body?.userId, 'Employee');
  const date = v.date(req.body?.date, 'Date');
  const info = await db.run(
    "UPDATE entries SET status = 'draft', updated_at = datetime('now') WHERE user_id = ? AND entry_date = ? AND status = 'submitted'",
    [userId, date]
  );
  if (info.changes === 0) throw v.badRequest('No submitted entries found for that employee and date');
  excel.scheduleSync();
  res.json({ ok: true, reopened: info.changes });
}));

router.delete('/entries/:id', v.asyncRoute(async (req, res) => {
  const entryId = v.id(req.params.id, 'Entry');
  const info = await db.run('DELETE FROM entries WHERE id = ?', [entryId]);
  if (info.changes === 0) return res.status(404).json({ error: 'Entry not found' });
  excel.scheduleSync();
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Dashboard + Excel                                                   */
/* ------------------------------------------------------------------ */

router.get('/dashboard', v.asyncRoute(async (req, res) => {
  const { from, to } = defaultRange(req);
  const range = [from, to];

  // Independent queries run in parallel: against a hosted database this is
  // one round trip of latency instead of seven.
  const [totals, billable, byProject, byEmployee, byActivity, daily, notSubmitted] = await Promise.all([
    db.get(
      `SELECT COALESCE(SUM(hours),0) AS hours,
              COALESCE(SUM(hours * rate_snapshot),0) AS cost,
              COUNT(*) AS entries,
              COUNT(DISTINCT user_id) AS people
         FROM entries WHERE entry_date BETWEEN ? AND ?`,
      range
    ),
    db.get(
      `SELECT COALESCE(SUM(e.hours),0) AS hours, COALESCE(SUM(e.hours * e.rate_snapshot),0) AS cost
         FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.entry_date BETWEEN ? AND ? AND p.is_billable = 1`,
      range
    ),
    db.all(
      `SELECT p.code, p.name, p.client, p.is_billable,
              SUM(e.hours) AS hours, SUM(e.hours * e.rate_snapshot) AS cost,
              COUNT(DISTINCT e.user_id) AS people
         FROM entries e JOIN projects p ON p.id = e.project_id
        WHERE e.entry_date BETWEEN ? AND ?
        GROUP BY p.id ORDER BY cost DESC, hours DESC`,
      range
    ),
    db.all(
      `SELECT u.employee_code, u.name, u.department,
              SUM(e.hours) AS hours, SUM(e.hours * e.rate_snapshot) AS cost,
              COUNT(DISTINCT e.entry_date) AS days_logged
         FROM entries e JOIN users u ON u.id = e.user_id
        WHERE e.entry_date BETWEEN ? AND ?
        GROUP BY u.id ORDER BY hours DESC`,
      range
    ),
    db.all(
      `SELECT a.name AS activity, SUM(e.hours) AS hours
         FROM entries e JOIN activities a ON a.id = e.activity_id
        WHERE e.entry_date BETWEEN ? AND ?
        GROUP BY a.id ORDER BY hours DESC`,
      range
    ),
    db.all(
      `SELECT entry_date AS date, SUM(hours) AS hours
         FROM entries WHERE entry_date BETWEEN ? AND ?
        GROUP BY entry_date ORDER BY entry_date`,
      range
    ),
    db.all(
      `SELECT u.employee_code, u.name
         FROM users u
        WHERE u.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM entries e WHERE e.user_id = u.id AND e.entry_date BETWEEN ? AND ?
          )
        ORDER BY u.employee_code`,
      range
    ),
  ]);

  res.json({
    from,
    to,
    currency: config.currency,
    totals,
    billable,
    byProject,
    byEmployee,
    byActivity,
    daily,
    notSubmitted,
    excel: excel.status(),
  });
}));

router.get('/export.xlsx', v.asyncRoute(async (_req, res) => {
  const stamp = today();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="DSR-${stamp}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  await excel.writeToStream(res);
  res.end();
}));

const ON_DEMAND_MESSAGE =
  'This deployment has no persistent disk, so there is no workbook file to sync or back up. ' +
  'Use Download DSR.xlsx — it is always built from the live data.';

router.post('/excel/sync', v.asyncRoute(async (_req, res) => {
  if (!config.excelFileSync) throw v.badRequest(ON_DEMAND_MESSAGE);
  await excel.syncNow();
  const status = excel.status();
  if (status.lastError) return res.status(503).json({ error: status.lastError, status });
  res.json({ ok: true, status });
}));

router.post('/excel/backup', v.asyncRoute(async (_req, res) => {
  if (!config.excelFileSync) throw v.badRequest(ON_DEMAND_MESSAGE);
  const file = await excel.backup();
  res.json({ ok: true, file });
}));

module.exports = router;
