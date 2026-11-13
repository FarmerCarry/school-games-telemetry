/*
 * The insights dashboard's shell: sign in, the hash router and tab bar, the filter
 * row, data loading, timers, and the Overview. The other tabs are their own scripts
 * (games.js, habits.js, pcs.js, data.js), each registering
 * window.SGTabs.<name> = { load(ctx), render(ctx, view, data) }; ctx is the shared
 * toolbox built here (requests, words, formats, cards, charts).
 *
 * Data: the /v1/admin/* answers (README.md) with the dashboard password as a
 * Bearer token. ?demo uses the bundled demo/*.json answers instead and sends nothing.
 * ?api=<origin> points the page at another server, only while the page itself is
 * opened from this computer (localhost), so a crafted link can never send the
 * password elsewhere. Game names come from names.js, written from the games site's
 * js/catalog.js by make-names.mjs; an unknown slug is shown as is.
 * Days, hours and "today" follow the school's clock that every answer carries
 * (clock: { tz, source, offsetMin, today }); a server without it means UTC.
 * Each tab loads its endpoints only when it is opened (and on Refresh); only the
 * Overview's numbers (every 5 minutes) and "playing now" (every 30 s) refresh themselves.
 * Play is anonymous: the server keeps sessions, game visits and rounds per PC, never who
 * played, so every number here is about play, not about a child.
 */
