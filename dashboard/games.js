/*
 * The Games tab (#/games: one card per game) and a game's page (#/game/<slug>).
 * Data: GET /v1/admin/kpis (the games, their levels and health) and
 * /v1/admin/game (age groups, days, the game's r_stat rows, tries to a first
 * win, paired same-student rows and the games before and after it). Band comparisons
 * are small multiples on one scale; won / lost / left unfinished keep s1 / s2 / s3;
 * the ordered "what happened next" stacks use the ordinal ramp.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var BANDS = ['6-7', '8-9', '10-11', 'unknown'];

  tabs.games = {
    load: function (ctx) { return ctx.get('kpis', { band: ctx.state.band }).then(function (k) { return { kpis: k }; }); },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, k = data.kpis;
      var sec = ctx.section(view, 'games-list', T.tabs.games, T.introGames);
      var games = (k.games || []).filter(I.shown);
      if (!games.length) { ctx.note(sec, T.noData, 'empty'); return; }
      var tools = h('div', { class: 'list-tools' }, sec);
      var by = ctx.choice(tools, 'gamesBy', [{ value: 'minutes', text: T.byMinutes }, { value: 'students', text: T.byStudents }, { value: 'name', text: T.byName }], 'minutes', T.sortBy);
      var value = { minutes: function (g) { return g.engagedMinutes || 0; }, students: function (g) { return g.students || 0; } };
      games.sort(function (a, b) {
        if (by === 'name') return ctx.gameName(a.slug).localeCompare(ctx.gameName(b.slug), ctx.lang());
        return value[by](b) - value[by](a) || (a.slug < b.slug ? -1 : 1);
      });
      var grid = h('ul', { class: 'game-cards' }, sec);
      var verdicts = {};
      I.difficultyGrid(k).rows.forEach(function (r) { verdicts[r.slug] = r.verdict; });
      games.forEach(function (g) {
        var li = h('li', { class: 'game-card', 'data-slug': g.slug }, grid);
        var a = h('a', { href: '#/game/' + encodeURIComponent(g.slug), class: 'game-card-link' }, li);
        h('span', { class: 'game-card-name' }, a, ctx.gameName(g.slug));
        var facts = [ctx.minutesText(g.engagedMinutes || 0), T.nOpens(g.opens || 0)];
        if (ctx.has(g.students)) facts.splice(1, 0, T.nStudents(g.students));
        h('span', { class: 'game-card-facts' }, a, facts.join(' · '));
        var v = verdicts[g.slug];
        if (v && v.code !== 'missing') ctx.verdictNode(h('span', { class: 'game-card-verdict' }, a), v, true);
        if (ctx.I.small(g.students, null)) ctx.chip(a, g.students, null);
      });
    }
  };

  // ---- a game's page -----------------------------------------------------------------
  tabs.game = {
    nightly: true,
    load: function (ctx) {
      var slug = ctx.route().arg, band = ctx.state.band;
      return Promise.all([ctx.get('kpis', { band: band }), ctx.part(ctx.get('game', { slug: slug, band: band }))])
        .then(function (x) { return { kpis: x[0], game: x[1] }; });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, slug = ctx.route().arg, k = data.kpis, game = data.game;
      var g = (k.games || []).filter(function (x) { return x.slug === slug && I.shown(x); })[0];
      var head = h('section', { class: 'section', id: 'game-head', 'aria-labelledby': 'game-h' }, view);
      ctx.link(h('p', { class: 'back' }, head), '#/games', T.backToGames);
      h('h2', { class: 'section-title', id: 'game-h' }, head, ctx.gameName(slug));
      var info = ctx.gameInfo(slug);
      if (info) h('p', { class: 'note' }, head, [info.cats.map(ctx.categoryName).join(' · '), T.players(info.players), T.inputStyle[info.input] || ''].filter(Boolean).join(' · '));
      if (!g) { ctx.note(view, T.gameNoPlay, 'empty'); return; }
      var rows = ctx.failed(game) ? [] : R.statRows(game.stats);
      tiles(ctx, head, k, g, rows, game);
      if (ctx.failed(game)) ctx.missing(view, game);
      else whoPlays(ctx, view, game);
      levels(ctx, view, k, slug, game);
      difficulty(ctx, view, k, slug, rows);
      if (!ctx.failed(game)) {
        better(ctx, view, slug, rows, game);
        after(ctx, view, rows);
        tired(ctx, view, rows);
      }
      comesFrom(ctx, view, g, game);
      if (!ctx.failed(game)) scores(ctx, view, slug, rows);
      pcs(ctx, view, k, slug);
    }
  };

  function tiles(ctx, parent, k, g, rows, game) {
    var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, has = ctx.has;
    var box = h('div', { class: 'tiles', id: 'game-tiles' }, parent);
    ctx.tile(box, 'students', T.tileStudents, has(g.students) ? I.int(g.students) : '—', '', T.gameStudentsHint, has(g.students) ? g.students : null);
    var d = I.duration(g.engagedMinutes || 0, ctx.lang());
    ctx.tile(box, 'minutes', T.tilePlayTime, d.value, d.unit, T.tilePlayTimeHint, g.engagedMinutes || 0);
    ctx.tile(box, 'opens', T.tileOpens, I.int(g.opens || 0), '', T.tileOpensHint, g.opens || 0);
    var perVisit = has(g.avgEngagedSecPerOpen) ? g.avgEngagedSecPerOpen / 60 : null;
    ctx.tile(box, 'perVisit', T.minutesPerVisit, perVisit == null ? '—' : I.short(perVisit), perVisit == null ? '' : T.minutesUnit, T.minutesPerVisitHint, perVisit);
    // Came back another day: the students who played it on 2 days or more (an older
    // server: the opens by children who had opened it before).
    var bands = !ctx.failed(game) && (game.bands || []).filter(function (b) { return has(b.twoDays) && has(b.students); });
    if (bands && bands.length) {
      var who = bands.reduce(function (a, b) { return a + b.students; }, 0), two = bands.reduce(function (a, b) { return a + b.twoDays; }, 0);
      ctx.tile(box, 'cameBack', T.cameBackDays, who ? I.pct(two / who) : '—', '', T.cameBackDaysHint(two, who), who ? two / who : null);
    } else {
      var back = I.returning({ games: [g] }, 1).rows[0];
      ctx.tile(box, 'cameBack', T.cameBack, back ? I.pct(back.share) : '—', '', T.cameBackHint, back ? back.share : null);
    }
    var hearts = g.hearts ? (g.hearts.on || 0) - (g.hearts.off || 0) : null;
    ctx.tile(box, 'hearts', T.heartsCol, hearts == null ? '—' : I.int(hearts), '', hearts == null ? '' : T.heartsHint(g.hearts.on || 0, g.hearts.off || 0), hearts);
    // A bounce: a visit under 30 seconds with no finished round (closed days only).
    var visits = R.pick(rows, 'visitlen'), all = visits.reduce(function (a, r) { return a + r.n; }, 0);
    var bounced = visits.filter(function (r) { return r.k2 === '0' && Number(r.k1) < 30; }).reduce(function (a, r) { return a + r.n; }, 0);
    ctx.tile(box, 'bounce', T.bounceRate, all ? I.pct(bounced / all) : '—', '', T.bounceHint, all ? bounced / all : null);
  }

  // Who plays it: students and minutes per age group, and students per day.
  function whoPlays(ctx, parent, game) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var sec = ctx.section(parent, 'game-who', T.whoPlays);
    var c = ctx.card(sec, 'who-card', null, T.whoPlaysSub, true);
    var bands = (game.bands || []).filter(function (b) { return BANDS.indexOf(b.band) >= 0; })
      .sort(function (a, b) { return BANDS.indexOf(a.band) - BANDS.indexOf(b.band); });
    var panels = C.h('div', { class: 'multiples' }, c.chart);
    [['students', T.studentsCol, function (v) { return I.int(v); }], ['minutes', T.playTime, function (v) { return ctx.minutesText(v); }]].forEach(function (spec) {
      var p = C.h('div', { class: 'panel' }, panels);
      C.h('h4', { class: 'panel-title' }, C.h('div', { class: 'panel-head' }, p), spec[1]);
      var host = C.h('div', { class: 'chart-host' }, p);
      var max = Math.max.apply(null, bands.map(function (b) { return b[spec[0]] || 0; }).concat([1]));
      if (!bands.length) { ctx.note(host, T.noData); return; }
      ctx.draw(function () {
        if (c.chart.hidden) return;
        C.barList(host, { name: T.whoPlays + ': ' + spec[1], rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: bands.map(function (b) {
          return { label: I.bandLabel(b.band, ctx.lang()), value: b[spec[0]] || 0, valueText: spec[2](b[spec[0]] || 0),
            chip: spec[0] === 'students' && b.students ? ctx.chipFor(b.students, null) : null,
            tip: { title: I.bandLabel(b.band, ctx.lang()), rows: [{ value: T.nStudents(b.students || 0) }, { value: ctx.minutesText(b.minutes || 0), label: T.ofPlay }, { value: T.nOpens(b.opens || 0) }] } };
        }) });
      });
    });
    C.table(c.table, T.whoPlays, [{ label: T.ageGroup }, { label: T.studentsCol, num: true }, { label: T.playTime, num: true }, { label: T.opens, num: true }],
      bands.map(function (b) { return [I.bandLabel(b.band, ctx.lang()), I.int(b.students), ctx.minutesText(b.minutes || 0), I.int(b.opens)]; }));
    // The game answer counts from the update day: the days before it would read 0.
    var cut = ctx.cutover();
    var days = (game.daily || []).filter(function (x) { return x && (!cut || x.day >= cut.factsSince); });
    var d = ctx.card(sec, 'game-daily', T.studentsPerDay0, null, true);
    if (cut && days.length < 2) ctx.note(d.chart, T.noData);
    else if (!cut && days.length < 7) ctx.note(d.chart, T.dailyNeedsDays);
    else ctx.draw(function () {
      if (d.chart.hidden) return;
      C.lineChart(d.chart, { name: T.studentsPerDay0, rtl: ctx.rtl(), color: 'var(--s1)', height: 160, keysHint: T.keysDays, format: function (v) { return I.int(v); },
        points: days.map(function (x) { return { tick: ctx.shortDay(x.day), title: ctx.longDay(x.day), value: x.students || 0 }; }) });
    });
    C.table(d.table, T.studentsPerDay0, [{ label: T.day }, { label: T.studentsCol, num: true }, { label: T.playTime, num: true }, { label: T.opens, num: true }],
      days.slice().reverse().map(function (x) { return [ctx.longDay(x.day), I.int(x.students), ctx.minutesText(x.minutes || 0), I.int(x.opens)]; }));
  }

  var natural = function (a, b) { return String(a.id).localeCompare(String(b.id), 'en', { numeric: true }); };
  // A level children can win: some round of it was won or lost in the period (an endless
  // mode only ends, so nobody wins it by design).
  function winnable(k, slug, id) {
    var l = (k && k.levels || []).filter(function (x) { return x && x.slug === slug && String(x.id) === String(id); })[0], cd = l && l.codes || {};
    return (cd.w || 0) + (cd.l || 0) > 0;
  }
  // Level by level: how many children reach each level, how its rounds end, and the
  // tries to a first win.
  function levels(ctx, parent, k, slug, game) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R, lang = ctx.lang();
    var list = (k.levels || []).filter(function (l) { return l.slug === slug && I.shown(l); }).sort(natural);
    var sec = ctx.section(parent, 'game-levels', T.levelByLevel);
    if (list.length < 2) { ctx.note(ctx.card(sec, 'funnel-card', null, null, false).chart, T.oneLevel); }
    else {
      // The children of each level: the game answer's first-win rows count each child once.
      // (The KPI answer's level students are summed day by day: a child on two days counts
      // twice.) Without them for every level, the funnel is drawn by tries.
      var who = {};
      if (!ctx.failed(game)) (game.firstWin || []).forEach(function (f) { if (f && ctx.has(f.students)) who[f.id] = f.students; });
      // (Not in a period that reaches back before the update: those rows start then, the tries do not.)
      var byStudents = !ctx.cutover() && list.every(function (l) { return ctx.has(who[l.id]); });
      var students = function (l) { return byStudents ? who[l.id] : null; };
      var c = ctx.card(sec, 'funnel-card', T.funnelTitle, byStudents ? T.funnelSub : T.funnelSubTries, true);
      var count = function (l) { return byStudents ? who[l.id] : l.starts || 0; };
      var max = Math.max.apply(null, list.map(count).concat([1]));
      var shown = ctx.top('funnel', list, 12);
      ctx.draw(function () {
        if (c.chart.hidden) return;
        C.barList(c.chart, { name: T.funnelTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: shown.map(function (l) {
          return { label: I.levelLabel(l.id, lang), value: count(l), valueText: byStudents ? T.nStudents(who[l.id]) : T.nTries(l.starts || 0),
            chip: ctx.chipFor(students(l), l.starts), tip: { title: I.levelLabel(l.id, lang), note: ctx.chipFor(students(l), l.starts, true), rows: [
              { value: T.nTries(l.starts || 0) }, { value: I.pct(l.winRate), label: T.winRate }, { value: I.int(l.unended || 0), label: T.unended }] } };
        }) });
      });
      ctx.moreButton(c.foot, 'funnel', list.length, T.showAllLevels, 12);
      C.table(c.table, T.funnelTitle, [{ label: T.level }, { label: T.studentsCol, num: true }, { label: T.tries, num: true }, { label: T.outcome.won, num: true },
        { label: T.outcome.lost, num: true }, { label: T.leftUnfinished, num: true }, { label: T.unended, num: true }],
      list.map(function (l) {
        var cd = l.codes || {};
        return [I.levelLabel(l.id, lang), byStudents ? I.int(who[l.id]) : '—', I.int(l.starts), I.int(cd.w), I.int(cd.l), I.int(cd.q), I.int(l.unended || 0)];
      }));
      // How each level's rounds end: one stacked bar per level (won, lost, left unfinished, other).
      var o = ctx.card(sec, 'level-outcomes', T.levelOutcomes, null, true);
      var endings = function (l) { var cd = l.codes || {}; return [cd.w || 0, cd.l || 0, cd.q || 0, (cd.d || 0) + (cd.e || 0)]; };
      var sum = function (parts) { return parts[0] + parts[1] + parts[2] + parts[3]; };
      ctx.draw(function () {
        if (o.chart.hidden) return;
        C.stackRows(o.chart, { name: T.levelOutcomes, rtl: ctx.rtl(), colors: ctx.OUTCOMES.map(function (x) { return x[1]; }),
          legend: ctx.OUTCOMES.map(function (x) { return T.outcome[x[0]]; }), rows: shown.map(function (l) {
            var parts = endings(l), all = sum(parts);
            return { label: I.levelLabel(l.id, lang), valueText: T.nTries(l.starts || 0), parts: parts.map(function (v) { return { value: v }; }),
              tip: { title: I.levelLabel(l.id, lang), rows: ctx.OUTCOMES.map(function (x, i) { return { value: all ? I.pct(parts[i] / all) : '—', label: T.outcome[x[0]] + ' (' + I.int(parts[i]) + ')', color: x[1], swatch: 'bar' }; }) } };
          }) });
      });
      C.table(o.table, T.levelOutcomes, [{ label: T.level }].concat(ctx.OUTCOMES.map(function (x) { return { label: T.outcome[x[0]], num: true }; }), [{ label: T.tries, num: true }]),
        list.map(function (l) {
          var parts = endings(l), all = sum(parts);
          return [I.levelLabel(l.id, lang)].concat(parts.map(function (v) { return all ? I.pct(v / all) : '—'; }), [I.int(l.starts)]);
        }));
    }
    // Tries to a first win, the winning try included, per level (median and the slower
    // quarter); a level nobody won yet says so, unless it cannot be won (an endless mode).
    if (ctx.failed(game)) return;
    var first = R.hardestLevels(game.firstWin).filter(function (f) { return f.median != null || (f.never && winnable(k, slug, f.id)); }).sort(natural);
    if (!first.length) return;
    var f = ctx.card(sec, 'first-win', T.firstWinTitle, T.firstWinSub, true);
    var fmax = Math.max.apply(null, first.map(function (x) { return x.p75 || x.median || 0; }).concat([1]));
    var fshown = ctx.top('first-win', first, 12);
    ctx.draw(function () {
      if (f.chart.hidden) return;
      C.barList(f.chart, { name: T.firstWinTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: fmax, rows: fshown.map(function (x) {
        return { label: I.levelLabel(x.id, lang), value: x.median || 0, valueText: x.median == null ? T.noWinYet : T.nTries(Math.round(x.median)),
          sub: T.firstWinSubRow(x.p75 == null ? '—' : I.short(x.p75), x.never), chip: x.small ? ctx.chipText(x.students, null) : null,
          tip: { title: I.levelLabel(x.id, lang), note: x.small ? ctx.chipText(x.students, null, true) : null, rows: [
            { value: x.median == null ? '—' : I.short(x.median), label: T.medianTries, color: 'var(--s1)', swatch: 'bar' },
            { value: x.p75 == null ? '—' : I.short(x.p75), label: T.p75Tries }, { value: T.nStudents(x.students) }, { value: I.int(x.never), label: T.neverWon }] } };
      }) });
    });
    ctx.moreButton(f.foot, 'first-win', first.length, T.showAllLevels, 12);
    C.table(f.table, T.firstWinTitle, [{ label: T.level }, { label: T.studentsCol, num: true }, { label: T.medianTries, num: true }, { label: T.p75Tries, num: true }, { label: T.neverWon, num: true }],
      first.map(function (x) { return [I.levelLabel(x.id, lang), I.int(x.students), x.median == null ? '—' : I.short(x.median), x.p75 == null ? '—' : I.short(x.p75), I.int(x.never)]; }));
  }

  // Difficulty: the verdict for each age, the win rate by tier, the DDA level by attempt.
  function difficulty(ctx, parent, k, slug, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'game-difficulty', T.diffTitle);
    ctx.difficulty(sec, k, { slugs: [slug], id: 'game-diff' });
    var tiers = R.curve(rows, 'tier', 'winRate').filter(function (p) { return p.value != null; });
    var dda = R.curvesByBand(rows, 'attempt', 'dda');
    if (!tiers.length && !Object.keys(dda).length) { ctx.note(sec, T.noDda); return; }
    if (tiers.length) {
      var c = ctx.card(sec, 'tier-card', T.tierTitle, T.tierSub, true);
      ctx.draw(function () {
        if (c.chart.hidden) return;
        C.columns(c.chart, { name: T.tierTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 100, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
          bars: tiers.map(function (p) { return { tick: String(p.k), title: T.tierN(p.k), value: p.value * 100,
            tip: { title: T.tierN(p.k), note: ctx.chipFor(null, p.n, true), rows: [{ value: I.pct(p.value), label: T.winRate, color: 'var(--s1)', swatch: 'bar' }, { value: T.nTries(p.n) }] } }; }) });
      });
      C.table(c.table, T.tierTitle, [{ label: T.tier }, { label: T.winRate, num: true }, { label: T.tries, num: true }],
        tiers.map(function (p) { return [T.tierN(p.k), I.pct(p.value), I.int(p.n)]; }));
    }
    bandCurves(ctx, sec, 'dda-card', T.ddaByAttempt, T.ddaByAttemptSub, dda, 'attempt', 'dda');
  }

  // A measure by bucket for each age group: small multiples on one scale.
  function bandCurves(ctx, parent, id, title, sub, curves, metric, name) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var bands = BANDS.filter(function (b) { return curves[b] && curves[b].some(function (p) { return p.value != null; }); });
    var c = ctx.card(parent, id, title, sub, true);
    if (!bands.length) { ctx.note(c.chart, T.noData); return c; }
    var f = fmtOf(ctx, name);
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.multiples(c.chart, bands.map(function (b) {
        var pts = curves[b];
        var students = Math.max.apply(null, pts.map(function (p) { return p.students; }).concat([0]));
        return { title: I.bandLabel(b, ctx.lang()), draw: 'line', chip: ctx.chipFor(null, pts.reduce(function (a, p) { return a + p.n; }, 0)),
          name: title + ': ' + I.bandLabel(b, ctx.lang()), points: pts.map(function (p) {
            return { tick: R.bucketLabel(metric, p.k), title: T.bucketTitle[metric](R.bucketLabel(metric, p.k)), value: p.value == null ? null : f.scale(p.value),
              tip: { title: T.bucketTitle[metric](R.bucketLabel(metric, p.k)), note: ctx.chipFor(null, p.n, true), rows: [
                { value: p.value == null ? '—' : f.text(p.value), label: T.measureName[name], color: 'var(--s1)', swatch: 'line' }, { value: T.nTries(p.rounds) }] } };
          }) };
      }), { rtl: ctx.rtl(), color: 'var(--s1)', height: 150, max: f.max, axis: f.axis, keysHint: T.keysSteps });
    });
    var rows = [];
    bands.forEach(function (b) { curves[b].forEach(function (p) { rows.push([I.bandLabel(b, ctx.lang()), R.bucketLabel(metric, p.k), p.value == null ? '—' : f.text(p.value), I.int(p.rounds)]); }); });
    C.table(c.table, title, [{ label: T.ageGroup }, { label: T.bucketCol[metric] }, { label: T.measureName[name], num: true }, { label: T.tries, num: true }], rows);
    return c;
  }
  // How a measure is drawn: rates as 0-100 %, the DDA level 0-100, times in seconds.
  function fmtOf(ctx, name) {
    var I = ctx.I;
    if (name === 'winRate' || name === 'accuracy' || name === 'quitRate') return { scale: function (v) { return v * 100; }, text: function (v) { return I.pct(v); }, max: 100, axis: function (v) { return v + '%'; } };
    if (name === 'dda') return { scale: function (v) { return v / 10; }, text: function (v) { return I.short(v / 10); }, max: 100, axis: null };
    if (name === 'reaction' || name === 'timeToWin') return { scale: function (v) { return v / 1000; }, text: function (v) { return ctx.t().secondsValue(I.seconds(v)); }, max: null, axis: null };
    return { scale: function (v) { return v; }, text: function (v) { return I.short(v); }, max: null, axis: null };
  }

  // Getting better: by attempt and by weeks since the first play, per age, and the same
  // children at the start and the end of the period.
  var BETTER = ['accuracy', 'reaction', 'winRate', 'score', 'timeToWin'];
  function better(ctx, parent, slug, rows, game) {
    var T = ctx.t(), I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'game-better', T.betterGame, T.betterGameIntro);
    var reported = R.measuresOf(R.pick(rows, 'attempt')).filter(function (m) { return BETTER.indexOf(m) >= 0; });
    if (!reported.length) { ctx.note(sec, T.betterNone); return; }
    var tools = ctx.h('div', { class: 'list-tools' }, sec);
    var name = ctx.choice(tools, 'gameMeasure', reported.map(function (m) { return { value: m, text: T.measureName[m] }; }), reported[0], T.measure);
    bandCurves(ctx, sec, 'attempt-card', T.attemptCurve, T.attemptCurveSub, R.curvesByBand(rows, 'attempt', name), 'attempt', name);
    bandCurves(ctx, sec, 'tenure-card', T.tenureCurve, T.tenureCurveSub, R.curvesByBand(rows, 'tenure', name), 'tenure', name);
    pairedCard(ctx, sec, 'paired-card', game.paired, name, ctx.gameName(slug));
  }
  // The same children in the first and the last third of the period: a dumbbell per age.
  function pairedCard(ctx, parent, id, paired, name, title) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var groups = R.paired(paired, name), f = fmtOf(ctx, name);
    var c = ctx.card(parent, id, T.pairedTitle(title), T.pairedSub, true);
    var keys = ['all'].concat(BANDS).filter(function (b) { return groups[b]; });
    if (!keys.length) { ctx.note(c.chart, T.pairedNone); return c; }
    var values = [];
    keys.forEach(function (b) { values.push(f.scale(groups[b].before), f.scale(groups[b].after)); });
    var max = f.max || Math.max.apply(null, values.concat([1])) * 1.1;
    var label = function (b) { return b === 'all' ? T.allAgesShort : I.bandLabel(b, ctx.lang()); };
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.dumbbell(c.chart, { name: T.pairedTitle(title), rtl: ctx.rtl(), color: 'var(--s1)', min: 0, max: max, ticks: C.ticks(max, 4).filter(function (v) { return v <= max; }),
        axis: f.axis || function (v) { return C.compact(v); }, rows: keys.map(function (b) {
          var g = groups[b];
          return { label: label(b) + ' · ' + T.nStudents(g.students), a: f.scale(g.before), b: f.scale(g.after), aText: f.text(g.before), bText: f.text(g.after),
            chip: g.small ? ctx.chipText(g.students, null) : null,
            tip: { title: label(b), note: g.small ? ctx.chipText(g.students, null, true) : null, rows: [
              { value: f.text(g.before), label: T.pairedBefore }, { value: f.text(g.after), label: T.pairedAfter },
              { value: T.betterOf(g.better, g.students) }] } };
        }) });
    });
    ctx.note(c.foot, T.pairedLegend);
    C.table(c.table, T.pairedTitle(title), [{ label: T.ageGroup }, { label: T.studentsCol, num: true }, { label: T.pairedBefore, num: true }, { label: T.pairedAfter, num: true },
      { label: T.betterCount, num: true }],
    keys.map(function (b) { var g = groups[b]; return [label(b), I.int(g.students), f.text(g.before), f.text(g.after), I.int(g.better)]; }));
    return c;
  }

  // After a win, a loss, or leaving a round: same level, another level, another game, stop.
  function after(ctx, parent, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'game-after', T.afterTitle);
    var c = ctx.card(sec, 'after-game', null, T.afterSub, true);
    var kinds = [['w', T.afterWin], ['l', T.afterLoss], ['q', T.afterQuit]].map(function (x) { return { label: x[1], p: R.persist(rows, { codes: [x[0]] }) }; })
      .filter(function (x) { return x.p.n > 0; });
    var names = R.PERSIST.map(function (k) { return T.persist[k]; });
    if (!kinds.length) { ctx.note(c.chart, T.noData); return; }
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.stackRows(c.chart, { name: T.afterTitle, rtl: ctx.rtl(), colors: ctx.ORDINAL, legend: names, rows: kinds.map(function (x) {
        return { label: x.label, chip: ctx.chipFor(null, x.p.n), valueText: x.p.retryGap == null ? T.nTimes(x.p.n) : T.retryGap(I.short(x.p.retryGap)),
          parts: R.PERSIST.map(function (k) { return { value: x.p.counts[k] }; }),
          tip: { title: x.label, rows: R.PERSIST.map(function (k, i) { return { value: I.pct(x.p.shares[k]), label: names[i], color: ctx.ORDINAL[i], swatch: 'bar' }; })
            .concat([{ value: T.nTimes(x.p.n) }]).concat(x.p.retryGap == null ? [] : [{ value: T.secondsValue(I.short(x.p.retryGap)), label: T.retryGapLabel }]) } };
      }) });
    });
    C.table(c.table, T.afterTitle, [{ label: '' }].concat(names.map(function (n) { return { label: n, num: true }; })).concat([{ label: T.count, num: true }, { label: T.retryGapLabel, num: true }]),
      kinds.map(function (x) { return [x.label].concat(R.PERSIST.map(function (k) { return I.pct(x.p.shares[k]); })).concat([I.int(x.p.n), x.p.retryGap == null ? '—' : T.secondsValue(I.short(x.p.retryGap))]); }));
  }

  // Tiredness: the win rate and the accuracy by minutes into the session (two charts).
  function tired(ctx, parent, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'game-tired', T.tiredTitle, T.tiredIntro);
    var grid = ctx.h('div', { class: 'grid-2' }, sec);
    [['winRate', 'tired-win'], ['accuracy', 'tired-acc']].forEach(function (spec) {
      var pts = R.curve(rows, 'fatigue', spec[0]).filter(function (p) { return p.value != null; });
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

  // Where they come from and where they go next (top 5), and the launch sources.
  function comesFrom(ctx, parent, g, game) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var sec = ctx.section(parent, 'game-flows', T.flowsTitle);
    var grid = ctx.h('div', { class: 'grid-2' }, sec);
    var other = function (slug, start) { return slug ? ctx.gameName(slug) : start ? T.sessionStart : T.sessionEnd; };
    if (!ctx.failed(game)) {
      [['flowsIn', 'from', T.cameFrom, true], ['flowsOut', 'to', T.wentTo, false]].forEach(function (spec) {
        var list = (game[spec[0]] || []).filter(function (x) { return x && x.n > 0; }).slice(0, 5);
        var c = ctx.card(grid, 'game-' + spec[0], spec[2], null, true);
        var max = list.length ? list[0].n : 1;
        if (!list.length) ctx.note(c.chart, T.noData);
        else ctx.draw(function () {
          if (c.chart.hidden) return;
          C.barList(c.chart, { name: spec[2], rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: list.map(function (x) {
            return { label: other(x[spec[1]], spec[3]), value: x.n, valueText: T.nTimes(x.n), tip: { title: other(x[spec[1]], spec[3]), rows: [{ value: T.nTimes(x.n) }] } };
          }) });
        });
        C.table(c.table, spec[2], [{ label: T.game }, { label: T.count, num: true }], list.map(function (x) { return [other(x[spec[1]], spec[3]), I.int(x.n)]; }));
      });
    }
    var sources = Object.keys(g.sources || {}).map(function (src) { return { src: src, n: g.sources[src] || 0 }; }).filter(function (x) { return x.n > 0; })
      .sort(function (a, b) { return b.n - a.n || (a.src < b.src ? -1 : 1); });
    var all = sources.reduce(function (a, x) { return a + x.n; }, 0);
    var s = ctx.card(grid, 'game-sources', T.sourcesTitle, T.sourcesSub, true);
    if (!sources.length) ctx.note(s.chart, T.noData);
    else ctx.draw(function () {
      if (s.chart.hidden) return;
      C.barList(s.chart, { name: T.sourcesTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 1, track: true, rows: sources.map(function (x) {
        return { label: T.source[x.src] || x.src, value: x.n / all, valueText: I.pct(x.n / all), tip: { title: T.source[x.src] || x.src, rows: [{ value: T.nOpens(x.n) }] } };
      }) });
    });
    C.table(s.table, T.sourcesTitle, [{ label: T.sourceCol }, { label: T.opens, num: true }, { label: T.shareCol, num: true }],
      sources.map(function (x) { return [T.source[x.src] || x.src, I.int(x.n), I.pct(x.n / all)]; }));
  }

  // The score: what it means in this game, and the average score by attempt.
  function scores(ctx, parent, slug, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R, lang = ctx.lang();
    var meaning = window.SG_SCORES && Object.prototype.hasOwnProperty.call(window.SG_SCORES, slug) ? window.SG_SCORES[slug] : null;
    var pts = R.curve(rows, 'attempt', 'score').filter(function (p) { return p.value != null; });
    if (!meaning && !pts.length) return;
    var sec = ctx.section(parent, 'game-score', T.scoreTitle);
    var c = ctx.card(sec, 'score-card', null, meaning ? T.scoreMeans(meaning[lang === 'ar' ? 0 : 1]) : T.scoreNoMeaning, true);
    if (!pts.length) { ctx.note(c.chart, T.noData); return; }
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: T.scoreByAttempt, rtl: ctx.rtl(), color: 'var(--s1)', keysHint: T.keysColumns, format: function (v) { return I.short(v); },
        bars: pts.map(function (p) { var label = R.bucketLabel('attempt', p.k); return { tick: label, title: T.bucketTitle.attempt(label), value: p.value,
          tip: { title: T.bucketTitle.attempt(label), note: ctx.chipFor(null, p.n, true), rows: [{ value: I.short(p.value), label: T.avgScore, color: 'var(--s1)', swatch: 'bar' }, { value: T.nTries(p.n) }] } }; }) });
    });
    ctx.note(c.foot, T.scoreCompare);
    C.table(c.table, T.scoreByAttempt, [{ label: T.bucketCol.attempt }, { label: T.avgScore, num: true }, { label: T.tries, num: true }],
      pts.map(function (p) { return [R.bucketLabel('attempt', p.k), I.short(p.value), I.int(p.n)]; }));
  }

  // On the school PCs: smoothness, loading, slow responses and failures for this game.
  function pcs(ctx, parent, k, slug) {
    var T = ctx.t(), I = ctx.I;
    var health = I.pcHealth({ games: (k.games || []).filter(function (g) { return g.slug === slug; }), totals: null });
    var r = health.rows[0];
    var sec = ctx.section(parent, 'game-pcs', T.onPcs0);
    if (!r) { ctx.note(sec, T.noData); return; }
    var box = ctx.h('div', { class: 'tiles tiles-small' }, sec);
    ctx.tile(box, 'smooth', T.smooth, r.smooth == null ? '—' : I.pct(r.smooth), '', T.smoothHint, r.smooth);
    ctx.tile(box, 'load', T.loadTime, r.loadMs == null ? '—' : I.seconds(r.loadMs), r.loadMs == null ? '' : T.secondsUnit, T.loadHint, r.loadMs);
    ctx.tile(box, 'slowInput', T.inputDelay, r.slowInput == null ? '—' : I.pct(r.slowInput), '', T.inputHint, r.slowInput);
    ctx.tile(box, 'fails', T.fails, I.int(r.fails), '', r.failRate == null ? '' : T.failsHint(I.short(r.failRate * 100)), r.fails);
    if (r.flags.length) { var flags = ctx.h('p', { class: 'flags-line' }, sec); r.flags.forEach(function (f) { ctx.flagChip(flags, T.flag[f]); }); }
    ctx.link(ctx.h('p', { class: 'more-link' }, sec), '#/pcs', T.healthMore);
  }

  // The Learning tab draws the same curves and paired comparisons.
  tabs.shared = { bandCurves: bandCurves, fmtOf: fmtOf, pairedCard: pairedCard, winnable: winnable };
}());
