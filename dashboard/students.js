/*
 * The Students tab (#/students) and a student's page (#/student/<code>).
 * Data: GET /v1/admin/students (canonical students of the period, each with 13 weeks
 * of minutes), /v1/admin/cohorts, /v1/admin/student (one student's days, hours,
 * games, weeks, rounds and sessions), and the school's persist rows from
 * /v1/admin/stats for "after a loss". Actions: POST /v1/admin/link, DELETE
 * /v1/admin/link, POST /v1/admin/forget (each asks twice). No ranks, no medals: the
 * table starts in code order and every column sorts both ways.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var PAGE = 50;
  // Minutes per student per week (lower bounds) for the histogram.
  var WEEK_BUCKETS = [0, 10, 20, 30, 45, 60, 90, 120, 180];
  var WHY = ['h', 'i', 'p', 'u'];

  // ---- the list ---------------------------------------------------------------------
  var list = { host: null, rows: null };   // the table, redrawn on a search without the rest of the page

  tabs.students = {
    load: function (ctx) {
      var band = ctx.state.band;
      return Promise.all([ctx.get('students', { band: band }), ctx.part(ctx.get('cohorts', { band: band }))])
        .then(function (x) { return { students: x[0], cohorts: x[1] }; });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, C = ctx.C;
      var students = (data.students.students || []).filter(function (s) { return s && typeof s.u === 'string'; });
      var sec = ctx.section(view, 'students-intro', T.tabs.students, T.introStudents);
      var r = ctx.range();
      if (!students.length) { ctx.note(sec, T.studentsNone, 'empty'); return; }
      var tiles = h('div', { class: 'tiles tiles-small' }, sec);
      var minutes = students.reduce(function (a, s) { return a + (s.minutes || 0); }, 0);
      ctx.tile(tiles, 'active', T.tileStudents, I.int(students.length), '', T.tileStudentsHint, students.length);
      ctx.tile(tiles, 'perStudent', T.minutesPerStudent, I.short(minutes / students.length), T.minutesUnit, T.minutesPerStudentHint, minutes / students.length);
      var linked = students.filter(function (s) { return (s.linked || []).length; }).length;
      ctx.tile(tiles, 'linked', T.linkedStudents, I.int(linked), '', T.linkedStudentsHint, linked);

      // Two histograms: minutes per student per week, and days played per week.
      var grid = h('div', { class: 'grid-2' }, view);
      var weeks = R.bucketize(R.studentWeeks(students, { from: r.from, to: r.to, weekStart: ctx.weekStart() }), WEEK_BUCKETS);
      histogram(ctx, grid, 'week-minutes', T.weekMinutesTitle, T.weekMinutesSub, weeks, function (b, i) {
        return i + 1 < WEEK_BUCKETS.length ? T.rangeMinutes(b.k, WEEK_BUCKETS[i + 1] - 1) : T.minutesOrMore(b.k);
      }, T.nStudentWeeks, function (b, i) { return i + 1 < WEEK_BUCKETS.length ? String(b.k) : b.k + '+'; }, true);
      var days = R.bucketize(R.daysPerWeek(students, { from: r.from, to: r.to, weekStart: ctx.weekStart() }), [1, 2, 3, 4, 5, 6, 7]);
      histogram(ctx, grid, 'week-days', T.weekDaysTitle, T.weekDaysSub, days, function (b) { return T.daysAWeek(b.k); }, T.nStudents,
        function (b) { return String(b.k); }, true);

      cohortCard(ctx, view, data.cohorts);

      // The table.
      var tsec = ctx.section(view, 'students-table', T.studentsTable);
      list.host = h('div', { class: 'card', id: 'students-card' }, tsec);
      list.rows = students;
      drawTable(ctx);
      ctx.note(tsec, T.twoPcsNote);
    },
    // A new search redraws only the table (the input keeps the keyboard).
    search: function (ctx) { if (list.host && list.host.isConnected) drawTable(ctx); }
  };

  // weekly: made from the students' weekly minutes (ctx.weeksShown says when they can be shown).
  function histogram(ctx, parent, id, title, sub, buckets, label, countText, tick, weekly) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var c = ctx.card(parent, id, title, sub, true);
    var shown = !weekly || ctx.weeksShown(c);
    if (!shown) buckets = [];
    var total = buckets.reduce(function (a, b) { return a + b.n; }, 0);
    if (shown && !total) ctx.note(c.chart, T.noData);
    else if (total) ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: title, rtl: ctx.rtl(), color: 'var(--s1)', keysHint: T.keysColumns, format: function (v) { return I.int(v); },
        bars: buckets.map(function (b, i) {
          return { tick: tick(b, i), title: label(b, i), value: b.n,
            tip: { title: label(b, i), rows: [{ value: countText(b.n), label: '(' + I.pct(b.n / total) + ')', color: 'var(--s1)', swatch: 'bar' }] } };
        }) });
    });
    C.table(c.table, title, [{ label: T.bucket }, { label: T.count, num: true }, { label: T.shareCol, num: true }],
      buckets.map(function (b, i) { return [label(b, i), I.int(b.n), total ? I.pct(b.n / total) : '—']; }));
    return c;
  }

  // The cohort triangle: students by the week they started, and the share of them
  // that played again in each week after.
  function cohortCard(ctx, parent, answer) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'cohorts', T.cohortTitle);
    var c = ctx.card(sec, 'cohort-card', null, T.cohortSub, true);
    if (ctx.failed(answer)) { ctx.missing(c.chart, answer); return; }
    var rows = R.cohortGrid(answer).filter(function (x) { return x.size > 0; });
    if (!rows.length) { ctx.note(c.chart, T.cohortNone); return; }
    var weeks = 13;
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.heatmap(c.chart, {
        name: T.cohortTitle, rtl: ctx.rtl(), cellSize: 34, minCell: 26, className: 'cohorts', corner: T.cohortStart,
        rows: rows.map(function (x) { return { label: ctx.shortDay(x.week) + ' · ' + I.int(x.size) }; }),
        cols: Array.from({ length: weeks }, function (_, k) { return { label: T.weekPlus(k), tick: '+' + k }; }),
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
    C.table(c.table, T.cohortTitle, [{ label: T.cohortStart }, { label: T.studentsCol, num: true }].concat(Array.from({ length: weeks }, function (_, k) { return { label: '+' + k, num: true }; })),
      rows.map(function (x) { return [ctx.longDay(x.week), I.int(x.size)].concat(x.cells.map(function (cell) { return cell ? I.pct(cell.share) : '—'; })); }));
  }

  // ---- the sortable table ----------------------------------------------------------------
  function columnsOf(ctx) {
    var T = ctx.t(), I = ctx.I, R = ctx.R;
    var perDay = function (s) { return s.days ? (s.minutes || 0) / s.days : 0; };
    return [
      { key: 'label', label: T.student, value: function (s) { return String(s.label || s.u); }, text: null },
      { key: 'band', label: T.age, value: function (s) { return ['6-7', '8-9', '10-11', 'unknown'].indexOf(s.band); }, text: function (s) { return I.bandLabel(s.band || 'unknown', ctx.lang()); } },
      { key: 'days', label: T.daysPlayed, num: true, value: function (s) { return s.days || 0; }, text: function (s) { return I.int(s.days); } },
      { key: 'sessions', label: T.playSessions, num: true, value: function (s) { return s.sessions || 0; }, text: function (s) { return I.int(s.sessions); } },
      { key: 'minutes', label: T.playTime, num: true, value: function (s) { return s.minutes || 0; }, text: function (s) { return ctx.minutesText(s.minutes || 0); } },
      { key: 'perDay', label: T.minutesPerDay, num: true, value: perDay, text: function (s) { return I.short(perDay(s)); } },
      { key: 'top', label: T.favouriteGame, value: function (s) { return s.top && s.top[0] ? ctx.gameName(s.top[0]) : ''; }, text: null },
      { key: 'games', label: T.gamesTried, num: true, value: function (s) { return s.games || 0; }, text: function (s) { return I.int(s.games); } },
      { key: 'won', label: T.winRate, num: true, value: function (s) { var w = R.winShare(s); return w == null ? -1 : w; }, text: function (s) { return I.pct(R.winShare(s)); } },
      { key: 'lastDay', label: T.lastPlayed, value: function (s) { return s.lastDay || ''; }, text: function (s) { return s.lastDay ? ctx.shortDay(s.lastDay) : '—'; } },
      { key: 'weekly', label: T.weeklyMinutes, value: null, text: null },
      { key: 'pcs', label: T.pcsCol, num: true, value: function (s) { return s.pcs || 0; }, text: function (s) { return I.int(s.pcs); } },
      { key: 'linked', label: T.linkedCol, value: function (s) { return (s.linked || []).length; }, text: function (s) { return (s.linked || []).length ? '🔗 ' + I.int(s.linked.length) : ''; } }
    ];
  }
  function drawTable(ctx) {
    ctx.keepFocus(function () { drawTableNow(ctx); });
  }
  function drawTableNow(ctx) {
    var T = ctx.t(), h = ctx.h, C = ctx.C, I = ctx.I, R = ctx.R, state = ctx.state;
    var host = list.host;
    host.textContent = '';
    var search = (state.search || '').trim();
    var rows = search ? R.findStudents(list.rows, search) : list.rows.slice();
    if (search && !R.codeQuery(search)) h('p', { class: 'note' }, host, T.codeSearchHint);
    var sort = state.sort.students || { key: 'label', dir: 1 };
    var cols = columnsOf(ctx), col = cols.filter(function (c) { return c.key === sort.key; })[0] || cols[0];
    rows.sort(function (a, b) {
      var x = col.value(a), y = col.value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || (a.u < b.u ? -1 : 1);
    });
    var pages = Math.max(1, Math.ceil(rows.length / PAGE)), page = Math.min(state.page.students || 0, pages - 1);
    var shown = rows.slice(page * PAGE, page * PAGE + PAGE);
    if (!rows.length) { h('p', { class: 'note' }, host, search ? T.codeNone(search) : T.studentsNone); return; }
    var wrap = h('div', { class: 'table-wrap' }, host);
    var table = h('table', { class: 'data students' }, wrap);
    h('caption', { class: 'sr-only' }, table, T.studentsTable);
    var hr = h('tr', null, h('thead', null, table));
    cols.forEach(function (c) {
      var th = h('th', { scope: 'col', class: c.num ? 'num' : null, 'aria-sort': c.key === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : null }, hr);
      if (!c.value) { th.textContent = c.label; return; }
      var b = h('button', { type: 'button', class: 'sort', 'data-focus': 'sort:' + c.key }, th, c.label);
      if (c.key === sort.key) h('span', { class: 'sort-mark', 'aria-hidden': 'true' }, b, sort.dir > 0 ? '▲' : '▼');
      b.addEventListener('click', function () {
        state.sort.students = { key: c.key, dir: c.key === sort.key ? -sort.dir : c.num || c.key === 'lastDay' ? -1 : 1 };
        state.page.students = 0;
        drawTable(ctx);
      });
    });
    var body = h('tbody', null, table);
    shown.forEach(function (s) {
      var tr = h('tr', { 'data-u': s.u }, body);
      cols.forEach(function (c, i) {
        var cell = h(i ? 'td' : 'th', { scope: i ? null : 'row', class: c.num ? 'num' : null }, tr);
        if (c.key === 'label') { ctx.studentLink(cell, s); if (s.removed) h('span', { class: 'chip' }, cell, T.removedChip); return; }
        if (c.key === 'top') { if (s.top && s.top[0]) ctx.gameLink(cell, s.top[0]); return; }
        if (c.key === 'weekly') {
          var w = (s.weekly || []).slice(-13).map(function (v) { return Number(v) || 0; });
          C.sparkline(cell, w, { label: T.weeklyLabel(w.map(function (v) { return I.short(v); }).join(', ')), rtl: ctx.rtl() });
          return;
        }
        cell.textContent = c.text(s);
      });
    });
    var pager = h('div', { class: 'pager' }, host);
    h('span', { class: 'pager-text', role: 'status' }, pager, T.showing(page * PAGE + 1, page * PAGE + shown.length, rows.length));
    if (pages > 1) {
      var prev = h('button', { type: 'button', class: 'btn-quiet', disabled: page === 0, 'data-focus': 'page:prev' }, pager, T.previous);
      var next = h('button', { type: 'button', class: 'btn-quiet', disabled: page >= pages - 1, 'data-focus': 'page:next' }, pager, T.next);
      prev.addEventListener('click', function () { state.page.students = page - 1; drawTable(ctx); });
      next.addEventListener('click', function () { state.page.students = page + 1; drawTable(ctx); });
    }
  }

  // ---- a student's page ---------------------------------------------------------------------
  tabs.student = {
    // The Data tab finds a code and opens the same panels (a: { student }).
    panels: { link: function (ctx, panel, a, close) { linkPanel(ctx, panel, a, close); }, forget: function (ctx, panel, a, close) { forgetPanel(ctx, panel, a, close); } },
    load: function (ctx) {
      var u = ctx.route().arg;
      return Promise.all([ctx.get('student', { u: u }), ctx.part(ctx.get('stats', { metrics: ['persist'] }))])
        .then(function (x) { return { student: x[0], school: x[1] }; });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, lang = ctx.lang();
      var a = data.student, s = a.student || { u: ctx.route().arg };
      var days = a.days || [], minutes = days.reduce(function (x, d) { return x + (d.minutes || 0); }, 0);
      var head = h('section', { class: 'section student-head', id: 'student-head', 'aria-labelledby': 'student-h' }, view);
      ctx.link(h('p', { class: 'back' }, head), '#/students', T.backToStudents);
      h('h2', { class: 'section-title', id: 'student-h' }, head, R.studentLabel(s, lang));
      var facts = [I.bandLabel(s.band || 'unknown', lang)];
      if (s.firstDay) facts.push(T.firstPlayed(ctx.dayText(s.firstDay, { day: 'numeric', month: 'short' })));
      facts.push(T.nDays(days.length), ctx.minutesText(minutes), T.nPcs((s.pcs || []).length));
      h('p', { class: 'student-facts' }, head, facts.join(' · '));
      var extra = [];
      if (s.profileMadeDay) extra.push(T.profileMade(ctx.dayText(s.profileMadeDay, { day: 'numeric', month: 'short', year: 'numeric' })));
      if (s.knownBefore) extra.push(T.knownBefore);
      if (s.removed) extra.push(T.removedOn(ctx.dayText(s.removed, { day: 'numeric', month: 'short', year: 'numeric' })));
      if (s.band && s.bandFirst && s.bandFirst !== s.band) extra.push(T.bandFirst(I.bandLabel(s.bandFirst, lang)));
      if ((s.pcs || []).length) extra.push(T.onPcs(s.pcs.join(', '), s.pcs.length));
      if (extra.length) h('p', { class: 'note' }, head, extra.join(' · '));
      actions(ctx, head, a);
      if (!days.length) { ctx.note(view, T.studentNoPlay, 'empty'); return; }

      var grid = h('div', { class: 'grid-2' }, view);
      weekColumns(ctx, grid, days);
      calendar(ctx, grid, days);
      hourColumns(ctx, grid, a.hours || []);
      gamesBars(ctx, grid, a.games || []);
      better(ctx, view, a);
      ddaSteps(ctx, view, a);
      afterLoss(ctx, view, a, data.school);
      recent(ctx, view, a.sessions || []);
    }
  };

  // Link, download, forget: each action asks twice before it changes anything.
  function actions(ctx, parent, a) {
    var T = ctx.t(), h = ctx.h, s = a.student;
    var box = h('div', { class: 'student-actions' }, parent);
    var panel = h('div', { class: 'action-panel', id: 'actionPanel', hidden: true }, parent);
    var open = function (fill) { panel.textContent = ''; panel.hidden = false; fill(panel); };
    var close = function () { panel.hidden = true; panel.textContent = ''; };
    var linkBtn = h('button', { type: 'button', class: 'btn-quiet', id: 'linkBtn', 'data-focus': 'act:link' }, box, T.linkAction);
    var csvBtn = h('button', { type: 'button', class: 'btn-quiet', id: 'csvBtn', 'data-focus': 'act:csv' }, box, cutRounds(a) ? T.csvLatest((a.rounds || []).length) : T.csvAction);
    var forgetBtn = h('button', { type: 'button', class: 'btn-quiet btn-danger', id: 'forgetBtn', 'data-focus': 'act:forget' }, box, T.forgetAction);
    csvBtn.addEventListener('click', function () { download(ctx, a); });
    linkBtn.addEventListener('click', function () { open(function (p) { linkPanel(ctx, p, a, close); }); });
    forgetBtn.addEventListener('click', function () { open(function (p) { forgetPanel(ctx, p, a, close); }); });
    // Codes linked into this one, each with its own unlink.
    if ((s.linked || []).length) {
      var linked = h('div', { class: 'linked-codes' }, parent);
      h('span', { class: 'filter-label' }, linked, T.linkedCodes);
      s.linked.forEach(function (code) {
        var item = h('span', { class: 'linked-code' }, linked);
        h('span', { dir: 'ltr' }, item, code.toUpperCase());
        var un = h('button', { type: 'button', class: 'btn-link', 'data-focus': 'unlink:' + code }, item, T.unlink);
        un.addEventListener('click', function () { open(function (p) { unlinkPanel(ctx, p, code, a, close); }); });
      });
    }
  }
  function demoBlock(ctx, panel, close) {
    if (!ctx.demo()) return false;
    ctx.note(panel, ctx.t().demoAction);
    ctx.h('button', { type: 'button', class: 'btn-quiet', 'data-focus': 'act:cancel' }, panel, ctx.t().cancel).addEventListener('click', close);
    return true;
  }
  function linkPanel(ctx, panel, a, close) {
    var T = ctx.t(), h = ctx.h, R = ctx.R, s = a.student;
    h('h3', { class: 'card-title' }, panel, T.linkTitle);
    h('p', { class: 'note' }, panel, T.linkIntro(R.studentLabel(s, ctx.lang())));
    if (demoBlock(ctx, panel, close)) return;
    var row = h('div', { class: 'field' }, panel);
    h('label', { for: 'linkSearch' }, row, T.codeSearch);
    var input = h('input', { id: 'linkSearch', type: 'search', dir: 'ltr', autocomplete: 'off', spellcheck: 'false', placeholder: T.codePlaceholder, 'data-focus': 'link:search' }, row);
    var results = h('div', { class: 'link-results', role: 'list' }, panel);
    var step = h('div', { class: 'link-step' }, panel);
    h('button', { type: 'button', class: 'btn-quiet', 'data-focus': 'act:cancel' }, panel, T.cancel).addEventListener('click', close);
    var all = null;
    ctx.get('students', {}).then(function (x) { all = (x.students || []).filter(function (o) { return o.u !== s.u; }); show(); },
      function (f) { ctx.note(results, ctx.failureText(f)); });
    function show() {
      results.textContent = '';
      if (!all) return;
      var found = R.findStudents(all, input.value).slice(0, 12);
      if (!input.value.trim()) return;
      if (!found.length) { ctx.note(results, R.codeQuery(input.value) ? T.codeNone(input.value.trim()) : T.codeSearchHint); return; }
      found.forEach(function (o) {
        var b = h('button', { type: 'button', class: 'btn-quiet link-pick', role: 'listitem', 'data-u': o.u, 'data-focus': 'link:' + o.u }, results,
          R.studentLabel(o, ctx.lang()) + ' · ' + ctx.I.bandLabel(o.band || 'unknown', ctx.lang()) + ' · ' + ctx.minutesText(o.minutes || 0));
        b.addEventListener('click', function () { confirmLink(o); });
      });
    }
    input.addEventListener('input', show);
    setTimeout(function () { input.focus(); }, 0);
    // First ask: what will happen. Second ask: are you sure.
    function confirmLink(o) {
      step.textContent = '';
      h('p', null, step, T.linkConfirm(R.studentLabel(o, ctx.lang()), R.studentLabel(s, ctx.lang())));
      var yes = h('button', { type: 'button', class: 'btn-quiet', id: 'linkYes', 'data-focus': 'link:yes' }, step, T.linkYes);
      yes.addEventListener('click', function () {
        step.textContent = '';
        h('p', { class: 'warn' }, step, T.linkSure);
        var sure = h('button', { type: 'button', class: 'btn-quiet btn-danger', id: 'linkSure', 'data-focus': 'link:sure' }, step, T.linkDo);
        sure.addEventListener('click', function () {
          sure.disabled = true;
          // The other code's play is added to this student: aliases(u_old = other, u_new = this).
          ctx.request('/v1/admin/link', 'POST', { u: o.u, to: s.u }).then(function () {
            panel.textContent = '';
            ctx.note(panel, T.linkDone, 'done');
            ctx.refreshView();
          }, function (f) { sure.disabled = false; ctx.note(step, ctx.failureText(f), 'field-error'); });
        });
        sure.focus();
      });
      yes.focus();
    }
  }
  function unlinkPanel(ctx, panel, code, a, close) {
    var T = ctx.t(), h = ctx.h;
    h('p', null, panel, T.unlinkConfirm(code.toUpperCase()));
    if (demoBlock(ctx, panel, close)) return;
    var yes = h('button', { type: 'button', class: 'btn-quiet btn-danger', 'data-focus': 'unlink:yes' }, panel, T.unlinkDo);
    h('button', { type: 'button', class: 'btn-quiet', 'data-focus': 'act:cancel' }, panel, T.cancel).addEventListener('click', close);
    yes.addEventListener('click', function () {
      yes.disabled = true;
      ctx.request('/v1/admin/link?u=' + encodeURIComponent(code), 'DELETE').then(function () {
        panel.textContent = ''; ctx.note(panel, T.unlinkDone, 'done'); ctx.refreshView();
      }, function (f) { yes.disabled = false; ctx.note(panel, ctx.failureText(f), 'field-error'); });
    });
    yes.focus();
  }
  function forgetPanel(ctx, panel, a, close) {
    var T = ctx.t(), h = ctx.h, R = ctx.R, s = a.student, label = R.studentLabel(s, ctx.lang());
    h('h3', { class: 'card-title' }, panel, T.forgetTitle(label));
    h('p', null, panel, T.forgetConfirm(label, (s.linked || []).length));
    if (demoBlock(ctx, panel, close)) return;
    var yes = h('button', { type: 'button', class: 'btn-quiet btn-danger', id: 'forgetYes', 'data-focus': 'forget:yes' }, panel, T.forgetYes);
    h('button', { type: 'button', class: 'btn-quiet', 'data-focus': 'act:cancel' }, panel, T.cancel).addEventListener('click', close);
    yes.addEventListener('click', function () {
      yes.remove();
      h('p', { class: 'warn' }, panel, T.forgetSure(label));
      var sure = h('button', { type: 'button', class: 'btn-quiet btn-danger', id: 'forgetSure', 'data-focus': 'forget:sure' }, panel, T.forgetDo);
      sure.addEventListener('click', function () {
        sure.disabled = true;
        ctx.request('/v1/admin/forget', 'POST', { u: s.u }).then(function (res) {
          var removed = res && res.removed || {};
          panel.textContent = '';
          ctx.note(panel, T.forgetDone(Number(removed.sessions) || 0, Number(removed.rounds) || 0), 'done');
          ctx.link(h('p', null, panel), '#/students', T.backToStudents);
          ctx.state.views = {};
        }, function (f) { sure.disabled = false; ctx.note(panel, ctx.failureText(f), 'field-error'); });
      });
      sure.focus();
    });
    yes.focus();
  }
  // Whether the server listed fewer ended rounds than the student's games add up to (it
  // lists the latest ones only).
  function cutRounds(a) {
    var listed = (a.rounds || []).filter(function (x) { return x.code; }).length;
    return listed < (a.games || []).reduce(function (k, g) { return k + (g.rounds || 0); }, 0);
  }
  // This student's rounds as a CSV file (UTF-8 with a byte-order mark, so Excel reads it);
  // the latest ones only when the server listed no more, and the name says so.
  function download(ctx, a) {
    var s = a.student, r = ctx.range();
    var head = ['day', 'time', 'game', 'level', 'outcome', 'engaged_ms', 'score', 'tier', 'dda_level', 'hits', 'misses', 'rt_mean_ms', 'attempt', 'minutes_into_session'];
    var outcome = { w: 'win', l: 'loss', d: 'draw', e: 'end', q: 'quit' };
    var cell = function (v) { if (v == null) return ''; var x = String(v); return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    var lines = [head.join(',')].concat((a.rounds || []).map(function (x) {
      return [x.day, x.time, x.slug, x.id, outcome[x.code] || '', x.ms, x.score, x.tier, x.dda, x.hits, x.misses, x.rtMean, x.attempt, x.minIntoSession].map(cell).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url;
    link.download = 'student-' + String(s.label || s.u).toLowerCase() + (cutRounds(a) ? '_latest' + (a.rounds || []).length : '') + '_' + r.from + '_' + r.to + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function weekColumns(ctx, parent, days) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R, r = ctx.range();
    var weeks = R.weeklyMinutes(days, { from: r.from, to: r.to, weekStart: ctx.weekStart() });
    var c = ctx.card(parent, 'student-weeks', T.minutesPerWeek, null, true);
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: T.minutesPerWeek, rtl: ctx.rtl(), color: 'var(--s1)', keysHint: T.keysColumns, format: function (v) { return ctx.minutesText(v); },
        bars: weeks.map(function (w) {
          return { tick: ctx.shortDay(w.week), title: T.weekOf(ctx.longDay(w.week)), value: w.minutes,
            tip: { title: T.weekOf(ctx.longDay(w.week)), rows: [{ value: ctx.minutesText(w.minutes), label: T.ofPlay, color: 'var(--s1)', swatch: 'bar' }] } };
        }) });
    });
    C.table(c.table, T.minutesPerWeek, [{ label: T.week }, { label: T.playTime, num: true }],
      weeks.slice().reverse().map(function (w) { return [T.weekOf(ctx.longDay(w.week)), ctx.minutesText(w.minutes)]; }));
  }
  function calendar(ctx, parent, days) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, r = ctx.range();
    var c = ctx.card(parent, 'student-calendar', T.calendarTitle, T.calendarSub, true);
    var items = days.map(function (d) {
      return { day: d.day, value: d.minutes || 0, tip: { title: ctx.longDay(d.day), rows: [{ value: ctx.minutesText(d.minutes || 0), label: T.ofPlay, color: 'var(--q4)', swatch: 'bar' },
        { value: ctx.t().nSessions(d.sessions || 0) }, { value: T.nRounds(d.rounds || 0) }] } };
    });
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.calendarStrip(c.chart, items, { name: T.calendarTitle, rtl: ctx.rtl(), from: r.from, to: r.to, weekStart: ctx.weekStart(),
        weekdayLabel: function (wd) { return ctx.weekdayName(wd, 'short'); }, weekLabel: function (w) { return T.weekOf(ctx.longDay(w)); },
        weekTick: function (w) { return ctx.shortDay(w); }, dayTitle: function (d) { return ctx.longDay(d); }, none: T.noPlayThatDay,
        legend: ctx.legendOf(function (v) { return ctx.minutesText(v); }) });
    });
    C.table(c.table, T.calendarTitle, [{ label: T.day }, { label: T.playTime, num: true }, { label: T.playSessions, num: true }, { label: T.rounds, num: true },
      { label: T.outcome.won, num: true }],
    days.slice().reverse().map(function (d) { return [ctx.longDay(d.day), ctx.minutesText(d.minutes || 0), I.int(d.sessions), I.int(d.rounds), I.int(d.w)]; }));
  }
  function hourColumns(ctx, parent, hours) {
    var T = ctx.t(), C = ctx.C;
    var c = ctx.card(parent, 'student-hours', T.hoursTitle, T.hoursSub, true);
    var lo = 7, hi = 16;
    hours.forEach(function (m, hr) { if (m > 0) { lo = Math.min(lo, hr); hi = Math.max(hi, hr); } });
    var shown = [];
    for (var hr = lo; hr <= hi; hr++) shown.push(hr);
    var hourText = function (x) { return String(x).padStart(2, '0') + ':00'; };
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: T.hoursTitle, rtl: ctx.rtl(), color: 'var(--s1)', keysHint: T.keysColumns, format: function (v) { return ctx.minutesText(v); },
        bars: shown.map(function (x) {
          return { tick: String(x).padStart(2, '0'), title: hourText(x), value: hours[x] || 0,
            tip: { title: hourText(x), rows: [{ value: ctx.minutesText(hours[x] || 0), label: T.ofPlay, color: 'var(--s1)', swatch: 'bar' }] } };
        }) });
    });
    C.table(c.table, T.hoursTitle, [{ label: T.hour }, { label: T.playTime, num: true }],
      shown.map(function (x) { return [hourText(x), ctx.minutesText(hours[x] || 0)]; }));
  }
  function gamesBars(ctx, parent, games) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var c = ctx.card(parent, 'student-games', T.gamesByMinutes, null, true);
    var rows = games.slice().sort(function (a, b) { return (b.minutes || 0) - (a.minutes || 0) || (a.slug < b.slug ? -1 : 1); });
    var max = rows.length ? rows[0].minutes || 1 : 1;
    var shown = ctx.top('student-games', rows);
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.gamesByMinutes, rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: shown.map(function (g) {
        var win = g.w + g.l ? g.w / (g.w + g.l) : null;
        return { label: ctx.gameName(g.slug), value: g.minutes || 0, valueText: ctx.minutesText(g.minutes || 0),
          tip: { title: ctx.gameName(g.slug), rows: [{ value: ctx.minutesText(g.minutes || 0), label: T.ofPlay, color: 'var(--s1)', swatch: 'bar' },
            { value: T.nRounds(g.rounds || 0) }, { value: I.pct(win), label: T.winRate }]
            .concat(g.bestScore != null ? [{ value: I.int(g.bestScore), label: T.bestScore }] : [])
            .concat(g.hearts ? [{ value: I.int(g.hearts), label: T.heartsCol }] : []) } };
      }) });
    });
    ctx.moreButton(c.foot, 'student-games', rows.length);
    C.table(c.table, T.gamesByMinutes, [{ label: T.game }, { label: T.playTime, num: true }, { label: T.rounds, num: true }, { label: T.winRate, num: true },
      { label: T.bestScore, num: true }, { label: T.heartsCol, num: true }],
    rows.map(function (g) {
      return [ctx.gameName(g.slug), ctx.minutesText(g.minutes || 0), I.int(g.rounds), I.pct(g.w + g.l ? g.w / (g.w + g.l) : null),
        g.bestScore == null ? '—' : I.int(g.bestScore), I.int(g.hearts || 0)];
    }));
  }

  // "Getting better?": the top 3 games, one measure each, by week or by attempt. By week
  // comes from the student's weekly sums (every round of the period); by attempt and the
  // sentence from the rounds the server lists, which are the latest ones only (cut: fewer
  // listed than the game's rounds). A sentence compares the first third of a game's tries
  // with the latest third only when all of them are listed, never when the measure fell
  // (no sentence says a child did worse), and with its chip under 20 tries a third.
  var MEASURE_ORDER = ['accuracy', 'score', 'winRate'];
  function better(ctx, parent, a) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'student-better', T.betterTitle, T.betterIntro);
    var c = ctx.card(sec, 'better-card', null, null, true);
    var by = ctx.choice(c.tools, 'betterBy', [{ value: 'week', text: T.byWeek }, { value: 'attempt', text: T.byAttempt }], 'week', T.showBy);
    var rounds = (a.rounds || []).filter(function (x) { return x.code; });
    var weekly = Array.isArray(a.weekly) ? a.weekly : null;
    var games = (a.games || []).filter(function (g) { return (g.rounds || 0) > 0; }).sort(function (x, y) { return (y.rounds || 0) - (x.rounds || 0) || (x.slug < y.slug ? -1 : 1); }).slice(0, 3);
    if (!games.length) { ctx.note(c.chart, T.noData); return; }
    var panels = [], tableRows = [];
    // Sums of a list of rounds, as the weekly rows have them.
    var sumOf = function (list) {
      var sum = { hits: 0, misses: 0, w: 0, l: 0, scoreSum: 0, scoreN: 0, rounds: list.length };
      list.forEach(function (x) { sum.hits += x.hits || 0; sum.misses += x.misses || 0; sum.w += +(x.code === 'w'); sum.l += +(x.code === 'l'); if (x.score != null) { sum.scoreSum += x.score; sum.scoreN++; } });
      return sum;
    };
    games.forEach(function (g) {
      var mine = rounds.filter(function (x) { return x.slug === g.slug; });
      var whole = mine.length >= (g.rounds || 0);
      var name = MEASURE_ORDER.filter(function (m) {
        return m === 'accuracy' ? g.hits + g.misses > 0 : m === 'score' ? g.bestScore != null : g.w + g.l > 0;
      })[0];
      if (!name) return;
      var value = function (sum) {
        return name === 'accuracy' ? (sum.hits + sum.misses ? sum.hits / (sum.hits + sum.misses) : null) : name === 'score' ? (sum.scoreN ? sum.scoreSum / sum.scoreN : null)
          : (sum.w + sum.l ? sum.w / (sum.w + sum.l) : null);
      };
      var groups = [];
      if (by === 'week' && weekly) {
        weekly.filter(function (w) { return w && w.slug === g.slug && w.rounds > 0 && R.isDay(w.week); }).sort(function (x, y) { return x.week < y.week ? -1 : 1; }).forEach(function (w) {
          groups.push({ tick: ctx.shortDay(w.week), title: T.weekOf(ctx.longDay(w.week)), sum: w });
        });
      } else if (by === 'week') {
        var weeks = {};
        mine.forEach(function (x) { var w = R.weekOf(x.day, ctx.weekStart()); (weeks[w] = weeks[w] || []).push(x); });
        Object.keys(weeks).sort().forEach(function (w) { groups.push({ tick: ctx.shortDay(w), title: T.weekOf(ctx.longDay(w)), sum: sumOf(weeks[w]) }); });
      } else {
        var buckets = R.BUCKETS.attempt, by2 = {};
        mine.forEach(function (x) { if (x.attempt == null) return; var b = buckets.filter(function (k) { return x.attempt >= k; }).pop(); (by2[b] = by2[b] || []).push(x); });
        buckets.forEach(function (b) { if (by2[b]) groups.push({ tick: R.bucketLabel('attempt', b), title: T.attemptTitle(R.bucketLabel('attempt', b)), sum: sumOf(by2[b]) }); });
      }
      var scale = name === 'score' ? 1 : 100;
      var fmt = function (v) { return name === 'score' ? I.short(v) : I.pct(v / 100); };
      var panel = { title: ctx.gameName(g.slug), sub: T.measureName[name], draw: 'line', name: ctx.gameName(g.slug) + ': ' + T.measureName[name],
        axis: name === 'score' ? null : function (v) { return v + '%'; },
        points: groups.map(function (x) { var v = value(x.sum); return { tick: x.tick, title: x.title, value: v == null ? null : v * scale,
          tip: { title: x.title, rows: [{ value: v == null ? '—' : fmt(v * scale), label: T.measureName[name], color: 'var(--s1)', swatch: 'line' }, { value: T.nRounds(x.sum.rounds) }] } }; }),
        format: fmt, empty: T.noData };
      panels.push(panel);
      groups.forEach(function (x) { var v = value(x.sum); tableRows.push([ctx.gameName(g.slug), T.measureName[name], x.title, v == null ? '—' : fmt(v * scale), ctx.I.int(x.sum.rounds)]); });
      // One plain sentence: the first third of the tries against the latest third.
      var sorted = mine.slice().sort(function (x, y) { return (x.attempt || 0) - (y.attempt || 0) || (x.day + x.time < y.day + y.time ? -1 : 1); });
      var third = Math.floor(sorted.length / 3);
      if (whole && third >= 3) {
        var first = value(sumOf(sorted.slice(0, third))), last = value(sumOf(sorted.slice(-third)));
        var from = first == null ? '' : fmt(first * scale), to = last == null ? '' : fmt(last * scale);
        if (from && to && !(last < first && from !== to)) {
          panel.sentence = T.betterSentence(ctx.gameName(g.slug), name, from, to, last > first && from !== to);
          panel.sentenceChip = ctx.chipFor(null, third);
        }
      }
    });
    if (cutRounds(a) && by === 'attempt') ctx.note(c.foot, T.betterLatest((a.rounds || []).length));
    ctx.draw(function () {
      if (c.chart.hidden) return;
      var hosts = C.multiples(c.chart, panels, { rtl: ctx.rtl(), color: 'var(--s1)', height: 140, shared: false, keysHint: T.keysSteps });
      hosts.forEach(function (host, i) {
        if (!panels[i].sentence) return;
        var p = ctx.h('p', { class: 'note' }, host, panels[i].sentence);
        if (panels[i].sentenceChip) { p.appendChild(document.createTextNode(' ')); ctx.h('span', { class: 'chip', 'data-small': 'true' }, p, panels[i].sentenceChip); }
      });
    });
    C.table(c.table, T.betterTitle, [{ label: T.game }, { label: T.measure }, { label: by === 'week' ? T.week : T.attempt }, { label: T.value, num: true }, { label: T.rounds, num: true }], tableRows);
  }

  // The DDA level by attempt, as a step line, for the adaptive games this student played.
  function ddaSteps(ctx, parent, a) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var rounds = (a.rounds || []).filter(function (x) { return x.dda != null && x.dda >= 0 && x.attempt != null; });
    var slugs = [];
    rounds.forEach(function (x) { if (slugs.indexOf(x.slug) < 0) slugs.push(x.slug); });
    if (!slugs.length) return;
    var sec = ctx.section(parent, 'student-dda', T.ddaTitle, T.ddaIntro);
    var c = ctx.card(sec, 'dda-card', null, null, true);
    var panels = slugs.map(function (slug) {
      var mine = rounds.filter(function (x) { return x.slug === slug; }).sort(function (x, y) { return x.attempt - y.attempt; });
      return { title: ctx.gameName(slug), draw: 'line', step: true, name: ctx.gameName(slug) + ': ' + T.ddaLevel,
        points: mine.map(function (x) { return { tick: String(x.attempt), title: T.attemptTitle(String(x.attempt)), value: x.dda / 10,
          tip: { title: T.attemptTitle(String(x.attempt)) + ' · ' + ctx.shortDay(x.day), rows: [{ value: I.short(x.dda / 10), label: T.ddaLevel, color: 'var(--s1)', swatch: 'line' }] } }; }) };
    });
    ctx.draw(function () { if (!c.chart.hidden) C.multiples(c.chart, panels, { rtl: ctx.rtl(), color: 'var(--s1)', height: 150, max: 100, keysHint: T.keysSteps, format: function (v) { return I.short(v); } }); });
    C.table(c.table, T.ddaTitle, [{ label: T.game }, { label: T.attempt, num: true }, { label: T.day }, { label: T.ddaLevel, num: true }],
      rounds.map(function (x) { return [ctx.gameName(x.slug), I.int(x.attempt), ctx.shortDay(x.day), I.short(x.dda / 10)]; }));
  }

  // After a loss: this student's same / level / game / stop next to the school's. The
  // student's counts follow lost rounds only, so the school's do too (not quits as well).
  function afterLoss(ctx, parent, a, school) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'student-after', T.afterLossTitle, T.afterLossIntro);
    var c = ctx.card(sec, 'after-card', null, null, true);
    var mine = R.persistShares(a.persist || {});
    var rows = [{ label: R.studentLabel(a.student, ctx.lang()), p: mine.shares, n: mine.n }];
    if (!ctx.failed(school)) {
      var all = R.persist(R.statRows(school), { codes: ['l'] });
      rows.push({ label: T.wholeSchool, p: all.shares, n: all.n });
    }
    var names = R.PERSIST.map(function (k) { return T.persist[k]; });
    if (!mine.n) ctx.note(c.chart, T.afterLossNone);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.stackRows(c.chart, { name: T.afterLossTitle, rtl: ctx.rtl(), colors: ctx.ORDINAL, legend: names, rows: rows.map(function (x) {
        return { label: x.label, chip: ctx.chipFor(null, x.n), valueText: T.nTimes(x.n), parts: R.PERSIST.map(function (k) { return { value: x.p[k] || 0 }; }),
          tip: { title: x.label, rows: R.PERSIST.map(function (k, i) { return { value: I.pct(x.p[k]), label: names[i], color: ctx.ORDINAL[i], swatch: 'bar' }; }) } };
      }) });
    });
    C.table(c.table, T.afterLossTitle, [{ label: '' }].concat(names.map(function (n) { return { label: n, num: true }; })).concat([{ label: T.count, num: true }]),
      rows.map(function (x) { return [x.label].concat(R.PERSIST.map(function (k) { return I.pct(x.p[k]); })).concat([I.int(x.n)]); }));
  }

  function recent(ctx, parent, sessions) {
    var T = ctx.t(), h = ctx.h, I = ctx.I;
    var sec = ctx.section(parent, 'student-sessions', T.recentTitle);
    var box = h('div', { class: 'card' }, sec);
    if (!sessions.length) { ctx.note(box, T.noData); return; }
    var rows = ctx.top('student-sessions', sessions, 20);
    var wrap = h('div', { class: 'table-wrap' }, box);
    var table = h('table', { class: 'data' }, wrap);
    h('caption', { class: 'sr-only' }, table, T.recentTitle);
    var hr = h('tr', null, h('thead', null, table));
    [T.day, T.schoolTime, T.pcCol, T.playTime, T.gamesInOrder, T.rounds, T.outcome.won, T.howEnded].forEach(function (l, i) {
      h('th', { scope: 'col', class: [3, 5, 6].indexOf(i) >= 0 ? 'num' : null }, hr, l);
    });
    var body = h('tbody', null, table);
    rows.forEach(function (x) {
      var tr = h('tr', null, body);
      h('th', { scope: 'row' }, tr, ctx.dayText(x.day, { weekday: 'short', day: 'numeric', month: 'short' }));
      h('td', { dir: 'ltr', class: 'time' }, tr, x.time || '');
      h('td', { dir: 'ltr' }, tr, x.pc || T.unknownPc);
      h('td', { class: 'num' }, tr, ctx.minutesText(x.minutes || 0));
      h('td', null, tr, (x.games || []).map(ctx.gameName).join(' → '));
      h('td', { class: 'num' }, tr, I.int(x.rounds));
      h('td', { class: 'num' }, tr, I.int(x.wins));
      h('td', null, tr, WHY.indexOf(x.why) >= 0 ? T.why[x.why] : '—');
    });
    ctx.moreButton(h('div', { class: 'card-foot' }, box), 'student-sessions', sessions.length, T.showAllSessions, 20);
  }
}());
