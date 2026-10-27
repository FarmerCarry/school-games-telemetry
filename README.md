# Play statistics server and insights dashboard

This folder is a small service that receives **anonymous** play statistics from the
games portal (the portal's telemetry sink, `js/telemetry.js`; see
[`docs/ARCHITECTURE.md`](https://github.com/FarmerCarry/school-games/blob/main/docs/ARCHITECTURE.md), "Telemetry sink" and "Milestone 2"),
keeps them as daily totals, and shows them on the insights dashboard at its own address.

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
   site on, and children's PCs start sending anonymous statistics.
9. **Open that address** in your browser to see the dashboard, and sign in with the
   password from step 5. Until children play, there is nothing to show; add `/?demo` to
   the address to see the dashboard with made-up sample data.

**It is free for a school.** Cloudflare's free plan allows 100,000 requests to the
server per day (a PC sends one about every game played; 120 play sessions send about
300; the server's own clean-up every 5 minutes adds about 300), and its free D1 database
allows 500 MB per database, 5 million rows read and 100,000 rows written per day. A
school day with 120 play sessions writes about 3,000 rows (a few percent of the
allowance) and keeps about 1 MB of totals per month. The first time each day the
dashboard shows a month it reads about 25,000 rows, and about 1,400 each time it
refreshes after that (a busy school with 500 play sessions a day: about 130,000 rows the
first time it shows 90 days).
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

The players are **children aged 6 to 11**. Even anonymous usage statistics about
children need the school's or district's **privacy review** and a **notice to
parents** before collection starts, under the rules that apply to you: for example
**COPPA** and **FERPA** in the United States, the **GDPR** with its rules for children's
data (often called GDPR-K) in the European Union, and the **UK GDPR with the Age
Appropriate Design Code** (Children's Code) in the United Kingdom. Give the reviewers
the "Privacy design" section below and the event list in `docs/ARCHITECTURE.md`, and
record who operates the server, where it runs and how long data is kept.

Even with the server on, a PC sends nothing while a teacher has stopped statistics on
it (the teacher page), and browsers that send Global Privacy Control never send anything.

## Files

| File | What it does |
|---|---|
| `worker.mjs` | Cloudflare entry: `fetch` (the handler on the D1 database `env.DB`, the dashboard from `env.ASSETS`) and `scheduled` (the daily purge, and the sweep of the live rows every 5 minutes). |
| `wrangler.json` | The Worker's settings: D1 binding `DB`, static assets `./dashboard`, two crons (the daily purge, and every 5 minutes the sweep of the live rows), `ALLOWED_ORIGINS` and `RETENTION_DAYS`, request logs (observability) off. |
| `package.json`, `package-lock.json` | Wrangler 4.149.0 for deploying (a development tool only), the plain-English descriptions the Deploy button shows, `npm start` for Node. |
| `.dev.vars.example` | Tells the Deploy button to ask for the `ADMIN_TOKEN` secret (empty on purpose). |
| `handler.mjs` | The HTTP rules as a Fetch-API handler, shared by both hosts: routes, CORS, the soft rate limit, body limits, admin password, status codes. |
| `store.mjs` | Daily aggregates over a D1-style SQL driver; creates and upgrades its tables itself; KPIs, live sessions, retention. |
| `schema.mjs` | Strict validation of the envelope and every event kind; cleans and clamps. |
| `sqlite-d1.mjs` | A D1-style driver over Node's built-in `node:sqlite`, for the Node host and the tests. |
| `app.mjs`, `main.mjs` | The Node host: `node:http` in front of the handler, settings from the environment, a purge every 24 hours. |
| `static.mjs` | The Node host's static file server for `dashboard/`, with the headers of `dashboard/_headers`. |
| `dashboard/` | The insights dashboard (static files), served at `/` by both hosts. `_headers` gives every page a strict Content-Security-Policy. |
| `warnings.mjs` | Hides Node 22's one `node:sqlite` ExperimentalWarning (and nothing else). |
| `simulate.mjs` | Deterministic synthetic sessions for dashboard development and tests. |
| `fixtures/sample-batch.json` | A valid envelope with every event kind (shared with the portal's tests). |
| `Dockerfile` | A minimal `node:22-alpine` image of the Node host. |

The folder is self-contained (it imports nothing from outside it), because the Deploy
button copies only this folder into a new repository.

## Privacy design

Privacy is built into what can be stored, not only into what the portal chooses to send.

* **No personal data.** The contract has no field for a name, typed text, error text,
  a PC label, a profile key, an avatar, a user-agent or a GPU string. The server
  validates every field against closed lists and patterns (`schema.mjs`) and drops
  anything else: unknown envelope fields are ignored, an event with an extra or a
  malformed field is dropped whole, and round ids that could be typed text (three
  digits in a row, spaces, more than 24 characters) are refused.
* **Totals, not events.** Events are never stored. A batch only adds to whole-number
  totals per UTC receipt day and age band (per game, level, launch source and device
  bucket). What a single child did cannot be read back.
* **Session ids for two days, batch ids for 30.** The session id is random per portal
  session and never reused. The server keeps it only in the `seen` table (to count
  distinct sessions per day) for today and yesterday, and in the `live` table while it
  is in the 5-minute live window (a sweep every 5 minutes deletes it within 10 minutes,
  also when no request comes). The batch id is random per batch and kept 30 days for
  de-duplication. Neither can link sessions of the same child. On the PC, unsent batches
  wait in localStorage (keys starting with `sg:site:tm:q`, at most 7 days and 128 KB).
* **No IP addresses and no headers are stored or logged.** The client address
  (`CF-Connecting-IP` on Cloudflare, the socket address or a trusted `X-Forwarded-For`
  hop on Node) is only a key of the in-memory rate limiter and is forgotten once its
  bucket has refilled. Requests and request bodies are never logged. On Cloudflare,
  Workers observability (stored request logs, which would hold IP addresses) is
  **off** in `wrangler.json`; keep it off. The only log lines are start-up and purge
  counts (Node) and internal error messages.
* **No wall-clock times from the client.** Events carry seconds since the session
  started and the server stores only the UTC **day** of receipt. The live view keeps
  the **minute** of each session's last batch, for at most 10 minutes.
* **Coarse buckets.** Devices are reported as cores (1, 2, 4, 8, 16), memory in GB
  (0, 1, 2, 4, 8) and screen width (1366, 1600, 1920, 2560); age as a band (6-7, 8-9,
  10-11 or unknown); profile age, days since last play and plays before as buckets;
  reaction times, input latency and frame times as fixed histograms.
* **Small-group suppression.** Every KPI group (a game, a level, an age band, a device
  bucket, a day, a launch source, live counts) with fewer than **3 distinct sessions**
  is returned as `{ ..., "suppressed": true }` with no numbers. Lists are sorted by
  their key, never by a hidden number. Suppression does not stop an administrator from
  subtracting narrower queries from wider ones; the dashboard password is for the
  people who operate the service, not for publishing raw results.
* **Retention.** Daily totals older than `RETENTION_DAYS` (default 180) are deleted by
  the daily purge (Cloudflare: a cron at 03:23 UTC; Node: at start and every 24 hours);
  live rows by a sweep every 5 minutes (Node: every minute).
  On Node, SQLite's `secure_delete` overwrites deleted rows and the write-ahead log is
  truncated after each purge.

## Self-hosting on Node

Node 22.13 or newer (where `node:sqlite` needs no flag); no `npm install` and no
runtime dependencies.

```sh
export ADMIN_TOKEN=$(openssl rand -hex 24)
node server/main.mjs &
# telemetry: listening on port 8787; 0 allowed origin(s), admin on, ...
curl -s localhost:8787/v1/health                    # {"ok":true}
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
| `RETENTION_DAYS` | `180` | Days of data to keep (1 to 36,500). |
| `RATE_PER_MIN` | `1200` | Requests per minute per client address (token bucket, bursts up to the same number). Generous because a whole school lab shares one NAT address. `0` turns the limit off. |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the server. With `1`, the client address for the rate limit is the last `X-Forwarded-For` entry (the one your proxy wrote); with `0` it is the socket address, so all traffic through a proxy shares one bucket. |

The server refuses to start on a malformed origin, a short admin token, a bad number,
or a database written by a newer version of the server.

On Cloudflare the same settings are `ALLOWED_ORIGINS` and `RETENTION_DAYS` (plain
variables in `wrangler.json`, default `https://farmercarry.github.io` and `180`),
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

* **This project:** once the owner reports the Worker's address, the developer commits
  it as `SG_TELEMETRY_URL` in `.github/workflows/build.yml`.
* **GitHub Pages in general:** in the repository, *Settings → Secrets and variables →
  Actions → Variables → New repository variable*, name `SG_TELEMETRY_URL`; delete it and
  rebuild to switch telemetry off.
* **A local build:** `SG_TELEMETRY_URL=https://telemetry.example.org/v1/batch node tools/build.mjs`.
* `ALLOWED_ORIGINS` must list the site's origin (on Cloudflare it already lists
  `https://farmercarry.github.io`).

## API

Every API response (paths under `/v1/`) has `Vary: Origin`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and, for an origin in `ALLOWED_ORIGINS`,
`Access-Control-Allow-Origin: <that origin>` and `Access-Control-Expose-Headers:
Retry-After`. Credentials are never allowed. Error bodies are `{"error": "<short
reason>"}` and never echo the request. Every request that reaches the server (including
`OPTIONS`, health checks and, on Node, dashboard files) takes a token from the client's
rate-limit bucket; an empty bucket answers `429` with `Retry-After` in seconds.

### `GET /` and other paths outside `/v1/`

The dashboard's static files from `dashboard/` (`GET` and `HEAD` only; anything else,
and missing files, are `404`). On Cloudflare, Workers static assets serve them; on Node,
`static.mjs` serves only regular files inside the folder (no dot files, no `_headers`,
no path outside it). Both send the headers in `dashboard/_headers`: a
Content-Security-Policy (`default-src 'self'`; scripts also from
`https://farmercarry.github.io` for the live game names), `X-Content-Type-Options:
nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` for the page.

### `POST /v1/batch`

The body is the telemetry envelope as JSON, sent as `text/plain` (a CORS "simple
request" without a preflight) or `application/json`. See `fixtures/sample-batch.json`
and `docs/ARCHITECTURE.md`.

| Status | When |
|---|---|
| `204` | Stored, or a batch id already received (repeats are answered the same, so the client drops them). Unknown event kinds and malformed events are dropped silently; the rest of the batch is kept. |
| `400` | Not JSON, or an invalid envelope: `v` is not `2`; `b` is not 16 lowercase hex; `s` is not 12 lowercase hex; `k` is not `src` or exactly 16 lowercase hex; `m` is not `web`/`app`; `a` is not `6-7`/`8-9`/`10-11`/`''`; `d` is not `[cores, memoryGB, screenWidth]` from the bucket lists; `ev` is not an array of at most 200 entries. |
| `403` | The request has an `Origin` header that is not in `ALLOWED_ORIGINS`. Requests without `Origin` (tools, `simulate.mjs`) are accepted. |
| `413` | The body is over 64 KB (65,536 bytes), declared or streamed. |
| `415` | Another content type. |
| `429` | Rate limited. |

Event validation (exact length; every field must pass):

| Event | Fields after the kind |
|---|---|
| `ss` | `t`, isNew `0`/`1`, profile age `0`–`3`, days since last `0`–`4`, level ≥ 0 |
| `go` | `t`, slug, source (`featured catalog recent favorites category quick search related surprise reload history direct starter`), plays before `0`–`4` |
| `ld` | `t`, slug, load ms |
| `er` | `t`, slug, kind `t`/`x`/`l` |
| `rs` | `t`, slug, round id, tier `0`–`9`, replay index |
| `re` | `t`, slug, code `w`/`l`/`d`/`e`/`q`, round id, ms, score (`-1` or ≥ 0), tier `0`–`9`, hits, misses, `rt[6]` |
| `gx` | `t`, slug, engaged ms, `il[6]`, `f[4]` |
| `lv` | `t`, level ≥ 1 |
| `se` | `t`, engaged ms |

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

`200 {"ok": true}`.

### Admin endpoints

`GET /v1/admin/kpis` and `GET /v1/admin/live` need `Authorization: Bearer <ADMIN_TOKEN>`
(compared in constant time). Without a valid token: `401` with
`WWW-Authenticate: Bearer`. With no valid `ADMIN_TOKEN` set: `404
{"error": "admin password not set"}` (the dashboard shows this as "the password was
not set").

#### `GET /v1/admin/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD&band=6-7`

Receipt days `from`..`to` (UTC, inclusive, at most 366 days; default: the 30 days
ending today). `band` is `all` (default), `6-7`, `8-9`, `10-11` or `unknown`.
Invalid parameters: `400`.

Conventions:

* A **group** is an object with its key fields and `sessions`, the number of distinct
  sessions in it (for games this is the brief's "unique sessions"). A group with 1 or
  2 sessions is only `{ <key fields>, "suppressed": true }`; a group with 0 sessions
  and nothing stored keeps its zeros. Check `suppressed` before reading numbers.
* **Sessions are counted per day:** a range's sessions are the sum of its days' distinct
  sessions, so a session that crosses midnight UTC (rare) counts on both days.
* Rates and shares are 0..1 with 4 decimals and `null` when the denominator is 0.
  Minutes have 1 decimal (`avgEngagedMinutesPerSession` 2), seconds 1, tiers 2,
  milliseconds are whole.
* Days are receipt days: a batch kept offline and delivered later counts on the day it
  arrived. Engaged time comes from game-close (`gx`) events; a visit that never closed
  adds rounds but no engaged time.
* Histograms: `rt` reaction time `<300, <500, <800, <1200, <2000, ≥2000` ms; `il` input
  latency `<8, <16, <33, <50, <100, ≥100` ms; frames `smooth ≤20, ok ≤34, choppy ≤250,
  stall >250` ms; `replayIndex` `0, 1, 2, 3–4, 5–9, 10+` prior starts of the same round
  in the session; `playsBefore` `0, 1, 2–4, 5–9, 10+` visits before; `profileAge` new,
  1–6, 7–29, 30+ days; `daysSinceLast` same day, 1, 2–6, 7+, first time.
* Round codes: `w` win, `l` loss, `d` draw, `e` neutral end (endless runs, two-player
  modes), `q` quit. Endless games end with `e`, so their completion rate is 0 and
  their win rate `null`: read `rounds.codes` and `dropOffRate` for them.
* A device bucket counts a session under the buckets of its first batch of the day.

```jsonc
{
  "v": 1,
  "range": { "from": "2026-10-01", "to": "2026-10-26", "days": 26, "band": "all" },  // band: all | 6-7 | 8-9 | 10-11 | unknown
  "minSessions": 3,
  "totals": {                                  // or { "suppressed": true }
    "sessions": 2560,                          // distinct sessions with a stored event, per day
    "engagedMinutes": 22692.6,                 // sum of gx engaged ms
    "avgEngagedMinutesPerSession": 8.86,
    "gameOpens": 6419, "roundsStarted": 27938, "roundsEnded": 27938, "levelUps": 2580, "errors": 147,
    "players": {                               // from session-start events
      "sessionStarts": 2560, "newProfiles": 283, "guests": 531,   // guests: level 0
      "profileAge": [814, 554, 577, 615],
      "daysSinceLast": [432, 439, 462, 413, 814]
    }
  },
  "daily": [                                   // every day of the range, oldest first
    { "day": "2026-10-23", "sessions": 120, "engagedMinutes": 1117.5, "opens": 320 },
    { "day": "2026-10-24", "suppressed": true }
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
      "replay": { "replayIndex": [1632, 327, 76, 35, 3, 0], "playsBefore": [379, 26, 27, 32, 29] }
    },
    { "slug": "tank-splat", "suppressed": true }
  ],
  "levels": [                                  // per (slug, round id), sorted by slug then id (L2 before L10)
    { "slug": "air-hockey", "id": "L1", "sessions": 126, "starts": 248, "ends": 248,
      "codes": { "w": 111, "l": 107, "d": 0, "e": 0, "q": 30 },
      "completionRate": 0.4476, "winRate": 0.5092, "dropOffRate": 0.121, "avgMs": 78585, "avgTier": null },
    { "slug": "air-hockey", "id": "L9", "suppressed": true }
  ],
  "bands": [                                   // 6-7, 8-9, 10-11, unknown (those with sessions)
    { "band": "6-7", "sessions": 739, "opens": 1825, "engagedMinutes": 5120.4,
      "games": [                               // age-band preferences, sorted by slug
        { "slug": "bubble-bop", "sessions": 136, "opens": 143,
          "share": 0.0784,                     // this game's share of the band's opens
          "avgTier": 1.48, "completionRate": 0.6432,
          "winRate": 0.8411, "dropOffRate": 0.1203, "engagedMinutes": 210.4, "starts": 812 },  // added in milestone 2
        { "slug": "dino-3d", "suppressed": true }
      ] },
    { "band": "unknown", "suppressed": true }
  ],
  "sources": [                                 // launch sources over all games, in the contract's order
    { "src": "featured", "sessions": 1013, "opens": 1242 },
    { "src": "history", "suppressed": true }
  ],
  "devices": {                                 // each dimension separately, sorted by value
    "cores":  [ { "value": 2, "sessions": 617,
                  "frames": { "counts": [15436271, 2715746, 676173, 35793], "smoothShare": 0.8183, "stallShare": 0.0019 },
                  "il": [75877, 88713, 50563, 20262, 12608, 5099], "avgLoadMs": 1757 } ],
    "memory": [ { "value": 0, "suppressed": true } ],
    "screen": [ ... ]
  },
  "modes": [ { "mode": "web", "sessions": 2180 }, { "mode": "app", "sessions": 380 } ]  // app = installed PWA
}
```

#### `GET /v1/admin/live`

Sessions whose last batch arrived in the current minute or the four before it (300 s
at minute resolution), and the game each one has open (opened with `go` and not yet
closed with `gx`; `se` closes everything; a session forgotten after 5 quiet minutes has
nothing open). A batch delivered late from a PC's offline queue counts as a sign of
life when it arrives; a repeated batch does not.

```json
{ "v": 1, "windowSec": 300, "minSessions": 3,
  "total": { "sessions": 80 },
  "games": [ { "slug": "dino-3d", "sessions": 3 }, { "slug": "block-burst", "suppressed": true } ] }
```

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
* **Retention.** Daily totals are deleted by receipt day by the daily purge; batch ids
  after 30 days, `seen` session ids after yesterday, the kept KPI rows (`kpi_cache`) at
  every daily purge, and live rows once they leave the 5-minute window (by the next batch
  or live query, and by a sweep every 5 minutes on Cloudflare and every minute on Node,
  so within 10 minutes even with no traffic). Lowering `RETENTION_DAYS` takes effect at
  the next purge (Node: the next start). To erase everything on Node, stop the server and
  delete the database files; on Cloudflare, delete the Worker and its D1 database
  `school-games-telemetry` in the Cloudflare dashboard.
* **Monitoring.** `GET /v1/health`. The Node process exits when it cannot start (port in
  use, unreadable database), so the supervisor (Docker, systemd) reports or restarts it.
  On Cloudflare, the Worker's *Metrics* tab shows requests and errors without logs.
* **Upgrades.** The store creates and upgrades its tables itself on first use (`CREATE
  TABLE IF NOT EXISTS`, the schema version in the `meta` table), so a deploy has no
  migration step. A database of the first server (one table per event kind) is folded
  into the daily totals on first use, its event tables are dropped, and its
  `user_version` is raised so the first server refuses it. A server refuses a database
  newer than itself.
* **Size and cost.** Measured with `simulate.mjs` (120 sessions per weekday, a sixth
  at weekends, 30 days, 9,105 batches): a batch is one transaction that writes 10.5 rows
  on average (median 11, 95th percentile 19) and reads about 16, so a month writes about
  96,000 rows and keeps about 1 MB of totals; a batch of 200 events over one game writes
  about 30 rows. A KPI query reads the aggregate rows of its days (about 500 per school
  day, 12,800 for the month; D1 counts 25,000 rows read for a 30-day query, twice the
  rows because of the grouping). Days before yesterday never change, so their KPI rows
  are read once per period and day: they are kept in `kpi_cache` (for every instance,
  until the next daily purge) and in each instance's memory for an hour, and any later
  query reads only the last two days (about 1,400 rows). A busy school (500 sessions per
  weekday, 90 days) writes about 17,000 rows per weekday, and a first 90-day query reads
  about 130,000 rows. JavaScript time per request in Node: 0.06 ms per batch and about
  1.3 ms per 30- or 90-day KPI query (about 3 ms for the busy school; 3 ms for a
  200-event batch over 100 games), plus SQLite's own work (0.2 ms per batch, 4 to 20 ms
  per KPI query), which on Cloudflare D1 does outside the Worker.

### Storage

`batches (b, day)` for de-duplication; `seen (day, kind, key, s)`, which sessions were
already counted today in a group (`d` the day, `g` a game, `l` a level, `s` a launch
source); `live (s, slug, seen_minute)`; `meta (key, value)` with the schema version;
`kpi_cache (key, made, rows)`, the KPI rows (sums per group as JSON, no session id) of
the closed days of a requested period, emptied by every daily purge; and five daily
aggregate tables, each keyed by `day` and band `a`:

| Table | Key after (day, a) | Sums |
|---|---|---|
| `agg_days` | | sessions (and per mode `web`, `app`), engaged ms, opens, round starts and ends, level-ups, errors, session starts, new profiles, guests, profile-age and days-since-last buckets |
| `agg_games` | `slug` | sessions, opens, closes, engaged ms, round starts and ends, codes `w l d e q`, tier sum and count, hits, misses, `rt0..5`, `il0..5`, `f0..3`, loads and load ms, errors per kind, opens per launch source, replay and plays-before buckets |
| `agg_levels` | `slug`, `id` | sessions, starts, ends, codes, round ms, tier sum and count |
| `agg_sources` | `src` | sessions, opens |
| `agg_devices` | `cores`, `mem`, `screen` | sessions, `f0..3`, `il0..5`, loads and load ms |

All tables are `STRICT, WITHOUT ROWID` with no other index, so a write is one row. There
are no other columns.

## Development

* Tests: `node --test --test-reporter=spec tools/tests/telemetry-server.test.mjs
  tools/tests/telemetry-worker.test.mjs` (the Node host on port 0 with a temporary
  database; the Worker entry with real `Request`s on the Node driver; and a comparison
  with the first server's store from Git, skipped when that commit is not checked out).
* The Workers runtime on your machine (no Cloudflare account needed): `npm install` in
  `server/`, put `ADMIN_TOKEN=...` in `server/.dev.vars` (ignored by Git), then
  `npx wrangler dev` (local D1 in `.wrangler/`). Add `--test-scheduled` and open
  `/__scheduled` to run the daily purge, or `/__scheduled?cron=*/5+*+*+*+*` for the
  sweep of the live rows. `npx wrangler deploy --dry-run --outdir /tmp/out`
  bundles without deploying.
* Synthetic data for the dashboard: `node server/simulate.mjs --url http://127.0.0.1:8787`
  posts deterministic sessions (same `--seed`, same batch ids, so a repeat adds nothing);
  `node server/simulate.mjs --db server/data/dev.db --days 28` writes four weeks of
  history straight into a Node database file. Every generated batch passes `schema.mjs`.
