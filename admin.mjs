// The admin API's research reads and the owner's actions (docs/RESEARCH_TELEMETRY_SPEC.md,
// §F.4): the students, one student's page, one game's page, the r_stat metrics, retention
// cohorts and the PCs; and forgetting a student, linking and unlinking codes, and
// recounting every day. Each read takes the rolled days from the rollups and the
// days not rolled yet from the facts, through the rollups' own SELECT, as the KPIs do; the
// part of the rolled days is kept per rollup version (rv), the open part per 10-minute slot
// on Workers (store.mjs keeps them). Lists that only the facts hold (a student's recent
// rounds and sessions, tries before a first win, students per PC) are read by index from
// the facts and kept with the open part, or with the closed part when the period has no
// open day. A code counts as its canonical code (an older code linked to a newer one
// counts as the newer one), in SQL through the aliases table. Every answer takes at most 20
// statements, and JavaScript only merges small rows per student, day or game. Pure apart
// from the store context it is given (adminViews(ctx)).
import { METRICS, METRIC_SUMS, ROLLUPS, jsonObject, rollupSelect } from './rollups.mjs';
import { CODES } from './schema.mjs';

const DAY_MS = 86400000;
const ALL_BANDS = ['6-7', '8-9', '10-11', ''];
const bandName = a => a === '' ? 'unknown' : a;
// A student page lists at most this many recent rounds and sessions.
const RECENT_ROUNDS = 600, RECENT_SESSIONS = 100;
// A PC is choppy under 80% smooth frames (as the dashboard's insights say).
const CHOPPY = 0.8;
// A PC is full at 24 profiles (js/profiles.js MAX).
const FULL = 24;

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => utcDay(Date.parse(day + 'T00:00:00Z') + n * DAY_MS);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
const dayList = (from, to) => Array.from({ length: Math.max(0, daysBetween(from, to)) }, (_, i) => addDays(from, i));
// The first day of the school week that holds `day` (ws: 0 Sunday, 1 Monday).
const weekOf = (day, ws) => addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() - ws + 7) % 7));
const round = (x, digits) => { const f = 10 ** digits; return Math.round(x * f) / f; };
const ratio = (a, b) => b ? round(a / b, 4) : null;
const mean = (sum, n, digits) => n ? round(sum / n, digits) : null;
const minutes = ms => round(ms / 60000, 1);
const natural = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const numeric = new Intl.Collator('en', { numeric: true }).compare;
const json = value => JSON.stringify(value);
// Quantile p of sorted numbers, linear between the two nearest ranks (as R and NumPy).
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, below = Math.floor(h), above = Math.min(below + 1, sorted.length - 1);
  return round(sorted[below] + (h - below) * (sorted[above] - sorted[below]), 1);
}

/* ------------------------------------------------------------ the SQL */
// Codes as their canonical code, through the links.
const CANON = alias => `COALESCE(al.u_new, ${alias}.u)`;
const LINKS = alias => ` LEFT JOIN aliases al ON al.u_old = ${alias}.u`;
const IN_JSON = n => `(SELECT value FROM json_each(?${n}))`;
// Where a read finds a rollup's rows: the rolled days ?1..?2 of its table (or the days of the
// JSON list ?1, so that a key after the day is found by seeking), or over the days not rolled
// yet (the UTC seconds [?1, ?2)) the rollup's own SELECT over the facts.
const source = (table, alias, scope, list = false) => scope
  ? { from: `(${rollupSelect(table, scope)}) ${alias}`, days: 'true' }
  : { from: `${table} ${alias}`, days: list ? `${alias}.day IN ${IN_JSON(1)}` : `${alias}.day BETWEEN ?1 AND ?2` };
const sums = (alias, columns) => columns.map(c => `TOTAL(${alias}.${c}) AS ${c}`).join(', ');

// Students: per canonical code, the days played, sessions, engaged ms, rounds ended, wins,
// losses and quits from day ?5 on, and the engaged ms of each of the 13 school weeks from ?4;
// band ?3. And the engaged ms per game from day ?5 on. Each is one JSON text: [[c, days,
// sessions, engaged ms, rounds, w, l, q, w0, ..., w12], ...] and [[c, [[slug, ms], ...]], ...].
// Over the rolled days ?1..?2, or the facts of the UTC seconds [?1, ?2) (src).
const STUDENT_COUNTS = ['sessions', 'engaged_ms', 'rounds', 'w', 'l', 'q'];
const WEEK = 'CAST((julianday(d.day) - julianday(?4)) / 7 AS INTEGER)';
const STUDENT_WEEKS = src => 'SELECT json_group_array(json_array(c, days, ' + STUDENT_COUNTS.join(', ') +
  Array.from({ length: 13 }, (_, i) => ', w' + i).join('') + ')) AS part FROM (' +
  `SELECT ${CANON('d')} AS c, COUNT(DISTINCT CASE WHEN d.day >= ?5 THEN d.day END) AS days, ` +
  STUDENT_COUNTS.map(c => `TOTAL(CASE WHEN d.day >= ?5 THEN d.${c} END) AS ${c}`).join(', ') +
  Array.from({ length: 13 }, (_, i) => `, TOTAL(CASE WHEN d.day >= ?4 AND ${WEEK} = ${i} THEN d.engaged_ms END) AS w${i}`).join('') +
  ` FROM ${src.from}${LINKS('d')} WHERE ${src.days} AND (?3 IS NULL OR d.a = ?3) GROUP BY 1)`;
const STUDENT_GAMES = src => 'SELECT json_group_array(json_array(c, json(list))) AS part FROM (SELECT c, json_group_array(json_array(slug, ms)) AS list ' +
  `FROM (SELECT ${CANON('g')} AS c, g.slug AS slug, TOTAL(g.engaged_ms) AS ms FROM ${src.from}${LINKS('g')} ` +
  `WHERE ${src.days} AND g.day >= ?5 AND (?3 IS NULL OR g.a = ?3) GROUP BY 1, 2) GROUP BY c)`;
// The closed part, made and kept in kpi_cache by SQL (key ?6, rv ?7) unless it is kept
// already: it never passes through the Worker.
const STUDENTS_CLOSED = `INSERT INTO kpi_cache (key, made, rows) SELECT ?6, ?7, json_object('weeks', json((${STUDENT_WEEKS(source('r_student_day', 'd', null))})), ` +
  `'games', json((${STUDENT_GAMES(source('r_student_game', 'g', null))}))) WHERE NOT EXISTS (SELECT 1 FROM kpi_cache WHERE key = ?6)`;
