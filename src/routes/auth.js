'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const v = require('../validate');
const { requireAuth } = require('../auth');

const router = express.Router();

// Per-instance memory: on Vercel each warm function keeps its own count, so
// this slows guessing rather than capping it exactly. Good enough for an
// internal tool; put Vercel's firewall rate limiting in front for more.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' },
});

// A real bcrypt hash of a random string, so the timing-equaliser below does the
// same amount of work as a genuine comparison.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

function publicUser(u) {
  return {
    id: u.id,
    employeeCode: u.employee_code,
    name: u.name,
    email: u.email,
    role: u.role,
    department: u.department,
    hourlyRate: u.hourly_rate,
    mustReset: !!u.must_reset,
  };
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const emailRaw = String(req.body?.email ?? '').trim().toLowerCase();
    const passwordRaw = String(req.body?.password ?? '');

    const user = emailRaw ? await db.get('SELECT * FROM users WHERE email = ?', [emailRaw]) : null;

    // Compare against a dummy hash when the user is unknown so a wrong email and
    // a wrong password take the same amount of time.
    const ok = await bcrypt.compare(passwordRaw, user?.password_hash ?? DUMMY_HASH);

    if (!user || !ok || !user.is_active) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Rotate the session id on login to close off session fixation.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      res.json({ user: publicUser(user) });
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('dsr.sid');
    res.json({ ok: true });
  });
});

router.get('/me', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    const full = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json({ user: publicUser(full) });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const current = String(req.body?.currentPassword ?? '');
    const nextPassword = v.password(req.body?.newPassword, 'New password');

    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(current, user.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (await bcrypt.compare(nextPassword, user.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    await db.run('UPDATE users SET password_hash = ?, must_reset = 0 WHERE id = ?', [
      await bcrypt.hash(nextPassword, 12),
      user.id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicUser };
