// Storage for the ingest server: daily aggregates over a D1-style async SQL driver
// (Cloudflare D1 on Workers, sqlite-d1.mjs on Node). An accepted batch adds its events
// to running totals per UTC receipt day and age band (per game, per level, per launch
// source, per device bucket, and the day's totals) with one INSERT ... ON CONFLICT DO
// UPDATE per table, all in one transaction, so a request costs O(groups), never
// O(events). Distinct sessions per group and day are counted through the small `seen`
// table, which keeps only the last two days; `live` keeps the last receipt minute and
// open game per session while it is in the five-minute window (at most ten minutes). Rows
// hold only validated contract values, counts and sums: no column for an IP, a header, a
// timestamp or an event.
import { CODES, ERRORS, SOURCES } from './schema.mjs';

export const MIN_SESSIONS = 3;
export const LIVE_WINDOW_MIN = 5;
export const DEDUP_DAYS = 30;
export const SEEN_DAYS = 2;
export const SCHEMA_VERSION = 3;
const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const CLOSED_KEEP_MS = 3600000;
const CLOSED_CAP = 16;
// Kept KPI rows stay well under D1's 2 MB limit for a value.
const KEPT_MAX = 1000000;
const BANDS = [['6-7', '6-7'], ['8-9', '8-9'], ['10-11', '10-11'], ['', 'unknown']];
const DEVICES = [['cores', 'cores'], ['mem', 'memory'], ['screen', 'screen']];

const series = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
const RT = series('rt', 6), IL = series('il', 6), F = series('f', 4);
const PROFILE_AGE = series('profile_age', 4), SINCE_LAST = series('since_last', 5);
const REPLAY = series('replay', 6), PLAYS = series('plays', 5);
const ERROR_COLUMNS = ERRORS.map(kind => 'error_' + kind), SOURCE_COLUMNS = SOURCES.map(src => 'src_' + src);

// Every aggregate table is keyed by (day, a, ...key) and holds whole-number sums.
// sessions is the number of distinct sessions in the group that day.
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
const AGGREGATES = Object.keys(TABLES);
const TEXT_KEYS = new Set(['slug', 'id', 'src']);

export const utcDay = ms => new Date(ms).toISOString().slice(0, 10);

const keyList = key => ['day', 'a', ...key].join(', ');
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS batches (b TEXT PRIMARY KEY, day TEXT NOT NULL) STRICT, WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS seen (day TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, s TEXT NOT NULL, ' +
    'PRIMARY KEY (day, kind, key, s)) STRICT, WITHOUT ROWID',
  'CREATE TABLE IF NOT EXISTS live (s TEXT PRIMARY KEY, slug TEXT NOT NULL, seen_minute INTEGER NOT NULL) STRICT, WITHOUT ROWID',
  // The KPI rows of closed days (JSON) per [from, end, band], and the last closed day when made.
  'CREATE TABLE IF NOT EXISTS kpi_cache (key TEXT PRIMARY KEY, made TEXT NOT NULL, rows TEXT NOT NULL) STRICT, WITHOUT ROWID',
  ...Object.entries(TABLES).map(([table, { key, sums }]) => `CREATE TABLE IF NOT EXISTS ${table} (day TEXT NOT NULL, a TEXT NOT NULL, ` +
    key.map(c => `${c} ${TEXT_KEYS.has(c) ? 'TEXT' : 'INTEGER'} NOT NULL, `).join('') +
    sums.map(c => `${c} INTEGER NOT NULL DEFAULT 0, `).join('') + `PRIMARY KEY (${keyList(key)})) STRICT, WITHOUT ROWID`)
];
const META = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT, WITHOUT ROWID';
const SET_VERSION = `INSERT INTO meta (key, value) VALUES ('schema', ${SCHEMA_VERSION}) ` +
  'ON CONFLICT (key) DO UPDATE SET value = excluded.value';

// The seen group of each table's rows: its kind and its key, from the JSON row.
const SEEN_GROUP = { agg_days: ['d', "''"], agg_games: ['g', 'value ->> 0'], agg_levels: ['l', "(value ->> 0) || ' ' || (value ->> 1)"],
  agg_sources: ['s', 'value ->> 0'], agg_devices: ['d', "''"] };
