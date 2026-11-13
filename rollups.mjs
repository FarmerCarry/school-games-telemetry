// The daily tables of the ingest server: milestone 2's frozen aggregates (agg_*) and the
// rollups of the facts (r_*) that replace them, by the school's local day
// (docs/RESEARCH_TELEMETRY_SPEC.md, "Rollup semantics"). For each rollup, one SELECT ...
// GROUP BY over the sessions that started in a span of local days is its only definition.
// It is used three ways: as INSERT INTO r_x SELECT ... for a day's first roll (and for a
// full re-roll, after DELETE ... WHERE day = ?), as an upsert that writes only the rows
// that changed (a diff re-roll), and as a plain SELECT over the days not rolled yet. Every
// column of the frozen aggregates that is still counted keeps its meaning, so v2 batches
// give the numbers milestone 2 gave. Sessions are anonymous: nothing is counted per child,
// per profile or per age group.
// Schema 4 kept the age band in the column a of the school-wide tables (a key column), and
// counts of students, guests and profiles in others. Schema 5 keeps those columns, so that
// its upgrade need not rewrite every row of a table (D1 bills each row written): a is
// always '' and the counts (`cleared`) always 0; the upgrade clears the rows schema 4
// wrote, a few days at a time (clearStatements), and every read adds the rows of a day up
// whatever their a, so it counts alike before and after.
// Pure: this module only writes SQL text.
import { CODES, ERRORS, SOURCES } from './schema.mjs';

const series = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
export const RT = series('rt', 6), IL = series('il', 6), F = series('f', 4);
export const PROFILE_AGE = series('profile_age', 4), SINCE_LAST = series('since_last', 5);
export const REPLAY = series('replay', 6), PLAYS = series('plays', 5);
const ERROR_COLUMNS = ERRORS.map(kind => 'error_' + kind), SOURCE_COLUMNS = SOURCES.map(src => 'src_' + src);

// The frozen daily aggregates of milestone 2: every table is keyed by (day, a, ...key) and
// holds whole-number sums; sessions is the number of distinct sessions in the group that day.
// `cleared`: the sums of the players' profiles, never read, and 0 once the upgrade to schema 5
// has cleared their day.
export const TABLES = {
  agg_days: { key: [], sums: ['sessions', 'web', 'app', 'engaged_ms', 'opens', 'starts', 'ends', 'errors'],
    cleared: ['level_ups', 'session_starts', 'new_profiles', 'guests', ...PROFILE_AGE, ...SINCE_LAST] },
  agg_games: { key: ['slug'], sums: ['sessions', 'opens', 'closes', 'engaged_ms', 'starts', 'ends', ...CODES,
    'tier_sum', 'tier_n', 'hits', 'misses', ...RT, ...IL, ...F, 'loads', 'load_ms', ...ERROR_COLUMNS, ...SOURCE_COLUMNS,
    ...REPLAY, ...PLAYS] },
  agg_levels: { key: ['slug', 'id'], sums: ['sessions', 'starts', 'ends', ...CODES, 'ms', 'tier_sum', 'tier_n'] },
  agg_sources: { key: ['src'], sums: ['sessions', 'opens'] },
  agg_devices: { key: ['cores', 'mem', 'screen'], sums: ['sessions', ...F, ...IL, 'loads', 'load_ms'] }
};

