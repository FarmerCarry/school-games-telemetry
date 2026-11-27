// The dashboard's insight rules (dashboard/insights.js): thresholds, ranking,
// every group described (even one session) with the small-sample flag, both languages,
// empty data; and dashboard/demo/: the real server's own answers (dashboard/make-demo.mjs,
// run again here), in the shapes the tabs read, with research files that follow the data
// dictionary. Play is anonymous (schema 5): no sentence or answer counts children. Pure
// Node: insights.js and i18n.js are plain browser scripts, loaded here in a vm context
// with a stand-in window.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.join(repo, 'dashboard');
// The games site's checkout, found the way dashboard/make-names.mjs finds it (SG_SITE_DIR, or
// school-games next to this repository). The tests that compare with the site's catalog and
// game code skip when it is not there.
const siteRoot = process.env.SG_SITE_DIR ? path.resolve(process.env.SG_SITE_DIR) : path.resolve(repo, '../school-games');
const SITE = fs.existsSync(path.join(siteRoot, 'js/catalog.js')) ? siteRoot : null;
const needsSite = { skip: SITE ? false : 'needs the school-games checkout (set SG_SITE_DIR)' };

// In this realm (so arrays compare with deepStrictEqual), with `window` as a parameter.
function loadScripts(...files) {
  const window = {};
  for (const file of files) {
    vm.runInThisContext('(function (window) {' + fs.readFileSync(path.join(dashboard, file), 'utf8') + '\n})', { filename: file })(window);
  }
  return window;
}
const I = loadScripts('insights.js').SGInsights;
const TEXT = loadScripts('insights.js', 'i18n.js').SGDashText;

const ARABIC = /[؀-ۿ]/;
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/;
const LATIN_WORD = /[A-Za-z]{2,}/;
const strip = text => text.replace(/[\u2066-\u2069]/g, '');

// ---- a small hand-made KPI answer in the documented shape ------------------------
const codes = (w, l, q, d = 0, e = 0) => ({ w, l, d, e, q });
function game(slug, { opens = 40, sessions = 30, starts = 100, c = codes(60, 30, 10), smooth = 0.9, loadMs = 200, il = [80, 10, 5, 3, 1, 1],
  errors = { t: 0, x: 0, l: 0 }, playsBefore = [20, 5, 5, 5, 5], pcRepeatOpens = 0, organic = null, trend = null } = {}) {
  const wl = c.w + c.l;
  return {
    slug, sessions, opens, closes: opens, engagedMinutes: opens * 2, avgEngagedSecPerOpen: 120,
    rounds: { starts, ends: starts, codes: c },
    completionRate: starts ? Math.round(c.w / starts * 1e4) / 1e4 : null, winRate: wl ? Math.round(c.w / wl * 1e4) / 1e4 : null,
    dropOffRate: starts ? Math.round(c.q / starts * 1e4) / 1e4 : null, avgTier: null, hits: 0, misses: 0, accuracy: null,
    rt: [0, 0, 0, 0, 0, 0], il, frames: { counts: [smooth * 1000, (1 - smooth) * 1000, 0, 0], smoothShare: smooth, stallShare: 0 },
    loads: opens, avgLoadMs: loadMs, errors, sources: { catalog: opens }, replay: { replayIndex: [starts, 0, 0, 0, 0, 0], playsBefore, pcRepeatOpens },
    organic: organic || { opens, engagedMinutes: opens * 2, avgSec: 120, bounce25Rate: 0.1, stay2mRate: 0.6 },
    trend
  };
}
function level(slug, id, starts, quits, sessions = 10) {
  return { slug, id, sessions, starts, ends: starts, codes: codes(starts - quits, 0, quits), completionRate: (starts - quits) / starts,
    winRate: 1, dropOffRate: Math.round(quits / starts * 1e4) / 1e4, avgMs: 30000, avgTier: null };
}
function sample(overrides = {}) {
  const games = [
    game('alpha', { opens: 120, sessions: 80, c: codes(30, 60, 10) }),                       // win 33 %: too hard
    game('bravo', { opens: 90, sessions: 60, c: codes(95, 2, 3), playsBefore: [10, 20, 20, 20, 20] }), // too easy, comes back 89 %
    game('charlie', { opens: 60, sessions: 40, c: codes(0, 0, 10, 0, 90) }),                 // endless: no winner
    game('delta', { opens: 60, sessions: 45, smooth: 0.7, loadMs: 4200, errors: { t: 4, x: 0, l: 0 } }), // PC problems
    { slug: 'secret', suppressed: true }
  ];
  return {
    v: 1, range: { from: '2026-10-01', to: '2026-10-21', days: 21 }, minSessions: 3,
    totals: { sessions: 300, engagedMinutes: 2000, avgEngagedMinutesPerSession: 6.67, gameOpens: 330, roundsStarted: 400, roundsEnded: 400, errors: 4 },
    daily: Array.from({ length: 21 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, sessions: i < 14 ? 10 : 15, engagedMinutes: 50, opens: 12 })),
    games,
    levels: [
      level('alpha', 'L2', 40, 16), level('alpha', 'L10', 40, 16), level('bravo', 'L1', 50, 20), level('delta', 'L3', 19, 15),
      level('charlie', 'endless', 100, 10), { slug: 'secret', id: 'L1', suppressed: true }
    ],
    sources: [{ src: 'catalog', sessions: 300, opens: 330 }],
    devices: {
      cores: [{ value: 1, suppressed: true }, { value: 2, sessions: 50, frames: { counts: [70, 30, 0, 0], smoothShare: 0.7, stallShare: 0 }, il: [1, 0, 0, 0, 0, 0], avgLoadMs: 2000 },
        { value: 8, sessions: 80, frames: { counts: [92, 8, 0, 0], smoothShare: 0.92, stallShare: 0 }, il: [1, 0, 0, 0, 0, 0], avgLoadMs: 900 }],
      memory: [], screen: []
    },
    modes: [{ mode: 'web', sessions: 300 }],
    ...overrides
  };
}
const NAMES = { alpha: 'Alpha Run', bravo: 'Bravo Hop', charlie: 'Charlie Dash', delta: 'Delta Drive', secret: 'Secret Game' };
const AR_NAMES = { alpha: 'جري ألفا', bravo: 'قفز برافو', charlie: 'اندفاع تشارلي', delta: 'قيادة دلتا', secret: 'لعبة سرية' };
const opts = lang => ({ lang, name: slug => (lang === 'ar' ? AR_NAMES : NAMES)[slug] || slug, today: '2026-10-21' });

