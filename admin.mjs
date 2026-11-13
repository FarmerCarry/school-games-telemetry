// The admin API's research reads and the owner's action (docs/RESEARCH_TELEMETRY_SPEC.md,
// §F.4): one game's page, the r_stat metrics and the PCs; and recounting every day. Each
// read takes the rolled days from the rollups and the days not rolled yet from the facts,
// through the rollups' own SELECT, as the KPIs do; the part of the rolled days is kept per
// rollup version (rv), the open part per 10-minute slot on Workers (store.mjs keeps them).
// Sessions are anonymous: nothing here is per child, per profile or per age group, and the
// rows of a day add up whatever their a (rollups.mjs). Every answer takes at most 20
// statements, and JavaScript only merges small rows per day, game or PC. Pure apart from
// the store context it is given (adminViews(ctx)).
import { A_KEYS, METRICS, METRIC_SUMS, ROLLUPS, rollupSelect, statK2 } from './rollups.mjs';

const DAY_MS = 86400000;
// A PC is choppy under 80% smooth frames (as the dashboard's insights say).
const CHOPPY = 0.8;

const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => utcDay(Date.parse(day + 'T00:00:00Z') + n * DAY_MS);
const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
const dayList = (from, to) => Array.from({ length: Math.max(0, daysBetween(from, to)) }, (_, i) => addDays(from, i));
const round = (x, digits) => { const f = 10 ** digits; return Math.round(x * f) / f; };
const ratio = (a, b) => b ? round(a / b, 4) : null;
const minutes = ms => round(ms / 60000, 1);
const natural = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const json = value => JSON.stringify(value);

/* ------------------------------------------------------------ the SQL */
const IN_JSON = n => `(SELECT value FROM json_each(?${n}))`;
// Every value a can hold (rollups.mjs A_KEYS), so that r_stat and r_game_day rows are found by key.
const A_LIST = `(${A_KEYS.map(a => `'${a}'`).join(', ')})`;
// Where a read finds a rollup's rows: the rolled days ?1..?2 of its table (or the days of the
// JSON list ?1, so that a key after the day is found by seeking), or over the days not rolled
// yet (the UTC seconds [?1, ?2)) the rollup's own SELECT over the facts.
const source = (table, alias, scope, list = false) => scope
  ? { from: `(${rollupSelect(table, scope)}) ${alias}`, days: 'true' }
  : { from: `${table} ${alias}`, days: list ? `${alias}.day IN ${IN_JSON(1)}` : `${alias}.day BETWEEN ?1 AND ?2` };
const sums = (alias, columns) => columns.map(c => `TOTAL(${alias}.${c}) AS ${c}`).join(', ');

// One game (?3) over the rolled days of the list ?1 (or the open days): minutes and opens per
// day; r_stat rows (the metrics ?4); and the flows into it from every game, found by key (from
// the session's start, and from each game played on that day). Each as one JSON text of
// arrays (the Worker parses one string, and makes no object per row).
const asArrays = (text, columns) => `SELECT json_group_array(json_array(${columns.join(', ')})) AS rows FROM (${text})`;
const GAME_DAYS = src => asArrays(`SELECT x.day AS day, TOTAL(x.engaged_ms) AS ms, TOTAL(x.opens) AS opens FROM ${src.from} ` +
  `WHERE ${src.days} AND x.a IN ${A_LIST} AND x.slug = ?3 GROUP BY 1`, ['day', 'ms', 'opens']);
const STAT_SUMS = ROLLUPS.r_stat.sums;
const STAT_ROWS = (keys, where, sums = STAT_SUMS) => `SELECT json_group_array(json_array(${[...keys, ...sums].join(', ')})) AS rows FROM (` +
  `SELECT ${keys.map(c => c === 'k2' ? `${statK2('x')} AS k2` : `x.${c} AS ${c}`).join(', ')}, ${sums.map(c => `SUM(x.${c}) AS ${c}`).join(', ')} FROM r_stat x ` +
  `WHERE ${where} GROUP BY ${keys.map((_, i) => i + 1).join(', ')} ORDER BY ${keys.map((_, i) => i + 1).join(', ')})`;
const GAME_STATS = STAT_ROWS(['metric', 'k1', 'k2'], `x.day IN ${IN_JSON(1)} AND x.a IN ${A_LIST} AND x.metric IN ${IN_JSON(4)} AND x.slug = ?3`);
const FLOW_FROM = `SELECT DISTINCT g.day AS day, g.slug AS slug FROM r_game_day g WHERE g.day IN ${IN_JSON(1)} AND g.a IN ${A_LIST} ` +
  "UNION SELECT d.value, '' FROM json_each(?1) d";
const GAME_FLOWS_IN = 'SELECT json_group_array(json_array("from", n)) AS rows FROM (SELECT x.slug AS "from", SUM(x.n) AS n ' +
  `FROM (${FLOW_FROM}) f JOIN r_stat x ON x.day = f.day AND x.a IN ${A_LIST} AND x.metric = 'flow' AND x.slug = f.slug AND x.k1 = ?3 AND x.k2 = '' ` +
  'GROUP BY 1 ORDER BY 1)';