// A students answer holds at most this many bytes of students (?10; D1 refuses a value over
// 2 MB); the rest are on the next page.
export const STUDENTS_PAGE_BYTES = 1500000;
// The students answer itself, as one JSON text (so JavaScript neither parses nor builds it),
// from the closed part (kept under ?6) and the open part (the facts of [?1, ?2) of `scope`,
// made here): both added up per student, with their games and top 3 by minutes (ties: the
// first slug), their links, and who they are from their codes' rows (as GROUPS_INFO,
// below), from the code after ?8 on, as many as STUDENTS_PAGE_BYTES hold, with the last of
// them as next when more are left (else null). kind is always 'profile': every student code is made for a profile on a PC.
const WEEK_COLUMNS = ['days', ...STUDENT_COUNTS, ...Array.from({ length: 13 }, (_, i) => 'w' + i)];
const STUDENTS_ANSWER = (L, scope) => {
  const kept = path => `json_each((SELECT rows FROM kpi_cache WHERE key = ?6), '${path}')`;
  const made = table => scope ? `json_each((${(table === 'r_student_day' ? STUDENT_WEEKS : STUDENT_GAMES)(source(table, table === 'r_student_day' ? 'd' : 'g', scope))}))` : null;
  const weeks = from => `SELECT value ->> 0 AS c, ${WEEK_COLUMNS.map((col, i) => `value ->> ${i + 1} AS ${col}`).join(', ')} FROM ${from}`;
  const games = from => `SELECT x.value ->> 0 AS c, y.value ->> 0 AS slug, y.value ->> 1 AS ms FROM ${from} x, json_each(x.value -> 1) y`;
  const both = (part, closed, open) => [part(closed), ...(open ? [part(open)] : [])].join(' UNION ALL ');
  const band = col => `CASE ${col} WHEN '' THEN 'unknown' ELSE ${col} END`;
  return `WITH s AS (SELECT c, ${WEEK_COLUMNS.map(col => `TOTAL(${col}) AS ${col}`).join(', ')} FROM (${both(weeks, kept('$.weeks'), made('r_student_day'))}) ` +
    'WHERE c > ?8 GROUP BY c HAVING TOTAL(days) > 0), ' +
    `gs AS (SELECT c, slug, TOTAL(ms) AS ms FROM (${both(games, kept('$.games'), made('r_student_game'))}) WHERE c IN (SELECT c FROM s) GROUP BY c, slug), ` +
    'tops AS (SELECT c, json_group_array(slug) AS top FROM (SELECT c, slug, ROW_NUMBER() OVER (PARTITION BY c ORDER BY ms DESC, slug) AS rk FROM gs) ' +
    'WHERE rk <= 3 GROUP BY c), played AS (SELECT c, COUNT(*) AS n FROM gs GROUP BY c), ' +
    'codes AS (SELECT c, c AS u FROM s UNION SELECT a.u_new, a.u_old FROM aliases a WHERE a.u_new IN (SELECT c FROM s)), ' +
    'links AS (SELECT u_new AS c, json_group_array(u_old) AS list FROM (SELECT u_new, u_old FROM aliases WHERE u_new IN (SELECT c FROM s) ' +
    'ORDER BY u_new, u_old) GROUP BY u_new), ' +
    'pcs AS (SELECT codes.c AS c, COUNT(DISTINCT x.p) AS n FROM codes JOIN st_student_pcs x ON x.u = codes.u GROUP BY 1), ' +
    'who AS (SELECT codes.c AS c, MAX(CASE WHEN t.u = codes.c THEN t.label END) AS label, ' +
    "substr(MAX(printf('%011d', t.last_s) || t.band_last), 12) AS band, substr(MIN(printf('%011d', t.first_s) || t.band_first), 12) AS band_first, " +
    `date(${L('MIN(t.first_s)')}, 'unixepoch') AS first_day, date(${L('MAX(t.last_s)')}, 'unixepoch') AS last_day, ` +
    `MIN(date(${L('t.first_s')}, 'unixepoch', '-' || IFNULL(t.age_days_first, 0) || ' days')) AS made_day, ` +
    `CASE WHEN MAX(t.removed_s) >= MAX(t.last_s) THEN date(${L('MAX(t.removed_s)')}, 'unixepoch') END AS removed_day ` +
    'FROM codes JOIN st_students t ON t.u = codes.u GROUP BY 1), ' +
    `page AS MATERIALIZED (SELECT c, o, SUM(length(o)) OVER (ORDER BY c) AS size FROM (SELECT s.c AS c, ${jsonObject([['u', 's.c'],
      ['label', 'COALESCE(w.label, upper(substr(s.c, 1, 4)))'],
      ['kind', "'profile'"], ['linked', "json(IFNULL(k.list, '[]'))"], ['band', band('w.band')], ['bandFirst', band('w.band_first')],
      ['firstDay', 'w.first_day'], ['lastDay', 'w.last_day'], ...['days', 'sessions'].map(col => [col, `CAST(s.${col} AS INTEGER)`]),
      ['minutes', 'round(s.engaged_ms / 60000.0, 1)'], ...['rounds', 'w', 'l', 'q'].map(col => [col, `CAST(s.${col} AS INTEGER)`]),
      ['games', 'IFNULL(g.n, 0)'], ['top', "json(IFNULL(t3.top, '[]'))"], ['pcs', 'IFNULL(p.n, 0)'],
      ['knownBefore', "CASE WHEN w.made_day < w.first_day THEN json('true') ELSE json('false') END"], ['removed', 'w.removed_day'],
      ['weekly', `json_array(${Array.from({ length: 13 }, (_, i) => `round(s.w${i} / 60000.0, 1)`).join(', ')})`]])} AS o ` +
    'FROM s LEFT JOIN who w ON w.c = s.c LEFT JOIN links k ON k.c = s.c LEFT JOIN pcs p ON p.c = s.c LEFT JOIN tops t3 ON t3.c = s.c ' +
    'LEFT JOIN played g ON g.c = s.c)), ' +
    // The first student always (so that every page moves on), then as many as fit.
    "page_in AS (SELECT c, o FROM page WHERE size <= ?10 OR size = length(o)) " +
    'SELECT (SELECT json_group_array(json(o)) FROM (SELECT o FROM page_in ORDER BY c)) AS students, ' +
    'CASE WHEN (SELECT COUNT(*) FROM page) > (SELECT COUNT(*) FROM page_in) THEN (SELECT MAX(c) FROM page_in) END AS next';
};
// The same, kept in kpi_cache by SQL (key ?9, rv ?7; its text: the next code, a space, the
// students), and read back.
const STUDENTS_KEPT = (L, scope) => `INSERT INTO kpi_cache (key, made, rows) SELECT ?9, ?7, IFNULL(next, '') || ' ' || students FROM (${STUDENTS_ANSWER(L, scope)}) ` +
  'WHERE NOT EXISTS (SELECT 1 FROM kpi_cache WHERE key = ?9)';
// Who the students of the codes ?1 (a JSON array) are, per canonical code, as one JSON text
// { c: [label, band, bandFirst, firstDay, lastDay, madeDay, removedDay, pcs, [pc labels]] }:
// the canonical code's label (a prefix of it), the band of the latest and of the first
// session, the first and last day of play on the school's clock (L: the wide scope's wall
// clock), the start of the earliest profile (its first session's day less the profile's
// age then), the latest removal from a PC when no code of the student played after it, and
// the PCs played on.
const GROUPS_INFO = L => `WITH p AS (SELECT ${CANON('x')} AS c, COUNT(DISTINCT x.p) AS n, json_group_array(DISTINCT upper(substr(x.p, 1, 4))) AS labels ` +
  `FROM st_student_pcs x${LINKS('x')} WHERE x.u IN ${IN_JSON(1)} GROUP BY 1), ` +
  `t AS (SELECT ${CANON('t')} AS c, COALESCE(MAX(CASE WHEN al.u_new IS NULL THEN t.label END), upper(substr(${CANON('t')}, 1, 4))) AS label, ` +
  "substr(MAX(printf('%011d', t.last_s) || t.band_last), 12) AS band, substr(MIN(printf('%011d', t.first_s) || t.band_first), 12) AS band_first, " +
  `date(${L('MIN(t.first_s)')}, 'unixepoch') AS first_day, date(${L('MAX(t.last_s)')}, 'unixepoch') AS last_day, ` +
  `MIN(date(${L('t.first_s')}, 'unixepoch', '-' || IFNULL(t.age_days_first, 0) || ' days')) AS made_day, ` +
  `CASE WHEN MAX(t.removed_s) >= MAX(t.last_s) THEN date(${L('MAX(t.removed_s)')}, 'unixepoch') END AS removed_day ` +
  `FROM st_students t${LINKS('t')} WHERE t.u IN ${IN_JSON(1)} GROUP BY 1) ` +
  "SELECT json_group_object(t.c, json_array(t.label, t.band, t.band_first, t.first_day, t.last_day, t.made_day, t.removed_day, IFNULL(p.n, 0), " +
  "json(IFNULL(p.labels, '[]')))) AS info FROM t LEFT JOIN p ON p.c = t.c";

