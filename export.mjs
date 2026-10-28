// The research export (docs/RESEARCH_TELEMETRY_SPEC.md, §F.6): GET /v1/admin/export?file=
// &from&to[&after] answers one page of a CSV file, at most 2,500 lines without a header (the
// dashboard writes the header from its data dictionary, whose columns must equal COLUMNS),
// with the cursor of the next page. Every line is built in SQL; JavaScript only joins them.
// No value ever needs quoting: each one is a number, an ISO date, a school-clock time or a
// token the ingest validated (codes, slugs, round ids, bands, build hashes, zone names,
// enumerations), none of which can hold a comma, a quote or a line break. Pages follow a
// key, never an offset, so each row is read once: sessions in order of their start (400
// sessions a page); their visits, rounds and marks in the same order, resuming inside a
// session; students and PCs by code; the daily files by day, a few weeks at a time. Times
// are the school's clock; empty means unknown (−1 never appears). Pure apart from the
// store context it is given (store.mjs).
import { rollupSelect } from './rollups.mjs';
import { U_RE } from './schema.mjs';

// A page is at most this many lines (a rounds page is then about 400 KB): the Worker reads it
// as one string within a few milliseconds.
export const PAGE_LINES = 2500;
export const PAGE_SESSIONS = 400;
// How many days a page of the daily files looks at, at most (a busy day has about 300
// student-days and 140 game rows).
const WINDOW_DAYS = { student_days: 14, daily_games: 30 };
const DAY_MS = 86400000;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => utcDay(Date.parse(day + 'T00:00:00Z') + n * DAY_MS);

// Values the school's clock gives a UTC second x (L: the wide scope's wall clock).
const dayOf = (L, x) => `date(${L(x)}, 'unixepoch')`;
const timeOf = (L, x) => `strftime('%H:%M:%S', ${L(x)}, 'unixepoch')`;
const weekdayOf = (L, x) => `(CAST(strftime('%w', ${L(x)}, 'unixepoch') AS INTEGER) + 1)`;
const share = (a, b) => `CASE WHEN ${b} > 0 THEN round((${a}) * 1.0 / (${b}), 4) END`;
const whole = x => `CAST(${x} AS INTEGER)`;
const OUTCOME = c => `CASE ${c} WHEN 'w' THEN 'win' WHEN 'l' THEN 'loss' WHEN 'd' THEN 'draw' WHEN 'e' THEN 'end' WHEN 'q' THEN 'quit' END`;
const LINKED = alias => `CASE WHEN ${alias}.u <> '' THEN COALESCE(al.u_new, ${alias}.u) END`;
const RT = ['rt_lt300', 'rt_lt500', 'rt_lt800', 'rt_lt1200', 'rt_lt2000', 'rt_ge2000'];
const IL = ['il_lt8', 'il_lt16', 'il_lt33', 'il_lt50', 'il_lt100', 'il_ge100'];
const FRAMES = ['frames_smooth', 'frames_ok', 'frames_choppy', 'frames_stall'];
const mark = (alias, kind, x) => `EXISTS (SELECT 1 FROM st_marks m WHERE m.sid = ${alias}.sid AND m.kind = '${kind}' AND m.n = ${alias}.n AND m.x = '${x}')`;
const countMarks = (alias, kind, x) => `(SELECT COUNT(*) FROM st_marks m WHERE m.sid = ${alias}.sid AND m.kind = '${kind}' AND m.n = ${alias}.n AND m.x = '${x}')`;
const timer = like => `EXISTS (SELECT 1 FROM st_marks m WHERE m.sid = s.id AND m.kind = 'ct' AND m.x LIKE '${like}')`;

