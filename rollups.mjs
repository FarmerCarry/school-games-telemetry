// The daily tables of the ingest server: milestone 2's frozen aggregates (agg_*) and the
// rollups of the facts (r_*) that replace them, by the school's local day
// (docs/RESEARCH_TELEMETRY_SPEC.md, "Rollup semantics"). For each rollup, one SELECT ...
// GROUP BY over the sessions that started in a span of local days is its only definition.
// It is used three ways: as INSERT INTO r_x SELECT ... for a day's first roll (and for a
// full re-roll, after DELETE ... WHERE day = ?), as an upsert that writes only the rows
// that changed (a diff re-roll), and as a plain SELECT over the days not rolled yet. Every
// column of the frozen aggregates keeps its meaning, so v2 batches give the numbers
// milestone 2 gave. Distinct students are counted by their canonical code (an older code
// linked to a newer one counts as the newer one, as the links stand at the roll); the
// per-student rollups are keyed by the raw code, and links are applied when they are read.
// Pure: this module only writes SQL text.
import { CODES, ERRORS, SOURCES } from './schema.mjs';

const series = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
export const RT = series('rt', 6), IL = series('il', 6), F = series('f', 4);
export const PROFILE_AGE = series('profile_age', 4), SINCE_LAST = series('since_last', 5);
export const REPLAY = series('replay', 6), PLAYS = series('plays', 5);
const ERROR_COLUMNS = ERRORS.map(kind => 'error_' + kind), SOURCE_COLUMNS = SOURCES.map(src => 'src_' + src);

// The frozen daily aggregates of milestone 2: every table is keyed by (day, a, ...key) and
// holds whole-number sums; sessions is the number of distinct sessions in the group that day.
export const TABLES = {
  agg_days: { key: [], sums: ['sessions', 'web', 'app', 'engaged_ms', 'opens', 'starts', 'ends', 'level_ups', 'errors',
    'session_starts', 'new_profiles', 'guests', ...PROFILE_AGE, ...SINCE_LAST] },
  agg_games: { key: ['slug'], sums: ['sessions', 'opens', 'closes', 'engaged_ms', 'starts', 'ends', ...CODES,
    'tier_sum', 'tier_n', 'hits', 'misses', ...RT, ...IL, ...F, 'loads', 'load_ms', ...ERROR_COLUMNS, ...SOURCE_COLUMNS,
    ...REPLAY, ...PLAYS] },
  agg_levels: { key: ['slug', 'id'], sums: ['sessions', 'starts', 'ends', ...CODES, 'ms', 'tier_sum', 'tier_n'] },
  agg_sources: { key: ['src'], sums: ['sessions', 'opens'] },
  agg_devices: { key: ['cores', 'mem', 'screen'], sums: ['sessions', ...F, ...IL, 'loads', 'load_ms'] }
};

