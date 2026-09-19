# Deploying DSR Tracker to Vercel

This guide takes the app from the GitHub repo to a live HTTPS URL on Vercel.
Allow about 20–30 minutes the first time.

## How the Vercel deployment differs

Vercel runs the app as a *serverless function*. The function starts on demand,
can be paused between requests, and has **no disk that survives between
requests**. The app therefore behaves slightly differently there:

| | Local / Docker | Vercel |
|---|---|---|
| Database | SQLite file in `data/` | **Turso** (hosted SQLite), required |
| `DSR.xlsx` | Rewritten on disk after every save | Built fresh from live data on every download |
| Dashboards / Power BI | Point at the file on disk | Point at the token-protected live URL (Step 6) |
| Re-sync / backup buttons | Available | Hidden, since there is no file to sync (Turso keeps its own backups) |

Everything else works the same way: logins, time entry, submit/lock, admin
screens and costing.

---

## What you need

- The GitHub repo `Rajatnau/DSR-Web-App`, which you already have.
- A **Vercel** account at <https://vercel.com>. Sign up with GitHub so it can
  see your repo.
- A **Turso** account at <https://turso.tech>. The free tier is enough to start.
- Node.js on your laptop. You only need it for the optional demo-data step and
  for generating secrets.

> **Plan note:** Vercel's free Hobby plan is for personal, non-commercial use.
> An internal tool for a company should normally be on the **Pro** plan. Check
> Vercel's current terms before rolling it out to staff.

---

## Step 1: Put the code on `main`

Vercel treats the `main` branch as production. The Vercel work is on
`feat/dsr-tracker`, so merge it first:

1. Open <https://github.com/Rajatnau/DSR-Web-App/pulls>, click **New pull
   request**, set base `main` ← compare `feat/dsr-tracker`, then **Create** →
   **Merge**.

   Or from the project folder:

   ```powershell
   git checkout main
   git merge feat/dsr-tracker
   git push origin main
   ```

---

## Step 2: Create the Turso database

The app creates its own tables on first start. You only need an empty database
and credentials to reach it.

### Option A: Turso web dashboard (easiest on Windows)