// One student (the codes ?3, a JSON array): per day, per game and per school week and game
// (ws: 0 Sunday, 1 Monday) from the rollups' rows; band any.
const OF_CODES = alias => `${alias}.u IN ${IN_JSON(3)}`;
const ONE_DAYS = src => `SELECT d.day AS day, ${sums('d', ['sessions', 'engaged_ms', 'opens', 'rounds', 'w', 'l', 'q'])} ` +
  `FROM ${src.from} WHERE ${src.days} AND ${OF_CODES('d')} GROUP BY d.day`;
const GAME_SUMS = ['engaged_ms', 'rounds', ...CODES, 'hits', 'misses', 'rt_sum', 'rt_n', 'score_sum', 'score_n', 'dda_sum', 'dda_n', 'hearts'];
const ONE_GAMES = src => `SELECT g.slug AS slug, ${sums('g', GAME_SUMS)}, MAX(CASE WHEN g.score_n > 0 THEN g.score_max END) AS best ` +
  `FROM ${src.from} WHERE ${src.days} AND ${OF_CODES('g')} GROUP BY g.slug`;
const WEEK_SUMS = ['rounds', 'w', 'l', 'hits', 'misses', 'rt_sum', 'rt_n', 'score_sum', 'score_n', 'dda_sum', 'dda_n'];
const ONE_WEEKS = (src, ws) => `SELECT date(g.day, '-' || ((CAST(strftime('%w', g.day) AS INTEGER) + ${7 - ws}) % 7) || ' days') AS week, ` +
  `g.slug AS slug, ${sums('g', WEEK_SUMS)} FROM ${src.from} WHERE ${src.days} AND ${OF_CODES('g')} AND g.rounds > 0 GROUP BY 1, 2`;
// From the facts of the codes ?3 in the UTC seconds [?1, ?2), by the student index: engaged
// ms by the school's hour of the visit's opening, the latest rounds and sessions, and what
// followed a loss (as the r_stat metric persist).
const SESSIONS_OF = `FROM st_sessions s WHERE s.u IN ${IN_JSON(3)} AND s.start_s >= ?1 AND s.start_s < ?2`;
const ROUNDS_OF = `FROM st_sessions s JOIN st_rounds r ON r.sid = s.id WHERE s.u IN ${IN_JSON(3)} AND s.start_s >= ?1 AND s.start_s < ?2`;
const ONE_HOURS = L => `SELECT CAST(strftime('%H', ${L('s.start_s + v.t_open')}, 'unixepoch') AS INTEGER) AS h, TOTAL(v.engaged_ms) AS ms ` +
  `FROM st_sessions s JOIN st_visits v ON v.sid = s.id WHERE s.u IN ${IN_JSON(3)} AND s.start_s >= ?1 AND s.start_s < ?2 ` +
  'AND v.t_open IS NOT NULL GROUP BY 1';
const ROUND_AT = 's.start_s + COALESCE(r.t0, r.t)';
const ONE_ROUNDS = L => `SELECT date(${L(ROUND_AT)}, 'unixepoch') AS day, strftime('%H:%M', ${L(ROUND_AT)}, 'unixepoch') AS time, ` +
  'r.slug AS slug, r.id AS id, r.code AS code, r.ms AS ms, r.score AS score, COALESCE(r.tier0, r.tier) AS tier, ' +
  'CASE WHEN r.dda >= 0 THEN r.dda END AS dda, r.hits AS hits, r.misses AS misses, ' +
  'CASE WHEN r.rt_n > 0 THEN CAST(round(r.rt_sum * 1.0 / r.rt_n) AS INTEGER) END AS rtMean, r.attempt AS attempt, ' +
  `round(COALESCE(r.t0, r.t) / 60.0, 1) AS minIntoSession ${ROUNDS_OF} ORDER BY ${ROUND_AT} DESC, s.id DESC, r.n DESC, r.k DESC LIMIT ${RECENT_ROUNDS}`;
const ONE_SESSIONS = L => `SELECT date(${L('s.start_s')}, 'unixepoch') AS day, strftime('%H:%M', ${L('s.start_s')}, 'unixepoch') AS time, ` +
  "upper(substr(s.p, 1, 4)) AS pc, round((SELECT TOTAL(v.engaged_ms) FROM st_visits v WHERE v.sid = s.id) / 60000.0, 1) AS minutes, " +
  '(SELECT json_group_array(v.slug) FROM st_visits v WHERE v.sid = s.id) AS games, ' +
  '(SELECT COUNT(*) FROM st_rounds r WHERE r.sid = s.id AND r.code IS NOT NULL) AS rounds, ' +
  "(SELECT COUNT(*) FROM st_rounds r WHERE r.sid = s.id AND r.code = 'w') AS wins, s.why AS why " +
  `${SESSIONS_OF} ORDER BY s.start_s DESC, s.id DESC LIMIT ${RECENT_SESSIONS}`;
const NEXT = "CASE WHEN nx.k IS NOT NULL THEN CASE WHEN nx.id = r.id THEN 'same' ELSE 'level' END " +
  "WHEN EXISTS (SELECT 1 FROM st_visits y WHERE y.sid = r.sid AND y.n > r.n) THEN 'game' ELSE 'stop' END";
const ONE_PERSIST = `SELECT ${NEXT} AS next, COUNT(*) AS n FROM st_sessions s JOIN st_rounds r ON r.sid = s.id ` +
  `LEFT JOIN st_rounds nx ON nx.sid = r.sid AND nx.n = r.n AND nx.k = r.k + 1 WHERE s.u IN ${IN_JSON(3)} AND s.start_s >= ?1 AND s.start_s < ?2 ` +
  "AND r.code = 'l' AND r.duo = 0 GROUP BY 1";

// One game (?3) over the rolled days of the list ?1 (or the open days), band ?4 (null for
// all) within the bands ?5 (a JSON array, so that r_game_day and r_stat are found by key):
// minutes and opens per day and band; distinct students per day; days played per band and
// student; r_stat rows (the metrics ?6); the paired thirds (part 0 to day ?7, part 1 from
// day ?8); and the flows into it from every game, found by key (from the session's start,
// and from each game played on that day and band).
// Each as one JSON text of arrays (the Worker parses one string, and makes no object per row).
const asArrays = (text, columns) => `SELECT json_group_array(json_array(${columns.join(', ')})) AS rows FROM (${text})`;
const GAME_DAYS = src => asArrays(`SELECT x.day AS day, x.a AS a, TOTAL(x.engaged_ms) AS ms, TOTAL(x.opens) AS opens FROM ${src.from} ` +
  `WHERE ${src.days} AND x.a IN ${IN_JSON(5)} AND x.slug = ?3 GROUP BY 1, 2`, ['day', 'a', 'ms', 'opens']);
const GAME_DAILY = src => asArrays(`SELECT x.day AS day, COUNT(DISTINCT ${CANON('x')}) AS students FROM ${src.from}${LINKS('x')} ` +
  `WHERE ${src.days} AND x.slug = ?3 AND (?4 IS NULL OR x.a = ?4) GROUP BY 1`, ['day', 'students']);
const GAME_STUDENTS = src => asArrays(`SELECT x.a AS a, ${CANON('x')} AS c, COUNT(DISTINCT x.day) AS days FROM ${src.from}${LINKS('x')} ` +
  `WHERE ${src.days} AND x.slug = ?3 AND (?4 IS NULL OR x.a = ?4) GROUP BY 1, 2`, ['a', 'c', 'days']);
const STAT_SUMS = ROLLUPS.r_stat.sums;
const STAT_ROWS = (keys, where, sums = STAT_SUMS) => `SELECT json_group_array(json_array(${[...keys, ...sums].join(', ')})) AS rows FROM (` +
  `SELECT ${keys.map(c => `x.${c} AS ${c}`).join(', ')}, ${sums.map(c => `SUM(x.${c}) AS ${c}`).join(', ')} FROM r_stat x ` +
  `WHERE ${where} GROUP BY ${keys.map((_, i) => i + 1).join(', ')} ORDER BY ${keys.map((_, i) => i + 1).join(', ')})`;
