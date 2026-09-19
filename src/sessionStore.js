'use strict';

const session = require('express-session');
const db = require('./db');

/**
 * express-session store backed by the app's own database, so logins survive a
 * restart — and, on Vercel, work across function instances, which share no
 * memory. Expired rows are cleared by db.ready() on each cold start and
 * opportunistically on writes; no timers, since a serverless function may be
 * frozen between requests.
 */
class DbStore extends session.Store {
  expiryOf(sess) {
    const ms = sess?.cookie?.maxAge ?? 12 * 60 * 60 * 1000;
    return Date.now() + ms;
  }

  get(sid, cb) {
    db.get('SELECT data, expires_at FROM sessions WHERE sid = ?', [sid])
      .then(async (row) => {
        if (!row) return cb(null, null);
        if (row.expires_at <= Date.now()) {
          await db.run('DELETE FROM sessions WHERE sid = ?', [sid]);
          return cb(null, null);
        }
        return cb(null, JSON.parse(row.data));
      })
      .catch(cb);
  }

  set(sid, sess, cb) {
    db.run(
      `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(sess), this.expiryOf(sess)]
    )
      .then(() => {
        // Roughly one write in fifty also sweeps expired sessions.
        if (Math.random() < 0.02) {
          db.run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]).catch(() => {});
        }
        cb(null);
      })
      .catch(cb);
  }

  touch(sid, sess, cb) {
    db.run('UPDATE sessions SET expires_at = ? WHERE sid = ?', [this.expiryOf(sess), sid])
      .then(() => cb(null))
      .catch(cb);
  }

  destroy(sid, cb) {
    db.run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb(null))
      .catch(cb);
  }
}

module.exports = DbStore;
