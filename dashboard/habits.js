/*
 * The Habits tab (#/habits): when and how long the school plays. Data: the r_stat rows
 * of GET /v1/admin/stats (hour, sesslen, games, flow: closed days only, so the charts
 * include play up to last night) and /v1/admin/kpis (launch sources). Play sessions are
 * anonymous: a session is play on one PC until the hand-over button or 20 quiet minutes.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var METRICS = ['hour', 'sesslen', 'games', 'flow'];

  tabs.habits = {
    nightly: true,
    load: function (ctx) {
      return Promise.all([ctx.get('stats', { metrics: METRICS }), ctx.get('kpis', {})])
        .then(function (x) { return { stats: x[0], kpis: x[1] }; });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R;
      var rows = R.statRows(data.stats);
      var sec = ctx.section(view, 'habits-intro', T.tabs.habits, T.introHabits);
      var box = h('div', { class: 'card insights-card', id: 'habit-insights' }, sec);
      ctx.sentences(box, I.researchInsights(habitFacts(ctx, rows), { lang: ctx.lang(), name: ctx.gameName, weekday: ctx.weekdayName }));

      // The full-size heatmap.
      var when = ctx.section(view, 'habits-when', T.whenTitle);
      var c = ctx.card(when, 'habits-heatmap', null, T.whenSub, true);
      ctx.whenHeatmap(c, data.stats, { lo: 6, hi: 18, cellSize: 22 });

      // Session length (and the old version's sessions on the same scale), games per session.
      var len = ctx.section(view, 'habits-length', T.lengthTitle);
      var grid = h('div', { class: 'grid-2' }, len);
      sessionLength(ctx, grid, rows);
      histogramCard(ctx, grid, 'games-card', T.gamesPerSession, T.gamesPerSessionSub, R.histogram(rows, 'games'), 'games', ctx.t().nSessions);

      flows(ctx, view, rows);
      sources(ctx, view, data.kpis);
    }
  };

  // The facts the Habits sentences are built from (insights.js researchInsights).
  function habitFacts(ctx, rows) {
    var R = ctx.R, r = ctx.range();
    var hours = R.weekHours(rows, { from: r.from, to: r.to, weekStart: ctx.weekStart() });
    var peak = null, all = 0;
    hours.forEach(function (row) { row.cells.forEach(function (c) { all += c.minutes; if (!peak || c.minutes > peak.minutes) peak = { weekday: row.weekday, hour: c.hour, minutes: c.minutes }; }); });
    var own = rows.filter(function (x) { return x.metric === 'sesslen'; });
    var median = R.quantile(R.histogram(own, 'sesslen'), 0.5);
    var n = own.reduce(function (a, x) { return a + x.n; }, 0);
    return { peak: peak && peak.minutes ? { weekday: peak.weekday, hour: peak.hour, share: all ? peak.minutes / all : null } : null,
      session: median ? { median: median.value, open: median.open, n: n } : null };
  }

  function bucketBars(ctx, hist, metric, countText, color) {
    var T = ctx.t(), I = ctx.I, R = ctx.R, total = hist.reduce(function (a, b) { return a + b.n; }, 0);
    return hist.map(function (b) {
      var label = R.bucketLabel(metric, b.k);
      return { tick: label, title: T.bucketTitle[metric](label), value: b.n,
        tip: { title: T.bucketTitle[metric](label), rows: [{ value: countText(b.n), label: total ? '(' + I.pct(b.n / total) + ')' : '', color: color || 'var(--s1)', swatch: 'bar' }] } };
    });
  }
  function histogramCard(ctx, parent, id, title, sub, hist, metric, countText) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var c = ctx.card(parent, id, title, sub, true);
    var total = hist.reduce(function (a, b) { return a + b.n; }, 0);
    if (!total) ctx.note(c.chart, T.noData);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: title, rtl: ctx.rtl(), color: 'var(--s1)', keysHint: T.keysColumns, format: function (v) { return I.int(v); }, bars: bucketBars(ctx, hist, metric, countText) });
    });
    var q = R.quantile(hist, 0.5, metric);
    if (q) ctx.note(c.foot, T.medianIs(T.bucketValue[metric](q.label && !q.open ? q.label : I.short(q.value)), q.open));
    C.table(c.table, title, [{ label: T.bucketCol[metric] }, { label: T.count, num: true }, { label: T.shareCol, num: true }],
      hist.map(function (b) { return [R.bucketLabel(metric, b.k), I.int(b.n), total ? I.pct(b.n / total) : '—']; }));
    return c;
  }

  // Session length: the sessions of the new version and of the old one as two panels on
  // one scale (the old version ends a session differently).
  function sessionLength(ctx, parent, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var c = ctx.card(parent, 'sesslen-card', T.sessLenTitle, T.sessLenSub, true);
    var kinds = [['3', T.newKind], ['2', T.oldKind]].map(function (k) {
      var own = rows.filter(function (x) { return x.metric === 'sesslen' && x.k2 === k[0]; });
      return { key: k[0], title: k[1], hist: R.histogram(own, 'sesslen') };
    }).filter(function (k) { return k.hist.some(function (b) { return b.n; }); });
    if (!kinds.length) { ctx.note(c.chart, T.noData); return; }
    ctx.draw(function () {
      if (c.chart.hidden) return;
      var hosts = C.multiples(c.chart, kinds.map(function (k) {
        var n = k.hist.reduce(function (a, b) { return a + b.n; }, 0);
        return { title: k.title, sub: ctx.t().nSessions(n), draw: 'columns', name: T.sessLenTitle + ': ' + k.title, bars: bucketBars(ctx, k.hist, 'sesslen', ctx.t().nSessions) };
      }), { rtl: ctx.rtl(), color: 'var(--s1)', height: 160, keysHint: T.keysColumns, format: function (v) { return I.int(v); } });
      kinds.forEach(function (k, i) { var q = R.quantile(k.hist, 0.5); if (q) ctx.h('p', { class: 'note' }, hosts[i], T.medianIs(T.bucketValue.sesslen(I.short(q.value)), q.open)); });
    });
    var table = [];
    kinds.forEach(function (k) { k.hist.forEach(function (b) { table.push([k.title, R.bucketLabel('sesslen', b.k), I.int(b.n)]); }); });
    C.table(c.table, T.sessLenTitle, [{ label: T.versionCol }, { label: T.bucketCol.sesslen }, { label: T.playSessions, num: true }], table);
  }

  // The top 10 game-to-game moves (bars "Road Hopper → Dino 3D"), no sankey.
  function flows(ctx, parent, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'habits-flows', T.flowsTop);
    var c = ctx.card(sec, 'flows-card', null, T.flowsTopSub, true);
    var edges = R.flows(rows, { games: true }).slice(0, 10);
    var max = edges.length ? edges[0].n : 1;
    var label = function (e) { return ctx.gameName(e.from) + ' → ' + ctx.gameName(e.to); };
    if (!edges.length) ctx.note(c.chart, T.noData);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.flowsTop, rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: edges.map(function (e) {
        return { label: label(e), value: e.n, valueText: T.nTimes(e.n), tip: { title: label(e), rows: [{ value: T.nTimes(e.n) }]
          .concat(e.gap == null ? [] : [{ value: T.secondsValue(I.short(e.gap)), label: T.flowGap }]) } };
      }) });
    });
    C.table(c.table, T.flowsTop, [{ label: T.fromGame }, { label: T.toGame }, { label: T.count, num: true }, { label: T.flowGap, num: true }],
      edges.map(function (e) { return [ctx.gameName(e.from), ctx.gameName(e.to), I.int(e.n), e.gap == null ? '—' : T.secondsValue(I.short(e.gap))]; }));
  }

  // How children find games: the share of game opens per launch source.
  function sources(ctx, parent, k) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var sec = ctx.section(parent, 'habits-sources', T.sourcesTitle);
    var c = ctx.card(sec, 'sources-card', null, T.sourcesSub, true);
    var list = (k.sources || []).filter(function (x) { return I.shown(x) && x.opens > 0; }).sort(function (a, b) { return b.opens - a.opens; });
    var all = list.reduce(function (a, x) { return a + x.opens; }, 0);
    if (!list.length) ctx.note(c.chart, T.noData);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.sourcesTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 1, track: true, rows: list.map(function (x) {
        return { label: T.source[x.src] || x.src, value: x.opens / all, valueText: I.pct(x.opens / all),
          tip: { title: T.source[x.src] || x.src, rows: [{ value: T.nOpens(x.opens) }, { value: ctx.t().nSessions(x.sessions) }] } };
      }) });
    });
    C.table(c.table, T.sourcesTitle, [{ label: T.sourceCol }, { label: T.opens, num: true }, { label: T.shareCol, num: true }, { label: T.playSessions, num: true }],
      list.map(function (x) { return [T.source[x.src] || x.src, I.int(x.opens), I.pct(x.opens / all), I.int(x.sessions)]; }));
  }
}());