test('the difficulty verdict follows the documented thresholds', () => {
  assert.deepEqual({ ...I.T }, {
    MIN_TRIES: 20, MIN_EARLY_TRIES: 10, MIN_SESSIONS_NO_TRIES: 5, HARD_WIN: 0.4, HARD_QUIT: 0.3, EASY_WIN: 0.9, EASY_QUIT: 0.1,
    HARD_COMPLETION: 0.3, EASY_COMPLETION: 0.85, STUCK_MIN_TRIES: 20, STUCK_RATE: 0.25, RETURN_MIN_OPENS: 20, RETURN_RATE: 0.5,
    FAIL_MIN_OPENS: 20, FAIL_MIN: 3, FAIL_RATE: 0.03, SLOW_LOAD_MS: 400, SLOW_LOAD_MIN: 10, CHOPPY_SMOOTH: 0.9, SLOW_INPUT: 0.1,
    DEVICE_MIN_SESSIONS: 10, DEVICE_SMOOTH: 0.85, DEVICE_GAP: 0.05, TREND_DAYS: 7, TREND_MIN: 20, TREND_CHANGE: 0.1,
    REGRESS_MIN_OPENS: 10, REGRESS_AVG_DROP: 0.35, REGRESS_BOUNCE_JUMP: 0.2,
    HEARTS_MIN: 3, SMALL_TRIES: 20
  });
  assert.equal('MIN_SESSIONS' in I.T, false, 'no privacy floor: every group is described');
  assert.equal('SMALL_STUDENTS' in I.T, false, 'play is anonymous: no rule counts children');
  const v = cell => I.verdict({ tries: 20, sessions: 10, winnable: true, ...cell }).code;
  // Fewer than 10 tries: not enough yet; 10-19: the same rules as an early sign; 20 or more: a verdict.
  assert.deepEqual(I.verdict({ tries: 9, winnable: true, winRate: 0.1, dropOffRate: 0.5 }), { code: 'few', tries: 9 });
  assert.deepEqual(I.verdict({ tries: 10, winnable: true, winRate: 0.1, dropOffRate: 0.5 }),
    { code: 'hard', basis: 'win', win: 0.1, quit: 0.5, tries: 10, early: true });
  assert.equal(I.verdict({ tries: 19, winnable: true, winRate: 0.95, dropOffRate: 0 }).early, true);
  assert.equal(I.verdict({ tries: 19, winnable: true, winRate: 0.95, dropOffRate: 0 }).code, 'easy');
  assert.equal(I.verdict({ tries: 20, winnable: true, winRate: 0.95, dropOffRate: 0 }).early, undefined, '20 tries: a verdict');
  assert.equal(I.verdict({ tries: 12, winnable: false }).early, undefined, 'an unrated game is no early sign');
  assert.equal(v({ winRate: 0.39, dropOffRate: 0 }), 'hard');
  assert.equal(v({ winRate: 0.40, dropOffRate: 0.29 }), 'right');
  assert.equal(v({ winRate: 0.70, dropOffRate: 0.30 }), 'hard', '30 % left unfinished is too hard');
  assert.equal(v({ winRate: 0.89, dropOffRate: 0.32 }), 'hard');
  assert.equal(v({ winRate: 1, dropOffRate: 0.32 }), 'right', 'a game children always win but often leave (it cannot be lost) is not too hard');
  assert.equal(v({ winRate: 0.90, dropOffRate: 0.5 }), 'right');
  assert.equal(v({ winRate: 0.90, dropOffRate: 0.09 }), 'easy');
  assert.equal(v({ winRate: 0.90, dropOffRate: 0.10 }), 'right');
  assert.equal(v({ winRate: 0.89, dropOffRate: 0 }), 'right');
  assert.equal(v({ winRate: null, dropOffRate: 0.31 }), 'hard', 'every finished round was a quit');
  assert.equal(I.verdict({ tries: 30, winnable: true, winRate: null, dropOffRate: 0.31 }).basis, 'quit');
  assert.equal(v({ winRate: null, dropOffRate: 0.1 }), 'none');
  assert.equal(v({ winnable: false, winRate: null, dropOffRate: 0.9 }), 'none', 'endless and two-player games are not rated');
  assert.equal(I.verdict({ suppressed: true }).code, 'missing', 'an older server\'s group without numbers is not judged');
  assert.equal(I.verdict(null).code, 'missing');
  // An older server: only the completion rate for a game, and no tries.
  const c = cell => I.verdict({ tries: null, winnable: true, ...cell }).code;
  assert.equal(c({ sessions: 4, completionRate: 0.1 }), 'few', 'fewer than 5 play sessions when tries are unknown');
  assert.equal(c({ sessions: 5, completionRate: 0.29 }), 'hard');
  assert.equal(c({ sessions: 5, completionRate: 0.30 }), 'right');
  assert.equal(c({ sessions: 5, completionRate: 0.85 }), 'easy');
  assert.equal(I.verdict({ tries: null, sessions: 9, winnable: true, completionRate: 0.5 }).basis, 'completion');
  // Rates are judged as the whole percentages the page shows.
  assert.equal(v({ winRate: 0.396, dropOffRate: 0 }), 'right', '39.6 % is shown as 40 %');
  assert.equal(v({ winRate: 0.394, dropOffRate: 0 }), 'hard');
  const choppy = smooth => I.pcHealth({ games: [game('g', { smooth })] }).rows[0].flags.includes('choppy');
  assert.deepEqual([0.894, 0.8951, 0.91].map(choppy), [true, false, false]);
  const slowLoad = loadMs => I.pcHealth({ games: [game('g', { loadMs })] }).rows[0].flags.includes('slowLoad');
  assert.deepEqual([349, 350, 400].map(slowLoad), [false, true, true]);
});

test('rankings are deterministic: a number first, then the slug and the id', () => {
  const stuck = I.stuckLevels(sample()).rows.map(l => l.slug + ' ' + l.id);
  // 40 % for three levels: more quits first, then by slug and natural level order; delta L3 has 19 tries.
  assert.deepEqual(stuck, ['bravo L1', 'alpha L2', 'alpha L10', 'charlie endless']);
  const shuffled = sample({ games: sample().games.slice().reverse(), levels: sample().levels.slice().reverse() });
  assert.deepEqual(I.stuckLevels(shuffled).rows, I.stuckLevels(sample()).rows);
  // charlie and delta both have 60 opens: more play sessions first.
  assert.deepEqual(I.favourites(shuffled).rows.map(g => g.slug), ['alpha', 'bravo', 'delta', 'charlie']);
  assert.deepEqual(I.favourites(shuffled).rows.map(g => g.slug), I.favourites(sample()).rows.map(g => g.slug));
  const tie = sample({ games: [game('zulu', { opens: 50, sessions: 10 }), game('yankee', { opens: 50, sessions: 10 }), game('xray', { opens: 50, sessions: 12 })] });
  assert.deepEqual(I.favourites(tie).rows.map(g => g.slug), ['xray', 'yankee', 'zulu']);
  assert.deepEqual(I.returning(sample(), 20).rows[0].slug, 'bravo');
  assert.equal(Math.round(I.returning(sample(), 20).rows[0].share * 100), 89);
  // The grid puts problems first: too hard, then too easy, then the rest.
  const grid = I.difficultyGrid(sample());
  assert.deepEqual(grid.rows.map(r => [r.slug, r.verdict.code]), [['alpha', 'hard'], ['bravo', 'easy'], ['delta', 'right'], ['charlie', 'none']]);
  assert.deepEqual(I.difficultyGrid(shuffled).rows, grid.rows);
  assert.equal(grid.byCompletion, false, 'every verdict rests on tries: the page explains no fallback rule');
});