// The rollups, keyed by the school's local day: key columns with their types, TEXT
// columns that are not keys, and whole-number sums (all INTEGER NOT NULL DEFAULT 0).
const TEXT = 'TEXT', INT = 'INTEGER';
export const ROLLUPS = {
  r_day: { key: [['day', TEXT], ['a', TEXT]], sums: [...TABLES.agg_days.sums, 'students', 'new_students', 'guest_sessions',
    'v2_sessions', 'linked_ms', 'clock_r', 'unclosed', 'unended', 'duo', 'hearts_on', 'hearts_off', 'timer_sessions',
    'why_u', 'why_p', 'why_h', 'why_i'] },
  r_game_day: { key: [['day', TEXT], ['a', TEXT], ['slug', TEXT]], sums: [...TABLES.agg_games.sums, 'students', 'wall_s',
    'inputs', 'idle', 'pauses', 'rt_sum', 'rt_n', 'dda_sum', 'dda_n', 'score_sum', 'score_n', 'score_max', 'unended', 'duo',
    'hearts_on', 'hearts_off', 'tu_start', 'tu_done', 'fav_opens'] },
  r_level_day: { key: [['day', TEXT], ['a', TEXT], ['slug', TEXT], ['id', TEXT]], sums: [...TABLES.agg_levels.sums, 'students',
    'unended', 'hits', 'misses', 'score_sum', 'score_n', 'score_max', 'wall_ms', 'dda_sum', 'dda_n'] },
  r_source_day: { key: [['day', TEXT], ['a', TEXT], ['src', TEXT]], sums: ['sessions', 'opens'] },
  r_device_day: { key: [['day', TEXT], ['a', TEXT], ['cores', INT], ['mem', INT], ['screen', INT]], sums: TABLES.agg_devices.sums },
  r_student_day: { key: [['day', TEXT], ['u', TEXT]], text: ['a'], sums: ['sessions', 'engaged_ms', 'opens', 'games', 'rounds',
    ...CODES, 'hits', 'misses', 'rt_sum', 'rt_n', 'level_ups', 'first_s', 'last_s', 'pcs'], index: ['r_student_day_u', ['u', 'day']] },
  r_student_game: { key: [['day', TEXT], ['slug', TEXT], ['u', TEXT]], text: ['a'], sums: ['opens', 'engaged_ms', 'rounds', ...CODES,
    'hits', 'misses', 'rt_sum', 'rt_n', 'score_sum', 'score_n', 'score_max', 'dda_sum', 'dda_n', 'tier_sum', 'tier_n', 'hearts',
    'first_attempt', 'last_attempt'], index: ['r_student_game_u', ['u', 'day']] },
  r_pc_day: { key: [['day', TEXT], ['p', TEXT]], text: ['k'], sums: ['sessions', 'students', 'guests', 'engaged_ms', 'opens', 'loads',
    'load_ms', 'load_max', 'errors', 'quits', ...F, ...IL, 'np_max', 'new_profiles', 'busy_s', 'first_s', 'last_s', 'wire'] },
  r_stat: { key: [['day', TEXT], ['a', TEXT], ['metric', TEXT], ['slug', TEXT], ['k1', TEXT], ['k2', TEXT]], sums: ['n', 'students',
    ...CODES, 'ms', 'wall_ms', 'win_ms', 'hits', 'misses', 'rt_sum', 'rt_n', 'score_sum', 'score_n', 'tier_sum', 'tier_n', 'dda_sum',
    'dda_n', 'inputs', 'gap_sum', 'gap_n'] }
};
export const ROLLUP_TABLES = Object.keys(ROLLUPS);
// The r_stat metrics, in the order of the spec's table.
export const METRICS = ['hour', 'rhour', 'sesslen', 'daymin', 'games', 'visitlen', 'flow', 'attempt', 'tenure', 'persist', 'fatigue',
  'qrun', 'tier', 'tutorial'];
// The lower bounds of the buckets: minutes of a session, of a student's day; seconds of a
// visit; a student's attempt at a game; minutes into the session at a round's start.
export const BUCKETS = {
  sesslen: [0, 1, 2, 5, 10, 15, 20, 30, 45, 60], daymin: [0, 5, 10, 15, 20, 30, 45, 60, 90],
  visitlen: [0, 10, 30, 60, 120, 300, 600, 1200], attempt: [1, 2, 3, 4, 6, 11, 21, 51, 101], fatigue: [0, 5, 10, 15, 20, 30, 45]
};

// How the sums of one group add up: most are added; these keep the largest or the
// smallest value (a group without any keeps 0).
const LARGEST = new Set(['score_max', 'load_max', 'np_max', 'last_s', 'last_attempt', 'wire']);
const SMALLEST = new Set(['first_s', 'first_attempt']);
export const combine = c => LARGEST.has(c) ? 'max' : SMALLEST.has(c) ? 'min' : 'sum';

/* ------------------------------------------------------------ scopes */
// Which sessions a SELECT reads and how it dates them: `day` is the SQL of a session's local
// day, `lo` and `hi` the parameters of the UTC seconds [lo, hi) its start lies in, and
// local(x) the school's wall clock at the UTC second x (seconds, read as UTC). A roll reads
// one day: ?1 is the day and ?2, ?3 its bounds; the offset is ?5 seconds before the second
// ?4 and ?6 from it on (clock.mjs dayBounds).
export const DAY_SCOPE = { day: '?1', lo: '?2', hi: '?3', local: x => `((${x}) + CASE WHEN (${x}) >= ?4 THEN ?6 ELSE ?5 END)` };
// Several days, the seconds [?1, ?2): the zone's offsets over them (clock.mjs
// offsetsBetween) are written in; they are numbers computed here, so the text is safe.
export function spanScope({ o, changes }) {
  const offset = x => changes.length ? 'CASE ' + changes.slice().reverse().map(([ch, after]) => `WHEN (${x}) >= ${ch} THEN ${after * 60}`).join(' ') +
    ` ELSE ${o * 60} END` : String(o * 60);
  return { day: `date(s.start_s + ${offset('s.start_s')}, 'unixepoch')`, lo: '?1', hi: '?2', local: x => `((${x}) + ${offset(x)})` };
}
const within = scope => `s.start_s >= ${scope.lo} AND s.start_s < ${scope.hi}`;