// The sums a session adds only with its first batch of the day in a group.
const FIRST = new Set(['sessions', 'web', 'app']);
// One statement per table adds a JSON array of rows [...key, ...sums, more] for day ?1 and
// band ?2. A FIRST sum counts only while session ?4 has no seen row for the group, so the
// statements run before the batch's own seen rows go in, in the same transaction; a row
// whose other sums are all 0 (more = 0) is written only then. (WHERE keeps SQLite from
// reading ON CONFLICT as a join constraint.)
const UPSERT = Object.fromEntries(Object.entries(TABLES).map(([table, { key, sums }]) => {
  const [kind, group] = SEEN_GROUP[table], columns = [...key, ...sums];
  const fresh = `NOT EXISTS (SELECT 1 FROM seen WHERE day = ?1 AND kind = '${kind}' AND key = ${group} AND s = ?4)`;
  const values = columns.map((c, i) => FIRST.has(c) ? `CASE WHEN value ->> ${i} AND ${fresh} THEN value ->> ${i} ELSE 0 END` : `value ->> ${i}`);
  return [table, `INSERT INTO ${table} (${keyList(columns)}) SELECT ?1, ?2, ${values.join(', ')} FROM json_each(?3) ` +
    `WHERE value ->> ${columns.length} OR ${fresh} ` +
    `ON CONFLICT (${keyList(key)}) DO UPDATE SET ` + sums.map(c => `${c} = ${c} + excluded.${c}`).join(', ')];
}));
// The groups [kind, key] of session ?2 today, after the additions.
const SEEN = 'INSERT OR IGNORE INTO seen (day, kind, key, s) SELECT ?1, value ->> 0, value ->> 1, ?2 FROM json_each(?3)';
const ADD_BATCH = 'INSERT INTO batches (b, day) VALUES (?1, ?2)';
const ADD_EMPTY_BATCH = 'INSERT OR IGNORE INTO batches (b, day) VALUES (?1, ?2) RETURNING b';
// ?4 is 1 when the batch decides the open game (?2). Otherwise the game stays open unless
// ?5 names it (closed), or the session had left the live window (?6) and was forgotten.
const LIVE = 'INSERT INTO live (s, slug, seen_minute) VALUES (?1, ?2, ?3) ON CONFLICT (s) DO UPDATE SET ' +
  'seen_minute = excluded.seen_minute, slug = CASE WHEN ?4 THEN excluded.slug WHEN seen_minute <= ?6 THEN \'\' ' +
  "WHEN instr(?5, ' ' || slug || ' ') THEN '' ELSE slug END";
// Rows that have left the window (?1 is the current minute - LIVE_WINDOW_MIN) are dead:
// LIVE forgets them anyway. Every sweep deletes them.
const LIVE_SWEEP = 'DELETE FROM live WHERE seen_minute <= ?1';
const LIVE_COUNT = 'SELECT slug, COUNT(*) AS n FROM live WHERE seen_minute > ?1 GROUP BY slug';
const KEPT_GET = 'SELECT rows FROM kpi_cache WHERE key = ?1';
const KEPT_PRUNE = 'DELETE FROM kpi_cache WHERE made < ?1';
const KEPT_PUT = 'INSERT INTO kpi_cache (key, made, rows) VALUES (?1, ?2, ?3) ' +
  'ON CONFLICT (key) DO UPDATE SET made = excluded.made, rows = excluded.rows';
const DUPLICATE = /UNIQUE constraint failed: batches\.b\b/;

// The KPI queries, one per aggregate table: the group's key fields, then its sums over
// the days ?1..?2 and the band ?3 (null for every band, '' for the unknown band). They
// are read as arrays (raw()), and the index of each sum is AT[table][column].
const WHERE = 'day BETWEEN ?1 AND ?2 AND (?3 IS NULL OR a = ?3)';
const KPI_GROUPS = { agg_days: ['day', 'a'], agg_games: ['a', 'slug'], agg_levels: ['slug', 'id'], agg_sources: ['src'],
  agg_devices: ['cores', 'mem', 'screen'] };
const KPI = Object.entries(KPI_GROUPS).map(([table, keys]) => `SELECT ${keys.join(', ')}, ` +
  TABLES[table].sums.map(c => `TOTAL(${c})`).join(', ') + ` FROM ${table} WHERE ${WHERE} GROUP BY ${keys.join(', ')}`);
const AT = Object.fromEntries(Object.entries(TABLES).map(([table, { sums }]) => [table, Object.fromEntries(sums.map((c, i) => [c, i]))]));
const D = AT.agg_days, G = AT.agg_games, L = AT.agg_levels, S = AT.agg_sources, V = AT.agg_devices;