test('every group is described, even one session, with the small-sample flag', () => {
  // Echo was opened once: it is ranked, judged and named like any other game.
  const one = sample();
  one.games.push(game('echo', { opens: 1, sessions: 1, starts: 1, c: codes(0, 1, 0), playsBefore: [1, 0, 0, 0, 0] }));
  one.levels.push(level('echo', 'L1', 1, 1, 1));
  assert.ok(I.favourites(one).rows.some(g => g.slug === 'echo' && g.opens === 1));
  assert.ok(I.difficultyGrid(one).rows.some(r => r.slug === 'echo' && r.verdict.code === 'few' && r.small === true));
  assert.equal(I.stuckLevels(one, 1).rows.find(l => l.slug === 'echo').small, true);
  // The chip of a level rests on its tries.
  const days = sample();
  days.levels.push(level('foxtrot', 'L1', 40, 20), level('foxtrot', 'L2', 12, 6));
  const fox = I.stuckLevels(days, 1).rows.filter(l => l.slug === 'foxtrot');
  assert.deepEqual(fox.map(l => [l.id, l.small]), [['L1', false], ['L2', true]]);
  const said = I.insights(days, { lang: 'en' }).find(x => x.key === 'foxtrot L1');
  assert.ok(said && said.tries === 40 && !said.small);
  // The rule: fewer than 20 tries; a count not sent says nothing.
  assert.deepEqual([100, 19, 20, null, 5, 0].map(n => I.small(n)), [false, true, false, false, true, true]);
  // An older server's answer may still count students per game and level: nothing reads them,
  // so no chip and no sentence counts children.
  const older = sample();
  older.games.forEach(g => { if (I.shown(g)) g.students = 3; });
  older.levels.forEach(l => { if (I.shown(l)) l.students = 2; });
  for (const lang of ['en', 'ar']) {
    assert.deepEqual(I.insights(older, opts(lang)), I.insights(sample(), opts(lang)));
    assert.ok(I.insights(older, opts(lang)).every(s => !('students' in s)), 'no sentence counts children');
  }
  assert.ok(I.favourites(older).rows.every(r => !('students' in r) && !('small' in r)), 'a favourite rests on opens: no chip');
  assert.ok(I.difficultyGrid(older).rows.every(r => !('students' in r)));
  // An early sign is shown in the grid, never stated as "too hard".
  const early = sample({ games: [game('alpha', { opens: 120, sessions: 80, starts: 15, c: codes(2, 13, 0) })], levels: [] });
  assert.equal(I.difficultyGrid(early).rows[0].verdict.early, true);
  assert.ok(!I.insights(early, opts('en')).some(s => s.kind === 'hard'));
  // Totals, days and groups an older server marked "suppressed" have no numbers: left out, never read as zero.
  const old = sample();
  old.games[4] = { slug: 'secret', suppressed: true };
  old.daily[16] = { day: old.daily[16].day, suppressed: true };
  assert.ok(!I.favourites(old).rows.some(g => g.slug === 'secret'));
  assert.ok(!I.difficultyGrid(old).rows.some(r => r.slug === 'secret'));
  assert.ok(!I.insights(old, opts('en')).some(s => s.kind === 'trend'), 'a day without numbers stops the trend sentence');
  for (const lang of ['en', 'ar']) {
    const list = I.insights(sample({ totals: { suppressed: true } }), opts(lang));
    assert.deepEqual(list.map(s => s.kind), ['old']);
    assert.match(list[0].text, lang === 'ar' ? /حدِّث الخادم/ : /Update the server/);
    // A one-session period is described like any other.
    const tiny = I.insights(sample({ totals: { ...sample().totals, sessions: 1 } }), opts(lang));
    assert.ok(tiny.length >= 1 && !tiny.some(s => s.kind === 'old' || s.kind === 'empty'));
  }
});

test('the most hearted game: hearts pressed minus taken back, in both languages', () => {
  const k = sample({ levels: [] });
  k.games[1].hearts = { on: 23, off: 2 };
  k.games[2].hearts = { on: 4, off: 0 };
  assert.ok(I.KIND_ORDER.includes('hearts'));
  assert.deepEqual(I.insights(k, opts('en')).map(s => s.kind), I.insights(k, opts('ar')).map(s => s.kind));
  assert.ok(I.insights(k, opts('en')).length <= 5);
  // Hearts come after the other kinds: a quiet answer leaves room for them.
  const quiet = sample({ levels: [], devices: { cores: [], memory: [], screen: [] },
    games: [{ ...game('bravo', { playsBefore: [40, 0, 0, 0, 0] }), hearts: { on: 23, off: 2 } }, { ...game('charlie', { playsBefore: [40, 0, 0, 0, 0] }), hearts: { on: 2, off: 0 } }] });
  const q = I.insights(quiet, opts('en')).find(s => s.kind === 'hearts');
  assert.equal(q.text, 'Bravo Hop got the most hearts in this period: 21 after the ones taken back (its heart was pressed 23 times and taken back twice).');
  assert.equal(strip(I.insights(quiet, opts('ar')).find(s => s.kind === 'hearts').text),
    'نالت «قفز برافو» أكثر القلوب في هذه الفترة: 21 قلبًا بعد طرح ما أُلغي، إذ ضُغط قلبها 23 مرة وأُلغي مرتين.');
  assert.ok(!I.insights(quiet, opts('en')).some(s => s.key === 'charlie' && s.kind === 'hearts'), '2 hearts are not a finding');
});

