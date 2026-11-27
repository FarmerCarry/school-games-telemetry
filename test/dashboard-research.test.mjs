// The dashboard's research maths (dashboard/research.js): weeks, quantiles from
// histograms, category sums, persistence shares, game-to-game flows, the school's PCs, the
// small-sample rule and labels; the research sentences of insights.js in both languages; the
// game facts the tabs need (names.js: categories, players, input and what each game's code
// reports for every catalog game; scores.js: what the score means in every game that passes
// one); and the research download: dictionary.js (its columns equal export.mjs COLUMNS, and
// its markdown is the research data doc), zip.js and export.js. Play is anonymous (schema 5):
// nothing here counts children. Pure Node: the dashboard files are plain browser scripts,
// loaded in a vm context.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { COLUMNS } from '../export.mjs';
import { BUCKETS as SERVER_BUCKETS, DROPPED_METRICS, METRICS, ROLLUPS } from '../rollups.mjs';
import { hideSqliteWarning } from '../warnings.mjs';

hideSqliteWarning();
const { DatabaseSync } = await import('node:sqlite');
const { createApp } = await import('../app.mjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.join(repo, 'dashboard');
// The games site's checkout, found the way dashboard/make-names.mjs finds it (SG_SITE_DIR, or
// school-games next to this repository). The tests that compare with the site's catalog and
// game code skip when it is not there.
const siteRoot = process.env.SG_SITE_DIR ? path.resolve(process.env.SG_SITE_DIR) : path.resolve(repo, '../school-games');
const SITE = fs.existsSync(path.join(siteRoot, 'js/catalog.js')) ? siteRoot : null;
const needsSite = { skip: SITE ? false : 'needs the school-games checkout (set SG_SITE_DIR)' };
function loadScripts(...files) {
  const window = {};
  for (const file of files) {
    vm.runInThisContext('(function (window) {' + fs.readFileSync(path.join(dashboard, file), 'utf8') + '\n})', { filename: file })(window);
  }
  return window;
}
const R = loadScripts('research.js').SGResearch;
const I = loadScripts('insights.js').SGInsights;
// The games site's catalog, in this realm too (so its arrays compare with deepStrictEqual).
const site = {};
if (SITE) vm.runInThisContext('(function (window) {' + fs.readFileSync(path.join(SITE, 'js/catalog.js'), 'utf8') + '\n})', { filename: 'catalog.js' })(site);
const strip = text => text.replace(/[⁦-⁩]/g, '');
const ARABIC = /[؀-ۿ]/, ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/, LATIN_WORD = /[A-Za-z]{2,}/;
// What schema 5 took out: children told apart and their age groups.
const NO_CHILDREN = /\bstudents?\b|\bage groups?\b|\bbands?\b/i;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' ≈ ' + b);

// The columns of the server's stats answer at the most (README.md: the keys and the sums of
// rollups.mjs r_stat; an answer keeps only the sums its metrics have).
const STAT_COLUMNS = ['metric', 'slug', 'k1', 'k2', ...ROLLUPS.r_stat.sums];
// One r_stat row from its named sums (the rest 0).
const row = (metric, slug, k1, k2, sums = {}) => STAT_COLUMNS.map(c => ({ metric, slug, k1, k2 })[c] ?? sums[c] ?? 0);
const stats = rows => ({ columns: STAT_COLUMNS, rows });

