# DSR Tracker

A small web application for capturing **Daily Status Reports**: who worked on
which project, doing what activity, for how many hours. Everyone signs in with
their own account from any laptop or phone, and every saved entry is mirrored
into an Excel workbook that is ready for pivot tables, dashboards and project
costing.

---

## Why there is a database *and* an Excel file

The brief was "the entered data should be sitting in an Excel file". Writing
directly to `.xlsx` on every request is not safe in practice:

- two people submitting at the same moment can corrupt the workbook,
- on Windows the file locks the moment someone opens it in Excel, and every
  write fails until they close it,
- a crash mid-write leaves a truncated file with no earlier copy.

So the app keeps a **SQLite database as the transactional store** and
**re-generates `data/DSR.xlsx` after every change**. The workbook is always
current, and it is a real, fully-formatted Excel file — it simply isn't the
thing being written to concurrently.

What this buys you:

| Situation | What happens |
|---|---|
| Ten people submit at once | All saved. One workbook rebuild, not ten. |
| Someone has `DSR.xlsx` open in Excel | Entries still save. The dashboard shows a "workbook is locked" notice and re-syncs automatically once it is closed. |
| Server crashes mid-write | The workbook is written to a temp file and renamed atomically, so you always have a complete file. |
| You want a point-in-time copy | **Create dated backup** keeps the last 30 daily snapshots in `data/backups/`. |

You can also pull a fresh copy any time from **Download DSR.xlsx** in the admin
console, which streams a workbook built on the spot and never touches the file
on disk.

**On Vercel** (or any host without a persistent disk) the database is Vercel's
built-in **Postgres** (Storage tab, run by Neon) instead of a local file, and
the workbook is built fresh from live data on every download. A token-protected URL lets
Excel Power Query and Power BI refresh from it. See
[docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md).

---

## What's in the workbook

`data/DSR.xlsx` has seven sheets. Each has a frozen header row and an
auto-filter, so it drops straight into a pivot table or Power Query.

| Sheet | Purpose |
|---|---|
| **DSR Entries** | The flat fact table — one row per logged task, with date, year, month, employee, department, project, client, billable flag, activity, description, hours, hourly rate and cost. This is the sheet you point dashboards at. |
| **Cost by Project** | Hours, cost, headcount and date range per project. |
| **Cost by Employee** | Hours, cost, project count and days logged per person. |
| **Monthly by Project** | Month × project grid — the usual monthly-spend source. |
| **Effort by Activity** | Where the time actually goes (development vs meetings vs support). |
| **Projects** / **Employees** | Dimension tables for lookups and joins. |

### How project cost is calculated

`cost = hours × the employee's hourly rate at the moment the entry was saved`.

The rate is **snapshotted onto each entry**, so giving someone a raise does not
silently rewrite last quarter's project costs. Rates are set per person in
**Admin → People**.

---

## Running it

Requires **Node.js 22 or 24**. The database driver (`@libsql/client`) ships
prebuilt binaries, so there is no compiler or build step.

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

On the very first run the app creates the database and a bootstrap
administrator. Sign in, then **change that password immediately**:

```
admin@company.com / Admin@123
```

Override those before first launch with `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`.

### Demo data

To see the dashboards populated:

```bash
npm run seed
```

This creates six people, five projects and about 450 entries over the last 45
weekdays. Every seeded account uses the password `Password@123`:

| Email | Role |
|---|---|
| `sanjay.iyer@company.com` | Administrator |
| `priya.raman@company.com` | Employee |
| `arun.krishnan@company.com` | Employee |
| `meera.nair@company.com` | Employee |
| `vikram.shetty@company.com` | Employee |
| `divya.balan@company.com` | Employee |

Delete the `data/` folder to start over from scratch.

---

## How people use it

**Employees** get four tabs:

- **Log time** — pick a date, add entries (project, activity, hours in 0.25
  steps, description, optional ticket reference). A meter shows progress toward
  the 8-hour day. **Submit day** locks the entries.
