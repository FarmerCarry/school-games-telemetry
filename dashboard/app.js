/*
 * The insights dashboard: sign in, filters, data loading and the sections.
 * Data: GET /v1/admin/kpis and /v1/admin/live with the dashboard password as a
 * Bearer token (server/README.md). ?demo uses the bundled demo.json instead and
 * sends nothing. ?api=<origin> points the page at another server, only while the
 * page itself is opened from this computer (localhost), so a crafted link can
 * never send the password elsewhere. Game names come from names.js, written from
 * the games site's js/catalog.js by make-names.mjs; an unknown slug is shown as is.
 */
(function () {
  'use strict';
  var KPI_EVERY_MS = 5 * 60000, LIVE_EVERY_MS = 30000;
  var PERIODS = [1, 7, 30, 90], BANDS = ['all', '6-7', '8-9', '10-11'];
  var KEY = { lang: 'sg:dash:lang', theme: 'sg:dash:theme', token: 'sg:dash:token' };
  var TOP = 10;

  var I = window.SGInsights, C = window.SGCharts, TEXT = window.SGDashText, h = C.h;
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
    period: 30, band: 'all',
    kpis: null, live: null, kpisAt: null, liveAt: null,
    loading: false, seq: 0, notice: null, signinError: null,
    tables: {}, expanded: {},
    demoData: null
  };
  var t = function () { return TEXT[state.lang]; };
  var rtl = function () { return state.lang === 'ar'; };

  // ---- game names ---------------------------------------------------------------
  // Bundled in names.js (make-names.mjs). No script from another site ever runs here:
  // it could read the stored password.
  var BUNDLED = window.SG_GAME_NAMES || {};
  function gameName(slug) {
    var own = Object.prototype.hasOwnProperty.call(BUNDLED, slug) ? BUNDLED[slug] : null;
    return (own && own[state.lang === 'ar' ? 0 : 1]) || slug;
  }

  // ---- formatting ---------------------------------------------------------------
  var locale = function () { return state.lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB'; };
  function dayText(day, opts) {
    return new Intl.DateTimeFormat(locale(), Object.assign({ timeZone: 'UTC' }, opts)).format(new Date(day + 'T00:00:00Z'));
  }
  function timeText(date) {
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  function minutesText(m) { var d = I.duration(m, state.lang); return d.value + ' ' + d.unit; }
  function secondsText(ms) { return ms == null ? '—' : t().secondsValue(I.seconds(ms)); }
  var utcToday = function () { return new Date().toISOString().slice(0, 10); };
  var shiftDay = function (day, by) { return new Date(Date.parse(day + 'T00:00:00Z') + by * 86400000).toISOString().slice(0, 10); };

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
  function range() {
    var to = utcToday();
    return { from: shiftDay(to, -(state.period - 1)), to: to };
  }
  function Failure(kind, status) { this.kind = kind; this.status = status; }
  function request(path, token) {
    return fetch(api + path, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' })
      .catch(function () { throw new Failure('network'); })
      .then(function (res) {
        if (res.status === 401) throw new Failure('wrong', 401);
        if (res.status === 404) throw new Failure('notSet', 404);
        if (res.status === 429) throw new Failure('busy', 429);
        if (!res.ok) throw new Failure('server', res.status);
        return res.json().catch(function () { throw new Failure('server', res.status); });
      });
  }
  function kpiPath() {
    var r = range();
    return '/v1/admin/kpis?from=' + r.from + '&to=' + r.to + (state.band === 'all' ? '' : '&band=' + state.band);
  }
  function demoData() {
    if (state.demoData) return Promise.resolve(state.demoData);
    return fetch('demo.json', { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Failure('server', res.status);
      return res.json();
    }).then(function (data) { state.demoData = data; return data; }, function (e) { throw e instanceof Failure ? e : new Failure('network'); });
  }
  function getKpis(token) {
    if (state.demo) return demoData().then(function (d) { return d.kpis[state.period + '|' + state.band]; });
    return request(kpiPath(), token);
  }
  function getLive(token) {
    if (state.demo) return demoData().then(function (d) { return d.live; });
    return request('/v1/admin/live', token);
  }
  function failureText(f) {
    var T = t();
    if (f && f.kind === 'network') return T.errNetwork;
    if (f && f.kind === 'busy') return T.errBusy;
    if (f && f.kind === 'wrong') return T.errExpired;
    return T.errServer(f && f.status || '?');
  }

  // Loads the KPIs for the current filters; a newer request wins.
  function refreshKpis() {
    var seq = ++state.seq;
    state.loading = true;
    $('dash').classList.add('is-loading');
    $('dash').setAttribute('aria-busy', 'true');
    return getKpis(state.token).then(function (kpis) {
      if (seq !== state.seq) return;
      if (!kpis || !kpis.totals) throw new Failure('server', 200);
      // An unchanged answer (the 5-minute refresh, mostly) keeps the page, its focus and scroll.
      var json = JSON.stringify(kpis), same = !!state.kpis && json === state.kpisJson && !state.notice;
      state.kpis = kpis; state.kpisJson = json; state.kpisAt = new Date(); state.notice = null;
      if (same) { renderNotice(); return; }
      renderData();
    }, function (f) {
      if (seq !== state.seq) return;
      if (f && (f.kind === 'wrong' || f.kind === 'notSet')) { signOut(f.kind === 'wrong' ? 'expired' : 'notSet'); return; }
      state.notice = failureText(f);
      if (!state.kpis) renderData(); else renderNotice();
    }).then(function () {
      if (seq !== state.seq) return;
      state.loading = false;
      $('dash').classList.remove('is-loading');
      $('dash').removeAttribute('aria-busy');
    });
  }
  // An answer for a password that was signed out meanwhile is ignored.
  function refreshLive() {
    var token = state.token;
    return getLive(token).then(function (live) {
      if (token !== state.token) return;
      state.live = live; state.liveAt = new Date();
      renderLive();
    }, function (f) {
      if (token === state.token && !state.demo && f && f.kind === 'wrong') signOut('expired');
    });
  }

  // Timers pause while the page is hidden and catch up when it comes back.
  var timers = [];
  function startTimers() {
    stopTimers();
    timers.push(setInterval(function () { if (!document.hidden) refreshKpis(); }, KPI_EVERY_MS));
    timers.push(setInterval(function () { if (!document.hidden) refreshLive(); }, LIVE_EVERY_MS));
  }
  function stopTimers() { timers.forEach(clearInterval); timers = []; }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !timers.length) return;
    if (!state.kpisAt || Date.now() - state.kpisAt > KPI_EVERY_MS) refreshKpis();
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
    state.token = null; state.kpis = null; state.kpisJson = null; state.live = null; state.kpisAt = null; state.seq++;
    save(KEY.token, null);
    clearData();
    showSignIn(reason ? { kind: reason } : null);
  }
  function showDash(haveLive) {
    $('signin').hidden = true;
    $('dash').hidden = false;
    $('signOutBtn').hidden = state.demo;
    $('demoBanner').hidden = !state.demo;
    renderFilters();
    refreshKpis();
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
    renderFilters();
    if (state.kpis || state.notice) renderData();
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
    var next = document.querySelector('[data-focus="' + key + '"]');
    if (next) next.focus({ preventScroll: true });
  }

  // ---- filters ---------------------------------------------------------------------
  function segmented(host, label, items, current, onPick) {
    host.textContent = '';
    h('span', { class: 'filter-label', id: host.id + 'Label' }, host, label);
    var group = h('div', { class: 'seg', role: 'group', 'aria-labelledby': host.id + 'Label' }, host);
    items.forEach(function (item) {
      var b = h('button', { type: 'button', 'aria-pressed': String(item.value === current), 'data-value': String(item.value),
        'data-focus': host.id + ':' + item.value }, group, item.text);
      b.addEventListener('click', function () { if (item.value !== current) onPick(item.value); });
    });
  }
  function renderFilters() { keepFocus(drawFilters); }
  function drawFilters() {
    var T = t();
    segmented($('periodFilter'), T.period, PERIODS.map(function (p) { return { value: p, text: p === 1 ? T.today : T.days(p) }; }), state.period,
      function (p) { state.period = p; renderFilters(); refreshKpis(); });
    segmented($('bandFilter'), T.age, BANDS.map(function (b) { return { value: b, text: b === 'all' ? T.allAges : I.bandLabel(b, state.lang).replace(/ (سنوات|سنة)$/, '') }; }), state.band,
      function (b) { state.band = b; renderFilters(); refreshKpis(); });
    renderStatus();
  }
  function renderStatus() { keepFocus(drawStatus); }
  function drawStatus() {
    var T = t(), box = $('status');
    box.textContent = '';
    if (state.demo) h('span', { class: 'pill' }, box, T.demoTitle);
    if (state.kpisAt) h('span', { class: 'updated' }, box, T.updated(timeText(state.kpisAt)));
    var b = h('button', { type: 'button', class: 'btn-quiet', id: 'refreshBtn', 'data-focus': 'refresh' }, box, T.refresh);
    b.addEventListener('click', function () { refreshKpis(); refreshLive(); });
  }
  function renderNotice() {
    var box = $('notice');
    box.hidden = !state.notice;
    box.textContent = state.notice && state.kpisAt ? t().staleNote(state.notice, timeText(state.kpisAt)) : state.notice || '';
    renderStatus();
  }

  // ---- cards -----------------------------------------------------------------------
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
    var body = h('div', { class: 'card-body' }, root);
    var chart = h('div', { class: 'chart-host' }, body);
    var tableHost = h('div', { class: 'table-host', hidden: true }, body);
    var foot = h('figcaption', { class: 'card-foot' }, root);
    var api = { root: root, chart: chart, table: tableHost, foot: foot, body: body, head: head };
    if (withTable) {
      var on = !!state.tables[id];
      var b = h('button', { type: 'button', class: 'btn-quiet table-toggle', 'aria-pressed': String(on), 'aria-controls': id + '-body',
        'data-focus': 'table:' + id }, head, on ? T.showChart : T.showTable);
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
    return api;
  }
  function note(parent, text, cls) { return h('p', { class: 'note' + (cls ? ' ' + cls : '') }, parent, text); }
  function hiddenNote(parent, k, what) { if (k) note(parent, t().moreHidden(k, t()[what]), 'privacy'); }
  function moreButton(parent, id, total) {
    if (total <= TOP) return;
    var T = t(), open = !!state.expanded[id];
    var b = h('button', { type: 'button', class: 'btn-quiet more', 'aria-expanded': String(open), 'data-focus': 'more:' + id }, parent, open ? T.showFewer : T.showAll(total));
    b.addEventListener('click', function () { state.expanded[id] = !open; renderData(); });
  }
  var top = function (id, rows) { return state.expanded[id] ? rows : rows.slice(0, TOP); };

  // Charts are drawn to their card's width once the whole page is laid out (a panel
  // measured before its neighbours exist would be too wide); a resize redraws them.
  var drawers = [];
  function redrawCharts() { drawers.forEach(function (fn) { fn(); }); }
  function draw(fn) { drawers.push(fn); }

  function clearData() {
    drawers = [];
    ['insights', 'tiles', 'sections'].forEach(function (id) { $(id).textContent = ''; });
    C.hideTip();
  }

  // ---- render --------------------------------------------------------------------------
  function renderData() { keepFocus(drawData); }
  function drawData() {
    var T = t(), k = state.kpis, scrollY = window.scrollY;
    clearData();
    renderNotice();
    $('rangeText').textContent = '';
    if (!k) { note($('insights'), state.notice || T.loading); return; }
    var r = k.range || {};
    $('rangeText').textContent = (r.from === r.to ? T.rangeOne(dayText(r.from, { day: 'numeric', month: 'long', year: 'numeric' }))
      : T.range(dayText(r.from, { day: 'numeric', month: 'short' }), dayText(r.to, { day: 'numeric', month: 'short', year: 'numeric' }))) +
      ' · ' + (r.band && r.band !== 'all' ? I.bandLabel(r.band, state.lang) : T.allAges);
    renderInsights(k);
    renderTiles(k);
    var sections = $('sections');
    var totalsHidden = !I.shown(k.totals);
    if (totalsHidden || !k.totals.sessions) {
      note(sections, totalsHidden ? T.hiddenHint : T.emptyHint, 'empty');
      return;
    }
    renderDaily(sections, k);
    renderFavourites(sections, k);
    renderByAge(sections, k);
    renderStuck(sections, k);
    renderDifficulty(sections, k);
    renderReturning(sections, k);
    renderHealth(sections, k);
    redrawCharts();
    if (window.scrollY !== scrollY) window.scrollTo(window.scrollX, scrollY);
  }

  function section(parent, id, title) {
    var sec = h('section', { class: 'section', id: id, 'aria-labelledby': id + '-h' }, parent);
    h('h2', { class: 'section-title', id: id + '-h' }, sec, title);
    return sec;
  }

  var ICONS = {
    stuck: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v.5', hard: 'M12 3 2 21h20L12 3Zm0 6v5m0 3v.5',
    favourite: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
    favouriteBand: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
    health: 'M3 5h18v11H3zM8 20h8M12 16v4', returning: 'M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4',
    trend: 'M3 17l6-6 4 4 8-8M15 7h6v6', easy: 'M5 12l5 5 9-10', hidden: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
    empty: 'M4 12h16', quiet: 'M5 12l5 5 9-10'
  };
  function icon(parent, kind, cls) {
    var svg = C.s('svg', { viewBox: '0 0 24 24', class: 'icon ' + (cls || ''), 'aria-hidden': 'true' }, parent);
    C.s('path', { d: ICONS[kind] || ICONS.empty }, svg);
    return svg;
  }
  function renderInsights(k) {
    var box = $('insights'), list = I.insights(k, { lang: state.lang, name: gameName, today: utcToday() });
    var ol = h('ol', { class: 'insight-list' }, box);
    list.forEach(function (item) {
      var li = h('li', { class: 'insight', 'data-kind': item.kind }, ol);
      icon(li, item.kind);
      h('span', null, li, item.text);
    });
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
  function renderTiles(k) {
    var T = t(), box = $('tiles'), tot = k.totals;
    var hidden = !I.shown(tot);
    var dash = '—';
    tile(box, 'sessions', T.tileSessions, hidden ? dash : I.int(tot.sessions), '', hidden ? T.hiddenTile : T.tileSessionsHint, hidden ? null : tot.sessions);
    var d = hidden ? null : I.duration(tot.engagedMinutes, state.lang);
    tile(box, 'playTime', T.tilePlayTime, hidden ? dash : d.value, hidden ? '' : d.unit, hidden ? T.hiddenTile : T.tilePlayTimeHint, hidden ? null : tot.engagedMinutes);
    var per = hidden ? null : tot.avgEngagedMinutesPerSession;
    tile(box, 'perSession', T.tilePerSession, per == null ? dash : I.short(per), '', hidden ? T.hiddenTile : T.tilePerSessionHint, per);
    tile(box, 'opens', T.tileOpens, hidden ? dash : I.int(tot.gameOpens), '', hidden ? T.hiddenTile : T.tileOpensHint, hidden ? null : tot.gameOpens);
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
    if (!total) { number.textContent = '—'; el.setAttribute('data-value', ''); return; }
    if (!I.shown(total)) {
      number.textContent = '—'; el.setAttribute('data-value', '');
      hint.textContent = T.hiddenTile;
      return;
    }
    number.textContent = I.int(total.sessions);
    el.setAttribute('data-value', String(total.sessions));
    var games = (live.games || []).filter(function (g) { return I.shown(g) && g.sessions > 0; })
      .sort(function (a, b) { return b.sessions - a.sessions || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0); });
    hint.textContent = games.length ? T.nowTop(gameName(games[0].slug)) : T.tileNowHint;
    if (state.liveAt) el.title = T.nowChecked(timeText(state.liveAt));
  }

  // Daily activity: two separate charts, never a dual axis.
  function renderDaily(parent, k) {
    var T = t(), sec = section(parent, 'daily', T.dailyTitle);
    var grid = h('div', { class: 'grid-2' }, sec);
    var days = (k.daily || []).filter(Boolean);
    var hiddenDays = days.filter(function (d) { return !I.shown(d); }).length;
    var tick = function (day) { return days.length <= 7 ? dayText(day, { weekday: 'short', day: 'numeric' }) : dayText(day, { day: 'numeric', month: 'short' }); };
    var title = function (day) { return dayText(day, { weekday: 'long', day: 'numeric', month: 'long' }); };
    [['sessions', T.dailySessions, function (v) { return I.int(v); }, T.sessions],
      ['engagedMinutes', T.dailyMinutes, function (v) { return I.int(v); }, T.minutes]].forEach(function (spec, i) {
      var c = card(grid, i ? 'daily-minutes' : 'daily-sessions', spec[1], null, true);
      if (days.length < 7) { note(c.chart, T.dailyNeedsDays); }
      else {
        var points = days.map(function (d) { return { title: title(d.day), tick: tick(d.day), value: I.shown(d) ? d[spec[0]] || 0 : null }; });
        draw(function () {
          if (c.chart.hidden) return;
          C.lineChart(c.chart, { points: points, color: 'var(--s1)', rtl: rtl(), name: spec[1], format: spec[2], unit: '',
            hiddenText: T.hiddenPrivacy, keysHint: state.lang === 'ar' ? 'استخدم مفاتيح الأسهم لقراءة كل يوم.' : 'Use the arrow keys to read each day.' });
        });
      }
      if (hiddenDays) note(c.foot, T.hiddenDays(hiddenDays), 'privacy');
      C.table(c.table, spec[1], [{ label: T.day }, { label: spec[3], num: true }], days.slice().reverse().map(function (d) {
        return [title(d.day), I.shown(d) ? spec[2](d[spec[0]] || 0) : { text: T.hiddenPrivacy }];
      }));
    });
  }

  function renderFavourites(parent, k) {
    var T = t(), sec = section(parent, 'favourites', T.favTitle);
    var fav = I.favourites(k);
    var c = card(sec, 'fav-card', null, T.favSub, true);
    var rows = top('fav', fav.rows);
    var max = fav.rows.length ? fav.rows[0].opens : 1;
    if (!fav.rows.length) note(c.chart, T.noData);
    else draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.favTitle, rtl: rtl(), color: 'var(--s1)', max: max, sub: false, rows: rows.map(function (g) {
        return { label: gameName(g.slug), value: g.opens, valueText: T.nOpens(g.opens),
          tip: { title: gameName(g.slug), rows: [
            { value: T.nOpens(g.opens), label: g.share != null ? '(' + I.pct(g.share) + ')' : '', color: 'var(--s1)', swatch: 'bar' },
            { value: T.nSessions(g.sessions) },
            { value: minutesText(g.engagedMinutes), label: T.ofPlay }] } };
      }) });
    });
    moreButton(c.foot, 'fav', fav.rows.length);
    hiddenNote(c.foot, fav.hidden, 'games');
    C.table(c.table, T.favTitle, [{ label: T.game }, { label: T.opens, num: true }, { label: T.share, num: true },
      { label: T.playSessions, num: true }, { label: T.playTime, num: true }],
    fav.rows.map(function (g) { return [gameName(g.slug), I.int(g.opens), I.pct(g.share), I.int(g.sessions), minutesText(g.engagedMinutes)]; })
      .concat(fav.hidden ? [[{ text: T.moreHidden(fav.hidden, T.games), colspan: 5 }]] : []));
  }

  // Favourites by age: one small panel per age group, on the same scale.
  function renderByAge(parent, k) {
    var T = t(), sec = section(parent, 'by-age', T.byAgeTitle);
    // One age group chosen: its favourites are the list above.
    if (k.range && k.range.band && k.range.band !== 'all') {
      note(h('div', { class: 'card', id: 'age-card' }, sec), T.byAgeOne(I.bandLabel(k.range.band, state.lang)));
      return;
    }
    var groups = I.favouritesByBand(k, 5);
    var c = card(sec, 'age-card', null, T.byAgeSub, true);
    var max = 0;
    groups.forEach(function (g) { g.rows.forEach(function (r) { max = Math.max(max, r.share || 0); }); });
    var panels = h('div', { class: 'multiples' }, c.chart);
    if (!groups.length) note(panels, T.noData);
    groups.forEach(function (g) {
      var p = h('div', { class: 'panel' }, panels);
      var head = h('div', { class: 'panel-head' }, p);
      h('h4', { class: 'panel-title' }, head, I.bandLabel(g.band, state.lang));
      if (g.hidden) { note(p, T.hiddenTile, 'privacy'); return; }
      h('span', { class: 'panel-sub' }, head, T.nSessions(g.sessions));
      var host = h('div', { class: 'chart-host' }, p);
      if (!g.rows.length) { note(host, T.noData); return; }
      draw(function () {
        if (c.chart.hidden) return;
        C.barList(host, { name: T.byAgeTitle + ': ' + I.bandLabel(g.band, state.lang), rtl: rtl(), color: 'var(--s1)', max: max || 1, sub: false,
          rows: g.rows.map(function (r) {
            return { label: gameName(r.slug), value: r.share || 0, valueText: I.pct(r.share),
              tip: { title: gameName(r.slug), rows: [{ value: I.pct(r.share), label: T.ofGroupOpens, color: 'var(--s1)', swatch: 'bar' },
                { value: T.nOpens(r.opens) }].concat(r.engagedMinutes == null ? [] : [{ value: minutesText(r.engagedMinutes), label: T.ofPlay }]) } };
          }) });
      });
      if (g.hiddenGames) note(p, T.moreHidden(g.hiddenGames, T.games), 'privacy');
    });
    // Play time per age group and game, when the server reports it.
    var minutes = groups.some(function (g) { return g.rows.some(function (r) { return r.engagedMinutes != null; }); });
    var rows = [];
    groups.forEach(function (g) {
      if (g.hidden) { rows.push([I.bandLabel(g.band, state.lang), { text: T.hiddenPrivacy, colspan: minutes ? 4 : 3 }]); return; }
      g.rows.forEach(function (r) {
        rows.push([I.bandLabel(g.band, state.lang), gameName(r.slug), I.pct(r.share), I.int(r.opens)]
          .concat(minutes ? [r.engagedMinutes == null ? '—' : minutesText(r.engagedMinutes)] : []));
      });
    });
    C.table(c.table, T.byAgeTitle, [{ label: T.ageGroup }, { label: T.game }, { label: T.share, num: true }, { label: T.opens, num: true }]
      .concat(minutes ? [{ label: T.playTime, num: true }] : []), rows);
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
        return { label: levelName(l), value: l.rate, valueText: I.pct(l.rate), sub: T.xOfY(l.quits, l.starts),
          tip: { title: levelName(l), rows: [{ value: I.pct(l.rate), label: T.leftUnfinished, color: 'var(--s3)', swatch: 'bar' },
            { value: T.xOfY(l.quits, l.starts) }] } };
      }) });
    });
    hiddenNote(c.foot, stuck.hidden, 'levels');
    C.table(c.table, T.stuckTitle, [{ label: T.game }, { label: T.level }, { label: T.leftUnfinished, num: true }, { label: T.tries, num: true }],
      stuck.rows.map(function (l) { return [gameName(l.slug), I.levelLabel(l.id, state.lang), I.pct(l.rate), T.xOfY(l.quits, l.starts)]; }));
  }

  var VERDICT_ICON = { hard: 'M12 4 3 19h18L12 4Z', easy: 'M12 20 3 5h18L12 20Z', right: 'M5 12.5l4.5 4.5L19 7', few: 'M6 12h.01M12 12h.01M18 12h.01',
    none: 'M6 12h12', hidden: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z', missing: 'M6 12h12' };
  function verdictNode(parent, v, compact) {
    var T = t(), code = v.code;
    var el = h('span', { class: 'verdict v-' + code, 'data-verdict': code }, parent);
    var svg = C.s('svg', { viewBox: '0 0 24 24', class: 'verdict-icon', 'aria-hidden': 'true' }, el);
    C.s('path', { d: VERDICT_ICON[code] }, svg);
    h('span', { class: 'verdict-label' }, el, compact ? T.verdict[code] : T.verdictLong[code]);
    return el;
  }
  var OUTCOMES = [['won', 'var(--s1)'], ['lost', 'var(--s2)'], ['unfinished', 'var(--s3)'], ['other', 'var(--other)']];

  function renderDifficulty(parent, k) {
    var T = t(), sec = section(parent, 'difficulty', T.diffTitle);
    var grid = I.difficultyGrid(k);
    var c = card(sec, 'diff-card', null, T.diffSub, true);
    var cols = grid.perBand ? ['all'].concat(I.BANDS) : [grid.band];
    var colName = function (b) { return b === 'all' ? T.allAgesShort : I.bandLabel(b, state.lang); };
    var legend = h('ul', { class: 'legend', 'aria-label': T.howRoundsEnd }, c.chart);
    OUTCOMES.forEach(function (o) {
      var li = h('li', null, legend);
      h('span', { class: 'swatch' }, li).style.background = o[1];
      h('span', null, li, T.outcome[o[0]]);
    });
    var table = h('div', { class: 'diff-grid cols-' + cols.length, role: 'table', 'aria-labelledby': 'difficulty-h' }, c.chart);
    var head = h('div', { class: 'diff-row diff-head', role: 'row' }, table);
    h('span', { role: 'columnheader', class: 'diff-game' }, head, T.game);
    h('span', { role: 'columnheader', class: 'diff-bar' }, head, T.howRoundsEnd);
    cols.forEach(function (b) { h('span', { role: 'columnheader', class: 'diff-cell' }, head, colName(b)); });
    top('diff', grid.rows).forEach(function (r) {
      var row = h('div', { class: 'diff-row mark', role: 'row', 'data-slug': r.slug }, table);
      h('span', { role: 'rowheader', class: 'diff-game' }, row, gameName(r.slug));
      var barCell = h('span', { role: 'cell', class: 'diff-bar' }, row);
      var o = r.outcomes, total = o.ended || 0;
      var parts = OUTCOMES.map(function (x) { return { value: o[x[0]], color: x[1] }; });
      var barHost = h('span', { class: 'stack-host' }, barCell);
      draw(function () { if (!c.chart.hidden) C.stackedBar(barHost, parts, { rtl: rtl(), height: 10 }); });
      var tipRows = OUTCOMES.map(function (x) {
        return { value: total ? I.pct(o[x[0]] / total) : '—', label: T.outcome[x[0]] + ' (' + I.int(o[x[0]]) + ')', color: x[1], swatch: 'bar' };
      });
      // The bar's "won" is a share of every ending; the verdict compares wins with wins and losses.
      if (r.winRate != null) tipRows.push({ value: I.pct(r.winRate), label: T.winRate });
      var verdicts = [];
      cols.forEach(function (b) {
        var v = b === 'all' || b === grid.band ? r.verdict : r.cells[b] || { code: 'missing' };
        var cell = h('span', { role: 'cell', class: 'diff-cell', 'data-band': b }, row);
        h('span', { class: 'diff-cell-band', 'aria-hidden': 'true' }, cell, colName(b));
        verdictNode(cell, v, true);
        verdicts.push(colName(b) + ': ' + T.verdictLong[v.code]);
      });
      // One stop per row for the keyboard: how its rounds end and every verdict.
      C.interactive(row, { title: gameName(r.slug), rows: tipRows, note: T.nTries(r.tries) + ' · ' + verdicts.join(' · ') });
    });
    moreButton(c.foot, 'diff', grid.rows.length);
    hiddenNote(c.foot, grid.hidden, 'games');
    var details = h('details', { class: 'rule' }, c.foot);
    h('summary', null, details, state.lang === 'ar' ? 'كيف يُحسب الحكم؟' : 'How is this decided?');
    h('p', null, details, T.diffRule);
    if (grid.byCompletion) h('p', null, details, T.diffRuleCompletion);
    if (grid.bySessions) h('p', null, details, T.diffRuleSessions);
    // Table twin with every number, the win rate the verdicts compare included.
    var columns = [{ label: T.game }, { label: T.tries, num: true }, { label: T.winRate, num: true }]
      .concat(OUTCOMES.map(function (x) { return { label: T.outcome[x[0]], num: true }; }))
      .concat(cols.map(function (b) { return { label: b === 'all' ? T.allAgesShort : I.bandLabel(b, state.lang) }; }));
    C.table(c.table, T.diffTitle, columns, grid.rows.map(function (r) {
      var o = r.outcomes;
      return [gameName(r.slug), I.int(r.tries), I.pct(r.winRate)].concat(OUTCOMES.map(function (x) { return o.ended ? I.pct(o[x[0]] / o.ended) : '—'; }))
        .concat(cols.map(function (b) {
          var v = b === 'all' || b === grid.band ? r.verdict : r.cells[b] || { code: 'missing' };
          return v.code === 'hidden' ? { text: T.hiddenPrivacy } : T.verdict[v.code];
        }));
    }));
  }

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
    hiddenNote(c.foot, back.hidden, 'games');
    C.table(c.table, T.backTitle, [{ label: T.game }, { label: T.playedBefore, num: true }, { label: T.opens, num: true }, { label: T.firstTime, num: true }],
      back.rows.map(function (g) { return [gameName(g.slug), I.pct(g.share), I.int(g.opens), I.int(g.opens - g.back)]; }));
  }

  function renderHealth(parent, k) {
    var T = t(), sec = section(parent, 'health', T.healthTitle);
    var health = I.pcHealth(k), o = health.overall;
    var tiles = h('div', { class: 'tiles tiles-small' }, sec);
    tile(tiles, 'smooth', T.smooth, o.smooth == null ? '—' : I.pct(o.smooth), '', T.smoothHint, o.smooth);
    tile(tiles, 'load', T.loadTime, o.loadMs == null ? '—' : I.seconds(o.loadMs), o.loadMs == null ? '' : T.secondsUnit, T.loadHint, o.loadMs);
    tile(tiles, 'slowInput', T.inputDelay, o.slowInput == null ? '—' : I.pct(o.slowInput), '', T.inputHint, o.slowInput);
    tile(tiles, 'fails', T.fails, o.fails == null ? '—' : I.int(o.fails), '', o.failRate == null ? '' : T.failsHint(I.short(o.failRate * 100)), o.fails);

    // By PC type: smooth motion per processor, memory and screen bucket.
    var c = card(sec, 'type-card', T.byType, T.byTypeSub, true);
    var panels = h('div', { class: 'multiples' }, c.chart);
    var typeRows = [];
    ['cores', 'memory', 'screen'].forEach(function (dim) {
      var p = h('div', { class: 'panel' }, panels);
      h('h4', { class: 'panel-title' }, h('div', { class: 'panel-head' }, p), T.dims[dim]);
      var items = health.devices[dim] || [];
      var host = h('div', { class: 'chart-host' }, p);
      var shownItems = items.filter(function (d) { return !d.hidden; });
      var hiddenCount = items.length - shownItems.length;
      items.forEach(function (d) {
        typeRows.push(d.hidden ? [T.dims[dim], I.deviceLabel(dim, d.value, state.lang), { text: T.hiddenPrivacy, colspan: 4 }]
          : [T.dims[dim], I.deviceLabel(dim, d.value, state.lang), I.int(d.sessions), I.pct(d.smooth), secondsText(d.loadMs), I.pct(d.slowInput)]);
      });
      if (!shownItems.length) { note(host, hiddenCount ? T.hiddenTile : T.noData, hiddenCount ? 'privacy' : null); return; }
      draw(function () {
        if (c.chart.hidden) return;
        C.barList(host, { name: T.byType + ': ' + T.dims[dim], rtl: rtl(), color: 'var(--s1)', max: 1, track: true, sub: false,
          rows: shownItems.map(function (d) {
            return { label: I.deviceLabel(dim, d.value, state.lang), value: d.smooth || 0, valueText: I.pct(d.smooth),
              tip: { title: T.dims[dim] + ': ' + I.deviceLabel(dim, d.value, state.lang), rows: [
                { value: I.pct(d.smooth), label: T.smooth, color: 'var(--s1)', swatch: 'bar' },
                { value: secondsText(d.loadMs), label: T.loadTime }, { value: I.pct(d.slowInput), label: T.inputDelay },
                { value: T.nSessions(d.sessions) }] } };
          }) });
      });
      if (hiddenCount) note(p, T.moreHidden(hiddenCount, T.pcTypes), 'privacy');
    });
    C.table(c.table, T.byType, [{ label: T.pcType }, { label: '' }, { label: T.playSessions, num: true }, { label: T.smooth, num: true },
      { label: T.loadTime, num: true }, { label: T.inputDelay, num: true }], typeRows);

    // By game: a table, problems first.
    var g = card(sec, 'game-health', T.byGame, T.byGameSub, false);
    var wrap = h('div', { class: 'table-wrap' }, g.chart);
    var tableEl = h('table', { class: 'data health' }, wrap);
    h('caption', { class: 'sr-only' }, tableEl, T.healthTitle + ': ' + T.byGame);
    var labels = [T.game, T.smooth, T.loadTime, T.inputDelay, T.fails, T.lookAt];
    var hr = h('tr', null, h('thead', null, tableEl));
    labels.forEach(function (label, i) { h('th', { scope: 'col', class: i && i < 5 ? 'num' : null }, hr, label); });
    var body = h('tbody', null, tableEl);
    top('health', health.rows).forEach(function (r) {
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
      r.flags.forEach(function (f) {
        var chip = h('span', { class: 'flag' }, flags);
        var svg = C.s('svg', { viewBox: '0 0 24 24', class: 'flag-icon', 'aria-hidden': 'true' }, chip);
        C.s('path', { d: 'M12 4 3 19h18L12 4Z' }, svg);
        h('span', null, chip, T.flag[f]);
      });
    });
    moreButton(g.foot, 'health', health.rows.length);
    hiddenNote(g.foot, health.hidden, 'games');
  }

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
