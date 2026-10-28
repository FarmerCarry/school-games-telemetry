# Insights dashboard

Static files served at `/` of the ingest server (Cloudflare Worker or Node), next to the
data and outside the children's site. No build, no libraries, no inline script: the
page runs under `default-src 'self'; script-src 'self'; …`.

| File | What it does |
|---|---|
| `index.html` | The page shell. |
| `app.js` | The shell: sign in, the hash router and tab bar, the filter row, loading (`request()`, demo mode), timers, the school's clock line, and the Overview. |
| `students.js`, `games.js`, `habits.js`, `learning.js`, `pcs.js`, `data.js` | One tab each (`window.SGTabs.<name> = { load, render }`); `students.js` also draws a student's page and `games.js` a game's page; `data.js` is the Data & settings tab (the research files, the data dictionary, the settings, one child's data, the meters and the data quality). |
| `insights.js` | Pure rules (no DOM): rankings, the difficulty check, the small-sample flag, the insight sentences and the research sentences in both languages, number formats. `window.SGInsights`; Node loads it as a plain script. |
| `research.js` | Pure maths (no DOM, no clock): weeks on the school's first weekday, r_stat sums and measures, quantiles from histograms, cohorts, paired same-student growth, persistence, categories, labels, the code search and the teacher page's check character. `window.SGResearch`. |
| `dictionary.js` | The research files' data dictionary: every column of every file of the download in its pinned order (the server's files list exactly `COLUMNS` of `server/export.mjs`), with type, unit, values, meaning in English and Arabic, source and the games that fill it; the validity notes; and the files the browser writes from them (`dictionary.csv`, `games.csv`, `README.txt`, `labels.sps`, `load.R`). `node server/dashboard/dictionary.js --md > docs/RESEARCH_DATA.md` writes the researchers' guide. `window.SGDictionary`. |
| `zip.js` | ZIP files from Blobs: the CRC and headers of `js/teacher.js` `zip()` (copied: `server/` stays self-contained), a CRC that streams, and deflate through `CompressionStream('deflate-raw')` where the browser has it (stored entries otherwise). `window.SGZip`. |
| `export.js` | The research download: every page of each server file, its header and byte-order mark, `rounds.csv` split by month past 500,000 rows, the cost estimate, and part 2 after the reading guard. `window.SGExport`. |
| `charts.js` | Inline-SVG line charts (also step lines), bar lists, columns (histograms, weekly and stacked columns), small multiples on one scale, sparklines, dumbbells and stacked rows; HTML heatmaps and calendar strips; the tooltip and the table twin. |
| `i18n.js` | Every word of the page in Arabic and English. |
| `style.css` | Light and dark colour roles (validated dataviz palette, the sequential `--q1..--q5` and ordinal `--o1..--o4` ramps), layout down to 360 px. |
| `names.js` | Every game's Arabic and English name, categories, players and input style from `js/catalog.js`, whether its own code adapts the difficulty, counts hits and reaction times or shows a tutorial (`games/<slug>/`), and the category names. |
| `scores.js` | What the score means in each of the 28 games that pass one (hand-written). |
| `demo/` | `/?demo`: the real server's answers for every request the sample makes (the KPIs per period and age group, playing now, the settings, the students, the research metrics, the cohorts, the PCs, three students' and six games' pages) and this morning's lines of each research file (`export-<file>.csv`), fetched lazily; at most 3 MB. |
| `make-demo.mjs` | Rebuilds `demo/`: `node server/dashboard/make-demo.mjs`. `server/simulate.mjs`'s school plays 90 days (50 sessions a school day) into a database in memory, the store rolls each night up, and the real Node server answers at a pinned clock (Tuesday 27 October 2026, 10:40 at the school), so the files are the same on every run. `dashboard-insights.test.mjs` runs it again and fails while `demo/` differs: run it after a change to the server's answers or the catalog. Not deployed (`.assetsignore`). |
| `make-names.mjs` | Rebuilds `names.js` after a game is added or renamed: `node server/dashboard/make-names.mjs`. Not deployed. |

* **Pages** (hash routes): `#/overview` (the default), `#/students` and `#/student/<code>`,
  `#/games` and `#/game/<slug>`, `#/habits`, `#/learning`, `#/pcs`, `#/data`. Each page
  asks for its endpoints only when it is opened (and on Refresh); the last tab and period
  are remembered in this browser.
