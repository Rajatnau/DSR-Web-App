'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const v = require('../validate');
const { requireAuth } = require('../auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' },
});

const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const setPassword = db.prepare(
  'UPDATE users SET password_hash = ?, must_reset = 0 WHERE id = ?'
);

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

router.post('/login', loginLimiter, (req, res) => {
  const emailRaw = String(req.body?.email ?? '').trim().toLowerCase();
  const passwordRaw = String(req.body?.password ?? '');

  const user = emailRaw ? findByEmail.get(emailRaw) : null;

  // Compare against a dummy hash when the user is unknown so a wrong email and a
  // wrong password take the same amount of time.
  const hash = user?.password_hash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const ok = bcrypt.compareSync(passwordRaw, hash);

  if (!user || !ok || !user.is_active) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Rotate the session id on login to close off session fixation.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('dsr.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(full) });
});

router.post('/change-password', requireAuth, (req, res, next) => {
  try {
    const current = String(req.body?.currentPassword ?? '');
    const next_ = v.password(req.body?.newPassword, 'New password');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(current, user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (bcrypt.compareSync(next_, user.password_hash)) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    setPassword.run(bcrypt.hashSync(next_, 12), user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, publicUser };