// The first schema (one table per event kind) is folded into the aggregates on upgrade.
// For each aggregate: [FROM clause, its day/band/key expressions, the sums it adds].
const isCode = Object.fromEntries(CODES.map(c => [c, `code = '${c}'`]));
const flags = (columns, column) => Object.fromEntries(columns.map((c, i) => [c, `${column} = ${i}`]));
const tier = { tier_sum: 'CASE WHEN tier > 0 THEN tier ELSE 0 END', tier_n: 'tier > 0' };
const same = columns => Object.fromEntries(columns.map(c => [c, c]));
const device = 'e JOIN session_days d ON d.s = e.s AND d.day = e.day';
const deviceKeys = { day: 'e.day', a: 'e.a', cores: 'd.cores', mem: 'd.mem', screen: 'd.screen' };
const LEGACY = {
  agg_days: [
    ['session_days', {}, { sessions: '1', web: "m = 'web'", app: "m = 'app'" }],
    ['ev_gx', {}, { engaged_ms: 'ms' }], ['ev_go', {}, { opens: '1' }], ['ev_rs', {}, { starts: '1' }],
    ['ev_re', {}, { ends: '1' }], ['ev_lv', {}, { level_ups: '1' }], ['ev_er', {}, { errors: '1' }],
    ['ev_ss', {}, { session_starts: '1', new_profiles: 'new_profile', guests: 'level = 0',
      ...flags(PROFILE_AGE, 'profile_age'), ...flags(SINCE_LAST, 'since_last') }]
  ],
  agg_games: [
    ['session_games', {}, { sessions: '1' }],
    ['ev_go', {}, { opens: '1', ...Object.fromEntries(SOURCES.map(src => ['src_' + src, `src = '${src}'`])), ...flags(PLAYS, 'plays') }],
    ['ev_gx', {}, { closes: '1', engaged_ms: 'ms', ...same([...IL, ...F]) }],
    ['ev_rs', {}, { starts: '1', ...tier,
      ...flags(REPLAY, 'CASE WHEN replay < 3 THEN replay WHEN replay < 5 THEN 3 WHEN replay < 10 THEN 4 ELSE 5 END') }],
    ['ev_re', {}, { ends: '1', ...isCode, ...same(['hits', 'misses', ...RT]) }],
    ['ev_ld', {}, { loads: '1', load_ms: 'ms' }],
    ['ev_er', {}, Object.fromEntries(ERRORS.map(kind => ['error_' + kind, `kind = '${kind}'`]))]
  ],
  agg_levels: [
    ['session_levels', {}, { sessions: '1' }],
    ['ev_rs', {}, { starts: '1', ...tier }],
    ['ev_re', {}, { ends: '1', ...isCode, ms: 'ms' }]
  ],
  agg_sources: [
    ['(SELECT day, a, src, COUNT(DISTINCT s) AS n, COUNT(*) AS opens FROM ev_go GROUP BY day, a, src)', {}, { sessions: 'n', opens: 'opens' }]
  ],
  agg_devices: [
    ['session_days', {}, { sessions: '1' }],
    ['ev_gx ' + device, deviceKeys, Object.fromEntries([...F, ...IL].map(c => [c, 'e.' + c]))],
    ['ev_ld ' + device, deviceKeys, { loads: '1', load_ms: 'e.ms' }]
  ]
};
const LEGACY_TABLES = ['session_days', 'session_games', 'session_levels', 'ev_ss', 'ev_go', 'ev_ld', 'ev_er', 'ev_rs', 'ev_re', 'ev_gx', 'ev_lv', 'ev_se'];
// Today's and yesterday's sessions, as seen by the last receipt day in the old tables.
const LEGACY_SEEN = "(SELECT date(MAX(day), '-1 day') FROM session_days)";

