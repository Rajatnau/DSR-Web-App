'use strict';

const db = require('./db');

/**
 * Loads the logged-in user onto req.user for every request. The user record is
 * re-read each time so deactivating an account takes effect immediately rather
 * than at the end of their session.
 */
async function loadUser(req, _res, next) {
  req.user = null;
  try {
    if (req.session?.userId) {
      const user = await db.get(
        'SELECT id, employee_code, name, email, role, department, hourly_rate, is_active, must_reset FROM users WHERE id = ?',
        [req.session.userId]
      );
      if (user && user.is_active) {
        req.user = user;
      } else {
        req.session.destroy(() => {});
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

function wantsJson(req) {
  // Inside a mounted router req.path is relative to the mount point, so an
  // API call would look like "/lookups". originalUrl always has the full path.
  return req.originalUrl.startsWith('/api/') || req.accepts(['html', 'json']) === 'json';
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (wantsJson(req)) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login.html');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    if (wantsJson(req)) return res.status(401).json({ error: 'Not signed in' });
    return res.redirect('/login.html');
  }
  if (req.user.role !== 'admin') {
    if (wantsJson(req)) return res.status(403).json({ error: 'Administrator access required' });
    return res.status(403).send('Administrator access required');
  }
  next();
}

module.exports = { loadUser, requireAuth, requireAdmin };
