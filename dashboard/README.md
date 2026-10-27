# Insights dashboard

Static files served at `/` of the ingest server (Cloudflare Worker or Node), next to the
data and outside the children's site. No build, no libraries, no inline script: the
page runs under `default-src 'self'; script-src 'self' https://farmercarry.github.io; …`.

| File | What it does |
|---|---|
| `index.html` | The page shell. |
| `app.js` | Sign in, filters, loading (`/v1/admin/kpis`, `/v1/admin/live`), timers, the sections. |
| `insights.js` | Pure rules (no DOM): rankings, the difficulty check, the insight sentences in both languages, number formats. `window.SGInsights`; Node loads it as a plain script. |
| `charts.js` | Inline-SVG line charts, bar lists and stacked bars, tooltip, table twin. |
| `i18n.js` | Every word of the page in Arabic and English. |
| `style.css` | Light and dark colour roles (validated dataviz palette), layout down to 360 px. |
| `names.js` | Every game's Arabic and English name from `js/catalog.js`, for a site that does not publish the catalog. |
| `demo.json` | `/?demo`: the real Node server's answers on simulated sessions, for every filter. |
| `make-demo.mjs` | Rebuilds `demo.json`: `node server/dashboard/make-demo.mjs`. Not deployed (`.assetsignore`). |
| `make-names.mjs` | Rebuilds `names.js` after a game is added or renamed: `node server/dashboard/make-names.mjs`. Not deployed. |

* **Password:** the `ADMIN_TOKEN` of the server, kept in that browser's `localStorage`
  (`sg:dash:token`) until "Sign out". 401 says the password is wrong, 404 explains how to
  set it, a network error says the server cannot be reached.
* **Refresh:** the KPIs on every filter change and every 5 minutes, "playing now" every
  30 seconds, both paused while the tab is hidden. An unchanged answer keeps the page.
* **Days** are the server's UTC receipt days; "today" is the UTC date.
* **Game names** come from `names.js` (bundled, same origin), written from the games
  site's `js/catalog.js` by `make-names.mjs`; only a game added after the server was last
  deployed shows its slug. No script from another site runs on the page (the CSP's
  `script-src` is `'self'`): it could read the stored password.
* **Privacy:** a group the server hides (`suppressed`, fewer than 3 sessions) is shown
  only as "fewer than 3 children — hidden for privacy", never ranked or described; a
  1–2 session group without the flag is treated the same way.
* **Development:** `?api=http://127.0.0.1:8787` points the page at another server, only
  while the page itself is opened from `localhost` (the password never leaves for a
  crafted link). The rules and thresholds are documented at the top of `insights.js`.
* **Tests:** `node --test tools/tests/dashboard-insights.test.mjs` (Node) and
  `node --test tools/tests/dashboard.test.mjs` (Chromium, under the CSP, against the real
  Node server).
