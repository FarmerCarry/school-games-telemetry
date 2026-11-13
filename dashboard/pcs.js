/*
 * The PCs tab (#/pcs): how the school PCs run the games. Data: GET /v1/admin/pcs (one
 * row per PC code that sends the new version) and /v1/admin/kpis (health per kind of
 * PC). A PC is named by the first 4 characters of its code; the teacher page on that
 * PC shows the whole code. Flags carry an icon and a label, never colour alone.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};

  tabs.pcs = {
    load: function (ctx) {
      return Promise.all([ctx.get('pcs', {}), ctx.part(ctx.get('kpis', {}))]).then(function (x) { return { pcs: x[0], kpis: x[1] }; });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, C = ctx.C;
      var pcs = R.pcRows(data.pcs);
      var sec = ctx.section(view, 'pcs-intro', T.tabs.pcs, T.introPcs);
      ctx.note(sec, T.findPc);
      var tsec = ctx.section(view, 'pcs-table', T.pcsTable);
      var box = h('div', { class: 'card', id: 'pcs-card' }, tsec);
      if (!pcs.length) ctx.note(box, T.pcsNone);
      else {
        var wrap = h('div', { class: 'table-wrap' }, box);
        var table = h('table', { class: 'data pcs' }, wrap);
        h('caption', { class: 'sr-only' }, table, T.pcsTable);
        var cols = [T.pcCol, T.lastSeen, T.playSessions, T.playTime, T.smooth, T.loadTime, T.inputDelay, T.fails, T.buildCol, T.lookAt];
        var hr = h('tr', null, h('thead', null, table));
        cols.forEach(function (label, i) { h('th', { scope: 'col', class: i >= 2 && i <= 7 ? 'num' : null }, hr, label); });
        var body = h('tbody', null, table);
        pcs.forEach(function (p) {
          var tr = h('tr', { 'data-pc': p.p }, body);
          h('th', { scope: 'row', dir: 'ltr' }, tr, p.label);
          h('td', null, tr, p.lastDay ? ctx.shortDay(p.lastDay) : '—');
          [I.int(p.sessions), ctx.minutesText(p.minutes || 0), I.pct(p.smoothShare), ctx.secondsText(p.avgLoadMs), I.pct(p.slowInputShare), I.int(p.errors)]
            .forEach(function (v, i) { h('td', { class: 'num', 'data-label': cols[i + 2] }, tr, v); });
          h('td', { dir: 'ltr', class: 'build' }, tr, p.build ? p.build.slice(0, 7) : '—');
          var flags = h('td', { class: 'flags' }, tr);
          if (!p.flags.length) h('span', { class: 'flag-ok' }, flags, T.noProblem);
          p.flags.forEach(function (f) { ctx.flagChip(flags, T.pcFlag[f]).title = T.pcFlagHint[f]; });
        });
        var flagged = pcs.filter(function (p) { return p.flags.length; }).length;
        ctx.note(box, T.pcsFlagged(flagged, pcs.length));
      }

      // Play per PC, and health per kind of PC.
      var grid = h('div', { class: 'grid-2' }, view);
      var c = ctx.card(grid, 'pc-play', T.playPerPc, T.playPerPcSub, true);
      var list = pcs.slice().sort(function (a, b) { return b.minutes - a.minutes || b.sessions - a.sessions || (a.label < b.label ? -1 : 1); });
      var max = list.length ? list[0].minutes || 1 : 1;
      if (!list.length) ctx.note(c.chart, T.pcsNone);
      else ctx.draw(function () {
        if (c.chart.hidden) return;
        C.barList(c.chart, { name: T.playPerPc, rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: ctx.top('pc-play', list).map(function (p) {
          return { label: T.pcLabel(p.label), value: p.minutes, valueText: ctx.minutesText(p.minutes),
            tip: { title: T.pcLabel(p.label), rows: [{ value: ctx.minutesText(p.minutes), label: T.ofPlay }, { value: ctx.t().nSessions(p.sessions) }, { value: T.nDays(p.days) }] } };
        }) });
      });
      ctx.moreButton(c.foot, 'pc-play', list.length, T.showAllPcs);
      C.table(c.table, T.playPerPc, [{ label: T.pcCol }, { label: T.playTime, num: true }, { label: T.playSessions, num: true }, { label: T.daysPlayed, num: true }],
        list.map(function (p) { return [p.label, ctx.minutesText(p.minutes), I.int(p.sessions), I.int(p.days)]; }));
      byType(ctx, grid, data.kpis);
    }
  };

  // By PC type: smooth motion per processor, memory and screen bucket.
  function byType(ctx, parent, k) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, h = ctx.h;
    var c = ctx.card(parent, 'type-card', T.byType, T.byTypeSub, true);
    if (ctx.failed(k)) { ctx.missing(c.chart, k); return; }
    var health = I.pcHealth(k);
    var panels = h('div', { class: 'multiples' }, c.chart);
    var typeRows = [];
    ['cores', 'memory', 'screen'].forEach(function (dim) {
      var p = h('div', { class: 'panel' }, panels);
      h('h4', { class: 'panel-title' }, h('div', { class: 'panel-head' }, p), T.dims[dim]);
      var items = health.devices[dim] || [];
      var host = h('div', { class: 'chart-host' }, p);
      items.forEach(function (d) {
        typeRows.push([T.dims[dim], I.deviceLabel(dim, d.value, ctx.lang()), I.int(d.sessions), I.pct(d.smooth), ctx.secondsText(d.loadMs), I.pct(d.slowInput)]);
      });
      if (!items.length) { ctx.note(host, T.noData); return; }
      ctx.draw(function () {
        if (c.chart.hidden) return;
        C.barList(host, { name: T.byType + ': ' + T.dims[dim], rtl: ctx.rtl(), color: 'var(--s1)', max: 1, track: true, sub: false,
          rows: items.map(function (d) {
            return { label: I.deviceLabel(dim, d.value, ctx.lang()), value: d.smooth || 0, valueText: I.pct(d.smooth),
              tip: { title: T.dims[dim] + ': ' + I.deviceLabel(dim, d.value, ctx.lang()), rows: [
                { value: I.pct(d.smooth), label: T.smooth, color: 'var(--s1)', swatch: 'bar' },
                { value: ctx.secondsText(d.loadMs), label: T.loadTime }, { value: I.pct(d.slowInput), label: T.inputDelay },
                { value: ctx.t().nSessions(d.sessions) }] } };
          }) });
      });
    });
    C.table(c.table, T.byType, [{ label: T.pcType }, { label: '' }, { label: T.playSessions, num: true }, { label: T.smooth, num: true },
      { label: T.loadTime, num: true }, { label: T.inputDelay, num: true }], typeRows);
  }
}());