test('a game is called the slowest to open only when no shown game is slower', () => {
  // Only the favourite and the loading-time sentences: one game every child opens for the first time.
  const quiet = extra => sample({ levels: [], devices: { cores: [], memory: [], screen: [] },
    games: [game('delta', { opens: 60, sessions: 45, loadMs: 4200, playsBefore: [60, 0, 0, 0, 0] }), ...extra] });
  const load = k => I.insights(k, opts('en')).find(s => s.key.startsWith('load ')).text;
  assert.equal(load(quiet([])), 'Delta Drive takes 4.2 seconds to open on average, the slowest of all games.');
  // A game opened only 5 times is not judged, but it is slower: no "slowest" for Delta Drive.
  const slower = quiet([game('echo', { opens: 5, sessions: 4, loadMs: 6000, playsBefore: [5, 0, 0, 0, 0] })]);
  assert.equal(load(slower), 'Delta Drive takes 4.2 seconds to open on average.');
  assert.ok(!I.insights(slower, opts('ar')).find(s => s.key.startsWith('load ')).text.includes('الأبطأ'));
});

test('names.js carries every catalog game\'s names (rebuild: node dashboard/make-names.mjs)', needsSite, async () => {
  const { namesSource } = await import('../dashboard/make-names.mjs');
  assert.equal(fs.readFileSync(path.join(dashboard, 'names.js'), 'utf8').replace(/\r\n/g, '\n'), namesSource(), 'names.js is out of date: run node dashboard/make-names.mjs');
  const names = loadScripts('names.js').SG_GAME_NAMES;
  const site = {};
  vm.runInNewContext(fs.readFileSync(path.join(SITE, 'js/catalog.js'), 'utf8'), { window: site });
  assert.deepEqual(Object.keys(names).sort(), [...site.GAMES].map(g => g.slug).sort());
  for (const g of site.GAMES) assert.deepEqual(names[g.slug], [I.catalogName(g, 'ar'), I.catalogName(g, 'en')], g.slug);
});

test('the sentences: at most five, one kind at a time, in the documented order', () => {
  assert.deepEqual(I.KIND_ORDER, ['regression', 'stuck', 'hard', 'favourite', 'health', 'returning', 'trend', 'easy', 'hearts']);
  const en = I.insights(sample(), opts('en'));
  assert.deepEqual(en.map(s => s.kind), ['stuck', 'hard', 'favourite', 'health', 'returning']);
  assert.equal(en[0].text, 'Children leave Bravo Hop level 1 unfinished in 40% of tries (20 of 50).');
  assert.equal(en[1].text, 'Alpha Run looks too hard for children: they win 33% of the rounds they finish and leave 10% of their rounds unfinished.');
  assert.equal(en[2].text, 'Alpha Run is the most opened game: 120 opens, 36% of all game opens.');
  assert.equal(en[3].text, 'Delta Drive failed to start 4 times (7 in every 100 opens).');
  assert.equal(en[4].text, 'Children come back to Bravo Hop the most: 89% of its opens were by someone who had played it before.');
  assert.deepEqual(I.insights(sample(), opts('en')), en, 'the same input gives the same sentences');
  // Without the first kinds, the later ones (trend, too easy) come in.
  const quiet = sample({ levels: [] });
  quiet.games[0] = game('alpha', { opens: 120, sessions: 80 });
  const kinds = I.insights(quiet, opts('en')).map(s => s.kind);
  assert.deepEqual(kinds, ['favourite', 'health', 'returning', 'trend', 'easy']);
  const trend = I.insights(quiet, opts('en')).find(s => s.kind === 'trend');
  // Today (21 October) is left out: 14-20 October against 7-13 October.
  assert.equal(trend.text, 'Play sessions went up 43% in the last 7 full days compared with the 7 days before (100 against 70).');
  // A range from an older server that names an age group changes nothing: sentences speak of every child.
  const band = sample({ range: { ...sample().range, band: '10-11' } });
  assert.deepEqual(I.insights(band, opts('en')), en);
});

test('both languages: Arabic sentences are Arabic with Western digits, English ones are English', () => {
  const en = I.insights(sample(), opts('en')), ar = I.insights(sample(), opts('ar'));
  assert.equal(en.length, ar.length);
  assert.deepEqual(en.map(s => s.kind + s.key), ar.map(s => s.kind + s.key), 'the same findings in both languages');
  for (const s of en) assert.ok(!ARABIC.test(s.text), s.text);
  for (const s of ar) {
    assert.ok(ARABIC.test(s.text), s.text);
    assert.ok(!LATIN_WORD.test(strip(s.text)), 'no English words: ' + s.text);
    assert.ok(!ARABIC_INDIC_DIGITS.test(s.text), 'Western digits: ' + s.text);
    assert.match(s.text, /«\u2068[^»]+\u2069»/, 'a game name in guillemets, isolated');
  }
  assert.equal(strip(ar[0].text), 'يترك الأطفال المرحلة 1 من «قفز برافو» دون إكمال في 40% من المحاولات (20 من أصل 50).');
  assert.equal(strip(ar[1].text), 'تبدو لعبة «جري ألفا» صعبة جدًا على الأطفال: يفوزون في 33% من الجولات التي يُنهونها، ويتركون 10% من جولاتهم دون إكمال.');
  assert.equal(strip(ar[3].text), 'تعذّر تشغيل «قيادة دلتا» 4 مرات (7 من كل 100 مرة فتح).');
  // Labels and Arabic counting.
  assert.equal(I.levelLabel('w1-2', 'en'), 'world 1, level 2');
  assert.equal(I.levelLabel('L3', 'ar'), 'المرحلة 3');
  assert.equal(I.levelLabel('s4', 'en'), '4×4 board');
  assert.equal(I.levelLabel('cpu-hard', 'en'), 'round “cpu-hard”');
  assert.deepEqual([1, 2, 3, 10, 11, 100, 103, 2.5].map(n => I.arWord(n, ['a', 'b', 'c', 'd'])), ['a', 'b', 'c', 'c', 'd', 'd', 'c', 'd']);
  // Hundreds and thousands ending in 00, 01 or 02 take the singular genitive (100 يوم), as rowsAr does ("12,000 صف").
  const days = ['يوم واحد', 'يومان', 'أيام', 'يومًا'];
  assert.deepEqual([99, 100, 101, 102, 103, 111, 200, 1000, 1002].map(n => I.arWord(n, days)),
    ['يومًا', 'يوم', 'يوم', 'يوم', 'أيام', 'يومًا', 'يوم', 'يوم', 'يوم']);
  assert.equal(I.arWord(100, ['صف', 'صفان', 'صفوف', 'صفًّا']), 'صفّ', 'the shadda stays');
  assert.equal(I.arWord(300, ['رمز', 'رمزان', 'رموز', 'رمزًا مربوطًا']), 'رمز مربوط', 'each word of the phrase');
  assert.equal(I.arWord(100, ['مرة', 'مرتان', 'مرات', 'مرة']), 'مرة');
  assert.equal(TEXT.ar.smallTries(200), 'بناءً على 200 محاولة حتى الآن');
  assert.equal(TEXT.ar.clockPcs(100), '100 جهاز');
  assert.deepEqual(I.duration(15215.8, 'ar'), { value: '254', unit: 'ساعة', text: '254 ساعة' });
  assert.deepEqual(I.duration(270, 'ar'), { value: '4.5', unit: 'ساعة', text: '4.5 ساعة' });
  assert.deepEqual(I.duration(5, 'ar').unit, 'دقائق');
  assert.deepEqual(I.duration(8.16, 'en'), { value: '8.2', unit: 'minutes', text: '8.2 minutes' });
  assert.deepEqual([0, 0.004, 0.5, 0.996, 1, null].map(I.pct), ['0%', '<1%', '50%', '>99%', '100%', '—'], 'no rate: the dash the tiles show');
  assert.equal(I.int(1234567), '1,234,567');
  assert.equal(I.catalogName(undefined, 'en'), '');
  for (const gone of ['bandLabel', 'children', 'favouritesByBand', 'partialStudents', 'forPeriod', 'BANDS']) assert.equal(gone in I, false, gone);
});