/* --------------------------------------------------------- the facts */
const SESSIONS = 'st_sessions s', LINKED = ' LEFT JOIN aliases al ON al.u_old = s.u';
const VISITS = ' JOIN st_visits v ON v.sid = s.id', ROUNDS = ' JOIN st_rounds r ON r.sid = s.id';
const marks = kinds => ` JOIN st_marks k ON k.sid = s.id AND k.kind IN (${kinds.map(kind => `'${kind}'`).join(', ')})`;
// A mark of a game visit (fv, tu), with the visit for its game.
const VISIT_MARK = ' JOIN st_visits v ON v.sid = k.sid AND v.n = k.n';
const CANON = 'COALESCE(al.u_new, s.u)';
const STUDENTS = `COUNT(DISTINCT CASE WHEN s.u <> '' THEN ${CANON} END)`;
const STUDENT = " AND s.u <> ''";

const each = (columns, expr) => Object.fromEntries(columns.map((c, i) => [c, expr(c, i)]));
const outcomes = each(CODES, c => `TOTAL(r.code = '${c}')`);
const roundsEnded = { rounds: 'TOTAL(r.code IS NOT NULL)' };
const startsEnds = { starts: 'TOTAL(r.t0 IS NOT NULL)', ends: 'TOTAL(r.code IS NOT NULL)' };
// The tier a round was started at (rs); 0 is a game without levels of difficulty.
const tiers = { tier_sum: 'TOTAL(CASE WHEN r.tier0 > 0 THEN r.tier0 END)', tier_n: 'TOTAL(r.tier0 > 0)' };
const dda = { dda_sum: 'TOTAL(CASE WHEN r.dda >= 0 THEN r.dda END)', dda_n: 'TOTAL(r.dda >= 0)' };
const scores = { score_sum: 'TOTAL(r.score)', score_n: 'TOTAL(r.score IS NOT NULL)' };
const accuracy = { hits: 'TOTAL(r.hits)', misses: 'TOTAL(r.misses)' };
const reaction = { rt_sum: 'TOTAL(r.rt_sum)', rt_n: 'TOTAL(r.rt_n)' };
const health = { ...each([...F, ...IL], c => `TOTAL(v.${c})`), loads: 'TOTAL(v.load_ms IS NOT NULL)', load_ms: 'TOTAL(v.load_ms)' };
const visitTime = { engaged_ms: 'TOTAL(v.engaged_ms)', opens: 'TOTAL(v.t_open IS NOT NULL)' };
const hearts = { hearts_on: "TOTAL(k.kind = 'fv' AND k.x = '1')", hearts_off: "TOTAL(k.kind = 'fv' AND k.x = '0')" };
const unended = { unended: 'TOTAL(r.code IS NULL)' }, duo = { duo: 'TOTAL(r.duo)' };
// The replay index of milestone 2: 0, 1, 2, 3-4, 5-9, 10+ earlier starts of the round in the session.
const replayBucket = 'CASE WHEN r.replay IS NULL THEN -1 WHEN r.replay < 3 THEN r.replay WHEN r.replay < 5 THEN 3 WHEN r.replay < 10 THEN 4 ELSE 5 END';
// The band of a code's first session (and the build of a PC's last one) in the group: a
// fixed-width text that sorts by start, then id.
const firstOf = (aggregate, column) => `substr(${aggregate}(printf('%011d %011d %s', s.start_s, s.id, ${column})), 25)`;
// The last second of a session that is known: its end, or its latest visit or round time.
const LAST_T = 'COALESCE(s.se_t, MAX(IFNULL((SELECT MAX(MAX(IFNULL(x.t_open, 0), IFNULL(x.t_close, 0))) FROM st_visits x WHERE x.sid = s.id), 0), ' +
  'IFNULL((SELECT MAX(MAX(IFNULL(y.t0, 0), IFNULL(y.t, 0))) FROM st_rounds y WHERE y.sid = s.id), 0)))';

