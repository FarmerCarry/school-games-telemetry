# Insights dashboard

Static files served at `/` of the ingest server (Cloudflare Worker or Node), next to the
data and outside the children's site. No build, no libraries, no inline script: the
page runs under `default-src 'self'; script-src 'self'; …`.

Play is anonymous: the server keeps sessions, game visits and rounds per PC and never who
played, so every page counts play (sessions, minutes, opens, rounds, tries), never children.
There are no student pages, no age groups and no player counts.

| File | What it does |
|---|---|
| `index.html` | The page shell. |
| `app.js` | The shell: sign in, the hash router and tab bar, the filter row, loading (`request()`, demo mode), timers, the school's clock line, and the Overview. |
| `games.js`, `habits.js`, `pcs.js`, `data.js` | One tab each (`window.SGTabs.<name> = { load, render }`); `games.js` also draws a game's page; `data.js` is the Data & settings tab (the research files, the data dictionary, the settings, the meters and the data quality). |
| `insights.js` | Pure rules (no DOM): rankings, the difficulty check, the small-sample flag, the insight sentences and the research sentences in both languages, number formats. `window.SGInsights`; Node loads it as a plain script. |
| `research.js` | Pure maths (no DOM, no clock): weeks on the school's first weekday, r_stat sums and measures, quantiles from histograms, persistence, flows, categories, the PC rows, labels. `window.SGResearch`. |
| `dictionary.js` | The research files' data dictionary: every column of every file of the download in its pinned order (the server's files list exactly `COLUMNS` of `export.mjs`, which `test/no-accounts.test.mjs` checks), with type, unit, values, meaning in English and Arabic, source and the games that fill it; the validity notes; and the files the browser writes from them (`dictionary.csv`, `games.csv`, `README.txt`, `labels.sps`, `load.R`). `node dashboard/dictionary.js --md` writes the researchers' guide. `window.SGDictionary`. |
| `zip.js` | ZIP files from Blobs: the CRC and headers of the site's `js/teacher.js` `zip()` (copied, so the server stays self-contained), a CRC that streams, and deflate through `CompressionStream('deflate-raw')` where the browser has it (stored entries otherwise). `window.SGZip`. |
| `export.js` | The research download: every page of each server file, its header and byte-order mark, `rounds.csv` split by month past 500,000 rows, the cost estimate, and part 2 after the reading guard. `window.SGExport`. |
| `charts.js` | Inline-SVG line charts (also step lines), bar lists, columns (histograms and stacked columns), small multiples on one scale, sparklines, dumbbells and stacked rows; HTML heatmaps and calendar strips; the tooltip and the table twin. |
| `i18n.js` | Every word of the page in Arabic and English. |
| `style.css` | Light and dark colour roles (validated dataviz palette, the sequential `--q1..--q5` and ordinal `--o1..--o4` ramps), layout down to 360 px. |
| `names.js` | Every game's Arabic and English name, categories, players and input style from the site's `js/catalog.js`, whether its own code adapts the difficulty, counts hits and reaction times or shows a tutorial (`games/<slug>/`), and the category names. |
| `scores.js` | What the score means in each of the 28 games that pass one (hand-written). |
| `demo/` | `/?demo`: the real server's answers for every request the sample makes (the KPIs and the research metrics per period, playing now, the settings, the PCs and six games' pages) and this morning's lines of each research file (`export-<file>.csv`), fetched lazily; about 340 KB. |
| `make-demo.mjs` | Rebuilds `demo/`: `npm run demo` (`node dashboard/make-demo.mjs`). `simulate.mjs`'s school plays 90 days (50 sessions a school day) into a database in memory, the store rolls each night up, and the real Node server answers at a pinned clock (Tuesday 27 October 2026, 10:40 at the school), so the files are the same on every run: run it after a change to the server's answers or the catalog. Not deployed (`.assetsignore`). |
| `make-names.mjs` | Rebuilds `names.js` after a game is added or renamed: `node dashboard/make-names.mjs`. Not deployed. |