1. Sign in at <https://app.turso.tech>.
2. **Create Database**. Name it `dsr-tracker`.
3. **Location:** choose **Mumbai (`aws-ap-south-1`)**. The app's
   `vercel.json` runs the functions in Vercel's Mumbai region (`bom1`), and
   keeping the database in the same region keeps every page fast. If your
   team is elsewhere, see [Changing region](#changing-region).
4. Open the database and copy its **URL**. It looks like
   `libsql://dsr-tracker-<your-org>.turso.io`.
5. **Create Token** with **read & write** access and copy it. It is shown
   only once.

### Option B: Turso CLI (macOS, Linux, or Windows via WSL)

```bash
turso auth signup                                    # or: turso auth login
turso db create dsr-tracker --location aws-ap-south-1
turso db show dsr-tracker --url                      # -> TURSO_DATABASE_URL
turso db tokens create dsr-tracker                   # -> TURSO_AUTH_TOKEN
```

Keep the URL and token handy for Step 4.

---

## Step 3: Generate the secrets

Run this in PowerShell **twice**: once for `SESSION_SECRET` and once for
`EXPORT_TOKEN`.

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Also choose the first administrator's email and a strong password. That
account is created automatically the first time the app starts.

---

## Step 4: Import the project into Vercel

1. In Vercel, click **Add New… → Project**.
2. Under **Import Git Repository**, find `Rajatnau/DSR-Web-App` and click
   **Import**. If it isn't listed, click **Adjust GitHub App Permissions** and
   grant access to the repo.
3. On the **Configure Project** screen:
   - **Framework Preset:** leave it as detected. `vercel.json` sets it to
     *Other*.
   - **Root Directory:** `./`
   - **Build and Output Settings:** leave them alone. `vercel.json` handles
     them.
4. Expand **Environment Variables** and add every row below **before** you
   click Deploy:

   | Name | Value | Notes |
   |---|---|---|
   | `TURSO_DATABASE_URL` | `libsql://dsr-tracker-….turso.io` | From Step 2 |
   | `TURSO_AUTH_TOKEN` | *(token from Step 2)* | |
   | `SESSION_SECRET` | *(first secret from Step 3)* | Required; the app refuses to start without it |
   | `SEED_ADMIN_EMAIL` | e.g. `rajat@yourcompany.com` | Your first admin login |
   | `SEED_ADMIN_PASSWORD` | *(a strong password)* | Only used on the very first start |
   | `APP_TIMEZONE` | `Asia/Kolkata` | Defines "today". Vercel's clock is UTC |
   | `CURRENCY` | `INR` | Optional; shown on costs and in the workbook |
   | `EXPORT_TOKEN` | *(second secret from Step 3)* | Optional; enables the Power BI / Excel live feed |

   You do **not** need `NODE_ENV`, `TRUST_PROXY`, `SECURE_COOKIES`,
   `DATA_DIR` or `PORT`. Vercel and the app set these correctly on their own.

5. Click **Deploy**. The build takes a minute or two.

> **Alternative for the database:** instead of creating the database yourself
> in Step 2, you can open the project in Vercel and go to **Storage → Create
> Database → Turso**. The integration adds `TURSO_DATABASE_URL` and
> `TURSO_AUTH_TOKEN` automatically. Then add the remaining variables and
> redeploy (**Deployments → ⋯ → Redeploy**).

---

## Step 5: First sign-in and setup

1. Open the URL Vercel gives you, e.g. `https://dsr-web-app.vercel.app`.
   Visiting `/api/health` should return `{"status":"ok", …}`.
2. Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
3. Change the password straight away: **My DSR → Account → Change password**.
4. In the admin console:
   - **Projects:** add your real projects and mark each as billable or
     internal.
   - **People:** add each employee with their work email, a temporary
     password, department and **hourly rate**. The rate drives all project
     cost figures.
   - **Activities:** adjust the task categories if the defaults don't fit.
5. Send each person the URL and their temporary password. They'll be asked to
   change it.

`SEED_ADMIN_PASSWORD` is only read when the database is empty. Changing it in
Vercel later has no effect, which is intended. To stop the password sitting in
your settings, you can delete that variable once you've signed in.

---

## Step 6: Excel and dashboards

### One-off download

**Admin → Dashboard → Download DSR.xlsx** builds the workbook from the live
database at that moment.

### Live refresh in Excel or Power BI

If you set `EXPORT_TOKEN`, this URL always returns the current workbook:

```
https://<your-app>.vercel.app/api/export/dsr.xlsx?token=<EXPORT_TOKEN>
```

**Excel:** **Data → Get Data → From Other Sources → From Web** → paste the URL
→ **Anonymous** → in the Navigator pick **DSR Entries** (and any of the cost
sheets) → **Load**. After that, **Data → Refresh All** pulls the latest
entries. Build your pivot tables and charts on the loaded tables.

**Power BI Desktop:** **Get Data → Web** → same URL → Anonymous → pick the
sheets → **Load**. For scheduled refresh in the Power BI Service, the same
anonymous web source works.

Treat that URL like a password: anyone who has it can download all DSR data.
To revoke access, change `EXPORT_TOKEN` in Vercel and redeploy. Old links stop
working immediately.

### Keeping an actual `.xlsx` file somewhere (optional)

To have a real file land on a shared drive or OneDrive folder every night, run
the export script on any always-on Windows machine against the same Turso
database:

```powershell
$env:DATABASE_URL        = "libsql://dsr-tracker-….turso.io"
$env:DATABASE_AUTH_TOKEN = "<turso token>"
$env:DATA_DIR            = "C:\Shared\DSR"
npm run export           # writes C:\Shared\DSR\DSR.xlsx
```

Schedule it with Windows Task Scheduler.

---

## Optional: demo data

To try the dashboards with realistic sample data before real use, run this
once from your laptop against the Turso database:

```powershell
cd C:\Users\Aveva\DSR-Web-App
$env:DATABASE_URL        = "libsql://dsr-tracker-….turso.io"
$env:DATABASE_AUTH_TOKEN = "<turso token>"
npm run seed
```

This adds six demo people, all with password `Password@123`, five projects and
about 450 entries. **Do not do this on the database your staff will use.**
Those accounts have a published password. Use a separate Turso database for a
trial, or delete the demo people and projects afterwards.

---

## Updating the app later

Push to `main` and Vercel redeploys automatically. Pushes to any other branch
get a **preview URL** of their own, which is handy for checking a change
before merging.

Preview deployments use the same environment variables and therefore **the
same database** unless you give the Preview environment its own
`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` in **Settings → Environment
Variables**. Do that before testing risky changes.

---

## Changing region

`vercel.json` pins the functions to Mumbai:

```json
"regions": ["bom1"]
```

Each page load makes several database queries, so the function and the
database should be in the same region. If your team and database are
elsewhere, change `bom1` to the matching Vercel region (for example `sin1`
Singapore, `fra1` Frankfurt, `iad1` Washington DC) and create the Turso
database in the nearest Turso location.

---

## Troubleshooting

**Every page shows a 500 error / "Something went wrong".**
Open **Vercel → your project → Logs**. The usual causes:
- `No database configured` → `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are
  missing, or were added after the last deploy. Add them, then **Redeploy**.
- `SESSION_SECRET must be set` → add it, then redeploy.
- `APP_TIMEZONE "…" is not a valid IANA timezone` → use a name like
  `Asia/Kolkata`.
- An authentication error from Turso → the token is wrong or expired. Create
  a new one.

**Environment variable changes don't seem to apply.**
They only take effect on the next deployment: **Deployments → latest → ⋯ →
Redeploy**.

**I sign in but get sent straight back to the login page.**
Use the `https://` URL. Session cookies are Secure on Vercel and browsers
won't send them over plain `http://`.

**The first request after a quiet period is slow.**
That is a serverless cold start: the function spins up and checks the
database schema. It takes a second or two, and subsequent requests are fast.

**"Too many sign-in attempts".**
The login limit is 20 tries per 15 minutes per IP. On Vercel each function
instance counts separately, so it slows down password guessing but isn't an
exact cap. For stronger protection, add a rate-limit rule for `/api/auth/login`
in **Vercel → Firewall**.

**Someone logged today's work and it was rejected as a future date.**
`APP_TIMEZONE` is missing or wrong, so the server is using UTC. Set it and
redeploy.

---

## Bringing over data from the local version

If you've been using the app locally and want to keep that data, load the
local database into Turso **before** the first Vercel deploy, while the Turso
database is still empty:

```bash
# needs the sqlite3 command-line tool and the Turso CLI (WSL on Windows)
sqlite3 data/dsr.db .dump | turso db shell dsr-tracker
```

In that case, skip `SEED_ADMIN_*`. Your existing admin accounts come across
with the data.