// Each rollup as parts over the facts: what they read, extra conditions, their key
// expressions and the columns they add (every other column is NULL in that part).
const ROLL_PARTS = {
  r_day: [
    { from: SESSIONS + LINKED, keys: { a: 's.a' }, values: {
      sessions: 'COUNT(*)', web: "TOTAL(s.m = 'web')", app: "TOTAL(s.m = 'app')", session_starts: 'TOTAL(s.level0 IS NOT NULL)',
      new_profiles: 'TOTAL(s.is_new)', guests: 'TOTAL(s.level0 = 0)', ...each(PROFILE_AGE, (c, i) => `TOTAL(s.age_b = ${i})`),
      ...each(SINCE_LAST, (c, i) => `TOTAL(s.since_b = ${i})`), students: STUDENTS,
      new_students: `COUNT(DISTINCT CASE WHEN s.u <> '' AND s.is_new = 1 THEN ${CANON} END)`,
      guest_sessions: "TOTAL(s.wire = 3 AND s.u = '')", v2_sessions: 'TOTAL(s.wire = 2)', clock_r: "TOTAL(s.clock = 'r')",
      ...Object.fromEntries(['u', 'p', 'h', 'i'].map(why => ['why_' + why, `TOTAL(s.why = '${why}')`])) } },
    { from: SESSIONS + VISITS, keys: { a: 's.a' }, values: { ...visitTime, errors: 'TOTAL(v.err IS NOT NULL)',
      linked_ms: "TOTAL(CASE WHEN s.u <> '' THEN v.engaged_ms END)", unclosed: 'TOTAL(v.closed = 0)' } },
    { from: SESSIONS + ROUNDS, keys: { a: 's.a' }, values: { ...startsEnds, ...unended, ...duo } },
    { from: SESSIONS + marks(['lv', 'fv', 'ct']), keys: { a: 's.a' }, values: { level_ups: "TOTAL(k.kind = 'lv')", ...hearts,
      timer_sessions: "COUNT(DISTINCT CASE WHEN k.kind = 'ct' AND k.x LIKE 's:%' THEN k.sid END)" } }
  ],
  r_game_day: [
    { from: SESSIONS + LINKED + VISITS, keys: { a: 's.a', slug: 'v.slug' }, values: {
      sessions: 'COUNT(DISTINCT v.sid)', ...visitTime, closes: 'TOTAL(v.closed)', ...health,
      ...Object.fromEntries(ERRORS.map(kind => ['error_' + kind, `TOTAL(v.err = '${kind}')`])),
      ...Object.fromEntries(SOURCES.map(src => ['src_' + src, `TOTAL(v.src = '${src}')`])), ...each(PLAYS, (c, i) => `TOTAL(v.plays_b = ${i})`),
      students: STUDENTS, fav_opens: 'TOTAL(v.fav = 1)' } },
    { from: SESSIONS + ROUNDS, keys: { a: 's.a', slug: 'r.slug' }, values: {
      ...startsEnds, ...outcomes, ...tiers, ...accuracy, ...each(RT, c => `TOTAL(r.${c})`), ...each(REPLAY, (c, i) => `TOTAL(${replayBucket} = ${i})`),
      wall_s: 'ROUND(TOTAL(r.wall_ms) / 1000)', inputs: 'TOTAL(r.inputs)', idle: 'TOTAL(r.idle)', pauses: 'TOTAL(r.pauses)', ...reaction,
      ...dda, ...scores, score_max: 'MAX(r.score)', ...unended, ...duo } },
    { from: SESSIONS + marks(['fv', 'tu']) + VISIT_MARK, keys: { a: 's.a', slug: 'v.slug' }, values: { ...hearts,
      tu_start: "TOTAL(k.kind = 'tu' AND k.x = 's')", tu_done: "TOTAL(k.kind = 'tu' AND k.x = 'd')" } }
  ],
  r_level_day: [
    { from: SESSIONS + LINKED + ROUNDS, keys: { a: 's.a', slug: 'r.slug', id: 'r.id' }, values: {
      sessions: 'COUNT(DISTINCT r.sid)', ...startsEnds, ...outcomes, ms: 'TOTAL(r.ms)', ...tiers, students: STUDENTS, ...unended,
      ...accuracy, ...scores, score_max: 'MAX(r.score)', wall_ms: 'TOTAL(r.wall_ms)', ...dda } }
  ],
  r_source_day: [
    { from: SESSIONS + VISITS, where: ' AND v.src IS NOT NULL', keys: { a: 's.a', src: 'v.src' }, values: { sessions: 'COUNT(DISTINCT v.sid)', opens: 'COUNT(*)' } }
  ],
  r_device_day: [
    { from: SESSIONS, keys: { a: 's.a', cores: 's.cores', mem: 's.mem', screen: 's.screen' }, values: { sessions: 'COUNT(*)' } },
    { from: SESSIONS + VISITS, keys: { a: 's.a', cores: 's.cores', mem: 's.mem', screen: 's.screen' }, values: health }
  ],
  r_student_day: [
    { from: SESSIONS, where: STUDENT, keys: { u: 's.u' }, values: { a: firstOf('MIN', 's.a'), sessions: 'COUNT(*)', first_s: 'MIN(s.start_s)',
      last_s: 'MAX(s.start_s)', pcs: "COUNT(DISTINCT NULLIF(s.p, ''))" } },
    { from: SESSIONS + VISITS, where: STUDENT, keys: { u: 's.u' }, values: { ...visitTime, games: 'COUNT(DISTINCT v.slug)' } },
    { from: SESSIONS + ROUNDS, where: STUDENT, keys: { u: 's.u' }, values: { ...roundsEnded, ...outcomes, ...accuracy, ...reaction } },
    { from: SESSIONS + marks(['lv']), where: STUDENT, keys: { u: 's.u' }, values: { level_ups: 'COUNT(*)' } }
  ],
  r_student_game: [
    { from: SESSIONS + VISITS, where: STUDENT, keys: { slug: 'v.slug', u: 's.u' }, values: { a: firstOf('MIN', 's.a'), ...visitTime } },
    { from: SESSIONS + ROUNDS, where: STUDENT, keys: { slug: 'r.slug', u: 's.u' }, values: { ...roundsEnded, ...outcomes, ...accuracy, ...reaction,
      ...scores, score_max: 'MAX(r.score)', ...dda, ...tiers, first_attempt: 'MIN(r.attempt)', last_attempt: 'MAX(r.attempt)' } },
    { from: SESSIONS + marks(['fv']) + VISIT_MARK, where: STUDENT, keys: { slug: 'v.slug', u: 's.u' },
      values: { hearts: "TOTAL(CASE k.x WHEN '1' THEN 1 ELSE -1 END)" } }
  ],
  r_pc_day: [
    { from: SESSIONS + LINKED, keys: { p: 's.p' }, values: { k: firstOf('MAX', 's.k'), sessions: 'COUNT(*)', students: STUDENTS,
      guests: "TOTAL(s.wire = 3 AND s.u = '')", np_max: 'MAX(s.np)', new_profiles: 'TOTAL(s.is_new)', busy_s: `TOTAL(${LAST_T})`,
      first_s: 'MIN(s.start_s)', last_s: 'MAX(s.start_s)', wire: 'MAX(s.wire)' } },
    { from: SESSIONS + VISITS, keys: { p: 's.p' }, values: { ...visitTime, ...health, load_max: 'MAX(v.load_ms)', errors: 'TOTAL(v.err IS NOT NULL)' } },
    { from: SESSIONS + ROUNDS, keys: { p: 's.p' }, values: { quits: "TOTAL(r.code = 'q')" } }
  ]
};

