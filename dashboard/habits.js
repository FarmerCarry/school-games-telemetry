/*
 * The Habits tab (#/habits): when and how long children play. Data: the r_stat rows of
 * GET /v1/admin/stats (hour, sesslen, daymin, games, flow: closed days only, so the
 * charts include play up to last night), /v1/admin/kpis (launch sources and guest
 * minutes per day), /v1/admin/students (new and returning per week) and
 * /v1/admin/cohorts.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var METRICS = ['hour', 'sesslen', 'daymin', 'games', 'flow'];

  tabs.habits = {
    nightly: true,
    load: function (ctx) {
      var band = ctx.state.band;
      return Promise.all([
        ctx.get('stats', { band: band, metrics: METRICS }), ctx.get('kpis', { band: band }),
        ctx.part(ctx.get('students', { band: band })), ctx.part(ctx.get('cohorts', { band: band }))
      ]).then(function (x) { return { stats: x[0], kpis: x[1], students: x[2], cohorts: x[3] }; });
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

      // Session length (students and guests on one scale), minutes per student-day, games per session.
      var len = ctx.section(view, 'habits-length', T.lengthTitle);
      sessionLength(ctx, len, rows);
      var grid = h('div', { class: 'grid-2' }, len);
      histogramCard(ctx, grid, 'daymin-card', T.dayMinTitle, T.dayMinSub, R.histogram(rows, 'daymin'), 'daymin', T.nStudentDays);
      histogramCard(ctx, grid, 'games-card', T.gamesPerSession, T.gamesPerSessionSub, R.histogram(rows, 'games'), 'games', ctx.t().nSessions);

      var back = ctx.section(view, 'habits-back', T.newReturningTitle);
      ctx.newReturning(back, 'habits-weeks', data.students);
      cohorts(ctx, back, data.cohorts);

      flows(ctx, view, rows);
      sources(ctx, view, data.kpis);
      guests(ctx, view, data.kpis);
    }
  };

  // The facts the Habits sentences are built from (insights.js researchInsights).
  function habitFacts(ctx, rows) {
    var R = ctx.R, r = ctx.range();
    var hours = R.weekHours(rows, { from: r.from, to: r.to, weekStart: ctx.weekStart() });
    var peak = null, all = 0;
    hours.forEach(function (row) { row.cells.forEach(function (c) { all += c.minutes; if (!peak || c.minutes > peak.minutes) peak = { weekday: row.weekday, hour: c.hour, minutes: c.minutes }; }); });
    var own = rows.filter(function (x) { return x.metric === 'sesslen' && x.k2 === 's'; });
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

  // Session length: students and guests as two panels on one scale (and the old version's sessions).
  function sessionLength(ctx, parent, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var c = ctx.card(parent, 'sesslen-card', T.sessLenTitle, T.sessLenSub, true);
    var kinds = [['s', T.studentsKind], ['g', T.guestsKind], ['u', T.oldKind]].map(function (k) {
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
    C.table(c.table, T.sessLenTitle, [{ label: T.whoCol }, { label: T.bucketCol.sesslen }, { label: T.playSessions, num: true }], table);
  }

  function cohorts(ctx, parent, answer) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var c = ctx.card(parent, 'habits-cohorts', T.cohortTitle, T.cohortSub, true);
    if (ctx.failed(answer)) { ctx.missing(c.chart, answer); return; }
    var rows = R.cohortGrid(answer).filter(function (x) { return x.size > 0; });
    if (!rows.length) { ctx.note(c.chart, T.cohortNone); return; }
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.heatmap(c.chart, {
        name: T.cohortTitle, rtl: ctx.rtl(), cellSize: 34, minCell: 26, className: 'cohorts', corner: T.cohortStart,
        rows: rows.map(function (x) { return { label: ctx.shortDay(x.week) + ' · ' + I.int(x.size) }; }),
        cols: Array.from({ length: 13 }, function (_, k) { return { label: T.weekPlus(k), tick: '+' + k }; }),
        value: function (ri, k) { var x = rows[ri].cells[k]; return x ? x.share : null; },
        text: function (ri, k) { var x = rows[ri].cells[k]; return x && x.share != null ? I.pct(x.share).replace('%', '') : ''; },
        tip: function (ri, k) {
          var x = rows[ri], cell = x.cells[k];
          return { title: T.cohortRow(ctx.longDay(x.week), x.size), note: ctx.chipFor(x.size, null, true),
            rows: cell ? [{ value: I.pct(cell.share), label: T.cohortCell(k, cell.n, x.size), color: 'var(--q4)', swatch: 'bar' }] : [{ value: T.cohortNotYet }] };
        },
        legend: { low: function (v) { return I.pct(v); }, high: function (v) { return I.pct(v); }, empty: I.pct(0), none: T.cohortNotYet }
      });
    });
    C.table(c.table, T.cohortTitle, [{ label: T.cohortStart }, { label: T.studentsCol, num: true }].concat(Array.from({ length: 13 }, function (_, k) { return { label: '+' + k, num: true }; })),
      rows.map(function (x) { return [ctx.longDay(x.week), I.int(x.size)].concat(x.cells.map(function (cell) { return cell ? I.pct(cell.share) : '—'; })); }));
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

  // Guest share per week: the play time of guests (no animal picked) over all play time.
  function guests(ctx, parent, k) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'habits-guests', T.guestTitle);
    var c = ctx.card(sec, 'guest-card', null, T.guestSub, true);
    var byWeek = {};
    // Only the days with a guest count (the days before the update have none).
    (k.daily || []).forEach(function (d) {
      if (!I.shown(d) || !R.isDay(d.day) || !ctx.has(d.guestMinutes)) return;
      var w = R.weekOf(d.day, ctx.weekStart()), x = byWeek[w] || (byWeek[w] = { guests: 0, all: 0 });
      x.guests += d.guestMinutes || 0; x.all += d.engagedMinutes || 0;
    });
    var weeks = Object.keys(byWeek).sort().map(function (w) { return { week: w, share: byWeek[w].all ? byWeek[w].guests / byWeek[w].all : null, minutes: byWeek[w].guests }; });
    var any = (k.daily || []).some(function (d) { return ctx.has(d.guestMinutes); });
    if (!any) { ctx.note(c.chart, T.oldServer); return; }
    if (weeks.length < 2) ctx.note(c.chart, T.weeksNeedDays);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: T.guestTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 100, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
        bars: weeks.map(function (w) { return { tick: ctx.shortDay(w.week), title: T.weekOf(ctx.longDay(w.week)), value: w.share == null ? 0 : w.share * 100,
          tip: { title: T.weekOf(ctx.longDay(w.week)), rows: [{ value: I.pct(w.share), label: T.guestShareLabel, color: 'var(--s1)', swatch: 'bar' }, { value: ctx.minutesText(w.minutes), label: T.asGuests }] } }; }) });
    });
    ctx.note(c.foot, T.guestAdvice);
    C.table(c.table, T.guestTitle, [{ label: T.week }, { label: T.guestShareLabel, num: true }, { label: T.asGuests, num: true }],
      weeks.slice().reverse().map(function (w) { return [T.weekOf(ctx.longDay(w.week)), I.pct(w.share), ctx.minutesText(w.minutes)]; }));
  }
}());