// The r_stat metrics ?2 (a JSON array) over the rolled days of the list ?1, all games or
// the game ?3: only the sums those metrics have, made and kept in kpi_cache by SQL (key ?4,
// rv ?5) unless kept already, then read back.
const statsKept = (one, sums) => `INSERT INTO kpi_cache (key, made, rows) SELECT ?4, ?5, (${STAT_ROWS(['metric', 'slug', 'k1', 'k2'],
  `x.day IN ${IN_JSON(1)} AND x.a IN ${A_LIST} AND x.metric IN ${IN_JSON(2)}${one ? ' AND x.slug = ?3' : ''}`, sums)}) ` +
  'WHERE NOT EXISTS (SELECT 1 FROM kpi_cache WHERE key = ?4)';

// PCs (not '' : v2 and unknown PCs) over the rolled days ?1..?2 (or the open days); the PCs'
// own rows (?1, a JSON array of codes); and the build of the PC seen last since ?1.
const PC_SUMS = ['sessions', 'engaged_ms', 'opens', 'loads', 'load_ms', 'errors', 'f0', 'f1', 'f2', 'f3',
  'il0', 'il1', 'il2', 'il3', 'il4', 'il5'];
const PC_DAYS = src => `SELECT x.p AS p, COUNT(*) AS days, ${sums('x', PC_SUMS)} FROM ${src.from} WHERE ${src.days} AND x.p <> '' GROUP BY 1`;
const PC_INFO = L => `SELECT p, z, k, cores, mem, screen, date(${L('first_s')}, 'unixepoch') AS first_day, ` +
  `date(${L('last_s')}, 'unixepoch') AS last_day FROM st_pcs WHERE p IN ${IN_JSON(1)}`;
const PC_BUILD = 'SELECT k FROM st_pcs WHERE last_s >= ?1 ORDER BY last_s DESC, k LIMIT 1';

