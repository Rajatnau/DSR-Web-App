# Deploying DSR Tracker to Vercel

This guide takes the app from GitHub to a live HTTPS site on Vercel, using
**Vercel's built-in Postgres database**. The database is created from the
Storage tab of your Vercel project and run by Neon, and Vercel connects it for
you, so there are no connection strings to copy by hand.

Allow about 15–20 minutes the first time.

---

## How it fits together

Vercel runs the app as a *serverless function*. It starts on demand and has no
disk that survives between requests, so the data lives in the Postgres
database instead.

| | On your laptop | On Vercel |
|---|---|---|
| Database | SQLite file in `data/` | Vercel Postgres |
| `DSR.xlsx` | Rewritten on disk after every save | Built fresh from live data on every download |
| Dashboards / Power BI | Point at the file on disk | Point at the token-protected live URL (Step 6) |

Everything else works the same way: logins, time entry, submit/lock, admin
screens and costing.

The app picks the database automatically. If `DATABASE_URL` (or
`POSTGRES_URL`) starts with `postgres://`, it uses Postgres. If nothing is set
on your laptop, it uses the local file. On first connection it creates its own
tables; you never run any SQL.

---

## What you need

- The GitHub repo `Rajatnau/DSR-Web-App`, which is already up to date.
- A **Vercel** account at <https://vercel.com>. Sign up with GitHub so it can
  see the repo.
- Node.js on your laptop, only for generating secrets and the optional steps.

> **Plan note:** Vercel's free Hobby plan is for personal, non-commercial use.
> An internal tool for a company should normally be on **Pro**. The Postgres
> database has a free tier that is plenty for a DSR app.

---

## Step 1: Import the project into Vercel

1. Go to <https://vercel.com/new>, or click **Add New… → Project** on the
   dashboard.
2. Under **Import Git Repository**, find **`Rajatnau/DSR-Web-App`** and click
   **Import**. If it isn't listed, click **Adjust GitHub App Permissions** and
   give Vercel access to the repo.
3. On **Configure Project**, leave everything as it is: Framework Preset,
   Root Directory `./`, and Build and Output Settings. The repo's `vercel.json`
   handles them.
4. Click **Deploy**.

**This first deployment is expected to show errors when you open the site,**
because there is no database yet. The logs will say *"No database
configured"*. That's fine: you'll add the database next and redeploy.

(If you already imported the project earlier, skip to Step 2.)

---

## Step 2: Create the Postgres database and connect it

1. Open your project in Vercel and click the **Storage** tab.
2. Click **Create Database**.
3. Choose **Neon** (listed as *Serverless Postgres*) and click **Continue**.
   If you're asked to accept Neon's terms or install the integration, accept.