const GAME_STATS = STAT_ROWS(['a', 'metric', 'k1', 'k2'], `x.day IN ${IN_JSON(1)} AND x.a IN ${IN_JSON(5)} AND x.metric IN ${IN_JSON(6)} AND x.slug = ?3`);
const PAIRED_SUMS = ['rounds', 'w', 'l', 'hits', 'misses', 'rt_sum', 'rt_n', 'score_sum', 'score_n', 'dda_sum', 'dda_n'];
const GAME_PAIRED = src => asArrays(`SELECT ${CANON('x')} AS c, x.a AS a, CASE WHEN x.day <= ?7 THEN 0 ELSE 1 END AS part, ${sums('x', PAIRED_SUMS)} ` +
  `FROM ${src.from}${LINKS('x')} WHERE ${src.days} AND x.slug = ?3 AND (?4 IS NULL OR x.a = ?4) AND (x.day <= ?7 OR x.day >= ?8) GROUP BY 1, 2, 3`,
['c', 'a', 'part', ...PAIRED_SUMS]);
const FLOW_FROM = `SELECT g.day AS day, g.a AS a, g.slug AS slug FROM r_game_day g WHERE g.day IN ${IN_JSON(1)} AND g.a IN ${IN_JSON(5)} ` +
  `UNION ALL SELECT d.value, b.value, '' FROM json_each(?1) d, json_each(?5) b`;
const GAME_FLOWS_IN = 'SELECT json_group_array(json_array("from", n)) AS rows FROM (SELECT x.slug AS "from", SUM(x.n) AS n ' +
  `FROM (${FLOW_FROM}) f JOIN r_stat x ON x.day = f.day AND x.a = f.a AND x.metric = 'flow' AND x.slug = f.slug AND x.k1 = ?3 AND x.k2 = '' ` +
  'GROUP BY 1 ORDER BY 1)';
// Tries before the first win, from the facts (the UTC seconds [?9, ?10)): per canonical
// student and level, the ended rounds (solo, band ?4) in play order up to the first win,
// counted per level, number of tries and whether the student won ([id, tries, won, n]).
// The students are those with r_student_game rows for the game on the rolled days ?12, and
// every student playing on the open days [?11, ?10).
const FIRST_WIN = 'WITH codes AS (SELECT g.u AS u FROM r_student_game g WHERE g.day IN ' + IN_JSON(12) + ' AND g.slug = ?3 ' +
  "UNION SELECT o.u FROM st_sessions o WHERE o.start_s >= ?11 AND o.start_s < ?10 AND o.u <> ''), " +
  "rs AS MATERIALIZED (SELECT COALESCE(al.u_new, s.u) AS c, r.id AS id, r.code AS code, printf('%011d %011d %05d %05d', s.start_s, s.id, r.n, r.k) AS o " +
  'FROM codes JOIN st_sessions s ON s.u = codes.u AND s.start_s >= ?9 AND s.start_s < ?10 JOIN st_visits v ON v.sid = s.id AND v.slug = ?3 ' +
  'JOIN st_rounds r ON r.sid = v.sid AND r.n = v.n LEFT JOIN aliases al ON al.u_old = s.u ' +
  'WHERE r.code IS NOT NULL AND r.duo = 0 AND (?4 IS NULL OR s.a = ?4)), ' +
  "fw AS (SELECT c, id, MIN(o) AS o FROM rs WHERE code = 'w' GROUP BY 1, 2) " +
  'SELECT json_group_array(json_array(id, tries, won, n)) AS rows FROM (SELECT id, tries, won, COUNT(*) AS n FROM (' +
  'SELECT rs.id AS id, rs.c AS c, COUNT(*) AS tries, fw.o IS NOT NULL AS won FROM rs LEFT JOIN fw ON fw.c = rs.c AND fw.id = rs.id ' +
  'WHERE fw.o IS NULL OR rs.o <= fw.o GROUP BY 1, 2) GROUP BY 1, 2, 3)';

// The r_stat metrics ?3 (a JSON array) over the rolled days of the list ?1, bands ?2, all
// games or the game ?4: only the sums those metrics have, made and kept in kpi_cache by SQL
// (key ?5, rv ?6) unless kept already, then read back.
const statsKept = (one, sums) => `INSERT INTO kpi_cache (key, made, rows) SELECT ?5, ?6, (${STAT_ROWS(['a', 'metric', 'slug', 'k1', 'k2'],
  `x.day IN ${IN_JSON(1)} AND x.a IN ${IN_JSON(2)} AND x.metric IN ${IN_JSON(3)}${one ? ' AND x.slug = ?4' : ''}`, sums)}) ` +
  'WHERE NOT EXISTS (SELECT 1 FROM kpi_cache WHERE key = ?5)';

// Retention cohorts over the rolled days ?1..?2, band ?3: weeks are counted from the week
// start ?4. A student's cohort is the week of their profile's start (the earliest of their
// codes: its first session's day less the profile's age then); answers per cohort week
// (?5..?6) and week after it (0..12) the students active, and (k = -1) its size.
const COHORTS = L => 'WITH d AS MATERIALIZED (SELECT COALESCE(al.u_new, x.u) AS c, x.u AS u, ' +
  'CAST((julianday(x.day) - julianday(?4)) / 7 AS INTEGER) AS w FROM r_student_day x LEFT JOIN aliases al ON al.u_old = x.u ' +
  'WHERE x.day BETWEEN ?1 AND ?2 AND (?3 IS NULL OR x.a = ?3)), ' +
  'codes AS (SELECT DISTINCT c, u FROM d UNION SELECT a.u_new, a.u_old FROM aliases a WHERE a.u_new IN (SELECT c FROM d)), ' +
  `made AS (SELECT codes.c AS c, MIN(date(${L('t.first_s')}, 'unixepoch', '-' || IFNULL(t.age_days_first, 0) || ' days')) AS day ` +
  'FROM codes JOIN st_students t ON t.u = codes.u GROUP BY 1), ' +
  'm AS (SELECT c, CAST((julianday(day) - julianday(?4)) / 7 AS INTEGER) AS w0 FROM made WHERE day >= ?4) ' +
  'SELECT m.w0 AS cohort, d.w - m.w0 AS k, COUNT(DISTINCT d.c) AS n FROM d JOIN m ON m.c = d.c ' +
  'WHERE m.w0 BETWEEN ?5 AND ?6 AND d.w >= m.w0 AND d.w - m.w0 <= 12 GROUP BY 1, 2 ' +
  'UNION ALL SELECT w0, -1, COUNT(*) FROM m WHERE w0 BETWEEN ?5 AND ?6 GROUP BY 1';

// PCs (not '' : v2 and unknown PCs) over the rolled days ?1..?2 (or the open days); the
// distinct students per PC from the facts of the UTC seconds [?1, ?2); the PCs' own rows
// (?1, a JSON array of codes); and the build of the PC seen last since ?1.
const PC_SUMS = ['sessions', 'guests', 'engaged_ms', 'opens', 'loads', 'load_ms', 'errors', 'new_profiles', 'f0', 'f1', 'f2', 'f3',
  'il0', 'il1', 'il2', 'il3', 'il4', 'il5'];
const PC_DAYS = src => `SELECT x.p AS p, COUNT(*) AS days, ${sums('x', PC_SUMS)}, MAX(x.np_max) AS np_max, ` +
  `MAX(x.new_profiles >= 3 AND x.new_profiles * 2 >= x.sessions) AS forgets FROM ${src.from} WHERE ${src.days} AND x.p <> '' GROUP BY 1`;
const PC_STUDENTS = `SELECT s.p AS p, COUNT(DISTINCT ${CANON('s')}) AS students FROM st_sessions s${LINKS('s')} ` +
  "WHERE s.start_s >= ?1 AND s.start_s < ?2 AND s.u <> '' AND s.p <> '' GROUP BY 1";
const PC_INFO = L => `SELECT p, z, k, cores, mem, screen, date(${L('first_s')}, 'unixepoch') AS first_day, ` +
  `date(${L('last_s')}, 'unixepoch') AS last_day FROM st_pcs WHERE p IN ${IN_JSON(1)}`;