test('days and weeks follow the school\'s first weekday', () => {
  // 27 Oct 2026 is a Tuesday.
  assert.equal(R.weekdayOf('2026-10-27'), 2);
  assert.equal(R.weekOf('2026-10-27', 'sun'), '2026-10-25');
  assert.equal(R.weekOf('2026-10-27', 'mon'), '2026-10-26');
  assert.equal(R.weekOf('2026-10-25', 'sun'), '2026-10-25', 'a Sunday starts its own week');
  assert.equal(R.weekOf('2026-10-25', 'mon'), '2026-10-19');
  assert.deepEqual(R.weekdays('sun'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(R.weekdays('mon'), [1, 2, 3, 4, 5, 6, 0]);
  // 1-30 Oct 2026: 30 days from a Thursday; Thursday, Friday and Saturday occur 5 times.
  assert.deepEqual(R.weekdayCounts('2026-10-01', '2026-10-30'), [4, 4, 4, 4, 5, 5, 4]);
  assert.deepEqual(R.weekdayCounts('2026-10-02', '2026-10-01'), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(R.schoolYearStart('2026-10-27'), '2026-08-01');
  assert.equal(R.schoolYearStart('2027-03-05'), '2026-08-01');
  assert.equal(R.schoolYearStart('2026-08-01'), '2026-08-01');
  assert.equal(R.daysBetween('2026-10-01', '2026-10-27'), 26);
  assert.equal(R.shift('2026-12-31', 1), '2027-01-01');
});

test('the small-sample rule is the one insights.js uses: fewer than 20 tries', () => {
  assert.deepEqual({ ...R.SMALL }, { tries: I.T.SMALL_TRIES });
  for (const n of [100, 19, 20, null, 5, 0]) assert.equal(R.small(n), I.small(n), String(n));
  assert.equal(R.small(19), true);
  assert.equal(R.small(20), false);
  assert.equal(R.small(null), false, 'no count: nothing to flag');
});

test('r_stat rows: sums per game, and measures that are null without their denominator', () => {
  const rows = R.statRows(stats([
    row('fatigue', 'road-hopper', '0', '', { n: 10, w: 3, l: 5, hits: 30, misses: 10, rt_sum: 4000, rt_n: 8 }),
    row('fatigue', 'road-hopper', '0', '', { n: 6, w: 4, l: 1, hits: 18, misses: 2, rt_sum: 2400, rt_n: 6 }),
    row('fatigue', 'road-hopper', '5', '', { n: 4, w: 1, l: 1, q: 2 }),
    row('fatigue', 'dino-3d', '0', '', { n: 5, q: 5 }),
    row('tier', 'road-hopper', '2', '', { n: 8, w: 6, l: 2, ms: 120000, win_ms: 90000 })
  ]));
  assert.equal(rows.length, 5);
  assert.ok(!('a' in rows[0]) && !('students' in rows[0]), 'no age group and no student count in a row');
  assert.equal(R.pick(rows, 'fatigue', { slug: 'road-hopper' }).length, 3);
  assert.equal(R.pick(rows, 'fatigue', { band: '8-9' }).length, 4, 'an age group asked for picks nothing out');
  const all = R.total(R.pick(rows, 'fatigue', { slug: 'road-hopper' }));
  assert.deepEqual([all.n, all.w, all.l, all.hits, all.misses], [20, 8, 7, 48, 12]);
  assert.deepEqual(R.measure(all, 'winRate'), { value: 8 / 15, n: 15 });
  assert.deepEqual(R.measure(all, 'accuracy'), { value: 0.8, n: 60 });
  assert.deepEqual(R.measure(R.total([]), 'winRate'), { value: null, n: 0 }, 'no rounds won or lost: no win rate, not 0');
  // A curve over fatigue buckets, in bucket order.
  const curve = R.curve(rows, 'fatigue', 'winRate', { slug: 'road-hopper' });
  assert.deepEqual(curve.map(p => [p.k, p.n, p.rounds]), [[0, 13, 13], [5, 2, 4]]);
  close(curve[0].value, 7 / 13);
  const accuracy = R.curve(rows, 'fatigue', 'accuracy', { slug: 'road-hopper' });
  assert.equal(accuracy[0].value, 0.8);
  assert.equal(accuracy[1].value, null, 'minutes 5-10 counted no hits');
  // Missing numeric columns read as 0; text columns as ''.
  const short = R.statRows({ columns: ['metric', 'k1', 'n'], rows: [['games', '1', 3], 'not a row'] });
  assert.deepEqual([short.length, short[0].w, short[0].slug], [1, 0, '']);
  assert.deepEqual(R.statRows(null), []);
});

test('bucket labels and quantiles from a histogram', () => {
  // The buckets the server counts are the dashboard's, and none of the metrics schema 5 dropped.
  for (const [metric, bounds] of Object.entries(SERVER_BUCKETS)) assert.deepEqual(R.BUCKETS[metric], bounds, metric);
  for (const metric of Object.keys(R.BUCKETS)) assert.ok(METRICS.includes(metric) && !DROPPED_METRICS.includes(metric), metric);
  assert.deepEqual(R.BUCKETS.games.map(k => R.bucketLabel('games', k)), ['1', '2', '3', '4', '5', '6–7', '8+']);
  assert.equal(R.bucketLabel('sesslen', 5), '5–10', 'minutes: from 5 up to 10');
  assert.equal(R.bucketLabel('tier', 9), '9+');
  const hist = R.histogram(R.statRows(stats([row('sesslen', '', '0', '3', { n: 10 }), row('sesslen', '', '5', '3', { n: 10 }),
    row('sesslen', '', '10', '2', { n: 20 })])), 'sesslen');
  assert.deepEqual(hist.map(b => b.n), [10, 0, 0, 10, 20, 0, 0, 0, 0, 0]);
  // 40 sessions: the 20th falls at the end of the 5-10 bucket.
  assert.deepEqual(R.quantile(hist, 0.5), { value: 10, open: false });
  assert.deepEqual(R.quantile(hist, 0.25), { value: 1, open: false }, 'linear inside 0-1');
  close(R.quantile(hist, 0.75).value, 12.5);
  // The last bucket has no end: a quantile there is "60 or more".
  assert.deepEqual(R.quantile([{ k: 30, n: 1 }, { k: 60, n: 3 }], 0.5), { value: 60, open: true });
  assert.equal(R.quantile([{ k: 0, n: 0 }], 0.5), null);
  // A count (games per session, losses in a row, tier) is never 3.7: the bucket that holds the quantile.
  const games = R.histogram(R.statRows(stats([1, 2, 3, 4].map((k, i) => row('games', '', String(k), '', { n: [115, 384, 503, 350][i] })))), 'games');
  close(R.quantile(games, 0.5).value, 3.352, 0.001);
  assert.deepEqual(R.quantile(games, 0.5, 'games'), { value: 3, open: false, label: '3' });
  assert.deepEqual(R.quantile([{ k: 1, n: 1 }, { k: 6, n: 3 }, { k: 8, n: 0 }], 0.5, 'games'), { value: 6, open: false, label: '6–7' });
  assert.deepEqual(R.quantile([{ k: 6, n: 1 }, { k: 8, n: 3 }], 0.5, 'games'), { value: 8, open: true, label: '8+' });
  assert.deepEqual(R.quantile(hist, 0.5, 'sesslen'), { value: 10, open: false }, 'minutes stay linear');
});

test('when they play: weekday x hour, averaged over the days of the period', () => {
  const rows = R.statRows(stats([
    row('hour', '', '10', '0', { n: 4, ms: 600000 }),
    row('hour', '', '10', '0', { n: 2, ms: 300000 }),
    row('hour', '', '14', '3', { n: 1, ms: 60000 })
  ]));
  // 4-17 Oct 2026: two Sundays, two Wednesdays. perDay is the game opens on such a day and
  // hour: 6 opens over 2 Sundays.
  const grid = R.weekHours(rows, { from: '2026-10-04', to: '2026-10-17', weekStart: 'sun' });
  assert.deepEqual(grid.map(r => r.weekday), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(grid[0].cells[10], { hour: 10, minutes: 15, visits: 6, occurrences: 2, perDay: 3 });
  assert.equal(grid[3].cells[14].minutes, 1);
  assert.equal(grid[1].cells[10].visits, 0);
  assert.deepEqual(R.weekHours(rows, { from: '2026-10-04', to: '2026-10-17', weekStart: 'mon' }).map(r => r.weekday), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(R.activeHours(grid), [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.deepEqual(R.activeHours(grid, 10, 12), [10, 11, 12, 13, 14], 'widened to the play outside');
});

test('persistence after a loss: same level, another level, another game, stop, and the retry gap', () => {
  const rows = R.statRows(stats([
    row('persist', 'road-hopper', 'l', 'same', { n: 6, gap_sum: 60, gap_n: 6 }),
    row('persist', 'road-hopper', 'l', 'level', { n: 2, gap_sum: 40, gap_n: 2 }),
    row('persist', 'road-hopper', 'q', 'game', { n: 1 }),
    row('persist', 'road-hopper', 'q', 'stop', { n: 1 }),
    row('persist', 'road-hopper', 'w', 'same', { n: 50 }),
    row('persist', 'candy-rope', 'l', 'same', { n: 1 }),
    row('persist', 'candy-rope', 'l', 'stop', { n: 3 })
  ]));
  const p = R.persist(rows, { slug: 'road-hopper' });
  assert.deepEqual(p.counts, { same: 6, level: 2, game: 1, stop: 1 }, 'wins are not losses');
  assert.deepEqual(p.shares, { same: 0.6, level: 0.2, game: 0.1, stop: 0.1 });
  assert.equal(p.n, 10);
  assert.ok(!('students' in p), 'counted in rounds, not children');
  assert.equal(p.retryGap, 100 / 8, 'the mean seconds before the retry, same or another level');
  assert.equal(R.persist(rows, { slug: 'road-hopper', codes: ['w'] }).shares.same, 1);
  assert.deepEqual(R.persist(rows, { slug: 'dino-3d' }).shares, { same: null, level: null, game: null, stop: null });
  assert.deepEqual(R.retryByGame(rows).map(g => [g.slug, g.share, g.n]), [['road-hopper', 0.6, 10], ['candy-rope', 0.25, 4]]);
  // Game-to-game moves, '' being a session's start or end.
  const flows = R.statRows(stats([row('flow', 'road-hopper', 'dino-3d', '', { n: 5, gap_sum: 50, gap_n: 5 }),
    row('flow', 'road-hopper', 'dino-3d', '', { n: 3, gap_sum: 30, gap_n: 3 }), row('flow', '', 'road-hopper', '', { n: 9 }),
    row('flow', 'dino-3d', '', '', { n: 7 })]));
  assert.deepEqual(R.flows(flows), [{ from: '', to: 'road-hopper', n: 9, gap: null }, { from: 'road-hopper', to: 'dino-3d', n: 8, gap: 10 }, { from: 'dino-3d', to: '', n: 7, gap: null }]);
  assert.deepEqual(R.flows(flows, { games: true }).map(e => e.n), [8], 'only game to game');
});

test('categories and the school PCs', () => {
  const info = { a: { cats: ['arcade', 'running'] }, b: { cats: ['puzzle'] }, c: { cats: [] } };
  assert.deepEqual(R.categories([{ slug: 'a', engagedMinutes: 10, opens: 2 }, { slug: 'b', engagedMinutes: 30, opens: 1 }, { slug: 'c', engagedMinutes: 1, opens: 1 },
    { slug: 'd', suppressed: true }], info), [
    { id: 'puzzle', minutes: 30, opens: 1, games: 1 }, { id: 'arcade', minutes: 10, opens: 2, games: 1 }, { id: 'running', minutes: 10, opens: 2, games: 1 },
    { id: '', minutes: 1, opens: 1, games: 1 }], 'a game in two categories counts in both');
  assert.deepEqual(R.PC_FLAGS, ['choppy', 'old']);
  const pcs = R.pcRows({ pcs: [{ p: '8c21d0e94a6f', label: '8C21', sessions: 10, flags: [] }, { p: '0b11aa22cc33', label: '0B11', sessions: 5, flags: ['old', 'nonsense'] },
    { p: 'ffee00112233', sessions: 1 }, { label: 'no code' }] });
  assert.deepEqual(pcs.map(p => [p.label, p.flags, p.sessions]), [['0B11', ['old'], 5], ['8C21', [], 10], ['FFEE', [], 1]],
    'PCs with a flag first; no label: the first 4 characters; no code: no row');
  for (const key of ['students', 'guests', 'guestShare', 'npMax', 'newProfiles']) assert.ok(!(key in pcs[0]), key);
});

test('the research sentences: one of each kind, in both languages, associations with their sample sizes', () => {
  const facts = {
    persist: [{ slug: 'road-hopper', share: 0.64, n: 80 }, { slug: 'dino-3d', share: 0.3, n: 50 }, { slug: 'candy-rope', share: 0.9, n: 3 }],
    tired: { early: { value: 0.61, n: 100 }, late: { value: 0.52, n: 60 } },
    session: { median: 8.2, open: false, n: 300 },
    peak: { weekday: 0, hour: 10, share: 0.09 }
  };
  const names = { 'bubble-bop': ['فقاعات بوب', 'Bubble Bop'], 'road-hopper': ['عبور الطريق', 'Road Hopper'] };
  const opts = lang => ({ lang, name: slug => (names[slug] || [slug, slug])[lang === 'ar' ? 0 : 1], weekday: d => lang === 'ar' ? ['الأحد'][d] : ['Sunday'][d] });
  const en = I.researchInsights(facts, opts('en')), ar = I.researchInsights(facts, opts('ar'));
  assert.deepEqual(en.map(s => s.kind), ['persist', 'tired', 'session', 'peak']);
  assert.deepEqual(ar.map(s => s.kind + s.key), en.map(s => s.kind + s.key));
  assert.equal(en[0].text, 'After losing or leaving a round of Road Hopper, children try the same level again 64% of the time, more than in any other game.',
    'a game with 3 tries is not compared');
  assert.equal(en[1].text, 'Children win 52% of their rounds after 20 minutes of play, against 61% in the first 10 minutes of a session.');
  assert.equal(en[2].text, 'Half of the play sessions last 8 minutes or less.');
  assert.equal(en[3].text, 'The busiest time is Sunday at 10:00, with 9% of the play time.');
  assert.equal(strip(ar[0].text), 'بعد خسارة جولة أو تركها في «عبور الطريق» يعيد الأطفال المرحلة نفسها في 64% من المرات، أكثر من أي لعبة أخرى.');
  assert.equal(strip(ar[2].text), 'تنتهي نصف جلسات اللعب خلال 8 دقائق أو أقل.');
  for (const s of ar) {
    assert.ok(ARABIC.test(s.text) && !ARABIC_INDIC_DIGITS.test(s.text), s.text);
    assert.ok(!LATIN_WORD.test(strip(s.text)), 'no English words: ' + s.text);
  }
  for (const s of en) assert.ok(!ARABIC.test(s.text), s.text);
  for (const s of [...en, ...ar]) assert.ok(!('students' in s), 'a sample is tries, never children: ' + s.kind);
  assert.deepEqual([en[0].tries, en[0].small], [80, false]);
  // A sentence on a small sample carries the flag; nothing to say is said plainly.
  const smallGroup = I.researchInsights({ session: { median: 8.2, open: false, n: 12 } }, opts('en'));
  assert.deepEqual([smallGroup[0].tries, smallGroup[0].small], [12, true]);
  assert.deepEqual(I.researchInsights({}, opts('en')).map(s => s.kind), ['quiet']);
  assert.deepEqual(I.researchInsights(null, opts('ar')).map(s => s.kind), ['quiet']);
  // An older server's same-children growth facts say nothing now.
  assert.deepEqual(I.researchInsights({ growth: [{ slug: 'bubble-bop', measure: 'accuracy', band: '8-9', students: 12, before: 0.62, after: 0.71 }] },
    opts('en')).map(s => s.kind), ['quiet']);
  // A small change in tiredness is no finding.
  assert.ok(!I.researchInsights({ tired: { early: { value: 0.6, n: 100 }, late: { value: 0.58, n: 100 } } }, opts('en')).some(s => s.kind === 'tired'));
});

test('names.js and scores.js agree with each other: every game named, its categories named, its flags 0 or 1', () => {
  const w = loadScripts('names.js', 'scores.js');
  const slugs = Object.keys(w.SG_GAME_NAMES).sort();
  assert.deepEqual(Object.keys(w.SG_GAME_INFO).sort(), slugs);
  for (const slug of slugs) {
    const info = w.SG_GAME_INFO[slug];
    for (const c of info.cats) assert.ok(Object.hasOwn(w.SG_CATEGORIES, c), slug + ': ' + c);
    assert.ok(Number.isInteger(info.players) && info.players >= 1, slug);
    for (const flag of ['dda', 'track', 'tutorial']) assert.ok(info[flag] === 0 || info[flag] === 1, slug + ' ' + flag);
  }
  for (const [id, [ar, en]] of Object.entries(w.SG_CATEGORIES)) assert.ok(ARABIC.test(ar) && en && !ARABIC.test(en), id);
  for (const [slug, [ar, en]] of Object.entries(w.SG_SCORES)) {
    assert.ok(slugs.includes(slug), slug + ': a catalog game');
    assert.ok(ARABIC.test(ar) && !LATIN_WORD.test(ar), slug + ': ' + ar);
    assert.ok(en && !ARABIC.test(en) && /^[a-z]/.test(en), slug + ': ' + en);
  }
});

test('names.js carries every catalog game\'s categories, players and input, and every category\'s names', needsSite, () => {
  const w = loadScripts('names.js');
  assert.deepEqual(Object.keys(w.SG_GAME_INFO).sort(), site.GAMES.map(g => g.slug).sort());
  // What the games' own code reports (the M2.5 spec §B.5), read here from
  // games/<slug>/: Kit.dda adapts the difficulty, Kit.track counts hits and reaction times,
  // Kit.stats.tutorial shows a tutorial.
  const uses = (slug, pattern) => {
    const dir = path.join(SITE, 'games', slug);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(?:js|html)$/.test(f)) : [];
    return files.some(f => pattern.test(fs.readFileSync(path.join(dir, f), 'utf8'))) ? 1 : 0;
  };
  const CODE = { dda: /\bKit\.dda\b/, track: /\bKit\.track\b/, tutorial: /\bstats\.tutorial\b/ };
  for (const g of site.GAMES) {
    const info = w.SG_GAME_INFO[g.slug];
    assert.deepEqual(info.cats, g.cats, g.slug);
    assert.equal(info.players, Math.max(...g.players.split('-').map(Number)), g.slug);
    assert.equal(info.input, g.inputStyle, g.slug);
    for (const [flag, pattern] of Object.entries(CODE)) assert.equal(info[flag], uses(g.slug, pattern), g.slug + ' ' + flag);
  }
  // The demo's adaptive games (dashboard/make-demo.mjs) are adaptive in the site's code too.
  for (const slug of ['bubble-bop', 'dino-3d', 'road-hopper']) assert.equal(w.SG_GAME_INFO[slug].dda, 1, slug);
  assert.deepEqual(Object.keys(w.SG_CATEGORIES), site.CATEGORIES.map(c => c.id));
  for (const c of site.CATEGORIES) {
    const [ar, en] = w.SG_CATEGORIES[c.id];
    assert.equal(ar, c.label);
    assert.ok(en && !ARABIC.test(en), c.id);
  }
});

test('scores.js says what the score means in exactly the games that pass one', needsSite, () => {
  const scores = loadScripts('scores.js').SG_SCORES;
  // The games' own code: a Kit.stats.end(result, score) call with a second argument
  // (a comma at the call's own depth, so a condition in parentheses counts as one argument).
  const twoArguments = text => {
    for (let at = text.indexOf('stats.end('); at >= 0; at = text.indexOf('stats.end(', at + 1)) {
      for (let i = at + 10, depth = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') { if (!depth) break; depth--; } else if (ch === ',' && !depth) return true;
      }
    }
    return false;
  };
  const passes = slug => {
    const dir = path.join(SITE, 'games', slug);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter(f => /\.js$/.test(f) && !/\.min\.js$/.test(f)) : [];
    return files.some(f => twoArguments(fs.readFileSync(path.join(dir, f), 'utf8')));
  };
  const scoring = site.GAMES.map(g => g.slug).filter(passes).sort();
  assert.ok(scoring.length > 0 && scoring.length < site.GAMES.length, 'some games pass a score and some do not');
  assert.deepEqual(Object.keys(scores).sort(), scoring);
});

// ---- the research download ----------------------------------------------------------------------
const W = loadScripts('dictionary.js', 'zip.js', 'export.js', 'names.js', 'scores.js');
const D = W.SGDictionary, Z = W.SGZip, E = W.SGExport;
// The entries of a ZIP: { name: { data (Buffer), method } }, each checked against its CRC and size.
function unzip(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let end = buffer.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  const out = {};
  for (let i = 0, p = view.getUint32(end + 16, true); i < view.getUint16(end + 10, true); i++) {
    const method = view.getUint16(p + 10, true), crc = view.getUint32(p + 16, true), packed = view.getUint32(p + 20, true), size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true), at = view.getUint32(p + 42, true), name = buffer.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    assert.equal(view.getUint32(at, true), 0x04034b50, name + ': local header');
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true), raw = buffer.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, size, name + ': size');
    assert.equal(zlib.crc32(data), crc, name + ': CRC');
    out[name] = { data, method };
    p += 46 + nameLength;
  }
  return out;
}

test('dictionary.js lists exactly the columns of export.mjs, each with both meanings', () => {
  assert.deepEqual(D.SERVER_FILES, Object.keys(COLUMNS), 'the server\'s files, in the order of the download');
  for (const [file, columns] of Object.entries(COLUMNS)) {
    assert.deepEqual(D.columns(file), columns, file);
    assert.equal(D.header(file), columns.join(','), file);
  }
  const TYPES = ['code', 'text', 'category', 'integer', 'decimal', 'flag', 'date', 'time', 'datetime'];
  for (const f of D.FILES) {
    assert.equal(new Set(D.columns(f.file)).size, f.columns.length, f.file + ': no column twice');
    assert.ok(f.one[0] && ARABIC.test(f.one[1]), f.file);
    for (const col of f.columns) {
      const [name, type, unit, values, en, ar, source, available] = col;
      assert.equal(col.length, 8, f.file + '.' + name);
      assert.match(name, /^[a-z][a-z0-9_]*$/, f.file);
      assert.ok(TYPES.includes(type), f.file + '.' + name + ': ' + type);
      assert.equal(typeof unit, 'string');
      assert.equal(typeof values, 'string');
      assert.ok(en && !ARABIC.test(en), f.file + '.' + name + ': ' + en);
      assert.ok(ARABIC.test(ar) && !ARABIC_INDIC_DIGITS.test(ar), f.file + '.' + name + ': ' + ar);
      assert.ok(source, f.file + '.' + name);
      assert.ok(D.AVAILABLE.includes(available), f.file + '.' + name + ': ' + available);
      if (type === 'flag') assert.equal(values, '0, 1', f.file + '.' + name);
    }
  }
  assert.deepEqual(D.columns('games'), ['game', 'name_ar', 'name_en', 'categories', 'players', 'input_style', 'has_levels', 'dda', 'reports_hits',
    'reports_reaction', 'reports_score', 'score_meaning_en', 'score_meaning_ar', 'tutorial']);
  assert.deepEqual(D.columns('dictionary'), ['file', 'column', 'type', 'unit', 'values', 'meaning_en', 'meaning_ar', 'source', 'available_for']);
  for (const [en, ar] of D.NOTES) {
    assert.ok(en && !ARABIC.test(en) && ARABIC.test(ar));
    assert.doesNotMatch(en, NO_CHILDREN, 'no note on children told apart or their age groups');
  }
  for (const f of D.FILES) for (const [name] of f.columns) assert.doesNotMatch(name, /student|band|^age/, f.file + '.' + name);
});

test('the research data doc is the dictionary\'s own output (node dashboard/dictionary.js --md)', () => {
  const md = D.markdown();
  assert.equal(md, D.markdown(), 'the same text every time');
  const cli = spawnSync(process.execPath, [path.join(dashboard, 'dictionary.js'), '--md'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, md);
  for (const f of D.FILES) {
    assert.ok(md.includes('### `' + f.file + '.csv`'), f.file);
    for (const [name, , , , en, ar] of f.columns) assert.ok(md.includes(name) && md.includes(en.split('\n')[0]) && md.includes(ar.split('\n')[0]), f.file + '.' + name);
  }
  assert.doesNotMatch(md, NO_CHILDREN);
});

test('no player-card leftovers in the dashboard or the research data doc (the owner said no, for good)', () => {
  // "card" alone is the dashboard's own layout word (a chart card, a game card); these are the player cards.
  const CARDS = /🎴|player.?cards?|card codes?|\/v1\/admin\/cards|kind\s*[:=]+\s*['"]card['"]|['"]card['"]\s*\]|(?<![#0-9a-z])c[0-9a-f]{4}(?![0-9a-z])/i;
  const texts = fs.readdirSync(dashboard).filter(f => /\.(js|mjs|html|css|md)$/.test(f))
    .map(f => [path.join('dashboard', f), fs.readFileSync(path.join(dashboard, f), 'utf8')])
    .concat([['the research data doc (D.markdown())', D.markdown()], ['README.txt (D.readme())', D.readme({ from: '2026-09-01', to: '2026-10-27' })]]);
  for (const [name, text] of texts) {
    const hit = text.split('\n').findIndex(line => CARDS.test(line));
    assert.equal(hit, -1, name + (hit >= 0 ? ':' + (hit + 1) : ''));
  }
});

test('the browser\'s files: games.csv, dictionary.csv, README.txt in both languages, labels.sps and load.R', () => {
  const parse = text => text.trim().split('\n').map(line => {
    const cells = [];
    for (let i = 0, cur = '', quoted = false; i <= line.length; i++) {
      const ch = line[i];
      if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ',' || ch === undefined) { cells.push(cur); cur = ''; } else cur += ch;
    }
    return cells;
  });
  const games = parse(D.gamesCsv({ games: W.SG_GAME_NAMES, about: W.SG_GAME_INFO, scores: W.SG_SCORES, levels: { 'road-hopper': 4, 'dino-3d': 1 } }));
  assert.deepEqual(games[0], D.columns('games'));
  assert.equal(games.length, 1 + Object.keys(W.SG_GAME_NAMES).length, 'one row per game of names.js');
  const of = slug => Object.fromEntries(D.columns('games').map((c, i) => [c, games.find(r => r[0] === slug)[i]]));
  const hopper = of('road-hopper');
  assert.equal(hopper.name_en, 'Road Hopper');
  assert.ok(ARABIC.test(hopper.name_ar));
  assert.deepEqual([hopper.has_levels, hopper.dda, hopper.reports_hits, hopper.reports_reaction, hopper.reports_score, hopper.tutorial], ['1', '1', '1', '1', '1', '1']);
  assert.equal(of('dino-3d').has_levels, '0');
  assert.equal(of('tic-tac-toe').has_levels, '', 'not played in the period');
  assert.deepEqual([of('tic-tac-toe').reports_score, of('tic-tac-toe').score_meaning_en], ['0', '']);
  assert.equal(of('beat-dash').score_meaning_en, W.SG_SCORES['beat-dash'][1], 'a meaning with a comma, quoted');
  const dictionary = parse(D.dictionaryCsv());
  assert.deepEqual(dictionary[0], D.columns('dictionary'));
  assert.equal(dictionary.length - 1, D.FILES.reduce((n, f) => n + f.columns.length, 0));
  assert.ok(dictionary.every(r => r.length === 9));

  const files = [{ name: 'sessions.csv', rows: 3 }, { name: 'rounds-2026-09.csv', rows: 1 }, { name: 'rounds-2026-10.csv', rows: 12 }];
  const readme = D.readme({ from: '2026-09-01', to: '2026-10-27', tz: 'Asia/Riyadh', exported: '2026-10-27 10:40', files, factsSince: '2026-09-02',
    legacyUntil: '2026-09-02', v3Since: '2026-09-10', part: 2, stopped: { file: 'events' } });
  for (const text of ['2026-09-01', 'Asia/Riyadh', 'sessions.csv: 3 rows, one per play session', 'rounds-2026-09.csv: 1 row, one per round', 'part 2',
    'stopped early, in events.csv', 'Up to 2026-09-02', 'From 2026-09-10', 'GET DATA /TYPE=TXT /ENCODING=\'UTF8\'', 'fileEncoding = "UTF-8-BOM"',
    'lme4::glmer(win ~ log(round) + (1 | pc) + (1 | game)', 'MIXED', 'Count sessions, visits and rounds, never children',
    'no names and no codes for children', 'sessions.csv: 3 صفوف', 'rounds-2026-09.csv: صف واحد', 'rounds-2026-10.csv: 12 صفًّا']) {
    assert.ok(readme.includes(text), text);
  }
  for (const [en, ar] of D.NOTES) assert.ok(readme.includes(en) && readme.includes(ar));
  // Parts are made on different days: what was played in between is in the later part only.
  for (const text of ['made on different days', 'sessions that are in no sessions.csv', 'a period that ends yesterday or earlier',
    'صُنعت الأجزاء في أيام مختلفة', 'لا توجد في أي ملف sessions.csv']) assert.ok(readme.includes(text), text);
  const first = D.readme({ from: '2026-09-01', to: '2026-10-27', part: 1, stopped: { file: 'rounds' } });
  for (const text of ['in the next part only', 'في الجزء التالي وحده']) assert.ok(first.includes(text), text);
  assert.ok(!D.readme({ from: '2026-09-01', to: '2026-10-27' }).includes('different days'), 'one download in one go says nothing of parts');
  assert.doesNotMatch(readme, /card/i, 'there are no player cards');
  assert.doesNotMatch(readme, NO_CHILDREN, 'no student codes and no age groups');
  const names = files.map(f => f.name).concat(['games.csv', 'dictionary.csv']);
  const sps = D.spss(names);
  for (const name of names) {
    const block = sps.slice(sps.indexOf("/FILE='" + name + "'"));
    const variables = /\/VARIABLES=([^\n]*)\./.exec(block)[1].split(' ');
    assert.equal(variables.length / 2, D.columns(name.replace(/\.csv$/, '').replace(/-\d{4}-\d\d$/, '')).length, name);
  }
  assert.match(sps, /VALUE LABELS [^.]*outcome 'win' 'win' 'loss' 'loss'/);
  const r = D.rLoader(names);
  assert.match(r, /rounds <- read_sg\(c\("rounds-2026-09\.csv", "rounds-2026-10\.csv"\)/, 'the months of rounds as one table');
  assert.match(r, /sessions\$end_reason <- factor\(sessions\$end_reason, levels = c\("unload", "switch", "handover", "idle"\)\)/);
  assert.doesNotMatch(r, /visits <-/, 'only the files of the download');
  assert.doesNotMatch(sps + r, NO_CHILDREN);
});

test('export.js: the cost of a download is the rows its SQL reads, not the lines it writes', async () => {
  // A simulated school's facts, its KPI answer, and the rows each file's lookups in
  // export.mjs must read at the least (D1 counts every row a statement reads; the
  // Node driver counts only the rows returned, so this is counted from the facts).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-export-cost-'));
  const dbPath = path.join(dir, 'telemetry.db');
  const sim = spawnSync(process.execPath, [path.join(repo, 'simulate.mjs'), '--db', dbPath, '--days', '14', '--sessions', '40', '--seed', '3'], { encoding: 'utf8' });
  assert.equal(sim.status, 0, sim.stderr);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const one = sql => Object.values(db.prepare(sql).get())[0];
  const [S, V, N] = ['st_sessions', 'st_visits', 'st_rounds'].map(table => one('SELECT COUNT(*) FROM ' + table));
  const ofKind = kind => one(`SELECT COUNT(*) FROM st_marks WHERE kind = '${kind}'`);
  const ofVisit = (table, where) => one(`SELECT TOTAL((SELECT COUNT(*) FROM ${table} x WHERE ${where})) FROM st_visits v`);
  // A session line: itself, its visits twice, its rounds and its timer marks three times; a
  // visit line: itself, its session, the visits before and after, its rounds twice and its
  // session's heart and tutorial marks twice; a round line: itself, its session and the round
  // before; an event line (the heart, tutorial and timer marks only): itself, its session and its visit.
  const marks = ofKind('fv') + ofKind('tu') + ofKind('ct');
  const floor = {
    sessions: S + V * 2 + N + ofKind('ct') * 3,
    visits: V * 4 + 2 * ofVisit('st_rounds', 'x.sid = v.sid AND x.n = v.n') + 2 * ofVisit('st_marks', "x.sid = v.sid AND x.kind IN ('tu', 'fv')"),
    rounds: N * 3, events: marks * 3
  };
  db.close();
  const app = createApp({ dbPath, adminToken: 'export-cost-token-0123456789' });
  try {
    const base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1')).port;
    const get = async route => (await fetch(base + route, { headers: { Authorization: 'Bearer export-cost-token-0123456789' } })).json();
    const settings = await get('/v1/admin/settings');
    const to = settings.clock.today, from = R.shift(to, -20);
    const est = E.estimate(await get(`/v1/admin/kpis?from=${from}&to=${to}`), settings.usage, 21);
    const least = Object.values(floor).reduce((a, b) => a + b, 0);
    assert.ok(least > 5 * est.lines, 'the lookups read several rows a line');
    // The KPI answer does not count the timer marks, so the estimate may fall a little short of the floor.
    assert.ok(est.rows >= 0.9 * least && est.rows <= 1.5 * least, est.rows + ' rows estimated, ' + least + ' at the least');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('zip.js: deflated and stored entries any unzip tool reads, with streaming CRCs', async () => {
  assert.equal(Z.crc32(Buffer.from('hello world')), zlib.crc32('hello world'));
  assert.equal(Z.crc32(Buffer.from(' world'), Z.crc32(Buffer.from('hello'))), zlib.crc32('hello world'), 'the CRC goes on from the bytes before');
  const big = new Blob(['﻿a,b\n', ...Array.from({ length: 4000 }, (_, i) => i + ',' + 'x'.repeat(i % 40) + '\n')]);
  const blob = await Z.zip([{ name: 'rounds.csv', blob: big }, { name: 'اقرأني.txt', blob: 'نص قصير' }, { name: 'empty.csv', blob: '' }], { when: new Date(2026, 9, 27, 10, 40) });
  assert.equal(blob.type, 'application/zip');
  const files = unzip(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ['rounds.csv', 'اقرأني.txt', 'empty.csv']);
  assert.equal(files['rounds.csv'].method, 8, 'deflated');
  // (Blob.text() would drop the byte-order mark: compare the bytes.)
  assert.equal(files['rounds.csv'].data.toString('utf8'), Buffer.from(await big.arrayBuffer()).toString('utf8'));
  assert.equal(files['اقرأني.txt'].data.toString('utf8'), 'نص قصير');
  assert.equal(files['اقرأني.txt'].method, 0, 'a short file that deflating does not shrink is stored');
  const stored = unzip(Buffer.from(await (await Z.zip([{ name: 'a.csv', blob: big }], { store: true })).arrayBuffer()));
  assert.equal(stored['a.csv'].method, 0);
  assert.equal(stored['a.csv'].data.length, big.size);
});

test('export.js: every page once, a header from the dictionary, rounds by month, and part 2 after the reading guard', async () => {
  // A server of three pages of rounds over two months and one page of everything else; the
  // reading guard answers the second page of events.
  const line = (file, i, day = '2026-10-0' + (1 + (i % 5))) => D.columns(file).map(c => c === 'day' ? day : c === 'session' ? 's' + i : '').join(',');
  const pages = {
    rounds: [[0, 1, 2].map(i => line('rounds', i, '2026-09-30')).join('\n') + '\n', [3, 4].map(i => line('rounds', i)).join('\n') + '\n', line('rounds', 5) + '\n'],
    events: [line('events', 0) + '\n', line('events', 1) + '\n']
  };
  const asked = [];
  const page = guard => (file, after) => {
    asked.push(file + ':' + after);
    const list = pages[file] || [line(file, 0) + '\n'], k = after ? Number(after) : 0;
    if (guard && file === 'events' && k === 1) return Promise.reject({ kind: 'busy', status: 429, body: { error: 'reads', until: '03:00' } });
    return Promise.resolve({ text: list[k], next: k + 1 < list.length ? String(k + 1) : null });
  };
  const progress = [];
  assert.deepEqual(E.FILES, Object.keys(COLUMNS), 'the server\'s files, in export.mjs order');
  const job = E.job({ from: '2026-09-01', to: '2026-10-27', page: page(true), split: 4, onProgress: p => progress.push(p) });
  assert.equal(await job.run(), 'stopped');
  assert.deepEqual(job.stopped, { file: 'events', after: '1', until: '03:00' });
  assert.deepEqual(asked, ['sessions:null', 'visits:null', 'rounds:null', 'rounds:1', 'rounds:2', 'events:null', 'events:1']);
  assert.equal(progress.at(-1).lines, 1 + 1 + 6 + 1);
  const one = await job.zip({ games: { games: W.SG_GAME_NAMES, about: W.SG_GAME_INFO, scores: W.SG_SCORES }, readme: { from: '2026-09-01', to: '2026-10-27' } }, new Date(2026, 9, 27));
  assert.equal(one.name, 'school-games-data_2026-09-01_2026-10-27.zip');
  const files = unzip(Buffer.from(await one.blob.arrayBuffer()));
  // 6 rounds pass the split of 4 in this test: one file per month.
  assert.deepEqual(Object.keys(files), ['sessions.csv', 'visits.csv', 'rounds-2026-09.csv', 'rounds-2026-10.csv', 'events.csv', 'games.csv',
    'dictionary.csv', 'README.txt', 'labels.sps', 'load.R']);
  const text = name => files[name].data.toString('utf8');
  for (const name of ['sessions.csv', 'rounds-2026-09.csv', 'events.csv', 'games.csv', 'dictionary.csv', 'README.txt']) assert.ok(text(name).startsWith('﻿'), name + ': BOM');
  assert.equal(text('rounds-2026-09.csv'), '﻿' + D.header('rounds') + '\n' + pages.rounds[0]);
  assert.equal(text('rounds-2026-10.csv').split('\n').length - 2, 3);
  assert.equal(text('events.csv'), '﻿' + D.header('events') + '\n' + pages.events[0], 'the rows before the guard');
  assert.match(text('README.txt'), /stopped early, in events\.csv/);
  assert.match(text('README.txt'), /rounds-2026-10\.csv: 3 rows/);
  // Part 2 goes on from the cursor and holds only what part 1 did not.
  asked.length = 0;
  const two = E.job({ from: '2026-09-01', to: '2026-10-27', page: page(false), part: 2, file: job.stopped.file, after: job.stopped.after });
  assert.equal(await two.run(), 'done');
  assert.deepEqual(asked, ['events:1', 'daily_games:null', 'pcs:null']);
  const second = await two.zip({}, new Date(2026, 9, 28));
  assert.equal(second.name, 'school-games-data_2026-09-01_2026-10-27_part2.zip');
  const rest = unzip(Buffer.from(await second.blob.arrayBuffer()));
  assert.deepEqual(Object.keys(rest).filter(n => n.endsWith('.csv')), ['events.csv', 'daily_games.csv', 'pcs.csv', 'games.csv', 'dictionary.csv']);
  assert.equal(rest['events.csv'].data.toString('utf8'), '﻿' + D.header('events') + '\n' + pages.events[1]);
  assert.match(rest['README.txt'].data.toString('utf8'), /This is part 2 of the download/);
  // Without the split, one rounds.csv in the server's order.
  const whole = E.job({ from: '2026-09-01', to: '2026-10-27', page: page(false) });
  assert.equal(await whole.run(), 'done');
  const all = (await whole.entries({})).find(e => e.name === 'rounds.csv');
  assert.equal(Buffer.from(await all.blob.arrayBuffer()).toString('utf8'), '﻿' + D.header('rounds') + '\n' + pages.rounds.join(''));
  assert.equal(all.rows, 6);
  // A network failure keeps the rows: run() again asks for the same page.
  let fail = true;
  const flaky = E.job({ from: '2026-09-01', to: '2026-10-27', page: (file, after) => file === 'visits' && fail ? (fail = false, Promise.reject({ kind: 'network' })) : page(false)(file, after) });
  await assert.rejects(flaky.run(), f => f.kind === 'network');
  assert.equal(await flaky.run(), 'done');
  assert.equal((await flaky.entries({})).find(e => e.name === 'sessions.csv').rows, 1, 'nothing fetched twice');
  // The cost before starting, from the period's KPIs.
  const est = E.estimate({ totals: { sessions: 100, gameOpens: 250, roundsStarted: 1100, roundsEnded: 1000 },
    games: [{ slug: 'a', hearts: { on: 5, off: 1 }, tutorials: { start: 10, done: 4 } }], quality: { pcsNew: 12 } }, { reads: 3499000, readsLimit: 5000000 }, 30);
  assert.equal(est.lines, 100 + 250 + 1100 + 20 + 30 + 12);
  // The rows the server's lookups read for each file (export.js estimate): sessions, visits
  // (2.5 visits a session, 20 heart and tutorial marks), rounds, events, game-days, PCs.
  assert.equal(est.rows, (200 + 500 + 1100 + 20) + (1000 + 2200 + 2 * 20 * 2.5) + 3300 + 60 + 30 + (24 + 100));
  assert.equal(est.share, est.rows / 5000000);
  assert.equal(est.stops, true, 'today’s reads so far plus these pass the export guard');
  assert.equal(E.estimate({ totals: { sessions: 100 } }, { reads: 0 }, 1).stops, false);
  // An older server's student counts and level-ups add nothing.
  assert.deepEqual(E.estimate({ totals: { sessions: 100, levelUps: 40, students: { active: 30, guestSessions: 20 } } }, { reads: 0 }, 1),
    E.estimate({ totals: { sessions: 100 } }, { reads: 0 }, 1));
  // Each page of 2,500 PCs reads the sessions again (a lab that forgets its profiles nightly has thousands of codes).
  const many = { totals: { sessions: 7000, gameOpens: 9000 }, quality: { pcsNew: 2600 } };
  const more = E.estimate(many, { reads: 0 }, 30), fewer = E.estimate({ ...many, quality: { pcsNew: 2500 } }, { reads: 0 }, 30);
  assert.equal(more.rows - fewer.rows, 100 * 2 + 7000);
});