4. Fill in:
   - **Region:** **Asia Pacific (Mumbai) – `aws-ap-south-1`**. The app's
     functions run in Vercel's Mumbai region (`bom1`), and keeping the
     database next to them keeps every page fast. If your team is elsewhere,
     see [Changing region](#changing-region).
   - **Plan:** **Free** is enough to start.
   - **Database name:** `dsr-tracker`
5. Click **Create**.
6. A **Connect Project** screen appears (if not, open the database and click
   **Connect Project**):
   - **Project:** `DSR-Web-App`
   - **Environments:** tick **Production**. Tick **Preview** and
     **Development** too if you want test deployments to work. They will then
     share this same database.
   - **Custom environment variable prefix:** **leave it empty**, so the
     variable is called exactly `DATABASE_URL`. The app also accepts
     `POSTGRES_URL`, but any other prefix won't be found.
   - Click **Connect**.

Vercel has now added `DATABASE_URL` and some related variables to your
project. You can see them under **Settings → Environment Variables**.

---

## Step 3: Add the app's own settings

1. Generate a session secret. Run this in PowerShell and copy the output:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   Run it a second time if you want the Excel live feed (Step 6); that output
   is your `EXPORT_TOKEN`.

2. In Vercel: **Settings → Environment Variables**. Add each row, ticking the
   same environments as in Step 2:

   | Key | Value | Why |
   |---|---|---|
   | `SESSION_SECRET` | the secret from step 1 | Required; the app refuses to start without it |
   | `SEED_ADMIN_EMAIL` | your email, e.g. `rajat@yourcompany.com` | Your first administrator login |
   | `SEED_ADMIN_PASSWORD` | a strong password | Password for that login |
   | `APP_TIMEZONE` | `Asia/Kolkata` | Defines "today". Vercel's clock is UTC |
   | `CURRENCY` | `INR` | Optional; shown on costs and in the workbook |
   | `EXPORT_TOKEN` | the second secret | Optional; enables the Excel / Power BI live feed |

   Paste values exactly, with **no quotes and no spaces**. Don't add
   `NODE_ENV`, `TRUST_PROXY`, `SECURE_COOKIES`, `PORT` or `DATA_DIR`; Vercel
   and the app handle those.

---

## Step 4: Redeploy

Variables only take effect on a new deployment.

1. Click the **Deployments** tab.
2. On the top (latest) deployment, click **⋯** then **Redeploy**, and confirm.
3. Wait until the status shows **Ready**, about a minute.

---

## Step 5: Sign in and set up

1. Click **Visit** (or open `https://<your-project>.vercel.app`).
2. Sign in with **`SEED_ADMIN_EMAIL`** and **`SEED_ADMIN_PASSWORD`** from
   Step 3. Type the full email address.
   - If you get in, the database is connected. That account exists only
     because the app reached Postgres, created its tables and saved you as
     the first admin.
3. Change your password right away: **My DSR** (top right) → **Account** →
   **Change password**.
4. Set up your organisation in the admin console:
   - **Projects:** add your real projects; mark each billable or internal.
   - **People:** add each employee with their work email, a temporary
     password, department and **hourly rate**. The rate drives all the
     project-cost figures.
   - **Activities:** adjust the task categories if needed.
5. Send each person the site URL and their temporary password. They'll be
   asked to change it on first sign-in.

`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` are only used the very first time,
while the database is empty. Changing them later does nothing, which is
intended. You can delete `SEED_ADMIN_PASSWORD` from Vercel once you've signed
in.

### Checking the data in Vercel

**Storage → `dsr-tracker` → Open in Neon Console → SQL Editor** lets you look
at the tables directly, for example:

```sql
SELECT email, role, is_active FROM users;
SELECT COUNT(*) FROM entries;
```

---

## Step 6: Excel and dashboards

### One-off download

**Admin → Dashboard → Download DSR.xlsx** builds the workbook from the live
database at that moment.

### Live refresh in Excel or Power BI

If you set `EXPORT_TOKEN`, this URL always returns the current workbook:

```
https://<your-project>.vercel.app/api/export/dsr.xlsx?token=<EXPORT_TOKEN>
```

**Excel:** **Data → Get Data → From Other Sources → From Web** → paste the URL
→ **Anonymous** → in the Navigator tick **DSR Entries** (plus any cost sheets)
→ **Load**. **Data → Refresh All** then pulls the latest entries.

**Power BI Desktop:** **Get Data → Web** → same URL → **Anonymous** → pick the
sheets → **Load**.

Treat that URL like a password: anyone who has it can download all DSR data.
To revoke access, change `EXPORT_TOKEN` in Vercel and redeploy. The old link
stops working immediately.

---

## Optional: use the live database from your laptop

This is useful for writing a real `DSR.xlsx` to a shared folder, or running
the app locally against live data.

1. In Vercel: **Storage → `dsr-tracker` → Quickstart / .env.local** tab →
   **Show secret** → copy the `DATABASE_URL` line.
2. Add that line to `C:\Users\Aveva\DSR-Web-App\.env`. That file is never
   uploaded to GitHub or Vercel.
3. In PowerShell:

   ```powershell
   cd C:\Users\Aveva\DSR-Web-App
   npm run export      # writes data\DSR.xlsx from the live database
   npm start           # the app on http://localhost:3000 using LIVE data
   ```

4. Remove the line (or put `#` in front) to go back to the local file.

**Demo data:** `npm run seed` while connected adds six demo people (password
`Password@123`, which is public) and about 450 entries. Only do this on a
separate trial database, **never** the one your staff use.

---

## Updating the app later

Push to `main` and Vercel redeploys automatically. Pushes to other branches get
their own **preview URL**. If you ticked **Preview** in Step 2, those previews
share the production database, so be careful testing risky changes there.

---

## Changing region

`vercel.json` pins the functions to Mumbai:

```json
"regions": ["bom1"]
```

Each page makes several database queries, so the function and the database
should be in the same region. If your team is elsewhere, create the database
in the matching region and change `bom1` (for example `sin1` Singapore,
`fra1` Frankfurt, `iad1` Washington DC), then push.

---

## Troubleshooting

Open **your project → Logs** (or **Deployments → latest → Runtime Logs**), then
reload the failing page to see the exact error.

| Error in the logs | Cause | Fix |
|---|---|---|
| `No database configured` | The database isn't connected, or you haven't redeployed since connecting it | Check **Settings → Environment Variables** has `DATABASE_URL` for Production, then **Redeploy** |
| `No database configured` even though you connected it | You used a custom prefix, so the variable has a different name | Add a variable named `DATABASE_URL` with the same value, then redeploy |
| `SESSION_SECRET must be set` | Missing variable | Add it (Step 3), then redeploy |
| `password authentication failed` | The database password was rotated after deploying | Redeploy so the function gets the new `DATABASE_URL` |
| `timeout` / `ECONNREFUSED` connecting to Postgres | Database paused or deleted, or the URL was edited by hand | Open the database in the Storage tab to wake it; check the URL wasn't changed |
| `APP_TIMEZONE "…" is not a valid IANA timezone` | Typo | Use a name like `Asia/Kolkata` |
| A warning mentioning `sslmode` | Informational message from the Postgres driver | Harmless; the connection is encrypted |

**Can't sign in, no errors in the logs.** The seed admin is only created on the
very first start. Check who exists with `SELECT email FROM users;` in the Neon
SQL Editor (Step 5).

**Signed in, then sent straight back to the login page.** Use the `https://`
address. Session cookies are Secure on Vercel.

**First request after a quiet period is slow.** That's a cold start: Vercel
wakes the function and the free-tier database may also wake from sleep. It
takes a few seconds once, then it's fast.

**Entries made early in the morning rejected as "future date".**
`APP_TIMEZONE` is missing, so the server is using UTC. Add it and redeploy.

---

## Alternative: Turso instead of Postgres

The app also supports Turso (hosted SQLite). Set `TURSO_DATABASE_URL`
(`libsql://…`) and `TURSO_AUTH_TOKEN` instead of `DATABASE_URL`, either
by hand or via **Storage → Create Database → Turso**. Everything else in this
guide is the same.
