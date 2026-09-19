'use strict';

/*
 * Long-running server for a laptop, office machine or container. On Vercel
 * this file is not used — api/index.js hands the same app to the platform.
 */

const config = require('./src/config');
const db = require('./src/db');
const excel = require('./src/excel');
const app = require('./app');

let server;

async function start() {
  // Fail fast on a bad database URL or token instead of on the first request.
  await db.ready();

  server = app.listen(config.port, config.host, () => {
    console.log(`\n  DSR Web App running on http://localhost:${config.port}`);
    console.log(`  Database       : ${config.isFileDb ? config.dbUrl.slice('file:'.length) : config.dbUrl}`);
    console.log(
      `  Excel workbook : ${config.excelFileSync ? config.excelFile : 'built on download (EXCEL_FILE_SYNC=false)'}`
    );
    console.log(`  Mode           : ${config.isProduction ? 'production' : 'development (set NODE_ENV=production for deployment)'}\n`);
  });

  await excel.syncNow();

  if (config.excelFileSync) {
    // Refresh the workbook and roll a dated backup once a day while the app is up.
    setInterval(() => {
      excel.backup().catch((err) => console.error('[excel] backup failed:', err.message));
    }, 24 * 60 * 60 * 1000).unref();
  }
}

function shutdown(signal) {
  console.log(`\n[${signal}] shutting down…`);
  if (!server) process.exit(0);
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

start().catch((err) => {
  console.error('[startup] failed:', err.message);
  process.exit(1);
});