// The rollups, keyed by the school's local day: key columns with their types, TEXT
// columns that are not keys, whole-number sums (all INTEGER NOT NULL DEFAULT 0), and the
// sums schema 4 counted per student, guest or profile (`cleared`: never written or read,
// 0 once cleared). A table with the key a has '' in it.
const TEXT = 'TEXT', INT = 'INTEGER';
export const ROLLUPS = {
  r_day: { key: [['day', TEXT], ['a', TEXT]], sums: [...TABLES.agg_days.sums, 'v2_sessions', 'clock_r', 'unclosed', 'unended', 'duo',
    'hearts_on', 'hearts_off', 'timer_sessions', 'why_u', 'why_p', 'why_h', 'why_i'],
  cleared: [...TABLES.agg_days.cleared, 'students', 'new_students', 'guest_sessions', 'linked_ms'] },
  r_game_day: { key: [['day', TEXT], ['a', TEXT], ['slug', TEXT]], sums: [...TABLES.agg_games.sums, 'wall_s',
    'inputs', 'idle', 'pauses', 'rt_sum', 'rt_n', 'dda_sum', 'dda_n', 'score_sum', 'score_n', 'score_max', 'unended', 'duo',
    'hearts_on', 'hearts_off', 'tu_start', 'tu_done', 'fav_opens'], cleared: ['students'] },
  r_level_day: { key: [['day', TEXT], ['a', TEXT], ['slug', TEXT], ['id', TEXT]], sums: [...TABLES.agg_levels.sums,
    'unended', 'hits', 'misses', 'score_sum', 'score_n', 'score_max', 'wall_ms', 'dda_sum', 'dda_n'], cleared: ['students'] },
  r_source_day: { key: [['day', TEXT], ['a', TEXT], ['src', TEXT]], sums: ['sessions', 'opens'] },
  r_device_day: { key: [['day', TEXT], ['a', TEXT], ['cores', INT], ['mem', INT], ['screen', INT]], sums: TABLES.agg_devices.sums },
  r_pc_day: { key: [['day', TEXT], ['p', TEXT]], text: ['k'], sums: ['sessions', 'engaged_ms', 'opens', 'loads',
    'load_ms', 'load_max', 'errors', 'quits', ...F, ...IL, 'busy_s', 'first_s', 'last_s', 'wire'],
  cleared: ['students', 'guests', 'np_max', 'new_profiles'] },
  // r_stat's d, e, wall_ms, score_*, tier_* and dda_* were only counted by the per-student metrics.
  r_stat: { key: [['day', TEXT], ['a', TEXT], ['metric', TEXT], ['slug', TEXT], ['k1', TEXT], ['k2', TEXT]], sums: ['n',
    'w', 'l', 'q', 'ms', 'win_ms', 'hits', 'misses', 'rt_sum', 'rt_n', 'inputs', 'gap_sum', 'gap_n'],
  cleared: ['students', 'd', 'e', 'wall_ms', 'score_sum', 'score_n', 'tier_sum', 'tier_n', 'dda_sum', 'dda_n'] }
};
export const ROLLUP_TABLES = Object.keys(ROLLUPS);
// The tables with the key a.
export const BANDED = ROLLUP_TABLES.filter(table => ROLLUPS[table].key.some(([c]) => c === 'a'));
// The values a can hold: '' (schema 5), and on a day the upgrade has not cleared yet schema
// 4's age bands. A read that finds r_stat rows by their key looks for each.
export const A_KEYS = ['', '6-7', '8-9', '10-11'];
// The per-student rollups of schema 4, dropped by the upgrade to schema 5.
export const DROPPED_ROLLUPS = ['r_student_day', 'r_student_game'];
// The r_stat metrics, in the order of the spec's table (schema 4 also had daymin, attempt
// and tenure, which were counted per student: the upgrade deletes their rows).
export const METRICS = ['hour', 'rhour', 'sesslen', 'games', 'visitlen', 'flow', 'persist', 'fatigue', 'qrun', 'tier', 'tutorial'];
export const DROPPED_METRICS = ['daymin', 'attempt', 'tenure'];
// The lower bounds of the buckets: minutes of a session; seconds of a visit; minutes into
// the session at a round's start.
export const BUCKETS = {
  sesslen: [0, 1, 2, 5, 10, 15, 20, 30, 45, 60], visitlen: [0, 10, 30, 60, 120, 300, 600, 1200], fatigue: [0, 5, 10, 15, 20, 30, 45]
};

// How the sums of one group add up: most are added; these keep the largest or the
// smallest value (a group without any keeps 0).
const LARGEST = new Set(['score_max', 'load_max', 'last_s', 'wire']);
const SMALLEST = new Set(['first_s']);
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
const SESSIONS = 'st_sessions s';
const VISITS = ' JOIN st_visits v ON v.sid = s.id', ROUNDS = ' JOIN st_rounds r ON r.sid = s.id';
const marks = kinds => ` JOIN st_marks k ON k.sid = s.id AND k.kind IN (${kinds.map(kind => `'${kind}'`).join(', ')})`;
// A mark of a game visit (fv, tu), with the visit for its game.
const VISIT_MARK = ' JOIN st_visits v ON v.sid = k.sid AND v.n = k.n';
// The key a of every row written since schema 5.
const NO_BAND = "''";