function legacyUpgrade() {
  const sql = Object.entries(LEGACY).map(([table, sources]) => {
    const { key, sums } = TABLES[table], columns = ['day', 'a', ...key];
    const parts = sources.map(([from, keys, values]) => 'SELECT ' +
      columns.map(c => `${keys[c] || c} AS ${c}`).concat(sums.map(c => `${values[c] || 0} AS ${c}`)).join(', ') + ' FROM ' + from);
    return `INSERT INTO ${table} (${[...columns, ...sums].join(', ')}) SELECT ${columns.join(', ')}, ` +
      sums.map(c => `SUM(${c})`).join(', ') + ` FROM (${parts.join(' UNION ALL ')}) GROUP BY ${columns.join(', ')}`;
  });
  sql.push(`INSERT OR IGNORE INTO seen (day, kind, key, s) SELECT day, 'd', '', s FROM session_days WHERE day >= ${LEGACY_SEEN} ` +
    `UNION SELECT day, 'g', slug, s FROM session_games WHERE day >= ${LEGACY_SEEN} ` +
    `UNION SELECT day, 'l', slug || ' ' || id, s FROM session_levels WHERE day >= ${LEGACY_SEEN} ` +
    `UNION SELECT day, 's', src, s FROM ev_go WHERE day >= ${LEGACY_SEEN}`);
  sql.push(...LEGACY_TABLES.map(table => `DROP TABLE ${table}`), 'DROP INDEX IF EXISTS batches_day',
    // The first server refuses a database whose user_version is newer than its own.
    `PRAGMA user_version = ${SCHEMA_VERSION}`);
  return sql;
}

// A group with fewer than MIN_SESSIONS distinct sessions is reported only as suppressed.
// An empty group (no rows) reveals nothing and keeps its zeros; a group with rows is
// never shown with fewer than MIN_SESSIONS sessions, even 0.
const hidden = (n, present) => n < MIN_SESSIONS && (n > 0 || present);
const group = (key, sessions, present, build) =>
  hidden(sessions, present) ? { ...key, suppressed: true } : { ...key, sessions, ...build() };
const round = (x, digits) => { const f = 10 ** digits; return Math.round(x * f) / f; };
const ratio = (a, b) => b ? round(a / b, 4) : null;
const mean = (sum, n, digits) => n ? round(sum / n, digits) : null;
const minutes = ms => round(ms / 60000, 1);
const pick = (row, columns) => columns.map(c => row[c]);
const natural = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// The same order as localeCompare(b, 'en', { numeric: true }), without a new collator per call.
const numeric = new Intl.Collator('en', { numeric: true }).compare;
const byLevel = (a, b) => natural(a.slug, b.slug) || numeric(a.id, b.id) || natural(a.id, b.id);
const zeros = table => Object.fromEntries(TABLES[table].sums.map(c => [c, 0]));

// KPI rows are arrays: `keys` key fields, then the sums. sumRows adds up the rows of each
// group (the same group can come from kept and fresh days) into { key, v }, v being the
// sums as an array indexed through AT; the rows themselves are never changed.
function sumRows(rows, keys) {
  const map = new Map();
  for (const row of rows) {
    const id = keys === 1 ? row[0] : row.slice(0, keys).join(' '), entry = map.get(id);
    if (!entry) map.set(id, { key: row.slice(0, keys), v: row.slice(keys) });
    else for (let i = keys; i < row.length; i++) entry.v[i - keys] += row[i];
  }
  return map;
}
const sumInto = (map, id, v) => {
  const into = map.get(id);
  if (!into) map.set(id, v.slice());
  else for (let i = 0; i < v.length; i++) into[i] += v[i];
};
const vector = (v, at, columns) => columns.map(c => v[at[c]]);
const frames = (v, at) => {
  const counts = vector(v, at, F), all = counts.reduce((a, b) => a + b, 0);
  return { counts, smoothShare: ratio(counts[0], all), stallShare: ratio(counts[3], all) };
};
const codes = (v, at) => Object.fromEntries(CODES.map(c => [c, v[at[c]]]));
const replayBucket = n => n < 3 ? n : n < 5 ? 3 : n < 10 ? 4 : 5;

