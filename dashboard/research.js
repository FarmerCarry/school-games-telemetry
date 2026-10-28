/*
 * Research maths for the dashboard's tabs: pure functions over the admin answers of
 * the updated server (server/README.md: students, student, game, stats, cohorts).
 * No DOM, no clock, no network, like insights.js: the page uses window.SGResearch,
 * Node loads this file as a plain script (module.exports when CommonJS is around),
 * and tools/tests/dashboard-research.test.mjs checks every rule.
 *
 * Conventions:
 *   days        'YYYY-MM-DD' on the school's clock (the server's), compared as text.
 *   weeks       start on settings.clock.weekStart ('sun' or 'mon'); a week is named by
 *               the day it starts.
 *   stats       r_stat rows grouped over a range: { columns, rows: [[...]] }. Rows are
 *               per age band (a); "all ages" is the sum over the bands.
 *   measures    win rate = w / (w + l); accuracy = hits / (hits + misses); reaction time
 *               = rt_sum / rt_n ms; score = score_sum / score_n; time to win =
 *               win_ms / w; DDA level = dda_sum / dda_n permille; tier = tier_sum /
 *               tier_n. A measure without its denominator is null, never 0.
 *   small       fewer than SMALL.students students or SMALL.tries tries: the number is
 *               shown with a "based on 2 children" chip (insights.js uses the same rule).
 *   paired      a student counts in a paired comparison only with the measure defined
 *               in both the first and the last third of the period; the comparison is
 *               the mean over those students, so each child weighs the same.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.SGResearch = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const SMALL = Object.freeze({ students: 5, tries: 20 });
  const BANDS = ['6-7', '8-9', '10-11', 'unknown'];
  const DAY_MS = 86400000;
  // Bucket lower bounds of the r_stat metrics (server/README.md).
  const BUCKETS = Object.freeze({
    sesslen: [0, 1, 2, 5, 10, 15, 20, 30, 45, 60],          // engaged minutes per session
    daymin: [0, 5, 10, 15, 20, 30, 45, 60, 90],             // minutes per student-day
    games: [1, 2, 3, 4, 5, 6, 8],                            // games opened per session (6 = 6-7, 8 = 8+)
    visitlen: [0, 10, 30, 60, 120, 300, 600, 1200],          // engaged seconds per visit
    attempt: [1, 2, 3, 4, 6, 11, 21, 51, 101],               // a student's attempt at a game
    tenure: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],  // weeks since the first play (13 = 13+)
    fatigue: [0, 5, 10, 15, 20, 30, 45],                     // minutes into the session
    qrun: [0, 1, 2, 3, 4, 5],                                // losses in a row before (5 = 5+)
    tier: [1, 2, 3, 4, 5, 6, 7, 8, 9]
  });
  const PERSIST = ['same', 'level', 'game', 'stop'];
  // A bucket's label from its lower bound: counts read "4–5" and "101+" (the last bucket
  // is open); minutes and seconds read "5–10" (from 5 up to 10).
  const CONTINUOUS = new Set(['sesslen', 'daymin', 'fatigue', 'visitlen']);
  function bucketLabel(metric, k) {
    const bounds = BUCKETS[metric] || [], i = bounds.indexOf(Number(k));
    if (i < 0) return String(k);
    const lo = bounds[i], next = bounds[i + 1];
    if (next == null) return lo + '+';
    if (CONTINUOUS.has(metric)) return lo + '–' + next;
    return next - 1 === lo ? String(lo) : lo + '–' + (next - 1);
  }
  const NUMERIC = ['n', 'students', 'w', 'l', 'd', 'e', 'q', 'ms', 'wall_ms', 'win_ms', 'hits', 'misses', 'rt_sum', 'rt_n',
    'score_sum', 'score_n', 'tier_sum', 'tier_n', 'dda_sum', 'dda_n', 'inputs', 'gap_sum', 'gap_n'];

  const list = v => Array.isArray(v) ? v : [];
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const div = (a, b) => num(a) !== null && num(b) ? a / b : null;
  const LRI = '⁦', PDI = '⁩';

  // ---- days and weeks (UTC arithmetic on calendar days) -------------------------
  const isDay = d => typeof d === 'string' && /^\d{4}-\d\d-\d\d$/.test(d);
  const shift = (day, by) => new Date(Date.parse(day + 'T00:00:00Z') + by * DAY_MS).toISOString().slice(0, 10);
  const weekdayOf = day => new Date(day + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
  const firstWeekday = weekStart => weekStart === 'mon' ? 1 : 0;
  function weekOf(day, weekStart) { return shift(day, -((weekdayOf(day) - firstWeekday(weekStart) + 7) % 7)); }
  // The weekdays in the school's order: [0..6] from Sunday, or [1..6, 0] from Monday.
  function weekdays(weekStart) { const f = firstWeekday(weekStart); return [0, 1, 2, 3, 4, 5, 6].map(i => (i + f) % 7); }
  // How many times each weekday occurs in [from, to].
  function weekdayCounts(from, to) {
    const out = [0, 0, 0, 0, 0, 0, 0];
    if (!isDay(from) || !isDay(to) || from > to) return out;
    const n = daysBetween(from, to) + 1, w0 = weekdayOf(from);
    for (let i = 0; i < 7; i++) out[(w0 + i) % 7] = Math.floor(n / 7) + (i < n % 7 ? 1 : 0);
    return out;
  }
  // The n weeks ending with the week of `to`, oldest first.
  function weeksEnding(to, n, weekStart) {
    const last = weekOf(to, weekStart);
    return Array.from({ length: n }, (_, i) => shift(last, (i - n + 1) * 7));
  }
  // "This school year": from the latest 1 August on or before today.
  function schoolYearStart(today) {
    const y = Number(today.slice(0, 4)), aug = y + '-08-01';
    return today >= aug ? aug : (y - 1) + '-08-01';
  }

  // ---- the small-sample rule and labels -------------------------------------------
  function small(students, tries) {
    const s = num(students), t = num(tries);
    return (s !== null && s < SMALL.students) || (t !== null && t < SMALL.tries);
  }
  // "Student 7F3A" / «الطالب 7F3A»; the code is isolated so it reads left to right in
  // Arabic.
  function studentLabel(s, lang) {
    const label = s && typeof s.label === 'string' && s.label ? s.label : String(s && s.u || '').slice(0, 4).toUpperCase();
    return (lang === 'ar' ? 'الطالب ' : 'Student ') + LRI + label + PDI;
  }
  // The check character the teacher page shows after a code (3F9A-0C51-E2B7-5): Luhn
  // mod 16 over the 12 hex digits. From the rightmost digit the factors are 2, 1, 2, ...;
  // each addend is floor(f·v/16) + (f·v % 16); the check is (16 − sum % 16) % 16, in hex.
  function checkChar(code) {
    if (!/^[0-9a-f]{12}$/.test(code)) return null;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const p = (i % 2 ? 1 : 2) * parseInt(code[11 - i], 16);
      sum += Math.floor(p / 16) + p % 16;
    }
    return ((16 - sum % 16) % 16).toString(16);
  }
  // What was typed, without dashes and spaces, in lower case, Arabic digits as 0-9 (a
  // keyboard set to Arabic types them).
  const typed = text => String(text || '').toLowerCase().replace(/[\s\-‐-―]/g, '')
    .replace(/[٠-٩۰-۹]/g, d => String(d.charCodeAt(0) & 15));
  // A code typed into the search: 4 to 13 letters and digits once dashes and spaces are
  // gone (a code as the teacher page shows it, 3F9A-0C51-E2B7-5, is 12 hex plus a check
  // character). Returns the lower-case prefix to look for, or null.
  function codeQuery(text) {
    const clean = typed(text);
    if (clean.length < 4 || clean.length > 13 || !/^[0-9a-z]+$/.test(clean)) return null;
    return clean.length === 13 ? clean.slice(0, 12) : clean;
  }
  // A whole code, as typed: { code } for 12 hex digits (or 13 with the right check
  // character), { wrong: true } when the check character does not match, else null.
  function fullCode(text) {
    const clean = typed(text);
    if (!/^[0-9a-f]{12}[0-9a-f]?$/.test(clean)) return null;
    const code = clean.slice(0, 12);
    return clean.length === 13 && clean[12] !== checkChar(code) ? { wrong: true } : { code };
  }
  // Students whose code, label or a linked code starts with the query.
  function findStudents(students, text) {
    const q = codeQuery(text);
    if (!q) return [];
    return list(students).filter(s => s && (String(s.u).startsWith(q) || String(s.label || '').toLowerCase().startsWith(q) ||
      list(s.linked).some(u => String(u).startsWith(q))));
  }

  // ---- r_stat rows ---------------------------------------------------------------------
  // { columns, rows } -> [{ a, metric, slug, k1, k2, n, students, w, ... }]. Missing
  // numeric columns read as 0; unknown columns are kept. The server stores an age group
  // that was never set as '' and names it 'unknown' elsewhere: here it is 'unknown' too.
  // A game's own rows have no slug column (slug '').
  const bandOf = a => a == null || a === '' ? 'unknown' : String(a);
  function statRows(answer) {
    const columns = list(answer && answer.columns);
    return list(answer && answer.rows).filter(Array.isArray).map(r => {
      const o = {};
      columns.forEach((c, i) => { o[c] = r[i]; });
      for (const c of NUMERIC) o[c] = num(o[c]) || 0;
      for (const c of ['metric', 'slug', 'k1', 'k2']) o[c] = o[c] == null ? '' : String(o[c]);
      o.a = bandOf(o.a);
      return o;
    });
  }
  // The rows of one metric, for one age band ('all' or none: every band) and one game.
  function pick(rows, metric, opts) {
    const o = opts || {};
    return list(rows).filter(r => r.metric === metric && (!o.band || o.band === 'all' || r.a === o.band) &&
      (o.slug == null || r.slug === o.slug) && (!o.slugs || o.slugs.includes(r.slug)));
  }
  const zero = () => { const o = {}; for (const c of NUMERIC) o[c] = 0; return o; };
  function add(into, row) { for (const c of NUMERIC) into[c] += num(row[c]) || 0; return into; }
  // Sums rows by a key: Map key -> summed row (in first-seen order).
  function sumBy(rows, keyOf) {
    const out = new Map();
    for (const r of list(rows)) {
      const k = keyOf(r);
      if (!out.has(k)) out.set(k, Object.assign(zero(), { key: k }));
      add(out.get(k), r);
    }
    return out;
  }
  function total(rows) { return list(rows).reduce(add, zero()); }

  // ---- measures -------------------------------------------------------------------------
  // Each measure from a summed row: { value, n } where n is its denominator (the tries
  // or answers it rests on). value is a share 0..1, milliseconds, a score or a level.
  const MEASURES = Object.freeze({
    winRate: r => ({ value: div(r.w, r.w + r.l), n: r.w + r.l }),
    accuracy: r => ({ value: div(r.hits, r.hits + r.misses), n: r.hits + r.misses }),
    reaction: r => ({ value: div(r.rt_sum, r.rt_n), n: r.rt_n }),
    score: r => ({ value: div(r.score_sum, r.score_n), n: r.score_n }),
    timeToWin: r => ({ value: div(r.win_ms, r.w), n: r.w }),
    dda: r => ({ value: div(r.dda_sum, r.dda_n), n: r.dda_n }),
    tier: r => ({ value: div(r.tier_sum, r.tier_n), n: r.tier_n }),
    quitRate: r => ({ value: div(r.q, r.w + r.l + r.d + r.e + r.q), n: r.w + r.l + r.d + r.e + r.q }),
    inputsPerMinute: r => ({ value: r.ms ? r.inputs / (r.ms / 60000) : null, n: r.ms ? r.inputs : 0 })
  });
  // Lower is better for these.
  const LOWER_BETTER = new Set(['reaction', 'timeToWin', 'quitRate']);
  function measure(row, name) {
    const f = MEASURES[name];
    if (!f || !row) return { value: null, n: 0 };
    const m = f(row);
    return { value: m.value === null || !Number.isFinite(m.value) ? null : m.value, n: m.n || 0 };
  }
  // The measures a game reports, from its rows: accuracy and reaction time where Kit
  // counts hits and reactions, the score where the game passes one, the DDA level in the
  // adaptive games, the win rate where rounds are won or lost.
  function measuresOf(rows) {
    const t = total(rows), out = [];
    if (t.hits + t.misses > 0) out.push('accuracy');
    if (t.rt_n > 0) out.push('reaction');
    if (t.w + t.l > 0) out.push('winRate');
    if (t.score_n > 0) out.push('score');
    if (t.dda_n > 0) out.push('dda');
    if (t.w > 0 && t.win_ms > 0) out.push('timeToWin');
    return out;
  }

  // A curve over a bucketed key (attempt, tenure, fatigue, tier): one point per bucket,
  // in bucket order, with its value, its denominator and its students.
  function curve(rows, metric, name, opts) {
    const o = opts || {};
    const bounds = BUCKETS[metric] || [];
    const sums = sumBy(pick(rows, metric, o), r => r.k1);
    return bounds.map(b => {
      const r = sums.get(String(b));
      const m = measure(r, name);
      return { k: b, value: m.value, n: m.n, students: r ? r.students : 0, rounds: r ? r.w + r.l + r.d + r.e + r.q : 0 };
    }).filter(p => p.rounds > 0 || p.n > 0);
  }
  // Per age band: { band: curve } for small multiples on one scale.
  function curvesByBand(rows, metric, name, opts) {
    const out = {};
    for (const b of BANDS) {
      const c = curve(rows, metric, name, Object.assign({}, opts, { band: b }));
      if (c.length) out[b] = c;
    }
    return out;
  }

  // ---- histograms and quantiles --------------------------------------------------------------
  // counts per bucket of a metric (k1 = the bucket's lower bound), summed over the rows.
  function histogram(rows, metric, opts) {
    const bounds = BUCKETS[metric] || [];
    const sums = sumBy(pick(rows, metric, opts), r => r.k1);
    return bounds.map(b => { const r = sums.get(String(b)); return { k: b, n: r ? r.n : 0, ms: r ? r.ms : 0, students: r ? r.students : 0 }; });
  }
  // Quantile q (0..1) of a bucketed distribution, linear inside the bucket. The last
  // bucket has no upper bound: a quantile that falls in it is its lower bound, and
  // `open` says so ("45 minutes or more"). With a metric that counts (games per session,
  // attempts, losses in a row, tiers: not minutes or seconds), the bucket that holds the
  // quantile instead, with its label ("3", "6–7"): a session never opens 3.7 games.
  function quantile(hist, q, metric) {
    const counts = list(hist).map(h => num(h.n) || 0), totalN = counts.reduce((a, b) => a + b, 0);
    if (!totalN) return null;
    const target = q * totalN;
    let seen = 0;
    for (let i = 0; i < counts.length; i++) {
      if (!counts[i]) continue;
      if (seen + counts[i] >= target || i === counts.length - 1) {
        const lo = hist[i].k, hi = i + 1 < hist.length ? hist[i + 1].k : null;
        if (metric && BUCKETS[metric] && !CONTINUOUS.has(metric)) return { value: lo, open: hi === null, label: bucketLabel(metric, lo) };
        if (hi === null) return { value: lo, open: true };
        return { value: lo + (hi - lo) * Math.max(0, Math.min(1, (target - seen) / counts[i])), open: false };
      }
      seen += counts[i];
    }
    return null;
  }

  // ---- when they play: weekday x hour -------------------------------------------------------------
  // hour rows (k1 hour 00-23, k2 weekday 0-6) -> 7 rows in the school's weekday order,
  // 24 cells each: { minutes, visits, students (summed per day), occurrences, perDay
  // (average students on such a day and hour) }. Stats cover closed days only, so the
  // occurrences count the weekdays in [from, lastClosed].
  function weekHours(rows, opts) {
    const o = opts || {};
    const sums = sumBy(pick(rows, 'hour', o), r => r.k2 + '|' + Number(r.k1));
    const occ = weekdayCounts(o.from, o.to);
    return weekdays(o.weekStart).map(wd => ({
      weekday: wd,
      cells: Array.from({ length: 24 }, (_, hour) => {
        const r = sums.get(wd + '|' + hour);
        return { hour, minutes: r ? r.ms / 60000 : 0, visits: r ? r.n : 0, students: r ? r.students : 0, occurrences: occ[wd],
          perDay: r && occ[wd] ? r.students / occ[wd] : 0 };
      })
    }));
  }
  // The hours that have any play, widened to whole school hours (07..16 by default).
  function activeHours(grid, lo, hi) {
    let a = lo == null ? 7 : lo, b = hi == null ? 16 : hi;
    for (const row of list(grid)) for (const c of row.cells) if (c.visits > 0) { a = Math.min(a, c.hour); b = Math.max(b, c.hour); }
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }

  // ---- persistence -------------------------------------------------------------------------------
  // After rounds ending in `codes` (default a loss or a quit): the shares that went on
  // to the same level, another level, another game, or stopped; the mean seconds
  // before the retry (same or level).
  function persist(rows, opts) {
    const o = opts || {};
    const codes = o.codes || ['l', 'q'];
    const parts = { same: 0, level: 0, game: 0, stop: 0 };
    let gap = 0, gapN = 0, students = 0;
    for (const r of pick(rows, 'persist', o)) {
      if (!codes.includes(r.k1) || !Object.hasOwn(parts, r.k2)) continue;
      parts[r.k2] += r.n; students += r.students;
      if (r.k2 === 'same' || r.k2 === 'level') { gap += r.gap_sum; gapN += r.gap_n; }
    }
    const n = parts.same + parts.level + parts.game + parts.stop;
    const shares = {};
    for (const k of PERSIST) shares[k] = n ? parts[k] / n : null;
    return { counts: parts, shares, n, retryGap: gapN ? gap / gapN : null, students };
  }
  // A student's own { same, level, game, stop } (counts or shares) as shares.
  function persistShares(p) {
    const n = PERSIST.reduce((a, k) => a + (num(p && p[k]) || 0), 0);
    const shares = {};
    for (const k of PERSIST) shares[k] = n ? (num(p[k]) || 0) / n : null;
    return { shares, n };
  }
  // Per game: the share of rounds after a loss or quit that were tried again on the same level.
  function retryByGame(rows, opts) {
    const slugs = [...new Set(pick(rows, 'persist', opts).map(r => r.slug))];
    return slugs.map(slug => {
      const p = persist(rows, Object.assign({}, opts, { slug }));
      return { slug, share: p.shares.same, again: p.shares.same === null ? null : p.shares.same + p.shares.level, n: p.n, retryGap: p.retryGap };
    }).filter(g => g.n > 0).sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || b.n - a.n || cmp(a.slug, b.slug));
  }

  // ---- flows -----------------------------------------------------------------------------------
  // Game-to-game edges (from slug -> to slug, '' = the session's start or end), most first.
  function flows(rows, opts) {
    const o = opts || {};
    const sums = sumBy(pick(rows, 'flow', o), r => r.slug + '>' + r.k1);
    return [...sums.values()].map(r => { const [from, to] = r.key.split('>'); return { from, to, n: r.n, gap: r.gap_n ? r.gap_sum / r.gap_n : null }; })
      .filter(e => !o.games || (e.from && e.to)).sort((a, b) => b.n - a.n || cmp(a.from, b.from) || cmp(a.to, b.to));
  }

  // ---- students --------------------------------------------------------------------------------
  // New and returning students per week from the students answer: a student is active in
  // a week when weekly[i] > 0 (weekly holds the 13 weeks ending with the week of `to`);
  // new in the week of their first play when they were not known before. Only the
  // weeks that overlap [from, to] are returned.
  function newReturning(students, opts) {
    const o = opts || {};
    const weeks = weeksEnding(o.to, 13, o.weekStart);
    const out = weeks.map(week => ({ week, new: 0, returning: 0 }));
    for (const s of list(students)) {
      const firstWeek = isDay(s.firstDay) ? weekOf(s.firstDay, o.weekStart) : null;
      list(s.weekly).slice(-13).forEach((m, i) => {
        if (!(num(m) > 0)) return;
        if (!s.knownBefore && firstWeek === weeks[i]) out[i].new++; else out[i].returning++;
      });
    }
    return out.filter(w => shift(w.week, 6) >= o.from && w.week <= o.to);
  }
  // Which of the 13 weekly slots (the weeks ending with the week of `to`) overlap [from, to].
  function weeksKept(o) {
    return weeksEnding(o.to, 13, o.weekStart).map(w => shift(w, 6) >= o.from && w <= o.to);
  }
  // Each student-week with play, from the weekly minutes (the histogram of minutes per
  // student per week), limited to the weeks that overlap [from, to].
  function studentWeeks(students, opts) {
    const keep = weeksKept(opts || {});
    const out = [];
    for (const s of list(students)) list(s.weekly).slice(-13).forEach((m, i) => { if (keep[i] && num(m) > 0) out.push(m); });
    return out;
  }
  // Values into fixed buckets (lower bounds): [{ k, n }].
  function bucketize(values, bounds) {
    const out = bounds.map(k => ({ k, n: 0 }));
    for (const v of list(values)) {
      if (num(v) === null) continue;
      let i = 0;
      while (i + 1 < bounds.length && v >= bounds[i + 1]) i++;
      out[i].n++;
    }
    return out;
  }
  // Days played per week, on average over the weeks a student played: [1..7]. days counts
  // the days of [from, to], so only the weeks that overlap it count (opts: { from, to,
  // weekStart }; without them every one of the 13 weeks).
  function daysPerWeek(students, opts) {
    const o = opts || {}, keep = isDay(o.from) && isDay(o.to) ? weeksKept(o) : null;
    return list(students).map(s => {
      const weeks = list(s.weekly).slice(-13).filter((m, i) => num(m) > 0 && (!keep || keep[i])).length;
      return weeks ? Math.min(7, num(s.days) / weeks) : null;
    }).filter(v => v !== null && v > 0);
  }
  // A student's minutes per week from their days: [{ week, minutes }] from the first
  // to the last week of [from, to].
  function weeklyMinutes(days, opts) {
    const o = opts || {};
    const by = new Map();
    for (const d of list(days)) if (isDay(d.day)) { const w = weekOf(d.day, o.weekStart); by.set(w, (by.get(w) || 0) + (num(d.minutes) || 0)); }
    if (!isDay(o.from) || !isDay(o.to)) return [...by].sort((a, b) => cmp(a[0], b[0])).map(([week, minutes]) => ({ week, minutes }));
    const out = [];
    for (let w = weekOf(o.from, o.weekStart); w <= o.to; w = shift(w, 7)) out.push({ week: w, minutes: by.get(w) || 0 });
    return out;
  }
  // Win rate (of finished) for a student row: w / (w + l).
  const winShare = s => div(s.w, (num(s.w) || 0) + (num(s.l) || 0));

  // ---- cohorts ---------------------------------------------------------------------------------
  // Each cohort (start week) with its size and the share active in weeks +0..+12; a
  // week the cohort has not reached yet is null (not 0).
  function cohortGrid(answer) {
    return list(answer && answer.cohorts).filter(c => c && isDay(c.week)).map(c => ({
      week: c.week, size: num(c.size) || 0,
      cells: Array.from({ length: 13 }, (_, k) => {
        const n = num(list(c.active)[k]);
        return n === null ? null : { n, share: c.size ? n / c.size : null };
      })
    })).sort((a, b) => cmp(a.week, b.week));
  }

  // ---- paired growth --------------------------------------------------------------------------
  // The game answer's paired rows ([u, a, part 0|1, rounds, w, l, hits, misses, rtSum,
  // rtN, scoreSum, scoreN, ddaSum, ddaN]) -> per age band: the mean of each student's
  // measure in the first third (before) and the last third (after), over the students
  // with the measure in both. all: every band together. The server pairs a student's
  // thirds within one age group, so a child whose age group changed counts in each.
  const PAIRED = ['u', 'a', 'part', 'rounds', 'w', 'l', 'hits', 'misses', 'rtSum', 'rtN', 'scoreSum', 'scoreN', 'ddaSum', 'ddaN'];
  function pairedRows(answer) {
    const columns = list(answer && answer.columns).length ? answer.columns : PAIRED;
    return list(answer && answer.rows).filter(Array.isArray).map(r => {
      const o = {};
      columns.forEach((c, i) => { o[c] = r[i]; });
      return {
        u: String(o.u), a: bandOf(o.a), part: Number(o.part), rounds: num(o.rounds) || 0, w: num(o.w) || 0, l: num(o.l) || 0,
        hits: num(o.hits) || 0, misses: num(o.misses) || 0, rt_sum: num(o.rtSum) || 0, rt_n: num(o.rtN) || 0,
        score_sum: num(o.scoreSum) || 0, score_n: num(o.scoreN) || 0, dda_sum: num(o.ddaSum) || 0, dda_n: num(o.ddaN) || 0,
        d: 0, e: 0, q: 0, win_ms: 0, tier_sum: 0, tier_n: 0, ms: 0, inputs: 0
      };
    });
  }
  function paired(answer, name) {
    const byStudent = new Map();
    for (const r of pairedRows(answer)) {
      if (r.part !== 0 && r.part !== 1) continue;
      const key = r.u + ' ' + r.a, s = byStudent.get(key) || { a: r.a, parts: [null, null] };
      s.parts[r.part] = r;
      byStudent.set(key, s);
    }
    const groups = {};
    for (const s of byStudent.values()) {
      if (!s.parts[0] || !s.parts[1]) continue;
      const before = measure(s.parts[0], name), after = measure(s.parts[1], name);
      if (before.value === null || after.value === null) continue;
      for (const key of ['all', s.a]) {
        const g = groups[key] || (groups[key] = { band: key, students: 0, before: 0, after: 0, up: 0, rounds: 0 });
        g.students++; g.before += before.value; g.after += after.value; g.rounds += s.parts[0].rounds + s.parts[1].rounds;
        if (LOWER_BETTER.has(name) ? after.value < before.value : after.value > before.value) g.up++;
      }
    }
    const out = {};
    for (const [k, g] of Object.entries(groups)) {
      out[k] = { band: g.band, students: g.students, before: g.before / g.students, after: g.after / g.students, change: (g.after - g.before) / g.students,
        better: g.up, small: small(g.students, null), rounds: g.rounds };
    }
    return out;
  }

  // ---- first wins --------------------------------------------------------------------------------
  // The game answer's firstWin rows, hardest first: the most tries to a first win (the winning try included)
  // (median, then p75), then the share who never won.
  function hardestLevels(firstWin) {
    return list(firstWin).filter(f => f && f.id != null).map(f => {
      const students = num(f.students) || 0, never = num(f.never) || 0;
      return { id: String(f.id), students, median: num(f.median), p75: num(f.p75), never, neverShare: students ? never / students : null,
        small: small(students, null) };
    }).sort((a, b) => (b.median ?? -1) - (a.median ?? -1) || (b.p75 ?? -1) - (a.p75 ?? -1) || (b.neverShare ?? 0) - (a.neverShare ?? 0) ||
      String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  }

  // ---- categories --------------------------------------------------------------------------------
  // Minutes, opens and games per category (window.SG_GAME_INFO cats); a game with two
  // categories counts in both. Students cannot be added up across games, so there are none.
  function categories(games, info) {
    const out = new Map();
    for (const g of list(games)) {
      if (!g || g.suppressed) continue;
      const cats = info && Object.hasOwn(info, g.slug) ? list(info[g.slug].cats) : [];
      for (const c of cats.length ? cats : ['']) {
        const x = out.get(c) || { id: c, minutes: 0, opens: 0, games: 0 };
        x.minutes += num(g.engagedMinutes) || 0; x.opens += num(g.opens) || 0; x.games++;
        out.set(c, x);
      }
    }
    return [...out.values()].sort((a, b) => b.minutes - a.minutes || b.opens - a.opens || cmp(a.id, b.id));
  }

  // ---- the school's PCs ---------------------------------------------------------------------------
  const PC_FLAGS = ['full', 'forgets', 'choppy', 'old'];
  function pcRows(answer) {
    return list(answer && answer.pcs).filter(p => p && p.p != null).map(p => ({
      p: String(p.p), label: p.label || String(p.p).slice(0, 4).toUpperCase(), lastDay: p.lastDay || null, firstDay: p.firstDay || null,
      days: num(p.days) || 0, sessions: num(p.sessions) || 0, students: num(p.students) || 0, guests: num(p.guests) || 0,
      guestShare: div(num(p.guests) || 0, num(p.sessions) || 0), minutes: num(p.minutes) || 0, smoothShare: num(p.smoothShare),
      stallShare: num(p.stallShare), avgLoadMs: num(p.avgLoadMs), slowInputShare: num(p.slowInputShare), errors: num(p.errors) || 0,
      npMax: num(p.npMax), newProfiles: num(p.newProfiles) || 0, z: p.z || '', build: p.build || '',
      flags: list(p.flags).filter(f => PC_FLAGS.includes(f))
    })).sort((a, b) => b.flags.length - a.flags.length || cmp(a.label, b.label) || cmp(a.p, b.p));
  }

  return Object.freeze({
    SMALL, BANDS, BUCKETS, PERSIST, MEASURES: Object.keys(MEASURES), LOWER_BETTER: [...LOWER_BETTER], PC_FLAGS, bucketLabel,
    isDay, shift, weekdayOf, daysBetween, weekOf, weekdays, weekdayCounts, weeksEnding, schoolYearStart,
    small, studentLabel, checkChar, codeQuery, fullCode, findStudents,
    statRows, pick, sumBy, total, measure, measuresOf, curve, curvesByBand, histogram, quantile, weekHours, activeHours,
    persist, persistShares, retryByGame, flows,
    newReturning, studentWeeks, bucketize, daysPerWeek, weeklyMinutes, winShare,
    cohortGrid, pairedRows, paired, hardestLevels, categories, pcRows
  });
}));
