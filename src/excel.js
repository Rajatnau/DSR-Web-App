'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');
const db = require('./db');
const config = require('./config');

const MONEY_FMT = '#,##0.00';
const HOURS_FMT = '0.00';
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

const SQL_ENTRIES = `
  SELECT e.id, e.entry_date, e.hours, e.rate_snapshot, e.description, e.ticket_ref,
         e.status, e.created_at, e.updated_at,
         u.employee_code, u.name AS employee_name, u.department, u.email,
         p.code AS project_code, p.name AS project_name, p.client, p.is_billable,
         a.name AS activity_name
  FROM entries e
  JOIN users u      ON u.id = e.user_id
  JOIN projects p   ON p.id = e.project_id
  JOIN activities a ON a.id = e.activity_id
  ORDER BY e.entry_date DESC, u.employee_code, e.id
`;

const SQL_PROJECTS = `
  SELECT p.code, p.name, p.client, p.is_billable, p.is_active, p.created_at,
         COALESCE(SUM(e.hours), 0)                    AS total_hours,
         COALESCE(SUM(e.hours * e.rate_snapshot), 0)  AS total_cost,
         COUNT(DISTINCT e.user_id)                    AS people
  FROM projects p
  LEFT JOIN entries e ON e.project_id = p.id
  GROUP BY p.id
  ORDER BY p.code
`;

const SQL_EMPLOYEES = `
  SELECT u.employee_code, u.name, u.email, u.department, u.role, u.hourly_rate,
         u.is_active, u.created_at,
         COALESCE(SUM(e.hours), 0)                   AS total_hours,
         COALESCE(SUM(e.hours * e.rate_snapshot), 0) AS total_cost
  FROM users u
  LEFT JOIN entries e ON e.user_id = u.id
  GROUP BY u.id
  ORDER BY u.employee_code
`;

const SQL_BY_PROJECT = `
  SELECT p.code, p.name, p.client,
         CASE WHEN p.is_billable = 1 THEN 'Billable' ELSE 'Non-billable' END AS billable,
         SUM(e.hours)                    AS hours,
         SUM(e.hours * e.rate_snapshot)  AS cost,
         COUNT(DISTINCT e.user_id)       AS people,
         MIN(e.entry_date)               AS first_entry,
         MAX(e.entry_date)               AS last_entry
  FROM entries e JOIN projects p ON p.id = e.project_id
  GROUP BY p.id ORDER BY cost DESC
`;

const SQL_BY_EMPLOYEE = `
  SELECT u.employee_code, u.name, u.department,
         SUM(e.hours)                   AS hours,
         SUM(e.hours * e.rate_snapshot) AS cost,
         COUNT(DISTINCT e.project_id)   AS projects,
         COUNT(DISTINCT e.entry_date)   AS days_logged
  FROM entries e JOIN users u ON u.id = e.user_id
  GROUP BY u.id ORDER BY cost DESC
`;

const SQL_BY_MONTH = `
  SELECT substr(e.entry_date, 1, 7) AS month,
         p.code AS project_code, p.name AS project_name,
         SUM(e.hours)                   AS hours,
         SUM(e.hours * e.rate_snapshot) AS cost
  FROM entries e JOIN projects p ON p.id = e.project_id
  GROUP BY month, p.id ORDER BY month DESC, cost DESC
`;

const SQL_BY_ACTIVITY = `
  SELECT a.name AS activity,
         SUM(e.hours)                   AS hours,
         SUM(e.hours * e.rate_snapshot) AS cost,
         COUNT(*)                       AS entries
  FROM entries e JOIN activities a ON a.id = e.activity_id
  GROUP BY a.id ORDER BY hours DESC
`;

/* ------------------------------------------------------------------ */
/* Sheet helpers                                                       */
/* ------------------------------------------------------------------ */

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columns;

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  rows.forEach((r) => ws.addRow(r));

  // AutoFilter over the populated block makes the sheet immediately usable as a
  // pivot-table / Power Query source.
  if (rows.length > 0) {
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: rows.length + 1, column: columns.length },
    };
  }
  return ws;
}

async function loadData() {
  const [entries, projects, employees, byProject, byEmployee, byMonth, byActivity] = await Promise.all(
    [SQL_ENTRIES, SQL_PROJECTS, SQL_EMPLOYEES, SQL_BY_PROJECT, SQL_BY_EMPLOYEE, SQL_BY_MONTH, SQL_BY_ACTIVITY].map((sql) => db.all(sql))
  );
  return { entries, projects, employees, byProject, byEmployee, byMonth, byActivity };
}