// The deltas of one batch: a row per aggregate table and group, and the seen keys. The
// FIRST sums hold what the session adds if this is its first batch of the day in the group
// (the store decides that): one session, and on the day's row its mode.
function collect(envelope, events) {
  const first = table => ({ ...zeros(table), sessions: 1 });
  const day = { ...first('agg_days'), [envelope.m]: 1 }, device = first('agg_devices');
  const games = new Map(), levels = new Map(), sources = new Map();
  const game = slug => games.get(slug) || games.set(slug, first('agg_games')).get(slug);
  const level = (slug, id) => {
    const key = slug + ' ' + id;
    return (levels.get(key) || levels.set(key, { slug, id, row: first('agg_levels') }).get(key)).row;
  };
  for (const event of events) {
    switch (event[0]) {
      case 'ss': {
        const [, , fresh, age, since, lv] = event;
        day.session_starts++; day.new_profiles += fresh; day['profile_age' + age]++; day['since_last' + since]++;
        if (lv === 0) day.guests++;
        break;
      }
      case 'go': {
        const [, , slug, src, plays] = event, g = game(slug);
        day.opens++; g.opens++; g['src_' + src]++; g['plays' + plays]++;
        (sources.get(src) || sources.set(src, first('agg_sources')).get(src)).opens++;
        break;
      }
      case 'ld': {
        const [, , slug, ms] = event, g = game(slug);
        g.loads++; g.load_ms += ms; device.loads++; device.load_ms += ms;
        break;
      }
      case 'er': day.errors++; game(event[2])['error_' + event[3]]++; break;
      case 'rs': {
        const [, , slug, id, tier, replay] = event, g = game(slug), l = level(slug, id);
        day.starts++; g.starts++; l.starts++; g['replay' + replayBucket(replay)]++;
        if (tier > 0) { g.tier_sum += tier; g.tier_n++; l.tier_sum += tier; l.tier_n++; }
        break;
      }
      case 're': {
        const [, , slug, code, id, ms, , , hits, misses, rt] = event, g = game(slug), l = level(slug, id);
        day.ends++; g.ends++; g[code]++; g.hits += hits; g.misses += misses;
        for (let i = 0; i < 6; i++) g[RT[i]] += rt[i];
        l.ends++; l[code]++; l.ms += ms;
        break;
      }
      case 'gx': {
        const [, , slug, ms, il, f] = event, g = game(slug);
        day.engaged_ms += ms; g.closes++; g.engaged_ms += ms;
        for (let i = 0; i < 6; i++) { g[IL[i]] += il[i]; device[IL[i]] += il[i]; }
        for (let i = 0; i < 4; i++) { g[F[i]] += f[i]; device[F[i]] += f[i]; }
        break;
      }
      case 'lv': day.level_ups++; break;
      // 'se' adds nothing the KPIs read; it still marks the session as seen today.
    }
  }
  const seen = [['d', ''], ...[...games.keys()].map(slug => ['g', slug]), ...[...levels.keys()].map(key => ['l', key]),
    ...[...sources.keys()].map(src => ['s', src])];
  return { day, device, games, levels, sources, seen };
}

// Which game a session has open after this batch: decided by its last go or se, or,
// when it has neither, the game open before unless one of its gx closed that game.
function openGame(events) {
  let known = false, slug = '';
  const closed = new Set();
  for (const event of events) {
    if (event[0] === 'go') {
      known = true;
      slug = event[2];
    } else if (event[0] === 'se') {
      known = true;
      slug = '';
    } else if (event[0] === 'gx') {
      if (!known) closed.add(event[2]);
      else if (slug === event[2]) slug = '';
    }
  }
  return { known, slug, closed: ' ' + [...closed].join(' ') + ' ' };
}

// 1 when a row adds more than its FIRST sums.
const more = (row, table) => TABLES[table].sums.some(c => !FIRST.has(c) && row[c]) ? 1 : 0;

