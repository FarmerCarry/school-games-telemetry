# Play statistics server and insights dashboard

This folder is a small service that receives play statistics **without names** from the
games portal (the portal's telemetry sink, `js/telemetry.js`; see
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), "Telemetry sink", "Milestone 2" and
"Milestone 2.5"), keeps them row by row, **anonymously**, and shows them on the insights
dashboard at its own address. The site has no student accounts, player profiles or age
groups: the server keeps play sessions, game visits and rounds under a random code per
session and per PC, and nothing that tells children apart.

It runs in one of two places, with the same code:

* **Cloudflare (recommended):** a free Cloudflare Worker with a free D1 database. One
  button sets it up; nothing to install, nothing to keep running.
* **Your own computer or server (Node):** `node main.mjs` with one SQLite file. See
  [Self-hosting on Node](#self-hosting-on-node).

The portal sends nothing until its fast build is given this server's address, so the
site works exactly as before without it.

## Turn on data collection (about 5 minutes, no code)

You need: an email address, your GitHub account (the one that holds the games site), and
a web browser. Everything below is free.

1. **Click this button:**

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/FarmerCarry/school-games/tree/main/server)

2. **Sign up or sign in to Cloudflare.** If you have no Cloudflare account, choose
   *Sign up*, type your email address and a password of your choice, and open the
   confirmation email Cloudflare sends you. The free plan is all you need: if Cloudflare
   offers a paid plan, skip it.
3. **Connect GitHub when Cloudflare asks.** Click *Connect GitHub* (or *GitHub*), sign in
   to GitHub if asked, and allow Cloudflare. The button makes a **copy of this server in
   your own GitHub account** (a new repository, usually named `school-games-telemetry`),
   and Cloudflare runs that copy. This is normal and expected.
4. **Keep the suggested names.** Leave the project name `school-games-telemetry` and the
   database name `school-games-telemetry` as they are.
5. **Type a dashboard password** in the box named **`ADMIN_TOKEN`**. Make one up: **at
   least 16 English letters or digits, with no spaces** (for example
   `GreenTiger42Window7Lamp`, but make up your own). **Write it down on paper now.**
   You type it to open the dashboard, and Cloudflare keeps it secret: it cannot show it
   to you again later (you can only replace it, see below). If you see no box with that
   name, go on without it and add the password afterwards (see *Changing or setting the
   password later* below).
6. **Press *Create and deploy*** (it may just say *Deploy*).
7. **Wait** one to three minutes, until Cloudflare says the deployment succeeded. If
   Cloudflare first asks you to choose a *workers.dev* name (a subdomain), type a short
   name in English letters, for example your school's name: it becomes part of the address.
8. **Copy the address** it shows. It looks like
   `https://school-games-telemetry.<your-name>.workers.dev`. Send that address to the
   developer (an email or a chat message is fine). The developer then switches the games
   site on, and children's PCs start sending statistics (without names).
9. **Open that address** in your browser to see the dashboard, and sign in with the
   password from step 5. Until children play, there is nothing to show; add `/?demo` to
   the address to see the dashboard with made-up sample data.