// x in the bucket of its lower bound (bounds times scale, the unit of x).
const bucket = (x, bounds, scale = 1) => 'CASE ' + bounds.slice(1).map((b, i) => `WHEN ${x} < ${b * scale} THEN '${bounds[i]}'`).join(' ') +
  ` ELSE '${bounds.at(-1)}' END`;
const hourOf = (scope, x) => `strftime('%H', ${scope.local(x)}, 'unixepoch')`;
const weekdayOf = (scope, x) => `strftime('%w', ${scope.local(x)}, 'unixepoch')`;
// A round's skill measures: outcomes, times, accuracy, reaction time, score, tier, DDA level, inputs.
const SKILL = { ...outcomes, ms: 'TOTAL(r.ms)', wall_ms: 'TOTAL(r.wall_ms)', win_ms: "TOTAL(CASE WHEN r.code = 'w' THEN r.ms END)", ...accuracy,
  ...reaction, ...scores, ...tiers, ...dda, inputs: 'TOTAL(r.inputs)' };
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
// A session's engaged time: the sum of its visits'.
const ENGAGED = '(SELECT TOTAL(x.engaged_ms) FROM st_visits x WHERE x.sid = s.id)';
const KIND = "CASE WHEN s.wire = 2 THEN 'u' WHEN s.u = '' THEN 'g' ELSE 's' END";
const SOLO = ' AND r.code IS NOT NULL AND r.duo = 0';
const ATTEMPTED = " AND s.u <> '' AND r.duo = 0 AND r.code IS NOT NULL AND r.attempt IS NOT NULL";
// Losses in a row just before round r in its visit: the lost rounds after its last earlier round that was not a loss.
const LOSSES = "(SELECT COUNT(*) FROM st_rounds p WHERE p.sid = r.sid AND p.n = r.n AND p.k < r.k AND p.code = 'l' AND p.k > " +
  "IFNULL((SELECT MAX(o.k) FROM st_rounds o WHERE o.sid = r.sid AND o.n = r.n AND o.k < r.k AND (o.code IS NULL OR o.code <> 'l')), 0))";
const tutorialMark = x => `EXISTS (SELECT 1 FROM st_marks t WHERE t.sid = v.sid AND t.kind = 'tu' AND t.n = v.n AND t.x = '${x}')`;