test('game names from the site\'s catalog, in both languages', needsSite, () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(SITE, 'js/catalog.js'), 'utf8'), { window });
  const bySlug = new Map(window.GAMES.map(g => [g.slug, g]));
  assert.equal(I.catalogName(bySlug.get('bubble-bop'), 'en'), 'Bubble Bop');
  assert.equal(I.catalogName(bySlug.get('dino-3d'), 'en'), 'Dino 3D');
  assert.equal(I.catalogName(bySlug.get('connect-four'), 'en'), 'Connect 4');
  assert.equal(I.catalogName(bySlug.get('fire-and-ice'), 'en'), 'Fire & Ice');
  assert.equal(I.catalogName(bySlug.get('merge-2048'), 'en'), '2048');
  assert.equal(I.catalogName(bySlug.get('bubble-bop'), 'ar'), 'فقاعات بوب');
  for (const g of window.GAMES) assert.ok(I.catalogName(g, 'en') && I.catalogName(g, 'ar'), g.slug);
});

test('the dashboard words exist in both languages', () => {
  const shape = value => typeof value === 'function' ? 'function' : Array.isArray(value) ? 'array' + value.length
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, shape(value[k])])) : typeof value;
  const keys = obj => Object.keys(obj).sort();
  assert.deepEqual(keys(TEXT.ar), keys(TEXT.en));
  for (const key of keys(TEXT.en)) {
    assert.deepEqual(shape(TEXT.ar[key]), shape(TEXT.en[key]), key);
  }
  for (const [key, value] of Object.entries(TEXT.ar)) {
    if (typeof value === 'string' && !['otherLang'].includes(key)) assert.ok(ARABIC.test(value), 'Arabic text for ' + key);
  }
  for (const lang of ['en', 'ar']) assert.equal(TEXT[lang].errNotSetSteps.length, 5);
  // The small-sample chip and Arabic number agreement.
  assert.deepEqual([1, 2, 3, 11].map(k => TEXT.en.smallTries(k)),
    ['Based on 1 try so far', 'Based on 2 tries so far', 'Based on 3 tries so far', 'Based on 11 tries so far']);
  assert.deepEqual([1, 2, 3, 11].map(k => TEXT.ar.smallTries(k)),
    ['بناءً على محاولة واحدة حتى الآن', 'بناءً على محاولتين حتى الآن', 'بناءً على 3 محاولات حتى الآن', 'بناءً على 11 محاولة حتى الآن']);
  assert.equal(TEXT.ar.smallChipTries(2), 'بناءً على محاولتين');
  for (const gone of ['smallSample', 'smallChip', 'nStudents']) assert.equal(gone in TEXT.en || gone in TEXT.ar, false, gone + ': no word counts children');
  assert.equal(TEXT.en.verdictLong.few, 'Not enough tries yet (fewer than 10)');
  assert.equal(TEXT.ar.verdict.few, 'المحاولات قليلة حتى الآن');
  assert.equal(strip(TEXT.ar.earlySign), 'علامة مبكرة (10–19 محاولة)');
  // The school's clock line, in each state.
  assert.equal(TEXT.en.clockNote('UTC', 'UTC', 'none', '', 0), 'Waiting for a PC to report the school’s clock; world time (UTC) until then.');
  assert.equal(strip(TEXT.en.clockNote('Asia/Riyadh', 'UTC+3', 'pcs', '10:42', 12)),
    'Days and hours follow the school’s clock: Asia/Riyadh (UTC+3, now 10:42), from 12 PCs.');
  assert.equal(strip(TEXT.ar.clockNote('Asia/Riyadh', 'UTC+3', 'pc', '10:42', 12)).replace('\u200f', ''),
    'الأيام والساعات بحسب ساعة المدرسة: Asia/Riyadh (UTC+3، الآن 10:42) كما يذكرها 12 جهازًا في المدرسة.');
  assert.match(TEXT.en.clockNote('Asia/Riyadh', 'UTC+3', 'dashboard', '10:42', 0), /from this browser/);
  assert.match(TEXT.en.clockNote('Asia/Riyadh', 'UTC+3', 'owner', '10:42', 0), /as you chose/);
});