const PC_BUILD = 'SELECT k FROM st_pcs WHERE last_s >= ?1 ORDER BY last_s DESC, k LIMIT 1';

// The owner's actions. A student's group: the canonical code of ?1 and every code linked to it.
const CANONICAL = 'COALESCE((SELECT u_new FROM aliases WHERE u_old = ?1), ?1)';
const GROUP = `(SELECT ${CANONICAL} AS u UNION SELECT u_old FROM aliases WHERE u_new = ${CANONICAL})`;
const OF_GROUP = `(SELECT id FROM st_sessions WHERE u IN ${GROUP})`;
// Forget: how many of the group's codes the server holds, then every fact and per-student
// rollup row of the group (and the marks of other sessions that name one of its codes: the
// removal of a profile, or an older code whose link was undone; both come after the
// student's first play), the live rows, the student rows and the links last (the group is
// read from them). School-wide rollups keep their counts.
const FORGET = [
  `SELECT COUNT(*) AS n FROM ${GROUP} g WHERE EXISTS (SELECT 1 FROM st_students WHERE u = g.u) OR EXISTS (SELECT 1 FROM st_sessions WHERE u = g.u)`,
  `DELETE FROM st_rounds WHERE sid IN ${OF_GROUP}`, `DELETE FROM st_visits WHERE sid IN ${OF_GROUP}`, `DELETE FROM st_marks WHERE sid IN ${OF_GROUP}`,
  `DELETE FROM st_marks WHERE kind IN ('pr', 'cd') AND x IN ${GROUP} AND sid IN (SELECT id FROM st_sessions WHERE start_s >= ` +
    `(SELECT MIN(first_s) FROM st_students WHERE u IN ${GROUP}))`,
  `DELETE FROM st_sessions WHERE u IN ${GROUP}`, `DELETE FROM st_student_pcs WHERE u IN ${GROUP}`, `DELETE FROM st_student_games WHERE u IN ${GROUP}`,
  `DELETE FROM r_student_day WHERE u IN ${GROUP}`, `DELETE FROM r_student_game WHERE u IN ${GROUP}`, `DELETE FROM live WHERE u IN ${GROUP}`,
  `DELETE FROM st_students WHERE u IN ${GROUP}`, `DELETE FROM aliases WHERE u_old IN ${GROUP} OR u_new IN ${GROUP}`
];
// Link ?1 to the canonical code of ?2 (by the owner, at ?3): links to ?1 move to it (one hop
// deep), and ?1's own link is replaced. Nothing changes when that would form a cycle.
const TARGET = 'COALESCE((SELECT u_new FROM aliases WHERE u_old = ?2), ?2)';
const LINK_CHECK = `SELECT ${TARGET} AS target, EXISTS (SELECT 1 FROM st_students WHERE u = ?1) AS u_known, ` +
  'EXISTS (SELECT 1 FROM st_students WHERE u = ?2) AS to_known';
const LINK = [`UPDATE aliases SET u_new = ${TARGET} WHERE u_new = ?1 AND ${TARGET} <> ?1`,
  `INSERT INTO aliases (u_old, u_new, s, how) SELECT ?1, ${TARGET}, ?3, 'owner' WHERE ${TARGET} <> ?1 ` +
    'ON CONFLICT (u_old) DO UPDATE SET u_new = excluded.u_new, s = excluded.s, how = excluded.how'];