const each = (columns, expr) => Object.fromEntries(columns.map((c, i) => [c, expr(c, i)]));
const outcomes = each(CODES, c => `TOTAL(r.code = '${c}')`);
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
// The build of a PC's last session in the group: a fixed-width text that sorts by start, then id.
const firstOf = (aggregate, column) => `substr(${aggregate}(printf('%011d %011d %s', s.start_s, s.id, ${column})), 25)`;
// The last second of a session that is known: its end, or its latest visit or round time.
const LAST_T = 'COALESCE(s.se_t, MAX(IFNULL((SELECT MAX(MAX(IFNULL(x.t_open, 0), IFNULL(x.t_close, 0))) FROM st_visits x WHERE x.sid = s.id), 0), ' +
  'IFNULL((SELECT MAX(MAX(IFNULL(y.t0, 0), IFNULL(y.t, 0))) FROM st_rounds y WHERE y.sid = s.id), 0)))';

// Each rollup as parts over the facts: what they read, extra conditions, their key
// expressions and the columns they add (every other column is NULL in that part).
const ROLL_PARTS = {
  r_day: [
    { from: SESSIONS, keys: { a: NO_BAND }, values: {
      sessions: 'COUNT(*)', web: "TOTAL(s.m = 'web')", app: "TOTAL(s.m = 'app')", v2_sessions: 'TOTAL(s.wire = 2)', clock_r: "TOTAL(s.clock = 'r')",
      ...Object.fromEntries(['u', 'p', 'h', 'i'].map(why => ['why_' + why, `TOTAL(s.why = '${why}')`])) } },
    { from: SESSIONS + VISITS, keys: { a: NO_BAND }, values: { ...visitTime, errors: 'TOTAL(v.err IS NOT NULL)', unclosed: 'TOTAL(v.closed = 0)' } },
    { from: SESSIONS + ROUNDS, keys: { a: NO_BAND }, values: { ...startsEnds, ...unended, ...duo } },
    { from: SESSIONS + marks(['fv', 'ct']), keys: { a: NO_BAND }, values: { ...hearts,
      timer_sessions: "COUNT(DISTINCT CASE WHEN k.kind = 'ct' AND k.x LIKE 's:%' THEN k.sid END)" } }
  ],
  r_game_day: [
    { from: SESSIONS + VISITS, keys: { a: NO_BAND, slug: 'v.slug' }, values: {
      sessions: 'COUNT(DISTINCT v.sid)', ...visitTime, closes: 'TOTAL(v.closed)', ...health,
      ...Object.fromEntries(ERRORS.map(kind => ['error_' + kind, `TOTAL(v.err = '${kind}')`])),
      ...Object.fromEntries(SOURCES.map(src => ['src_' + src, `TOTAL(v.src = '${src}')`])), ...each(PLAYS, (c, i) => `TOTAL(v.plays_b = ${i})`),
      fav_opens: 'TOTAL(v.fav = 1)' } },
    { from: SESSIONS + ROUNDS, keys: { a: NO_BAND, slug: 'r.slug' }, values: {
      ...startsEnds, ...outcomes, ...tiers, ...accuracy, ...each(RT, c => `TOTAL(r.${c})`), ...each(REPLAY, (c, i) => `TOTAL(${replayBucket} = ${i})`),
      wall_s: 'ROUND(TOTAL(r.wall_ms) / 1000)', inputs: 'TOTAL(r.inputs)', idle: 'TOTAL(r.idle)', pauses: 'TOTAL(r.pauses)', ...reaction,
      ...dda, ...scores, score_max: 'MAX(r.score)', ...unended, ...duo } },
    { from: SESSIONS + marks(['fv', 'tu']) + VISIT_MARK, keys: { a: NO_BAND, slug: 'v.slug' }, values: { ...hearts,
      tu_start: "TOTAL(k.kind = 'tu' AND k.x = 's')", tu_done: "TOTAL(k.kind = 'tu' AND k.x = 'd')" } }
  ],
  r_level_day: [
    { from: SESSIONS + ROUNDS, keys: { a: NO_BAND, slug: 'r.slug', id: 'r.id' }, values: {
      sessions: 'COUNT(DISTINCT r.sid)', ...startsEnds, ...outcomes, ms: 'TOTAL(r.ms)', ...tiers, ...unended,
      ...accuracy, ...scores, score_max: 'MAX(r.score)', wall_ms: 'TOTAL(r.wall_ms)', ...dda } }
  ],
  r_source_day: [
    { from: SESSIONS + VISITS, where: ' AND v.src IS NOT NULL', keys: { a: NO_BAND, src: 'v.src' }, values: { sessions: 'COUNT(DISTINCT v.sid)', opens: 'COUNT(*)' } }
  ],
  r_device_day: [
    { from: SESSIONS, keys: { a: NO_BAND, cores: 's.cores', mem: 's.mem', screen: 's.screen' }, values: { sessions: 'COUNT(*)' } },
    { from: SESSIONS + VISITS, keys: { a: NO_BAND, cores: 's.cores', mem: 's.mem', screen: 's.screen' }, values: health }
  ],
  r_pc_day: [
    { from: SESSIONS, keys: { p: 's.p' }, values: { k: firstOf('MAX', 's.k'), sessions: 'COUNT(*)', busy_s: `TOTAL(${LAST_T})`,
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
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
// A session's engaged time: the sum of its visits'.
const ENGAGED = '(SELECT TOTAL(x.engaged_ms) FROM st_visits x WHERE x.sid = s.id)';
// The wire version of a session's PC ('2': the old portal), the k2 of sesslen.
export const WIRE_KIND = "CASE WHEN s.wire = 2 THEN '2' ELSE '3' END";
const SOLO = ' AND r.code IS NOT NULL AND r.duo = 0';
// Losses in a row just before round r in its visit: the lost rounds after its last earlier round that was not a loss.
const LOSSES = "(SELECT COUNT(*) FROM st_rounds p WHERE p.sid = r.sid AND p.n = r.n AND p.k < r.k AND p.code = 'l' AND p.k > " +
  "IFNULL((SELECT MAX(o.k) FROM st_rounds o WHERE o.sid = r.sid AND o.n = r.n AND o.k < r.k AND (o.code IS NULL OR o.code <> 'l')), 0))";
const tutorialMark = x => `EXISTS (SELECT 1 FROM st_marks t WHERE t.sid = v.sid AND t.kind = 'tu' AND t.n = v.n AND t.x = '${x}')`;

// The r_stat metrics as parts: what they read (with the scope's sessions), and the key
// (slug, k1, k2) and sums of their rows; a part may read a derived table x, with its own day.
function statParts(scope) {
  const R = SESSIONS + ROUNDS, V = SESSIONS + VISITS, range = within(scope);
  const sessionRows = extra => `(SELECT ${scope.day} AS day, ${extra} FROM ${SESSIONS} WHERE ${range}) x`;
  return [
    { metric: 'hour', from: V, where: ' AND v.t_open IS NOT NULL', slug: "''", k1: hourOf(scope, 's.start_s + v.t_open'),
      k2: weekdayOf(scope, 's.start_s + v.t_open'), values: { n: 'COUNT(*)', ms: 'TOTAL(v.engaged_ms)' } },
    { metric: 'rhour', from: R, where: ' AND r.t0 IS NOT NULL', slug: "''", k1: hourOf(scope, 's.start_s + r.t0'),
      k2: weekdayOf(scope, 's.start_s + r.t0'), values: { n: 'COUNT(*)', ...pick(outcomes, ['w', 'l', 'q']), ...accuracy, ...reaction } },
    { metric: 'sesslen', derived: sessionRows(`${WIRE_KIND} AS kind, ${ENGAGED} AS m`), slug: "''", k1: bucket('x.m', BUCKETS.sesslen, 60000),
      k2: 'x.kind', values: { n: 'COUNT(*)', ms: 'TOTAL(x.m)' } },
    { metric: 'games', derived: sessionRows('(SELECT COUNT(DISTINCT y.slug) FROM st_visits y WHERE y.sid = s.id AND y.t_open IS NOT NULL) AS g'),
      where: ' WHERE x.g > 0', slug: "''", k1: "CASE WHEN x.g >= 8 THEN '8' WHEN x.g >= 6 THEN '6' ELSE CAST(x.g AS TEXT) END", k2: "''",
      values: { n: 'COUNT(*)' } },
    { metric: 'visitlen', from: V, slug: 'v.slug', k1: bucket('v.engaged_ms', BUCKETS.visitlen, 1000),
      k2: "CASE WHEN EXISTS (SELECT 1 FROM st_rounds y WHERE y.sid = v.sid AND y.n = v.n AND y.code IS NOT NULL) THEN '1' ELSE '0' END",
      values: { n: 'COUNT(*)', ms: 'TOTAL(v.engaged_ms)' } },
    // Into each visit from the one before ('' at the session's start), and out of a visit with no next one.
    { metric: 'flow', from: V + ' LEFT JOIN st_visits pv ON pv.sid = v.sid AND pv.n = v.n - 1', slug: "IFNULL(pv.slug, '')", k1: 'v.slug', k2: "''",
      values: { n: 'COUNT(*)', gap_sum: 'TOTAL(CASE WHEN pv.t_close IS NOT NULL AND v.t_open IS NOT NULL THEN MAX(v.t_open - pv.t_close, 0) END)',
        gap_n: 'TOTAL(pv.t_close IS NOT NULL AND v.t_open IS NOT NULL)' } },
    { metric: 'flow', from: V, where: ' AND NOT EXISTS (SELECT 1 FROM st_visits nx WHERE nx.sid = v.sid AND nx.n = v.n + 1)', slug: 'v.slug', k1: "''", k2: "''",
      values: { n: 'COUNT(*)' } },
    { metric: 'persist', from: R + ' LEFT JOIN st_rounds nx ON nx.sid = r.sid AND nx.n = r.n AND nx.k = r.k + 1', where: SOLO, slug: 'r.slug', k1: 'r.code',
      k2: "CASE WHEN nx.k IS NOT NULL THEN CASE WHEN nx.id = r.id THEN 'same' ELSE 'level' END " +
        "WHEN EXISTS (SELECT 1 FROM st_visits y WHERE y.sid = r.sid AND y.n > r.n) THEN 'game' ELSE 'stop' END",
      values: { n: 'COUNT(*)', gap_sum: 'TOTAL(CASE WHEN nx.t0 IS NOT NULL THEN MAX(nx.t0 - r.t, 0) END)', gap_n: 'COUNT(nx.t0)' } },
    { metric: 'fatigue', from: R, where: SOLO, slug: 'r.slug', k1: bucket('IFNULL(r.t0, r.t)', BUCKETS.fatigue, 60), k2: "''",
      values: { n: 'COUNT(*)', ...pick(outcomes, ['w', 'l', 'q']), ...accuracy, ...reaction, inputs: 'TOTAL(r.inputs)', ms: 'TOTAL(r.ms)' } },
    { metric: 'qrun', from: R, where: SOLO + " AND (r.code = 'q' OR NOT EXISTS (SELECT 1 FROM st_rounds y WHERE y.sid = r.sid AND y.n = r.n AND y.k > r.k))",
      slug: 'r.slug', k1: `CAST(MIN(${LOSSES}, 5) AS TEXT)`, k2: "CASE WHEN r.code = 'q' THEN 'q' ELSE 'x' END", values: { n: 'COUNT(*)' } },
    { metric: 'tier', from: R, where: ' AND r.code IS NOT NULL AND r.tier0 > 0', slug: 'r.slug', k1: 'CAST(r.tier0 AS TEXT)', k2: "''",
      values: { n: 'COUNT(*)', ...pick(outcomes, ['w', 'l', 'q']), ms: 'TOTAL(r.ms)', win_ms: "TOTAL(CASE WHEN r.code = 'w' THEN r.ms END)" } },
    { metric: 'tutorial', from: V, slug: 'v.slug',
      k1: `CASE WHEN ${tutorialMark('d')} THEN 'done' WHEN ${tutorialMark('s')} THEN 'start' ELSE 'none' END`,
      k2: "IFNULL((SELECT y.code FROM st_rounds y WHERE y.sid = v.sid AND y.n = v.n AND y.code IS NOT NULL ORDER BY y.k LIMIT 1), '')",
      values: { n: 'COUNT(*)' } }
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
    `SELECT ${derived ? 'x.day' : scope.day} AS day, ${NO_BAND} AS a, '${metric}' AS metric, ${slug} AS slug, ${k1} AS k1, ${k2} AS k2, ` +
    sums.map(c => `${values[c] ?? 0} AS ${c}`).join(', ') +
    (derived ? ` FROM ${derived}${where}` : ` FROM ${from} WHERE ${within(scope)}${where}`) + ' GROUP BY 1, 2, 3, 4, 5, 6'));
}

// The rollups whose rows can lose every fact behind them (r_stat when late data moves a
// visit into another bucket or gives a round a next one, any of them on a day schema 4
// rolled, whose rows of an age band the facts no longer give). A row of theirs always has
// a count of at least 1 when it has facts, so a row whose values are all zero has none.
const PRUNED = new Set(ROLLUP_TABLES);

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

/* ---------------------------------------------- clearing schema 4's rows */
// sesslen's k2 as schema 5 writes it: schema 4 told students (s) and guests (g) apart, and
// the old portal (u); schema 5 only the wire version ('3', '2'). Reads of r_stat give
// k2 through this, so a day not cleared yet answers as one cleared.
export const statK2 = alias => `CASE WHEN ${alias}.metric = 'sesslen' THEN CASE WHEN ${alias}.k2 IN ('u', '2') THEN '2' ELSE '3' END ELSE ${alias}.k2 END`;
const AGGREGATE = { sum: 'SUM', max: 'MAX', min: 'MIN' };
// One table's rows of the days ?1..?2 as schema 5 writes them: the rows of every age band
// added into the row of a = '' (sums added, the largest and smallest kept), the counts per
// student, guest or profile (cleared) set to 0, and in r_stat the rows of the metrics
// schema 5 dropped left out and sesslen's k2 made the wire version. An upsert (SQLite reads
// a SELECT of the table it writes to whole, before it writes) and the delete of the rows it
// replaced; for a table without a, the counts set to 0. Running them again changes nothing.
function clearTable(table, keys, values, cleared) {
  if (!keys.includes('a')) {
    return cleared.length ? [`UPDATE ${table} SET ${cleared.map(c => `${c} = 0`).join(', ')} WHERE day BETWEEN ?1 AND ?2 AND (${cleared.map(c => `${c} <> 0`).join(' OR ')})`] : [];
  }
  const stat = table === 'r_stat', key = c => c === 'a' ? "'' AS a" : stat && c === 'k2' ? `${statK2(table)} AS k2` : c;
  const dropped = stat ? ` AND metric NOT IN (${DROPPED_METRICS.map(m => `'${m}'`).join(', ')})` : '';
  const select = `SELECT ${keys.map(key).join(', ')}, ${values.map(c => `${AGGREGATE[combine(c)]}(${c}) AS ${c}`).join(', ')}` +
    `${cleared.map(c => `, 0 AS ${c}`).join('')} FROM ${table} WHERE day BETWEEN ?1 AND ?2${dropped} GROUP BY ${positions(keys.length)}`;
  const all = [...values, ...cleared];
  const upsert = `INSERT INTO ${table} (${[...keys, ...all].join(', ')}) SELECT * FROM (${select}) WHERE true ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ` +
    all.map(c => `${c} = excluded.${c}`).join(', ') + ` WHERE (${all.join(', ')}) IS NOT (${all.map(c => 'excluded.' + c).join(', ')})`;
  const rest = stat ? ` OR metric IN (${DROPPED_METRICS.map(m => `'${m}'`).join(', ')}) OR metric = 'sesslen' AND k2 NOT IN ('2', '3')` : '';
  return [upsert, `DELETE FROM ${table} WHERE day BETWEEN ?1 AND ?2 AND (a <> ''${rest})`];
}
// The statements that clear the days ?1..?2 of every rollup, and with frozen of
// milestone 2's frozen aggregates (only on a database that has them).
export function clearStatements({ frozen = false } = {}) {
  const rollups = ROLLUP_TABLES.flatMap(table => clearTable(table, keysOf(table), valuesOf(table), ROLLUPS[table].cleared || []));
  const aggregates = frozen ? Object.entries(TABLES).flatMap(([table, { key, sums, cleared = [] }]) => clearTable(table, ['day', 'a', ...key], sums, cleared)) : [];
  return [...rollups, ...aggregates];
}