async function buildWorkbook() {
  const data = await loadData();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'DSR Web App';
  wb.lastModifiedBy = 'DSR Web App';
  wb.created = new Date();
  wb.modified = new Date();

  /* --- Sheet 1: the flat fact table that dashboards pivot against --- */
  addSheet(
    wb,
    'DSR Entries',
    [
      { header: 'Entry ID', key: 'id', width: 10 },
      { header: 'Date', key: 'entry_date', width: 12 },
      { header: 'Year', key: 'year', width: 8 },
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Employee Code', key: 'employee_code', width: 16 },
      { header: 'Employee Name', key: 'employee_name', width: 24 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Project Code', key: 'project_code', width: 16 },
      { header: 'Project Name', key: 'project_name', width: 30 },
      { header: 'Client', key: 'client', width: 20 },
      { header: 'Billable', key: 'billable', width: 14 },
      { header: 'Activity', key: 'activity_name', width: 22 },
      { header: 'Task Description', key: 'description', width: 55 },
      { header: 'Ticket / Ref', key: 'ticket_ref', width: 16 },
      { header: 'Hours', key: 'hours', width: 9, style: { numFmt: HOURS_FMT } },
      { header: `Hourly Rate (${config.currency})`, key: 'rate', width: 18, style: { numFmt: MONEY_FMT } },
      { header: `Cost (${config.currency})`, key: 'cost', width: 16, style: { numFmt: MONEY_FMT } },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Created At (UTC)', key: 'created_at', width: 20 },
      { header: 'Updated At (UTC)', key: 'updated_at', width: 20 },
    ],
    data.entries.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      year: Number(e.entry_date.slice(0, 4)),
      month: e.entry_date.slice(0, 7),
      employee_code: e.employee_code,
      employee_name: e.employee_name,
      department: e.department,
      project_code: e.project_code,
      project_name: e.project_name,
      client: e.client,
      billable: e.is_billable ? 'Billable' : 'Non-billable',
      activity_name: e.activity_name,
      description: e.description,
      ticket_ref: e.ticket_ref,
      hours: e.hours,
      rate: e.rate_snapshot,
      cost: Number((e.hours * e.rate_snapshot).toFixed(2)),
      status: e.status === 'submitted' ? 'Submitted' : 'Draft',
      created_at: e.created_at,
      updated_at: e.updated_at,
    }))
  );

  /* --- Sheet 2: project cost roll-up --- */
  addSheet(
    wb,
    'Cost by Project',
    [
      { header: 'Project Code', key: 'code', width: 16 },
      { header: 'Project Name', key: 'name', width: 32 },
      { header: 'Client', key: 'client', width: 22 },
      { header: 'Billable', key: 'billable', width: 14 },
      { header: 'Total Hours', key: 'hours', width: 14, style: { numFmt: HOURS_FMT } },
      { header: `Total Cost (${config.currency})`, key: 'cost', width: 20, style: { numFmt: MONEY_FMT } },
      { header: 'People', key: 'people', width: 10 },
      { header: 'First Entry', key: 'first_entry', width: 14 },
      { header: 'Last Entry', key: 'last_entry', width: 14 },
    ],
    data.byProject
  );

  /* --- Sheet 3: effort & cost per person --- */
  addSheet(
    wb,
    'Cost by Employee',
    [
      { header: 'Employee Code', key: 'employee_code', width: 16 },
      { header: 'Employee Name', key: 'name', width: 26 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Total Hours', key: 'hours', width: 14, style: { numFmt: HOURS_FMT } },
      { header: `Total Cost (${config.currency})`, key: 'cost', width: 20, style: { numFmt: MONEY_FMT } },
      { header: 'Projects', key: 'projects', width: 12 },
      { header: 'Days Logged', key: 'days_logged', width: 14 },
    ],
    data.byEmployee
  );

  /* --- Sheet 4: month x project, the usual dashboard source --- */
  addSheet(
    wb,
    'Monthly by Project',
    [
      { header: 'Month', key: 'month', width: 12 },
      { header: 'Project Code', key: 'project_code', width: 16 },
      { header: 'Project Name', key: 'project_name', width: 32 },
      { header: 'Hours', key: 'hours', width: 12, style: { numFmt: HOURS_FMT } },
      { header: `Cost (${config.currency})`, key: 'cost', width: 18, style: { numFmt: MONEY_FMT } },
    ],
    data.byMonth
  );

  /* --- Sheet 5: where the time actually goes --- */
  addSheet(
    wb,
    'Effort by Activity',
    [
      { header: 'Activity', key: 'activity', width: 26 },
      { header: 'Hours', key: 'hours', width: 12, style: { numFmt: HOURS_FMT } },
      { header: `Cost (${config.currency})`, key: 'cost', width: 18, style: { numFmt: MONEY_FMT } },
      { header: 'Entries', key: 'entries', width: 12 },
    ],
    data.byActivity
  );

  /* --- Sheets 6 & 7: dimension tables --- */
  addSheet(
    wb,
    'Projects',
    [
      { header: 'Project Code', key: 'code', width: 16 },
      { header: 'Project Name', key: 'name', width: 32 },
      { header: 'Client', key: 'client', width: 22 },
      { header: 'Billable', key: 'is_billable', width: 12 },
      { header: 'Active', key: 'is_active', width: 10 },
      { header: 'Total Hours', key: 'total_hours', width: 14, style: { numFmt: HOURS_FMT } },
      { header: `Total Cost (${config.currency})`, key: 'total_cost', width: 20, style: { numFmt: MONEY_FMT } },
      { header: 'People', key: 'people', width: 10 },
      { header: 'Created At (UTC)', key: 'created_at', width: 20 },
    ],
    data.projects.map((p) => ({
      ...p,
      is_billable: p.is_billable ? 'Yes' : 'No',
      is_active: p.is_active ? 'Yes' : 'No',
    }))
  );

  addSheet(
    wb,
    'Employees',
    [
      { header: 'Employee Code', key: 'employee_code', width: 16 },
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Department', key: 'department', width: 20 },
      { header: 'Role', key: 'role', width: 12 },
      { header: `Hourly Rate (${config.currency})`, key: 'hourly_rate', width: 18, style: { numFmt: MONEY_FMT } },
      { header: 'Active', key: 'is_active', width: 10 },
      { header: 'Total Hours', key: 'total_hours', width: 14, style: { numFmt: HOURS_FMT } },
      { header: `Total Cost (${config.currency})`, key: 'total_cost', width: 20, style: { numFmt: MONEY_FMT } },
      { header: 'Created At (UTC)', key: 'created_at', width: 20 },
    ],
    data.employees.map((u) => ({ ...u, is_active: u.is_active ? 'Yes' : 'No' }))
  );

  return wb;
}