- **My timesheet** — everything logged over a date range, with totals.
- **Overview** — today / this week / this month, hours by project, and a nudge
  listing weekdays with nothing logged.
- **Account** — change password.

**Administrators** additionally get:

- **Dashboard** — total hours and cost, billable split, cost by project, hours
  by activity, effort per person, and who hasn't logged anything. Plus the
  Excel download / re-sync / backup controls.
- **All entries** — filter by date, employee, project and status; reopen a
  submitted day for correction; delete bad entries.
- **Projects** — create projects, mark them billable or internal, close them
  (closed projects stay in reports but can no longer be booked against).
- **People** — add staff, set hourly rates and departments, promote to admin,
  deactivate leavers, reset passwords.
- **Activities** — maintain the task categories people pick from.

Admins can also log their own time via **My DSR**.

### Rules the app enforces

- Hours must be positive, in 0.25 steps, and at most 24.
- A single person cannot exceed 16 hours in one day (`MAX_HOURS_PER_DAY`).
- Time cannot be logged against a future date, or a closed project.
- Submitted entries are read-only until an administrator reopens the day.
- Nobody can see or edit another person's entries.
- The last active administrator cannot be demoted or deactivated.

---

## Deployment

The app runs either as a serverless function on Vercel with a hosted database
(Vercel Postgres, or Turso), or as a single Node process with a local SQLite
file. For the second
option, **the one thing that matters is that `DATA_DIR` points at storage that
survives restarts**. Otherwise every deploy starts from an empty database.

### Vercel

Step-by-step guide: **[docs/DEPLOY-VERCEL.md](docs/DEPLOY-VERCEL.md)**. In
short: import the GitHub repo into Vercel, create a Postgres database under
**Storage** and connect it (this adds `DATABASE_URL`), set `SESSION_SECRET`,
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and `APP_TIMEZONE`, then redeploy.
`vercel.json` already handles routing and the region. Turso works too.

### On your own network (simplest)

Good for a small team where everyone is on the office LAN or VPN.

```powershell
$env:NODE_ENV      = "production"
$env:SESSION_SECRET = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
$env:SECURE_COOKIES = "false"   # no HTTPS on a plain LAN
npm start
```

Colleagues reach it at `http://<your-machine-ip>:3000`. Allow the port once:

```powershell
New-NetFirewallRule -DisplayName "DSR Tracker" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

To keep it running after logout, install it as a Windows service with
[NSSM](https://nssm.cc/) or run it under PM2.

### Docker

```bash
echo "SESSION_SECRET=$(openssl rand -hex 48)" > .env
docker compose up -d
```

The workbook appears on the host at `./dsr-data/DSR.xlsx`.

### Render / Railway / Azure App Service

`render.yaml` is included for a Blueprint deploy. For any platform:

- attach a **persistent disk** and set `DATA_DIR` to its mount path,
- set `SESSION_SECRET`,
- set `TRUST_PROXY=true` and `SECURE_COOKIES=true` (they terminate TLS for you),
- health check path is `/api/health`.

> Container filesystems are ephemeral. Without a mounted volume the database and
> the workbook are wiped on every redeploy.

### Before going live

- [ ] Change the bootstrap admin password.
- [ ] Set a real `SESSION_SECRET` (the app refuses to start in production without one).
- [ ] Serve over HTTPS, then set `SECURE_COOKIES=true` and `TRUST_PROXY=true`.
- [ ] Put `data/` on backed-up storage, or schedule `npm run export` to copy the workbook somewhere safe.

---

## Configuration

Copy `.env.example` to `.env`. Everything has a working default except
`SESSION_SECRET`, which is mandatory in production.

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | |
| `SESSION_SECRET` | — | **Required** when `NODE_ENV=production`. |
| `DATA_DIR` | `./data` | Holds `dsr.db` (local mode), `DSR.xlsx`, `backups/`. |
| `DATABASE_URL` | local file | `postgres://…` for PostgreSQL (Vercel's Storage tab sets this; `POSTGRES_URL` also works), or `libsql://…` for Turso together with `DATABASE_AUTH_TOKEN` (or `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`). **Required on Vercel.** |
| `EXCEL_FILE_SYNC` | `true` locally, `false` on Vercel | Rewrite `DSR.xlsx` on disk after every change. |
| `EXPORT_TOKEN` | — | Enables the live feed `/api/export/dsr.xlsx?token=…` for Power Query / Power BI. At least 24 characters. |
| `APP_TIMEZONE` | machine's zone | IANA zone that defines "today", e.g. `Asia/Kolkata`. Set it on Vercel, whose clock is UTC. |
| `TRUST_PROXY` | `false` (`true` on Vercel) | `true` behind a reverse proxy or PaaS. |
| `SECURE_COOKIES` | on in production | Set `false` for plain-HTTP LAN use. |
| `SESSION_HOURS` | `12` | Sign-in lifetime. |
| `CURRENCY` | `INR` | Currency label and formatting. |
| `STANDARD_HOURS_PER_DAY` | `8` | Drives the day meter. |
| `MAX_HOURS_PER_DAY` | `16` | Hard cap per person per day. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `admin@company.com` / `Admin@123` | Only used when the database is first created. |