// The r_stat metrics as parts: what they read (with the scope's sessions), and the key
// (slug, k1, k2) and sums of their rows; a part may read a derived table x, with its own
// day and band. `a` is the session's band.
function statParts(scope) {
  const R = SESSIONS + LINKED + ROUNDS, V = SESSIONS + LINKED + VISITS, range = within(scope);
  const sessionRows = extra => `(SELECT ${scope.day} AS day, s.a AS a, CASE WHEN s.u <> '' THEN ${CANON} END AS c, ${extra} ` +
    `FROM ${SESSIONS + LINKED} WHERE ${range}) x`;
  return [
    { metric: 'hour', from: V, where: ' AND v.t_open IS NOT NULL', slug: "''", k1: hourOf(scope, 's.start_s + v.t_open'),
      k2: weekdayOf(scope, 's.start_s + v.t_open'), values: { n: 'COUNT(*)', students: STUDENTS, ms: 'TOTAL(v.engaged_ms)' } },
    { metric: 'rhour', from: R, where: ' AND r.t0 IS NOT NULL', slug: "''", k1: hourOf(scope, 's.start_s + r.t0'),
      k2: weekdayOf(scope, 's.start_s + r.t0'), values: { n: 'COUNT(*)', students: STUDENTS, ...pick(outcomes, ['w', 'l', 'q']), ...accuracy, ...reaction } },
    { metric: 'sesslen', derived: sessionRows(`${KIND} AS kind, ${ENGAGED} AS m`), slug: "''", k1: bucket('x.m', BUCKETS.sesslen, 60000),
      k2: 'x.kind', values: { n: 'COUNT(*)', students: 'COUNT(DISTINCT x.c)', ms: 'TOTAL(x.m)' } },
    // A student's day: every session of their canonical code that day, with the band of the first.
    { metric: 'daymin', derived: `(SELECT y.day, substr(MIN(y.o), 25) AS a, TOTAL(y.m) AS m FROM (SELECT ${scope.day} AS day, ${CANON} AS c, ` +
      `printf('%011d %011d %s', s.start_s, s.id, s.a) AS o, ${ENGAGED} AS m FROM ${SESSIONS + LINKED} WHERE ${range}${STUDENT}) y ` +
      'GROUP BY y.day, y.c) x', slug: "''", k1: bucket('x.m', BUCKETS.daymin, 60000), k2: "''", values: { n: 'COUNT(*)', students: 'COUNT(*)', ms: 'TOTAL(x.m)' } },
    { metric: 'games', derived: sessionRows('(SELECT COUNT(DISTINCT y.slug) FROM st_visits y WHERE y.sid = s.id AND y.t_open IS NOT NULL) AS g'),
      where: ' WHERE x.g > 0', slug: "''", k1: "CASE WHEN x.g >= 8 THEN '8' WHEN x.g >= 6 THEN '6' ELSE CAST(x.g AS TEXT) END", k2: "''",
      values: { n: 'COUNT(*)', students: 'COUNT(DISTINCT x.c)' } },
    { metric: 'visitlen', from: V, slug: 'v.slug', k1: bucket('v.engaged_ms', BUCKETS.visitlen, 1000),
      k2: "CASE WHEN EXISTS (SELECT 1 FROM st_rounds y WHERE y.sid = v.sid AND y.n = v.n AND y.code IS NOT NULL) THEN '1' ELSE '0' END",
      values: { n: 'COUNT(*)', students: STUDENTS, ms: 'TOTAL(v.engaged_ms)' } },
    // Into each visit from the one before ('' at the session's start), and out of a visit with no next one.
    { metric: 'flow', from: V + ' LEFT JOIN st_visits pv ON pv.sid = v.sid AND pv.n = v.n - 1', slug: "IFNULL(pv.slug, '')", k1: 'v.slug', k2: "''",
      values: { n: 'COUNT(*)', students: STUDENTS, gap_sum: 'TOTAL(CASE WHEN pv.t_close IS NOT NULL AND v.t_open IS NOT NULL THEN MAX(v.t_open - pv.t_close, 0) END)',
        gap_n: 'TOTAL(pv.t_close IS NOT NULL AND v.t_open IS NOT NULL)' } },
    { metric: 'flow', from: V, where: ' AND NOT EXISTS (SELECT 1 FROM st_visits nx WHERE nx.sid = v.sid AND nx.n = v.n + 1)', slug: 'v.slug', k1: "''", k2: "''",
      values: { n: 'COUNT(*)', students: STUDENTS } },
    { metric: 'attempt', from: R, where: ATTEMPTED, slug: 'r.slug', k1: bucket('r.attempt', BUCKETS.attempt), k2: "''",
      values: { n: 'COUNT(*)', students: STUDENTS, ...SKILL } },
    { metric: 'tenure', from: R + ' JOIN st_student_games g ON g.u = s.u AND g.slug = r.slug', where: ATTEMPTED, slug: 'r.slug',
      k1: 'CAST(MIN(MAX(s.start_s + IFNULL(r.t0, r.t) - g.first_s, 0) / 604800, 13) AS TEXT)', k2: "''", values: { n: 'COUNT(*)', students: STUDENTS, ...SKILL } },
    { metric: 'persist', from: R + ' LEFT JOIN st_rounds nx ON nx.sid = r.sid AND nx.n = r.n AND nx.k = r.k + 1', where: SOLO, slug: 'r.slug', k1: 'r.code',
      k2: "CASE WHEN nx.k IS NOT NULL THEN CASE WHEN nx.id = r.id THEN 'same' ELSE 'level' END " +
        "WHEN EXISTS (SELECT 1 FROM st_visits y WHERE y.sid = r.sid AND y.n > r.n) THEN 'game' ELSE 'stop' END",
      values: { n: 'COUNT(*)', students: STUDENTS, gap_sum: 'TOTAL(CASE WHEN nx.t0 IS NOT NULL THEN MAX(nx.t0 - r.t, 0) END)', gap_n: 'COUNT(nx.t0)' } },
    { metric: 'fatigue', from: R, where: SOLO, slug: 'r.slug', k1: bucket('IFNULL(r.t0, r.t)', BUCKETS.fatigue, 60), k2: "''",
      values: { n: 'COUNT(*)', students: STUDENTS, ...pick(outcomes, ['w', 'l', 'q']), ...accuracy, ...reaction, inputs: 'TOTAL(r.inputs)', ms: 'TOTAL(r.ms)' } },
    { metric: 'qrun', from: R, where: SOLO + " AND (r.code = 'q' OR NOT EXISTS (SELECT 1 FROM st_rounds y WHERE y.sid = r.sid AND y.n = r.n AND y.k > r.k))",
      slug: 'r.slug', k1: `CAST(MIN(${LOSSES}, 5) AS TEXT)`, k2: "CASE WHEN r.code = 'q' THEN 'q' ELSE 'x' END", values: { n: 'COUNT(*)', students: STUDENTS } },
    { metric: 'tier', from: R, where: ' AND r.code IS NOT NULL AND r.tier0 > 0', slug: 'r.slug', k1: 'CAST(r.tier0 AS TEXT)', k2: "''",
      values: { n: 'COUNT(*)', students: STUDENTS, ...pick(outcomes, ['w', 'l', 'q']), ms: 'TOTAL(r.ms)', win_ms: SKILL.win_ms } },
    { metric: 'tutorial', from: V, slug: 'v.slug',
      k1: `CASE WHEN ${tutorialMark('d')} THEN 'done' WHEN ${tutorialMark('s')} THEN 'start' ELSE 'none' END`,
      k2: "IFNULL((SELECT y.code FROM st_rounds y WHERE y.sid = v.sid AND y.n = v.n AND y.code IS NOT NULL ORDER BY y.k LIMIT 1), '')",
      values: { n: 'COUNT(*)', students: STUDENTS } }
  ];
}