/* ------------------------------------------------------------------ */
/* Writing to disk: serialised, atomic, tolerant of the file being open */
/*                                                                      */
/* Only in "file" mode (a server with a persistent disk). On Vercel     */
/* there is no disk that outlives a request, so the workbook is built   */
/* on demand by writeToStream() instead and these become no-ops.        */
/* ------------------------------------------------------------------ */

let writing = null; // in-flight write promise
let queued = false; // a change arrived while a write was running
let debounceTimer = null;
let lastError = null;
let lastSyncedAt = null;

async function writeWorkbookToDisk() {
  const wb = await buildWorkbook();
  await fsp.mkdir(path.dirname(config.excelFile), { recursive: true });
  const tmp = `${config.excelFile}.${process.pid}.tmp`;

  await wb.xlsx.writeFile(tmp);

  // Atomic swap: readers see either the old workbook or the new one, never a
  // half-written file. rename() replaces the destination on Windows too.
  try {
    await fsp.rename(tmp, config.excelFile);
  } catch (err) {
    // EBUSY/EPERM means someone has the workbook open in Excel. Keep the temp
    // file out of the way and report it — the data is safe in the database.
    await fsp.rm(tmp, { force: true });
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw Object.assign(
        new Error(
          'DSR.xlsx is locked (it is probably open in Excel). Close it — the next change will re-sync.'
        ),
        { code: 'EXCEL_LOCKED' }
      );
    }
    throw err;
  }
}

async function runSync() {
  do {
    queued = false;
    try {
      await writeWorkbookToDisk();
      lastSyncedAt = new Date();
      lastError = null;
    } catch (err) {
      lastError = err.message;
      console.error('[excel] sync failed:', err.message);
    }
  } while (queued);
  writing = null;
}

/** Rebuild the workbook now and resolve when it is on disk. */
function syncNow() {
  if (!config.excelFileSync) return Promise.resolve();
  if (writing) {
    queued = true;
    return writing;
  }
  writing = runSync();
  return writing;
}

/**
 * Ask for a re-sync after the caller's burst of changes settles. Called from
 * write routes so saving ten entries costs one workbook rebuild, not ten.
 */
function scheduleSync(delayMs = 1500) {
  if (!config.excelFileSync) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    syncNow();
  }, delayMs);
  debounceTimer.unref?.();
}

/** Builds the workbook from the live database and streams it to a response. */
async function writeToStream(stream) {
  const wb = await buildWorkbook();
  await wb.xlsx.write(stream);
}

/** Keeps a dated copy so a bad edit is never the only version of the truth. */
async function backup() {
  if (!config.excelFileSync) return null;
  if (!fs.existsSync(config.excelFile)) await syncNow();
  if (!fs.existsSync(config.excelFile)) return null;

  await fsp.mkdir(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const target = path.join(config.backupDir, `DSR-${stamp}.xlsx`);
  await fsp.copyFile(config.excelFile, target);

  // Keep the 30 most recent daily snapshots.
  const files = (await fsp.readdir(config.backupDir))
    .filter((f) => f.startsWith('DSR-') && f.endsWith('.xlsx'))
    .sort()
    .reverse();
  for (const stale of files.slice(30)) {
    await fsp.rm(path.join(config.backupDir, stale), { force: true });
  }
  return target;
}

function status() {
  if (!config.excelFileSync) {
    return {
      mode: 'on-demand',
      feedEnabled: Boolean(config.exportToken),
      lastSyncedAt: null,
      lastError: null,
    };
  }
  return {
    mode: 'file',
    feedEnabled: Boolean(config.exportToken),
    file: config.excelFile,
    lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
    lastError,
    exists: fs.existsSync(config.excelFile),
  };
}

module.exports = { syncNow, scheduleSync, writeToStream, backup, status, buildWorkbook };