// Each file's columns in their pinned order, with the SQL of each value (L: the clock).
const FIELDS = {
  students: L => [
    ['student', 'x.u'], ['student_label', 'COALESCE(t.label, upper(substr(x.u, 1, 4)))'], ['student_linked', 'COALESCE(al.u_new, x.u)'],
    ['kind', "'profile'"], ['band_first', 't.band_first'], ['band_last', 't.band_last'],
    ['profile_made_day', `date(${L('t.first_s')}, 'unixepoch', '-' || IFNULL(t.age_days_first, 0) || ' days')`],
    ['first_day', dayOf(L, 't.first_s')], ['last_day', dayOf(L, 't.last_s')], ['days_active', 'x.days'], ['sessions', 'x.sessions'],
    ['minutes', 'round(x.ms / 60000.0, 1)'], ['rounds', 'x.rounds'], ['wins', 'x.w'], ['losses', 'x.l'], ['quits', 'x.q'],
    ['games_tried', 'g.games'], ['favourite_game', 'g.top'], ['pcs', '(SELECT COUNT(*) FROM st_student_pcs p WHERE p.u = x.u)'],
    ['known_before', `CASE WHEN t.u IS NOT NULL THEN date(${L('t.first_s')}, 'unixepoch', '-' || IFNULL(t.age_days_first, 0) || ' days') < ${dayOf(L, 't.first_s')} END`],
    ['removed_day', `CASE WHEN t.removed_s >= t.last_s THEN ${dayOf(L, 't.removed_s')} END`]
  ],
  sessions: L => [
    ['session', 's.s'], ['student', 's.u'], ['student_linked', LINKED('s')], ['pc', 's.p'],
    ['kind', "CASE WHEN s.wire = 2 THEN 'unknown' WHEN s.u = '' THEN 'guest' ELSE 'student' END"], ['wire_version', 's.wire'], ['band', 's.a'],
    ['day', dayOf(L, 's.start_s')], ['weekday', weekdayOf(L, 's.start_s')], ['start_time', timeOf(L, 's.start_s')],
    ['minute_of_day', `(CAST(strftime('%H', ${L('s.start_s')}, 'unixepoch') AS INTEGER) * 60 + CAST(strftime('%M', ${L('s.start_s')}, 'unixepoch') AS INTEGER))`],
    ['start_utc', "strftime('%Y-%m-%dT%H:%M:%SZ', s.start_s, 'unixepoch')"], ['clock_source', 's.clock'], ['mode', 's.m'], ['build', 's.k'],
    ['cores', 's.cores'], ['memory_gb', 's.mem'], ['screen', 's.screen'], ['classroom_mode', 's.cls'], ['profiles_on_pc', 's.np'],
    ['new_profile', 's.is_new'], ['profile_age_days', 'CASE WHEN s.age_days >= 0 THEN s.age_days END'],
    ['days_since_last', 'CASE WHEN s.since_days >= 0 THEN s.since_days END'], ['profile_age_bucket', 's.age_b'], ['days_since_last_bucket', 's.since_b'],
    ['level_start', 's.level0'], ['level_ups', "(SELECT COUNT(*) FROM st_marks m WHERE m.sid = s.id AND m.kind = 'lv')"],
    ['games_opened', '(SELECT COUNT(*) FROM st_visits v WHERE v.sid = s.id AND v.t_open IS NOT NULL)'],
    ['rounds', '(SELECT COUNT(*) FROM st_rounds r WHERE r.sid = s.id AND r.code IS NOT NULL)'],
    ['engaged_s', '(SELECT round(TOTAL(v.engaged_ms) / 1000.0, 1) FROM st_visits v WHERE v.sid = s.id)'], ['end_t_s', 's.se_t'],
    ['end_reason', "CASE s.why WHEN 'u' THEN 'unload' WHEN 'p' THEN 'switch' WHEN 'h' THEN 'handover' WHEN 'i' THEN 'idle' END"],
    ['timer_minutes', "(SELECT CAST(substr(m.x, 3) AS INTEGER) FROM st_marks m WHERE m.sid = s.id AND m.kind = 'ct' AND m.x LIKE 's:%' ORDER BY m.t LIMIT 1)"],
    ['timer_ended', `CASE WHEN ${timer('s:%')} THEN ${timer('e:%')} END`]
  ],
  visits: L => {
    const at = 's.start_s + COALESCE(v.t_open, v.t_close, 0)';
    return [
      ['session', 's.s'], ['visit', 'v.n'], ['student', 's.u'], ['student_linked', LINKED('s')], ['band', 's.a'], ['day', dayOf(L, at)],
      ['open_time', `CASE WHEN v.t_open IS NOT NULL THEN ${timeOf(L, 's.start_s + v.t_open')} END`], ['open_s', 'v.t_open'], ['close_s', 'v.t_close'],
      ['open_seconds', 'v.t_close - v.t_open'], ['engaged_s', 'round(v.engaged_ms / 1000.0, 1)'], ['game', 'v.slug'], ['source', 'v.src'],
      ['plays_before', 'v.plays'], ['plays_before_bucket', 'v.plays_b'], ['favourite_at_open', 'v.fav'], ['load_ms', 'v.load_ms'],
      ['error', "CASE v.err WHEN 't' THEN 'timeout' WHEN 'x' THEN 'script' WHEN 'l' THEN 'load' END"],
      ['rounds_started', '(SELECT COUNT(*) FROM st_rounds r WHERE r.sid = v.sid AND r.n = v.n AND r.t0 IS NOT NULL)'],
      ['rounds_ended', '(SELECT COUNT(*) FROM st_rounds r WHERE r.sid = v.sid AND r.n = v.n AND r.code IS NOT NULL)'],
      ['tutorial', `CASE WHEN ${mark('v', 'tu', 'd')} THEN 'done' WHEN ${mark('v', 'tu', 's')} THEN 'start' ELSE 'none' END`],
      ['hearts_on', countMarks('v', 'fv', '1')], ['hearts_off', countMarks('v', 'fv', '0')],
      ...IL.map((c, i) => [c, 'v.il' + i]), ...FRAMES.map((c, i) => [c, 'v.f' + i]), ['closed', 'v.closed'],
      ['previous_game', '(SELECT p.slug FROM st_visits p WHERE p.sid = v.sid AND p.n = v.n - 1)'],
      ['next_game', '(SELECT p.slug FROM st_visits p WHERE p.sid = v.sid AND p.n = v.n + 1)']
    ];
  },
  rounds: L => {
    const at = 's.start_s + COALESCE(r.t0, r.t)';
    return [
      ['session', 's.s'], ['visit', 'r.n'], ['round', 'r.k'], ['student', 's.u'], ['student_linked', LINKED('s')], ['pc', 's.p'], ['band', 's.a'],
      ['day', dayOf(L, at)], ['weekday', weekdayOf(L, at)], ['time', timeOf(L, at)], ['start_s', 'r.t0'],
      ['minutes_into_session', 'round(COALESCE(r.t0, r.t) / 60.0, 1)'], ['game', 'r.slug'], ['level', 'r.id'], ['outcome', OUTCOME('r.code')],
      ['previous_outcome', `(SELECT ${OUTCOME('p.code')} FROM st_rounds p WHERE p.sid = r.sid AND p.n = r.n AND p.k = r.k - 1)`],
      ['two_player', 'r.duo'], ['attempt', 'r.attempt'], ['replay_in_session', 'r.replay'], ['engaged_ms', 'r.ms'], ['wall_ms', 'r.wall_ms'],
      ['score', 'r.score'], ['tier_start', 'r.tier0'], ['tier_end', 'r.tier'], ['dda_level', 'CASE WHEN r.dda >= 0 THEN r.dda END'],
      ['hits', 'r.hits'], ['misses', 'r.misses'], ['accuracy', share('r.hits', 'r.hits + r.misses')], ...RT.map((c, i) => [c, 'r.rt' + i]),
      ['rt_mean_ms', `CASE WHEN r.rt_n > 0 THEN ${whole('round(r.rt_sum * 1.0 / r.rt_n)')} END`], ['rt_n', 'r.rt_n'], ['inputs', 'r.inputs'],
      ['inputs_per_min', 'CASE WHEN r.wall_ms > 0 THEN round(r.inputs * 60000.0 / r.wall_ms, 1) END'], ['idle_lapses', 'r.idle'], ['pauses', 'r.pauses']
    ];
  },
  events: L => [
    ['session', 's.s'], ['student', 's.u'], ['student_linked', LINKED('s')], ['day', dayOf(L, 's.start_s + m.t')], ['time', timeOf(L, 's.start_s + m.t')],
    ['t_s', 'm.t'],
    ['kind', "CASE m.kind WHEN 'lv' THEN 'level_up' WHEN 'fv' THEN CASE m.x WHEN '1' THEN 'heart_on' ELSE 'heart_off' END " +
      "WHEN 'tu' THEN CASE m.x WHEN 's' THEN 'tutorial_start' ELSE 'tutorial_done' END " +
      "WHEN 'ct' THEN CASE substr(m.x, 1, 1) WHEN 's' THEN 'timer_start' WHEN 'c' THEN 'timer_cancel' ELSE 'timer_end' END " +
      "WHEN 'pr' THEN 'profile_removed' WHEN 'cd' THEN 'linked' END"],
    ['game', 'v.slug'],
    ['value', "CASE m.kind WHEN 'lv' THEN m.x WHEN 'ct' THEN CASE WHEN m.x LIKE 's:%' THEN substr(m.x, 3) END WHEN 'pr' THEN m.x WHEN 'cd' THEN m.x END"]
  ],
  student_days: L => [
    ['student', 'x.u'], ['student_linked', 'COALESCE(al.u_new, x.u)'], ['day', 'x.day'], ['weekday', "(CAST(strftime('%w', x.day) AS INTEGER) + 1)"],
    ['band', 'x.a'], ['sessions', whole('x.sessions')], ['minutes', 'round(x.engaged_ms / 60000.0, 1)'], ['opens', whole('x.opens')],
    ['games', whole('x.games')], ['rounds', whole('x.rounds')], ['wins', whole('x.w')], ['losses', whole('x.l')], ['draws', whole('x.d')],
    ['ends', whole('x.e')], ['quits', whole('x.q')], ['hits', whole('x.hits')], ['misses', whole('x.misses')],
    ['rt_mean_ms', `CASE WHEN x.rt_n > 0 THEN ${whole('round(x.rt_sum * 1.0 / x.rt_n)')} END`], ['level_ups', whole('x.level_ups')],
    ['first_time', timeOf(L, 'x.first_s')], ['last_time', timeOf(L, 'x.last_s')], ['pcs', whole('x.pcs')]
  ],
  daily_games: () => [
    ['day', 'x.day'], ['clock', 'x.clock'], ['band', 'x.a'], ['game', 'x.slug'], ['sessions', whole('x.sessions')], ['students', whole('x.students')],
    ['opens', whole('x.opens')], ['minutes', 'round(x.engaged_ms / 60000.0, 1)'], ['starts', whole('x.starts')], ['ends', whole('x.ends')],
    ['wins', whole('x.w')], ['losses', whole('x.l')], ['draws', whole('x.d')], ['ends_neutral', whole('x.e')], ['quits', whole('x.q')],
    ['hearts_on', whole('x.hearts_on')], ['hearts_off', whole('x.hearts_off')],
    ['avg_tier', 'CASE WHEN x.tier_n > 0 THEN round(x.tier_sum * 1.0 / x.tier_n, 2) END'], ['accuracy', share('x.hits', 'x.hits + x.misses')]
  ],
  pcs: L => {
    const frames = 'x.f0 + x.f1 + x.f2 + x.f3', il = 'x.il0 + x.il1 + x.il2 + x.il3 + x.il4 + x.il5';
    return [
      ['pc', 'x.p'], ['pc_label', 'upper(substr(x.p, 1, 4))'], ['first_day', dayOf(L, 'c.first_s')], ['last_day', dayOf(L, 'c.last_s')],
      ['days', 'x.days'], ['time_zone', 'c.z'], ['build', 'c.k'], ['cores', 'c.cores'], ['memory_gb', 'c.mem'], ['screen', 'c.screen'],
      ['sessions', whole('x.sessions')], ['students', 'IFNULL(st.students, 0)'], ['guest_share', share('x.guests', 'x.sessions')],
      ['minutes', 'round(x.engaged_ms / 60000.0, 1)'], ['smooth_share', share('x.f0', frames)], ['stall_share', share('x.f3', frames)],
      ['avg_load_ms', `CASE WHEN x.loads > 0 THEN ${whole('round(x.load_ms * 1.0 / x.loads)')} END`], ['slow_input_share', share('x.il4 + x.il5', il)],
      ['failures', whole('x.errors')], ['profiles_max', whole('x.np_max')], ['new_profiles', whole('x.new_profiles')]
    ];
  }
};
export const FILES = Object.keys(FIELDS);
// The columns of each file, in their pinned order (the dashboard's dictionary.js must list
// the same); the key is also the `file` parameter.
export const COLUMNS = Object.fromEntries(FILES.map(file => [file, FIELDS[file](x => x).map(([column]) => column)]));
// The SQL of a file's line: every value, empty when unknown, joined by commas.
const line = (file, L) => FIELDS[file](L).map(([, value]) => `IFNULL(${value}, '')`).join(" || ',' || ");

