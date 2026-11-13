/*
 * The Games tab (#/games: one card per game, then the school-wide patterns of trying
 * again, tiredness and reaction times) and a game's page (#/game/<slug>).
 * Data: GET /v1/admin/kpis (the games, their levels and health), /v1/admin/stats (the
 * r_stat rows persist and fatigue: closed days only) and /v1/admin/game (its days, its
 * r_stat rows and the games before and after it). Play is anonymous, so every chart
 * counts rounds, visits or sessions; comparisons are associations, as children choose
 * their games. Won / lost / left unfinished keep s1 / s2 / s3; the ordered "what
 * happened next" stacks use the ordinal ramp.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var RT = ['<300', '300–499', '500–799', '800–1199', '1200–1999', '2000+'];

  tabs.games = {
    nightly: true,
    load: function (ctx) {
      return Promise.all([ctx.get('kpis', {}), ctx.part(ctx.get('stats', { metrics: ['persist', 'fatigue'] }))])
        .then(function (x) { return { kpis: x[0], stats: x[1] }; });
    },
    render: function (ctx, view, data) {
      var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, k = data.kpis;
      var sec = ctx.section(view, 'games-list', T.tabs.games, T.introGames);
      var games = (k.games || []).filter(I.shown);
      if (!games.length) { ctx.note(sec, T.noData, 'empty'); return; }
      var rows = ctx.failed(data.stats) ? [] : R.statRows(data.stats);
      var box = h('div', { class: 'card insights-card', id: 'games-insights' }, sec);
      ctx.sentences(box, I.researchInsights(gameFacts(ctx, rows), { lang: ctx.lang(), name: ctx.gameName, weekday: ctx.weekdayName }));
      var tools = h('div', { class: 'list-tools' }, sec);
      var by = ctx.choice(tools, 'gamesBy', [{ value: 'minutes', text: T.byMinutes }, { value: 'opens', text: T.byOpens }, { value: 'name', text: T.byName }], 'minutes', T.sortBy);
      var value = { minutes: function (g) { return g.engagedMinutes || 0; }, opens: function (g) { return g.opens || 0; } };
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
        h('span', { class: 'game-card-facts' }, a, [ctx.minutesText(g.engagedMinutes || 0), T.nOpens(g.opens || 0), T.nSessions(g.sessions || 0)].join(' · '));
        var v = verdicts[g.slug];
        if (v && v.code !== 'missing') ctx.verdictNode(h('span', { class: 'game-card-verdict' }, a), v, true);
      });
      if (ctx.failed(data.stats)) ctx.missing(view, data.stats);
      else {
        persistence(ctx, view, rows);
        tired(ctx, view, rows, 'games-tired', 'school-tired');
      }
      reaction(ctx, view, k);
    }
  };

  // The facts the Games sentences are built from (insights.js researchInsights).
  function gameFacts(ctx, rows) {
    var R = ctx.R;
    var early = R.total(R.pick(rows, 'fatigue').filter(function (r) { return Number(r.k1) < 10; }));
    var late = R.total(R.pick(rows, 'fatigue').filter(function (r) { return Number(r.k1) >= 20; }));
    return { persist: R.retryByGame(rows), tired: { early: R.measure(early, 'winRate'), late: R.measure(late, 'winRate') } };
  }

  // Trying again by game: after a loss or leaving a round, the share that tried the same level again.
  function persistence(ctx, parent, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'games-persist', T.persistTitle, T.persistIntro);
    var c = ctx.card(sec, 'persist-card', null, null, true);
    var list = R.retryByGame(rows);
    var shown = ctx.top('persist', list);
    if (!list.length) ctx.note(c.chart, T.noData);
    else ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.persistTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 1, track: true, rows: shown.map(function (g) {
        return { label: ctx.gameName(g.slug), value: g.share || 0, valueText: I.pct(g.share), sub: T.nTimes(g.n), chip: ctx.chipFor(g.n),
          tip: { title: ctx.gameName(g.slug), note: ctx.chipFor(g.n, true), rows: [{ value: I.pct(g.share), label: T.persist.same, color: 'var(--s1)', swatch: 'bar' },
            { value: I.pct(g.again), label: T.triedAgain }].concat(g.retryGap == null ? [] : [{ value: T.secondsValue(I.short(g.retryGap)), label: T.retryGapLabel }]) } };
      }) });
    });
    ctx.moreButton(c.foot, 'persist', list.length);
    C.table(c.table, T.persistTitle, [{ label: T.game }, { label: T.persist.same, num: true }, { label: T.triedAgain, num: true }, { label: T.count, num: true }, { label: T.retryGapLabel, num: true }],
      list.map(function (g) { return [ctx.gameName(g.slug), I.pct(g.share), I.pct(g.again), I.int(g.n), g.retryGap == null ? '—' : T.secondsValue(I.short(g.retryGap))]; }));
  }

  // Reaction times: the share of reactions in each time band, in the games that measure them.
  function reaction(ctx, parent, k) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var sec = ctx.section(parent, 'games-rt', T.rtTitle, T.rtIntro);
    var c = ctx.card(sec, 'rt-card', null, null, true);
    var rt = [0, 0, 0, 0, 0, 0];
    (k.games || []).forEach(function (g) { if (I.shown(g)) (g.rt || []).forEach(function (v, i) { if (i < 6) rt[i] += v || 0; }); });
    var all = rt.reduce(function (a, v) { return a + v; }, 0);
    if (!all) { ctx.note(c.chart, T.rtNone); return; }
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: T.rtTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 100, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
        bars: rt.map(function (v, i) { return { tick: RT[i], title: T.msBand(RT[i]), value: v / all * 100,
          tip: { title: T.msBand(RT[i]), rows: [{ value: I.pct(v / all), label: T.ofReactions, color: 'var(--s1)', swatch: 'bar' }, { value: T.nReactions(v) }] } }; }) });
    });
    ctx.note(c.foot, T.nReactions(all));
    C.table(c.table, T.rtTitle, [{ label: T.reactionCol }, { label: T.shareCol, num: true }, { label: T.count, num: true }],
      rt.map(function (v, i) { return [T.msBand(RT[i]), I.pct(v / all), I.int(v)]; }));
  }

  // ---- a game's page -----------------------------------------------------------------
  tabs.game = {
    nightly: true,
    load: function (ctx) {
      var slug = ctx.route().arg;
      return Promise.all([ctx.get('kpis', {}), ctx.part(ctx.get('game', { slug: slug }))])
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
      tiles(ctx, head, g, rows);
      if (ctx.failed(game)) ctx.missing(view, game);
      else perDay(ctx, view, game);
      levels(ctx, view, k, slug);
      difficulty(ctx, view, k, slug, rows);
      if (!ctx.failed(game)) {
        after(ctx, view, rows);
        tired(ctx, view, rows, 'game-tired', 'tired');
      }
      comesFrom(ctx, view, g, game);
      scores(ctx, view, slug);
      pcs(ctx, view, k, slug);
    }
  };

  function tiles(ctx, parent, g, rows) {
    var T = ctx.t(), h = ctx.h, I = ctx.I, R = ctx.R, has = ctx.has;
    var box = h('div', { class: 'tiles', id: 'game-tiles' }, parent);
    var d = I.duration(g.engagedMinutes || 0, ctx.lang());
    ctx.tile(box, 'minutes', T.tilePlayTime, d.value, d.unit, T.tilePlayTimeHint, g.engagedMinutes || 0);
    ctx.tile(box, 'opens', T.tileOpens, I.int(g.opens || 0), '', T.tileOpensHint, g.opens || 0);
    ctx.tile(box, 'sessions', T.tileSessions, I.int(g.sessions || 0), '', T.gameSessionsHint, g.sessions || 0);
    var perVisit = has(g.avgEngagedSecPerOpen) ? g.avgEngagedSecPerOpen / 60 : null;
    ctx.tile(box, 'perVisit', T.minutesPerVisit, perVisit == null ? '—' : I.short(perVisit), perVisit == null ? '' : T.minutesUnit, T.minutesPerVisitHint, perVisit);
    // Opened before: the opens on a browser that had opened the game before.
    var back = I.returning({ games: [g] }, 1).rows[0];
    ctx.tile(box, 'cameBack', T.cameBack, back ? I.pct(back.share) : '—', '', T.cameBackHint, back ? back.share : null);
    var hearts = g.hearts ? (g.hearts.on || 0) - (g.hearts.off || 0) : null;
    ctx.tile(box, 'hearts', T.heartsCol, hearts == null ? '—' : I.int(hearts), '', hearts == null ? '' : T.heartsHint(g.hearts.on || 0, g.hearts.off || 0), hearts);
    // A bounce: a visit under 30 seconds with no finished round (closed days only).
    var visits = R.pick(rows, 'visitlen'), all = visits.reduce(function (a, r) { return a + r.n; }, 0);
    var bounced = visits.filter(function (r) { return r.k2 === '0' && Number(r.k1) < 30; }).reduce(function (a, r) { return a + r.n; }, 0);
    ctx.tile(box, 'bounce', T.bounceRate, all ? I.pct(bounced / all) : '—', '', T.bounceHint, all ? bounced / all : null);
  }

  // Day by day: the game's opens and minutes on each day of the period.
  function perDay(ctx, parent, game) {
    var T = ctx.t(), C = ctx.C, I = ctx.I;
    var sec = ctx.section(parent, 'game-days', T.gameDaysTitle);
    // The game answer counts from the update day: the days before it would read 0.
    var cut = ctx.cutover();
    var days = (game.daily || []).filter(function (x) { return x && (!cut || x.day >= cut.factsSince); });
    var d = ctx.card(sec, 'game-daily', T.opensPerDay, null, true);
    if (cut && days.length < 2) ctx.note(d.chart, T.noData);
    else if (!cut && days.length < 7) ctx.note(d.chart, T.dailyNeedsDays);
    else ctx.draw(function () {
      if (d.chart.hidden) return;
      C.lineChart(d.chart, { name: T.opensPerDay, rtl: ctx.rtl(), color: 'var(--s1)', height: 160, keysHint: T.keysDays, format: function (v) { return I.int(v); },
        points: days.map(function (x) { return { tick: ctx.shortDay(x.day), title: ctx.longDay(x.day), value: x.opens || 0 }; }) });
    });
    C.table(d.table, T.opensPerDay, [{ label: T.day }, { label: T.opens, num: true }, { label: T.playTime, num: true }],
      days.slice().reverse().map(function (x) { return [ctx.longDay(x.day), I.int(x.opens), ctx.minutesText(x.minutes || 0)]; }));
  }

  var natural = function (a, b) { return String(a.id).localeCompare(String(b.id), 'en', { numeric: true }); };
  // Level by level: the tries of each level and how its rounds end.
  function levels(ctx, parent, k, slug) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, lang = ctx.lang();
    var list = (k.levels || []).filter(function (l) { return l.slug === slug && I.shown(l); }).sort(natural);
    var sec = ctx.section(parent, 'game-levels', T.levelByLevel);
    if (list.length < 2) { ctx.note(ctx.card(sec, 'funnel-card', null, null, false).chart, T.oneLevel); return; }
    var c = ctx.card(sec, 'funnel-card', T.funnelTitle, T.funnelSubTries, true);
    var max = Math.max.apply(null, list.map(function (l) { return l.starts || 0; }).concat([1]));
    var shown = ctx.top('funnel', list, 12);
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.barList(c.chart, { name: T.funnelTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: max, rows: shown.map(function (l) {
        return { label: I.levelLabel(l.id, lang), value: l.starts || 0, valueText: T.nTries(l.starts || 0),
          chip: ctx.chipFor(l.starts), tip: { title: I.levelLabel(l.id, lang), note: ctx.chipFor(l.starts, true), rows: [
            { value: T.nTries(l.starts || 0) }, { value: I.pct(l.winRate), label: T.winRate }, { value: I.int(l.unended || 0), label: T.unended }] } };
      }) });
    });
    ctx.moreButton(c.foot, 'funnel', list.length, T.showAllLevels, 12);
    C.table(c.table, T.funnelTitle, [{ label: T.level }, { label: T.tries, num: true }, { label: T.outcome.won, num: true },
      { label: T.outcome.lost, num: true }, { label: T.leftUnfinished, num: true }, { label: T.unended, num: true }],
    list.map(function (l) {
      var cd = l.codes || {};
      return [I.levelLabel(l.id, lang), I.int(l.starts), I.int(cd.w), I.int(cd.l), I.int(cd.q), I.int(l.unended || 0)];
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

  // Difficulty: the verdict and the win rate by tier.
  function difficulty(ctx, parent, k, slug, rows) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, 'game-difficulty', T.diffTitle);
    ctx.difficulty(sec, k, { slugs: [slug], id: 'game-diff' });
    var tiers = R.curve(rows, 'tier', 'winRate').filter(function (p) { return p.value != null; });
    if (!tiers.length) { ctx.note(sec, T.noDda); return; }
    var c = ctx.card(sec, 'tier-card', T.tierTitle, T.tierSub, true);
    ctx.draw(function () {
      if (c.chart.hidden) return;
      C.columns(c.chart, { name: T.tierTitle, rtl: ctx.rtl(), color: 'var(--s1)', max: 100, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
        bars: tiers.map(function (p) { return { tick: String(p.k), title: T.tierN(p.k), value: p.value * 100,
          tip: { title: T.tierN(p.k), note: ctx.chipFor(p.n, true), rows: [{ value: I.pct(p.value), label: T.winRate, color: 'var(--s1)', swatch: 'bar' }, { value: T.nTries(p.n) }] } }; }) });
    });
    C.table(c.table, T.tierTitle, [{ label: T.tier }, { label: T.winRate, num: true }, { label: T.tries, num: true }],
      tiers.map(function (p) { return [T.tierN(p.k), I.pct(p.value), I.int(p.n)]; }));
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
        return { label: x.label, chip: ctx.chipFor(x.p.n), valueText: x.p.retryGap == null ? T.nTimes(x.p.n) : T.retryGap(I.short(x.p.retryGap)),
          parts: R.PERSIST.map(function (k) { return { value: x.p.counts[k] }; }),
          tip: { title: x.label, rows: R.PERSIST.map(function (k, i) { return { value: I.pct(x.p.shares[k]), label: names[i], color: ctx.ORDINAL[i], swatch: 'bar' }; })
            .concat([{ value: T.nTimes(x.p.n) }]).concat(x.p.retryGap == null ? [] : [{ value: T.secondsValue(I.short(x.p.retryGap)), label: T.retryGapLabel }]) } };
      }) });
    });
    C.table(c.table, T.afterTitle, [{ label: '' }].concat(names.map(function (n) { return { label: n, num: true }; })).concat([{ label: T.count, num: true }, { label: T.retryGapLabel, num: true }]),
      kinds.map(function (x) { return [x.label].concat(R.PERSIST.map(function (k) { return I.pct(x.p.shares[k]); })).concat([I.int(x.p.n), x.p.retryGap == null ? '—' : T.secondsValue(I.short(x.p.retryGap))]); }));
  }

  // Tiredness: the win rate and the accuracy by minutes into the session (two charts), for
  // one game or every game.
  function tired(ctx, parent, rows, id, prefix) {
    var T = ctx.t(), C = ctx.C, I = ctx.I, R = ctx.R;
    var sec = ctx.section(parent, id, T.tiredTitle, T.tiredIntro);
    var grid = ctx.h('div', { class: 'grid-2' }, sec);
    [['winRate', prefix + '-win'], ['accuracy', prefix + '-acc']].forEach(function (spec) {
      var pts = R.curve(rows, 'fatigue', spec[0]).filter(function (p) { return p.value != null; });
      if (!pts.length) return;
      var title = T.tiredBy(T.measureName[spec[0]]);
      var c = ctx.card(grid, spec[1], title, null, true);
      ctx.draw(function () {
        if (c.chart.hidden) return;
        C.columns(c.chart, { name: title, rtl: ctx.rtl(), color: 'var(--s1)', max: 100, axis: function (v) { return v + '%'; }, keysHint: T.keysColumns,
          bars: pts.map(function (p) { var label = R.bucketLabel('fatigue', p.k); return { tick: label, title: T.bucketTitle.fatigue(label), value: p.value * 100,
            tip: { title: T.bucketTitle.fatigue(label), note: ctx.chipFor(p.n, true), rows: [{ value: I.pct(p.value), label: T.measureName[spec[0]], color: 'var(--s1)', swatch: 'bar' }, { value: T.nTries(p.rounds) }] } }; }) });
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

  // The score: what it means in this game (each round's score is in the research files;
  // an average would mix the kinds of rounds a game scores differently).
  function scores(ctx, parent, slug) {
    var T = ctx.t(), lang = ctx.lang();
    var meaning = window.SG_SCORES && Object.prototype.hasOwnProperty.call(window.SG_SCORES, slug) ? window.SG_SCORES[slug] : null;
    if (!meaning) return;
    var sec = ctx.section(parent, 'game-score', T.scoreTitle);
    var box = ctx.h('div', { class: 'card', id: 'score-card' }, sec);
    ctx.h('p', null, box, T.scoreMeans(meaning[lang === 'ar' ? 0 : 1]));
    ctx.note(box, T.scoreCompare);
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
}());
