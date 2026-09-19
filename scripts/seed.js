'use strict';

/**
 * Loads a realistic demo dataset so the dashboards have something to show.
 * Safe to run more than once: it skips records that already exist.
 *
 *   npm run seed
 */

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const excel = require('../src/excel');
const config = require('../src/config');

const PEOPLE = [
  ['EMP001', 'Priya Raman',      'priya.raman@company.com',      'Engineering', 1200, 'employee'],
  ['EMP002', 'Arun Krishnan',    'arun.krishnan@company.com',    'Engineering', 1450, 'employee'],
  ['EMP003', 'Meera Nair',       'meera.nair@company.com',       'QA',           950, 'employee'],
  ['EMP004', 'Vikram Shetty',    'vikram.shetty@company.com',    'Engineering', 1600, 'employee'],
  ['EMP005', 'Divya Balan',      'divya.balan@company.com',      'Design',      1100, 'employee'],
  ['MGR001', 'Sanjay Iyer',      'sanjay.iyer@company.com',      'Delivery',    2100, 'admin'],
];

const PROJECTS = [
  ['ACME-ERP',   'Acme ERP Implementation',    'Acme Manufacturing', 1],
  ['NORTH-PORTAL', 'Northwind Customer Portal', 'Northwind Retail',  1],
  ['ZENITH-MIG', 'Zenith Cloud Migration',      'Zenith Bank',       1],
  ['INTERNAL',   'Internal / Non-billable',     'Internal',          0],
  ['PRESALES',   'Pre-sales & Proposals',       'Internal',          0],
];

const TASKS = {
  Development: [
    'Implemented the purchase-order approval workflow',
    'Built the invoice export endpoint and wired it to the UI',
    'Added pagination and server-side filtering to the orders grid',
    'Refactored the pricing engine to remove duplicated rules',
  ],
  'Code Review': ['Reviewed the payments module pull request', 'Reviewed and merged three feature branches'],
  'Testing / QA': [
    'Wrote regression tests for the checkout flow',
    'Executed the UAT test pack and logged four defects',
  ],
  'Bug Fix': ['Fixed the rounding error on multi-currency invoices', 'Resolved the session timeout on the reports page'],
  Meeting: ['Daily stand-up and sprint planning', 'Client status call and follow-up notes'],
  Documentation: ['Updated the deployment runbook', 'Drafted the API integration guide for the client'],
  'Production Support': ['Investigated the overnight batch failure', 'Handled two P2 tickets from the service desk'],
  'Design / Architecture': ['Drafted the integration architecture for the billing service'],
  'Requirement Analysis': ['Walked through the new reporting requirements with the business analyst'],
  'Deployment / Release': ['Released build 2.4.1 to staging and ran smoke tests'],
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

async function seed() {
  await db.ready();

  // --- People -------------------------------------------------------
  const hash = bcrypt.hashSync('Password@123', 10);
  await db.batch(
    PEOPLE.map(([code, name, email, dept, rate, role]) => ({
      sql: `INSERT INTO users (employee_code, name, email, password_hash, role, department, hourly_rate, must_reset)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT DO NOTHING`,
      args: [code, name, email, hash, role, dept, rate],
    }))
  );

  // --- Projects -----------------------------------------------------
  await db.batch(
    PROJECTS.map(([code, name, client, billable]) => ({
      sql: 'INSERT INTO projects (code, name, client, is_billable) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      args: [code, name, client, billable],
    }))
  );

  // --- Entries ------------------------------------------------------
  const { n } = await db.get('SELECT COUNT(*) AS n FROM entries');
  if (n > 0) {
    console.log(`[seed] ${n} entries already present — skipping entry generation.`);
    return;
  }

  const users = await db.all(
    "SELECT id, hourly_rate FROM users WHERE employee_code LIKE 'EMP%' OR employee_code = 'MGR001'"
  );
  const projects = await db.all("SELECT id, code FROM projects WHERE code != 'INTERNAL'");
  const internal = await db.get("SELECT id FROM projects WHERE code = 'INTERNAL'");
  const activities = await db.all('SELECT id, name FROM activities');
  const activityByName = new Map(activities.map((a) => [a.name, a.id]));

  const statements = [];
  // 45 days back, weekdays only.
  for (let day = 45; day >= 0; day -= 1) {
    const date = isoDaysAgo(day);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;

    for (const user of users) {
      if (Math.random() < 0.08) continue; // the odd day off

      let remaining = 8;
      const slots = 2 + Math.floor(Math.random() * 2); // 2-3 entries per day

      for (let i = 0; i < slots && remaining >= 0.5; i += 1) {
        const last = i === slots - 1;
        const raw = last ? remaining : Math.min(remaining - 0.5, 1 + Math.random() * 3.5);
        const hours = Math.max(0.5, Math.round(raw * 4) / 4);
        remaining = Math.round((remaining - hours) * 4) / 4;

        const activityName = pick(Object.keys(TASKS));
        const activityId = activityByName.get(activityName);
        if (!activityId) continue;

        const useInternal = ['Meeting', 'Documentation'].includes(activityName) && Math.random() < 0.4;
        const project = useInternal ? internal : pick(projects);

        statements.push({
          sql: `INSERT INTO entries (user_id, project_id, activity_id, entry_date, hours, rate_snapshot,
                                     description, ticket_ref, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            user.id,
            project.id,
            activityId,
            date,
            hours,
            user.hourly_rate,
            pick(TASKS[activityName]),
            Math.random() < 0.4 ? `JIRA-${1000 + Math.floor(Math.random() * 900)}` : '',
            // Leave the last two days as drafts so the "submit" flow is visible.
            day <= 1 ? 'draft' : 'submitted',
          ],
        });
      }
    }
  }

  // One batch = one round trip, which matters when seeding a hosted database.
  await db.batch(statements);
  console.log(`[seed] Created ${statements.length} demo entries across ${users.length} people.`);
}

seed()
  .then(() => excel.syncNow())
  .then(() => {
    console.log(
      config.excelFileSync
        ? `[seed] Excel workbook written to ${config.excelFile}.`
        : '[seed] Excel file sync is off; download the workbook from the admin console.'
    );
    console.log('[seed] Demo password for every seeded user: Password@123');
    db.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  });