* **Filters:** the period (today, 7, 30 or 90 days, this school year from 1 August, or two
  dates at most 366 days apart), the age group (with "Not set"), the game on the Learning
  tab and a game's page, and a code search (4 to 13 letters and digits) on the Students tab.
* **Password:** the `ADMIN_TOKEN` of the server, kept in that browser's `localStorage`
  (`sg:dash:token`) until "Sign out". 401 says the password is wrong, 404 explains how to
  set it (an endpoint an older server lacks says the server needs updating instead), a
  network error says the server cannot be reached.
* **Refresh:** the Overview's numbers every 5 minutes and "playing now" every 30 seconds,
  both paused while the tab is hidden. An unchanged answer keeps the page.
* **Days** follow the school's clock that every admin answer carries (`clock.today` is
  "today"); after sign-in, while the server knows no zone, the page offers this browser's
  zone once (`POST /v1/admin/settings {tz, source: 'dashboard'}`), and the clock line's
  Change sends the owner's choice. Charts built from `/v1/admin/stats` include play up to
  last night.
* **Research files** (Data & settings): the period's rows as `school-games-data_<from>_<to>.zip`:
  `students.csv`, `sessions.csv`, `visits.csv`, `rounds.csv`, `events.csv`, `student_days.csv`,
  `daily_games.csv` and `pcs.csv` from `GET /v1/admin/export` (pages of at most 2,500 lines; the
  page adds the header from `dictionary.js` and a byte-order mark), plus `games.csv`,
  `dictionary.csv`, `README.txt` (English and Arabic), `labels.sps` (SPSS) and `load.R` (R). The
  tab first says what it costs ("About 2.4 million rows: about 48% of today's free reading
  allowance": the rows the export's lookups read, about 7 a line, counted per file from the
  period's KPIs), then shows a progress bar. If the server's reading guard stops it (429 "reads"),
  the files so far are part 1 and the browser remembers where it stopped (`sg:dash:export`), so
  the next part goes on from there the next day; no row is in two parts, but the parts are made
  on different days, which each part's `README.txt` explains. In the sample, the files are
  `demo/export-*.csv`. `docs/RESEARCH_DATA.md` explains every column.
* **One child's data** (Data & settings): the code the teacher page shows (`3F9A-0C51-E2B7-5`,
  its check character checked) or its start finds the student; forgetting them or linking
  another code asks twice, as on the student's page.
* **The update day:** a period that reaches back to the days the server kept as milestone 2's
  daily totals (`range.legacyUntil`) says so above every page. Its student counts, hours and
  per-child charts start on `range.factsSince`; it draws play sessions per day instead of
  students, and no chip or sentence counts the children of only part of it.
* **Nothing is hidden:** every group is shown with its numbers, even one child. A number
  based on fewer than 5 children or 20 tries carries a "based on 2 children" chip; a
  difficulty verdict on 10 to 19 tries is an early sign. Children appear only under their
  code ("Student 7F3A"); there are no names, ranks or medals.
* **Game names** come from `names.js` (bundled, same origin), written from the games
  site's `js/catalog.js` by `make-names.mjs`; only a game added after the server was last
  deployed shows its slug. No script from another site runs on the page (the CSP's
  `script-src` is `'self'`): it could read the stored password.
* **Development:** `?api=http://127.0.0.1:8787` points the page at another server, only
  while the page itself is opened from `localhost` (the password never leaves for a
  crafted link). The rules and thresholds are documented at the top of `insights.js` and
  `research.js`.
* **Tests:** `node --test tools/tests/dashboard-insights.test.mjs` (the insight rules, and
  `demo/` is what `make-demo.mjs` writes) and `tools/tests/dashboard-research.test.mjs` (the
  maths, the game facts, the dictionary against `server/export.mjs`, the ZIP and the
  download) in Node; `tools/tests/dashboard.test.mjs` (Chromium, under the CSP, against the
  real Node server or one stubbed endpoint, and the sample) and
  `tools/tests/dashboard-e2e.test.mjs` (every tab in English and Arabic, light and dark, and the
  research download, from the real Node host serving the dashboard itself).
