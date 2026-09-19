'use strict';

/** Writes data/DSR.xlsx from the current database and exits. Handy for cron. */

const excel = require('../src/excel');
const config = require('../src/config');

excel
  .syncNow()
  .then(() => {
    const status = excel.status();
    if (status.lastError) {
      console.error(`[export] ${status.lastError}`);
      process.exit(1);
    }
    console.log(`[export] Wrote ${config.excelFile}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[export]', err.message);
    process.exit(1);
  });