* **Pages** (hash routes): `#/overview` (the default), `#/games` and `#/game/<slug>`,
  `#/habits`, `#/pcs`, `#/data`. Each page asks for its endpoints only when it is opened
  (and on Refresh); the last tab and period are remembered in this browser. An old link
  to a page that no longer exists opens the Overview.
  * **Overview:** what stands out, the headline numbers (play sessions, play time, minutes
    per session, games opened, rounds finished, playing now), sessions and minutes per day,
    when the school plays (weekday by hour), favourite games and categories, where children
    get stuck, the difficulty check, coming back to a game, PC health.
  * **Games:** a card per game, then trying again after a loss, tiredness (win rate and
    accuracy by minutes into the session) and reaction times over every game; a game's page
    has its tiles, opens per day, level by level, difficulty and win rate by tier, what
    came after a round, tiredness, where it was opened from, its score and its PC health.
  * **Habits:** when the school plays, session length (the old version on the same scale),
    games per session, game-to-game moves and launch sources.
  * **PCs:** each PC (sessions, minutes, smoothness, loading, slow responses, failures,
    version, flags), play per PC and health per kind of PC.
  * **Data & settings:** the research files, the data dictionary, the school's clock, the
    first weekday, how long data is kept, a full recount, the free plan's meters (with the
    upgrade's progress while it tidies the days kept before it) and the data quality.
* **Filters:** the period (today, 7, 30 or 90 days, this school year from 1 August, or two
  dates at most 366 days apart), and the game on a game's page.
* **Password:** the `ADMIN_TOKEN` of the server, kept in that browser's `localStorage`
  (`sg:dash:token`) until "Sign out". 401 says the password is wrong, 404 explains how to
  set it (an endpoint the server lacks says the server needs updating instead), a
  network error says the server cannot be reached.
* **Refresh:** the Overview's numbers every 5 minutes and "playing now" every 30 seconds,
  both paused while the tab is hidden. An unchanged answer keeps the page.
* **Days** follow the school's clock that every admin answer carries (`clock.today` is
  "today"); after sign-in, while the server knows no zone, the page offers this browser's
  zone once (`POST /v1/admin/settings {tz, source: 'dashboard'}`), and the clock line's
  Change sends the owner's choice. Charts built from `/v1/admin/stats` include play up to
  last night.
* **Research files** (Data & settings): the period's rows as `school-games-data_<from>_<to>.zip`:
  `sessions.csv`, `visits.csv`, `rounds.csv`, `events.csv`, `daily_games.csv` and `pcs.csv`
  from `GET /v1/admin/export` (pages of at most 2,500 lines; the page adds the header from
  `dictionary.js` and a byte-order mark), plus `games.csv`, `dictionary.csv`, `README.txt`
  (English and Arabic), `labels.sps` (SPSS) and `load.R` (R). No file has a column for a
  child, a profile or an age. The tab first says what it costs ("About 2.4 million rows:
  about 48% of today's free reading allowance": the rows the export's lookups read, counted
  per file from the period's KPIs), then shows a progress bar. If the server's reading guard
  stops it (429 "reads"), the files so far are part 1 and the browser remembers where it
  stopped (`sg:dash:export`), so the next part goes on from there the next day; no row is in
  two parts, but the parts are made on different days, which each part's `README.txt`
  explains. In the sample, the files are `demo/export-*.csv`.
* **The update day:** a period that reaches back to the days the server kept as milestone 2's
  daily totals (`range.legacyUntil`) says so above every page. Its hours, levels and the
  charts of each game start on `range.factsSince`.
* **Nothing is hidden:** every group is shown with its numbers, even one session. A number
  based on fewer than 20 tries carries a "based on 12 tries" chip; a difficulty verdict on
  10 to 19 tries is an early sign. There are no names, ranks or medals.
* **Game names** come from `names.js` (bundled, same origin), written from the games
  site's `js/catalog.js` by `make-names.mjs`; only a game added after the server was last
  deployed shows its slug. No script from another site runs on the page (the CSP's
  `script-src` is `'self'`): it could read the stored password.
* **Development:** `?api=http://127.0.0.1:8787` points the page at another server, only
  while the page itself is opened from `localhost` (the password never leaves for a
  crafted link). The rules and thresholds are documented at the top of `insights.js` and
  `research.js`.
