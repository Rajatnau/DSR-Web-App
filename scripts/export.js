'use strict';

/**
 * Writes DSR.xlsx from the current database and exits. Handy for a scheduled
 * task, and works against a hosted Turso database too — point DATABASE_URL /
 * TURSO_DATABASE_URL at it to pull the production workbook to this machine.
 */

const db = require('../src/db');
const excel = require('../src/excel');
const config = require('../src/config');

async function main() {
  if (!config.excelFileSync) {
    throw new Error('EXCEL_FILE_SYNC is false, so there is no file to write. Unset it for this command.');
  }
  await db.ready();
  await excel.syncNow();
  const status = excel.status();
  if (status.lastError) throw new Error(status.lastError);
  console.log(`[export] Wrote ${config.excelFile}`);
}

main()
  .then(() => {
    db.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error('[export]', err.message);
    process.exit(1);
  });