test('no word of the dashboard says a number is hidden for privacy', () => {
  // Every string and every function's answer, in both languages, and the page's own scripts.
  const words = [];
  const walk = v => {
    if (typeof v === 'string') words.push(v);
    else if (typeof v === 'function') for (const args of [[1], [2], [3, 'x'], [11, 'x', 'pc', '10:00', 3]]) { try { walk(v(...args)); } catch { /* needs other arguments */ } }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(TEXT);
  for (const s of I.insights(sample(), opts('en')).concat(I.insights(sample(), opts('ar')))) words.push(s.text);
  for (const file of fs.readdirSync(dashboard).filter(f => /\.(js|html)$/.test(f))) words.push(fs.readFileSync(path.join(dashboard, file), 'utf8'));
  for (const text of words) {
    assert.ok(!/hidden for privacy/i.test(text), text.slice(0, 120));
    assert.ok(!text.includes('حفاظًا على الخصوصية'), text.slice(0, 120));
  }
  for (const key of ['hiddenShort', 'hiddenTile', 'hiddenDays', 'hiddenPrivacy', 'moreHidden', 'hiddenHint', 'utcNote']) {
    assert.equal(key in TEXT.en || key in TEXT.ar, false, key);
  }
  assert.equal('hidden' in TEXT.en.verdict || 'hidden' in TEXT.en.verdictLong || 'hidden' in TEXT.ar.verdictLong, false);
});

test('empty and missing data never throw', () => {
  for (const lang of ['en', 'ar']) {
    const none = I.insights(sample({ totals: { sessions: 0, engagedMinutes: 0, avgEngagedMinutesPerSession: null, gameOpens: 0 },
      games: [], levels: [], daily: [] }), opts(lang));
    assert.equal(none.length, 1);
    assert.equal(none[0].kind, 'empty');
    assert.match(none[0].text, lang === 'ar' ? /لم يُسجَّل/ : /No play has been recorded/);
  }
  assert.deepEqual(I.insights(null, opts('en')), []);
  assert.deepEqual(I.insights({}, opts('en')), []);
  const bare = { totals: { sessions: 5, gameOpens: 0 } };
  assert.deepEqual(I.insights(bare, opts('en')).map(s => s.kind), ['quiet']);
  for (const fn of [I.favourites, I.stuckLevels, I.difficultyGrid, I.returning, I.pcHealth]) {
    assert.doesNotThrow(() => fn(bare));
    assert.doesNotThrow(() => fn(null));
  }
  assert.deepEqual(I.pcHealth(null).overall, { smooth: null, loadMs: null, slowInput: null, fails: null, failRate: null });
});

test('automated 7d-vs-21d regression detector, PC-repeat returning share, and quality scorecard', () => {
  // 1. Regression detector: avg time drop >= 35%, bounce<25s jump >= +20pp, both, and below min opens (<10).
  const regSample = sample({
    levels: [],
    games: [
      game('alpha', {
        opens: 80, sessions: 60, c: codes(60, 30, 10),
        organic: { opens: 70, engagedMinutes: 50, avgSec: 42.9, bounce25Rate: 0.55, stay2mRate: 0.15 },
        trend: { recent: { opens: 25, avgSec: 60, bounce25Rate: 0.55 }, prior: { opens: 45, avgSec: 150, bounce25Rate: 0.25 } }
      }), // avgDrop = 60% AND bounceJump = +30pp
      game('bravo', {
        opens: 60, sessions: 40, c: codes(60, 30, 10),
        trend: { recent: { opens: 15, avgSec: 90, bounce25Rate: 0.20 }, prior: { opens: 30, avgSec: 150, bounce25Rate: 0.15 } }
      }), // avgDrop = 40% only
      game('charlie', {
        opens: 50, sessions: 35, c: codes(60, 30, 10),
        trend: { recent: { opens: 12, avgSec: 100, bounce25Rate: 0.45 }, prior: { opens: 25, avgSec: 120, bounce25Rate: 0.20 } }
      }), // bounceJump = +25pp only
      game('delta', {
        opens: 20, sessions: 15, c: codes(60, 30, 10),
        trend: { recent: { opens: 9, avgSec: 10, bounce25Rate: 0.90 }, prior: { opens: 20, avgSec: 200, bounce25Rate: 0.10 } }
      }) // recent opens < 10: ignored
    ]
  });
  const regs = I.regressions(regSample).rows;
  assert.deepEqual(regs.map(r => [r.slug, r.dropped, r.jumped]), [
    ['alpha', true, true], ['bravo', true, false], ['charlie', false, true]
  ]);
  // Deterministic ordering even when input order is reversed.
  assert.deepEqual(I.regressions({ games: regSample.games.slice().reverse() }).rows, regs);
  // Regression leads insights in both languages, respects 5-sentence cap, Arabic hygiene (Western digits, isolates, no Latin words).
  for (const lang of ['en', 'ar']) {
    const ins = I.insights(regSample, opts(lang));
    assert.ok(ins.length <= 5);
    assert.equal(ins[0].kind, 'regression');
    assert.equal(ins[0].key, 'alpha');
    if (lang === 'en') {
      assert.match(ins[0].text, /Alpha Run dropped sharply in the last 7 days: average play fell 60% \(60 s against 150 s\) and quick exits under 25 s rose to 55% \(from 25%\)\./);
    } else {
      assert.ok(ARABIC.test(ins[0].text));
      assert.ok(!ARABIC_INDIC_DIGITS.test(ins[0].text), 'Western digits: ' + ins[0].text);
      assert.ok(!LATIN_WORD.test(strip(ins[0].text)), 'No Latin words: ' + ins[0].text);
      assert.match(ins[0].text, /«\u2068جري ألفا\u2069»/);
    }
  }
  // Single-cause regression sentences (drop-only and bounce-only) in both languages.
  const dropOnly = sample({ levels: [], games: [regSample.games[1]] });
  const bounceOnly = sample({ levels: [], games: [regSample.games[2]] });
  assert.match(I.insights(dropOnly, opts('en'))[0].text, /average play fell 40%/);
  assert.ok(!LATIN_WORD.test(strip(I.insights(dropOnly, opts('ar'))[0].text)));
  assert.match(I.insights(bounceOnly, opts('en'))[0].text, /saw many more quick exits in the last 7 days: visits under 25 s rose to 45% \(from 20%\)/);
  assert.ok(!LATIN_WORD.test(strip(I.insights(bounceOnly, opts('ar'))[0].text)));

  // 2. Returning share combines playsBefore > 0 with server pcRepeatOpens (and caps at playsBefore[0]).
  const retKpis = {
    games: [
      game('alpha', { opens: 50, playsBefore: [50, 0, 0, 0, 0], pcRepeatOpens: 35 }), // historical all-zero plays_b: 35/50 = 70%
      game('bravo', { opens: 50, playsBefore: [20, 10, 10, 5, 5], pcRepeatOpens: 10 }), // mixed: 30 + 10 = 40/50 = 80%
      game('charlie', { opens: 20, playsBefore: [10, 10, 0, 0, 0], pcRepeatOpens: 99 }) // capped at first=10 => 20/20 = 100%
    ]
  };
  const ret = I.returning(retKpis, 1);
  assert.deepEqual(ret.rows.map(r => [r.slug, r.back, Math.round(r.share * 100)]), [
    ['charlie', 20, 100], ['bravo', 40, 80], ['alpha', 35, 70]
  ]);
  assert.equal(Math.round(ret.overall * 100), Math.round(95 / 120 * 100));

  // 3. Scorecard aggregates organic metrics + health flags + regression flags.
  const sc = I.scorecard(regSample).rows;
  const alphaSc = sc.find(r => r.slug === 'alpha');
  assert.deepEqual(alphaSc.flags, ['regression', 'highBounce', 'shortPlay']);
  assert.equal(alphaSc.orgAvgSec, 42.9);
  assert.equal(alphaSc.bounce25, 0.55);
  assert.equal(alphaSc.stay2m, 0.15);
  for (const fn of [I.regressions, I.scorecard]) {
    assert.doesNotThrow(() => fn(null));
    assert.doesNotThrow(() => fn({}));
  }
});

// ---- the real server: the sample data, made again ------------------------------------------
// dashboard/make-demo.mjs runs the real store and Node server over simulate.mjs's school at a
// pinned clock, so it writes the same answers every time; they are both the real answers
// these tests read and what dashboard/demo/ must hold.
let made = {};
const PERIODS = [1, 7, 30, 90];
const serverKpis = {};
before(async () => {
  const { makeDemo } = await import('../dashboard/make-demo.mjs');
  made = await makeDemo();
  for (const period of PERIODS) serverKpis[period] = JSON.parse(made[`kpis-${period}.json`]);
});

test('on real server answers: at most five sentences, deterministic, every game described', () => {
  // The game names the page shows (names.js: [Arabic, English] per catalog game).
  const names = loadScripts('names.js').SG_GAME_NAMES;
  for (const [key, kpis] of Object.entries(serverKpis)) {
    assert.equal(kpis.minSessions, 0, key);
    assert.ok(!JSON.stringify(kpis).includes('"suppressed"'), key + ': nothing is suppressed');
    for (const lang of ['en', 'ar']) {
      const name = slug => (names[slug] || [])[lang === 'ar' ? 0 : 1] || slug;
      const list = I.insights(kpis, { lang, name, today: kpis.clock.today });
      assert.ok(list.length >= 1 && list.length <= 5, key + ' ' + lang + ': ' + list.length);
      assert.deepEqual(I.insights(kpis, { lang, name, today: kpis.clock.today }), list);
      assert.ok(list.every(x => !('students' in x)), key + ' ' + lang + ': no sentence counts children');
      if (lang === 'ar') assert.ok(!ARABIC_INDIC_DIGITS.test(list.map(x => x.text).join('\n')));
    }
    // Every game the server sends has a row in the difficulty check, however few played it.
    const grid = I.difficultyGrid(kpis);
    assert.deepEqual(grid.rows.map(r => r.slug).sort(), kpis.games.map(g => g.slug).sort());
    for (const r of grid.rows) {
      const g = kpis.games.find(x => x.slug === r.slug);
      assert.equal(r.tries, g.rounds.starts);
      assert.equal(!!r.small, I.small(g.rounds.starts), r.slug + ': the small-sample flag');
      if (r.verdict.code === 'hard' || r.verdict.code === 'easy' || r.verdict.code === 'right') {
        assert.ok(g.rounds.starts >= (r.verdict.early ? I.T.MIN_EARLY_TRIES : I.T.MIN_TRIES), r.slug);
        assert.equal(!!r.verdict.early, g.rounds.starts < I.T.MIN_TRIES, r.slug);
      }
    }
    for (const l of I.stuckLevels(kpis).rows) assert.ok(l.starts >= I.T.STUCK_MIN_TRIES);
  }
});

// The answers of the server's admin API (README.md) as the dashboard reads them: the keys
// each object has. dashboard/demo/ is the server's own answers, so this also says when the
// server's shapes move away from what the tabs expect.
const CLOCK = ['tz', 'source', 'offsetMin', 'today'];
const RANGE = ['from', 'to', 'days'];
const SHAPES = {
  live: ['v', 'clock', 'windowSec', 'minSessions', 'total', 'pcs', 'games'],
  settings: ['v', 'clock', 'keep', 'storage', 'usage', 'rebuild', 'accepts', 'pcs', 'clearing'],
  settingsClock: [...CLOCK, 'now', 'weekStart', 'weekSource', 'detected', 'factsSince', 'legacyUntil', 'v3Since'],
  game: ['v', 'clock', 'slug', 'range', 'daily', 'stats', 'flowsIn', 'flowsOut'],
  stats: ['v', 'clock', 'range', 'metrics', 'slug', 'columns', 'rows'],
  pcs: ['v', 'clock', 'range', 'pcs'],
  pcRow: ['p', 'label', 'firstDay', 'lastDay', 'days', 'sessions', 'minutes', 'smoothShare', 'stallShare', 'avgLoadMs',
    'slowInputShare', 'errors', 'z', 'build', 'flags']
};
// What the research server adds to the milestone-2 KPI answer, all of which the tabs read.
const KPI_ADDITIONS = ['range.legacyUntil', 'range.factsSince', 'games[].hearts.on', 'games[].hearts.off',
  'games[].tutorials.start', 'games[].tutorials.done', 'games[].wallMinutes', 'games[].actionsPerMinute', 'games[].avgScore', 'games[].unended',
  'games[].duoRounds', 'games[].replay.pcRepeatOpens', 'games[].organic.opens', 'games[].organic.engagedMinutes', 'games[].organic.avgSec',
  'games[].organic.bounce25Rate', 'games[].organic.stay2mRate', 'sources[].avgSec', 'sources[].bounce25Rate', 'levels[].avgScore', 'levels[].unended',
  ...['v2Share', 'clockEstimatedShare', 'unclosedVisits', 'idleHandovers', 'pcsNew', 'oldVersionSessionShare'].map(k => 'quality.' + k)];
// Schema 4's player, student and age-group parts, gone from the KPI answer (README.md).
const KPI_GONE = ['totals.levelUps', 'totals.players', 'totals.students', 'daily[].students', 'daily[].guestMinutes', 'games[].students',
  'levels[].students', 'bands', 'range.band', ...['linkedShare', 'unknownBandShare', 'profilesFullPcs', 'forgetfulPcs'].map(k => 'quality.' + k)];
const keysOf = (value, keys, where) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), where);
// Every key path of a value, arrays collapsed to [] ("games[].rounds.codes.w").
function paths(value, prefix = '', out = new Set()) {
  if (Array.isArray(value)) { out.add(prefix + '[]'); for (const v of value) paths(v, prefix + '[]', out); }
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const p = prefix ? prefix + '.' + k : k;
      out.add(p);
      paths(v, p, out);
    }
  }
  return out;
}
const dir = path.join(dashboard, 'demo');
// The answers as values (so a SQLite build that writes a number differently still
// compares equal), without the meters of the run that made the sample: the rows SQLite
// read and wrote and the file's size depend on the SQLite build.
const settled = (file, text) => {
  const x = JSON.parse(text);
  if (file !== 'settings.json') return x;
  for (const k of ['reads', 'writes']) x.usage[k] = typeof x.usage[k];
  x.storage.bytes = typeof x.storage.bytes;
  return x;
};