const UNLINK = 'DELETE FROM aliases WHERE u_old = ?1';
// Recount: every rolled day since facts_since (and not trimmed) waits for a recount (dirty
// 3: a diff re-roll, which writes only the rows that changed, so a recount after a forget
// costs a few hundred rows a day, not the day's every row twice), unless it already waits
// for a full re-roll; then the days waiting.
const RECOUNT = ["UPDATE roll_days SET dirty = 3 WHERE day >= (SELECT MAX(value) FROM settings WHERE key IN ('facts_since', 'trimmed_before')) AND dirty < 2",
  "INSERT INTO settings (key, value) VALUES ('rebuild', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  "SELECT COUNT(*) AS n FROM roll_days WHERE dirty > 0 AND day >= (SELECT value FROM settings WHERE key = 'facts_since')"];

// A value that is already JSON text: the handler writes it into the answer as it is (an
// answer that is a JsonText is sent as it is). SENT: the JSON text of a whole answer object,
// made with it.
export class JsonText {
  constructor(text) { this.text = text; }
}
export const SENT = Symbol('sent');

/* ------------------------------------------------------------ the views */
// ctx: the store's helpers (store.mjs): sql, bound, run, ensure, conf (the settings as last
// read), spans (rolled and open days of a period), wide (the school's clock over every
// stored second), partKeys, lookup and keepParts (kept parts of answers), clock and renew
// (statements that raise rv and forget kept parts, and renewed() after they ran).
export function adminViews(ctx) {
  const { sql, bound, run, ensure, spans, wide, partKeys, lookup, keepParts } = ctx;

  // Codes and their canonical code, from the links ([u_old, u_new, ...] rows).
  function groups(aliases) {
    const canonical = new Map(), linked = new Map();
    for (const [old, to] of aliases) {
      canonical.set(old, to);
      (linked.get(to) || linked.set(to, []).get(to)).push(old);
    }
    for (const list of linked.values()) list.sort(natural);
    return { of: u => canonical.get(u) || u, linked: c => linked.get(c) || [] };
  }
  // Runs the tasks ([statement, take(result)]) in one batch.
  async function perform(tasks, now, options) {
    if (!tasks.length) return;
    const results = await run(tasks.map(([statement]) => statement), now, options);
    results.forEach((result, i) => tasks[i][1](result));
  }
  // Kept parts of an answer: the closed and open part found, and the links (unless links: false).
  async function kept(keys, now, options) {
    const { found, aliases } = await lookup([keys.closed, keys.open], now, options);
    return { closed: keys.closed && found.get(keys.closed.key), open: keys.open && found.get(keys.open.key), aliases };
  }
  const range = (from, to, band) => ({ from, to, days: daysBetween(from, to), band: band === null ? 'all' : bandName(band) });
  const answer = (now, fields) => ({ v: 1, ...fields, clock: ctx.clock(now) });
  // Who the students of these codes are (GROUPS_INFO), by canonical code.
  const whoTask = (codes, now, into) => [bound(GROUPS_INFO(wide(now).local), [json(codes)]), r => { into.info = JSON.parse(r.results[0].info || '{}'); }];
  function described(c, info) {
    const [label = c.slice(0, 4).toUpperCase(), band = null, bandFirst = null, firstDay = null, lastDay = null, made = null, removed = null, pcs = 0,
      pcLabels = []] = info[c] || [];
    return { label, kind: 'profile', band: band === null ? null : bandName(band), bandFirst: bandFirst === null ? null : bandName(bandFirst),
      firstDay, lastDay, profileMadeDay: made, knownBefore: !!(made && firstDay && made < firstDay), removed, pcs, pcLabels: pcLabels.sort(natural) };
  }

  // GET /v1/admin/students: every canonical student who played in the period (band: the
  // band of the day's first session), with their days, sessions, minutes, rounds ended,
  // wins, losses and quits there, the games they tried and their top 3 by minutes, their PCs
  // and links, and minutes per school week for the 13 weeks ending with `to`'s week; from
  // the code after `after` on, as many as fit in 1.5 MB (next: the last of them, to ask for
  // the next page after, when more are left). Its parts and the answer stay JSON text from SQL to the reply, and the
  // closed part goes from SQL to kpi_cache and back to SQL without the Worker: a school has
  // hundreds of students, too many to pass, parse and write again within the Workers' 10 ms.
  // On Workers the answer is kept per 10-minute slot.
  const studentsTexts = new Map();
  async function students({ from, to, band, after = null }, now = Date.now()) {
    await ensure(now);
    const conf = ctx.conf(), ws = conf.weekStart === 'sun' ? 0 : 1, w0 = addDays(weekOf(to, ws), -12 * 7), start = from < w0 ? from : w0;
    const weeks = spans(start, to, now);
    const out = (text, next) => answer(now, { range: range(from, to, band), students: new JsonText(text), ...(next ? { next } : {}) });
    const page = text => { const at = text.indexOf(' '); return out(text.slice(at + 1), text.slice(0, at)); };
    const answerKey = partKeys(['students-answer', from, to, band, ws, after], null, true, now, { raw: true }).open;
    if (answerKey) {
      const { found } = await lookup([answerKey], now, { links: false });
      if (found.has(answerKey.key)) return page(found.get(answerKey.key));
    }
    const closedKey = weeks.rolled ? JSON.stringify(['students', start, weeks.rolled[1], band, w0, from, conf.rv]) : '';
    const W = wide(now), L = W.local, textKey = W.day + ' ' + (weeks.scope?.day ?? '');
    let texts = studentsTexts.get(textKey);
    if (!texts) {
      if (studentsTexts.size >= 8) studentsTexts.clear();
      studentsTexts.set(textKey, texts = { answer: STUDENTS_ANSWER(L, weeks.scope), kept: STUDENTS_KEPT(L, weeks.scope) });
    }
    const values = [...(weeks.bounds || [0, 0]), band, w0, from, closedKey, conf.rv, after ?? '', answerKey?.key ?? '', ctx.studentsPageBytes];
    const work = closedKey ? [bound(STUDENTS_CLOSED, [...weeks.rolled, band, w0, from, closedKey, conf.rv])] : [];
    if (answerKey) work.push(bound(texts.kept, values), bound('SELECT rows FROM kpi_cache WHERE key = ?1', [answerKey.key]));
    else work.push(bound(texts.answer, values));
    const results = await run(work, now), row = results.at(-1).results[0];
    if (!answerKey) return out(row.students, row.next);
    await keepParts([[answerKey, row.rows]], now, { here: true });
    return page(row.rows);
  }

  // GET /v1/admin/student?u: one student's page (u is any of their codes): who they are,
  // their days, hours, games, weeks per game, latest rounds and sessions, and what followed
  // a loss. Answers { error: 'student', status: 404 } for a code the server does not know.
  async function student({ u, from, to }, now = Date.now()) {
    await ensure(now);
    const ws = ctx.conf().weekStart === 'sun' ? 0 : 1, period = spans(from, to, now);
    const keys = partKeys(['student', u, from, to], period.rolled, period.open, now);
    let { closed, open, aliases } = await kept(keys, now);
    const g = groups(aliases), c = g.of(u), codes = json([c, ...g.linked(c)]), L = wide(now).local, who = { info: {} };
    const tasks = [whoTask([c, ...g.linked(c)], now, who)];
    const lo = ctx.bounds(from).lo, hi = ctx.bounds(to).hi;
    const make = scope => {
      const part = { days: [], games: [], weeks: [] }, values = [...(scope ? period.bounds : period.rolled), codes];
      tasks.push([bound(ONE_DAYS(source('r_student_day', 'd', scope)), values), r => { part.days = r.results; }],
        [bound(ONE_GAMES(source('r_student_game', 'g', scope)), values), r => { part.games = r.results; }],
        [bound(ONE_WEEKS(source('r_student_game', 'g', scope), ws), values), r => { part.weeks = r.results; }]);
      // The lists only the facts hold, over the whole period, go with the open part when there is one.
      if (!!scope === !!period.open) {
        const facts = [lo, hi, codes];
        tasks.push([bound(ONE_HOURS(L), facts), r => { part.hours = r.results; }], [bound(ONE_ROUNDS(L), facts), r => { part.rounds = r.results; }],
          [bound(ONE_SESSIONS(L), facts), r => { part.sessions = r.results; }], [bound(ONE_PERSIST, facts), r => { part.persist = r.results; }]);
      }
      return part;
    };
    const fresh = [];
    if (period.rolled && !closed) fresh.push([keys.closed, closed = make(null)]);
    if (period.open && !open) fresh.push([keys.open, open = make(period.scope)]);
    await perform(tasks, now);
    if (!who.info[c]) return { error: 'student', status: 404 };
    await keepParts(fresh, now);

    const parts = [closed, open].filter(Boolean), facts = parts.find(part => part.rounds) || {};
    const days = parts.flatMap(part => part.days).sort((a, b) => natural(a.day, b.day))
      .map(d => ({ day: d.day, sessions: d.sessions, minutes: minutes(d.engaged_ms), opens: d.opens, rounds: d.rounds, w: d.w, l: d.l, q: d.q }));
    const games = new Map();
    for (const row of parts.flatMap(part => part.games)) {
      const into = games.get(row.slug);
      if (!into) { games.set(row.slug, { ...row }); continue; }
      for (const key of GAME_SUMS) into[key] += row[key];
      if (row.best !== null && (into.best === null || row.best > into.best)) into.best = row.best;
    }
    const weekly = new Map();
    for (const row of parts.flatMap(part => part.weeks)) {
      const id = row.week + ' ' + row.slug, into = weekly.get(id);
      if (!into) weekly.set(id, { ...row });
      else for (const key of WEEK_SUMS) into[key] += row[key];
    }
    const hours = Array(24).fill(0);
    for (const { h, ms } of facts.hours || []) hours[h] += ms;
    const persist = { same: 0, level: 0, game: 0, stop: 0 };
    for (const { next, n } of facts.persist || []) persist[next] = n;
    const d = described(c, who.info);
    return answer(now, {
      range: range(from, to, null),
      student: { u: c, label: d.label, kind: d.kind, band: d.band, bandFirst: d.bandFirst, firstDay: d.firstDay, lastDay: d.lastDay,
        profileMadeDay: d.profileMadeDay, knownBefore: d.knownBefore, removed: d.removed, pcs: d.pcLabels, linked: g.linked(c) },
      days, hours: hours.map(minutes),
      games: [...games.values()].sort((a, b) => b.engaged_ms - a.engaged_ms || natural(a.slug, b.slug)).map(x => ({
        slug: x.slug, minutes: minutes(x.engaged_ms), rounds: x.rounds, w: x.w, l: x.l, d: x.d, e: x.e, q: x.q, hits: x.hits, misses: x.misses,
        rtMean: mean(x.rt_sum, x.rt_n, 0), bestScore: x.best, avgScore: mean(x.score_sum, x.score_n, 1), ddaMean: mean(x.dda_sum, x.dda_n, 0), hearts: x.hearts })),
      weekly: [...weekly.values()].sort((a, b) => natural(a.week, b.week) || natural(a.slug, b.slug)).map(x => ({
        week: x.week, slug: x.slug, rounds: x.rounds, w: x.w, l: x.l, hits: x.hits, misses: x.misses, rtSum: x.rt_sum, rtN: x.rt_n,
        scoreSum: x.score_sum, scoreN: x.score_n, ddaSum: x.dda_sum, ddaN: x.dda_n })),
      rounds: facts.rounds || [],
      sessions: (facts.sessions || []).map(s => ({ ...s, games: JSON.parse(s.games) })),
      persist
    });
  }

  // GET /v1/admin/game?slug: one game's page: students, minutes and opens per band and per
  // day, its r_stat rows over the rolled days, tries before the first win per level, the
  // paired first and last thirds of the period per student, and the games before and after it.
  // A game's part over the rolled days (scope null: with its r_stat rows and flows) or a
  // scope's facts, with the tries before a first win when firstWin: one statement that makes
  // and keeps it in kpi_cache (key ?13, rv ?14) unless kept already (keep: it has a key), as
  // the JSON text of its lists, so it never passes through the Worker on its way in. Made
  // once per scope.
  const gameMade = new Map();
  function gamePart(scope, paired, firstWin, keep) {
    const key = [scope ? scope.day : '', paired, firstWin, keep].join(' ');
    let text = gameMade.get(key);
    if (!text) {
      if (gameMade.size >= 16) gameMade.clear();
      const src = table => source(table, 'x', scope, true);
      const lists = [['days', GAME_DAYS(src('r_game_day'))], ['daily', GAME_DAILY(src('r_student_game'))], ['students', GAME_STUDENTS(src('r_student_game'))],
        ...(paired ? [['paired', GAME_PAIRED(src('r_student_game'))]] : []), ...(scope ? [] : [['stats', GAME_STATS], ['flowsIn', GAME_FLOWS_IN]]),
        ...(firstWin ? [['firstWin', FIRST_WIN]] : [])];
      const part = 'json_object(' + lists.map(([name, list]) => `'${name}', json((${list}))`).join(', ') + ')';
      gameMade.set(key, text = keep ? `INSERT INTO kpi_cache (key, made, rows) SELECT ?13, ?14, ${part} WHERE NOT EXISTS (SELECT 1 FROM kpi_cache WHERE key = ?13)`
        : `SELECT ${part} AS rows`);
    }
    return text;
  }
  async function game({ slug, from, to, band }, now = Date.now()) {
    await ensure(now);
    const period = spans(from, to, now), keys = partKeys(['game', slug, from, to, band], period.rolled, period.open, now, { raw: true });
    let { closed, open } = await kept(keys, now, { links: false });
    const third = Math.floor(daysBetween(from, to) / 3), t1 = addDays(from, third - 1), t2 = addDays(to, 1 - third);
    const bands = json(band === null ? ALL_BANDS : [band]), metrics = json(METRICS);
    const rolledDays = period.rolled ? json(dayList(...period.rolled)) : '[]';
    const lo = ctx.bounds(from).lo, hi = ctx.bounds(to).hi, openLo = period.bounds ? period.bounds[0] : hi;
    // A part is the JSON text of its lists, made (and kept) by SQL, parsed when used; the
    // lists only the facts hold go with the open part when there is one.
    const work = [], made = [];
    const make = (scope, entry) => {
      const values = [...(scope ? period.bounds : [rolledDays, null]), slug, band, bands, metrics, t1, t2, lo, hi, openLo, rolledDays, entry?.key ?? '', ctx.conf().rv];
      work.push(bound(gamePart(scope, third > 0, !!scope === !!period.open, !!entry), values));
      if (entry) work.push(bound('SELECT rows FROM kpi_cache WHERE key = ?1', [entry.key]));
      made.push([entry, work.length - 1]);
    };
    if (period.rolled && !closed) make(null, keys.closed);
    if (period.open && !open) make(period.scope, keys.open);
    if (work.length) {
      const results = await run(work, now), texts = made.map(([entry, at]) => [entry, results[at].results[0].rows]);
      if (period.rolled && !closed) closed = texts[0][1];
      if (period.open && !open) open = texts.at(-1)[1];
      await keepParts(texts.filter(([entry]) => entry), now, { here: true });
    }
    const parts = [closed, open].filter(Boolean).map(part => JSON.parse(part)), closedPart = closed ? parts[0] : null;
    const all = name => parts.flatMap(part => part[name] || []), byBand = new Map(), byDay = new Map(), seen = new Map();
    for (const [day, a, ms, opens] of all('days')) {
      const b = byBand.get(a) || byBand.set(a, { ms: 0, opens: 0 }).get(a);
      b.ms += ms; b.opens += opens;
      const d = byDay.get(day) || byDay.set(day, { ms: 0, opens: 0, students: 0 }).get(day);
      d.ms += ms; d.opens += opens;
    }
    for (const [day, students] of all('daily')) (byDay.get(day) || byDay.set(day, { ms: 0, opens: 0, students: 0 }).get(day)).students = students;
    for (const [a, c, days] of all('students')) {
      const list = seen.get(a) || seen.set(a, new Map()).get(a);
      list.set(c, (list.get(c) || 0) + days);
    }
    // Paired thirds: students (and band) with rounds in both.
    const pairs = new Map();
    for (const row of all('paired')) {
      const id = row[0] + ' ' + row[1] + ' ' + row[2], into = pairs.get(id);
      if (!into) pairs.set(id, row.slice());
      else for (let i = 3; i < row.length; i++) into[i] += row[i];
    }
    const paired = [...pairs.values()].filter(row => row[3] > 0 && pairs.get(row[0] + ' ' + row[1] + ' ' + (1 - row[2]))?.[3] > 0)
      .sort((x, y) => natural(x[0], y[0]) || natural(x[1], y[1]) || x[2] - y[2]);
    // Tries before the first win, per level.
    const levels = new Map(), firstWin = (closedPart && closedPart.firstWin) || parts.find(part => part.firstWin)?.firstWin || [];
    for (const [id, tries, won, n] of firstWin) {
      const l = levels.get(id) || levels.set(id, { students: 0, never: 0, tries: [] }).get(id);
      l.students += n;
      if (won) for (let i = 0; i < n; i++) l.tries.push(tries); else l.never += n;
    }
    const stats = closedPart?.stats || [], flowsOut = new Map();
    for (const row of stats) if (row[1] === 'flow') flowsOut.set(row[2], (flowsOut.get(row[2]) || 0) + row[4]);
    const flowsIn = new Map();
    for (const [from, n] of closedPart?.flowsIn || []) flowsIn.set(from, (flowsIn.get(from) || 0) + n);
    const top = (map, name) => [...map].sort((a, b) => b[1] - a[1] || natural(a[0], b[0])).map(([key, n]) => ({ [name]: key, n }));
    return answer(now, {
      slug, range: range(from, to, band),
      bands: ALL_BANDS.filter(a => byBand.has(a) || seen.has(a)).map(a => {
        const b = byBand.get(a) || { ms: 0, opens: 0 }, list = seen.get(a) || new Map();
        return { band: bandName(a), students: list.size, twoDays: [...list.values()].filter(days => days >= 2).length, minutes: minutes(b.ms), opens: b.opens };
      }),
      daily: dayList(from, to).map(day => { const d = byDay.get(day) || { ms: 0, opens: 0, students: 0 }; return { day, students: d.students, minutes: minutes(d.ms), opens: d.opens }; }),
      stats: { columns: ['a', 'metric', 'k1', 'k2', ...STAT_SUMS], rows: stats },
      firstWin: [...levels].sort((a, b) => numeric(a[0], b[0]) || natural(a[0], b[0])).map(([id, l]) => {
        const sorted = l.tries.sort((x, y) => x - y);
        return { id, students: l.students, median: quantile(sorted, 0.5), p75: quantile(sorted, 0.75), never: l.never };
      }),
      paired: { columns: ['u', 'a', 'part', 'rounds', 'w', 'l', 'hits', 'misses', 'rtSum', 'rtN', 'scoreSum', 'scoreN', 'ddaSum', 'ddaN'], rows: paired },
      flowsIn: top(flowsIn, 'from'), flowsOut: top(flowsOut, 'to')
    });
  }

  // GET /v1/admin/stats: r_stat rows of the metrics over the rolled days of the period
  // (up to last night), summed over its days; every game, or one.
  async function stats({ from, to, band, metrics, slug = null }, now = Date.now()) {
    await ensure(now);
    // The rows stay one JSON text, from SQL to kpi_cache to the answer: an answer of every
    // metric over months has thousands of rows, too many to parse and write again in 10 ms.
    // Its columns: the keys and the sums the metrics have.
    const sums = STAT_SUMS.filter(c => metrics.some(metric => METRIC_SUMS[metric].includes(c)));
    const period = spans(from, to, now), keys = partKeys(['stats', from, to, band, metrics.join(','), slug], period.rolled, null, now, { raw: true });
    let closed = keys.closed && ctx.keptHere(keys.closed.key, now);
    if (keys.closed && !closed) {
      const values = [json(dayList(...period.rolled)), json(band === null ? ALL_BANDS : [band]), json(metrics), slug, keys.closed.key, ctx.conf().rv];
      const results = await run([bound(statsKept(!!slug, sums), values), bound('SELECT rows FROM kpi_cache WHERE key = ?1', [keys.closed.key])], now);
      closed = results[1].results[0].rows;
      await keepParts([[keys.closed, closed]], now, { here: true });
    }
    return answer(now, { range: { ...range(from, to, band), rolledThrough: ctx.conf().rolledThrough }, metrics, slug,
      columns: ['a', 'metric', 'slug', 'k1', 'k2', ...sums], rows: new JsonText(closed || '[]') });
  }

  // GET /v1/admin/cohorts: per school week of the period from v3_since on (the first week
  // the server could see profiles start), the students whose profile started then and how
  // many of them played in each of the 12 weeks after it, over the rolled days (null for a
  // week not reached yet).
  async function cohorts({ from, to, band }, now = Date.now()) {
    await ensure(now);
    const conf = ctx.conf(), ws = conf.weekStart === 'sun' ? 0 : 1, first = conf.v3Since > from ? conf.v3Since : from;
    const out = answer(now, { range: range(from, to, band), weekStart: conf.weekStart, cohorts: [] });
    if (!conf.v3Since || first > to) return out;
    const epoch = weekOf(first, ws), lastWeek = weekOf(to, ws), end = addDays(lastWeek, 13 * 7 - 1);
    const period = spans(epoch, end, now), keys = partKeys(['cohorts', from, to, band], period.rolled, null, now);
    let { closed } = await kept(keys, now);
    if (period.rolled && !closed) {
      const values = [...period.rolled, band, epoch, 0, Math.round((Date.parse(lastWeek) - Date.parse(epoch)) / (7 * DAY_MS))];
      await perform([[bound(COHORTS(wide(now).local), values), r => { closed = r.results.map(row => [row.cohort, row.k, row.n]); }]], now);
      await keepParts([[keys.closed, closed]], now);
    }
    const weeks = new Map(), reached = period.rolled ? period.rolled[1] : '';
    for (const [w0, k, n] of closed || []) {
      const week = addDays(epoch, w0 * 7);
      const c = weeks.get(week) || weeks.set(week, { week, size: 0, active: Array.from({ length: 13 }, (_, i) => addDays(week, i * 7) <= reached ? 0 : null) }).get(week);
      if (k < 0) c.size = n; else if (c.active[k] !== null) c.active[k] = n;
    }
    out.cohorts = [...weeks.values()].sort((a, b) => natural(a.week, b.week));
    return out;
  }

  // GET /v1/admin/pcs: every PC with a code that played in the period: days, sessions,
  // students (distinct, from the facts), guests, minutes, picture smoothness, loading, slow
  // responses, failures, profiles; its zone and build, and flags.
  async function pcs({ from, to }, now = Date.now()) {
    await ensure(now);
    const period = spans(from, to, now), keys = partKeys(['pcs', from, to], period.rolled, period.open, now);
    let { closed, open } = await kept(keys, now);
    const lo = ctx.bounds(from).lo, hi = ctx.bounds(to).hi, tasks = [];
    const make = scope => {
      const part = { days: [] };
      tasks.push([bound(PC_DAYS(source('r_pc_day', 'x', scope)), scope ? period.bounds : period.rolled), r => { part.days = r.results; }]);
      if (!!scope === !!period.open) tasks.push([bound(PC_STUDENTS, [lo, hi]), r => { part.students = r.results; }]);
      return part;
    };
    const fresh = [];
    if (period.rolled && !closed) fresh.push([keys.closed, closed = make(null)]);
    if (period.open && !open) fresh.push([keys.open, open = make(period.scope)]);
    await perform(tasks, now);
    await keepParts(fresh, now);
    const by = new Map();
    for (const row of [closed, open].filter(Boolean).flatMap(part => part.days)) {
      const into = by.get(row.p);
      if (!into) { by.set(row.p, { ...row }); continue; }
      for (const key of ['days', ...PC_SUMS]) into[key] += row[key];
      into.np_max = Math.max(into.np_max ?? 0, row.np_max ?? 0);
      into.forgets = into.forgets || row.forgets;
    }
    const students = new Map((closed?.students || open?.students || []).map(row => [row.p, row.students]));
    const info = new Map();
    let build = null;
    if (by.size) {
      await perform([[bound(PC_INFO(wide(now).local), [json([...by.keys()])]), r => { for (const row of r.results) info.set(row.p, row); }],
        [bound(PC_BUILD, [lo]), r => { build = r.results[0]?.k ?? null; }]], now);
    }
    return answer(now, {
      range: range(from, to, null),
      pcs: [...by.values()].sort((a, b) => natural(a.p, b.p)).map(x => {
        const pc = info.get(x.p) || {}, frames = x.f0 + x.f1 + x.f2 + x.f3, il = x.il0 + x.il1 + x.il2 + x.il3 + x.il4 + x.il5;
        const smoothShare = ratio(x.f0, frames), flags = [];
        if (x.np_max >= FULL) flags.push('full');
        if (x.forgets) flags.push('forgets');
        if (smoothShare !== null && smoothShare < CHOPPY) flags.push('choppy');
        if (build && pc.k && pc.k !== build) flags.push('old');
        return { p: x.p, label: x.p.slice(0, 4).toUpperCase(), firstDay: pc.first_day ?? null, lastDay: pc.last_day ?? null, days: x.days,
          sessions: x.sessions, students: students.get(x.p) || 0, guests: x.guests, minutes: minutes(x.engaged_ms), smoothShare,
          stallShare: ratio(x.f3, frames), avgLoadMs: x.loads ? Math.round(x.load_ms / x.loads) : null, slowInputShare: ratio(x.il4 + x.il5, il),
          errors: x.errors, npMax: x.np_max ?? 0, newProfiles: x.new_profiles, z: pc.z ?? '', build: pc.k ?? '', flags };
      })
    });
  }

  // POST /v1/admin/forget { u }: every fact and per-student row of the student's group of
  // codes. The school-wide rollups keep the play already counted (a recount drops it).
  async function forget({ u }, now = Date.now()) {
    await ensure(now);
    const results = await run([...FORGET.map(text => bound(text, [u])), ...ctx.renew()], now);
    ctx.renewed();
    const changed = i => results[i].meta.changes;
    return answer(now, { removed: { codes: results[0].results[0].n, sessions: changed(5), visits: changed(2), rounds: changed(1), marks: changed(3) + changed(4) } });
  }

  // POST /v1/admin/link { u, to }: u (and every code linked to it) counts as to's canonical
  // code from now on, its history included. Refused for a code the server does not know
  // (404) and for a cycle (400).
  async function link({ u, to }, now = Date.now()) {
    await ensure(now);
    const [check] = await run([bound(LINK_CHECK, [u, to])], now), { target, u_known: uKnown, to_known: toKnown } = check.results[0];
    if (!uKnown || !toKnown) return { error: 'student', status: 404 };
    if (target === u || to === u) return { error: 'cycle', status: 400 };
    await run([...LINK.map(text => bound(text, [u, to, Math.floor(now / 1000)])), ...ctx.renew()], now);
    ctx.renewed();
    return answer(now, { ok: true, u, to: target });
  }

  // DELETE /v1/admin/link?u: u counts as itself again. ok is false when it had no link.
  async function unlink({ u }, now = Date.now()) {
    await ensure(now);
    const [removed] = await run([bound(UNLINK, [u]), ...ctx.renew()], now);
    ctx.renewed();
    return answer(now, { ok: removed.meta.changes > 0 });
  }

  // POST /v1/admin/rebuild {}: every rolled day since facts_since (not trimmed) is counted
  // again by the 5-minute cron, newest first, as far as each day's writes leave room;
  // answers the days waiting.
  async function rebuild(now = Date.now()) {
    await ensure(now);
    const results = await run(RECOUNT.map(text => sql(text)), now);
    ctx.renewed();
    return answer(now, { pending: results[2].results[0].n });
  }

  return { students, student, game, stats, cohorts, pcs, forget, link, unlink, rebuild };
}