// Cursors: the key of the last row a page holds, dot-separated (no value holds a dot).
// The daily files' cursor `day.` (an empty rest) is the start of that day.
const CODE = U_RE.source.slice(1, -1);
const CURSORS = {
  sessions: /^(\d{1,12})\.(\d{1,15})$/,
  visits: /^(\d{1,12})\.(\d{1,15})\.(\d{1,4})$/,
  rounds: /^(\d{1,12})\.(\d{1,15})\.(\d{1,4})\.(\d{1,5})$/,
  events: /^(\d{1,12})\.(\d{1,15})\.([a-z]{2})\.(\d{1,6})\.(\d{1,4})\.([0-9a-z:]{1,16})$/,
  students: new RegExp(`^(${CODE})$`),
  student_days: new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\.(${CODE}|)$`),
  daily_games: /^(\d{4}-\d{2}-\d{2})\.((?:school|utc)?)\.((?:6-7|8-9|10-11)?)\.((?:[a-z0-9]+(?:-[a-z0-9]+)*)?)$/,
  pcs: /^([0-9a-f]{12})$/
};

/* ----------------------------------------------------- the page statements */
// Files of the sessions in the UTC seconds [?1, ?2): sessions after the cursor (?3, ?4) in
// order of their start and id, and the rows of each in key order after the cursor's row
// (?5...) inside the cursor's own session. A CASE, not an OR, so that SQLite walks the
// st_sessions_time index in order and stops at the page's end.
const AFTER = rest => `CASE WHEN s.start_s > ?3 OR s.id > ?4 THEN 1 WHEN s.id = ?4 THEN ${rest} ELSE 0 END`;
const FROM_SESSIONS = 'FROM st_sessions s LEFT JOIN aliases al ON al.u_old = s.u';
const RANGE = 's.start_s >= ?1 AND s.start_s < ?2';
const SESSION_PAGES = {
  sessions: L => `SELECT ${line('sessions', L)} AS l, s.start_s AS k1, s.id AS k2 ${FROM_SESSIONS} WHERE ${RANGE} AND ${AFTER('0')} ` +
    'ORDER BY s.start_s, s.id LIMIT ?5',
  visits: L => `SELECT ${line('visits', L)} AS l, s.start_s AS k1, s.id AS k2, v.n AS k3 ${FROM_SESSIONS} JOIN st_visits v ON v.sid = s.id ` +
    `WHERE ${RANGE} AND ${AFTER('v.n > ?5')} ORDER BY s.start_s, s.id, v.n LIMIT ?6`,
  rounds: L => `SELECT ${line('rounds', L)} AS l, s.start_s AS k1, s.id AS k2, r.n AS k3, r.k AS k4 ${FROM_SESSIONS} JOIN st_rounds r ON r.sid = s.id ` +
    `WHERE ${RANGE} AND ${AFTER('(r.n, r.k) > (?5, ?6)')} ORDER BY s.start_s, s.id, r.n, r.k LIMIT ?7`,
  events: L => `SELECT ${line('events', L)} AS l, s.start_s AS k1, s.id AS k2, m.kind AS k3, m.t AS k4, m.n AS k5, m.x AS k6 ` +
    `${FROM_SESSIONS} JOIN st_marks m ON m.sid = s.id LEFT JOIN st_visits v ON v.sid = m.sid AND v.n = m.n ` +
    `WHERE ${RANGE} AND ${AFTER('(m.kind, m.t, m.n, m.x) > (?5, ?6, ?7, ?8)')} ORDER BY s.start_s, s.id, m.kind, m.t, m.n, m.x LIMIT ?9`
};
// A rollup's rows of the rolled days ?1..?2 and, when there are open days, its SELECT over
// the facts of the UTC seconds [?3, ?4).
const rolledAndOpen = (table, columns, scope) => `SELECT ${columns} FROM ${table} WHERE day BETWEEN ?1 AND ?2` +
  (scope ? ` UNION ALL SELECT ${columns} FROM (${rollupSelect(table, { ...scope, lo: '?3', hi: '?4' })})` : '');
// Students with play in the period, by code after ?5: their days, sessions, minutes and
// rounds, and the games they tried with the one they played most (ties: the first slug).
const STUDENTS_PAGE = (L, scope) => `WITH d AS (${rolledAndOpen('r_student_day', 'u, day, sessions, engaged_ms, rounds, w, l, q', scope)}), ` +
  'x AS (SELECT u, COUNT(DISTINCT day) AS days, CAST(TOTAL(sessions) AS INTEGER) AS sessions, TOTAL(engaged_ms) AS ms, ' +
  'CAST(TOTAL(rounds) AS INTEGER) AS rounds, CAST(TOTAL(w) AS INTEGER) AS w, CAST(TOTAL(l) AS INTEGER) AS l, CAST(TOTAL(q) AS INTEGER) AS q ' +
  'FROM d WHERE u > ?5 GROUP BY u), ' +
  `gd AS (${rolledAndOpen('r_student_game', 'u, slug, engaged_ms', scope)}), ` +
  "g AS (SELECT u, COUNT(*) AS games, substr(MIN(printf('%015d', 999999999999999 - CAST(ms AS INTEGER)) || slug), 16) AS top " +
  'FROM (SELECT u, slug, TOTAL(engaged_ms) AS ms FROM gd WHERE u > ?5 GROUP BY u, slug) GROUP BY u) ' +
  `SELECT ${line('students', L)} AS l, x.u AS k1 FROM x LEFT JOIN st_students t ON t.u = x.u LEFT JOIN aliases al ON al.u_old = x.u ` +
  'LEFT JOIN g ON g.u = x.u ORDER BY x.u LIMIT ?6';
const STUDENT_DAY_COLUMNS = 'u, day, a, sessions, engaged_ms, opens, games, rounds, w, l, d, e, q, hits, misses, rt_sum, rt_n, level_ups, first_s, last_s, pcs';
const STUDENT_DAYS_PAGE = (L, scope) => `SELECT ${line('student_days', L)} AS l, x.day AS k1, x.u AS k2 FROM ` +
  `(${rolledAndOpen('r_student_day', STUDENT_DAY_COLUMNS, scope)}) x LEFT JOIN aliases al ON al.u_old = x.u ` +
  'WHERE (x.day, x.u) > (?5, ?6) ORDER BY x.day, x.u LIMIT ?7';
// Days × band × game: milestone 2's frozen UTC receipt days (?8..?9; no student or heart
// counts), then the school's rolled and open days.
const GAME_DAY_COLUMNS = (clock, frozen) => `day, '${clock}' AS clock, a, slug, sessions, ${frozen ? 'NULL' : 'students'} AS students, opens, engaged_ms, ` +
  `starts, ends, w, l, d, e, q, ${frozen ? 'NULL' : 'hearts_on'} AS hearts_on, ${frozen ? 'NULL' : 'hearts_off'} AS hearts_off, tier_sum, tier_n, hits, misses`;
const DAILY_GAMES_PAGE = (scope, legacy) => `SELECT ${line('daily_games')} AS l, x.day AS k1, x.clock AS k2, x.a AS k3, x.slug AS k4 FROM (` +
  (legacy ? `SELECT ${GAME_DAY_COLUMNS('utc', true)} FROM agg_games WHERE day BETWEEN ?8 AND ?9 UNION ALL ` : '') +
  `${rolledAndOpen('r_game_day', GAME_DAY_COLUMNS('school', false), scope)}) x ` +
  'WHERE (x.day, x.clock, x.a, x.slug) > (?5, ?6, ?7, ?10) ORDER BY x.day, x.clock, x.a, x.slug LIMIT ?11';
// PCs with a code and play in the period, by code after ?5, with their own row and their
// distinct students (from the facts of the UTC seconds [?7, ?8)).
const PC_DAY_SUMS = ['sessions', 'guests', 'engaged_ms', 'loads', 'load_ms', 'errors', 'new_profiles', 'f0', 'f1', 'f2', 'f3', 'il0', 'il1', 'il2', 'il3', 'il4', 'il5'];
const PCS_PAGE = (L, scope) => `WITH d AS (${rolledAndOpen('r_pc_day', ['p', 'np_max', ...PC_DAY_SUMS].join(', '), scope)}), ` +
  `x AS (SELECT p, COUNT(*) AS days, ${PC_DAY_SUMS.map(c => `TOTAL(${c}) AS ${c}`).join(', ')}, MAX(np_max) AS np_max FROM d ` +
  "WHERE p <> '' AND p > ?5 GROUP BY p), " +
  "st AS (SELECT s.p AS p, COUNT(DISTINCT COALESCE(al.u_new, s.u)) AS students FROM st_sessions s LEFT JOIN aliases al ON al.u_old = s.u " +
  "WHERE s.start_s >= ?7 AND s.start_s < ?8 AND s.u <> '' AND s.p > ?5 GROUP BY 1) " +
  `SELECT ${line('pcs', L)} AS l, x.p AS k1 FROM x LEFT JOIN st_pcs c ON c.p = x.p LEFT JOIN st ON st.p = x.p ORDER BY x.p LIMIT ?6`;

// A page's statement (its rows: a line l and the key columns, at most size + 1 of them, in
// order), as one row: the first `size` lines, each ending in a line break, how many rows
// there were, and the key of row `size` (a JSON array), so that the Worker reads one string
// it sends as it is, not an object per line. size is a whole number this module chose.
const KEYS = { sessions: 2, visits: 3, rounds: 4, events: 6, students: 1, student_days: 2, daily_games: 4, pcs: 1 };
const paged = (file, text, size) => `WITH page AS MATERIALIZED (${text}) SELECT ` +
  `(SELECT group_concat(l, char(10)) || char(10) FROM (SELECT l FROM page LIMIT ${size})) AS text, (SELECT COUNT(*) FROM page) AS n, ` +
  `(SELECT json_array(${Array.from({ length: KEYS[file] }, (_, i) => 'k' + (i + 1)).join(', ')}) FROM page LIMIT 1 OFFSET ${size - 1}) AS last`;

// One page of a file: { text, rows, next } (its lines, each ending in a line break; how
// many; and the cursor of the next page, or null), or { error, status } for a cursor that
// is not this file's. ctx: the store's helpers; limits: { lines, sessions } (tests make pages small).
export async function exportPage(ctx, { file, from, to, after = null }, now, limits = {}) {
  const pageLines = limits.lines || PAGE_LINES, pageSessions = limits.sessions || PAGE_SESSIONS;
  await ctx.ensure(now);
  const cursor = after === null ? null : CURSORS[file].exec(after);
  if (after !== null && !cursor) return { error: 'after', status: 400 };
  const conf = ctx.conf(), L = ctx.wide(now).local, lo = ctx.bounds(from).lo, hi = ctx.bounds(to).hi;
  const int = (i, fallback) => cursor ? Number(cursor[i]) : fallback;
  let text, values, size, end = null;
  if (SESSION_PAGES[file]) {
    // From the cursor's session on (the index range starts there).
    const rest = { sessions: [], visits: [int(3, 0)], rounds: [int(3, 0), int(4, 0)], events: cursor ? [cursor[3], int(4), int(5), cursor[6]] : ['', 0, 0, ''] }[file];
    size = file === 'sessions' ? pageSessions : pageLines;
    text = SESSION_PAGES[file](L);
    values = [Math.max(lo, int(1, lo)), hi, int(1, lo - 1), int(2, 0), ...rest, size + 1];
  } else {
    size = pageLines;
    // The daily files look at a window of days from the cursor's day; the others at the period.
    const start = cursor && WINDOW_DAYS[file] && cursor[1] > from ? cursor[1] : from;
    end = WINDOW_DAYS[file] ? [addDays(start, WINDOW_DAYS[file] - 1), to].sort()[0] : to;
    const span = ctx.spans(start, end, now), scope = span.open ? span.scope : null;
    const days = [...(span.rolled || ['1', '0']), ...(span.bounds || [0, 0])];
    if (file === 'students') [text, values] = [STUDENTS_PAGE(L, scope), [...days, cursor ? cursor[1] : '', size + 1]];
    else if (file === 'pcs') [text, values] = [PCS_PAGE(L, scope), [...days, cursor ? cursor[1] : '', size + 1, lo, hi]];
    else if (file === 'student_days') [text, values] = [STUDENT_DAYS_PAGE(L, scope), [...days, cursor ? cursor[1] : '', cursor ? cursor[2] : '', size + 1]];
    else {
      const legacy = conf.legacyUntil && start <= conf.legacyUntil ? [start, conf.legacyUntil < end ? conf.legacyUntil : end] : null;
      text = DAILY_GAMES_PAGE(scope, !!conf.legacyUntil);
      values = [...days, cursor ? cursor[1] : '', cursor ? cursor[2] : '', cursor ? cursor[3] : '', ...(legacy || ['1', '0']), cursor ? cursor[4] : '', size + 1];
    }
  }
  const [result] = await ctx.run([ctx.bound(paged(file, text, size), values)], now, { exported: true });
  const { text: lines, n, last } = result.results[0], rows = Math.min(n, size), out = { text: lines ?? '', rows };
  // A full page goes on after its last row; a daily file's window, at the next day.
  if (n > size) return { ...out, next: JSON.parse(last).join('.') };
  return { ...out, next: WINDOW_DAYS[file] && end < to ? addDays(end, 1) + '.' + (file === 'daily_games' ? '..' : '') : null };
}