---

## Building dashboards from the workbook

Point Excel or Power BI at the **DSR Entries** sheet — it is deliberately a flat
fact table with the date already split into `Year` and `Month` columns.

- **Spend per project** → PivotTable: rows `Project Name`, values `Sum of Cost`.
- **Monthly burn** → rows `Month`, columns `Project Code`, values `Sum of Cost`.
- **Billable utilisation** → rows `Employee Name`, columns `Billable`, values `Sum of Hours`.
- **Where time goes** → rows `Activity`, values `Sum of Hours`.

For a live dashboard, use Power Query (**Data → Get Data → From File**) against
`data/DSR.xlsx` and hit Refresh. The app keeps that file up to date, so the
refresh always picks up the latest entries. On Vercel, use **From Web** with
the export feed URL instead (see the deploy guide).

To write the workbook from a scheduled task without running the server:

```bash
npm run export
```

---

## Project layout

```
app.js                 Express app: security headers, sessions, routes (shared by both runtimes)
server.js              Long-running server: listen, daily backup, graceful shutdown
api/index.js           Vercel entry point — exports app.js
vercel.json            Vercel routing, region, function settings
src/
  config.js            Environment configuration
  db.js                Database layer: PostgreSQL or SQLite (local file / Turso), schema, first-run seeding
  dates.js             "Today" in the team's timezone
  excel.js             Workbook generation, atomic writes, backups
  auth.js              Session loading, requireAuth / requireAdmin
  validate.js          Input validation helpers
  sessionStore.js      Database-backed session store (works across serverless instances)
  routes/
    auth.js            Login, logout, change password
    entries.js         Employee timesheet CRUD, day submission
    admin.js           People, projects, activities, reporting, Excel
    export.js          Token-protected workbook feed for Power Query / Power BI
views/                 HTML pages, served only after the login check
  login.html  app.html  admin.html
public/                Static assets (served by Vercel's CDN when deployed there)
  css/app.css
  js/common.js  login.js  employee.js  admin.js
scripts/
  seed.js              Demo data
  export.js            Write the workbook and exit
docs/DEPLOY-VERCEL.md  Vercel + Postgres deployment guide
data/                  Created at runtime (local mode): database, workbook, backups
```

### Security notes

Passwords are hashed with bcrypt (cost 12). Sessions are HTTP-only cookies with
a rotating id on login, stored server-side in the database so they survive restarts and work across
serverless instances.
Sign-in is rate-limited to 20 attempts per 15 minutes per IP, and a wrong email
takes the same time as a wrong password. All SQL goes through prepared
statements, all HTML is escaped on output, and `helmet` sets a content security
policy that blocks inline and third-party scripts. Deactivating an account
invalidates its session on the next request.
