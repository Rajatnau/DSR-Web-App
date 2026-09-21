'use strict';

/*
 * The Express application, with no listen() and no timers, so it runs the same
 * way under the local server (server.js) and as a Vercel serverless function
 * (api/index.js).
 */

const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const config = require('./src/config');
const db = require('./src/db');
const excel = require('./src/excel');
const DbStore = require('./src/sessionStore');
const { loadUser, requireAuth, requireAdmin } = require('./src/auth');
const { router: authRoutes } = require('./src/routes/auth');
const entryRoutes = require('./src/routes/entries');
const adminRoutes = require('./src/routes/admin');
const exportRoutes = require('./src/routes/export');

const app = express();

if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The UI is plain HTML/CSS/JS served from this origin; inline styles are
        // used for a handful of computed bar widths.
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        // Helmet adds upgrade-insecure-requests by default. On a plain-HTTP
        // LAN deployment that rewrites our own stylesheet and scripts to
        // https:// and the page loads unstyled and dead, so only keep it when
        // we are actually being served over TLS. (localhost is exempt from the
        // upgrade, which is why this only bites on a real IP or hostname.)
        ...(config.secureCookies ? {} : { upgradeInsecureRequests: null }),
      },
    },
    // Same reasoning: HSTS and COOP are ignored by browsers without TLS in
    // front, and COOP logs a console warning on every page load if we send it.
    strictTransportSecurity: config.secureCookies ? undefined : false,
    crossOriginOpenerPolicy: config.secureCookies ? undefined : false,
    crossOriginEmbedderPolicy: false,
  })
);

// Health check answers before touching the database, so a platform probe can
// tell "process up" apart from "database reachable".
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    // Which engine, and the variable NAME it came from (never its value).
    database: { engine: db.kind === 'postgres' ? 'postgres' : config.isFileDb ? 'sqlite-file' : 'turso', source: config.dbUrlSource },
    excel: excel.status(),
  });
});

// Make sure tables exist before anything queries them. Runs once per process
// (once per cold start on Vercel) and retries on the next request if it fails.
// If the database cannot be reached, say so plainly instead of a generic 500:
// on a fresh deployment this is nearly always a wrong URL or token, which is
// fixed in the hosting dashboard. Driver messages ("HTTP status 401",
// "password authentication failed") never include the token or password.
app.use((req, res, next) => {
  db.ready().then(
    () => next(),
    (err) => {
      console.error('[db] could not connect or prepare the database:', err);
      const reason = String(err?.message || err).split('\n')[0];
      const hint =
        'Check the database settings (DATABASE_URL, or TURSO_DATABASE_URL and TURSO_AUTH_TOKEN) ' +
        'in your hosting dashboard, then redeploy.';
      res.status(503).set('Cache-Control', 'no-store');
      if (req.originalUrl.startsWith('/api/')) {
        return res.json({ error: `Could not connect to the database: ${reason}. ${hint}` });
      }
      res.type('text/plain').send(`DSR Tracker could not connect to the database.\n\nReason: ${reason}\n\n${hint}\n`);
    }
  );
});

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// The export feed authenticates with its own token, not a session, so it sits
// ahead of the session middleware and never creates a session row.
app.use('/api/export', exportRoutes);

app.use(
  session({
    name: 'dsr.sid',
    store: new DbStore(),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: config.sessionHours * 60 * 60 * 1000,
    },
  })
);

app.use(loadUser);

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

// The HTML shells live in views/, not public/: on Vercel everything in public/
// is served straight from the CDN, which would skip these login checks.
// Paths are written out in full so Vercel's bundler can see and include them.
const LOGIN_PAGE = path.join(__dirname, 'views', 'login.html');
const APP_PAGE = path.join(__dirname, 'views', 'app.html');
const ADMIN_PAGE = path.join(__dirname, 'views', 'admin.html');

const homeFor = (user) => (user.role === 'admin' ? '/admin.html' : '/app.html');

app.get('/', (req, res) => {
  res.redirect(req.user ? homeFor(req.user) : '/login.html');
});

app.get('/login.html', (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  res.sendFile(LOGIN_PAGE);
});

app.get('/app.html', requireAuth, (_req, res) => res.sendFile(APP_PAGE));
app.get('/admin.html', requireAdmin, (_req, res) => res.sendFile(ADMIN_PAGE));

// CSS and JS. On Vercel the CDN answers these before the function is reached;
// locally Express serves them.
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: config.isProduction ? '1h' : 0,
    etag: true,
  })
);

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

app.use('/api/auth', authRoutes);
app.use('/api', entryRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

app.use((err, req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;

  // For server errors, hand back a short reference and the error's code/type
  // (e.g. "42P01", "ECONNREFUSED", "TypeError") — enough to diagnose from the
  // browser, but never the message, SQL, data or any setting value. The full
  // error goes to the log under the same reference.
  let diag = null;
  if (status >= 500) {
    const ref = Math.random().toString(36).slice(2, 8);
    diag = { ref, code: String(err.code || err.name || 'Error').slice(0, 40) };
    console.error(`[error] ref=${ref} ${req.method} ${req.originalUrl}`, err);
  }

  const message = status >= 500 ? 'Something went wrong on the server' : err.message;
  if (res.headersSent) return res.end();
  // originalUrl, not path: req.url is rewritten while inside a mounted router.
  if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message, ...(diag || {}) });
  res.status(status).send(diag ? `${message} (ref ${diag.ref}, ${diag.code})` : message);
});

module.exports = app;