test('demo/ is the server\'s own answers (rebuild: node dashboard/make-demo.mjs)', () => {
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, Object.keys(made).sort(), 'the files make-demo.mjs writes, and no other');
  assert.equal(fs.existsSync(path.join(dashboard, 'demo.json')), false, 'demo/ replaces demo.json');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const same = f.endsWith('.json') ? isDeepStrictEqual(settled(f, text), settled(f, made[f])) : text === made[f];
    assert.ok(same, 'demo/' + f + ' is not what the server answers now: run node dashboard/make-demo.mjs');
  }
  const size = files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
  // The sample ships with the dashboard: it stays well under the old 3 MB ceiling.
  assert.ok(size <= 3.1e6, 'the sample data stays small: ' + size + ' bytes');
});

test('demo/ has an answer for every period and page the sample shows, in the shapes the tabs read', async () => {
  const { GAME_SLUGS } = await import('../games.mjs');
  const { METRICS } = await import('../rollups.mjs');
  const { METRICS: ASKED } = await import('../dashboard/make-demo.mjs');
  const files = Object.keys(made).sort();
  const expected = ['live.json', 'settings.json', 'pcs-30.json'];
  for (const p of PERIODS) expected.push(`kpis-${p}.json`, `stats-${p}.json`);
  for (const f of expected) assert.ok(files.includes(f), 'demo/' + f);
  const games = files.filter(f => /^game-/.test(f)), exports = files.filter(f => /^export-/.test(f));
  // Three adaptive games and the three most opened others.
  assert.equal(games.length, 6);
  const D = loadScripts('dictionary.js').SGDictionary;
  assert.deepEqual(exports, D.SERVER_FILES.map(f => `export-${f}.csv`).sort());
  assert.deepEqual(files.sort(), [...expected, ...games, ...exports].sort(), 'no student, cohort or per-age-group answer is left');
  const read = f => JSON.parse(made[f]);
  const slugs = new Set(GAME_SLUGS);
  const today = read('settings.json').clock.today;
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const answer = read(f);
    assert.equal(answer.v, 1, f);
    keysOf(answer.clock, CLOCK.concat(f === 'settings.json' ? SHAPES.settingsClock.slice(4) : []), f + ' clock');
    assert.equal(answer.clock.today, today, f + ': one school day for the whole sample');
    assert.equal(answer.clock.tz, 'Asia/Riyadh', f);
    if (answer.range) assert.ok(RANGE.every(k => k in answer.range), f + ' range');
  }
  for (const f of files.filter(f => f.startsWith('kpis-'))) {
    const k = read(f), [, period] = /^kpis-(\d+)\.json$/.exec(f), own = paths(k);
    assert.equal(k.range.days, Number(period), f);
    assert.equal(k.range.to, today, f);
    for (const p of ['v', 'range', 'totals', 'daily[].day', 'games[].rounds.codes.w', 'levels[].codes.q',
      'devices.cores[].frames.smoothShare', 'modes[].mode', ...KPI_ADDITIONS]) assert.ok(own.has(p), f + ': ' + p);
    for (const p of KPI_GONE) assert.ok(!own.has(p), f + ': ' + p + ' is gone');
    assert.ok(k.games.every(g => slugs.has(g.slug)), f + ': only the games games.mjs knows');
  }
  const live = read('live.json');
  keysOf(live, SHAPES.live, 'live');
  assert.equal(live.minSessions, 0);
  assert.ok(live.total.sessions > 0, 'children are playing at the sample\'s "now"');
  assert.ok(live.games.reduce((a, g) => a + g.sessions, 0) <= live.total.sessions, 'live: a session has at most one game open');
  const settings = read('settings.json');
  keysOf(settings, SHAPES.settings, 'settings');
  assert.deepEqual(settings.accepts, [2, 3]);
  for (const p of PERIODS) {
    const st = read(`stats-${p}.json`);
    keysOf(st, SHAPES.stats, 'stats-' + p);
    assert.deepEqual([...st.metrics].sort(), [...ASKED].sort(), 'stats-' + p + ': the metrics the tabs ask for');
    for (const c of ['metric', 'slug', 'k1', 'k2', 'n']) assert.ok(st.columns.includes(c), 'stats column ' + c);
    for (const c of ['a', 'students']) assert.ok(!st.columns.includes(c), 'stats-' + p + ': no ' + c + ' column');
    const mi = st.columns.indexOf('metric');
    for (const r of st.rows) {
      assert.equal(r.length, st.columns.length);
      assert.ok(METRICS.includes(r[mi]), r[mi]);
    }
  }
  for (const f of games) {
    const g = read(f);
    keysOf(g, SHAPES.game, f);
    assert.equal(f, 'game-' + g.slug + '.json');
    assert.ok(slugs.has(g.slug));
    g.daily.forEach(d => keysOf(d, ['day', 'minutes', 'opens'], f + ' daily'));
    assert.deepEqual(g.stats.columns.slice(0, 3), ['metric', 'k1', 'k2'], 'a game\'s own stats rows have no slug column');
    g.flowsIn.forEach(x => keysOf(x, ['from', 'n'], f + ' flowsIn'));
    g.flowsOut.forEach(x => keysOf(x, ['to', 'n'], f + ' flowsOut'));
  }
  for (const slug of ['bubble-bop', 'dino-3d', 'road-hopper']) assert.ok(games.includes('game-' + slug + '.json'), 'the adaptive games have a page: ' + slug);
  const pcs = read('pcs-30.json');
  keysOf(pcs, SHAPES.pcs, 'pcs');
  for (const p of pcs.pcs) {
    keysOf(p, SHAPES.pcRow, 'pc ' + p.p);
    assert.match(p.p, /^[0-9a-f]{12}$/);
    assert.equal(p.label, p.p.slice(0, 4).toUpperCase());
    assert.ok(p.flags.every(x => ['choppy', 'old'].includes(x)));
  }
});