(function () {
  'use strict';
  var KPI_EVERY_MS = 5 * 60000, LIVE_EVERY_MS = 30000, MAX_RANGE = 366;
  var PERIODS = [1, 7, 30, 90, 'year', 'custom'], DEMO_PERIODS = [1, 7, 30, 90];
  var TABS = ['overview', 'games', 'habits', 'pcs', 'data'];
  var KEY = { lang: 'sg:dash:lang', theme: 'sg:dash:theme', token: 'sg:dash:token', tab: 'sg:dash:tab', period: 'sg:dash:period' };
  var TOP = 10;
  var SLUG_RE = /^[a-z0-9-]{1,40}$/;

  var I = window.SGInsights, R = window.SGResearch, C = window.SGCharts, TEXT = window.SGDashText, h = C.h;
  var TABS_IMPL = window.SGTabs = window.SGTabs || {};
  var $ = function (id) { return document.getElementById(id); };

  // ---- storage (a blocked localStorage only means nothing is remembered) ------
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* not kept */ } }

  var params = new URLSearchParams(location.search);
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var api = '';
  if (params.has('api') && local) {
    try { var u = new URL(params.get('api')); if (/^https?:$/.test(u.protocol)) api = u.origin; } catch (e) { /* same origin */ }
  }

  var storedLang = load(KEY.lang), storedTheme = load(KEY.theme);
  var browserLang = String((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
  var state = {
    lang: storedLang === 'ar' || storedLang === 'en' ? storedLang : browserLang.indexOf('ar') === 0 ? 'ar' : 'en',
    theme: storedTheme === 'dark' || storedTheme === 'light' ? storedTheme : null,
    token: load(KEY.token),
    demo: params.has('demo'),
    period: 30, custom: null, customError: null,
    route: { tab: 'overview', arg: '', parent: 'overview' },
    live: null, liveAt: null, viewAt: null,
    clock: null, settings: null, clockPosted: false, clockOpen: false, clockNotice: null, zoneMoved: false,
    loading: false, seq: 0, gen: 0, notice: null, signinError: null,
    views: {}, cache: {}, demoCache: {},
    tables: {}, expanded: {}, choice: {}
  };
  var t = function () { return TEXT[state.lang]; };
  var rtl = function () { return state.lang === 'ar'; };

  // The remembered period: 1, 7, 30, 90, year, or custom:<from>:<to>.
  (function restorePeriod() {
    var p = load(KEY.period) || '';
    var m = /^custom:(\d{4}-\d\d-\d\d):(\d{4}-\d\d-\d\d)$/.exec(p);
    if (m && m[1] <= m[2] && R.daysBetween(m[1], m[2]) < MAX_RANGE) { state.period = 'custom'; state.custom = { from: m[1], to: m[2] }; }
    else if (p === 'year') state.period = 'year';
    else if (['1', '7', '30', '90'].indexOf(p) >= 0) state.period = Number(p);
  }());
  function savePeriod() {
    save(KEY.period, state.period === 'custom' && state.custom ? 'custom:' + state.custom.from + ':' + state.custom.to : String(state.period));
  }

  // ---- game names ---------------------------------------------------------------
  // Bundled in names.js (make-names.mjs). No script from another site ever runs here:
  // it could read the stored password.
  var BUNDLED = window.SG_GAME_NAMES || {}, INFO = window.SG_GAME_INFO || {}, CATS = window.SG_CATEGORIES || {};
  var own = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null; };
  function gameName(slug) {
    var names = own(BUNDLED, slug);
    return (names && names[state.lang === 'ar' ? 0 : 1]) || slug;
  }
  function categoryName(id) { var c = own(CATS, id); return (c && c[state.lang === 'ar' ? 0 : 1]) || id || t().otherCategory; }
  function knownSlugs() { return Object.keys(BUNDLED).sort(function (a, b) { return gameName(a).localeCompare(gameName(b), state.lang); }); }

  // ---- formatting ---------------------------------------------------------------
  var locale = function () { return state.lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB'; };
  function dayText(day, opts) {
    return new Intl.DateTimeFormat(locale(), Object.assign({ timeZone: 'UTC' }, opts)).format(new Date(day + 'T00:00:00Z'));
  }
  var shortDay = function (day) { return dayText(day, { day: 'numeric', month: 'short' }); };
  var longDay = function (day) { return dayText(day, { weekday: 'long', day: 'numeric', month: 'long' }); };
  function weekdayName(wd, style) { return dayText(R.shift('2026-01-04', wd), { weekday: style || 'long' }); }   // 4 Jan 2026 is a Sunday
  function timeText(date) {
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function minutesText(m) { var d = I.duration(m, state.lang); return d.value + ' ' + d.unit; }
  function secondsText(ms) { return ms == null ? '—' : t().secondsValue(I.seconds(ms)); }
  var utcToday = function () { return new Date().toISOString().slice(0, 10); };
  // "Today" is the school's day from the server's clock; UTC only for a server without one.
  var today = function () { return state.clock && R.isDay(state.clock.today) ? state.clock.today : utcToday(); };
  var weekStart = function () { var c = state.settings && state.settings.clock; return c && c.weekStart === 'mon' ? 'mon' : c && c.weekStart === 'sun' ? 'sun' : 'mon'; };

  // ---- theme and language ----------------------------------------------------------
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function isDark() { return state.theme ? state.theme === 'dark' : !!(media && media.matches); }
  function applyTheme() {
    if (state.theme === 'dark' || state.theme === 'light') document.documentElement.setAttribute('data-theme', state.theme);
    else document.documentElement.removeAttribute('data-theme');
    $('themeBtn').setAttribute('aria-pressed', String(isDark()));
  }
  function applyLang() {
    var T = t(), root = document.documentElement;
    root.lang = state.lang;
    root.dir = rtl() ? 'rtl' : 'ltr';
    document.title = T.appTitle + ' · ' + T.appSub;
    document.querySelectorAll('[data-t]').forEach(function (node) {
      var v = T[node.getAttribute('data-t')];
      if (typeof v === 'string') node.textContent = v;
    });
    var lb = $('langBtn');
    lb.textContent = T.otherLang;
    lb.setAttribute('lang', state.lang === 'ar' ? 'en' : 'ar');
    lb.setAttribute('aria-label', T.otherLangName);
    $('themeBtn').setAttribute('aria-label', T.dark);
    $('themeBtn').title = T.dark;
    var pw = $('password');
    $('pwToggle').textContent = pw.type === 'password' ? T.showPassword : T.hidePassword;
  }

  // ---- data -------------------------------------------------------------------------
  // The period as days on the school's clock: { from, to, days }.
  function range() {
    var to = today(), from;
    if (state.period === 'custom' && state.custom) { from = state.custom.from; to = state.custom.to; }
    else if (state.period === 'year') from = R.schoolYearStart(to);
    else from = R.shift(to, -((typeof state.period === 'number' ? state.period : 30) - 1));
    if (R.daysBetween(from, to) >= MAX_RANGE) from = R.shift(to, -(MAX_RANGE - 1));
    return { from: from, to: to, days: R.daysBetween(from, to) + 1 };
  }
  function Failure(kind, status, body) { this.kind = kind; this.status = status; this.body = body || null; }
  // method and body for the POST and DELETE actions (a JSON body of at most 4 KB).
  function request(path, token, method, body) {
    var init = { method: method || 'GET', headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(api + path, init)
      .catch(function () { throw new Failure('network'); })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (res.status === 401) throw new Failure('wrong', 401);
          // 404 is "the password was never set", or a server without this endpoint.
          if (res.status === 404) throw new Failure(json && json.error === 'admin password not set' ? 'notSet' : 'missing', 404, json);
          if (res.status === 429) throw new Failure('busy', 429, json);
          if (res.status === 503 && json && json.error === 'updating') throw new Failure('updating', 503, json);
          if (!res.ok || !json) throw new Failure('server', res.status, json);
          // Every answer of the updated server carries the school's clock.
          if (json.clock && typeof json.clock === 'object') setClock(json.clock);
          return json;
        });
      });
  }
  // One page of a research file (GET /v1/admin/export): { text, next, rows }, its lines
  // without a header and the cursor of the next page (null on the last one). Errors as for
  // request(); 429 carries the guard's answer ({ error: 'reads', until }).
  function requestPage(path, token) {
    return fetch(api + path, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' })
      .catch(function () { throw new Failure('network'); })
      .then(function (res) {
        if (res.ok) {
          return res.text().then(function (text) {
            return { text: text, next: res.headers.get('X-Next') || null, rows: Number(res.headers.get('X-Rows')) || 0 };
          });
        }
        return res.json().catch(function () { return null; }).then(function (json) {
          if (res.status === 401) throw new Failure('wrong', 401);
          if (res.status === 404) throw new Failure(json && json.error === 'admin password not set' ? 'notSet' : 'missing', 404, json);
          if (res.status === 429) throw new Failure('busy', 429, json);
          if (res.status === 503 && json && json.error === 'updating') throw new Failure('updating', 503, json);
          throw new Failure('server', res.status, json);
        });
      });
  }
  function failureText(f) {
    var T = t();
    if (f && f.kind === 'network') return T.errNetwork;
    if (f && f.kind === 'missing') return T.oldServer;
    if (f && f.kind === 'demoMissing') return T.demoMissing;
    if (f && f.kind === 'updating') return T.errUpdating;
    if (f && f.kind === 'busy') return f.body && f.body.error === 'reads' ? T.errReads(f.body.until || '') : f.body && f.body.error === 'writes' ? T.errWrites : T.errBusy;
    if (f && f.kind === 'wrong') return T.errExpired;
    return T.errServer(f && f.status || '?');
  }

  // The admin endpoints by name: their query in a fixed order.
  function query(name, q) {
    var r = q.range || range(), parts = [];
    var put = function (k, v) { if (v !== undefined && v !== null && v !== '') parts.push(k + '=' + encodeURIComponent(v)); };
    if (name === 'game') put('slug', q.slug);
    if (name !== 'live' && name !== 'settings') { put('from', r.from); put('to', r.to); }
    if (name === 'stats') put('metrics', q.metrics.join(','));
    if (name === 'stats') put('slug', q.slug);
    return '/v1/admin/' + name + (parts.length ? '?' + parts.join('&') : '');
  }
  // Demo mode: the bundled answers (demo/, written by make-demo.mjs from the real
  // server), fetched once each; the metric and game filters the server would apply are
  // applied here.
  function demoFile(name, q) {
    var p = DEMO_PERIODS.indexOf(state.period) >= 0 ? state.period : 30;
    if (name === 'kpis' || name === 'stats') return name + '-' + p + '.json';
    if (name === 'pcs') return 'pcs-30.json';
    if (name === 'game') return 'game-' + q.slug + '.json';
    return name + '.json';
  }
  function demoGet(name, q) {
    var file = 'demo/' + demoFile(name, q);
    var promise = state.demoCache[file] || (state.demoCache[file] = fetch(file, { cache: 'no-cache' }).then(function (res) {
      if (res.status === 404 && name === 'game') throw new Failure('demoMissing', 404);
      if (!res.ok) throw new Failure('server', res.status);
      return res.json();
    }).catch(function (e) { delete state.demoCache[file]; throw e instanceof Failure ? e : new Failure('network'); }));
    return promise.then(function (json) {
      if (json.clock && typeof json.clock === 'object') setClock(json.clock);
      if (name === 'stats') {
        var cols = json.columns, mi = cols.indexOf('metric'), si = cols.indexOf('slug');
        return Object.assign({}, json, { rows: json.rows.filter(function (r) {
          return q.metrics.indexOf(r[mi]) >= 0 && (q.slug == null || r[si] === q.slug);
        }) });
      }
      return json;
    });
  }
  // One request per address and generation: the sections of a tab share it, and a
  // new generation (a tab opened, a filter changed, Refresh) asks again.
  function get(name, q) {
    q = q || {};
    var url = query(name, q), hit = state.cache[url];
    if (hit && hit.gen === state.gen) return hit.promise;
    var token = state.token;
    var asked = state.demo ? demoGet(name, q) : request(url, token);
    var promise = asked.then(function (json) {
      if (!state.demo && token !== state.token) throw new Failure('stale');
      return json;
    });
    state.cache[url] = { gen: state.gen, promise: promise };
    promise.catch(function () { if (state.cache[url] && state.cache[url].promise === promise) delete state.cache[url]; });
    return promise;
  }
  // A part a section can do without: resolves to { failed } instead of rejecting.
  function part(promise) {
    return promise.then(function (json) { return json; }, function (f) {
      if (f && f.kind === 'wrong') throw f;
      return { failed: f instanceof Failure ? f : new Failure('server') };
    });
  }
  var failed = function (x) { return !x || !!x.failed; };

  // ---- the school's clock ------------------------------------------------------------
  function setClock(clock) {
    var old = state.clock && JSON.stringify(state.clock);
    state.clock = { tz: String(clock.tz || ''), source: String(clock.source || 'none'), offsetMin: Number(clock.offsetMin) || 0,
      today: String(clock.today || '') };
    if (old !== JSON.stringify(state.clock)) renderClock();
  }
  function browserZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  }
  // GET /v1/admin/settings; once a page, while nothing knows the school's clock, this
  // browser's zone is offered as a first guess (the PCs' own zone replaces it later).
  function loadSettings() {
    var token = state.token;
    var promise = state.demo ? demoGet('settings', {}) : request('/v1/admin/settings', token);
    return promise.then(function (settings) {
      if (!state.demo && token !== state.token) return;
      state.settings = settings;
      if (settings.clock) setClock(settings.clock);
      var zone = browserZone();
      if (!state.demo && state.clock && state.clock.source === 'none' && !state.clockPosted && zone) {
        state.clockPosted = true;
        return request('/v1/admin/settings', token, 'POST', { tz: zone, source: 'dashboard' }).then(function (next) {
          if (token !== state.token) return;
          state.settings = next;
          if (next.clock) setClock(next.clock);
        });
      }
    }).catch(function (f) {
      if (f && f.kind === 'wrong') signOut('expired');
      // An older server has no settings: days stay in UTC.
    }).then(renderClock);
  }
  function offsetText(min) {
    var m = Math.abs(min), sign = min < 0 ? '-' : '+';
    return 'UTC' + (m ? sign + Math.floor(m / 60) + (m % 60 ? ':' + String(m % 60).padStart(2, '0') : '') : '');
  }
  // The school's time now, for the clock line.
  function schoolTime(clock) {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: clock.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    } catch (e) {
      return new Date(Date.now() + clock.offsetMin * 60000).toISOString().slice(11, 16);
    }
  }
  function detectedZones() {
    var list = state.settings && state.settings.clock && state.settings.clock.detected;
    return (Array.isArray(list) ? list : []).filter(function (d) { return d && typeof d.tz === 'string' && d.tz; });
  }
  function zonePcs(tz) {
    var hit = detectedZones().filter(function (d) { return d.tz === tz; })[0];
    return hit ? Number(hit.pcs) || 0 : 0;
  }
  function renderClock() { keepFocus(drawClock); }
  function drawClock() {
    var box = $('clockLine');
    if (!box) return;
    var T = t(), c = state.clock;
    box.textContent = '';
    if (!c) { box.hidden = true; return; }
    box.hidden = false;
    var line = h('p', { class: 'clock-text' }, box);
    h('span', { id: 'clockText' }, line, T.clockNote(c.tz, offsetText(c.offsetMin), c.source, c.source === 'none' ? '' : schoolTime(c), zonePcs(c.tz)));
    if (!state.demo) {
      var b = h('button', { type: 'button', class: 'btn-link', id: 'clockChange', 'aria-expanded': String(state.clockOpen),
        'aria-controls': 'clockPanel', 'data-focus': 'clock:change' }, line, T.clockChange);
      b.addEventListener('click', function () { state.clockOpen = !state.clockOpen; state.clockNotice = null; renderClock(); });
    }
    var rebuild = state.settings && state.settings.rebuild;
    if (rebuild && Number(rebuild.pending) > 0) {
      h('p', { class: 'clock-note', role: 'status' }, box, T.rebuildProgress(Number(rebuild.done) || 0, (Number(rebuild.done) || 0) + Number(rebuild.pending), state.zoneMoved));
    } else if (state.clockNotice) h('p', { class: 'clock-note', role: 'status' }, box, state.clockNotice);
    if (state.clockOpen && !state.demo) zonePicker(box, 'clockPanel', function () { state.clockOpen = false; renderClock(); if ($('clockChange')) $('clockChange').focus(); });
  }
  // The zones the PCs report (with their PC counts), this browser's, then every zone.
  function zonePicker(box, id, onCancel) {
    var T = t(), current = state.clock && state.clock.tz;
    var panel = h('div', { class: 'clock-panel', id: id, role: 'group', 'aria-labelledby': id + 'Title' }, box);
    h('h2', { class: 'clock-title', id: id + 'Title' }, panel, T.clockTitle);
    h('p', { class: 'note' }, panel, T.clockIntro);
    var choices = detectedZones().map(function (d) { return { tz: d.tz, note: T.clockPcs(Number(d.pcs) || 0) }; });
    var mine = browserZone();
    if (mine && !choices.some(function (c) { return c.tz === mine; })) choices.push({ tz: mine, note: T.clockBrowser });
    if (choices.length) {
      h('p', { class: 'clock-sub' }, panel, T.clockReported);
      var list = h('div', { class: 'clock-choices' }, panel);
      choices.forEach(function (c) {
        var b = h('button', { type: 'button', class: 'btn-quiet clock-choice', 'aria-pressed': String(c.tz === current), 'data-tz': c.tz,
          'data-focus': id + ':' + c.tz }, list);
        h('span', { class: 'clock-zone', dir: 'ltr' }, b, c.tz);
        h('span', { class: 'clock-pcs' }, b, c.note);
        b.addEventListener('click', function () { chooseZone(c.tz); });
      });
    }
    var zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) { /* an older browser: the list above only */ }
    if (zones.length) {
      var row = h('div', { class: 'clock-all' }, panel);
      h('label', { for: id + 'Select' }, row, T.clockAll);
      var select = h('select', { id: id + 'Select', class: 'clock-select', dir: 'ltr', 'data-focus': id + ':select' }, row);
      (zones.indexOf('UTC') < 0 ? ['UTC'].concat(zones) : zones).forEach(function (z) { h('option', { value: z, selected: z === current }, select, z); });
      var use = h('button', { type: 'button', class: 'btn-quiet clock-use', 'data-focus': id + ':use' }, row, T.clockUse);
      use.addEventListener('click', function () { chooseZone(select.value); });
    }
    if (onCancel) h('button', { type: 'button', class: 'btn-link', 'data-focus': id + ':cancel' }, panel, T.clockCancel).addEventListener('click', onCancel);
    return panel;
  }
  // One click: the owner's choice (POST settings { tz }), never changed automatically.
  function chooseZone(tz) { postSettings({ tz: tz }, t().clockSaved); }
  function postSettings(body, done) {
    var token = state.token;
    return request('/v1/admin/settings', token, 'POST', body).then(function (settings) {
      if (token !== state.token) return;
      state.settings = settings;
      if (settings.clock) setClock(settings.clock);
      // Past days now move to the new clock (the progress line says so).
      if (body.tz) state.zoneMoved = true;
      state.clockOpen = false;
      state.clockNotice = done;
      renderClock();
      refreshView();
    }, function (f) {
      if (f && f.kind === 'wrong') { signOut('expired'); return; }
      state.clockNotice = f && f.kind === 'busy' ? failureText(f) : t().clockFailed;
      renderClock();
    });
  }

  // ---- the router -------------------------------------------------------------------
  function parseRoute(hash) {
    var m = /^#\/([a-z]+)(?:\/([^/?#]+))?$/.exec(hash || '');
    if (!m) return null;
    var arg = '';
    try { arg = m[2] ? decodeURIComponent(m[2]) : ''; } catch (e) { return null; }
    if (m[1] === 'game') return SLUG_RE.test(arg) ? { tab: 'game', arg: arg, parent: 'games' } : null;
    return TABS.indexOf(m[1]) >= 0 && !arg ? { tab: m[1], arg: '', parent: m[1] } : null;
  }
  function routeKey(r) { return r.tab + (r.arg ? '/' + r.arg : ''); }
  function hashOf(r) { return '#/' + r.tab + (r.arg ? '/' + encodeURIComponent(r.arg) : ''); }
  function readRoute() {
    var r = parseRoute(location.hash);
    if (!r) {
      var stored = load(KEY.tab);
      r = { tab: TABS.indexOf(stored) >= 0 ? stored : 'overview', arg: '', parent: '' };
      r.parent = r.tab;
      if (location.hash !== hashOf(r)) history.replaceState(null, '', location.pathname + location.search + hashOf(r));
    }
    return r;
  }
  window.addEventListener('hashchange', function () {
    if ($('dash').hidden) return;
    var r = readRoute();
    if (routeKey(r) === routeKey(state.route)) return;
    state.route = r;
    if (r.tab === r.parent) save(KEY.tab, r.tab);
    C.hideTip();
    renderTabs();
    renderFilters();
    refreshView({ top: true });
  });
  function renderTabs() { keepFocus(drawTabs); }
  function drawTabs() {
    var T = t(), nav = $('tabs');
    nav.textContent = '';
    nav.setAttribute('aria-label', T.tabsLabel);
    var ul = h('ul', { class: 'tab-list' }, nav);
    TABS.forEach(function (tab) {
      var li = h('li', null, ul);
      var a = h('a', { href: '#/' + tab, class: 'tab', 'data-tab': tab, 'data-focus': 'tab:' + tab,
        'aria-current': state.route.parent === tab ? 'page' : null }, li, T.tabs[tab]);
      a.addEventListener('click', function () { if (state.route.tab !== tab) return; refreshView(); });
    });
  }

  // ---- loading a view -------------------------------------------------------------------
  // The current tab's data, then its page; a newer request wins. An unchanged answer
  // (the 5-minute refresh, mostly) keeps the page, its focus and scroll.
  function tabOf(r) { return r.tab === 'overview' ? OVERVIEW : TABS_IMPL[r.tab]; }
  function refreshView(opts) {
    var o = opts || {};
    if (!o.keepCache) {
      // A new generation asks again; the answers of older ones are no longer needed.
      state.gen++;
      Object.keys(state.cache).forEach(function (url) { if (state.cache[url].gen < state.gen) delete state.cache[url]; });
    }
    var route = state.route, key = routeKey(route), seq = ++state.seq, tab = tabOf(route);
    if (!tab) return Promise.resolve();
    state.loading = true;
    $('dash').classList.add('is-loading');
    $('dash').setAttribute('aria-busy', 'true');
    var before = state.views[key];
    if (!before || o.top) { drawView(o.top); }
    return Promise.resolve().then(function () { return tab.load(ctx); }).then(function (data) {
      if (seq !== state.seq) return;
      var json = JSON.stringify(data), view = state.views[key];
      var same = !!view && view.json === json && !state.notice && view.lang === state.lang && !o.redraw;
      state.views[key] = { data: data, json: json, at: new Date(), lang: state.lang };
      state.viewAt = new Date(); state.notice = null;
      if (same && !o.top) { renderNotice(); return; }
      drawView(o.top);
    }, function (f) {
      if (seq !== state.seq) return;
      if (f && (f.kind === 'wrong' || f.kind === 'notSet')) { signOut(f.kind === 'wrong' ? 'expired' : 'notSet'); return; }
      if (f && f.kind === 'stale') return;
      state.notice = failureText(f);
      if (!state.views[key]) drawView(); else renderNotice();
    }).then(function () {
      if (seq !== state.seq) return;
      state.loading = false;
      $('dash').classList.remove('is-loading');
      $('dash').removeAttribute('aria-busy');
    });
  }
  function renderView() { keepFocus(function () { drawView(false); }); }
  function drawView(toTop) {
    var T = t(), route = state.route, view = state.views[routeKey(route)], box = $('view'), scrollY = window.scrollY;
    clearView();
    renderNotice();
    renderRange();
    box.setAttribute('data-route', route.tab);
    var tab = tabOf(route);
    if (!view) { note(box, state.notice || T.loading, state.notice ? 'empty' : null); return; }
    var cut = cutover();
    if (cut) note(box, T.cutoverTop(dayText(cut.factsSince, { day: 'numeric', month: 'short', year: 'numeric' })), 'cutover');
    tab.render(ctx, box, view.data);
    renderFooter();
    redrawCharts();
    if (toTop) window.scrollTo(window.scrollX, 0);
    else if (window.scrollY !== scrollY) window.scrollTo(window.scrollX, scrollY);
  }
  function clearView() {
    drawers = [];
    $('view').textContent = '';
    C.hideTip();
  }
  function renderRange() {
    var T = t(), r = range();
    $('rangeText').textContent = r.from === r.to ? T.rangeOne(dayText(r.from, { day: 'numeric', month: 'long', year: 'numeric' }))
      : T.range(dayText(r.from, { day: 'numeric', month: 'short' }), dayText(r.to, { day: 'numeric', month: 'short', year: 'numeric' }));
  }
  // The footer: what is collected, the day the school's clock began, last night's charts.
  function renderFooter() {
    var T = t(), box = $('footNotes'), r = range(), kpis = viewKpis();
    box.textContent = '';
    var legacy = kpis && kpis.range && R.isDay(kpis.range.legacyUntil) ? kpis.range.legacyUntil : null;
    if (legacy && r.from <= legacy) h('p', null, box, T.cutoverNote(dayText(R.shift(legacy, 1), { day: 'numeric', month: 'short', year: 'numeric' })));
    if (tabOf(state.route).nightly) h('p', null, box, T.nightlyNote);
  }
  function viewKpis() {
    var v = state.views[routeKey(state.route)];
    return v && v.data && v.data.kpis && !v.data.kpis.failed ? v.data.kpis : null;
  }
  // The update day, when the period reaches back before it: { legacyUntil, factsSince }, or
  // null. Up to legacyUntil the server kept milestone 2's daily totals only; the hours, the
  // levels and the game and stats answers start at factsSince.
  function cutover() {
    var r = range(), k = viewKpis(), c = state.settings && state.settings.clock;
    var src = [k && k.range, c].filter(function (x) { return x && R.isDay(x.legacyUntil); })[0];
    if (!src || r.from > src.legacyUntil) return null;
    return { legacyUntil: src.legacyUntil, factsSince: R.isDay(src.factsSince) ? src.factsSince : R.shift(src.legacyUntil, 1) };
  }

  // An answer for a password that was signed out meanwhile is ignored.
  function refreshLive() {
    var token = state.token;
    return (state.demo ? demoGet('live', {}) : request('/v1/admin/live', token)).then(function (live) {
      if (token !== state.token) return;
      state.live = live; state.liveAt = new Date();
      renderLive();
      renderClock();
      // While past days move to a new clock, the progress line follows it.
      if (state.settings && state.settings.rebuild && Number(state.settings.rebuild.pending) > 0) loadSettings();
    }, function (f) {
      if (token === state.token && !state.demo && f && f.kind === 'wrong') signOut('expired');
    });
  }

  // The Overview's own refresh: its numbers (the KPIs) again, the rest of the page as it was.
  function refreshTiles() {
    Object.keys(state.cache).forEach(function (url) { if (url.indexOf('/v1/admin/kpis') === 0) delete state.cache[url]; });
    return refreshView({ keepCache: true });
  }
  // Timers pause while the page is hidden and catch up when it comes back.
  var timers = [];
  function startTimers() {
    stopTimers();
    timers.push(setInterval(function () { if (!document.hidden && state.route.tab === 'overview') refreshTiles(); }, KPI_EVERY_MS));
    timers.push(setInterval(function () { if (!document.hidden) refreshLive(); }, LIVE_EVERY_MS));
  }
  function stopTimers() { timers.forEach(clearInterval); timers = []; }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !timers.length) return;
    if (state.route.tab === 'overview' && (!state.viewAt || Date.now() - state.viewAt > KPI_EVERY_MS)) refreshTiles();
    if (!state.liveAt || Date.now() - state.liveAt > LIVE_EVERY_MS) refreshLive();
  });

  // ---- sign in ------------------------------------------------------------------------
  // error: null, or { kind: 'wrong' | 'expired' | 'notSet' | 'network' | 'busy' | 'server', status }
  function showSignIn(error) {
    stopTimers();
    state.signinError = error || null;
    $('signin').hidden = false;
    $('dash').hidden = true;
    $('signOutBtn').hidden = true;
    $('demoBanner').hidden = true;
    renderSignInError();
    setTimeout(function () { $('password').focus(); }, 0);
  }
  function renderSignInError() {
    var T = t(), box = $('signinError'), error = state.signinError;
    box.textContent = '';
    box.hidden = !error;
    if (!error) return;
    if (error.kind === 'notSet') {
      h('p', { class: 'error-title' }, box, T.errNotSetTitle);
      var ol = h('ol', null, box);
      T.errNotSetSteps.forEach(function (step) { h('li', null, ol, step); });
      h('p', null, box, T.errNotSetSelf);
    } else {
      h('p', { class: 'error-title' }, box, error.kind === 'wrong' ? T.errWrong : error.kind === 'expired' ? T.errExpired : failureText(error));
    }
  }
  function signOut(reason) {
    state.token = null; state.live = null; state.viewAt = null; state.seq++; state.gen++;
    state.views = {}; state.cache = {};
    state.clock = null; state.settings = null; state.clockPosted = false; state.clockOpen = false; state.clockNotice = null; state.zoneMoved = false;
    save(KEY.token, null);
    clearView();
    showSignIn(reason ? { kind: reason } : null);
  }
  function showDash(haveLive) {
    $('signin').hidden = true;
    $('dash').hidden = false;
    $('signOutBtn').hidden = state.demo;
    $('demoBanner').hidden = !state.demo;
    state.route = readRoute();
    // Demo mode has the sample periods only.
    if (state.demo && DEMO_PERIODS.indexOf(state.period) < 0) state.period = 30;
    renderTabs();
    renderFilters();
    renderClock();
    // The school's day decides the period, so the clock comes first.
    loadSettings().then(function () { renderFilters(); refreshView(); });
    if (!haveLive) refreshLive();
    startTimers();
  }
  $('signinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var token = $('password').value.trim(), button = $('signinBtn'), T = t();
    if (!token) { $('password').focus(); return; }
    button.disabled = true;
    button.textContent = T.checking;
    $('signinError').hidden = true;
    request('/v1/admin/live', token).then(function (live) {
      state.token = token; state.live = live; state.liveAt = new Date();
      save(KEY.token, token);
      $('password').value = '';
      showDash(true);
    }, function (f) {
      showSignIn(f instanceof Failure ? f : { kind: 'network' });
    }).then(function () {
      button.disabled = false;
      button.textContent = t().signInButton;
    });
  });
  $('pwToggle').addEventListener('click', function () {
    var pw = $('password');
    pw.type = pw.type === 'password' ? 'text' : 'password';
    $('pwToggle').setAttribute('aria-pressed', String(pw.type === 'text'));
    applyLang();
  });
  $('signOutBtn').addEventListener('click', function () { signOut(); });
  $('langBtn').addEventListener('click', function () {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    save(KEY.lang, state.lang);
    applyLang();
    renderSignInError();
    if ($('dash').hidden) return;
    renderTabs();
    renderFilters();
    renderClock();
    renderView();
  });
  $('themeBtn').addEventListener('click', function () {
    state.theme = isDark() ? 'light' : 'dark';
    save(KEY.theme, state.theme);
    applyTheme();
  });
  if (media && media.addEventListener) media.addEventListener('change', applyTheme);

  // A redrawn control keeps the keyboard focus: the new button with the same data-focus
  // key takes it back, so a keyboard user is not sent to the top of the page.
  function keepFocus(draw) {
    var active = document.activeElement, key = active && active.getAttribute && active.getAttribute('data-focus');
    draw();
    if (!key || document.activeElement === active) return;
    var next = document.querySelector('[data-focus="' + CSS.escape(key) + '"]');
    if (next) next.focus({ preventScroll: true });
  }

  // ---- filters ---------------------------------------------------------------------
  // Every tab follows the period (the Data tab's quality panel too).
  function periodApplies() { return true; }
  function segmented(host, label, items, current, onPick) {
    host.textContent = '';
    h('span', { class: 'filter-label', id: host.id + 'Label' }, host, label);
    var group = h('div', { class: 'seg', role: 'group', 'aria-labelledby': host.id + 'Label' }, host);
    items.forEach(function (item) {
      var b = h('button', { type: 'button', 'aria-pressed': String(item.value === current), 'data-value': String(item.value),
        'data-focus': host.id + ':' + item.value }, group, item.text);
      b.addEventListener('click', function () { if (item.value !== current || item.value === 'custom') onPick(item.value); });
    });
    return group;
  }
  function changed() { renderFilters(); refreshView(); }
  function renderFilters() { keepFocus(drawFilters); }
  function drawFilters() {
    var T = t(), periods = state.demo ? DEMO_PERIODS : PERIODS;
    var pf = $('periodFilter');
    pf.hidden = !periodApplies();
    segmented(pf, T.period, periods.map(function (p) {
      return { value: p, text: p === 1 ? T.today : p === 'year' ? T.schoolYear : p === 'custom' ? T.customPeriod : T.days(p) };
    }), state.period, function (p) {
      if (p === 'custom') {
        var r = range();
        state.period = 'custom';
        state.custom = state.custom || { from: r.from, to: r.to };
        state.customOpen = true;
        renderFilters();
        var from = $('customFrom');
        if (from) from.focus();
        return;
      }
      state.period = p; state.customOpen = false; savePeriod(); changed();
    });
    drawCustom();
    drawPicker();
    renderStatus();
  }
  // Custom: two dates on the school's clock, at most 366 days, none after today.
  function drawCustom() {
    var T = t(), box = $('customRange');
    box.textContent = '';
    box.hidden = !(periodApplies() && state.period === 'custom' && state.customOpen);
    if (box.hidden) return;
    var c = state.custom || range();
    var form = h('form', { class: 'custom-form', novalidate: true }, box);
    var field = function (id, label, value) {
      var wrap = h('span', { class: 'field' }, form);
      h('label', { for: id }, wrap, label);
      return h('input', { id: id, type: 'date', value: value, max: today(), required: true, 'data-focus': 'custom:' + id }, wrap);
    };
    var from = field('customFrom', T.customFrom, c.from), to = field('customTo', T.customTo, c.to);
    h('button', { type: 'submit', class: 'btn-quiet', 'data-focus': 'custom:show' }, form, T.customShow);
    if (state.customError) h('p', { class: 'field-error', role: 'alert' }, box, state.customError);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var a = from.value, b = to.value;
      state.customError = !R.isDay(a) || !R.isDay(b) ? T.customBad : a > b ? T.customOrder : R.daysBetween(a, b) >= MAX_RANGE ? T.customLong : b > today() ? T.customFuture : null;
      if (state.customError) { renderFilters(); return; }
      state.custom = { from: a, to: b }; state.customOpen = false; savePeriod(); changed();
    });
  }
  // The game picker (a game's page).
  function drawPicker() {
    var T = t(), box = $('pickFilter'), tab = state.route.tab;
    box.textContent = '';
    box.hidden = tab !== 'game';
    if (box.hidden) return;
    h('label', { class: 'filter-label', for: 'gamePick' }, box, T.gamePick);
    var select = h('select', { id: 'gamePick', class: 'game-pick', 'data-focus': 'gamePick' }, box);
    var current = state.route.arg;
    knownSlugs().forEach(function (slug) { h('option', { value: slug, selected: slug === current }, select, gameName(slug)); });
    if (!own(BUNDLED, current)) h('option', { value: current, selected: true }, select, current);
    select.addEventListener('change', function () { location.hash = '#/game/' + encodeURIComponent(select.value); });
  }
  function renderStatus() { keepFocus(drawStatus); }
  function drawStatus() {
    var T = t(), box = $('status');
    box.textContent = '';
    if (state.demo) h('span', { class: 'pill' }, box, T.demoTitle);
    if (state.viewAt) h('span', { class: 'updated' }, box, T.updated(timeText(state.viewAt)));
    var b = h('button', { type: 'button', class: 'btn-quiet', id: 'refreshBtn', 'data-focus': 'refresh' }, box, T.refresh);
    b.addEventListener('click', function () { refreshView(); refreshLive(); if (!state.demo) loadSettings(); });
  }
  function renderNotice() {
    var box = $('notice');
    box.hidden = !state.notice;
    box.textContent = state.notice && state.viewAt ? t().staleNote(state.notice, timeText(state.viewAt)) : state.notice || '';
    renderStatus();
  }

  // ---- cards and small pieces ---------------------------------------------------------
  // A card with a title, a short explanation and a chart/table switch.
  // Without a title the card belongs to its section's heading.
  function card(parent, id, title, sub, withTable) {
    var T = t();
    var root = h('figure', { class: 'card', id: id }, parent);
    var head = h('div', { class: 'card-head' }, root);
    var titles = h('div', { class: 'card-titles' }, head);
    if (title) h('h3', { class: 'card-title', id: id + '-title' }, titles, title);
    else if (parent.getAttribute('aria-labelledby')) root.setAttribute('aria-labelledby', parent.getAttribute('aria-labelledby'));
    if (sub) h('p', { class: 'card-sub' }, titles, sub);
    var tools = h('div', { class: 'card-tools' }, head);
    var body = h('div', { class: 'card-body' }, root);
    var chart = h('div', { class: 'chart-host' }, body);
    var tableHost = h('div', { class: 'table-host', hidden: true }, body);
    var foot = h('figcaption', { class: 'card-foot' }, root);
    var out = { root: root, chart: chart, table: tableHost, foot: foot, body: body, head: head, tools: tools };
    if (withTable) {
      var on = !!state.tables[id];
      var b = h('button', { type: 'button', class: 'btn-quiet table-toggle', 'aria-pressed': String(on), 'aria-controls': id + '-body',
        'data-focus': 'table:' + id }, tools, on ? T.showChart : T.showTable);
      body.id = id + '-body';
      chart.hidden = on; tableHost.hidden = !on;
      b.addEventListener('click', function () {
        state.tables[id] = !state.tables[id];
        var now = !!state.tables[id];
        b.textContent = now ? t().showChart : t().showTable;
        b.setAttribute('aria-pressed', String(now));
        chart.hidden = now; tableHost.hidden = !now;
        C.hideTip();
        if (!now) redrawCharts();
      });
    }
    return out;
  }
  // A small switch in a card's head (minutes or opens, a measure); redraws the view.
  function choice(parent, id, items, fallback, label) {
    var current = state.choice[id] && items.some(function (i) { return i.value === state.choice[id]; }) ? state.choice[id] : fallback;
    var group = h('div', { class: 'seg seg-small', role: 'group', 'aria-label': label || null }, parent);
    items.forEach(function (item) {
      var b = h('button', { type: 'button', 'aria-pressed': String(item.value === current), 'data-value': item.value, 'data-focus': 'choice:' + id + ':' + item.value }, group, item.text);
      b.addEventListener('click', function () { if (item.value !== current) { state.choice[id] = item.value; renderView(); } });
    });
    return current;
  }
  // A chart with nothing to show in a period that reaches back before the update says from
  // which day it counts, not that nobody played.
  function note(parent, text, cls) {
    var cut = text === t().noData && cutover();
    if (cut) text = t().noDataSince(dayText(cut.factsSince, { day: 'numeric', month: 'short', year: 'numeric' }));
    return h('p', { class: 'note' + (cls ? ' ' + cls : '') }, parent, text);
  }
  // The small-sample chip: "based on 12 tries" (fewer than 20 tries).
  function chipText(tries, long) { var T = t(); return long ? T.smallTries(tries) : T.smallChipTries(tries); }
  function chip(parent, tries) {
    if (!I.small(tries)) return null;
    return h('span', { class: 'chip', 'data-small': 'true' }, parent, chipText(tries));
  }
  // The chip's text when a mark is small, else null (for bar lists and tooltips).
  function chipFor(tries, long) { return I.small(tries) ? chipText(tries, long) : null; }
  // label(k): "Show all 34 games" by default; limit: the rows shown before (TOP).
  function moreButton(parent, id, total, label, limit) {
    if (total <= (limit || TOP)) return;
    var T = t(), open = !!state.expanded[id];
    var b = h('button', { type: 'button', class: 'btn-quiet more', 'aria-expanded': String(open), 'data-focus': 'more:' + id }, parent, open ? T.showFewer : (label || T.showAll)(total));
    b.addEventListener('click', function () { state.expanded[id] = !open; renderView(); });
  }
  var top = function (id, rows, n) { return state.expanded[id] ? rows : rows.slice(0, n || TOP); };
  // A section: its heading and, when given, a one-line intro.
  function section(parent, id, title, intro) {
    var sec = h('section', { class: 'section', id: id, 'aria-labelledby': id + '-h' }, parent);
    h('h2', { class: 'section-title', id: id + '-h' }, sec, title);
    if (intro) h('p', { class: 'section-intro' }, sec, intro);
    return sec;
  }
  function tile(parent, key, label, value, unit, hint, raw) {
    var el = h('div', { class: 'tile', 'data-key': key, 'data-value': raw == null ? '' : String(raw) }, parent);
    h('div', { class: 'tile-label' }, el, label);
    var v = h('div', { class: 'tile-value' }, el);
    h('span', { class: 'tile-number' }, v, value);
    if (unit) h('span', { class: 'tile-unit' }, v, unit);
    var hintNode = h('div', { class: 'tile-hint' }, el, hint);
    return { el: el, hint: hintNode };
  }
  // A link to a page of the dashboard.
  function link(parent, hash, text, cls) {
    return h('a', { href: hash, class: cls || null }, parent, text);
  }
  function gameLink(parent, slug) { return link(parent, '#/game/' + encodeURIComponent(slug), gameName(slug), 'game-link'); }
  // A section whose data an older server does not send (or that failed) says so.
  function missing(parent, x) { note(parent, x && x.failed ? failureText(x.failed) : t().noData, 'empty-part'); }
  var has = function (v) { return typeof v === 'number' && isFinite(v); };

  // Charts are drawn to their card's width once the whole page is laid out (a panel
  // measured before its neighbours exist would be too wide); a resize redraws them.
  var drawers = [];
  function redrawCharts() { drawers.forEach(function (fn) { fn(); }); }
  function draw(fn) { drawers.push(fn); }

  var ICONS = {
    stuck: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v.5', hard: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v.5',
    favourite: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
    health: 'M3 5h18v11H3zM8 20h8M12 16v4', returning: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
    trend: 'M3 17l6-6 4 4 8-8M15 7h6v6', easy: 'M5 12l5 5 9-10',
    hearts: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
    persist: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4', tired: 'M12 7v5l3 2M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0',
    peak: 'M4 20V10M10 20V4M16 20v-7M22 20H2', session: 'M12 7v5l3 2M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0',
    old: 'M12 8v5m0 3v.5M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0', empty: 'M4 12h16', quiet: 'M5 12l5 5 9-10'
  };
  function icon(parent, kind, cls) {
    var svg = C.s('svg', { viewBox: '0 0 24 24', class: 'icon ' + (cls || ''), 'aria-hidden': 'true' }, parent);
    C.s('path', { d: ICONS[kind] || ICONS.empty }, svg);
    return svg;
  }
  // Insight sentences (insights.js), each with its small-sample chip.
  function sentences(box, list) {
    var ol = h('ol', { class: 'insight-list' }, box);
    list.forEach(function (item) {
      var li = h('li', { class: 'insight', 'data-kind': item.kind }, ol);
      icon(li, item.kind);
      var text = h('span', { class: 'insight-text' }, li, item.text);
      if (item.small) { text.appendChild(document.createTextNode(' ')); chip(text, item.tries); }
    });
    return ol;
  }

  var VERDICT_ICON = { hard: 'M12 4 3 19h18L12 4Z', easy: 'M12 20 3 5h18L12 20Z', right: 'M5 12.5l4.5 4.5L19 7', few: 'M6 12h.01M12 12h.01M18 12h.01',
    none: 'M6 12h12', missing: 'M6 12h12' };
  // A verdict with its icon and label; an early sign (10-19 tries) says so next to it.
  function verdictText(v, compact) {
    var T = t(), label = compact ? T.verdict[v.code] : T.verdictLong[v.code];
    return v.early ? label + ' · ' + (compact ? T.earlyShort : T.earlySign) : label;
  }
  function verdictNode(parent, v, compact) {
    var T = t(), code = v.code;
    var el = h('span', { class: 'verdict v-' + code + (v.early ? ' is-early' : ''), 'data-verdict': code, 'data-early': v.early ? 'true' : null }, parent);
    var svg = C.s('svg', { viewBox: '0 0 24 24', class: 'verdict-icon', 'aria-hidden': 'true' }, el);
    C.s('path', { d: VERDICT_ICON[code] }, svg);
    var label = h('span', { class: 'verdict-label' }, el, compact ? T.verdict[code] : T.verdictLong[code]);
    if (v.early) h('span', { class: 'verdict-early' }, label, (compact ? T.earlyShort : T.earlySign));
    return el;
  }
  var OUTCOMES = [['won', 'var(--s1)'], ['lost', 'var(--s2)'], ['unfinished', 'var(--s3)'], ['other', 'var(--other)']];
  var ORDINAL = ['var(--o1)', 'var(--o2)', 'var(--o3)', 'var(--o4)'];

  // A legend for a chart with two or more series: [[name, colour], ...].
  function legendList(parent, label, items) {
    var ul = h('ul', { class: 'legend', 'aria-label': label }, parent);
    items.forEach(function (x) {
      var li = h('li', null, ul);
      h('span', { class: 'swatch' }, li).style.background = x[1];
      h('span', null, li, x[0]);
    });
    return ul;
  }
  // A heatmap legend: the lowest and highest value, and the empty cell.
  function legendOf(format) {
    var T = t();
    return { low: function (v) { return format(v); }, high: function (v) { return format(v); }, empty: T.none };
  }

  // ---- the toolbox handed to the tab scripts -------------------------------------------
  var ctx = {
    I: I, R: R, C: C, h: h,
    t: t, rtl: rtl, lang: function () { return state.lang; }, state: state,
    get: get, part: part, failed: failed, request: function (path, method, body) { return request(path, state.token, method, body); },
    requestPage: function (path) { return requestPage(path, state.token); }, store: { load: load, save: save },
    range: range, today: today, weekStart: weekStart, demo: function () { return state.demo; },
    route: function () { return state.route; }, settings: function () { return state.settings; }, live: function () { return state.live; },
    gameName: gameName, gameInfo: function (slug) { return own(INFO, slug); }, categoryName: categoryName, knownSlugs: knownSlugs,
    dayText: dayText, shortDay: shortDay, longDay: longDay, weekdayName: weekdayName, minutesText: minutesText, secondsText: secondsText,
    card: card, choice: choice, note: note, chip: chip, chipText: chipText, chipFor: chipFor, moreButton: moreButton, top: top,
    section: section, tile: tile, link: link, gameLink: gameLink, missing: missing, has: has,
    draw: draw, icon: icon, sentences: sentences, verdictNode: verdictNode, verdictText: verdictText, legendOf: legendOf, legendList: legendList,
    OUTCOMES: OUTCOMES, ORDINAL: ORDINAL, failureText: failureText, renderView: renderView, refreshView: refreshView,
    keepFocus: keepFocus, postSettings: postSettings, zonePicker: zonePicker, loadSettings: loadSettings, cutover: function () { return cutover(); },
    go: function (hash) { location.hash = hash; }
  };

  // ---- the Overview ----------------------------------------------------------------------
  var OVERVIEW = {
    load: function () {
      return Promise.all([get('kpis', {}), part(get('stats', { metrics: ['hour'] }))])
        .then(function (x) { return { kpis: x[0], hours: x[1] }; });
    },
    render: function (c, view, data) { renderOverview(view, data); }
  };
  function renderOverview(view, data) {
    var T = t(), k = data.kpis;
    var head = section(view, 'insights-section', T.insightsTitle, T.introOverview);
    var box = h('div', { id: 'insights', class: 'card insights-card' }, head);
    sentences(box, I.insights(k, { lang: state.lang, name: gameName, today: today() }));
    var nums = section(view, 'numbers', T.numbersTitle);
    renderTiles(h('div', { id: 'tiles', class: 'tiles' }, nums), k);
    renderQuality(nums, k);
    if (!k || !I.shown(k.totals) || !k.totals.sessions) {
      note(view, k && I.shown(k.totals) ? T.emptyHint : T.oldServer, 'empty');
      return;
    }
    renderDaily(view, k);
    renderWhen(view, data.hours);
    renderFavourites(view, k);
    renderStuck(view, k);
    renderDifficulty(view, k);
    renderReturning(view, k);
    renderHealth(view, k);
  }

  function renderTiles(box, k) {
    var T = t(), tot = k && I.shown(k.totals) ? k.totals : {}, dash = '—';
    tile(box, 'sessions', T.tileSessions, has(tot.sessions) ? I.int(tot.sessions) : dash, '', T.tileSessionsHint, has(tot.sessions) ? tot.sessions : null);
    var d = has(tot.engagedMinutes) ? I.duration(tot.engagedMinutes, state.lang) : null;
    tile(box, 'playTime', T.tilePlayTime, d ? d.value : dash, d ? d.unit : '', T.tilePlayTimeHint, d ? tot.engagedMinutes : null);
    var per = tot.avgEngagedMinutesPerSession;
    tile(box, 'perSession', T.tilePerSession, has(per) ? I.short(per) : dash, has(per) ? T.minutesUnit : '', T.tilePerSessionHint, has(per) ? per : null);
    tile(box, 'opens', T.tileOpens, has(tot.gameOpens) ? I.int(tot.gameOpens) : dash, '', T.tileOpensHint, has(tot.gameOpens) ? tot.gameOpens : null);
    tile(box, 'rounds', T.tileRounds, has(tot.roundsEnded) ? I.int(tot.roundsEnded) : dash, '', T.tileRoundsHint, has(tot.roundsEnded) ? tot.roundsEnded : null);
    var now = tile(box, 'now', T.tileNow, dash, '', T.tileNowHint, null);
    now.el.id = 'nowTile';
    renderLive();
  }
  function renderLive() {
    var el = $('nowTile');
    if (!el) return;
    var T = t(), live = state.live, total = live && live.total;
    var number = el.querySelector('.tile-number'), hint = el.querySelector('.tile-hint');
    el.classList.toggle('is-live', !!(I.shown(total) && total.sessions > 0));
    if (!I.shown(total)) { number.textContent = '—'; el.setAttribute('data-value', ''); return; }
    number.textContent = I.int(total.sessions);
    el.setAttribute('data-value', String(total.sessions));
    var games = (live.games || []).filter(function (g) { return I.shown(g) && g.sessions > 0; })
      .sort(function (a, b) { return b.sessions - a.sessions || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0); });
    // "on 12 PCs" counts the PCs on the new version (older ones send no PC code).
    var where = total.sessions > 0 && has(live.pcs) && live.pcs > 0 ? T.nowPcs(live.pcs) : '';
    hint.textContent = [where, games.length ? T.nowTop(gameName(games[0].slug)) : ''].filter(Boolean).join(' · ') || T.tileNowHint;
    if (state.liveAt) el.title = T.nowChecked(timeText(state.liveAt));
  }

  // How many PCs run the new version, and how much play still comes from older ones.
  function renderQuality(parent, k) {
    var T = t(), q = k && k.quality;
    if (!q || typeof q !== 'object') return;
    var box = h('div', { class: 'quality', id: 'quality', role: 'note' }, parent);
    if (has(q.pcsNew)) h('p', null, box, T.pcsUpdated(q.pcsNew, has(q.oldVersionSessionShare) && q.oldVersionSessionShare > 0 ? I.pct(q.oldVersionSessionShare) : null));
    link(h('p', null, box), '#/data', T.qualityMore);
  }

  // Daily activity: two separate charts, never a dual axis: play sessions and play time.
  function renderDaily(parent, k) {
    var T = t(), sec = section(parent, 'daily', T.dailyTitle);
    var grid = h('div', { class: 'grid-2' }, sec);
    var days = (k.daily || []).filter(Boolean);
    var tick = function (day) { return days.length <= 7 ? dayText(day, { weekday: 'short', day: 'numeric' }) : shortDay(day); };
    [['sessions', T.dailySessions, T.sessions, 'daily-count'], ['engagedMinutes', T.dailyMinutes, T.minutes, 'daily-minutes']].forEach(function (spec) {
      var c = card(grid, spec[3], spec[1], null, true);
      var fmt = function (v) { return I.int(v); };
      if (days.length < 7) note(c.chart, T.dailyNeedsDays);
      else {
        var points = days.map(function (d) { return { title: longDay(d.day), tick: tick(d.day), value: I.shown(d) ? d[spec[0]] || 0 : null }; });
        draw(function () {
          if (c.chart.hidden) return;
          C.lineChart(c.chart, { points: points, color: 'var(--s1)', rtl: rtl(), name: spec[1], format: fmt, unit: '', emptyText: T.noNumbers, keysHint: T.keysDays });
        });
      }
      C.table(c.table, spec[1], [{ label: T.day }, { label: spec[2], num: true }], days.slice().reverse().map(function (d) {
        return [longDay(d.day), I.shown(d) ? fmt(d[spec[0]] || 0) : { text: T.noNumbers }];
      }));
    });
  }

  // When they play: weekday x hour of minutes, the rows from the school's first weekday.
  function whenHeatmap(c, hours, opts) {
    var T = t(), r = range(), last = R.shift(today(), -1), to = r.to < last ? r.to : last;
    var rows = R.statRows(hours);
    var grid = R.weekHours(rows, { from: r.from, to: to, weekStart: weekStart() });
    var hoursShown = R.activeHours(grid, opts && opts.lo, opts && opts.hi);
    var hourText = function (hr) { return String(hr).padStart(2, '0') + ':00'; };
    var empty = !grid.some(function (row) { return row.cells.some(function (x) { return x.visits; }); });
    if (empty) { note(c.chart, r.from > last ? T.statsTomorrow : T.noData); }
    else draw(function () {
      if (c.chart.hidden) return;
      C.heatmap(c.chart, {
        name: T.whenTitle, rtl: rtl(), cellSize: opts && opts.cellSize || 18, corner: '',
        rows: grid.map(function (row) { return { label: weekdayName(row.weekday, 'short') }; }),
        cols: hoursShown.map(function (hr, i) { return { label: hourText(hr), tick: hoursShown.length > 12 && i % 2 ? '' : String(hr).padStart(2, '0') }; }),
        value: function (ri, ci) { return grid[ri].cells[hoursShown[ci]].minutes; },
        tip: function (ri, ci) {
          var x = grid[ri].cells[hoursShown[ci]];
          return { title: weekdayName(grid[ri].weekday) + ' ' + hourText(x.hour), rows: [
            { value: minutesText(x.minutes), label: T.ofPlay, color: 'var(--q4)', swatch: 'bar' },
            { value: T.nVisits(x.visits) }, { value: I.short(x.perDay), label: T.visitsPerDay(x.occurrences) }] };
        },
        legend: legendOf(function (v) { return minutesText(v); })
      });
    });
    var cells = [];
    grid.forEach(function (row) { row.cells.forEach(function (x) { if (x.visits) cells.push([weekdayName(row.weekday), hourText(x.hour), minutesText(x.minutes), I.int(x.visits), I.short(x.perDay)]); }); });
    C.table(c.table, T.whenTitle, [{ label: T.weekday }, { label: T.hour }, { label: T.playTime, num: true }, { label: T.visits, num: true },
      { label: T.visitsPerDayCol, num: true }], cells);
  }
  function renderWhen(parent, hours) {
    var T = t(), sec = section(parent, 'when', T.whenTitle);
    var c = card(sec, 'when-card', null, T.whenSub, true);
    if (failed(hours)) { missing(c.chart, hours); return; }
    whenHeatmap(c, hours);
    note(c.foot, T.nightlyNote);
  }

  function renderFavourites(parent, k) {
    var T = t(), sec = section(parent, 'favourites', T.favTitle);
    var grid = h('div', { class: 'grid-2 grid-wide' }, sec);
    var fav = I.favourites(k);
    var c = card(grid, 'fav-card', null, T.favSub, true);
    var rows = top('fav', fav.rows);
    var max = fav.rows.length ? fav.rows[0].opens : 1;
    if (!fav.rows.length) note(c.chart, T.noData);
    else draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.favTitle, rtl: rtl(), color: 'var(--s1)', max: max, sub: false, rows: rows.map(function (g) {
        return { label: gameName(g.slug), value: g.opens, valueText: T.nOpens(g.opens),
          tip: { title: gameName(g.slug), rows: [
            { value: T.nOpens(g.opens), label: g.share != null ? '(' + I.pct(g.share) + ')' : '', color: 'var(--s1)', swatch: 'bar' },
            { value: T.nSessions(g.sessions) }, { value: minutesText(g.engagedMinutes), label: T.ofPlay }] } };
      }) });
    });
    moreButton(c.foot, 'fav', fav.rows.length);
    C.table(c.table, T.favTitle, [{ label: T.game }, { label: T.opens, num: true }, { label: T.share, num: true },
      { label: T.playSessions, num: true }, { label: T.playTime, num: true }],
    fav.rows.map(function (g) { return [gameName(g.slug), I.int(g.opens), I.pct(g.share), I.int(g.sessions), minutesText(g.engagedMinutes)]; }));
    // Favourite categories: minutes per category; a game in two categories counts in both.
    var cats = R.categories(k.games, INFO);
    var cc = card(grid, 'cat-card', T.catTitle, T.catSub, true);
    var cmax = cats.length ? cats[0].minutes : 1;
    if (!cats.length) note(cc.chart, T.noData);
    else draw(function () {
      if (cc.chart.hidden) return;
      C.barList(cc.chart, { name: T.catTitle, rtl: rtl(), color: 'var(--s1)', max: cmax || 1, rows: cats.map(function (x) {
        return { label: categoryName(x.id), value: x.minutes, valueText: minutesText(x.minutes),
          tip: { title: categoryName(x.id), rows: [{ value: minutesText(x.minutes), label: T.ofPlay, color: 'var(--s1)', swatch: 'bar' },
            { value: T.nOpens(x.opens) }, { value: T.nGames(x.games) }] } };
      }) });
    });
    C.table(cc.table, T.catTitle, [{ label: T.category }, { label: T.playTime, num: true }, { label: T.opens, num: true }, { label: T.gamesCol, num: true }],
      cats.map(function (x) { return [categoryName(x.id), minutesText(x.minutes), I.int(x.opens), I.int(x.games)]; }));
  }

  function levelName(l) { return gameName(l.slug) + ' · ' + I.levelLabel(l.id, state.lang); }

  function renderStuck(parent, k) {
    var T = t(), sec = section(parent, 'stuck', T.stuckTitle);
    var stuck = I.stuckLevels(k);
    var c = card(sec, 'stuck-card', null, T.stuckSub, true);
    var rows = stuck.rows.slice(0, 8);
    if (!rows.length) note(c.chart, T.stuckNone);
    else draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.stuckTitle, rtl: rtl(), color: 'var(--s3)', max: 1, track: true, rows: rows.map(function (l) {
        return { label: levelName(l), value: l.rate, valueText: I.pct(l.rate), sub: T.xOfY(l.quits, l.starts), chip: l.small ? chipText(l.starts) : null,
          tip: { title: levelName(l), note: l.small ? chipText(l.starts, true) : null, rows: [
            { value: I.pct(l.rate), label: T.leftUnfinished, color: 'var(--s3)', swatch: 'bar' }, { value: T.xOfY(l.quits, l.starts) }] } };
      }) });
    });
    C.table(c.table, T.stuckTitle, [{ label: T.game }, { label: T.level }, { label: T.leftUnfinished, num: true }, { label: T.tries, num: true }],
      stuck.rows.map(function (l) { return [gameName(l.slug), I.levelLabel(l.id, state.lang), I.pct(l.rate), T.xOfY(l.quits, l.starts)]; }));
  }

  // The difficulty grid (also on the Games tab and a game's page): every game, how its
  // rounds end, and its verdict.
  function difficulty(parent, k, opts) {
    var T = t(), o = opts || {};
    var grid = I.difficultyGrid(k);
    if (o.slugs) grid.rows = grid.rows.filter(function (r) { return o.slugs.indexOf(r.slug) >= 0; });
    var c = card(parent, o.id || 'diff-card', o.title || null, T.diffSub, true);
    var legend = h('ul', { class: 'legend', 'aria-label': T.howRoundsEnd }, c.chart);
    OUTCOMES.forEach(function (x) {
      var li = h('li', null, legend);
      h('span', { class: 'swatch' }, li).style.background = x[1];
      h('span', null, li, T.outcome[x[0]]);
    });
    var table = h('div', { class: 'diff-grid cols-1', role: 'table', 'aria-labelledby': parent.id + '-h' }, c.chart);
    var head = h('div', { class: 'diff-row diff-head', role: 'row' }, table);
    h('span', { role: 'columnheader', class: 'diff-game' }, head, T.game);
    h('span', { role: 'columnheader', class: 'diff-bar' }, head, T.howRoundsEnd);
    h('span', { role: 'columnheader', class: 'diff-cell' }, head, T.verdictCol);
    top(o.id || 'diff', grid.rows).forEach(function (r) {
      var row = h('div', { class: 'diff-row mark', role: 'row', 'data-slug': r.slug }, table);
      var nameCell = h('span', { role: 'rowheader', class: 'diff-game' }, row, gameName(r.slug));
      if (r.small) { nameCell.appendChild(document.createTextNode(' ')); chip(nameCell, r.tries); }
      var barCell = h('span', { role: 'cell', class: 'diff-bar' }, row);
      var oc = r.outcomes, total = oc.ended || 0;
      var parts = OUTCOMES.map(function (x) { return { value: oc[x[0]], color: x[1] }; });
      var barHost = h('span', { class: 'stack-host' }, barCell);
      draw(function () { if (!c.chart.hidden) C.stackedBar(barHost, parts, { rtl: rtl(), height: 10 }); });
      var tipRows = OUTCOMES.map(function (x) {
        return { value: total ? I.pct(oc[x[0]] / total) : '—', label: T.outcome[x[0]] + ' (' + I.int(oc[x[0]]) + ')', color: x[1], swatch: 'bar' };
      });
      // The bar's "won" is a share of every ending; the verdict compares wins with wins and losses.
      if (r.winRate != null) tipRows.push({ value: I.pct(r.winRate), label: T.winRate });
      var cell = h('span', { role: 'cell', class: 'diff-cell' }, row);
      verdictNode(cell, r.verdict, true);
      // One stop per row for the keyboard: how its rounds end and the verdict.
      C.interactive(row, { title: gameName(r.slug), rows: tipRows, note: T.nTries(r.tries) + ' · ' + verdictText(r.verdict, false) });
    });
    moreButton(c.foot, o.id || 'diff', grid.rows.length);
    var details = h('details', { class: 'rule' }, c.foot);
    h('summary', null, details, T.diffHow);
    h('p', null, details, T.diffRule);
    if (grid.byCompletion) h('p', null, details, T.diffRuleCompletion);
    // Table twin with every number, the win rate the verdict compares included.
    var columns = [{ label: T.game }, { label: T.tries, num: true }, { label: T.winRate, num: true }]
      .concat(OUTCOMES.map(function (x) { return { label: T.outcome[x[0]], num: true }; }))
      .concat([{ label: T.verdictCol }]);
    C.table(c.table, T.diffTitle, columns, grid.rows.map(function (r) {
      var oc = r.outcomes;
      return [gameName(r.slug), I.int(r.tries), I.pct(r.winRate)].concat(OUTCOMES.map(function (x) { return oc.ended ? I.pct(oc[x[0]] / oc.ended) : '—'; }))
        .concat([verdictText(r.verdict, true)]);
    }));
    return c;
  }
  ctx.difficulty = difficulty;
  function renderDifficulty(parent, k) { difficulty(section(parent, 'difficulty', t().diffTitle), k); }

  // Coming back: the share of each game's opens on a browser that had opened it before.
  function renderReturning(parent, k) {
    var T = t(), sec = section(parent, 'returning', T.backTitle);
    var back = I.returning(k, I.T.RETURN_MIN_OPENS);
    var c = card(sec, 'back-card', null, T.backSub, true);
    if (back.overall != null) {
      var lead = h('p', { class: 'lead' }, c.chart);
      h('strong', { class: 'lead-number' }, lead, I.pct(back.overall));
      lead.appendChild(document.createTextNode(' ' + T.backOverall));
    }
    var host = h('div', { class: 'chart-host' }, c.chart);
    var rows = top('back', back.rows);
    if (!rows.length) note(host, T.backNone);
    else draw(function () {
      if (c.chart.hidden) return;
      C.barList(host, { name: T.backTitle, rtl: rtl(), color: 'var(--s1)', max: 1, track: true, rows: rows.map(function (g) {
        return { label: gameName(g.slug), value: g.share, valueText: I.pct(g.share), sub: T.backDetail(g.back, g.opens),
          tip: { title: gameName(g.slug), rows: [{ value: I.pct(g.share), label: T.playedBefore, color: 'var(--s1)', swatch: 'bar' },
            { value: T.backDetail(g.back, g.opens) }] } };
      }) });
    });
    moreButton(c.foot, 'back', back.rows.length);
    C.table(c.table, T.backTitle, [{ label: T.game }, { label: T.playedBefore, num: true }, { label: T.opens, num: true }, { label: T.firstTime, num: true }],
      back.rows.map(function (g) { return [gameName(g.slug), I.pct(g.share), I.int(g.opens), I.int(g.opens - g.back)]; }));
  }
  ctx.whenHeatmap = whenHeatmap;

  // PC health summary: the headline tiles and the games with a problem; each PC on the PCs tab.
  function renderHealth(parent, k) {
    var T = t(), sec = section(parent, 'health', T.healthTitle);
    var health = I.pcHealth(k), o = health.overall;
    var tiles = h('div', { class: 'tiles tiles-small' }, sec);
    tile(tiles, 'smooth', T.smooth, o.smooth == null ? '—' : I.pct(o.smooth), '', T.smoothHint, o.smooth);
    tile(tiles, 'load', T.loadTime, o.loadMs == null ? '—' : I.seconds(o.loadMs), o.loadMs == null ? '' : T.secondsUnit, T.loadHint, o.loadMs);
    tile(tiles, 'slowInput', T.inputDelay, o.slowInput == null ? '—' : I.pct(o.slowInput), '', T.inputHint, o.slowInput);
    tile(tiles, 'fails', T.fails, o.fails == null ? '—' : I.int(o.fails), '', o.failRate == null ? '' : T.failsHint(I.short(o.failRate * 100)), o.fails);
    healthByGame(sec, health);
    link(h('p', { class: 'more-link' }, sec), '#/pcs', T.healthMore);
  }
  // By game: a table, problems first.
  function healthByGame(parent, health, id) {
    var T = t();
    var g = card(parent, id || 'game-health', T.byGame, T.byGameSub, false);
    var wrap = h('div', { class: 'table-wrap' }, g.chart);
    var tableEl = h('table', { class: 'data health' }, wrap);
    h('caption', { class: 'sr-only' }, tableEl, T.healthTitle + ': ' + T.byGame);
    var labels = [T.game, T.smooth, T.loadTime, T.inputDelay, T.fails, T.lookAt];
    var hr = h('tr', null, h('thead', null, tableEl));
    labels.forEach(function (label, i) { h('th', { scope: 'col', class: i && i < 5 ? 'num' : null }, hr, label); });
    var body = h('tbody', null, tableEl);
    top(id || 'health', health.rows).forEach(function (r) {
      var tr = h('tr', { 'data-slug': r.slug }, body);
      h('th', { scope: 'row' }, tr, gameName(r.slug));
      var cells = [
        [I.pct(r.smooth), r.flags.indexOf('choppy') >= 0], [secondsText(r.loadMs), r.flags.indexOf('slowLoad') >= 0],
        [I.pct(r.slowInput), r.flags.indexOf('slowInput') >= 0], [I.int(r.fails), r.flags.indexOf('fails') >= 0]];
      cells.forEach(function (cell, i) {
        var td = h('td', { class: 'num' + (cell[1] ? ' is-flagged' : ''), 'data-label': labels[i + 1] }, tr);
        if (cell[1]) { h('span', { class: 'flag-dot', 'aria-hidden': 'true' }, td); td.title = T.flag[['choppy', 'slowLoad', 'slowInput', 'fails'][i]]; }
        h('span', null, td, cell[0]);
      });
      var flags = h('td', { class: 'flags' }, tr);
      if (!r.flags.length) h('span', { class: 'flag-ok' }, flags, T.noProblem);
      r.flags.forEach(function (f) { flagChip(flags, T.flag[f]); });
    });
    moreButton(g.foot, id || 'health', health.rows.length);
    return g;
  }
  function flagChip(parent, text) {
    var flag = h('span', { class: 'flag' }, parent);
    var svg = C.s('svg', { viewBox: '0 0 24 24', class: 'flag-icon', 'aria-hidden': 'true' }, flag);
    C.s('path', { d: 'M12 4 3 19h18L12 4Z' }, svg);
    h('span', null, flag, text);
    return flag;
  }
  ctx.healthByGame = healthByGame;
  ctx.flagChip = flagChip;

  // ---- start ----------------------------------------------------------------------------
  var lastWidth = 0, resizeTimer = 0;
  function onResize() {
    var w = $('dash').clientWidth;
    if (Math.abs(w - lastWidth) < 2) return;
    lastWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { C.hideTip(); redrawCharts(); }, 120);
  }
  if (window.ResizeObserver) new ResizeObserver(onResize).observe($('dash'));
  else window.addEventListener('resize', onResize);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') C.hideTip(); });

  applyTheme();
  applyLang();
  $('demoLink').href = '?demo';
  $('demoSignIn').href = location.pathname;
  document.body.classList.remove('booting');
  if (state.demo || state.token) showDash();
  else showSignIn(null);
}());
