/*
 * Insights for the dashboard: pure functions over the KPI JSON of
 * GET /v1/admin/kpis (server/README.md). No DOM, no clock, no network: the same
 * input always gives the same output, so tools/tests/dashboard-insights.test.mjs
 * can check every rule. The page uses window.SGInsights; Node loads this file as
 * a plain script (module.exports when CommonJS is around).
 *
 * Nothing is hidden: every group the server sends is described, even one child.
 * A group of fewer than SMALL_STUDENTS students or SMALL_TRIES tries carries
 * small: true (the page shows a "based on 2 children so far" chip next to it).
 * An answer from an older server may still mark a group { suppressed: true }:
 * such a group has no numbers, so it is left out.
 *
 * Difficulty check (one game, one age group):
 *   tries        rounds started. MIN_TRIES or more: a verdict. MIN_EARLY_TRIES to
 *                MIN_TRIES - 1: the same rules, marked early: true ("early sign").
 *                Fewer: "not enough tries yet", with the numbers shown. When the
 *                server does not report tries for an age group, at least
 *                MIN_SESSIONS_NO_TRIES play sessions instead.
 *   win rate     wins / (wins + losses) — rounds that ended with a winner.
 *   quit rate    rounds left unfinished / rounds started (dropOffRate).
 *   too hard     win rate under 40 %, or 30 % or more of the rounds left unfinished
 *                while they win under 90 % of the rounds they finish (a game they
 *                nearly always win but often leave, such as one that cannot be lost,
 *                is not too hard: "where children stop" shows it).
 *   too easy     win rate 90 % or more and fewer than 10 % left unfinished.
 *   about right  everything in between.
 *   no winner    games whose rounds never end in a win or a loss (endless runs,
 *                two players on one PC): not rated.
 *   When an age group has only the completion rate (wins / rounds started, from
 *   an older server), too hard is under 30 % and too easy 85 % or more.
 *
 * Every rate is compared as the whole percentage the page shows (79.6 % counts as
 * 80 %), so a label never contradicts the number next to it.
 *
 * Insights: at most five sentences. Each kind has its own rule below (STUCK_*,
 * RETURN_*, ...) and a deterministic order (a number, then the slug, then the id).
 * One sentence per kind, in KIND_ORDER; while fewer than five, a second pass adds
 * each kind's next candidate in the same order.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.SGInsights = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const T = Object.freeze({
    MIN_TRIES: 20,
    MIN_EARLY_TRIES: 10,       // 10-19 tries: an early sign
    MIN_SESSIONS_NO_TRIES: 5,
    HARD_WIN: 0.40,
    HARD_QUIT: 0.30,
    EASY_WIN: 0.90,
    EASY_QUIT: 0.10,
    HARD_COMPLETION: 0.30,
    EASY_COMPLETION: 0.85,
    STUCK_MIN_TRIES: 20,       // a level needs 20 tries ...
    STUCK_RATE: 0.25,          // ... and a quarter of them left unfinished
    RETURN_MIN_OPENS: 20,
    RETURN_RATE: 0.5,
    FAIL_MIN_OPENS: 20,
    FAIL_MIN: 3,               // at least 3 failed starts ...
    FAIL_RATE: 0.03,           // ... and 3 in every 100 opens
    SLOW_LOAD_MS: 3000,
    SLOW_LOAD_MIN: 10,         // loads measured
    CHOPPY_SMOOTH: 0.80,       // under 80 % smooth picture updates
    SLOW_INPUT: 0.10,          // 10 % of clicks and key presses answered in 50 ms or more
    DEVICE_MIN_SESSIONS: 10,
    DEVICE_SMOOTH: 0.85,       // a PC type under 85 % smooth motion ...
    DEVICE_GAP: 0.05,          // ... and 5 points below the best
    TREND_DAYS: 7,
    TREND_MIN: 20,             // play sessions in the earlier week
    TREND_CHANGE: 0.10,
    HEARTS_MIN: 3,             // net hearts before a game is called the most hearted
    SMALL_STUDENTS: 5,         // fewer students than this, or fewer tries, carries the small-sample chip
    SMALL_TRIES: 20
  });
  const KIND_ORDER = ['stuck', 'hard', 'favourite', 'health', 'returning', 'trend', 'easy', 'favouriteBand', 'hearts'];
  const MAX_INSIGHTS = 5;
  const BANDS = ['6-7', '8-9', '10-11'];
  const VERDICT_RANK = { hard: 0, easy: 1, right: 2, few: 3, none: 4, missing: 5 };
  // An early sign sorts after the firm verdict of the same kind.
  const rank = v => VERDICT_RANK[v.code] + (v.early ? 0.5 : 0);

  // Unicode isolates keep numbers and Latin slugs in order inside Arabic text.
  const LRI = '\u2066', FSI = '\u2068', PDI = '\u2069';
  const iso = text => LRI + text + PDI;

  // Every group has numbers, except one an older server sent as { suppressed: true }.
  const shown = g => !!g && typeof g === 'object' && g.suppressed !== true;
  const list = v => Array.isArray(v) ? v : [];
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  // A rate as shown: a whole percentage (null stays null).
  const shownRate = v => { const r = num(v); return r === null ? null : Math.round(r * 100) / 100; };
  const sum = arr => list(arr).reduce((a, b) => a + (num(b) || 0), 0);
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const byLevel = (a, b) => cmp(a.slug, b.slug) ||
    String(a.id).localeCompare(String(b.id), 'en', { numeric: true }) || cmp(a.id, b.id);

  // ---- numbers -------------------------------------------------------------
  // Western digits in both languages (the site's convention), comma groups.
  function int(n) {
    const v = Math.round(num(n) || 0);
    return v.toLocaleString('en-US');
  }
  function decimal(n, digits) {
    const v = num(n) || 0;
    return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  // One decimal only when it says something: 8.2, 4.5, 12.
  function short(n) {
    const v = num(n) || 0;
    return Math.abs(v) >= 10 ? int(v) : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  }
  // 0..1 -> "64%"; a non-zero share that rounds to 0 or 100 says so. No rate: the dash the tiles show.
  function pct(rate) {
    const r = num(rate);
    if (r === null) return '—';
    const p = Math.round(r * 100);
    if (p === 0 && r > 0) return '<1%';
    if (p === 100 && r < 1) return '>99%';
    return p + '%';
  }
  // Minutes as the reader thinks of them: "45 min", "4.5 h", "378 h".
  function duration(minutes, lang) {
    const m = num(minutes) || 0;
    const hours = m >= 120;
    const value = short(hours ? m / 60 : m);
    // The unit agrees with the number as shown ("4.5 ساعة", "5 ساعات", "1 minute").
    const shownNumber = Number(value.replace(/,/g, ''));
    const unit = lang === 'ar'
      ? arWord(shownNumber, hours ? ['ساعة', 'ساعتان', 'ساعات', 'ساعة'] : ['دقيقة', 'دقيقتان', 'دقائق', 'دقيقة'])
      : (hours ? 'hours' : shownNumber === 1 ? 'minute' : 'minutes');
    return { value, unit, text: value + ' ' + unit };
  }
  function seconds(ms) { return decimal((num(ms) || 0) / 1000, 1); }

  // Arabic number agreement after a written number: [one, two, 3-10, other].
  // Fractions and 11+ take the singular; the last two digits decide past 100. A hundred or
  // more ending in 00, 01 or 02 takes the singular genitive: the "other" form without its
  // accusative ending (طالبًا -> 100 طالب, صفًّا -> 100 صفّ; مرة stays مرة).
  function arWord(n, forms) {
    if (!Number.isInteger(n)) return forms[3];
    const m = n % 100;
    if (n === 1) return forms[0];
    if (n === 2) return forms[1];
    if (m >= 3 && m <= 10) return forms[2];
    if (n >= 100 && m <= 2) return forms[3].replace(/ً(ّ?)ا(?=\s|$)/g, '$1');
    return forms[3];
  }
  // "5 مرات", "مرة واحدة", "مرتين" (after a verb).
  function arTimes(n) {
    if (n === 1) return 'مرة واحدة';
    if (n === 2) return 'مرتين';
    return int(n) + ' ' + arWord(n, ['مرة', 'مرتان', 'مرات', 'مرة']);
  }
  const enTimes = n => n === 1 ? 'once' : n === 2 ? 'twice' : int(n) + ' times';

  // ---- labels ----------------------------------------------------------------
  // A game's name from the site's catalog entry ({ slug, title, en }): the Arabic
  // title, or in English the first words of the search name, up to the first word
  // in lower case or one that repeats an earlier word ("Bubble Bop beginner …" ->
  // "Bubble Bop", "Dino 3D Dino3D …" -> "Dino 3D"). '' when there is none.
  function catalogName(entry, lang) {
    if (!entry || typeof entry !== 'object') return '';
    if (lang === 'ar') return typeof entry.title === 'string' ? entry.title.trim() : '';
    const out = [];
    for (const w of String(entry.en || '').split(/\s+/).filter(Boolean)) {
      if (out.length >= 4 || /^[a-z]/.test(w)) break;
      const low = w.toLowerCase();
      if (out.some(o => low.startsWith(o.toLowerCase()))) break;
      out.push(w);
    }
    return out.join(' ');
  }
  function bandLabel(band, lang) {
    if (band === 'unknown' || band === '') return lang === 'ar' ? 'العمر غير محدد' : 'Age not set';
    if (band === 'all' || band == null) return lang === 'ar' ? 'كل الأعمار' : 'All ages';
    const parts = String(band).split('-');
    const range = parts[0] + '–' + parts[1];
    return lang === 'ar' ? iso(range) + ' ' + (+parts[1] >= 3 && +parts[1] <= 10 ? 'سنوات' : 'سنة') : range;
  }
  // "children aged 6–7" — the subject of a sentence; null band = every child.
  function children(band, lang, capital) {
    const ar = lang === 'ar';
    if (band == null || band === 'all') return ar ? 'الأطفال' : (capital ? 'Children' : 'children');
    if (band === 'unknown' || band === '') return ar ? 'الأطفال الذين لم يُحدَّد عمرهم' : (capital ? 'Children' : 'children') + ' whose age is not set';
    return ar ? 'الأطفال بعمر ' + bandLabel(band, 'ar') : (capital ? 'Children' : 'children') + ' aged ' + bandLabel(band, 'en');
  }
  // Round ids are the games' own (Kit.stats.round): L3, w1-2, arena2, s4, endless, ...
  function levelLabel(id, lang) {
    const ar = lang === 'ar';
    const raw = String(id);
    const colon = raw.indexOf(':');
    const base = colon < 0 ? raw : raw.slice(0, colon);
    const extra = colon < 0 ? '' : ' (' + (ar ? iso(raw.slice(colon + 1)) : raw.slice(colon + 1)) + ')';
    let m;
    if ((m = /^L(\d+)$/.exec(base))) return (ar ? 'المرحلة ' : 'level ') + m[1] + extra;
    if ((m = /^w(\d+)-(\d+)$/.exec(base))) return (ar ? 'العالم ' + m[1] + '، المرحلة ' + m[2] : 'world ' + m[1] + ', level ' + m[2]) + extra;
    if ((m = /^stage-?(\d+)$/.exec(base))) return (ar ? 'المرحلة ' : 'stage ') + m[1] + extra;
    if ((m = /^arena-?(\d+)$/.exec(base))) return (ar ? 'الساحة ' : 'arena ') + m[1] + extra;
    if ((m = /^trick-?(\d+)$/.exec(base))) return (ar ? 'الخدعة ' : 'trick shot ') + m[1] + extra;
    if ((m = /^s(\d+)$/.exec(base))) return (ar ? 'اللوحة ' + iso(m[1] + '×' + m[1]) : m[1] + '×' + m[1] + ' board') + extra;
    if (base === 'endless') return (ar ? 'اللعب المتواصل' : 'endless mode') + extra;
    return ar ? 'جولة «' + FSI + raw + PDI + '»' : 'round “' + raw + '”';
  }
  // Processor, memory and screen buckets are "the largest bucket at or below the
  // PC's value" (js/telemetry.js): 4 cores means 4 to 7.
  const DEVICE_LABELS = {
    cores: {
      en: { 1: '1 core', 2: '2–3 cores', 4: '4–7 cores', 8: '8–15 cores', 16: '16 or more cores' },
      ar: { 1: 'نواة واحدة', 2: iso('2–3') + ' أنوية', 4: iso('4–7') + ' أنوية', 8: iso('8–15') + ' نواة', 16: '16 نواة أو أكثر' }
    },
    memory: {
      en: { 0: 'under 1 GB', 1: '1 GB', 2: '2 GB', 4: '4 GB', 8: '8 GB or more' },
      ar: { 0: 'أقل من 1 غيغابايت', 1: '1 غيغابايت', 2: '2 غيغابايت', 4: '4 غيغابايت', 8: '8 غيغابايت أو أكثر' }
    },
    screen: {
      en: { 1366: 'under 1600 px', 1600: '1600–1919 px', 1920: '1920–2559 px', 2560: '2560 px or more' },
      ar: { 1366: 'أقل من 1600 بكسل', 1600: iso('1600–1919') + ' بكسل', 1920: iso('1920–2559') + ' بكسل', 2560: '2560 بكسل أو أكثر' }
    }
  };
  function deviceLabel(dimension, value, lang) {
    const table = DEVICE_LABELS[dimension] && DEVICE_LABELS[dimension][lang === 'ar' ? 'ar' : 'en'];
    return table && Object.hasOwn(table, value) ? table[value] : String(value);
  }
  // "PCs with 2–3 processor cores" / "الأجهزة التي يحوي معالجها 2–3 أنوية".
  function devicePhrase(dimension, value, lang) {
    const label = deviceLabel(dimension, value, lang);
    if (lang === 'ar') return dimension === 'cores' ? 'يحوي معالجها ' + label : dimension === 'memory' ? 'ذاكرتها ' + label : 'عرض شاشتها ' + label;
    return dimension === 'cores' ? label.replace(/cores?$/, c => 'processor ' + c) : dimension === 'memory' ? label + ' of memory' : 'a screen ' + label + ' wide';
  }

  // ---- the update day ----------------------------------------------------------
  // The server tells students apart from the update day (range.factsSince). The days up to
  // range.legacyUntil come from milestone 2's daily totals, which have no students. When the
  // period reaches back to them, every group's student count covers only part of it.
  const isDayText = d => typeof d === 'string' && /^\d{4}-\d\d-\d\d$/.test(d);
  function partialStudents(kpis) {
    const r = kpis && kpis.range;
    return !!r && isDayText(r.legacyUntil) && isDayText(r.from) && r.from <= r.legacyUntil;
  }
  // The KPI answer for the page: when its student counts cover only part of the period,
  // the games', levels' and age groups' counts become unknown (null), so no chip or sentence
  // counts children; the totals stay (the page says from which day they count).
  function forPeriod(kpis) {
    if (!partialStudents(kpis)) return kpis;
    const drop = g => shown(g) ? Object.assign({}, g, { students: null }) : g;
    const out = Object.assign({}, kpis);
    if (Array.isArray(kpis.games)) out.games = kpis.games.map(drop);
    if (Array.isArray(kpis.levels)) out.levels = kpis.levels.map(drop);
    if (Array.isArray(kpis.bands)) out.bands = kpis.bands.map(b => shown(b) ? Object.assign(drop(b), Array.isArray(b.games) ? { games: b.games.map(drop) } : {}) : b);
    return out;
  }

  // ---- derived views (the page draws these; the sentences use them too) -----
  const totalsShown = k => !!k && shown(k.totals);
  const opensOf = g => num(g.opens) || 0;
  // The small-sample rule: fewer than 5 students or fewer than 20 tries (a count the
  // server did not send says nothing either way).
  function small(students, tries) {
    const s = num(students), t = num(tries);
    return (s !== null && s < T.SMALL_STUDENTS) || (t !== null && t < T.SMALL_TRIES);
  }

  // Favourite games: the most opened first.
  function favourites(kpis) {
    const total = totalsShown(kpis) ? num(kpis.totals.gameOpens) : null;
    const rows = list(kpis && kpis.games).filter(shown).map(g => ({
      slug: g.slug, opens: opensOf(g), sessions: num(g.sessions) || 0, students: num(g.students),
      engagedMinutes: num(g.engagedMinutes) || 0, avgSec: num(g.avgEngagedSecPerOpen),
      share: total ? opensOf(g) / total : null, small: small(g.students, null)
    })).sort((a, b) => b.opens - a.opens || b.sessions - a.sessions || cmp(a.slug, b.slug));
    return { rows };
  }

  // Favourites per age group: each group's games by their share of its opens.
  function favouritesByBand(kpis, limit) {
    const max = limit || 5;
    return list(kpis && kpis.bands).filter(shown).map(b => {
      const rows = list(b.games).filter(shown).map(g => ({
        slug: g.slug, opens: opensOf(g), sessions: num(g.sessions) || 0, share: num(g.share),
        engagedMinutes: num(g.engagedMinutes)   // null from a server without it
      })).sort((x, y) => (y.share || 0) - (x.share || 0) || y.opens - x.opens || cmp(x.slug, y.slug));
      return {
        band: b.band, sessions: num(b.sessions) || 0, opens: num(b.opens) || 0, engagedMinutes: num(b.engagedMinutes),
        students: num(b.students), small: small(b.students, null),
        rows: rows.slice(0, max), more: Math.max(0, rows.length - max)
      };
    });
  }

  // Levels most often left unfinished. A level's students in the KPI answer are summed day
  // by day (a child who played it on two days counts twice), so they are no count of
  // children: a level's small-sample chip rests on its tries alone.
  function stuckLevels(kpis, minTries) {
    const min = minTries == null ? T.STUCK_MIN_TRIES : minTries;
    const rows = list(kpis && kpis.levels).filter(shown).map(l => {
      const starts = num(l.starts) || 0, quits = num(l.codes && l.codes.q) || 0;
      return { slug: l.slug, id: l.id, starts, quits, rate: starts ? quits / starts : null, sessions: num(l.sessions) || 0,
        students: null, small: small(null, starts) };
    }).filter(l => l.starts >= min && l.quits > 0)
      .sort((a, b) => b.rate - a.rate || b.quits - a.quits || b.starts - a.starts || byLevel(a, b));
    return { rows };
  }

  // One cell of the difficulty check.
  // input: { tries (null when unknown), sessions, winRate, dropOffRate, completionRate, winnable }
  // 10-19 tries give the same verdict with early: true ("early sign").
  function verdict(cell) {
    if (!cell || cell.suppressed) return { code: 'missing' };
    const tries = num(cell.tries), sessions = num(cell.sessions) || 0;
    if (cell.winnable === false) return { code: 'none', tries };
    if (tries !== null ? tries < T.MIN_EARLY_TRIES : sessions < T.MIN_SESSIONS_NO_TRIES) return { code: 'few', tries };
    const v = judge(cell, tries);
    if (tries !== null && tries < T.MIN_TRIES && v.code !== 'none' && v.code !== 'few') v.early = true;
    return v;
  }
  function judge(cell, tries) {
    const win = shownRate(cell.winRate), quit = shownRate(cell.dropOffRate), done = shownRate(cell.completionRate);
    // undefined: an older server without the win rate for this group; null: no
    // round of this group ended in a win or a loss.
    if (cell.winRate !== undefined) {
      const q = quit === null ? 0 : quit;
      if (win === null) return q >= T.HARD_QUIT ? { code: 'hard', basis: 'quit', win, quit: q, tries } : { code: 'none', tries };
      if (win < T.HARD_WIN || (q >= T.HARD_QUIT && win < T.EASY_WIN)) return { code: 'hard', basis: 'win', win, quit: q, tries };
      if (win >= T.EASY_WIN && q < T.EASY_QUIT) return { code: 'easy', basis: 'win', win, quit: q, tries };
      return { code: 'right', basis: 'win', win, quit: q, tries };
    }
    if (done === null) return { code: 'few', tries };
    if (done < T.HARD_COMPLETION) return { code: 'hard', basis: 'completion', done, tries };
    if (done >= T.EASY_COMPLETION) return { code: 'easy', basis: 'completion', done, tries };
    return { code: 'right', basis: 'completion', done, tries };
  }

  // The difficulty grid: every game, its all-ages (or the chosen age group's)
  // verdict and how its rounds end, plus one cell per age group when the KPIs
  // cover every age.
  function difficultyGrid(kpis) {
    const band = kpis && kpis.range ? kpis.range.band : 'all';
    const perBand = band === 'all' || band == null;
    const bandGames = {};
    for (const b of list(kpis && kpis.bands)) {
      if (!shown(b) || !BANDS.includes(b.band)) continue;
      bandGames[b.band] = new Map(list(b.games).filter(g => shown(g) && g.slug).map(g => [g.slug, g]));
    }
    const rows = list(kpis && kpis.games).filter(shown).map(g => {
      const codes = (g.rounds && g.rounds.codes) || {};
      const w = num(codes.w) || 0, l = num(codes.l) || 0, q = num(codes.q) || 0, d = num(codes.d) || 0, e = num(codes.e) || 0;
      const ended = w + l + q + d + e;
      const tries = num(g.rounds && g.rounds.starts) || 0;
      const winnable = w + l > 0;
      const winRate = g.winRate === undefined ? (winnable ? w / (w + l) : null) : num(g.winRate);
      const main = verdict({ tries, sessions: g.sessions, winRate, dropOffRate: g.dropOffRate, completionRate: g.completionRate, winnable });
      const cells = {};
      if (perBand) {
        for (const b of BANDS) {
          const bg = bandGames[b] && bandGames[b].get(g.slug);
          if (!bg) { cells[b] = { code: 'missing' }; continue; }
          const bt = num(bg.starts) ?? num(bg.rounds && bg.rounds.starts);
          cells[b] = verdict({ tries: bt, sessions: bg.sessions, winRate: bg.winRate, dropOffRate: bg.dropOffRate,
            completionRate: bg.completionRate, winnable });
        }
      }
      const worst = Math.min(rank(main), ...Object.values(cells).map(rank));
      return {
        slug: g.slug, tries, verdict: main, cells, worst, students: num(g.students), small: small(g.students, tries),
        outcomes: { won: w, lost: l, unfinished: q, other: d + e, ended },
        winRate   // wins / (wins + losses), the number the verdict compares (null: no winner)
      };
    }).sort((a, b) => a.worst - b.worst || rank(a.verdict) - rank(b.verdict) ||
      (a.verdict.win ?? 2) - (b.verdict.win ?? 2) || b.tries - a.tries || cmp(a.slug, b.slug));
    // Which of the fallback rules an age group's cell needed, so the page explains only those.
    const cellsOf = rows.flatMap(r => Object.values(r.cells));
    return {
      rows, perBand, band: perBand ? 'all' : band,
      bySessions: cellsOf.some(c => c.tries === null && ['hard', 'easy', 'right', 'few'].includes(c.code)),
      byCompletion: cellsOf.some(c => c.basis === 'completion')
    };
  }

  // Coming back: the share of a game's opens by children who had opened it before.
  function returning(kpis, minOpens) {
    const min = minOpens == null ? 1 : minOpens;
    let all = 0, back = 0;
    const rows = list(kpis && kpis.games).filter(shown).map(g => {
      const pb = list(g.replay && g.replay.playsBefore);
      const total = sum(pb), first = num(pb[0]) || 0;
      all += total; back += total - first;
      return { slug: g.slug, opens: total, back: total - first, share: total ? (total - first) / total : null, buckets: pb.slice(),
        students: num(g.students) };
    }).filter(r => r.opens >= min && r.share !== null)
      .sort((a, b) => b.share - a.share || b.opens - a.opens || cmp(a.slug, b.slug));
    return { rows, overall: all ? back / all : null, opens: all, back };
  }

  // Input delay: clicks and key presses answered in 50 ms or more (il buckets 4 and 5).
  const slowInput = il => { const total = sum(il); return total ? ((num(il[4]) || 0) + (num(il[5]) || 0)) / total : null; };

  // PC health per game and per PC type.
  function pcHealth(kpis) {
    let frames = [0, 0, 0, 0], il = [0, 0, 0, 0, 0, 0], loadSum = 0, loads = 0;
    const rows = list(kpis && kpis.games).filter(shown).map(g => {
      const counts = list(g.frames && g.frames.counts);
      counts.forEach((c, i) => { if (i < 4) frames[i] += num(c) || 0; });
      list(g.il).forEach((c, i) => { if (i < 6) il[i] += num(c) || 0; });
      const n = num(g.loads) || 0, ms = num(g.avgLoadMs);
      if (n && ms !== null) { loadSum += n * ms; loads += n; }
      const fails = sum(Object.values(g.errors || {})), opens = opensOf(g);
      const smooth = num(g.frames && g.frames.smoothShare), slow = slowInput(list(g.il));
      const flags = [];
      if (smooth !== null && sum(counts) > 0 && shownRate(smooth) < T.CHOPPY_SMOOTH) flags.push('choppy');
      if (ms !== null && n >= T.SLOW_LOAD_MIN && Math.round(ms / 100) * 100 >= T.SLOW_LOAD_MS) flags.push('slowLoad');
      if (slow !== null && shownRate(slow) >= T.SLOW_INPUT) flags.push('slowInput');
      if (opens >= T.FAIL_MIN_OPENS && fails >= T.FAIL_MIN && shownRate(fails / opens) >= T.FAIL_RATE) flags.push('fails');
      return { slug: g.slug, smooth, stall: num(g.frames && g.frames.stallShare), loadMs: ms, loads: n, slowInput: slow,
        fails, opens, failRate: opens ? fails / opens : null, flags };
    }).sort((a, b) => b.flags.length - a.flags.length || (a.smooth ?? 2) - (b.smooth ?? 2) || cmp(a.slug, b.slug));
    const totalFrames = sum(frames);
    const devices = {};
    for (const dim of ['cores', 'memory', 'screen']) {
      devices[dim] = list(kpis && kpis.devices && kpis.devices[dim]).filter(shown).map(d => ({
        value: d.value, sessions: num(d.sessions) || 0, smooth: num(d.frames && d.frames.smoothShare),
        loadMs: num(d.avgLoadMs), slowInput: slowInput(list(d.il))
      }));
    }
    const t = totalsShown(kpis) ? kpis.totals : null;
    return {
      rows, devices,
      overall: {
        smooth: totalFrames ? frames[0] / totalFrames : null, loadMs: loads ? loadSum / loads : null,
        slowInput: slowInput(il), fails: t ? num(t.errors) : null,
        failRate: t && num(t.gameOpens) ? (num(t.errors) || 0) / t.gameOpens : null
      }
    };
  }

  // ---- sentences -------------------------------------------------------------
  function sentenceSet(kpis, options) {
    const o = options || {};
    const lang = o.lang === 'ar' ? 'ar' : 'en', ar = lang === 'ar';
    const nameOf = typeof o.name === 'function' ? o.name : slug => slug;
    const game = slug => ar ? '«' + FSI + nameOf(slug) + PDI + '»' : nameOf(slug);
    const band = kpis.range && kpis.range.band && kpis.range.band !== 'all' ? kpis.range.band : null;
    const out = {};
    // sample: the students and tries a sentence is based on (null: not known); small
    // marks one under the small-sample rule, for the chip next to it.
    const add = (kind, key, text, sample) => {
      const item = { kind, key, text };
      if (sample) Object.assign(item, { students: num(sample.students), tries: num(sample.tries), small: small(sample.students, sample.tries) });
      (out[kind] || (out[kind] = [])).push(item);
    };

    // Where children get stuck.
    for (const l of stuckLevels(kpis).rows) {
      if (shownRate(l.rate) < T.STUCK_RATE) break;
      add('stuck', l.slug + ' ' + l.id, ar
        ? 'يترك ' + children(band, lang) + ' ' + levelLabel(l.id, lang) + ' من ' + game(l.slug) + ' دون إكمال في ' + pct(l.rate) +
          ' من المحاولات (' + int(l.quits) + ' من أصل ' + int(l.starts) + ').'
        : children(band, lang, true) + ' leave ' + nameOf(l.slug) + ' ' + levelLabel(l.id, lang) + ' unfinished in ' + pct(l.rate) +
          ' of tries (' + int(l.quits) + ' of ' + int(l.starts) + ').', { students: l.students, tries: l.starts });
    }

    // Too hard and too easy: the age group's cell when it is judged, otherwise all ages.
    // An early sign (10-19 tries) is shown in the grid, never stated as a finding.
    const grid = difficultyGrid(kpis);
    const judged = [];
    const firm = v => v && (v.code === 'hard' || v.code === 'easy') && !v.early;
    for (const r of grid.rows) {
      const own = { band, v: r.verdict, students: r.students };
      const bandCells = BANDS.map(b => ({ band: b, v: r.cells[b], students: null })).filter(c => firm(c.v));
      for (const code of ['hard', 'easy']) {
        const cells = bandCells.filter(c => c.v.code === code);
        // The most extreme age group says more than the average over every age.
        const pick = cells.sort((a, b) => (code === 'hard' ? score(a.v) - score(b.v) : score(b.v) - score(a.v)) || cmp(a.band, b.band))[0] ||
          (firm(own.v) && own.v.code === code ? own : null);
        if (pick) judged.push({ slug: r.slug, code, band: pick.band, v: pick.v, students: pick.students });
      }
    }
    for (const code of ['hard', 'easy']) {
      judged.filter(j => j.code === code)
        .sort((a, b) => (code === 'hard' ? score(a.v) - score(b.v) : score(b.v) - score(a.v)) || cmp(a.slug, b.slug) || cmp(a.band || '', b.band || ''))
        .forEach(j => add(code, j.slug + ' ' + (j.band || 'all'), difficultySentence(j, lang, game, nameOf), { students: j.students, tries: j.v.tries }));
    }

    // Favourite game.
    const fav = favourites(kpis).rows;
    if (fav.length && fav[0].opens > 0 && fav[0].share !== null) {
      const f = fav[0];
      add('favourite', f.slug, ar
        ? game(f.slug) + ' هي اللعبة الأكثر فتحًا' + (band ? ' لدى ' + children(band, lang) : '') + ': فُتحت ' + arTimes(f.opens) +
          '، أي ' + pct(f.share) + (band ? ' من مرات فتحهم للألعاب.' : ' من كل مرات فتح الألعاب.')
        : nameOf(f.slug) + ' is the most opened game' + (band ? ' for ' + children(band, lang) : '') + ': ' + int(f.opens) +
          (f.opens === 1 ? ' open, ' : ' opens, ') + pct(f.share) + (band ? ' of their game opens.' : ' of all game opens.'), { students: f.students });
    }
    // Each age group's favourite, when it differs from the overall favourite.
    if (!band && fav.length) {
      for (const b of favouritesByBand(kpis, 1)) {
        if (!BANDS.includes(b.band) || !b.rows.length || b.rows[0].slug === fav[0].slug || b.rows[0].share === null) continue;
        const top = b.rows[0];
        add('favouriteBand', b.band + ' ' + top.slug, ar
          ? 'اللعبة المفضلة لدى ' + children(b.band, lang) + ' هي ' + game(top.slug) + ': ' + pct(top.share) + ' من مرات فتحهم للألعاب.'
          : 'The favourite of ' + children(b.band, lang) + ' is ' + nameOf(top.slug) + ': ' + pct(top.share) + ' of their game opens.',
        { students: b.students });
      }
    }

    // Coming back.
    for (const r of returning(kpis, T.RETURN_MIN_OPENS).rows) {
      if (shownRate(r.share) < T.RETURN_RATE) break;
      add('returning', r.slug, ar
        ? 'يعود ' + children(band, lang) + ' إلى ' + game(r.slug) + ' أكثر من غيرها: ' + pct(r.share) + ' من مرات فتحها كانت لأطفال لعبوها من قبل.'
        : children(band, lang, true) + ' come back to ' + nameOf(r.slug) + ' the most: ' + pct(r.share) +
          ' of its opens are by children who played it before.', { students: r.students });
      break;
    }

    // PC health: failed starts, then the least smooth PC type, the least smooth game, the slowest load.
    const health = pcHealth(kpis);
    health.rows.filter(r => r.flags.includes('fails'))
      .sort((a, b) => b.failRate - a.failRate || b.fails - a.fails || cmp(a.slug, b.slug))
      .forEach(r => add('health', 'fails ' + r.slug, ar
        ? 'تعذّر تشغيل ' + game(r.slug) + ' ' + arTimes(r.fails) + ' (' + int(r.failRate * 100) + ' من كل 100 مرة فتح).'
        : nameOf(r.slug) + ' failed to start ' + enTimes(r.fails) + ' (' + int(r.failRate * 100) + ' in every 100 opens).'));
    const gaps = [];
    for (const dim of ['cores', 'memory']) {
      const rows = health.devices[dim].filter(d => d.smooth !== null && d.sessions >= T.DEVICE_MIN_SESSIONS);
      if (rows.length < 2) continue;
      const worst = rows.slice().sort((a, b) => a.smooth - b.smooth || a.value - b.value)[0];
      const best = rows.slice().sort((a, b) => b.smooth - a.smooth || b.value - a.value)[0];
      const gap = Math.round((shownRate(best.smooth) - shownRate(worst.smooth)) * 100);
      if (worst.value !== best.value && shownRate(worst.smooth) < T.DEVICE_SMOOTH && gap >= Math.round(T.DEVICE_GAP * 100)) gaps.push({ dim, worst, best });
    }
    gaps.sort((a, b) => (b.best.smooth - b.worst.smooth) - (a.best.smooth - a.worst.smooth) || cmp(a.dim, b.dim));
    for (const g of gaps) {
      add('health', 'device ' + g.dim, ar
        ? 'الألعاب أقل سلاسة على الأجهزة التي ' + devicePhrase(g.dim, g.worst.value, lang) + ': حركة سلسة بنسبة ' + pct(g.worst.smooth) +
          '، مقابل ' + pct(g.best.smooth) + ' على الأجهزة التي ' + devicePhrase(g.dim, g.best.value, lang) + '.'
        : 'Games are least smooth on PCs with ' + devicePhrase(g.dim, g.worst.value, lang) + ': ' + pct(g.worst.smooth) +
          ' smooth motion, against ' + pct(g.best.smooth) + ' on PCs with ' + devicePhrase(g.dim, g.best.value, lang) + '.');
    }
    const choppy = health.rows.filter(r => r.flags.includes('choppy')).sort((a, b) => a.smooth - b.smooth || cmp(a.slug, b.slug))[0];
    if (choppy) {
      add('health', 'choppy ' + choppy.slug, ar
        ? game(choppy.slug) + ' هي الأقل سلاسة: حركة سلسة بنسبة ' + pct(choppy.smooth) +
          (health.overall.smooth !== null ? ' (كل الألعاب: ' + pct(health.overall.smooth) + ').' : '.')
        : nameOf(choppy.slug) + ' is the least smooth game: ' + pct(choppy.smooth) + ' smooth motion' +
          (health.overall.smooth !== null ? ' (all games: ' + pct(health.overall.smooth) + ').' : '.'));
    }
    const slow = health.rows.filter(r => r.flags.includes('slowLoad')).sort((a, b) => b.loadMs - a.loadMs || cmp(a.slug, b.slug))[0];
    if (slow) {
      // "The slowest" only when no shown game is slower, even one opened too few times to flag.
      const slowest = health.rows.every(r => r.loadMs === null || !r.loads || r.loadMs <= slow.loadMs);
      add('health', 'load ' + slow.slug, ar
        ? 'تحتاج ' + game(slow.slug) + ' إلى ' + seconds(slow.loadMs) + ' ثانية في المتوسط حتى تفتح' + (slowest ? '، وهي الأبطأ بين الألعاب.' : '.')
        : nameOf(slow.slug) + ' takes ' + seconds(slow.loadMs) + ' seconds to open on average' + (slowest ? ', the slowest of all games.' : '.'));
    }

    // Trend: the last full week against the one before (today is still filling up).
    const days = list(kpis.daily).filter(d => d && d.day !== o.today);
    if (days.length >= 2 * T.TREND_DAYS) {
      const recent = days.slice(-T.TREND_DAYS), before = days.slice(-2 * T.TREND_DAYS, -T.TREND_DAYS);
      if (recent.every(shown) && before.every(shown)) {
        const a = sum(before.map(d => d.sessions)), b = sum(recent.map(d => d.sessions));
        const change = a ? (b - a) / a : null;
        if (a >= T.TREND_MIN && change !== null && shownRate(Math.abs(change)) >= T.TREND_CHANGE) {
          const up = change > 0;
          add('trend', up ? 'up' : 'down', ar
            ? (up ? 'زادت' : 'انخفضت') + ' جلسات اللعب بنسبة ' + pct(Math.abs(change)) + ' في آخر 7 أيام كاملة مقارنة بالأيام السبعة التي قبلها (' +
              int(b) + ' مقابل ' + int(a) + ').'
            : 'Play sessions went ' + (up ? 'up' : 'down') + ' ' + pct(Math.abs(change)) + ' in the last 7 full days compared with the 7 days before (' +
              int(b) + ' against ' + int(a) + ').');
        }
      }
    }

    // Hearts: the game children gave the most hearts (pressed minus taken back).
    const hearted = list(kpis.games).filter(g => shown(g) && g.hearts).map(g => {
      const on = num(g.hearts.on) || 0, off = num(g.hearts.off) || 0;
      return { slug: g.slug, on, off, net: on - off, students: num(g.students) };
    }).filter(g => g.net >= T.HEARTS_MIN).sort((a, b) => b.net - a.net || b.on - a.on || cmp(a.slug, b.slug));
    for (const h of hearted.slice(0, 2)) {
      const from = band ? (ar ? ' من ' + children(band, lang) : ' from ' + children(band, lang)) : '';
      add('hearts', h.slug, ar
        ? 'نالت ' + game(h.slug) + ' أكثر القلوب' + from + ' في هذه الفترة: ' + int(h.net) + ' ' + arWord(h.net, ['قلب', 'قلبان', 'قلوب', 'قلبًا']) +
          (h.off ? ' بعد طرح ما أُلغي، إذ ضُغط قلبها ' + arTimes(h.on) + ' وأُلغي ' + arTimes(h.off) + '.' : '.')
        : nameOf(h.slug) + ' got the most hearts' + from + ' in this period: ' + int(h.net) +
          (h.off ? ' after the ones taken back (its heart was pressed ' + enTimes(h.on) + ' and taken back ' + enTimes(h.off) + ').' : '.'),
        { students: h.students });
    }
    return out;
  }

  // How far a judged cell is from "about right": lower is harder.
  function score(v) {
    if (v.basis === 'completion') return v.done;
    if (v.basis === 'quit') return -v.quit;
    return v.win - (v.quit || 0);
  }

  function difficultySentence(j, lang, game, nameOf) {
    const ar = lang === 'ar', v = j.v, who = children(j.band, lang);
    if (j.code === 'hard') {
      if (v.basis === 'quit') {
        return ar ? 'تبدو لعبة ' + game(j.slug) + ' صعبة جدًا على ' + who + ': يتركون ' + pct(v.quit) + ' من جولاتهم دون إكمال.'
          : nameOf(j.slug) + ' looks too hard for ' + who + ': they leave ' + pct(v.quit) + ' of their rounds unfinished.';
      }
      if (v.basis === 'completion') {
        return ar ? 'تبدو لعبة ' + game(j.slug) + ' صعبة جدًا على ' + who + ': تنتهي ' + pct(v.done) + ' فقط من جولاتهم بالفوز.'
          : nameOf(j.slug) + ' looks too hard for ' + who + ': only ' + pct(v.done) + ' of their rounds end in a win.';
      }
      return ar ? 'تبدو لعبة ' + game(j.slug) + ' صعبة جدًا على ' + who + ': يفوزون في ' + pct(v.win) + ' من الجولات التي يُنهونها، ويتركون ' +
          pct(v.quit || 0) + ' من جولاتهم دون إكمال.'
        : nameOf(j.slug) + ' looks too hard for ' + who + ': they win ' + pct(v.win) + ' of the rounds they finish and leave ' +
          pct(v.quit || 0) + ' of their rounds unfinished.';
    }
    if (v.basis === 'completion') {
      return ar ? 'تبدو لعبة ' + game(j.slug) + ' سهلة جدًا على ' + who + ': تنتهي ' + pct(v.done) + ' من جولاتهم بالفوز.'
        : nameOf(j.slug) + ' looks too easy for ' + who + ': ' + pct(v.done) + ' of their rounds end in a win.';
    }
    return ar ? 'تبدو لعبة ' + game(j.slug) + ' سهلة جدًا على ' + who + ': يفوزون في ' + pct(v.win) + ' من الجولات التي يُنهونها، ولا يتركون دون إكمال إلا ' +
        pct(v.quit || 0) + ' من جولاتهم.'
      : nameOf(j.slug) + ' looks too easy for ' + who + ': they win ' + pct(v.win) + ' of the rounds they finish and leave only ' +
        pct(v.quit || 0) + ' of their rounds unfinished.';
  }

  // Up to five sentences: [{ kind, key, text }].
  // options: { lang: 'ar' | 'en', name: slug -> display name, today: 'YYYY-MM-DD' }
  function insights(kpis, options) {
    const lang = options && options.lang === 'ar' ? 'ar' : 'en', ar = lang === 'ar';
    if (!kpis || typeof kpis !== 'object' || !kpis.totals) return [];
    // Only an older server leaves the totals out; this dashboard shows every number.
    if (!shown(kpis.totals)) {
      return [{ kind: 'old', key: 'totals', text: ar ? 'هذا الخادم إصدار أقدم لا يرسل أرقام المجموعات الصغيرة. حدِّث الخادم لترى كل الأرقام.'
        : 'This server is an older version that leaves out small groups. Update the server to see every number.' }];
    }
    if (!num(kpis.totals.sessions)) {
      return [{ kind: 'empty', key: 'totals', text: ar ? 'لم يُسجَّل أي لعب في هذه الفترة بعد.' : 'No play has been recorded in this period yet.' }];
    }
    const sets = sentenceSet(kpis, options);
    const picked = [];
    for (let pass = 0; pass < 2 && picked.length < MAX_INSIGHTS; pass++) {
      for (const kind of KIND_ORDER) {
        const item = sets[kind] && sets[kind][pass];
        if (item && picked.length < MAX_INSIGHTS) picked.push(item);
      }
    }
    if (!picked.length) {
      return [{ kind: 'quiet', key: 'none', text: ar ? 'لا يوجد ما يلفت الانتباه في هذه الفترة بعد.' : 'Nothing stands out in this period yet.' }];
    }
    return picked;
  }

  // ---- research sentences (the Habits and Learning tabs) ----------------------------
  // At most five sentences from facts the page derives with research.js:
  //   growth    [{ slug, measure, band, students, before, after, change, better }]: the
  //             same children in the first and the last third of the period
  //   persist   [{ slug, share, n }]: after a loss or a quit, the share that tried the
  //             same level again (n rounds)
  //   tired     { early: { value, n }, late: { value, n } }: the win rate in the first
  //             10 minutes of a session and after 20
  //   session   { median, open, n }: the median length of the students' sessions (minutes)
  //   peak      { weekday, hour, share }: the busiest weekday and hour, and its share of play
  // options: { lang, name: slug -> name, weekday: (0-6) -> name }
  // Every comparison is an association: children choose what they play.
  const RESEARCH_ORDER = ['growth', 'persist', 'tired', 'session', 'peak'];
  const GROWTH_MIN = { accuracy: 0.03, winRate: 0.05, reaction: 30, score: 0 };   // the smallest change worth a sentence
  function researchInsights(facts, options) {
    const o = options || {}, ar = o.lang === 'ar', lang = ar ? 'ar' : 'en';
    const nameOf = typeof o.name === 'function' ? o.name : slug => slug;
    const game = slug => ar ? '«' + FSI + nameOf(slug) + PDI + '»' : nameOf(slug);
    const dayName = typeof o.weekday === 'function' ? o.weekday : d => String(d);
    const f = facts || {};
    const out = [];
    const add = (kind, key, text, sample) => out.push({ kind, key, text, students: num(sample && sample.students), tries: num(sample && sample.tries),
      small: !!sample && small(sample.students, sample.tries) });
    // Growth: the largest improvement of one age group's same children.
    const better = list(f.growth).filter(g => g && GROWTH_MIN[g.measure] !== undefined && num(g.before) !== null && num(g.after) !== null && g.students > 0)
      .map(g => ({ ...g, gain: g.measure === 'reaction' ? g.before - g.after : g.after - g.before }))
      .filter(g => g.gain > GROWTH_MIN[g.measure] && (g.measure !== 'score' || g.after > g.before))
      .sort((a, b) => b.students - a.students || b.gain - a.gain || cmp(a.slug, b.slug) || cmp(a.band, b.band));
    if (better.length) {
      const g = better[0], who = children(g.band, lang);
      const v = x => g.measure === 'reaction' ? seconds(x) + (ar ? ' ثانية' : ' s') : g.measure === 'score' ? short(x) : pct(x);
      const what = ar
        ? { accuracy: 'أصابوا ' + v(g.after) + ' من أهدافهم', winRate: 'فازوا في ' + v(g.after) + ' من جولاتهم المنتهية',
            reaction: 'صارت استجابتهم ' + v(g.after), score: 'صار متوسط نتيجتهم ' + v(g.after) }[g.measure]
        : { accuracy: 'hit ' + v(g.after) + ' of their targets', winRate: 'won ' + v(g.after) + ' of their finished rounds',
            reaction: 'reacted in ' + v(g.after) + ' on average', score: 'scored ' + v(g.after) + ' on average' }[g.measure];
      add('growth', g.slug + ' ' + g.band + ' ' + g.measure, ar
        ? who + ' الذين لعبوا ' + game(g.slug) + ' في بداية الفترة ونهايتها ' + what + ' في آخرها، مقابل ' + v(g.before) + ' في أولها (' +
          int(g.students) + ' ' + arWord(g.students, ['طفل', 'طفلان', 'أطفال', 'طفلًا']) + ').'
        : children(g.band, lang, true) + ' who played ' + nameOf(g.slug) + ' at the start and the end of this period ' + what + ' lately, from ' + v(g.before) +
          ' at first (' + int(g.students) + (g.students === 1 ? ' child' : ' children') + ').', { students: g.students });
    }
    // Persistence: the game children most often try again after a loss.
    const tries = list(f.persist).filter(p => p && num(p.share) !== null && p.n >= T.SMALL_TRIES).sort((a, b) => b.share - a.share || b.n - a.n || cmp(a.slug, b.slug));
    if (tries.length >= 2) {
      const p = tries[0];
      add('persist', p.slug, ar
        ? 'بعد خسارة جولة أو تركها في ' + game(p.slug) + ' يعيد الأطفال المرحلة نفسها في ' + pct(p.share) + ' من المرات، أكثر من أي لعبة أخرى.'
        : 'After losing or leaving a round of ' + nameOf(p.slug) + ', children try the same level again ' + pct(p.share) + ' of the time, more than in any other game.',
      { tries: p.n });
    }
    // Tiredness: the win rate later in a session against its first minutes.
    const t = f.tired;
    if (t && t.early && t.late && num(t.early.value) !== null && num(t.late.value) !== null && t.early.n >= T.SMALL_TRIES && t.late.n >= T.SMALL_TRIES) {
      const drop = Math.round(t.early.value * 100) - Math.round(t.late.value * 100);
      if (Math.abs(drop) >= 5) {
        add('tired', drop > 0 ? 'down' : 'up', ar
          ? 'يفوز الأطفال في ' + pct(t.late.value) + ' من جولاتهم بعد 20 دقيقة من اللعب، مقابل ' + pct(t.early.value) + ' في أول 10 دقائق من الجلسة.'
          : 'Children win ' + pct(t.late.value) + ' of their rounds after 20 minutes of play, against ' + pct(t.early.value) + ' in the first 10 minutes of a session.',
        { tries: Math.min(t.early.n, t.late.n) });
      }
    }
    // Session length: the median of the students' sessions.
    const ss = f.session;
    if (ss && num(ss.median) !== null && ss.n > 0) {
      const m = Math.max(1, Math.round(ss.median));
      add('session', 'median', ar
        ? (ss.open ? 'تمتد نصف جلسات لعب الطلاب ' + int(m) + ' دقيقة أو أكثر.' : 'تنتهي نصف جلسات لعب الطلاب خلال ' + int(m) + ' ' + arWord(m, ['دقيقة', 'دقيقتين', 'دقائق', 'دقيقة']) + ' أو أقل.')
        : (ss.open ? 'Half of the students\' play sessions last ' + int(m) + ' minutes or more.' : 'Half of the students\' play sessions last ' + int(m) + (m === 1 ? ' minute' : ' minutes') + ' or less.'),
      { tries: ss.n >= T.SMALL_TRIES ? null : ss.n });
    }
    // The busiest weekday and hour.
    const pk = f.peak;
    if (pk && num(pk.share) !== null && pk.share > 0) {
      const at = String(pk.hour).padStart(2, '0') + ':00';
      add('peak', pk.weekday + ' ' + pk.hour, ar
        ? 'أكثر أوقات اللعب ازدحامًا يوم ' + dayName(pk.weekday) + ' عند الساعة ' + iso(at) + '، وفيه ' + pct(pk.share) + ' من وقت اللعب.'
        : 'The busiest time is ' + dayName(pk.weekday) + ' at ' + at + ', with ' + pct(pk.share) + ' of the play time.');
    }
    out.sort((a, b) => RESEARCH_ORDER.indexOf(a.kind) - RESEARCH_ORDER.indexOf(b.kind));
    if (!out.length) return [{ kind: 'quiet', key: 'none', text: ar ? 'لا يوجد ما يلفت الانتباه في هذه الفترة بعد.' : 'Nothing stands out in this period yet.' }];
    return out.slice(0, MAX_INSIGHTS);
  }

  return Object.freeze({
    T, KIND_ORDER, BANDS, shown, small, researchInsights,
    int, decimal, short, pct, duration, seconds, arWord, arTimes, enTimes,
    catalogName, bandLabel, children, levelLabel, deviceLabel,
    partialStudents, forPeriod,
    favourites, favouritesByBand, stuckLevels, verdict, difficultyGrid, returning, pcHealth, insights
  });
}));
