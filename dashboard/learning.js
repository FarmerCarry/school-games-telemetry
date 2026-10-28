/*
 * The Learning & difficulty tab (#/learning): are children getting better? For one
 * game (the picker) or "all measured games" (the games that count hits: accuracy and
 * reaction time). Data: the r_stat rows of GET /v1/admin/stats (attempt, fatigue,
 * persist), /v1/admin/kpis (the difficulty grid, reaction times per age
 * group) and /v1/admin/game for the games shown (paired same-student growth, tries
 * to a first win). Comparisons are associations: children choose their games.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var METRICS = ['attempt', 'fatigue', 'persist'];
  var BANDS = ['6-7', '8-9', '10-11'];
  var MAX_GAMES = 3;
  var RT = ['<300', '300–499', '500–799', '800–1199', '1200–1999', '2000+'];

  // The games that count hits (accuracy and reaction time), most played first.
  function measured(k) {
    return (k && k.games || []).filter(function (g) { return g && !g.suppressed && (g.hits || 0) + (g.misses || 0) > 0; })
      .sort(function (a, b) { return (b.rounds && b.rounds.starts || 0) - (a.rounds && a.rounds.starts || 0) || (a.slug < b.slug ? -1 : 1); })
      .map(function (g) { return g.slug; });
  }

  tabs.learning = {
    nightly: true,
    load: function (ctx) {
      var band = ctx.state.band, pick = ctx.state.game && ctx.state.game !== 'all' ? ctx.state.game : null;
      return ctx.get('kpis', { band: band }).then(function (k) {
        var targets = pick ? [pick] : measured(k).slice(0, MAX_GAMES);
        var bandKpis = band === 'all' ? BANDS.map(function (b) { return ctx.part(ctx.get('kpis', { band: b })); }) : [];
        return Promise.all([ctx.get('stats', { band: band, metrics: METRICS, slug: pick || undefined })]
          .concat(targets.map(function (slug) { return ctx.part(ctx.get('game', { slug: slug, band: band })); })).concat(bandKpis))
          .then(function (x) {
            var games = {};
            targets.forEach(function (slug, i) { games[slug] = x[1 + i]; });
            var byBand = {};
            if (band === 'all') BANDS.forEach(function (b, i) { byBand[b] = x[1 + targets.length + i]; });
            else byBand[band] = k;
            return { kpis: k, stats: x[0], targets: targets, games: games, byBand: byBand, pick: pick };
          });
      });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, S = tabs.shared;
      var rows = R.statRows(data.stats), k = data.kpis;
      var sec = ctx.section(view, 'learning-intro', T.tabs.learning, T.introLearning);
      var nMeasured = measured(k).length;
      ctx.note(sec, T.measuredIn(nMeasured));
      var box = h('div', { class: 'card insights-card', id: 'learning-insights' }, sec);
      ctx.sentences(box, I.researchInsights(learningFacts(ctx, data, rows), { lang: ctx.lang(), name: ctx.gameName, weekday: ctx.weekdayName }));

      // Skill growth by age: the same children at the start and the end of the period.
      var growth = ctx.section(view, 'learning-growth', T.growthTitle, T.growthIntro);
      if (!data.targets.length) ctx.note(growth, T.growthNone);
      data.targets.forEach(function (slug) {
        var game = data.games[slug];
        if (ctx.failed(game)) { ctx.missing(ctx.card(growth, 'growth-' + slug, ctx.gameName(slug), null, false).chart, game); return; }
        var own = R.pick(rows, 'attempt', { slug: slug });
        var name = R.measuresOf(own).filter(function (m) { return ['accuracy', 'winRate', 'score', 'reaction'].indexOf(m) >= 0; })[0] || 'winRate';
        S.pairedCard(ctx, growth, 'growth-' + slug, game.paired, name, ctx.gameName(slug) + ' · ' + T.measureName[name]);
      });

      // The difficulty grid.
      var diff = ctx.section(view, 'learning-difficulty', T.diffTitle);
      ctx.difficulty(diff, k, { id: 'learning-diff', slugs: data.pick ? [data.pick] : null });

      // DDA convergence: the level each age group settles at, by attempt.
      var dda = ctx.section(view, 'learning-dda', T.ddaConvergence, T.ddaConvergenceIntro);
      var ddaGames = [];
      R.pick(rows, 'attempt').forEach(function (r) { if (r.dda_n > 0 && ddaGames.indexOf(r.slug) < 0) ddaGames.push(r.slug); });
      ddaGames.sort();
      if (!ddaGames.length) ctx.note(dda, T.noDda);
      ddaGames.forEach(function (slug) {
        S.bandCurves(ctx, dda, 'dda-' + slug, ctx.gameName(slug), T.ddaByAttemptSub, R.curvesByBand(R.pick(rows, 'attempt', { slug: slug }), 'attempt', 'dda'), 'attempt', 'dda');
      });

      tiredness(ctx, view, rows, data.pick);
      persistence(ctx, view, rows, data.pick);
      hardest(ctx, view, data);
      reaction(ctx, view, data);
    }
  };

  // The facts the Learning sentences are built from (insights.js researchInsights).
  function learningFacts(ctx, data, rows) {
    var R = ctx.R, out = { growth: [], persist: [], tired: null, firstWin: [] };
    data.targets.forEach(function (slug) {
      var game = data.games[slug];
      if (ctx.failed(game)) return;
      var own = R.pick(rows, 'attempt', { slug: slug });
      R.measuresOf(own).filter(function (m) { return ['accuracy', 'winRate', 'reaction', 'score'].indexOf(m) >= 0; }).forEach(function (m) {
        var groups = R.paired(game.paired, m);
        Object.keys(groups).forEach(function (b) { if (b !== 'all') out.growth.push(Object.assign({ slug: slug, measure: m }, groups[b])); });
      });
      R.hardestLevels(game.firstWin).forEach(function (f) { if (f.median != null) out.firstWin.push(Object.assign({ slug: slug }, f)); });
    });
    out.persist = R.retryByGame(rows);
    var early = R.total(R.pick(rows, 'fatigue').filter(function (r) { return Number(r.k1) < 10; }));
    var late = R.total(R.pick(rows, 'fatigue').filter(function (r) { return Number(r.k1) >= 20; }));
    out.tired = { early: R.measure(early, 'winRate'), late: R.measure(late, 'winRate') };
    return out;
  }

  // School-wide tiredness: the win rate and the accuracy by minutes into the session.
  function tiredness(ctx, parent, rows, pick) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'learning-tired', T.tiredTitle, T.tiredIntro);
    var grid = ctx.h('div', { class: 'grid-2' }, sec);
    [['winRate', 'l-tired-win'], ['accuracy', 'l-tired-acc']].forEach(function (spec) {
      var pts = R.curve(rows, 'fatigue', spec[0], pick ? { slug: pick } : null).filter(function (p) { return p.value != null; });
      if (!pts.length) return;
      var title = T.tiredBy(T.measureName[spec[0]]);
      var c = ctx.card(grid, spec[1], title, null, true);
      ctx.draw(function () {
        if (c.chart.hidden) return;
        C.columns(c.chart, { name: title, rtl: ctx.rtl(), color: 'var(--s1)', max: 100, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
          bars: pts.map(function (p) { var label = R.bucketLabel('fatigue', p.k); return { tick: label, title: T.bucketTitle.fatigue(label), value: p.value * 100,
            tip: { title: T.bucketTitle.fatigue(label), note: ctx.chipFor(null, p.n, true), rows: [{ value: I.pct(p.value), label: T.measureName[spec[0]], color: 'var(--s1)', swatch: 'bar' }, { value: T.nTries(p.rounds) }] } }; }) });
      });
      C.table(c.table, title, [{ label: T.bucketCol.fatigue }, { label: T.measureName[spec[0]], num: true }, { label: T.tries, num: true }],
        pts.map(function (p) { return [R.bucketLabel('fatigue', p.k), I.pct(p.value), I.int(p.rounds)]; }));
    });
    if (!grid.children.length) ctx.note(sec, T.noData);
  }

  // Persistence by game: after a loss or leaving a round, the share that tried the same level again.
  function persistence(ctx, parent, rows, pick) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'learning-persist', T.persistTitle, T.persistIntro);
    var c = ctx.card(sec, 'persist-card', null, null, true);
    var list = R.retryByGame(rows).filter(function (g) { return !pick || g.slug === pick; });
    var shown = ctx.top('persist', list);
    if (!list.length) ctx.note(c.chart, T.noData);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.persistTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 1, track: true, rows: shown.map(function (g) {
        return { label: ctx.gameName(g.slug), value: g.share || 0, valueText: I.pct(g.share), sub: T.nTimes(g.n), chip: ctx.chipFor(null, g.n),
          tip: { title: ctx.gameName(g.slug), note: ctx.chipFor(null, g.n, true), rows: [{ value: I.pct(g.share), label: T.persist.same, color: 'var(--s1)', swatch: 'bar' },
            { value: I.pct(g.again), label: T.triedAgain }].concat(g.retryGap == null ? [] : [{ value: T.secondsValue(I.short(g.retryGap)), label: T.retryGapLabel }]) } };
      }) });
    });
    ctx.moreButton(c.foot, 'persist', list.length);
    C.table(c.table, T.persistTitle, [{ label: T.game }, { label: T.persist.same, num: true }, { label: T.triedAgain, num: true }, { label: T.count, num: true }, { label: T.retryGapLabel, num: true }],
      list.map(function (g) { return [ctx.gameName(g.slug), I.pct(g.share), I.pct(g.again), I.int(g.n), g.retryGap == null ? '—' : T.secondsValue(I.short(g.retryGap))]; }));
  }

  // The hardest levels across the games shown: those nobody has won yet first (the most
  // children who tried first), then the most tries to a first win.
  function hardest(ctx, parent, data) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R, lang = ctx.lang();
    var list = [];
    data.targets.forEach(function (slug) {
      var game = data.games[slug];
      if (!ctx.failed(game)) R.hardestLevels(game.firstWin).forEach(function (f) {
        if (f.median != null || (f.never > 0 && tabs.shared.winnable(data.kpis, slug, f.id))) list.push(Object.assign({ slug: slug }, f));
      });
    });
    list.sort(function (a, b) {
      return (b.median == null) - (a.median == null) || (a.median == null ? (b.neverShare || 0) - (a.neverShare || 0) || b.never - a.never : 0) ||
        (b.median || 0) - (a.median || 0) || (b.p75 || 0) - (a.p75 || 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) ||
        String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
    });
    var sec = ctx.section(parent, 'learning-hardest', T.hardestTitle, T.hardestIntro);
    var c = ctx.card(sec, 'hardest-card', null, null, true);
    var shown = list.slice(0, 10), max = Math.max.apply(null, shown.map(function (f) { return f.p75 || f.median || 0; }).concat([1]));
    var label = function (f) { return ctx.gameName(f.slug) + ' · ' + I.levelLabel(f.id, lang); };
    if (!shown.length) ctx.note(c.chart, T.hardestNone);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.hardestTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: shown.map(function (f) {
        return { label: label(f), value: f.median || 0, valueText: f.median == null ? T.noWinYet : T.nTries(Math.round(f.median)), sub: T.firstWinSubRow(f.p75 == null ? '—' : I.short(f.p75), f.never),
          chip: f.small ? ctx.chipText(f.students, null) : null,
          tip: { title: label(f), note: f.small ? ctx.chipText(f.students, null, true) : null, rows: [{ value: f.median == null ? '—' : I.short(f.median), label: T.medianTries, color: 'var(--s1)', swatch: 'bar' },
            { value: f.p75 == null ? '—' : I.short(f.p75), label: T.p75Tries }, { value: T.nStudents(f.students) }, { value: I.int(f.never), label: T.neverWon }] } };
      }) });
    });
    C.table(c.table, T.hardestTitle, [{ label: T.game }, { label: T.level }, { label: T.studentsCol, num: true }, { label: T.medianTries, num: true }, { label: T.p75Tries, num: true }, { label: T.neverWon, num: true }],
      list.map(function (f) { return [ctx.gameName(f.slug), I.levelLabel(f.id, lang), I.int(f.students), f.median == null ? '—' : I.short(f.median), f.p75 == null ? '—' : I.short(f.p75), I.int(f.never)]; }));
  }

  // Reaction time by age: the share of reactions in each time band, one panel per age group.
  function reaction(ctx, parent, data) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var sec = ctx.section(parent, 'learning-rt', T.rtTitle, T.rtIntro);
    var c = ctx.card(sec, 'rt-card', null, null, true);
    var targets = data.pick ? [data.pick] : measured(data.kpis);
    var panels = [], table = [];
    Object.keys(data.byBand).forEach(function (b) {
      var k = data.byBand[b];
      if (ctx.failed(k)) return;
      var rt = [0, 0, 0, 0, 0, 0];
      (k.games || []).forEach(function (g) { if (targets.indexOf(g.slug) >= 0) (g.rt || []).forEach(function (v, i) { if (i < 6) rt[i] += v || 0; }); });
      var all = rt.reduce(function (a, v) { return a + v; }, 0);
      if (!all) return;
      panels.push({ title: I.bandLabel(b, ctx.lang()), sub: T.nReactions(all), draw: 'columns', name: T.rtTitle + ': ' + I.bandLabel(b, ctx.lang()), chip: ctx.chipFor(null, all),
        bars: rt.map(function (v, i) { return { tick: RT[i], title: T.msBand(RT[i]), value: v / all * 100,
          tip: { title: T.msBand(RT[i]), rows: [{ value: I.pct(v / all), label: T.ofReactions, color: 'var(--s1)', swatch: 'bar' }, { value: T.nReactions(v) }] } }; }) });
      rt.forEach(function (v, i) { table.push([I.bandLabel(b, ctx.lang()), T.msBand(RT[i]), I.pct(v / all), I.int(v)]); });
    });
    if (!panels.length) { ctx.note(c.chart, T.rtNone); return; }
    ctx.draw(function () {
      if (!c.chart.hidden) C.multiples(c.chart, panels, { rtl: ctx.rtl(), color: 'var(--s1)', height: 150, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
        format: function (v) { return I.short(v) + '%'; } });
    });
    C.table(c.table, T.rtTitle, [{ label: T.ageGroup }, { label: T.reactionCol }, { label: T.shareCol, num: true }, { label: T.count, num: true }], table);
  }
}());