export function openStore(db, { retentionDays = 180 } = {}) {
  let ready = null, sweptMinute = -1;
  const sql = text => db.prepare(text);

  async function init() {
    const [, meta] = await db.batch([sql(META), sql("SELECT value FROM meta WHERE key = 'schema'")]);
    const version = meta.results[0]?.value ?? 0;
    if (version > SCHEMA_VERSION) throw new Error(`database schema ${version} is newer than this server (${SCHEMA_VERSION})`);
    if (version === SCHEMA_VERSION) return;
    const legacy = await sql("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ev_go'").first();
    await db.batch([...SCHEMA, ...(legacy ? legacyUpgrade() : []), SET_VERSION].map(sql));
  }
  // Creates or upgrades the tables once, on first use. A failure is retried on the next call.
  function setup() {
    ready ||= init().catch(error => { ready = null; throw error; });
    return ready;
  }

  // Adds one validated batch. False when its batch id was already received.
  async function ingest(envelope, events, now) {
    await setup();
    const day = utcDay(now), minute = Math.floor(now / MINUTE_MS), { b, s, a } = envelope;
    if (!events.length) {
      const [added] = await db.batch([sql(ADD_EMPTY_BATCH).bind(b, day)]);
      return added.results.length > 0;
    }
    const delta = collect(envelope, events);
    // Everything in one transaction, so a failure keeps nothing and the PC's retry counts in
    // full. The batch id goes in first: a known id (a repeat, even one arriving at the same
    // time) fails here and none of the additions are kept. The additions read seen before
    // the batch's own seen rows go in: that is how a session counts once per group and day,
    // and its first batch of the day also decides its mode and device buckets.
    const statements = [sql(ADD_BATCH).bind(b, day)];
    const add = (table, rows) => {
      const { key, sums } = TABLES[table];
      const json = rows.map(row => [...pick(row, key), ...pick(row, sums), more(row, table)]);
      if (json.length) statements.push(sql(UPSERT[table]).bind(day, a, JSON.stringify(json), s));
    };
    add('agg_days', [delta.day]);
    add('agg_games', [...delta.games].map(([slug, row]) => ({ slug, ...row })));
    add('agg_levels', [...delta.levels.values()].map(({ slug, id, row }) => ({ slug, id, ...row })));
    add('agg_sources', [...delta.sources].map(([src, row]) => ({ src, ...row })));
    add('agg_devices', [{ cores: envelope.d[0], mem: envelope.d[1], screen: envelope.d[2], ...delta.device }]);
    statements.push(sql(SEEN).bind(day, s, JSON.stringify(delta.seen)));
    const open = openGame(events), sweep = minute !== sweptMinute;
    statements.push(sql(LIVE).bind(s, open.known ? open.slug : '', minute, open.known ? 1 : 0, open.closed, minute - LIVE_WINDOW_MIN));
    if (sweep) statements.push(sql(LIVE_SWEEP).bind(minute - LIVE_WINDOW_MIN));
    try {
      await db.batch(statements);
    } catch (error) {
      if (DUPLICATE.test(error && error.message)) return false;
      throw error;
    }
    if (sweep) sweptMinute = minute;
    return true;
  }

  // Deletes aggregate days older than the retention period, batch ids older than 30
  // days, seen rows older than yesterday, live rows out of the window and the kept KPI
  // rows of closed days.
  async function purge(now) {
    await setup();
    const cutoff = utcDay(now - retentionDays * DAY_MS);
    const results = await db.batch([
      ...AGGREGATES.map(table => sql(`DELETE FROM ${table} WHERE day < ?1`).bind(cutoff)),
      sql('DELETE FROM batches WHERE day < ?1').bind(utcDay(now - DEDUP_DAYS * DAY_MS)),
      sql('DELETE FROM seen WHERE day < ?1').bind(utcDay(now - (SEEN_DAYS - 1) * DAY_MS)),
      sql(LIVE_SWEEP).bind(Math.floor(now / MINUTE_MS) - LIVE_WINDOW_MIN),
      sql('DELETE FROM kpi_cache')
    ]);
    closedDays.clear();
    const changes = results.map(result => result.meta.changes);
    return { cutoff, rows: changes.slice(0, AGGREGATES.length).reduce((x, y) => x + y, 0), batches: changes[AGGREGATES.length] };
  }


  // The KPI rows (arrays, see KPI) for days from..to. Only today's rows change (a batch
  // counts on its receipt day), so the rows of the days before yesterday are read from the
  // aggregates once: they are kept in the kpi_cache table until the next purge, so every
  // instance shares them (Cloudflare may answer each dashboard refresh from a new one),
  // and in this instance's memory for an hour. A refresh reads only the last two days again.
  const closedDays = new Map();
  const scan = (from, to, band) => Promise.all(KPI.map(text => sql(text).bind(from, to, band).raw()));
  async function closedRows(from, end, band, lastClosed, now) {
    const key = JSON.stringify([from, end, band]);
    let entry = closedDays.get(key);
    if (entry && entry.until > now) return entry.rows;
    const kept = await sql(KEPT_GET).bind(key).first('rows');
    entry = { rows: kept === null ? await scan(from, end, band) : JSON.parse(kept), until: now + CLOSED_KEEP_MS };
    if (kept === null) {
      // Copies made on earlier days go. A copy that cannot be kept only costs a scan later.
      const text = JSON.stringify(entry.rows);
      if (text.length <= KEPT_MAX) await db.batch([sql(KEPT_PRUNE).bind(lastClosed), sql(KEPT_PUT).bind(key, lastClosed, text)]).catch(() => {});
    }
    for (const [old, other] of closedDays) if (old === key || other.until <= now) closedDays.delete(old);
    closedDays.set(key, entry);
    while (closedDays.size > CLOSED_CAP) closedDays.delete(closedDays.keys().next().value);
    return entry.rows;
  }
  async function kpiRows(from, to, band, now) {
    const lastClosed = utcDay(now - 2 * DAY_MS);
    if (from > lastClosed) return scan(from, to, band);
    const end = to < lastClosed ? to : lastClosed, rows = await closedRows(from, end, band, lastClosed, now);
    if (end === to) return rows;
    const recent = await scan(utcDay(Date.parse(end + 'T00:00:00Z') + DAY_MS), to, band);
    return rows.map((part, i) => part.concat(recent[i]));
  }

  // Engagement KPIs for receipt days from..to (YYYY-MM-DD, inclusive). band: null for
  // every band, '' for the unknown band. The shape is documented in server/README.md.
  async function kpis({ from, to, band = null }, now = Date.now()) {
    await setup();
    const [dayRows, gameRows, levelRows, sourceRows, deviceRows] = await kpiRows(from, to, band, now);

    // The day totals, per day and per band.
    const total = TABLES.agg_days.sums.map(() => 0), byDay = new Map(), byBand = new Map();
    for (const row of dayRows) {
      const v = row.slice(2);
      sumInto(byDay, row[0], v);
      sumInto(byBand, row[1], v);
      for (let i = 0; i < v.length; i++) total[i] += v[i];
    }
    const sessions = total[D.sessions];
    const totals = group({}, sessions, dayRows.length > 0, () => ({
      engagedMinutes: minutes(total[D.engaged_ms]), avgEngagedMinutesPerSession: mean(total[D.engaged_ms] / 60000, sessions, 2),
      gameOpens: total[D.opens], roundsStarted: total[D.starts], roundsEnded: total[D.ends], levelUps: total[D.level_ups],
      errors: total[D.errors],
      players: {
        sessionStarts: total[D.session_starts], newProfiles: total[D.new_profiles], guests: total[D.guests],
        profileAge: vector(total, D, PROFILE_AGE), daysSinceLast: vector(total, D, SINCE_LAST)
      }
    }));
    const daily = [];
    for (let t = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z'); t <= end; t += DAY_MS) {
      const day = utcDay(t), v = byDay.get(day);
      daily.push(group({ day }, v ? v[D.sessions] : 0, !!v, () => ({ engagedMinutes: minutes(v ? v[D.engaged_ms] : 0), opens: v ? v[D.opens] : 0 })));
    }
    const modes = ['web', 'app'].filter(mode => total[D[mode]] > 0).map(mode => group({ mode }, total[D[mode]], true, () => ({})));

    // Per band and game, and per game over the selected bands.
    const bandGames = sumRows(gameRows, 2), bySlug = new Map();
    for (const { key: [, slug], v } of bandGames.values()) sumInto(bySlug, slug, v);
    const games = [...bySlug.keys()].sort(natural).map(slug => {
      const g = bySlug.get(slug), c = codes(g, G), starts = g[G.starts], closes = g[G.closes];
      const hits = g[G.hits], misses = g[G.misses], loads = g[G.loads];
      return group({ slug }, g[G.sessions], true, () => ({
        opens: g[G.opens], closes,
        engagedMinutes: minutes(g[G.engaged_ms]), avgEngagedSecPerOpen: mean(g[G.engaged_ms] / 1000, closes, 1),
        rounds: { starts, ends: g[G.ends], codes: c },
        completionRate: ratio(c.w, starts), winRate: ratio(c.w, c.w + c.l), dropOffRate: ratio(c.q, starts),
        avgTier: mean(g[G.tier_sum], g[G.tier_n], 2),
        hits, misses, accuracy: ratio(hits, hits + misses),
        rt: vector(g, G, RT), il: vector(g, G, IL), frames: frames(g, G),
        loads, avgLoadMs: loads ? Math.round(g[G.load_ms] / loads) : null,
        errors: Object.fromEntries(ERRORS.map(kind => [kind, g[G['error_' + kind]]])),
        sources: Object.fromEntries(SOURCES.filter(src => g[G['src_' + src]]).map(src => [src, g[G['src_' + src]]])),
        replay: { replayIndex: vector(g, G, REPLAY), playsBefore: vector(g, G, PLAYS) }
      }));
    });

    // Per level (slug, round id): the funnel and where children stop.
    const levels = [...sumRows(levelRows, 2).values()].map(({ key: [slug, id], v }) => ({ slug, id, v })).sort(byLevel)
      .map(({ slug, id, v }) => {
        const c = codes(v, L), starts = v[L.starts], ends = v[L.ends];
        return group({ slug, id }, v[L.sessions], true, () => ({
          starts, ends, codes: c,
          completionRate: ratio(c.w, starts), winRate: ratio(c.w, c.w + c.l), dropOffRate: ratio(c.q, starts),
          avgMs: ends ? Math.round(v[L.ms] / ends) : null, avgTier: mean(v[L.tier_sum], v[L.tier_n], 2)
        }));
      });

    // Per age band: preferences (share of the band's opens per game), difficulty and time.
    const perBand = new Map();
    for (const { key: [a, slug], v } of bandGames.values()) (perBand.get(a) || perBand.set(a, []).get(a)).push({ slug, v });
    const bands = BANDS.filter(([a]) => byBand.has(a)).map(([a, name]) => {
      const b = byBand.get(a), opens = b[D.opens];
      return group({ band: name }, b[D.sessions], true, () => ({
        opens, engagedMinutes: minutes(b[D.engaged_ms]),
        games: (perBand.get(a) || []).sort((x, y) => natural(x.slug, y.slug)).map(({ slug, v }) => group({ slug }, v[G.sessions], true, () => ({
          opens: v[G.opens], share: ratio(v[G.opens], opens), avgTier: mean(v[G.tier_sum], v[G.tier_n], 2),
          completionRate: ratio(v[G.w], v[G.starts]),
          winRate: ratio(v[G.w], v[G.w] + v[G.l]), dropOffRate: ratio(v[G.q], v[G.starts]), engagedMinutes: minutes(v[G.engaged_ms]),
          starts: v[G.starts]
        })))
      }));
    });

    // Launch sources over all games, in the contract's order.
    const bySource = sumRows(sourceRows, 1);
    const sources = SOURCES.filter(src => bySource.has(src)).map(src => {
      const { v } = bySource.get(src);
      return group({ src }, v[S.sessions], true, () => ({ opens: v[S.opens] }));
    });

    // Coarse device buckets against smoothness, input latency and load time.
    const devices = {};
    DEVICES.forEach(([, name], i) => {
      const byValue = new Map();
      for (const row of deviceRows) sumInto(byValue, row[i], row.slice(3));
      devices[name] = [...byValue.keys()].sort((x, y) => x - y).map(value => {
        const v = byValue.get(value), loads = v[V.loads];
        return group({ value }, v[V.sessions], true, () => ({
          frames: frames(v, V), il: vector(v, V, IL), avgLoadMs: loads ? Math.round(v[V.load_ms] / loads) : null
        }));
      });
    });

    return {
      v: 1, range: { from, to, days: daily.length, band: band === null ? 'all' : band || 'unknown' },
      minSessions: MIN_SESSIONS, totals, daily, games, levels, bands, sources, devices, modes
    };
  }

  // Deletes the live rows that have left the window. Batches and live queries do it as they
  // come; the hosts also call this every few minutes (the Worker's 5-minute cron, a timer
  // on Node), so a live row is gone within 10 minutes when no request comes at all.
  async function sweep(now) {
    await setup();
    const [result] = await db.batch([sql(LIVE_SWEEP).bind(Math.floor(now / MINUTE_MS) - LIVE_WINDOW_MIN)]);
    return result.meta.changes;
  }

  // Sessions whose last batch arrived in this minute or the four before, and their open games.
  async function live(now) {
    await setup();
    const minute = Math.floor(now / MINUTE_MS), statements = [sql(LIVE_COUNT).bind(minute - LIVE_WINDOW_MIN)];
    if (minute !== sweptMinute) { sweptMinute = minute; statements.push(sql(LIVE_SWEEP).bind(minute - LIVE_WINDOW_MIN)); }
    const [{ results }] = await db.batch(statements);
    const open = results.filter(row => row.slug).sort((x, y) => natural(x.slug, y.slug));
    return {
      v: 1, windowSec: LIVE_WINDOW_MIN * 60, minSessions: MIN_SESSIONS,
      total: group({}, results.reduce((n, row) => n + row.n, 0), false, () => ({})),
      games: open.map(row => group({ slug: row.slug }, row.n, true, () => ({})))
    };
  }

  return { db, setup, ingest, purge, sweep, kpis, live, close: () => db.close?.() };
}