**It is free for a school.** Cloudflare's free plan allows 100,000 requests to the
server per day (a PC sends one about every minute of play and one when a game closes;
500 play sessions send about 4,600 to 5,700; the server's own work every 5 minutes adds
about 300), and its free D1 database allows 500 MB per database, 5 million rows read and
100,000 rows written per day. A busy school (500 play sessions a day) writes a little
under half of the daily allowance in the first year and keeps about 350 MB after it
(see [Free-plan arithmetic](#free-plan-arithmetic)). The server counts its own use, and
when a day's writes run high it asks the PCs to send less often (the `X-Batch-Every`
answer header), and when a day's reads run high the dashboard waits until the next day.
If a limit were ever reached, the server stops answering until midnight UTC: nothing is
charged (the free plan has no bill), and the PCs keep their statistics for up to 7 days
and send them later.

**Changing or setting the password later:** on [dash.cloudflare.com](https://dash.cloudflare.com),
open *Workers & Pages*, then `school-games-telemetry`, then *Settings*, then *Variables and
Secrets*. Edit `ADMIN_TOKEN` (or add it, type *Secret*), type the new password and press
*Deploy*. A password shorter than 16 characters, or one with a space, does not count:
the dashboard then says that the password was not set (the statistics are still
collected), and you set a longer one here.

## Before you turn it on

The players are children. No names are collected, nothing a child types, no account or
profile code and no age: each row is play on a school PC, under a random code made for
that play session and one made for that PC. Most of the time a PC is shared by a class,
so a PC's code does not stand for a child; but a PC that one child uses alone (at home,
say) keeps that child's play together over time, so treat the records with care under
GDPR-style rules (the GDPR, the UK GDPR and its Children's Code; COPPA and FERPA notions
in the United States): tell parents before collection starts, give your privacy
reviewers the section "What is collected and kept" below, and check whether publishing
research from it needs consent or an ethics review. A PC sends nothing while a teacher
has stopped statistics on it (the teacher page), and browsers that send Global Privacy
Control never send anything.

## Files

| File | What it does |
|---|---|
| `worker.mjs` | Cloudflare entry: `fetch` (the handler on the D1 database `env.DB`, the dashboard from `env.ASSETS`) and `scheduled` (the daily purge, and every 5 minutes the rollups and the sweep of the live rows). |
| `wrangler.json` | The Worker's settings: D1 binding `DB`, static assets `./dashboard`, two crons (the daily purge, and every 5 minutes the rollups and the sweep of the live rows), `ALLOWED_ORIGINS` and `RETENTION_DAYS`, request logs (observability) off. |
| `package.json`, `package-lock.json` | Wrangler 4.149.0 for deploying (a development tool only), the plain-English descriptions the Deploy button shows, `npm start` for Node, `npm test` for the tests and `npm run demo` for the dashboard's sample data. |
| `.dev.vars.example` | Tells the Deploy button to ask for the `ADMIN_TOKEN` secret (empty on purpose). |
| `handler.mjs` | The HTTP rules as a Fetch-API handler, shared by both hosts: routes, CORS, the soft rate limit, body limits, admin password, the admin router (methods, parameters, guards), status codes. |
| `store.mjs` | The facts (sessions, game visits, rounds, marks, PCs) over a D1-style SQL driver; creates and upgrades its tables itself, one version step at a time (and clears what schema 4 kept per child, a bounded step every 5 minutes); the 5-minute rollups, KPIs, live sessions, settings, retention, the usage meter and its guards, and the kept parts of answers. |
| `admin.mjs` | The research reads (one game, the `r_stat` metrics, the PCs) and the owner's recount, in SQL over the rollups and the facts not rolled yet. |
| `export.mjs` | The research export: each file's pinned columns (`COLUMNS`) and its pages of CSV lines, built in SQL. |
| `rollups.mjs` | The daily rollups of the facts by the school's local day, and milestone 2's frozen daily totals: their tables, and for each rollup the one SQL `SELECT` that defines it. |
| `schema.mjs` | Validation of the envelope (wire versions 2 and 3) and every event kind; cleans and clamps, and reads past the fields and events of older portals' accounts (never returned, so never stored). |
| `clock.mjs` | The school's clock: UTC offsets, local days and the exact bounds of a local day in an IANA zone, from `Intl` alone. |
| `sqlite-d1.mjs` | A D1-style driver over Node's built-in `node:sqlite`, for the Node host and the tests. |
| `app.mjs`, `main.mjs` | The Node host: `node:http` in front of the handler, settings from the environment, a purge every 24 hours, the rollups every 5 minutes. |
| `static.mjs` | The Node host's static file server for `dashboard/`, with the headers of `dashboard/_headers`. |
| `dashboard/` | The insights dashboard (static files), served at `/` by both hosts. `_headers` gives every page a strict Content-Security-Policy. |
| `warnings.mjs` | Hides Node 22's one `node:sqlite` ExperimentalWarning (and nothing else). |
| `simulate.mjs` | A deterministic simulated school (600 children in 24 classes on 30 PCs, mostly wire version 3 without accounts, at the portal sink's real batch cadence) for dashboard development, tests and measurements; `--db` writes weeks of history and rolls each day up as the cron would. |
| `fixtures/sample-batch.json`, `fixtures/sample-batch-v3.json` | A valid v2 and a valid v3 envelope, each with every event kind of its version (shared with the portal's tests). |
| `fixtures/sample-batch-v3-accounts.json` | A v3 envelope from the portal as it was with accounts (a student code, an age band, a profile's session-start fields, a level-up, a removed profile, an older code): accepted, and none of those parts is stored. |
| `test/` | The tests (`npm test`): the school's clock, the rollups against a JavaScript oracle, the facts, the Node host, the Worker entry, and the server without accounts (an older portal's batch, the removed routes and columns, the upgrade from schema 4). |
| `Dockerfile` | A minimal `node:22-alpine` image of the Node host. |

The folder is self-contained (it imports nothing from outside it), because the Deploy
button copies only this folder into a new repository.

## What is collected and kept

What can be stored is decided here, not only by what the portal chooses to send.

* **No names, nothing a child types, nothing that tells children apart.** The contract
  has no field for a name, typed text, error text, a PC label, an account or profile, an
  avatar or colour, an age, a user-agent or a GPU string. The server validates every
  field against closed lists and patterns (`schema.mjs`) and drops anything else:
  unknown envelope fields are ignored, an event with an extra or a malformed field is
  dropped whole, and round ids that could be typed text (three digits in a row, spaces,
  more than 24 characters) are refused.
* **Older portals' account fields are read past.** A PC that still runs the portal from
  before (with student accounts, profiles and age groups), or a cached copy of it, may
  send a student code (`u`), an age band (`a`), a profile's fields at the session start
  (new profile, profile age, days since the last play, level, profiles on the PC,
  classroom mode), level-ups (`lv`), removed profiles (`pr`) and older codes of a student
  (`cd`). Such a batch is accepted like any other (`204`), and none of those parts is
  stored or counted: the validator never returns them.
* **Random codes of sessions and PCs.** A batch of wire version 3 carries a random code
  for the PC (`p`: 12 hex, made once on the PC and never derived from anything about it)
  and the PC's zone name (such as `Asia/Riyadh`); every batch carries the random code of
  its play session (`s`). A value of any other form is stored as unknown (`''`), never as
  sent. A session is play on one PC until the hand-over button, 20 quiet minutes or the
  page closing, whoever played.
* **Play is kept row by row.** Each play session, game visit, round and mark (a heart, a
  tutorial step, the classroom timer) is a row of the facts, with the session's code and
  PC code; each PC code has a row with its first and last play, zone, device buckets and
  build. Older v2 batches are stored the same way, without a PC code.
* **No IP addresses and no headers are stored or logged.** The client address
  (`CF-Connecting-IP` on Cloudflare, the socket address or a trusted `X-Forwarded-For`
  hop on Node) is only a key of the in-memory rate limiter and is forgotten once its
  bucket has refilled. Requests and request bodies are never logged. On Cloudflare,
  Workers observability (stored request logs, which would hold IP addresses) is
  **off** in `wrangler.json`; keep it off. The only log lines are start-up and purge
  counts (Node) and internal error messages.
* **No wall-clock times from the client.** Events carry seconds since the session
  started, and a v3 batch the seconds from the session's start to its sending (`w`).
  The server dates the session by its own clock at receipt minus `w` (for v2: minus the
  batch's last event time and 10 seconds), so a PC whose clock is wrong still dates its
  play correctly; days and hours follow the school's zone.
* **Coarse buckets.** Devices are reported as cores (1, 2, 4, 8, 16), memory in GB
  (0, 1, 2, 4, 8) and screen width (1366, 1600, 1920, 2560); reaction times, input
  latency and frame times as fixed histograms.
* **Every number is shown.** The dashboard's answers show every group with its numbers,
  even one session's (nothing is hidden for small groups); only the dashboard password
  opens them.
* **Downloads.** The research export (`GET /v1/admin/export`) gives the rows themselves,
  under the same session and PC codes. Once downloaded they are outside the server's
  retention: keep them like other school records.
* **Retention.** The daily purge (Cloudflare: a cron at 03:23 UTC; Node: at start and
  every 24 hours) deletes the facts of play sessions that started more than
  `RETENTION_DAYS` days ago (default 400: a school year and the summer; the owner can
  choose 760 on the dashboard), the frozen daily totals of milestone 2 older than that,
  batch ids after 30 days and the server's usage counts after 60 days. The daily rollups
  (counts per day, per game, per level, per PC and the research metrics) are kept 800
  days, or longer if the facts are, and the PC rows as long as the rollups: until their
  last day of play is past the rollups' retention. Live rows go by a sweep every 5
  minutes (Node: every minute). If the database nears the free plan's 500 MB, the
  round-by-round rows of the oldest 30 days of facts are removed (the rollups stay).
  Deletions go a few hundred sessions at a time, so a shorter retention takes a few
  nights to reach the new cutoff. On Node, SQLite's `secure_delete` overwrites deleted
  rows and the write-ahead log is truncated after each purge.
* **What the update to schema 5 removed.** Schema 4 (the server with accounts) also kept
  a code per child's profile, the age band and the profile's fields of every session,
  student rows, the PCs each student played on, links between a child's codes, each
  student's attempt numbers, level-ups and per-student daily rollups. The upgrade deletes
  the student tables, the links, the per-student rollups, the live rows and the marks of
  removed profiles and older codes at once, and the 5-minute cron then clears the rest
  (see [This update: schema 5](#this-update-schema-5-no-accounts-or-ages)). On
  Cloudflare, D1 *Time Travel* can restore the database to any minute of the last 7 days
  (30 on a paid plan), so the deleted rows stay restorable that long after the upgrade
  and are gone after it; on Node, back-ups made before the upgrade still hold them.

## Self-hosting on Node

Node 22.13 or newer (where `node:sqlite` needs no flag); no `npm install` and no
runtime dependencies.

```sh
export ADMIN_TOKEN=$(openssl rand -hex 24)
node server/main.mjs &
# telemetry: listening on port 8787; 0 allowed origin(s), admin on, ...
curl -s localhost:8787/v1/health                    # {"ok":true,"accepts":[2,3],"schema":5}
node server/simulate.mjs --sessions 200             # synthetic sessions (today)
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8787/v1/admin/kpis
# the dashboard: http://localhost:8787/
```

The default database is `server/data/telemetry.db` (ignored by Git).

### Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | TCP port. `0` picks a free one (printed at start). |
| `HOST` | all interfaces | Bind address. Use `127.0.0.1` behind a reverse proxy on the same machine. |
| `DB_PATH` | `server/data/telemetry.db` | SQLite file (created with its folder). Also writes `-wal` and `-shm` files next to it. |
| `ALLOWED_ORIGINS` | none | Comma-separated origins of the portal, e.g. `https://name.github.io` (an origin has no path and no trailing slash, even when the site lives at `/school-games/`). Browser requests from any other origin get no CORS header and `POST /v1/batch` answers `403`. The literal `null` (pages from `file:` or sandboxed frames) is accepted only if listed; the portal never sends from `file:`. |
| `ADMIN_TOKEN` | none | The dashboard password: the bearer token for `/v1/admin/*`, at least 16 printable ASCII characters without spaces (use `openssl rand -hex 24`). Unset: the admin endpoints answer `404`. |
| `RETENTION_DAYS` | `400` | Days of play facts to keep (1 to 36,500); the daily rollups are kept at least 800 days. The owner's choice on the dashboard (`keepDays`) wins. |
| `RATE_PER_MIN` | `1200` | Requests per minute per client address (token bucket, bursts up to the same number). Generous because a whole school lab shares one NAT address. `0` turns the limit off. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the server. With `1`, the client address for the rate limit is the last `X-Forwarded-For` entry (the one your proxy wrote); with `0` it is the socket address, so all traffic through a proxy shares one bucket. |

The server refuses to start on a malformed origin, a short admin token, a bad number,
or a database written by a newer version of the server.

On Cloudflare the same settings are `ALLOWED_ORIGINS` and `RETENTION_DAYS` (plain
variables in `wrangler.json`, default `https://farmercarry.github.io` and `400`),
`ADMIN_TOKEN` (a secret; an invalid one turns the admin endpoints off rather than
stopping the Worker) and the optional `RATE_PER_MIN` (the limit is per Worker
instance, so it is soft).

### Deploying

The Node host speaks plain HTTP. **Always run it behind a TLS reverse proxy**: the
portal only sends to `https://` URLs, and GitHub Pages is served over HTTPS. Configure
the proxy **not to log client IP addresses**, and keep request bodies out of its logs.

**Docker:**

```sh
docker build -t school-games-telemetry server/
docker run -d --name sg-telemetry --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v sg-telemetry:/data \
  -e ALLOWED_ORIGINS=https://name.github.io -e TRUST_PROXY=1 \
  -e ADMIN_TOKEN="$(cat /etc/sg-telemetry/admin-token)" \
  school-games-telemetry
```

The image runs as the unprivileged `node` user, stores the database in the `/data`
volume, serves the dashboard and has a health check on `/v1/health`.

**A small VM with systemd:** copy the `server/` folder to `/opt/sg-telemetry` and
install Node 22.13 or newer (for example from nodejs.org or NodeSource). Then
`/etc/systemd/system/sg-telemetry.service`:

```ini
[Unit]
Description=School games telemetry ingest
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/sg-telemetry/main.mjs
Environment=HOST=127.0.0.1 PORT=8787 TRUST_PROXY=1 DB_PATH=/var/lib/sg-telemetry/telemetry.db
Environment=ALLOWED_ORIGINS=https://name.github.io
# The admin token, as the line ADMIN_TOKEN=... in a file only root can read (chmod 600).
# The leading "-" lets the service start without the file (admin endpoints off).
EnvironmentFile=-/etc/sg-telemetry.env
DynamicUser=yes
StateDirectory=sg-telemetry
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now sg-telemetry`. The journal receives only the server's own
lines, which never contain addresses.

**Caddy** (automatic HTTPS; Caddy writes no access log unless you add a `log` directive):

```
telemetry.example.org {
	request_body {
		max_size 64KB
	}
	reverse_proxy 127.0.0.1:8787
}
```

**nginx:**

```nginx
server {
    listen 443 ssl;
    server_name telemetry.example.org;
    ssl_certificate     /etc/letsencrypt/live/telemetry.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/telemetry.example.org/privkey.pem;
    access_log off;                 # never log children's IP addresses
    error_log /var/log/nginx/telemetry.error.log crit;  # lower levels include the client address
    client_max_body_size 64k;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header X-Forwarded-For $remote_addr;  # replaces any client-supplied value
    }
}
```

**Any other Node host** that runs `node main.mjs` (or `npm start` in `server/`) with Node
22.13+, gives it a persistent disk for `DB_PATH` and terminates TLS works (one instance:
SQLite is a single file). Check that the platform's request logs can be configured
without client IPs, or turned off.

## Pointing the portal at the server

The source tree never contains a URL. The fast build (`tools/build.mjs`) reads the
**`SG_TELEMETRY_URL`** environment variable and injects it into the portal as
`window.SG_TELEMETRY.url`; the portal's sink (`js/telemetry.js`) is the only code that
uses it. It must start with `https://` and name the batch endpoint: the Worker's
address plus `/v1/batch`, for example
`https://school-games-telemetry.name.workers.dev/v1/batch`.

* **This project:** `.github/workflows/build.yml` names the school's Worker,
  `https://school-games-telemetry.services-agreement137.workers.dev/v1/batch`; a `SG_TELEMETRY_URL`
  repository variable overrides it, and removing the address from the workflow switches
  the portal off.
* **GitHub Pages in general:** in the repository, *Settings → Secrets and variables →
  Actions → Variables → New repository variable*, name `SG_TELEMETRY_URL`; delete it and
  rebuild to switch telemetry off.
* **A local build:** `SG_TELEMETRY_URL=https://telemetry.example.org/v1/batch node tools/build.mjs`.
* `ALLOWED_ORIGINS` must list the site's origin (on Cloudflare it already lists
  `https://farmercarry.github.io`).

## Updating the server

**On Cloudflare** the Worker runs the owner's GitHub repository
(`FarmerCarry/school-games-telemetry`), and Cloudflare deploys every push to its default
branch within a few minutes. To update it, merge the change into that branch (keep that
repository's own `wrangler.json`, which names its D1 database, and its `RETENTION_DAYS`).
There is no migration to run by hand: the store upgrades the database itself (see
*Upgrades* under [Operations](#operations)).

**Check after a deploy:**

* `https://<your worker>/v1/health` answers `{"ok": true, "accepts": [2, 3], "schema": 5}`;
* a real batch from a PC is answered `204` (the first request after a deploy that
  upgrades the database may be answered `503` once; the PC sends it again);
* `/?demo` shows the dashboard with sample data, and after signing in every tab shows
  the school's numbers (reload a dashboard tab that was open before the deploy);
* the next 5-minute cron runs without errors (*Workers & Pages* →
  `school-games-telemetry` → *Metrics*), and the meters on the Settings page move.

### This update: schema 5 (no accounts or ages)

The site no longer has student accounts, player profiles ("who's playing", guests, the
picture profiles, experience levels) or age groups. Schema 5 keeps every statistic of
play and nothing per child. On the first request after the deploy (answered `503 updating`;
the Node host does it at start), in one transaction (well inside D1's 50 statements):

* **Dropped:** the tables `st_students` (student rows: code, label, age bands, profile
  age), `st_student_pcs` (who played on which PC), `st_student_games` (each student's
  rounds per game, for attempt numbers), `aliases` (links between a child's codes), the
  per-student rollups `r_student_day` and `r_student_game`, and the index
  `st_sessions_student`.
* **Deleted:** the marks of removed profiles (`pr`) and older codes (`cd`) in `st_marks`
  (each holds a student code), every row of `live` (made again without the student
  column) and every kept answer in `kpi_cache`; the rollup version `rv` goes up.
* **Started:** the clearing (`scrub` in `settings`), with the sessions to clear (up to
  the newest session id) and the rolled days.

Then the 5-minute cron clears what schema 4 wrote in the columns that stay, a bounded
step at a time and only while the day's writes leave room, before any other catch-up
work (the night's roll of yesterday still comes first):

* **Facts**, 500 sessions a run: in `st_sessions` the student code `u` and the age band
  `a` become `''`, and the profile's fields (`is_new`, `age_days`, `since_days`,
  `age_b`, `since_b`, `level0`, `np`, `cls`) become `NULL`; in `st_rounds` the
  student's `attempt` becomes `NULL`; the level-up marks (`lv`) are deleted.
* **Rollups**, as many days a run as about 20,000 rows written allow (at least one):
  each banded table's rows of the age bands `6-7`, `8-9` and `10-11` are added into the
  day's row without a band and deleted; the counts of students, guests, new profiles,
  linked minutes and profiles on a PC become `0`; in `r_stat` the rows of the
  per-student metrics (`daymin`, `attempt`, `tenure`) are deleted and session lengths
  are kept per wire version only. Milestone 2's frozen daily totals (on a database that
  has them) get the same treatment.

The dashboard's Settings page says how many sessions and days are left. With a few
hundred sessions the clearing ends within the first half hour. Each run is counted as
8,000 rows written and runs only while the UTC day's writes leave that room under the
85,000 the cron may use (with 40,000 kept for the day's batches), so it clears a few
thousand sessions a UTC day at most: a busy school's year (100,000 sessions) would take
some weeks, never near D1's daily limit. Every answer reads the
cleared and the not yet cleared rows alike (the bands added up, the dropped metrics left
out), so no number moves while it runs, except that a game's play time on a day rolled
by schema 4 can differ by a second or two (schema 4 rounded it per age band). The old
columns stay in the tables, always empty: dropping a column rewrites every row, and D1
bills each one. A database made new has the same columns, so both read alike.

**What stays the same:** every session, game visit, round and the other marks (hearts,
tutorials, the classroom timer), the PC rows, the school's clock, the settings and every
rollup count of play. Wire versions 2 and 3 are both still accepted; an older portal's
account fields are read past (see [What is collected and kept](#what-is-collected-and-kept)).

**Rolling back.** The schema 4 server refuses a schema 5 database ("newer than this
server"), so going back is one of:

* deploying this server again with a fix (the database stays as it is); or
* restoring the database with D1 *Time Travel* (any minute of the last 7 days on the
  free plan) to just before the deploy, then deploying the schema 4 server. This brings
  the deleted student data back, and play that arrived after that point is lost. The
  restore is in the Cloudflare dashboard (*Storage & databases* → *D1* →
  `school-games-telemetry` → *Time Travel*) or `npx wrangler d1 time-travel restore
  school-games-telemetry --timestamp=<the time, RFC 3339>`.

While the server answers `5xx` or cannot be reached (during a deploy, or the `503` of
the upgrade), the PCs keep what they could not send for up to 7 days and send it later;
any other `4xx` answer than `429` is final.

**On Node,** stop the server, back up the database (see [Operations](#operations)),
replace the folder and start it again: the Node host upgrades the database at start,
and its 5-minute timer clears the rest. Going back means that backup.

### Measuring the batch rate first (Step 0)

Before the first update to milestone 2.5, with milestone 2's server still running, open
the D1 console (Cloudflare → *Storage & databases* → *D1* → `school-games-telemetry` →
*Console*) and run, one at a time:

```sql
SELECT day, COUNT(*) FROM batches GROUP BY day ORDER BY day DESC LIMIT 14;
SELECT day, SUM(sessions) FROM agg_days GROUP BY day ORDER BY day DESC LIMIT 14;
```

Divide each school day's batches by its sessions and record the ratio below. If it is
above 16, the portal's default batch timer for wire version 3 goes from 60 to 90 seconds
(`docs/RESEARCH_TELEMETRY_SPEC.md`, §B.6), before that version is published.

| Measured on | School days | Batches per session (portal on wire version 2, 20 s timer) |
|---|---|---|
| not measured yet (needs the Cloudflare account) | | |

For comparison, the simulated school (`simulate.mjs`) sends 15.4 batches per version 2
session (20 s timer) and 11.3 per version 3 session (60 s timer, and one when a game
closes).

## API

Every API response (paths under `/v1/`) has `Vary: Origin`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and, for an origin in `ALLOWED_ORIGINS`,
`Access-Control-Allow-Origin: <that origin>` and `Access-Control-Expose-Headers:
Retry-After, X-Batch-Every`. Credentials are never allowed. Error bodies are `{"error": "<short
reason>"}` (a `429` from a guard adds `until`) and never echo the request. Every request that reaches the server (including
`OPTIONS`, health checks and, on Node, dashboard files) takes a token from the client's
rate-limit bucket; an empty bucket answers `429` with `Retry-After` in seconds.

### `GET /` and other paths outside `/v1/`

The dashboard's static files from `dashboard/` (`GET` and `HEAD` only; missing files are
`404`, and other methods `404` on Node and `405` on Cloudflare). On Cloudflare, Workers static assets serve them; on Node,
`static.mjs` serves only regular files inside the folder (no dot files, no `_headers`,
no path outside it). Both send the headers in `dashboard/_headers`: a
Content-Security-Policy (`default-src 'self'` and `script-src 'self'`; the game names come
bundled in `names.js`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` for the page.

### `POST /v1/batch`

The body is the telemetry envelope as JSON, sent as `text/plain` (a CORS "simple
request" without a preflight) or `application/json`. Wire version 2 (`"v": 2`, the
portal until milestone 2.5) and version 3 (`"v": 3`) are both accepted, version 2
indefinitely (queues of up to 7 days, cached portals). See
`fixtures/sample-batch.json`, `fixtures/sample-batch-v3.json`, `docs/ARCHITECTURE.md`
and `docs/RESEARCH_TELEMETRY_SPEC.md` ("Wire format v3"). A batch from an older portal
with accounts (`fixtures/sample-batch-v3-accounts.json`) is accepted too; its account
fields are read past (below).

| Status | When |
|---|---|
| `204` | Stored, or already stored: a repeated v2 batch id is answered the same, and a v3 batch delivered again changes nothing, so the client drops it. Unknown event kinds and malformed events are dropped silently; the rest of the batch is kept. The header `X-Batch-Every` gives the seconds the PC should wait between batches: `60` while the day's rows written are at most 60,000, `180` up to 80,000, `300` above. |
| `400` | Not JSON, or an invalid envelope: `v` is not `2` or `3`; `b` is not 16 lowercase hex; `s` is not 12 lowercase hex; `k` is not `src` or exactly 16 lowercase hex; `m` is not `web`/`app`; `d` is not `[cores, memoryGB, screenWidth]` from the bucket lists; `ev` is not an array of at most 200 entries. |
| `403` | The request has an `Origin` header that is not in `ALLOWED_ORIGINS`. Requests without `Origin` (tools, `simulate.mjs`) are accepted. |
| `413` | The body is over 64 KB (65,536 bytes), declared or streamed. |
| `415` | Another content type. |
| `429` | Rate limited. |
| `503` | `{"error": "updating"}` with `Retry-After: 2`: this request created or upgraded the database (one version step) and did nothing else. The portal sends the batch again. Only on Cloudflare: the Node host upgrades at start. |

The fields version 3 adds to the envelope are lenient, because the portal drops a batch
for good on any `4xx`: a malformed value is stored as unknown and the batch is kept.

| Field | Accepted | Otherwise |
|---|---|---|
| `p` | a PC code: 12 lowercase hex, or `''` | `''` |
| `z` | an IANA zone this server knows (or `UTC`), at most 40 characters | `''` |
| `w` | a whole number of seconds from 0 to 691,200 (8 days): the session's age when the batch was sent | `null` (the session is dated from the receipt time) |

**Read past, never stored.** The fields of the portal's former accounts are not
validated and not kept, whatever they hold, so a batch is never refused for them: the
envelope's age band `a` (v2 and v3) and student code `u` (v3); every field of the
session start `ss` after its time; and the event kinds `lv` (a level-up), `pr` (a profile
removed on the PC) and `cd` (an older code of a student), which are neither kept nor
counted as dropped.

Event validation (exact length, except `ss`; every field must pass):

| Event | v2 fields after the kind | v3 fields after the kind |
|---|---|---|
| `ss` | `t` (an older portal's profile fields after it are read past) | the same |
| `go` | `t`, slug, source (`featured catalog recent favorites category quick search related surprise reload history direct starter`), plays before `0`–`4` | `t`, visit `n` (`1`–`9999`), slug, source, plays before (≤ 10⁶), favourite `0`/`1` |
| `ld` | `t`, slug, load ms | `t`, `n`, slug, load ms |
| `er` | `t`, slug, kind `t`/`x`/`l` | `t`, `n`, slug, kind |
| `rs` | `t`, slug, round id, tier `0`–`9`, replay index | `t`, `n`, round `k` (`1`–`99999`), slug, round id, tier, replay index |
| `re` | `t`, slug, code `w`/`l`/`d`/`e`/`q`, round id, ms, score (`-1` or ≥ 0), tier `0`–`9`, hits, misses, `rt[6]` | `t`, `n`, `k`, slug, then as v2, then `x`: `null` or `[wallMs, inputs, idleLapses, pauses, rtSumMs, rtN, ddaPermille]` (lenient: anything else is `null` and the round is kept) |
| `gp` | | `t`, `n`, slug, engaged ms so far |
| `gx` | `t`, slug, engaged ms, `il[6]`, `f[4]` | `t`, `n`, slug, engaged ms, `il[6]`, `f[4]` |
| `tu` | | `t`, `n`, slug, tutorial step `s`/`d` |
| `fv` | | `t`, `n`, slug, heart on `1` or off `0` |
| `ct` | | `t`, classroom timer `s`/`c`/`e`, minutes (≤ 120) |
| `se` | `t`, engaged ms | `t`, engaged ms, why the session ended `u`/`p`/`h`/`i` |

Slugs match `^[a-z0-9]+(?:-[a-z0-9]+)*$` (at most 40 characters); round ids match
`^[A-Za-z][A-Za-z0-9_:.-]{0,23}$` without three digits in a row. Neither may be a
built-in object key such as `constructor`. Enumerations, flags, buckets and tiers must
be exact integers. Measured numbers (`t`, ms, counts, scores, levels, histogram
entries) must be finite and not negative; they are rounded and clamped to: `t` 7 days
in seconds, level 999, load 120,000 ms, replay index 9,999, round 3 h, score 10⁹,
hits/misses/`rt`/`il` entries 100,000, each frame bucket 10⁷, game visit 6 h, session 24 h.

### `OPTIONS *`

`204`. For an allowed origin also `Access-Control-Allow-Methods: GET, HEAD, POST,
OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization` and
`Access-Control-Max-Age: 86400`.

### `GET /v1/health`

`200 {"ok": true, "accepts": [2, 3], "schema": 5}`: the wire versions this server takes
and its database schema. It never touches the database, so it is the check to make
before a portal that sends version 3 is published.

### Admin endpoints

| Route under `/v1/admin/` | Methods | Guard |
|---|---|---|
| `kpis`, `game`, `stats`, `pcs` | `GET` | reads |
| `export` | `GET` | export reads |
| `live` | `GET` | none |
| `settings` | `GET`, `POST` | none |
| `rebuild` | `POST` | writes |

There is nothing per child: the routes of schema 4's students (`students`, `student`,
`cohorts`, `forget`, `link`, and the older `cards`) answer `404` like any unknown path,
and a `band` parameter is ignored.

`HEAD` goes with every `GET`. Every admin route needs `Authorization: Bearer
<ADMIN_TOKEN>` (compared in constant time). Without a valid token: `401` with
`WWW-Authenticate: Bearer`. With no valid `ADMIN_TOKEN` set: `404 {"error": "admin
password not set"}` (the dashboard shows this as "the password was not set"). A method a
route does not take: `405` with `Allow`, the route's methods (with `HEAD` for a `GET`
route) and `OPTIONS`. The request that upgrades the database answers `503` as for
batches. Every JSON answer has `"v": 1` and the school's clock, `"clock": {"tz",
"source", "offsetMin", "today"}` (`today` is the school's local day).

**Parameters.** `from` and `to` as for the KPIs below: days `from`..`to` of the
school's clock (inclusive, at most 366; default the 30 days ending today). A game `slug`
is as in batches. A malformed parameter, or a missing one that has no default: `400
{"error": "<its name>"}`.

**Bodies.** `POST` takes a JSON body (`Content-Type: application/json`, at most 4 KB).
Over 4 KB: `413`; another media type: `415`; not
JSON: `400 {"error": "json"}`; not an object: `400 {"error": "body"}`; a field the route
does not take: `400 {"error": "field"}`. There is no cookie, so another site cannot make
a browser send these requests.

**Nothing is hidden:** every group is shown with its numbers, even a single session
(`minSessions` is `0`, and no group is ever `suppressed`). A dashboard
should mark small numbers as early signs instead.

**The free allowances.** D1's free plan stops every query for the rest of the UTC day
once 5 million rows have been read, and every write once 100,000 rows have been
written. As far as the server's own meter knows: once the day's reads pass 4.2 million,
the admin reads answer `429 {"error": "reads", "until": "03:00"}`, `until` being the next
00:00 UTC on the school's clock; export pages answer so from 3.5 million, so that an
export stops well before the dashboard does; once the day's writes pass 90,000,
`rebuild` answers `429 {"error": "writes", "until": ...}`. `live` and
`settings` always answer, and batches are never refused.

Writes are metered per instance and flushed at the start of a batch at most once a
minute, before anything in that batch reads the day's usage; the crons end by writing
their own counts, so a cron run in a new Worker instance is counted too.

**Kept parts.** Each read takes the days already rolled up from the rollups and the
days after them (today, and yesterday until the night's roll) from the facts, through
the rollups' own SQL, so both count alike (`stats` and a game's `stats` and flows take
the rolled days only). The part of the rolled days is kept in
`kpi_cache` under the route, its parameters and the rollup version `rv`, and in the
instance's memory for an hour; on Cloudflare the part of the other days is kept 10
minutes (on Node it is made on every request). A part over 1 MB is not kept. Each roll
(a recount's too) and the upgrade to schema 5 raise `rv`, so later answers are made again
(a Worker instance that kept a part in memory sees the new `rv` within 5 minutes).
Every answer takes at most 20 statements.

#### `GET /v1/admin/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD`

Days `from`..`to` (inclusive, at most 366 days; default: the 30 days ending today on the
school's clock). Days up to the update to schema 4 (`range.legacyUntil`) are the frozen
UTC receipt days of milestone 2; days from `range.factsSince` on are the school's local
days. On the one day both cover, both add up. Invalid parameters: `400`.

Conventions:

* A **group** is an object with its key fields and `sessions`, the number of distinct
  sessions in it (for games this is the brief's "unique sessions"). A group that has no
  play keeps its zeros.
* **A session counts once, on the day it started** (on the school's clock), with
  everything it did; a range's sessions are the sum of its days' sessions. Sessions are
  anonymous: nothing counts children, players or age groups.
* Rates and shares are 0..1 with 4 decimals and `null` when the denominator is 0.
  Minutes have 1 decimal (`avgEngagedMinutesPerSession` 2), seconds 1, tiers 2,
  scores 1, milliseconds are whole.
* A batch kept offline and delivered later counts on the day it was played. Engaged
  time is each game visit's: from its close (`gx`) and, for v3, also from the running
  time (`gp`) of a visit that never closed.
* Histograms: `rt` reaction time `<300, <500, <800, <1200, <2000, ≥2000` ms; `il` input
  latency `<8, <16, <33, <50, <100, ≥100` ms; frames `smooth ≤20, ok ≤34, choppy ≤250,
  stall >250` ms; `replayIndex` `0, 1, 2, 3–4, 5–9, 10+` prior starts of the same round
  in the session; `playsBefore` `0, 1, 2–4, 5–9, 10+` visits before, as the PC counted
  them.
* Round codes: `w` win, `l` loss, `d` draw, `e` neutral end (endless runs, two-player
  modes), `q` quit. Endless games end with `e`, so their completion rate is 0 and
  their win rate `null`: read `rounds.codes` and `dropOffRate` for them.
* A device bucket counts a session under its first batch's.
* Days already rolled up come from the rollups; today (and yesterday until 01:00 at
  the school, or any day the cron has not reached) from the facts, with the same
  definitions. A day rolled again after late data shows the late play within about an
  hour. On Cloudflare the answer for the days not rolled yet is kept 10 minutes.

```jsonc
{
  "v": 1,
  "range": { "from": "2026-11-01", "to": "2026-11-26", "days": 26,
    "legacyUntil": "2026-10-28", "factsSince": "2026-10-28" },   // '' when this database never held milestone 2's totals
  "minSessions": 0,
  "clock": { "tz": "Asia/Riyadh", "source": "pcs", "offsetMin": 180, "today": "2026-11-26" },
  "totals": {
    "sessions": 2560,                          // distinct sessions, per day
    "engagedMinutes": 22692.6,                 // sum of the visits' engaged ms
    "avgEngagedMinutesPerSession": 8.86,
    "gameOpens": 6419, "roundsStarted": 27938, "roundsEnded": 27938, "errors": 147
  },
  "daily": [                                   // every day of the range, oldest first
    { "day": "2026-11-23", "sessions": 120, "engagedMinutes": 1117.5, "opens": 320 },
    { "day": "2026-11-24", "sessions": 1, "engagedMinutes": 3.2, "opens": 1 }
  ],
  "games": [                                   // sorted by slug
    {
      "slug": "bubble-bop", "sessions": 469,
      "opens": 493, "closes": 493, "engagedMinutes": 766.7,
      "avgEngagedSecPerOpen": 93.3,            // engaged seconds per closed visit
      "rounds": { "starts": 2073, "ends": 2073, "codes": { "w": 1596, "l": 243, "d": 0, "e": 0, "q": 234 } },
      "completionRate": 0.7699,                // wins / starts
      "winRate": 0.8679,                       // wins / (wins + losses)
      "dropOffRate": 0.1129,                   // quits / starts
      "avgTier": 2.78,                         // mean start tier of rounds with DDA (tier > 0), else null
      "hits": 27759, "misses": 11294, "accuracy": 0.7108,          // hits / (hits + misses)
      "rt": [5560, 8057, 6990, 4109, 2033, 1010],
      "il": [18098, 12339, 5194, 1811, 1047, 564],
      "frames": { "counts": [2374001, 232663, 58174, 3136], "smoothShare": 0.8898, "stallShare": 0.0012 },
      "loads": 481, "avgLoadMs": 940,
      "errors": { "t": 5, "x": 4, "l": 3 },    // timeout, script error, load error
      "sources": { "featured": 40, "catalog": 73, "starter": 283 },  // opens per launch source (non-zero only)
      "replay": { "replayIndex": [1632, 327, 76, 35, 3, 0], "playsBefore": [379, 26, 27, 32, 29] },
      "hearts": { "on": 12, "off": 2 },        // the heart button pressed in a visit
      "tutorials": { "start": 88, "done": 71 },
      "wallMinutes": 1022.4,                   // rounds' wall-clock time (newer Kit only)
      "actionsPerMinute": 41.3,                // key presses and clicks per minute of that time
      "avgScore": 212.4,                       // mean score of rounds that report one
      "unended": 14,                           // rounds started and never ended
      "duoRounds": 0                           // local two-player rounds
    }
  ],
  "levels": [                                  // per (slug, round id), sorted by slug then id (L2 before L10)
    { "slug": "air-hockey", "id": "L1", "sessions": 126, "starts": 248, "ends": 248,
      "codes": { "w": 111, "l": 107, "d": 0, "e": 0, "q": 30 },
      "completionRate": 0.4476, "winRate": 0.5092, "dropOffRate": 0.121, "avgMs": 78585, "avgTier": null,
      "avgScore": null, "unended": 3 }
  ],
  "sources": [                                 // launch sources over all games, in the contract's order
    { "src": "featured", "sessions": 1013, "opens": 1242 }
  ],
  "devices": {                                 // each dimension separately, sorted by value
    "cores":  [ { "value": 2, "sessions": 617,
                  "frames": { "counts": [15436271, 2715746, 676173, 35793], "smoothShare": 0.8183, "stallShare": 0.0019 },
                  "il": [75877, 88713, 50563, 20262, 12608, 5099], "avgLoadMs": 1757 } ],
    "memory": [ ... ],
    "screen": [ ... ]
  },
  "modes": [ { "mode": "web", "sessions": 2180 }, { "mode": "app", "sessions": 380 } ],  // app = installed PWA
  "quality": {                                 // how far the numbers can be trusted (the days from factsSince)
    "v2Share": 0.18,                           // engaged time of sessions from PCs still on wire version 2
    "clockEstimatedShare": 0.2,                // sessions dated from the receipt time, not the PC's elapsed seconds
    "unclosedVisits": 310,                     // game visits never closed
    "idleHandovers": 23,                       // sessions that ended after 20 quiet minutes
    "pcsNew": 12,                              // PC codes seen (only PCs on the new version send one)
    "oldVersionSessionShare": 0.18             // sessions from PCs on wire version 2
  }
}
```

Schema 4's player and student parts (`totals.levelUps`, `totals.players`,
`totals.students`, `daily[].students` and `guestMinutes`, `games[].students`,
`levels[].students`, `bands`, and the quality's `linkedShare`, `unknownBandShare`,
`profilesFullPcs` and `forgetfulPcs`) are gone.

#### `GET /v1/admin/live`

Sessions whose last batch arrived in the current minute or the four before it (300 s
at minute resolution), and the game each one has open (opened with `go` and not yet
closed with `gx`; `se` closes everything; a session forgotten after 5 quiet minutes has
nothing open). A batch delivered late from a PC's offline queue counts as a sign of
life when it arrives; a repeated batch does not. `pcs` are the distinct PC codes (PCs
still on wire version 2 send none).

```json
{ "v": 1, "windowSec": 300, "minSessions": 0,
  "total": { "sessions": 14 }, "pcs": 12,
  "games": [ { "slug": "dino-3d", "sessions": 3 }, { "slug": "block-burst", "sessions": 1 } ],
  "clock": { "tz": "Asia/Riyadh", "source": "pcs", "offsetMin": 180, "today": "2026-11-26" } }
```

#### `GET /v1/admin/settings` and `POST /v1/admin/settings`

The school's clock, retention, storage and today's usage:

```jsonc
{
  "v": 1,
  "clock": { "tz": "Asia/Riyadh", "source": "pcs", "offsetMin": 180, "today": "2026-11-26", "now": "10:42",
    "weekStart": "sun", "weekSource": "auto",             // auto: from the zone; owner: chosen
    "detected": [ { "tz": "Asia/Riyadh", "pcs": 12 } ],   // zones of the PCs seen in the last 14 days
    "factsSince": "2026-10-28", "legacyUntil": "2026-10-28", "v3Since": "2026-11-02" },
  "keep": { "days": 400, "source": "env", "rollupDays": 800 },   // source: env (RETENTION_DAYS) or owner
  "storage": { "bytes": 82000000, "limit": 500000000, "guardAt": 425000000, "trimmedBefore": "" },
  "usage": { "day": "2026-11-26", "reads": 450000, "writes": 34000, "readsLimit": 5000000, "writesLimit": 100000, "batchEvery": 60 },
  "rebuild": { "pending": 0, "full": 0, "done": 200 },  // rolled days since factsSince: waiting to be rolled again, in full, and done
  "clearing": { "sessions": 1240, "days": 39 },         // while the upgrade to schema 5 clears what schema 4 kept: what is left; else null
  "accepts": [2, 3],
  "pcs": { "new": 14, "seen14d": 12 }                   // PC codes known, and seen in the last 14 days
}
```

`usage` is UTC (D1's day), as far as the server's own meter knows ("about": an instance
that stops loses its last minute of counts).

`POST` takes a JSON body (`Content-Type: application/json`, at most 4 KB) with any of
`tz` (an IANA zone this runtime knows), `source: "dashboard"` (only with `tz`),
`weekStart` (`"sun"` or `"mon"`) and `keepDays` (`400` or `760`), and answers like `GET`.
Anything else is `400 {"error": "<field>"}`; another media type `415`.

* **Where the school's zone comes from** (`clock.source`): `none` (nothing known yet:
  UTC); `dashboard` (`{tz, source: "dashboard"}`, the signed-in browser's zone, taken only
  while the source is `none` or `dashboard`); `pc` (the first v3 batch with a zone, while
  the source is `none` or `dashboard`, then the nightly vote); `pcs` (locked: the nightly
  vote found 3 PCs seen in the last 14 days reporting the top zone); `owner` (`{tz}`
  without `source`). Nothing changes `pcs` or `owner` automatically, and only the owner
  changes `pcs`.
* A new zone moves every rolled day (since `factsSince`, and not trimmed by the storage
  guard) to the new clock: the 5-minute cron rebuilds them one at a time, newest first,
  as far as each UTC day's writes leave room (see *Rollups* under Operations: at a busy
  school about one day a school day, more at weekends), and `rebuild` shows how far it
  is. The facts never change. A day that is today again on the new clock (the clock moved
  west after it was rolled) is read from the facts until it is over, then rebuilt.
* The week start follows the zone while `weekSource` is `auto` (Sunday in Riyadh, Cairo
  and the other zones `clock.mjs` lists, Monday elsewhere); `weekStart` sets it for good.
* `keepDays` overrides `RETENTION_DAYS`: 400 days (a school year and the summer) or 760
  (two). Keeping more is refused with `400 {"error": "storage"}` when the database,
  growing in proportion, would pass the storage guard.

#### `GET /v1/admin/game?slug&from&to`

One game's page. `stats`, `flowsIn` and `flowsOut` cover the rolled days only (up to
last night); `daily` also today.

```jsonc
{ "v": 1, "slug": "bubble-bop", "range": { "from": "2026-09-28", "to": "2026-10-27", "days": 30 },
  "daily": [ { "day": "2026-09-28", "minutes": 21.1, "opens": 13 } ],   // every day of the period
  "stats": { "columns": ["metric", "k1", "k2", "n", "w", "l", "q", "ms", "win_ms", "hits", "misses", "rt_sum", "rt_n", "inputs", "gap_sum", "gap_n"],
    "rows": [["fatigue", "0", "", 479, 364, 80, 35, 11041230, 0, 12303, 3065, 8208490, 11083, 13905, 0, 0]] },   // this game's r_stat rows
  "flowsIn": [ { "from": "", "n": 76 }, { "from": "rail-rush", "n": 10 } ],   // the game before it ('': it came first)
  "flowsOut": [ { "to": "", "n": 31 }, { "to": "tic-tac-toe", "n": 9 } ],     // the game after it ('': the session ended)
  "clock": { ... } }
```

#### `GET /v1/admin/stats?from&to&metrics=a,b,...[&slug]`

The research metrics of `r_stat`, summed over the rolled days of the period (up to
`range.rolledThrough`), for every game or the game `slug`. `metrics` is a comma-separated
subset of `hour, rhour, sesslen, games, visitlen, flow, persist, fatigue, qrun, tier,
tutorial` (`docs/RESEARCH_TELEMETRY_SPEC.md`, §D.2, gives each one's keys `k1` and `k2`;
`sesslen`'s `k2` is the wire version, `3` or `2`); the answer lists them in that order.
Schema 4's per-student metrics (`daymin`, `attempt`, `tenure`) are gone: asking for one
is `400 {"error": "metrics"}`. Rows are sorted by their keys. `columns` holds the keys and
only the sums the asked metrics have (every other sum is always 0 in their rows), in the
order below; read a value by its column's name.

```jsonc
{ "v": 1, "range": { ..., "rolledThrough": "2026-10-28" }, "metrics": ["hour", "flow"], "slug": null,
  // all the sums: n, w, l, q, ms, win_ms, hits, misses, rt_sum, rt_n, inputs, gap_sum, gap_n;
  // hour and flow have these:
  "columns": ["metric", "slug", "k1", "k2", "n", "ms", "gap_sum", "gap_n"],
  "rows": [ ["flow", "", "air-hockey", "", 1, 0, 0, 0] ],
  "clock": { ... } }
```

#### `GET /v1/admin/pcs?from&to`

Every PC with a code that played in the period, by code.

```jsonc
{ "v": 1, "range": { ... },
  "pcs": [ { "p": "01e890fc1672", "label": "01E8", "firstDay": "2026-10-28", "lastDay": "2026-10-28",
    "days": 1, "sessions": 4, "minutes": 19.6,
    "smoothShare": 0.9278, "stallShare": 0.0008,   // frames up to 20 ms; over 250 ms
    "avgLoadMs": 926, "slowInputShare": 0.0198,    // input latency of 50 ms or more
    "errors": 0, "z": "Asia/Riyadh", "build": "5c18c6d2d1c052ad",
    "flags": ["choppy"] } ],                   // choppy, old (below)
  "clock": { ... } }
```

Flags: `choppy`, under 80% of its frames were smooth; `old`, its build is not that of
the PC seen last.

#### `GET /v1/admin/export?file&from&to[&after]`

One page of a research file: `200`, `Content-Type: text/csv; charset=utf-8`, at most
2,500 lines **without a header** (each ending in a line feed; SQL joins them, so the
Worker sends one string), `X-Rows: <lines>` and,
unless it is the last page, `X-Next: <cursor>`; the next page is the same request with
`&after=<cursor>`. A cursor that is not this file's: `400 {"error": "after"}`. The
dashboard writes the header (its data dictionary lists the same columns as
`export.mjs` `COLUMNS`), the BOM and the zip.

* No value is quoted, because none can hold a comma, a quote or a line break: each is a
  number, an ISO date, a time `HH:MM:SS` or a token the server validated (session and PC
  codes, slugs, round ids, builds, zone names, the words below). Empty means unknown or not
  applicable; `-1` never appears; `.` is the decimal mark.
* Days, weekdays (1 = Sunday … 7 = Saturday) and times are the school's clock, each at
  the row's own moment (a round's start, a mark's time).
* No file has a column for a student, a profile or an age group: rows are play
  sessions, game visits, rounds and marks under their session and PC codes.
* Pages follow a key, never an offset, so each row is read once. A daily file's page
  covers a few weeks; one can be empty and still have `X-Next`.

| `file` | One line per | A page |
|---|---|---|
| `sessions` | session started in the period | 400 sessions, by start |
| `visits`, `rounds`, `events` | game visit, round, mark (of those sessions) | 2,500 lines, in the sessions' order |
| `daily_games` | day, clock and game: milestone 2's frozen UTC days (`clock` `utc`, without hearts), then the school's days | 2,500 lines, at most 30 days |
| `pcs` | PC code with play in the period | 2,500 codes, by code |

`students` and `student_days` (schema 4's per-student files) are gone: asking for one is
`400 {"error": "file"}`.

Columns, in their pinned order:

| `file` | Columns |
|---|---|
| `sessions` | session, pc, wire_version, day, weekday, start_time, minute_of_day, start_utc, clock_source, mode, build, cores, memory_gb, screen, games_opened, rounds, engaged_s, end_t_s, end_reason, timer_minutes, timer_ended |
| `visits` | session, visit, day, open_time, open_s, close_s, open_seconds, engaged_s, game, source, plays_before, plays_before_bucket, favourite_at_open, load_ms, error, rounds_started, rounds_ended, tutorial, hearts_on, hearts_off, il_lt8, il_lt16, il_lt33, il_lt50, il_lt100, il_ge100, frames_smooth, frames_ok, frames_choppy, frames_stall, closed, previous_game, next_game |
| `rounds` | session, visit, round, pc, day, weekday, time, start_s, minutes_into_session, game, level, outcome, previous_outcome, two_player, replay_in_session, engaged_ms, wall_ms, score, tier_start, tier_end, dda_level, hits, misses, accuracy, rt_lt300, rt_lt500, rt_lt800, rt_lt1200, rt_lt2000, rt_ge2000, rt_mean_ms, rt_n, inputs, inputs_per_min, idle_lapses, pauses |
| `events` | session, day, time, t_s, kind, game, value |
| `daily_games` | day, clock, game, sessions, opens, minutes, starts, ends, wins, losses, draws, ends_neutral, quits, hearts_on, hearts_off, avg_tier, accuracy |
| `pcs` | pc, pc_label, first_day, last_day, days, time_zone, build, cores, memory_gb, screen, sessions, minutes, smooth_share, stall_share, avg_load_ms, slow_input_share, failures |

Words: `clock_source` `w` (from the PC's elapsed seconds), `r` (from the receipt time);
`end_reason` `unload`, `switch` (a new session started on the page, older portals),
`handover`, `idle`; `error` `timeout`, `script`, `load`; `outcome` and `previous_outcome`
`win`, `loss`, `draw`, `end`, `quit`, empty for a round not ended; `tutorial` `none`,
`start`, `done`; `kind` (events) `heart_on`, `heart_off`, `tutorial_start`,
`tutorial_done`, `timer_start`, `timer_cancel`, `timer_end`, with `value` the timer's
minutes for `timer_start`. Flags are `0` or `1`.

#### `POST /v1/admin/rebuild`

Body `{}`: every rolled day since `factsSince` (and not trimmed by the storage guard)
waits to be counted again; the 5-minute cron recounts one day at a time, newest first,
with the diff re-roll (only the rows that change are written, and rows left without
facts are deleted, so a recount writes only what changed where a full rebuild would write
every row twice), within the day's read and write allowance.
Answers `{"pending": <days waiting>}`.

## Operations

* **Backup.** Cloudflare: D1 can restore the database to any minute of the last 7 days
  on the free plan (*Time Travel*). Node: the
  database is one file plus its write-ahead log; take a consistent copy while the server
  runs with SQLite's `VACUUM INTO`, for example nightly from cron:
  `sqlite3 /var/lib/sg-telemetry/telemetry.db "VACUUM INTO '/backups/telemetry-$(date +%F).db'"`,
  or without the `sqlite3` tool:
  `node --no-warnings -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec(\"VACUUM INTO '\" + process.argv[2] + \"'\")" telemetry.db backup.db`.
  Keep backups no longer than `RETENTION_DAYS` (they are copies of the same data) and
  encrypt them at rest. To restore, stop the server and replace the file (delete stale
  `-wal`/`-shm` files).
* **Retention.** The daily purge deletes, by the school's local day, the facts of the
  sessions that started more than `keep` days ago (`keep_days` chosen on the dashboard,
  else `RETENTION_DAYS`), at most 600 sessions a night (about 15,000 rows written; more
  than a busy school's day, and the 5-minute cron deletes the rest when the day's writes
  leave room, so a shorter retention reaches its cutoff within days, never in one
  batch), and moves `facts_since` on with them (to the day after the newest
  session deleted, and to the cutoff once none older is left); the frozen daily totals of
  milestone 2 by UTC receipt day after `keep` days, a week of them a night
  (`legacy_until` is cleared once the last one goes); batch ids after 30 days, the usage counts after 60
  days, kept KPI parts of an older rollup version, and live rows once they leave the
  5-minute window (by the next batch or live query, and by a sweep every 5 minutes on
  Cloudflare and every minute on Node, so within 10 minutes even with no traffic). The
  rollups and their `roll_days` rows go after the larger of 800 days and `keep`, a day
  at a time, deleted by the 5-minute cron when it has no day to roll (so the daily purge
  stays within D1's statement limit); the daily purge deletes the PCs last seen before
  that cutoff. Lowering the retention starts at the next purge
  (Node: the next start). To erase everything on Node, stop the server and delete the database
  files; on Cloudflare, delete the Worker and its D1 database `school-games-telemetry`
  in the Cloudflare dashboard.
* **Storage guard.** When the database passes 425 MB at the daily purge, the round rows
  of the oldest 30 days of facts are to go (sessions, visits and every rollup stay, so
  charts keep working): the purge sets `trim_to`, and the 5-minute cron deletes them 800
  sessions a run (about 9,000 rows) when it has no day to roll and the day's writes leave
  room, moving `trimmed_before` on; the next trim waits until the file has grown again
  (SQLite reuses the freed space first). Days before `trimmed_before` are never rebuilt
  for a new zone. Download the research files each term.
* **Rollups.** Every 5 minutes (Node: at start and every 5 minutes) the cron rolls at most
  one of the school's local days into the `r_*` tables: first the oldest day not rolled
  yet (yesterday from 01:00 at the school; only one instance can make that roll), then a
  day waiting for a full rebuild after a change of zone (newest first), then a day that
  late batches reached (at most once an hour per day), then a day waiting for a recount
  (newest first). A day still running on the school's clock is never rolled again. After
  yesterday's roll, the PCs seen in the last 14 days vote for the school's zone. A
  rebuild, a re-roll, a recount or a catch-up deletion starts only while the day's reads
  stay under 3 million (2 million by re-rolls) and the day's writes, plus its estimate
  (twice the rows the day's rollups took for a full rebuild, those rows for a diff),
  plus 40,000 for the rest of a school day's batches, roll and purge, stay at or under
  85,000; otherwise it waits, if need be for the next UTC day. A full rebuild of a busy
  school's day writes about 16,000 rows (its 8,000 rollup rows deleted and written
  again), so at most two run in a UTC day: a zone change at a busy school rebuilds about
  two days a day, and never brings the day near D1's 100,000. Each roll raises the rollup
  version, so the dashboard's kept answers are made again. With no day to roll, the cron
  first finishes the upgrade's clearing of what schema 4 kept per child (see
  [This update: schema 5](#this-update-schema-5-no-accounts-or-ages)), then the deletions
  past retention and the storage guard's trim.
* **Monitoring.** `GET /v1/health`. The Node process exits when it cannot start (port in
  use, unreadable database), so the supervisor (Docker, systemd) reports or restarts it.
  On Cloudflare, the Worker's *Metrics* tab shows requests and errors without logs.
* **Upgrades.** The store creates and upgrades its tables itself (`CREATE TABLE IF NOT
  EXISTS`, the schema version in the `meta` table), so a deploy has no migration step.
  It goes one version step per request: on Cloudflare the first request after a deploy
  that needs a step does only that step and is answered `503` with `Retry-After: 2` (a
  daily or 5-minute cron that meets it does nothing else either); the Node host takes
  every step at start. Schema 4 becomes schema 5 in one step (the per-student tables and
  rollups dropped, the marks of removed profiles and older codes deleted, `live` made again
  without the student code, the clearing started; see
  [This update: schema 5](#this-update-schema-5-no-accounts-or-ages)). Schema 3
  (milestone 2) becomes schema 5 in one step too: the facts, settings and rollup tables
  are added, `seen` is dropped, `live` is made again, and the daily totals stay, read
  only, for the days up to the update (their age-band rows are cleared by the cron like
  schema 4's). A database of the first server (one table per event kind) is folded into
  the daily totals first (schema 3, with its `user_version` raised so the first server
  refuses it) and becomes schema 5 on the next request. A server refuses a database newer
  than itself, so going back means D1 *Time Travel* (7 days) to just before the deploy,
  then deploying the older server.
* **Size and cost.** Measured on the Node driver, which bills a written row once for its
  table and once for each secondary index, as D1 does: about 4.4 rows a batch on average
  (the facts, the PC row, the live row and the usage meter), a batch of 200 events one
  row per visit and round plus 2. A batch takes at most 20 statements, and the request that upgrades the database
  at most 45 (D1 allows 50 per request). The other invocations' worst cases are in
  [Free-plan arithmetic](#free-plan-arithmetic), with the rows and bytes of a busy
  school.

### Storage

Schema 5 (`docs/RESEARCH_TELEMETRY_SPEC.md`, "Storage on D1", has the exact columns,
without its per-student tables):

| Tables | What they hold |
|---|---|
| `st_sessions` | One row per play session: its code `s`, the PC code `p` (`''` when unknown), wire version, build, mode, device buckets, start (`start_s`, with `clock` `w` from the PC's elapsed seconds or `r` estimated from the receipt time; never before the first day of the facts, so a v2 tab open across the deploy counts on the deploy day), the PC's zone, how it ended, and the server's numbering state for v2. Indexed by start. Schema 4's columns `u` and `a` (always `''`) and `is_new`, `age_days`, `since_days`, `age_b`, `since_b`, `level0`, `np` and `cls` (always `NULL`) stay in the table, empty. |
| `st_visits`, `st_rounds`, `st_marks` | Game visits `(session, n)`, rounds `(session, n, k)` with their outcome, tier, score, hits, misses, reaction times and extras and the two-player flag (schema 4's `attempt` stays, always `NULL`), and marks (hearts, tutorial steps, the classroom timer). |
| `st_pcs` | Per PC code: first and last play, zone, buckets, build. |
| `settings`, `usage`, `roll_days` | The school's zone and where it came from (and `tz_epoch`, raised with each change), the week start, the retention the owner chose, `facts_since`, `legacy_until`, `v3_since`, the rollup version `rv`, `rolled_through`, `trimmed_before`, and the cron's bookkeeping (`rebuild`: days may wait for a full rebuild or a recount; `trimmed_size` and `trim_to`: the storage guard's trim; `scrub`, `scrub_id`, `scrub_end` and `scrub_day`: how far the upgrade's clearing is); D1 rows read, written and read by rebuilds per UTC day, and the database size (each instance adds its counts once a minute, and each cron run its own); which local days are rolled up, whether late data (`dirty` 1), a new zone (2) or a recount (3) waits for them, when each was rolled and the rows its rollups took (`rows`, which a re-roll is estimated from). |
| `r_day`, `r_game_day`, `r_level_day`, `r_source_day`, `r_device_day`, `r_pc_day`, `r_stat` | Per-day rollups of the facts by the school's local day: milestone 2's daily totals with two-player rounds, hearts, tutorials and session endings; per game, level, launch source, device bucket and PC; and `r_stat`, the research metrics (hour of play, session length, games per session, visit length, game-to-game flows, what follows a round, tiredness, losses before quitting, tier, tutorials) per day and game. Their key column `a` (schema 4's age band) is always `''`, and their schema 4 count columns of students, guests, new profiles, linked minutes and profiles per PC are always `0`. |
| `live`, `batches`, `kpi_cache`, `meta` | Sessions in the 5-minute live window (with the PC code and wire version); v2 batch ids for de-duplication; kept parts of admin answers, with the rollup version they were made with; the schema version. |
| `agg_days`, `agg_games`, `agg_levels`, `agg_sources`, `agg_devices` | Only on a database milestone 2 used: its daily totals per UTC receipt day, frozen. |

Every table but `st_sessions` is `STRICT, WITHOUT ROWID`. The only index beyond the
primary keys is `st_sessions_time` (`r_stat` has none: every read of it finds its rows
by day, and an index by metric would add to its size). There are no other columns. The
empty schema 4 columns stay because dropping a column rewrites every row (D1 bills each
one) and `a` is part of the rollups' keys; a new database has them too, so a new and an
upgraded database read alike.

### Free-plan arithmetic

Measured on the Node driver, which bills a written row once for its table and once for
each index as D1 does, with the simulated school of `simulate.mjs`: 600 children in 24
classes on 30 PCs, about 435 play sessions a school day, 11.3 batches per version 3
session (60 s timer, and one when a game closes), 3.5 game visits, 11.3 rounds and 9.6
engaged minutes per session. Scaled to a busy school of 500 sessions a school day:

| Rows written per school day | Simulated school | 500 sessions |
|---|---|---|
| Batches: about 4.4 rows each (facts, PC rows, live rows, usage) | 21,500 | ≈ 24,700 |
| The night's first roll of the day: about 900 rollup rows, and the live sweep | 1,000 | ≈ 1,200 |
| Re-rolls of days that late batches reached | 50–100 each | ≈ 200 |
| **First year** | | **≈ 26,000 (26%)** |
| + the facts of a day deleted after 400 days (about 20 rows and index entries a session) | | + ≈ 10,000 |
| + the rollups of a day deleted after 800 days | | + ≈ 1,200 |
| **From the third year** | | **≈ 37,000 (37%)** |

The PCs are asked to send less often only past 60,000 rows written in a UTC day
(`X-Batch-Every`), which a school this busy does not reach. The daily limit of 100,000
stays far out of reach. (Schema 4, which also kept students, wrote about 40% more: about
31,000 rows a simulated day, and five times the rollup rows.)

| Storage | Measured | 500 sessions a school day |
|---|---|---|
| Facts | 0.94 KB a session | ≈ 105 MB for 400 days (about 220 school days) |
| Rollups | 0.07 MB a school day of 435 sessions, 72% of it `r_stat` | ≈ 18 MB a year of 220 school days |
| **After the first year** | | **≈ 125 MB (25%)** |

The rollups are kept 800 days (about 480 school days), so the database levels off at
about 145 MB, far under the storage guard (425 MB). A database upgraded from schema 4
keeps the size it had (SQLite reuses the space the upgrade frees before it grows). Read
costs cannot be measured on Node (`node:sqlite` reports the rows returned, not the rows
SQLite read): the spec (`docs/RESEARCH_TELEMETRY_SPEC.md`, "Budget math") estimates 0.6
to 1.2 million rows read on a typical day with the dashboard open, and 2.1 to 2.6
million more for a school year's export.

**Requests:** about 5,650 batches, 289 crons and about 1,500 dashboard calls a day; a
school year's export adds about 700 pages of 2,500 lines (most of them `rounds`,
`visits` and `events`). About 8% of the 100,000.

**Statements and CPU per invocation.** D1 allows 50 statements per invocation; this
server keeps an admin answer to 20, the 5-minute cron to 35 and the daily purge to 25.
D1 also limits each statement: 100 KB of SQL, 100 bound parameters, 32 arguments per SQL
function, 100 result columns and 5 terms per compound `SELECT` (workerd's local D1
refuses a sixth `UNION ALL` term). `sqlite-d1.mjs` refuses a statement past any of these
as D1 would, so every test runs inside them; the rollups nest their `UNION ALL` parts
four at a time, and a KPI row of more than 32 columns comes as an array of arrays.
The Workers free plan allows 10 ms of CPU per invocation (only CPU counts, not the time
waiting for D1). The CPU column is JavaScript's time outside SQLite (wall time less the
time in `db.batch`), plus what the Worker's D1 binding does with each batch (the request
as JSON, the response parsed in D1's rows-and-columns form and an object made per row):
the median of cold runs (a new instance, nothing kept) over 30 days of the simulated
school with 120 and with 470 sessions a school day, on a 2.1 GHz server core, measured
with schema 4 (schema 5's answers are the same or smaller):

| Invocation | Statements | CPU outside SQLite |
|---|---|---|
| `kpis` over frozen, rolled and open days | 13 | 5.2–5.5 ms |
| `game` | 7 | 1.7–2.3 ms |
| `stats` (every metric of every game) | 4 | 1.4–1.7 ms |
| `pcs` | 7 | 1.5 ms |
| `live`, `settings`, `POST settings` | 5, 2, 7 | under 0.1 ms |
| an `export` page (`rounds` or `visits`: 2,500 lines, about 410 KB) | 3 | 1.3–1.6 ms |
| an `export` page of `events` or `sessions` | 3 | 0.6–0.9 ms |
| `rebuild` | 5 | under 0.2 ms |
| the 5-minute cron's full rebuild of a day | 26 | |
| its first roll with the zone vote | 19 | |
| a run of the upgrade's clearing (500 sessions' facts, or a few days' rollups) | at most 35 | |
| the daily purge with frozen days and the storage guard | 24 | |
| the request that upgrades schema 4 to 5 | at most 45 | |

The statement counts include the settings re-read (every 5 minutes) and the usage flush
(once a minute) that an invocation may carry. The tests hold the admin answers to 5 ms
and an export page to 3 ms on this measure, with 120 sessions a day; runs differ by
about a millisecond, and the first request of a new process takes up to twice as long
while the JavaScript engine warms up. A kept answer costs about 0.6 ms; a `kpis` whose
rolled part is kept and whose open day is made again, about 4.4 ms. The answers are made
as JSON text by SQL and sent as they are: the Worker parses none of a kept part, and
writes kept parts to `kpi_cache` inside the same statements that read them.

## Development

* Tests: `npm test` (`node --test --test-concurrency=1 test/*.test.mjs`): `clock` (the
  school's clock), `rollups` (every rollup against a JavaScript oracle over the same
  facts, and the upgrade's clearing statements inside D1's limits), `facts` (the facts on
  the store and the research files' columns), `server` (the Node host on port 0 with a
  temporary database, every admin route, the removed routes, the upgrades from milestone
  2's schemas), `worker` (the Worker entry with real `Request`s on the Node driver, every
  invocation inside D1's limits) and `no-accounts` (an older portal's batch with a student code, an age band, profile fields
  and level-ups is accepted and nothing of it is stored; the removed routes answer `404`
  and the research files and the dashboard's dictionary have no student, band or profile
  column; the upgrade of a schema 4 database seeded with students, links, age bands and
  per-student rollups, made here and made by the schema 4 server from Git, leaves none of
  them and keeps every session, visit, round and rollup, inside D1's limits, and twice
  changes nothing more). One file: `node --test test/no-accounts.test.mjs`.
* The Workers runtime on your machine (no Cloudflare account needed): `npm install` in
  `server/`, put `ADMIN_TOKEN=...` in `server/.dev.vars` (ignored by Git), then
  `npx wrangler dev` (local D1 in `.wrangler/`). Add `--test-scheduled` and open
  `/__scheduled` to run the daily purge, or `/__scheduled?cron=*/5+*+*+*+*` for the
  rollups and the sweep of the live rows. `npx wrangler deploy --dry-run --outdir /tmp/out`
  bundles without deploying.
* Synthetic data for the dashboard: a simulated school in Asia/Riyadh (600 children in
  24 classes, a lab of 30 PCs, Sunday to Thursday; three PCs still on wire version 2,
  whose batches still carry an old portal's age band and profile fields, and one PC that
  gets a new code every night), sending at the portal sink's real cadence.
  `node simulate.mjs --url http://127.0.0.1:8787 [--sessions 300]` posts the sessions of
  the last half hour to a running server (same `--seed`, same batch ids, so a repeat adds
  nothing); `node simulate.mjs --db data/dev.db --days 28 [--sessions 120]` writes four
  weeks of history straight into a Node database file (stop the server first, or use
  another file) and rolls each day up with the store's own rollups, as the cron would.
  Every generated batch passes `schema.mjs`. `npm run demo` rebuilds the dashboard's
  sample data (`dashboard/demo/`) from it.
* A batch by hand: `curl -X POST -H 'Content-Type: text/plain' --data-binary
  @fixtures/sample-batch-v3.json http://127.0.0.1:8787/v1/batch` answers `204`.