// The r_stat sums each metric has (the others are always 0 in its rows), in the table's order.
export const METRIC_SUMS = Object.fromEntries(METRICS.map(metric => {
  const used = new Set(statParts(DAY_SCOPE).filter(part => part.metric === metric).flatMap(part => Object.keys(part.values)));
  return [metric, ROLLUPS.r_stat.sums.filter(c => used.has(c))];
}));

/* ------------------------------------------------------------ the SQL */
// D1 refuses a compound SELECT of more than 5 terms and an SQL function of more than 32
// arguments (sqlite-d1.mjs D1_LIMITS). SELECTs joined by UNION ALL, nested as
// SELECT * FROM (...) in groups of at most `max` terms (4 leaves room for one more term).
export function unionAll(parts, max = 4) {
  if (parts.length <= max) return parts.join(' UNION ALL ');
  const groups = [];
  for (let i = 0; i < parts.length; i += max) groups.push(parts.length - i === 1 ? parts[i] : `SELECT * FROM (${parts.slice(i, i + max).join(' UNION ALL ')})`);
  return unionAll(groups, max);
}
// json_array of the expressions, as one array of arrays of at most 32 (flat when they fit):
// read back with flatRow.
export const ARGS = 32;
export const jsonArray = list => list.length <= ARGS ? `json_array(${list.join(', ')})`
  : jsonArray(Array.from({ length: Math.ceil(list.length / ARGS) }, (_, i) => `json_array(${list.slice(i * ARGS, (i + 1) * ARGS).join(', ')})`));
// json_object of [key, SQL] pairs: the first 16 in json_object, the rest added 15 at a time by json_set.
export function jsonObject(pairs) {
  const arg = ([key, sql]) => [`'${key}'`, sql];
  let text = `json_object(${pairs.slice(0, 16).flatMap(arg).join(', ')})`;
  for (let i = 16; i < pairs.length; i += 15) text = `json_set(${text}, ${pairs.slice(i, i + 15).flatMap(([key, sql]) => [`'$.${key}'`, sql]).join(', ')})`;
  return text;
}

