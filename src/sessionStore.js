'use strict';

const session = require('express-session');
const db = require('./db');

/**
 * Minimal express-session store backed by the app's SQLite database, so logins
 * survive a restart without pulling in another dependency.
 */
class SqliteStore extends session.Store {
  constructor() {
    super();
    this.stmts = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    };

    // Clear expired rows hourly; unref so the timer never holds the process open.
    this.timer = setInterval(() => this.prune(), 60 * 60 * 1000);
    this.timer.unref();
    this.prune();
  }

  prune() {
    try {
      this.stmts.prune.run(Date.now());
    } catch (err) {
      console.error('[session] prune failed:', err.message);
    }
  }

  expiryOf(sess) {
    const ms = sess?.cookie?.maxAge ?? 12 * 60 * 60 * 1000;
    return Date.now() + ms;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.stmts.destroy.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.expiryOf(sess));
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.expiryOf(sess), sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmts.destroy.run(sid);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}

module.exports = SqliteStore;
