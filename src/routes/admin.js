'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const v = require('../validate');
const config = require('../config');
const excel = require('../excel');
const { requireAdmin } = require('../auth');

const router = express.Router();
router.use(requireAdmin);

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

const qUsers = db.prepare(`
  SELECT u.id, u.employee_code, u.name, u.email, u.role, u.department,
         u.hourly_rate, u.is_active, u.must_reset, u.created_at,
         COALESCE(SUM(e.hours), 0) AS total_hours
  FROM users u LEFT JOIN entries e ON e.user_id = u.id
  GROUP BY u.id ORDER BY u.is_active DESC, u.employee_code
`);

const countActiveAdmins = db.prepare(
  "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1"
);

router.get('/users', (_req, res) => res.json({ users: qUsers.all() }));

router.post('/users', (req, res, next) => {
  try {
    const employeeCode = v.str(req.body?.employeeCode, 'Employee code', { required: true, max: 30 }).toUpperCase();
    const name = v.str(req.body?.name, 'Name', { required: true, max: 120 });
    const email = v.email(req.body?.email);
    const password = v.password(req.body?.password, 'Temporary password');
    const role = req.body?.role === 'admin' ? 'admin' : 'employee';
    const department = v.str(req.body?.department, 'Department', { max: 80 });
    const hourlyRate = v.money(req.body?.hourlyRate, 'Hourly rate');

    const info = db
      .prepare(
        `INSERT INTO users (employee_code, name, email, password_hash, role, department, hourly_rate, must_reset)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(employeeCode, name, email, bcrypt.hashSync(password, 12), role, department, hourlyRate);

    excel.scheduleSync();
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return next(v.badRequest('That employee code or email is already registered'));
    }
    next(err);
  }
});

router.put('/users/:id', (req, res, next) => {
  try {
    const userId = v.id(req.params.id, 'User');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const name = v.str(req.body?.name, 'Name', { required: true, max: 120 });
    const department = v.str(req.body?.department, 'Department', { max: 80 });
    const hourlyRate = v.money(req.body?.hourlyRate, 'Hourly rate');
    const role = req.body?.role === 'admin' ? 'admin' : 'employee';
    const isActive = v.bool(req.body?.isActive);

    // Never let the last active administrator lock everyone out.
    const losingAdmin = user.role === 'admin' && user.is_active && (role !== 'admin' || !isActive);
    if (losingAdmin && countActiveAdmins.get().n <= 1) {
      throw v.badRequest('This is the only active administrator — promote someone else first');
    }
    if (user.id === req.user.id && !isActive) {
      throw v.badRequest('You cannot deactivate your own account');
    }

    db.prepare(
      'UPDATE users SET name = ?, department = ?, hourly_rate = ?, role = ?, is_active = ? WHERE id = ?'
    ).run(name, department, hourlyRate, role, isActive, userId);

    excel.scheduleSync();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/reset-password', (req, res, next) => {
  try {
    const userId = v.id(req.params.id, 'User');
    const password = v.password(req.body?.password, 'Temporary password');
    const info = db
      .prepare('UPDATE users SET password_hash = ?, must_reset = 1 WHERE id = ?')
      .run(bcrypt.hashSync(password, 12), userId);
    if (info.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

const qProjects = db.prepare(`
  SELECT p.id, p.code, p.name, p.client, p.is_billable, p.is_active, p.created_at,
         COALESCE(SUM(e.hours), 0)                   AS total_hours,
         COALESCE(SUM(e.hours * e.rate_snapshot), 0) AS total_cost
  FROM projects p LEFT JOIN entries e ON e.project_id = p.id
  GROUP BY p.id ORDER BY p.is_active DESC, p.code
`);

router.get('/projects', (_req, res) => res.json({ projects: qProjects.all() }));

router.post('/projects', (req, res, next) => {
  try {
    const code = v.str(req.body?.code, 'Project code', { required: true, max: 30 }).toUpperCase();
    const name = v.str(req.body?.name, 'Project name', { required: true, max: 150 });
    const client = v.str(req.body?.client, 'Client', { max: 120 });
    const isBillable = v.bool(req.body?.isBillable);

    const info = db
      .prepare('INSERT INTO projects (code, name, client, is_billable) VALUES (?, ?, ?, ?)')
      .run(code, name, client, isBillable);

    excel.scheduleSync();
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return next(v.badRequest('A project with that code already exists'));
    }
    next(err);
  }
});

router.put('/projects/:id', (req, res, next) => {
  try {
    const projectId = v.id(req.params.id, 'Project');
    const name = v.str(req.body?.name, 'Project name', { required: true, max: 150 });
    const client = v.str(req.body?.client, 'Client', { max: 120 });
    const isBillable = v.bool(req.body?.isBillable);
    const isActive = v.bool(req.body?.isActive);

    const info = db
      .prepare('UPDATE projects SET name = ?, client = ?, is_billable = ?, is_active = ? WHERE id = ?')
      .run(name, client, isBillable, isActive, projectId);
    if (info.changes === 0) return res.status(404).json({ error: 'Project not found' });

    excel.scheduleSync();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Activities                                                          */
/* ------------------------------------------------------------------ */

router.get('/activities', (_req, res) => {
  res.json({
    activities: db
      .prepare(
        `SELECT a.id, a.name, a.is_active, COUNT(e.id) AS uses
           FROM activities a LEFT JOIN entries e ON e.activity_id = a.id
          GROUP BY a.id ORDER BY a.is_active DESC, a.name`
      )
      .all(),
  });
});

router.post('/activities', (req, res, next) => {
  try {
    const name = v.str(req.body?.name, 'Activity name', { required: true, max: 80 });
    const info = db.prepare('INSERT INTO activities (name) VALUES (?)').run(name);
    excel.scheduleSync();
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return next(v.badRequest('That activity already exists'));
    }
    next(err);
  }
});

router.put('/activities/:id', (req, res, next) => {
  try {
    const activityId = v.id(req.params.id, 'Activity');
    const name = v.str(req.body?.name, 'Activity name', { required: true, max: 80 });
    const isActive = v.bool(req.body?.isActive);
    const info = db
      .prepare('UPDATE activities SET name = ?, is_active = ? WHERE id = ?')
      .run(name, isActive, activityId);
    if (info.changes === 0) return res.status(404).json({ error: 'Activity not found' });
    excel.scheduleSync();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* All entries + moderation                                           */
/* ------------------------------------------------------------------ */

router.get('/entries', (req, res, next) => {
  try {
    const to = v.optionalDate(req.query.to, 'To date') ?? new Date().toISOString().slice(0, 10);
    const from = v.optionalDate(req.query.from, 'From date') ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw v.badRequest('From date must not be after To date');

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

    const rows = db
      .prepare(
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
          LIMIT 2000`
      )
      .all(...params);

    res.json({
      from,
      to,
      entries: rows,
      totalHours: Number(rows.reduce((s, r) => s + r.hours, 0).toFixed(2)),
      totalCost: Number(rows.reduce((s, r) => s + r.cost, 0).toFixed(2)),
      truncated: rows.length === 2000,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/entries/reopen', (req, res, next) => {
  try {
    const userId = v.id(req.body?.userId, 'Employee');
    const date = v.date(req.body?.date, 'Date');
    const info = db
      .prepare(
        "UPDATE entries SET status = 'draft', updated_at = datetime('now') WHERE user_id = ? AND entry_date = ? AND status = 'submitted'"
      )
      .run(userId, date);
    if (info.changes === 0) throw v.badRequest('No submitted entries found for that employee and date');
    excel.scheduleSync();
    res.json({ ok: true, reopened: info.changes });
  } catch (err) {
    next(err);
  }
});

router.delete('/entries/:id', (req, res, next) => {
  try {
    const entryId = v.id(req.params.id, 'Entry');
    const info = db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
    if (info.changes === 0) return res.status(404).json({ error: 'Entry not found' });
    excel.scheduleSync();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------ */
/* Dashboard + Excel                                                   */
/* ------------------------------------------------------------------ */

router.get('/dashboard', (req, res, next) => {
  try {
    const to = v.optionalDate(req.query.to, 'To date') ?? new Date().toISOString().slice(0, 10);
    const from = v.optionalDate(req.query.from, 'From date') ?? `${to.slice(0, 7)}-01`;
    if (from > to) throw v.badRequest('From date must not be after To date');

    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(hours),0) AS hours,
                COALESCE(SUM(hours * rate_snapshot),0) AS cost,
                COUNT(*) AS entries,
                COUNT(DISTINCT user_id) AS people
           FROM entries WHERE entry_date BETWEEN ? AND ?`
      )
      .get(from, to);

    const billable = db
      .prepare(
        `SELECT COALESCE(SUM(e.hours),0) AS hours, COALESCE(SUM(e.hours * e.rate_snapshot),0) AS cost
           FROM entries e JOIN projects p ON p.id = e.project_id
          WHERE e.entry_date BETWEEN ? AND ? AND p.is_billable = 1`
      )
      .get(from, to);

    const byProject = db
      .prepare(
        `SELECT p.code, p.name, p.client, p.is_billable,
                SUM(e.hours) AS hours, SUM(e.hours * e.rate_snapshot) AS cost,
                COUNT(DISTINCT e.user_id) AS people
           FROM entries e JOIN projects p ON p.id = e.project_id
          WHERE e.entry_date BETWEEN ? AND ?
          GROUP BY p.id ORDER BY cost DESC, hours DESC`
      )
      .all(from, to);

    const byEmployee = db
      .prepare(
        `SELECT u.employee_code, u.name, u.department,
                SUM(e.hours) AS hours, SUM(e.hours * e.rate_snapshot) AS cost,
                COUNT(DISTINCT e.entry_date) AS days_logged
           FROM entries e JOIN users u ON u.id = e.user_id
          WHERE e.entry_date BETWEEN ? AND ?
          GROUP BY u.id ORDER BY hours DESC`
      )
      .all(from, to);

    const byActivity = db
      .prepare(
        `SELECT a.name AS activity, SUM(e.hours) AS hours
           FROM entries e JOIN activities a ON a.id = e.activity_id
          WHERE e.entry_date BETWEEN ? AND ?
          GROUP BY a.id ORDER BY hours DESC`
      )
      .all(from, to);

    const daily = db
      .prepare(
        `SELECT entry_date AS date, SUM(hours) AS hours
           FROM entries WHERE entry_date BETWEEN ? AND ?
          GROUP BY entry_date ORDER BY entry_date`
      )
      .all(from, to);

    // Who has not logged anything for the most recent weekday in range.
    const notSubmitted = db
      .prepare(
        `SELECT u.employee_code, u.name
           FROM users u
          WHERE u.is_active = 1
            AND NOT EXISTS (
              SELECT 1 FROM entries e WHERE e.user_id = u.id AND e.entry_date BETWEEN ? AND ?
            )
          ORDER BY u.employee_code`
      )
      .all(from, to);

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
  } catch (err) {
    next(err);
  }
});

router.get('/export.xlsx', async (req, res, next) => {
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="DSR-${stamp}.xlsx"`);
    await excel.writeToStream(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.post('/excel/sync', async (_req, res, next) => {
  try {
    await excel.syncNow();
    const status = excel.status();
    if (status.lastError) return res.status(503).json({ error: status.lastError, status });
    res.json({ ok: true, status });
  } catch (err) {
    next(err);
  }
});

router.post('/excel/backup', async (_req, res, next) => {
  try {
    const file = await excel.backup();
    res.json({ ok: true, file });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