test('the sample research files: every line has the dictionary\'s columns, each value of its type', () => {
  const D = loadScripts('dictionary.js').SGDictionary;
  const TYPE = {
    code: /^[0-9a-f]{12}$/, text: /^[^,"\n]*$/, category: /^[a-z0-9_-]*$/, integer: /^-?\d+$/, decimal: /^-?\d+(?:\.\d+)?$/, flag: /^[01]$/,
    date: /^\d{4}-\d\d-\d\d$/, time: /^\d\d:\d\d:\d\d$/, datetime: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/
  };
  for (const file of D.SERVER_FILES) {
    const text = made[`export-${file}.csv`], columns = D.file(file).columns;
    assert.ok(text.length > 0 && text.endsWith('\n'), file + ': this morning\'s play');
    for (const line of text.slice(0, -1).split('\n')) {
      const cells = line.split(',');
      assert.equal(cells.length, columns.length, file + ': ' + line);
      cells.forEach((v, i) => {
        if (v === '') return;
        const [name, type, , values] = columns[i];
        assert.match(v, TYPE[type], file + '.' + name + ' = ' + v);
        if (type === 'category') assert.ok(values.split(';')[0].split(/,\s*/).includes(v), file + '.' + name + ': ' + v + ' is one of ' + values);
      });
    }
    assert.ok(columns.every(([name, type]) => type !== 'code' || name !== 'student') && !columns.some(([name]) => /^band/.test(name)),
      file + ': no student code and no age group');
  }
});
