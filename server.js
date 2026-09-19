'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const config = require('./src/config');
const db = require('./src/db');
const excel = require('./src/excel');
const SqliteStore = require('./src/sessionStore');
const { loadUser, requireAuth, requireAdmin } = require('./src/auth');
const { router: authRoutes } = require('./src/routes/auth');
const entryRoutes = require('./src/routes/entries');
const adminRoutes = require('./src/routes/admin');

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

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.use(
  session({
    name: 'dsr.sid',
    store: new SqliteStore(),
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

const publicDir = path.join(__dirname, 'public');
const page = (file) => (_req, res) => res.sendFile(path.join(publicDir, file));

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  res.redirect(req.user.role === 'admin' ? '/admin.html' : '/app.html');
});

// Send already-signed-in people straight through, so the login page never has
// to probe /api/auth/me and log a 401 in the browser console.
app.get('/login.html', (req, res, next) => {
  if (!req.user) return next();
  res.redirect(req.user.role === 'admin' ? '/admin.html' : '/app.html');
});

// Gate the app shells before express.static can serve them anonymously.
app.get('/app.html', requireAuth, page('app.html'));
app.get('/admin.html', requireAdmin, page('admin.html'));

app.use(
  express.static(publicDir, {
    index: false,
    maxAge: config.isProduction ? '1h' : 0,
    etag: true,
  })
);

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), excel: excel.status() });
});

app.use('/api/auth', authRoutes);
app.use('/api', entryRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

app.use((err, req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[error]', err);
  const message = status >= 500 ? 'Something went wrong on the server' : err.message;
  // originalUrl, not path: req.url is rewritten while inside a mounted router.
  if (req.originalUrl.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

/* ------------------------------------------------------------------ */
/* Startup / shutdown                                                  */
/* ------------------------------------------------------------------ */

const server = app.listen(config.port, config.host, async () => {
  console.log(`\n  DSR Web App running on http://localhost:${config.port}`);
  console.log(`  Excel workbook : ${config.excelFile}`);
  console.log(`  Database       : ${config.dbFile}`);
  if (!config.isProduction) {
    console.log('  Mode           : development (set NODE_ENV=production for deployment)\n');
  } else {
    console.log('  Mode           : production\n');
  }
  await excel.syncNow();
});

// Refresh the workbook and roll a dated backup once a day while the app is up.
const dailyTimer = setInterval(() => {
  excel.backup().catch((err) => console.error('[excel] backup failed:', err.message));
}, 24 * 60 * 60 * 1000);
dailyTimer.unref();

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  server.close(async () => {
    try {
      await excel.syncNow();
      db.close();
    } catch (err) {
      console.error('[shutdown]', err.message);
    }
    process.exit(0);
  });
  // Do not hang forever on lingering keep-alive sockets.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
