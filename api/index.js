'use strict';

// Vercel entry point. vercel.json rewrites every non-static request here, and
// an Express app is itself a (req, res) handler, so it can be served as-is.
//
// If the app cannot even load — almost always a missing or mistyped setting
// such as SESSION_SECRET or the database URL — Vercel would otherwise show only
// a generic "500 FUNCTION_INVOCATION_FAILED" page. Catch that and show the
// actual reason instead, so it can be fixed from the Vercel dashboard. Only the
// message is shown, never a stack trace or any setting's value.

let app = null;
let startupError = null;

try {
  app = require('../app');
} catch (err) {
  startupError = err;
  console.error('[startup] DSR Tracker could not start:', err);
}

// A stray rejected promise must not take the whole function down; log it so
// it shows in Vercel's Logs tab instead.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

module.exports = (req, res) => {
  if (startupError) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(
      'DSR Tracker could not start.\n\n' +
        `Reason: ${String(startupError.message).split('\n')[0]}\n\n` +
        'Fix: Vercel -> your project -> Settings -> Environment Variables, ' +
        'correct the setting named above, then Deployments -> ... -> Redeploy.\n'
    );
    return;
  }
  return app(req, res);
};