const keysOf = table => ROLLUPS[table].key.map(([c]) => c);
const valuesOf = table => [...(ROLLUPS[table].text || []), ...ROLLUPS[table].sums];
const columnsOf = table => [...keysOf(table), ...valuesOf(table)];
const positions = n => Array.from({ length: n }, (_, i) => i + 1).join(', ');
// How a column of the parts adds up into the group.
function outer(table, c) {
  if ((ROLLUPS[table].text || []).includes(c)) return `IFNULL(MAX(${c}), '')`;
  const how = combine(c);
  return how === 'sum' ? `TOTAL(${c})` : `IFNULL(${how.toUpperCase()}(${c}), 0)`;
}

// The rows of a rollup over the sessions of `scope`, in the table's column order.
export function rollupSelect(table, scope) {
  if (table === 'r_stat') return statSelect(scope);
  const keys = keysOf(table).slice(1), values = valuesOf(table);
  const parts = ROLL_PARTS[table].map(({ from, where = '', keys: exprs, values: sums }) =>
    `SELECT ${scope.day} AS day, ${keys.map(c => `${exprs[c]} AS ${c}`).join(', ')}, ${values.map(c => `${sums[c] ?? 'NULL'} AS ${c}`).join(', ')} ` +
    `FROM ${from} WHERE ${within(scope)}${where} GROUP BY ${positions(keys.length + 1)}`);
  return `SELECT day, ${keys.join(', ')}, ${values.map(c => `${outer(table, c)} AS ${c}`).join(', ')} FROM (${unionAll(parts)}) ` +
    `GROUP BY ${positions(keys.length + 1)}`;
}
function statSelect(scope) {
  const sums = ROLLUPS.r_stat.sums;
  return unionAll(statParts(scope).map(({ metric, from, derived, where = '', slug, k1, k2, values }) =>
    `SELECT ${derived ? 'x.day' : scope.day} AS day, ${derived ? 'x.a' : 's.a'} AS a, '${metric}' AS metric, ${slug} AS slug, ${k1} AS k1, ${k2} AS k2, ` +
    sums.map(c => `${values[c] ?? 0} AS ${c}`).join(', ') +
    (derived ? ` FROM ${derived}${where}` : ` FROM ${from} WHERE ${within(scope)}${where}`) + ' GROUP BY 1, 2, 3, 4, 5, 6'));
}

// The school-wide rollups (and r_stat), whose rows can lose every fact behind them: after a
// forget, or (r_stat) when late data moves a visit into another bucket or gives a round a
// next one. A row of theirs always has a count of at least 1 when it has facts, so a row
// whose values are all zero has none. The per-student rollups lose rows only by a forget,
// which deletes them itself.
const PRUNED = new Set(['r_day', 'r_game_day', 'r_level_day', 'r_source_day', 'r_device_day', 'r_pc_day', 'r_stat']);

// The statements that roll one day (DAY_SCOPE's parameters), per rollup:
// insert: the first roll, or a full re-roll after `clear`; diff: an upsert that writes
// only the rows that changed (late data, a recount after a forget or a link), then prune.
// The diff of a pruned table also sets the day's rows that no longer have facts to zero,
// and prune deletes them, so a diff leaves the day as a fresh roll would at a few writes.
export function rollStatements(table) {
  const columns = columnsOf(table), keys = keysOf(table), values = valuesOf(table), text = new Set(ROLLUPS[table].text || []);
  const select = rollupSelect(table, DAY_SCOPE), pruned = PRUNED.has(table);
  const insert = `INSERT INTO ${table} (${columns.join(', ')}) ${select}`;
  // The day's stored keys, without values (NULL): each value then adds up from the facts alone, or to 0 ('' for text).
  const source = pruned
    ? `SELECT ${keys.join(', ')}, ${values.map(c => `${outer(table, c)} AS ${c}`).join(', ')} FROM (${select} UNION ALL SELECT ${keys.join(', ')}, ` +
      `${values.map(() => 'NULL').join(', ')} FROM ${table} WHERE day = ?1) GROUP BY ${positions(keys.length)}`
    : select;
  const diff = `INSERT INTO ${table} (${columns.join(', ')}) SELECT * FROM (${source}) WHERE true ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ` +
    values.map(c => `${c} = excluded.${c}`).join(', ') + ` WHERE (${values.join(', ')}) IS NOT (${values.map(c => 'excluded.' + c).join(', ')})`;
  const prune = pruned ? `DELETE FROM ${table} WHERE day = ?1 AND (${values.join(', ')}) = (${values.map(c => text.has(c) ? "''" : '0').join(', ')})` : null;
  return { insert, diff, prune, clear: `DELETE FROM ${table} WHERE day = ?1` };
}