// Recount: every rolled day since facts_since (and not trimmed) waits for a recount (dirty
// 3: a diff re-roll, which writes only the rows that changed, so a recount costs a few
// hundred rows a day, not the day's every row twice), unless it already waits for a full
// re-roll; then the days waiting.
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
// stored second), partKeys, lookup and keepParts (kept parts of answers), clock and
// renewed() (after statements that forget kept parts ran).
export function adminViews(ctx) {
  const { sql, bound, run, ensure, spans, wide, partKeys, lookup, keepParts } = ctx;

  // Runs the tasks ([statement, take(result)]) in one batch.
  async function perform(tasks, now, options) {
    if (!tasks.length) return;
    const results = await run(tasks.map(([statement]) => statement), now, options);
    results.forEach((result, i) => tasks[i][1](result));
  }
  // Kept parts of an answer: the closed and open part found.
  async function kept(keys, now) {
    const { found } = await lookup([keys.closed, keys.open], now);
    return { closed: keys.closed && found.get(keys.closed.key), open: keys.open && found.get(keys.open.key) };
  }
  const range = (from, to) => ({ from, to, days: daysBetween(from, to) });
  const answer = (now, fields) => ({ v: 1, ...fields, clock: ctx.clock(now) });

  // GET /v1/admin/game?slug: one game's page: minutes and opens per day, its r_stat rows over
  // the rolled days, and the games before and after it. A game's part over the rolled days
  // (scope null: with its r_stat rows and flows) or a scope's facts: one statement that
  // makes and keeps it in kpi_cache (key ?5, rv ?6) unless kept already (keep: it has a
  // key), as the JSON text of its lists, so it never passes through the Worker on its way
  // in. Made once per scope.
  const gameMade = new Map();
  function gamePart(scope, keep) {
    const key = [scope ? scope.day : '', keep].join(' ');
    let text = gameMade.get(key);
    if (!text) {
      if (gameMade.size >= 16) gameMade.clear();
      const lists = [['days', GAME_DAYS(source('r_game_day', 'x', scope, true))], ...(scope ? [] : [['stats', GAME_STATS], ['flowsIn', GAME_FLOWS_IN]])];
      const part = 'json_object(' + lists.map(([name, list]) => `'${name}', json((${list}))`).join(', ') + ')';
      gameMade.set(key, text = keep ? `INSERT INTO kpi_cache (key, made, rows) SELECT ?5, ?6, ${part} WHERE NOT EXISTS (SELECT 1 FROM kpi_cache WHERE key = ?5)`
        : `SELECT ${part} AS rows`);
    }
    return text;
  }
  async function game({ slug, from, to }, now = Date.now()) {
    await ensure(now);
    const period = spans(from, to, now), keys = partKeys(['game', slug, from, to], period.rolled, period.open, now, { raw: true });
    let { closed, open } = await kept(keys, now);
    const metrics = json(METRICS), rolledDays = period.rolled ? json(dayList(...period.rolled)) : '[]';
    // A part is the JSON text of its lists, made (and kept) by SQL, parsed when used.
    const work = [], made = [];
    const make = (scope, entry) => {
      const values = [...(scope ? period.bounds : [rolledDays, null]), slug, metrics, entry?.key ?? '', ctx.conf().rv];
      work.push(bound(gamePart(scope, !!entry), values));
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
    const byDay = new Map();
    for (const [day, ms, opens] of parts.flatMap(part => part.days || [])) {
      const d = byDay.get(day) || byDay.set(day, { ms: 0, opens: 0 }).get(day);
      d.ms += ms; d.opens += opens;
    }
    const stats = closedPart?.stats || [], flowsOut = new Map();
    for (const row of stats) if (row[0] === 'flow') flowsOut.set(row[1], (flowsOut.get(row[1]) || 0) + row[3]);
    const flowsIn = new Map();
    for (const [from, n] of closedPart?.flowsIn || []) flowsIn.set(from, (flowsIn.get(from) || 0) + n);
    const top = (map, name) => [...map].sort((a, b) => b[1] - a[1] || natural(a[0], b[0])).map(([key, n]) => ({ [name]: key, n }));
    return answer(now, {
      slug, range: range(from, to),
      daily: dayList(from, to).map(day => { const d = byDay.get(day) || { ms: 0, opens: 0 }; return { day, minutes: minutes(d.ms), opens: d.opens }; }),
      stats: { columns: ['metric', 'k1', 'k2', ...STAT_SUMS], rows: stats },
      flowsIn: top(flowsIn, 'from'), flowsOut: top(flowsOut, 'to')
    });
  }

  // GET /v1/admin/stats: r_stat rows of the metrics over the rolled days of the period
  // (up to last night), summed over its days; every game, or one.
  async function stats({ from, to, metrics, slug = null }, now = Date.now()) {
    await ensure(now);
    // The rows stay one JSON text, from SQL to kpi_cache to the answer: an answer of every
    // metric over months has thousands of rows, too many to parse and write again in 10 ms.
    // Its columns: the keys and the sums the metrics have.
    const sums = STAT_SUMS.filter(c => metrics.some(metric => METRIC_SUMS[metric].includes(c)));
    const period = spans(from, to, now), keys = partKeys(['stats', from, to, metrics.join(','), slug], period.rolled, null, now, { raw: true });
    let closed = keys.closed && ctx.keptHere(keys.closed.key, now);
    if (keys.closed && !closed) {
      const values = [json(dayList(...period.rolled)), json(metrics), slug, keys.closed.key, ctx.conf().rv];
      const results = await run([bound(statsKept(!!slug, sums), values), bound('SELECT rows FROM kpi_cache WHERE key = ?1', [keys.closed.key])], now);
      closed = results[1].results[0].rows;
      await keepParts([[keys.closed, closed]], now, { here: true });
    }
    return answer(now, { range: { ...range(from, to), rolledThrough: ctx.conf().rolledThrough }, metrics, slug,
      columns: ['metric', 'slug', 'k1', 'k2', ...sums], rows: new JsonText(closed || '[]') });
  }

  // GET /v1/admin/pcs: every PC with a code that played in the period: days, sessions,
  // minutes, picture smoothness, loading, slow responses, failures; its zone and build, and
  // flags.
  async function pcs({ from, to }, now = Date.now()) {
    await ensure(now);
    const period = spans(from, to, now), keys = partKeys(['pcs', from, to], period.rolled, period.open, now);
    let { closed, open } = await kept(keys, now);
    const lo = ctx.bounds(from).lo, tasks = [];
    const make = scope => {
      const part = { days: [] };
      tasks.push([bound(PC_DAYS(source('r_pc_day', 'x', scope)), scope ? period.bounds : period.rolled), r => { part.days = r.results; }]);
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
    }
    const info = new Map();
    let build = null;
    if (by.size) {
      await perform([[bound(PC_INFO(wide(now).local), [json([...by.keys()])]), r => { for (const row of r.results) info.set(row.p, row); }],
        [bound(PC_BUILD, [lo]), r => { build = r.results[0]?.k ?? null; }]], now);
    }
    return answer(now, {
      range: range(from, to),
      pcs: [...by.values()].sort((a, b) => natural(a.p, b.p)).map(x => {
        const pc = info.get(x.p) || {}, frames = x.f0 + x.f1 + x.f2 + x.f3, il = x.il0 + x.il1 + x.il2 + x.il3 + x.il4 + x.il5;
        const smoothShare = ratio(x.f0, frames), flags = [];
        if (smoothShare !== null && smoothShare < CHOPPY) flags.push('choppy');
        if (build && pc.k && pc.k !== build) flags.push('old');
        return { p: x.p, label: x.p.slice(0, 4).toUpperCase(), firstDay: pc.first_day ?? null, lastDay: pc.last_day ?? null, days: x.days,
          sessions: x.sessions, minutes: minutes(x.engaged_ms), smoothShare,
          stallShare: ratio(x.f3, frames), avgLoadMs: x.loads ? Math.round(x.load_ms / x.loads) : null, slowInputShare: ratio(x.il4 + x.il5, il),
          errors: x.errors, z: pc.z ?? '', build: pc.k ?? '', flags };
      })
    });
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

  return { game, stats, pcs, rebuild };
}
