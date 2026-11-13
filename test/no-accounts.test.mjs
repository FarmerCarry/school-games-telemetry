// The server without student accounts, profiles or age groups (schema 5): an older portal's
// batch (a student code, an age band, a profile's fields, an older code, a removed profile,
// a level-up) is accepted and none of it is stored; the routes of students and cohorts are
// gone; the research files have no student, band or profile column; and the upgrade from
// schema 4 on deploy: on a schema 4 database seeded with students, links, age bands and
// per-student rollups, it leaves none of them, keeps every session, visit, round and rollup
// as schema 5 counts them, stays inside D1's limits per invocation, and is idempotent.
// Twice: on a schema 4 database made here from a schema 5 one (it always runs), and on one
// the schema 4 server itself wrote, from this repository's history (git show; skipped in a
// checkout without that commit).
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { hideSqliteWarning } = await import('../warnings.mjs');
hideSqliteWarning();
const { openDatabase, d1LimitError } = await import('../sqlite-d1.mjs');
const { openStore, SCHEMA_VERSION } = await import('../store.mjs');
const { validateBatch } = await import('../schema.mjs');
const { ROLLUPS, BANDED } = await import('../rollups.mjs');
const { COLUMNS, FILES } = await import('../export.mjs');
const { createApp } = await import('../app.mjs');
const { history } = await import('../simulate.mjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const old3 = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch-v3-accounts.json'), 'utf8'));
const old2 = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch.json'), 'utf8'));
const TOKEN = 'no-accounts-token-0123456789';
const DAY_MS = 86400000, MIN = 60000;
// The commit of this repository whose server is schema 4 (the one before the accounts went).
const SCHEMA_4 = 'c2d24309e4a0642f9fac3cf7dc8ed00be46636b2';
// What schema 4 kept of a student, a profile or an age band, and is gone or empty in schema 5.
const STUDENT_TABLES = ['st_students', 'st_student_pcs', 'st_student_games', 'aliases', 'r_student_day', 'r_student_game'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-no-accounts-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const all = async (db, text, ...values) => (await db.prepare(text).bind(...values).all()).results;
const one = async (db, text, ...values) => (await db.prepare(text).bind(...values).first());
const tables = async db => (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map(r => r.name);
const columns = async (db, table) => (await all(db, `PRAGMA table_info(${table})`)).map(c => c.name);
const keyOf = table => ROLLUPS[table].key.map(([c]) => c).join(', ');
// The rows of the facts and the rollups, in key order: what schema 5 keeps.
async function kept(db) {
  const out = {};
  for (const [table, order] of [['st_sessions', 'id'], ['st_visits', 'sid, n'], ['st_rounds', 'sid, n, k'], ['st_marks', 'sid, kind, t, n, x'], ['st_pcs', 'p'],
    ...Object.keys(ROLLUPS).map(table => [table, keyOf(table)])]) out[table] = await all(db, `SELECT * FROM ${table} ORDER BY ${order}`);
  out.roll_days = (await all(db, 'SELECT day, dirty, rolled_s FROM roll_days ORDER BY day'));
  return out;
}
// Every admin answer and export page of a period, as the dashboard reads them (without the clock).
async function answers(store, from, to, now) {
  const strip = answer => { const copy = JSON.parse(JSON.stringify(answer)); delete copy.clock; return copy; };
  const kpis = strip(await store.kpis({ from, to }, now));
  const out = { kpis, pcs: strip(await store.pcs({ from, to }, now)),
    stats: strip(JSON.parse((await import('../handler.mjs')).serialize(await store.stats({ from, to, metrics: ['hour', 'sesslen', 'games', 'flow', 'persist', 'fatigue', 'tier'], slug: null }, now)))) };
  for (const g of kpis.games.slice(0, 3)) out['game ' + g.slug] = strip(await store.game({ slug: g.slug, from, to }, now));
  for (const file of FILES) {
    let text = '', after = null;
    do { const page = await store.exportPage({ file, from, to, after }, now); text += page.text; after = page.next; } while (after);
    out['export ' + file] = text;
  }
  return out;
}
// The 5-minute cron, each run a new instance (as on Workers), until the upgrade's clearing is done:
// what each run cleared, with the statements and rows it took.
async function clearAll(db, from, step = 5 * MIN) {
  const runs = [], batch = db.batch.bind(db);
  let statements = 0, written = 0;
  db.batch = async list => { statements += list.length; const results = await batch(list); written += results.reduce((n, r) => n + r.meta.rows_written, 0); return results; };
  try {
    for (let i = 0, at = from; i < 200; i++, at += step) {
      statements = 0; written = 0;
      const done = await openStore(db).rollupStep(at);
      if (done.cleared) runs.push({ cleared: done.cleared, statements, written });
      if (done.cleared === 'done') return runs;
    }
  } finally {
    db.batch = batch;
  }
  throw new Error('the clearing never finished: ' + JSON.stringify(runs.slice(-3)));
}
// The upgrade on its own request, as the first request after a deploy meets it: the statements it
// takes (D1's free plan allows 50 per invocation) and the rows it writes.
async function upgrade(db, now) {
  const prepare = db.prepare.bind(db), batch = db.batch.bind(db);
  let prepared = 0, written = 0;
  db.prepare = text => { prepared++; assert.equal(d1LimitError(text), null, text.slice(0, 80)); return prepare(text); };
  db.batch = async list => { const results = await batch(list); written += results.reduce((n, r) => n + r.meta.rows_written, 0); return results; };
  try {
    const store = openStore(db);
    assert.equal(await store.setup(now), 'migrated');
    const step = { prepared, written };
    assert.equal(await store.setup(now), 'ready');
    return step;
  } finally {
    db.prepare = prepare;
    db.batch = batch;
  }
}
// What schema 4 kept of students, profiles and age bands that is still in a database.
async function leftovers(db) {
  const names = await tables(db);
  const out = { tables: names.filter(name => STUDENT_TABLES.includes(name)) };
  out.index = (await all(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'st_sessions_student'")).length;
  out.sessions = (await one(db, "SELECT COUNT(*) AS n FROM st_sessions WHERE u <> '' OR a <> '' OR is_new IS NOT NULL OR age_days IS NOT NULL OR " +
    'since_days IS NOT NULL OR age_b IS NOT NULL OR since_b IS NOT NULL OR level0 IS NOT NULL OR np IS NOT NULL OR cls IS NOT NULL')).n;
  out.attempts = (await one(db, 'SELECT COUNT(*) AS n FROM st_rounds WHERE attempt IS NOT NULL')).n;
  out.marks = (await one(db, "SELECT COUNT(*) AS n FROM st_marks WHERE kind NOT IN ('fv', 'tu', 'ct')")).n;
  out.live = (await columns(db, 'live')).includes('u');
  out.bands = 0;
  for (const table of [...BANDED, ...names.filter(name => name.startsWith('agg_'))]) out.bands += (await one(db, `SELECT COUNT(*) AS n FROM ${table} WHERE a <> ''`)).n;
  out.cleared = 0;
  for (const [table, { cleared = [] }] of Object.entries(ROLLUPS)) {
    if (cleared.length) out.cleared += (await one(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${cleared.map(c => c + ' <> 0').join(' OR ')}`)).n;
  }
  out.metrics = (await one(db, "SELECT COUNT(*) AS n FROM r_stat WHERE metric IN ('daymin', 'attempt', 'tenure') OR metric = 'sesslen' AND k2 NOT IN ('2', '3')")).n;
  return out;
}
const NONE = { tables: [], index: 0, sessions: 0, attempts: 0, marks: 0, live: false, bands: 0, cleared: 0, metrics: 0 };

test('an older portal\'s batch is accepted, v3 and v2, and nothing of its student code, age band, profile, level-ups, removed profiles or older codes is stored', async t => {
  const now = Date.parse('2026-10-20T09:15:00Z'), clock = { now };
  const app = createApp({ dbPath: path.join(tmp, 'accepted.db'), adminToken: TOKEN, now: () => clock.now, dashboardDir: null });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1')).port;
  const post = body => fetch(base + '/v1/batch', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(body) });
  // The older v3 batch has every field the accounts had; so has the v2 one (its band, its profile's session start, a level-up).
  assert.deepEqual([old3.u, old3.a, old3.ev[0].length, ['cd', 'pr', 'lv'].every(kind => old3.ev.some(e => e[0] === kind))], ['3f9a0c51e2b7', '8-9', 8, true]);
  assert.deepEqual([old2.a, old2.ev[0].length, old2.ev.some(e => e[0] === 'lv')], ['6-7', 6, true]);
  for (const body of [old3, old2, { ...old3, b: 'a'.repeat(16), s: 'abcdefabcdef', a: 'SENTINEL-AGE', u: 'not-a-code' }, { ...old3, s: '0123456789ab', a: undefined, u: undefined }]) {
    const res = await post(body);
    assert.equal(res.status, 204, JSON.stringify(body).slice(0, 60));
    assert.equal(await res.text(), '');
  }
  // Its play is stored, every session anonymous.
  const db = app.store.db;
  assert.equal((await one(db, 'SELECT COUNT(*) AS n FROM st_sessions')).n, 4);
  assert.equal((await one(db, 'SELECT COUNT(*) AS n FROM st_rounds')).n, 12);
  assert.deepEqual(await leftovers(db), NONE);
  assert.deepEqual((await all(db, 'SELECT DISTINCT kind FROM st_marks ORDER BY kind')).map(r => r.kind), ['ct', 'fv', 'tu']);
  assert.deepEqual(await tables(db), ['batches', 'kpi_cache', 'live', 'meta', 'r_day', 'r_device_day', 'r_game_day', 'r_level_day', 'r_pc_day', 'r_source_day',
    'r_stat', 'roll_days', 'settings', 'st_marks', 'st_pcs', 'st_rounds', 'st_sessions', 'st_visits', 'usage']);
  // Nowhere in the database, its files included: not the student's code, nor its older code, nor the removed profile's.
  clock.now = now + DAY_MS + 2 * 3600000;
  await app.roll();
  for (const table of await tables(db)) {
    const text = JSON.stringify(await all(db, `SELECT * FROM ${table}`));
    for (const secret of ['3f9a0c51e2b7', '1b2c3d4e5f60', '5e6f7a8b9c0d', 'SENTINEL-AGE', '8-9', '6-7', 'not-a-code']) assert.ok(!text.includes(secret), `${table} holds ${secret}`);
  }
  db.compact();
  const bytes = fs.readFileSync(path.join(tmp, 'accepted.db'));
  for (const secret of ['3f9a0c51e2b7', '1b2c3d4e5f60', '5e6f7a8b9c0d', 'SENTINEL-AGE']) assert.equal(bytes.indexOf(secret), -1, secret);
  // The health check says what this server is.
  assert.deepEqual(await (await fetch(base + '/v1/health')).json(), { ok: true, accepts: [2, 3], schema: 5 });
});

test('the routes of students, a student, cohorts, forget and link answer 404; the export has no student, band or profile column', async t => {
  const app = createApp({ dbPath: ':memory:', adminToken: TOKEN, dashboardDir: null });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1')).port;
  const call = (method, route, body) => fetch(base + '/v1/admin/' + route, { method, headers: { authorization: 'Bearer ' + TOKEN,
    ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  for (const [method, route, body] of [['GET', 'students'], ['GET', 'student?u=3f9a0c51e2b7'], ['GET', 'cohorts'], ['POST', 'forget', { u: '3f9a0c51e2b7' }],
    ['POST', 'link', { u: '3f9a0c51e2b7', to: '1b2c3d4e5f60' }], ['DELETE', 'link?u=3f9a0c51e2b7'], ['GET', 'export?file=students'], ['GET', 'export?file=student_days']]) {
    const res = await call(method, route, body);
    assert.equal(res.status, route.startsWith('export') ? 400 : 404, method + ' ' + route);
    assert.deepEqual(await res.json(), { error: route.startsWith('export') ? 'file' : 'not found' });
  }
  assert.deepEqual(FILES, ['sessions', 'visits', 'rounds', 'events', 'daily_games', 'pcs']);
  for (const [file, list] of Object.entries(COLUMNS)) {
    for (const column of list) assert.doesNotMatch(column, /student|band|profile|guest|level_up|level_start|classroom|attempt|known_before|removed|linked/, file + '.' + column);
  }
  // A session's kind was student, guest or unknown: there is no such column any more (an event's kind is what happened).
  assert.ok(!COLUMNS.sessions.includes('kind') && COLUMNS.events.includes('kind'));
  // The dashboard's data dictionary lists exactly these columns.
  const window = {};
  new Function('window', fs.readFileSync(path.join(repo, 'dashboard/dictionary.js'), 'utf8'))(window);
  assert.deepEqual(Object.fromEntries(window.SGDictionary.FILES.filter(f => FILES.includes(f.file)).map(f => [f.file, f.columns.map(c => c[0])])), COLUMNS);
});

// Schema 4's tables and columns that schema 5 has no more, as schema 4's store created them.
const SCHEMA_4_STUDENTS = [
  'CREATE TABLE st_students (u TEXT PRIMARY KEY, label TEXT NOT NULL, first_s INTEGER NOT NULL, last_s INTEGER NOT NULL, ' +
    'band_first TEXT NOT NULL, band_last TEXT NOT NULL, age_days_first INTEGER, removed_s INTEGER) STRICT, WITHOUT ROWID',
  'CREATE TABLE st_student_pcs (u TEXT NOT NULL, p TEXT NOT NULL, first_s INTEGER NOT NULL, PRIMARY KEY (u, p)) STRICT, WITHOUT ROWID',
  'CREATE TABLE st_student_games (u TEXT NOT NULL, slug TEXT NOT NULL, rounds INTEGER NOT NULL, first_s INTEGER NOT NULL, PRIMARY KEY (u, slug)) STRICT, WITHOUT ROWID',
  'CREATE TABLE aliases (u_old TEXT PRIMARY KEY, u_new TEXT NOT NULL, s INTEGER NOT NULL, how TEXT NOT NULL) STRICT, WITHOUT ROWID',
  'CREATE TABLE r_student_day (day TEXT NOT NULL, u TEXT NOT NULL, a TEXT NOT NULL DEFAULT \'\', sessions INTEGER NOT NULL DEFAULT 0, ' +
    'engaged_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, u)) STRICT, WITHOUT ROWID',
  'CREATE INDEX r_student_day_u ON r_student_day (u, day)',
  'CREATE TABLE r_student_game (day TEXT NOT NULL, slug TEXT NOT NULL, u TEXT NOT NULL, a TEXT NOT NULL DEFAULT \'\', rounds INTEGER NOT NULL DEFAULT 0, ' +
    'PRIMARY KEY (day, slug, u)) STRICT, WITHOUT ROWID',
  'CREATE INDEX r_student_game_u ON r_student_game (u, day)',
  'CREATE INDEX st_sessions_student ON st_sessions (u, start_s)'
];
// A schema 5 database written back to what schema 4 would have held for the same play: a
// student code, an age band and a profile's fields on its sessions (a third of them guests),
// attempt numbers on rounds, level-ups, removed profiles and older codes as marks, students
// with their PCs, games and links, per-student rollups, every school-wide rollup row split
// into two age bands (sums shared out, largest values kept), student counts in every rollup,
// r_stat's per-student metrics and its kinds of session, live rows with codes and kept
// answers that name students.
async function asSchema4(db) {
  const code = n => `printf('%012x', ${n})`;
  const stmts = [
    ...SCHEMA_4_STUDENTS,
    `UPDATE st_sessions SET u = CASE WHEN id % 3 = 0 THEN '' ELSE ${code('100000 + id % 40')} END, a = CASE id % 4 WHEN 0 THEN '6-7' WHEN 1 THEN '8-9' WHEN 2 THEN '10-11' ELSE '' END, ` +
      'is_new = id % 2, age_days = id % 90, since_days = id % 5, age_b = 1, since_b = 2, level0 = id % 9, np = 12, cls = 1',
    'UPDATE st_rounds SET attempt = k WHERE code IS NOT NULL',
    "INSERT INTO st_marks (sid, kind, t, n, x) SELECT id, 'lv', 5, 0, '4' FROM st_sessions WHERE id % 2 = 0",
    `INSERT INTO st_marks (sid, kind, t, n, x) SELECT id, 'pr', 0, 0, ${code('200000 + id')} FROM st_sessions WHERE id % 50 = 0`,
    `INSERT INTO st_marks (sid, kind, t, n, x) SELECT id, 'cd', 0, 0, ${code('300000 + id')} FROM st_sessions WHERE id % 70 = 0`,
    "INSERT INTO st_students (u, label, first_s, last_s, band_first, band_last, age_days_first, removed_s) SELECT u, upper(substr(u, 1, 4)), MIN(start_s), MAX(start_s), " +
      "'8-9', '8-9', 30, NULL FROM st_sessions WHERE u <> '' GROUP BY u",
    "INSERT INTO st_student_pcs (u, p, first_s) SELECT u, p, MIN(start_s) FROM st_sessions WHERE u <> '' AND p <> '' GROUP BY u, p",
    "INSERT INTO st_student_games (u, slug, rounds, first_s) SELECT s.u, r.slug, COUNT(*), MIN(s.start_s) FROM st_sessions s JOIN st_rounds r ON r.sid = s.id WHERE s.u <> '' GROUP BY 1, 2",
    `INSERT INTO aliases (u_old, u_new, s, how) SELECT x, (SELECT u FROM st_sessions WHERE id = sid), 1, 'pc' FROM st_marks WHERE kind = 'cd' AND (SELECT u FROM st_sessions WHERE id = sid) <> ''`,
    "INSERT INTO r_student_day (day, u, a, sessions) SELECT date(start_s, 'unixepoch'), u, a, COUNT(*) FROM st_sessions WHERE u <> '' GROUP BY 1, 2",
    "INSERT INTO r_student_game (day, slug, u, rounds) SELECT date(s.start_s, 'unixepoch'), r.slug, s.u, COUNT(*) FROM st_sessions s JOIN st_rounds r ON r.sid = s.id WHERE s.u <> '' GROUP BY 1, 2, 3",
    // r_stat's kinds of session: students (s) and guests (g) where schema 5 has the current portal ('3'), the old portal (u) for '2'.
    "UPDATE r_stat SET k2 = 's' WHERE metric = 'sesslen' AND k2 = '3'", "UPDATE r_stat SET k2 = 'u' WHERE metric = 'sesslen' AND k2 = '2'"
  ];
  // Every row of a table with a, split into the bands 6-7 (half of each sum, rounded down) and 8-9 (the rest); the largest values in both.
  for (const table of BANDED) {
    const { key, sums, cleared = [] } = ROLLUPS[table], keys = key.map(([c]) => c), largest = new Set(['score_max', 'load_max']);
    stmts.push(`INSERT INTO ${table} (${[...keys, ...sums, ...cleared].join(', ')}) SELECT ${keys.map(c => c === 'a' ? "'8-9'" : c).join(', ')}, ` +
      `${sums.map(c => largest.has(c) ? c : `${c} - ${c} / 2`).join(', ')}${cleared.map(() => ', 7').join('')} FROM ${table} WHERE a = ''`,
    `UPDATE ${table} SET ${[...sums.filter(c => !largest.has(c)).map(c => `${c} = ${c} / 2`), ...cleared.map(c => `${c} = 3`), "a = '6-7'"].join(', ')} WHERE a = ''`);
  }
  // A guest's sessions as their own kind; the per-student metrics.
  stmts.push("UPDATE r_stat SET k2 = 'g' WHERE metric = 'sesslen' AND k2 = 's' AND a = '8-9'",
    "INSERT INTO r_stat (day, a, metric, slug, k1, k2, n, students, ms) SELECT day, '6-7', 'daymin', '', '10', '', 5, 5, 3000000 FROM roll_days",
    "INSERT INTO r_stat (day, a, metric, slug, k1, k2, n, students, w, wall_ms, score_sum, dda_n) SELECT day, '8-9', 'attempt', 'road-hopper', '1', '', 4, 2, 1, 9000, 40, 1 FROM roll_days",
    "INSERT INTO r_stat (day, a, metric, slug, k1, k2, n, students, tier_sum, tier_n) SELECT day, '', 'tenure', 'road-hopper', '0', '', 3, 1, 6, 3 FROM roll_days",
    'UPDATE r_pc_day SET students = 2, guests = 1, np_max = 12, new_profiles = 1',
    'DROP TABLE live',
    "CREATE TABLE live (s TEXT PRIMARY KEY, slug TEXT NOT NULL, seen_minute INTEGER NOT NULL, u TEXT NOT NULL DEFAULT '', p TEXT NOT NULL DEFAULT '', wire INTEGER NOT NULL DEFAULT 2) STRICT, WITHOUT ROWID",
    "INSERT INTO live (s, slug, seen_minute, u, p, wire) SELECT s, '', 1, u, p, wire FROM st_sessions ORDER BY id DESC LIMIT 5",
    `INSERT INTO kpi_cache (key, made, rows) VALUES ('["students"]', '9', '{"students":[{"u":"' || ${code(100001)} || '","band":"8-9"}]}')`,
    "DELETE FROM settings WHERE key IN ('scrub', 'scrub_id', 'scrub_end', 'scrub_day')", "UPDATE meta SET value = 4 WHERE key = 'schema'");
  await db.batch(stmts.map(text => db.prepare(text)));
}

// A school of 600 children (simulate.mjs) over `days`, its days rolled each night, into the store's database.
async function school(store, { days, sessions, seed, now }) {
  const { schoolDays } = await import('../simulate.mjs');
  for (const day of schoolDays({ days, sessions, seed, now })) {
    for (const { batch, now: at } of day.batches) await store.ingest(validateBatch(batch), at);
    const night = Date.parse(day.day + 'T00:00:00Z') - 3 * 3600000 + DAY_MS + 65 * MIN;
    if (night < now) for (let i = 0; i < 40 && (await store.rollupStep(night + i * 300000)).rolled; i++);
  }
}

test('the upgrade from schema 4 on a database seeded with students and age bands leaves none of them, and keeps the facts and the rollups as schema 5 counts them', async () => {
  const now = Date.parse('2026-10-22T09:30:00Z'), file = path.join(tmp, 'seeded.db');
  const db = openDatabase(file), store = openStore(db);
  await school(store, { days: 12, sessions: 80, seed: 8, now });
  // Past every roll, on a new UTC day (the clearing waits for room in the day's free writes).
  const at = now + 2 * DAY_MS;
  for (let i = 0; i < 20 && (await store.rollupStep(at + i * 300000)).rolled; i++);
  const before = await kept(db), said = await answers(store, '2026-10-01', '2026-10-24', at);
  assert.ok(before.st_sessions.length > 500, before.st_sessions.length + ' sessions: more than one chunk of the clearing');
  assert.ok(before.r_stat.length > 1000 && before.roll_days.length >= 8);
  assert.deepEqual(await leftovers(db), NONE);

  await asSchema4(db);
  const seeded = await leftovers(db);
  for (const [what, n] of Object.entries(seeded)) assert.ok(what === 'tables' ? n.length === STUDENT_TABLES.length : n, `seeded: ${what}`);
  const codes = (await all(db, 'SELECT u FROM st_students')).map(r => r.u).concat((await all(db, 'SELECT u_old FROM aliases')).map(r => r.u_old));
  assert.ok(codes.length > 40);

  // The deploy: the first request upgrades the database and does nothing else, in a few statements whose writes do not grow with the facts.
  const step = await upgrade(db, at + MIN);
  assert.ok(step.prepared <= 45, `the upgrade took ${step.prepared} statements`);
  assert.ok(step.written < 300, `the upgrade wrote ${step.written} rows`);
  assert.deepEqual((await all(db, 'SELECT value FROM meta')).map(r => r.value), [SCHEMA_VERSION]);
  const upgraded = await leftovers(db);
  assert.deepEqual([upgraded.tables, upgraded.index, upgraded.live, upgraded.marks > 0], [[], 0, false, true], 'the student tables, the codes in live and removed profiles go at once');
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM st_marks WHERE kind IN ('pr', 'cd')")).n, 0);
  assert.deepEqual(await all(db, 'SELECT * FROM kpi_cache'), []);
  const settings = Object.fromEntries((await all(db, "SELECT key, value FROM settings WHERE key LIKE 'scrub%'")).map(r => [r.key, r.value]));
  assert.deepEqual(settings, { scrub: '1', scrub_day: '', scrub_end: String(before.st_sessions.at(-1).id), scrub_id: '0' });
  // Every answer is already what it was, before the clearing (reads add up the rows of every a, and read none of the cleared columns).
  assert.deepEqual(await answers(openStore(db), '2026-10-01', '2026-10-24', at + 2 * MIN), said);
  // An older Worker instance still running schema 4's code cannot write: its batches fail (the portal sends them again).
  await assert.rejects(db.prepare("INSERT INTO live (s, slug, seen_minute, u, p, wire) VALUES ('x', '', 1, '', '', 3)").run(), /no column named u|has no column/);

  // The 5-minute cron clears the rest, a bounded step a run: the facts in chunks, then the rollups a few days at a time.
  const runs = await clearAll(db, at + 5 * MIN);
  assert.deepEqual(runs.filter(r => r.cleared === 'facts').length, 2, JSON.stringify(runs.map(r => r.cleared)));
  assert.ok(runs.filter(r => Array.isArray(r.cleared)).length >= 1);
  for (const run of runs) {
    assert.ok(run.statements <= 35, `a run took ${run.statements} statements`);
    assert.ok(run.written <= 25000, `a run wrote ${run.written} rows`);
  }
  assert.deepEqual(await leftovers(db), NONE);
  const after1 = await kept(db);
  for (const table of Object.keys(before)) assert.deepEqual(after1[table], before[table], 'the facts and the rollups as schema 5 wrote them: ' + table);
  assert.deepEqual(await answers(openStore(db), '2026-10-01', '2026-10-24', at + DAY_MS), said);
  // Nothing of the codes is left in the database file either.
  db.compact();
  const bytes = fs.readFileSync(file);
  for (const u of codes) assert.equal(bytes.indexOf(u), -1, u);

  // Idempotent: the clearing again (as after a retry) changes nothing.
  await db.batch([db.prepare("UPDATE settings SET value = CASE key WHEN 'scrub' THEN '1' WHEN 'scrub_id' THEN '0' WHEN 'scrub_end' THEN ?1 ELSE '' END WHERE key LIKE 'scrub%'")
    .bind(String(before.st_sessions.at(-1).id))]);
  const again = await clearAll(db, at + 3 * 3600000);
  assert.ok(again.every(run => run.written <= run.statements + 2), 'no row is written again: ' + JSON.stringify(again));
  assert.deepEqual(await kept(db), before);
  db.close();
});

test('an upgrade that fails part-way changes nothing, and the next request upgrades in full', async () => {
  const now = Date.parse('2026-10-22T09:30:00Z'), db = openDatabase(':memory:');
  await school(openStore(db), { days: 3, sessions: 20, seed: 2, now });
  await asSchema4(db);
  const before = { tables: await tables(db), rows: await all(db, 'SELECT COUNT(*) AS n FROM st_students') };
  const batch = db.batch.bind(db);
  let failed = false;
  db.batch = async list => {
    if (!failed && list.some(st => /^DROP TABLE IF EXISTS st_students/.test(st.sql))) {
      failed = true;
      // The statements run in one transaction, as D1 runs a batch: the last one fails, after the drops.
      await assert.rejects(batch([...list.slice(0, -1), db.prepare('SELECT no_such_column FROM meta')]));
      throw new Error('D1_ERROR: Network connection lost.');
    }
    return batch(list);
  };
  await assert.rejects(openStore(db).setup(now + DAY_MS), /Network connection lost/);
  assert.deepEqual({ tables: await tables(db), rows: await all(db, 'SELECT COUNT(*) AS n FROM st_students') }, before);
  assert.equal((await one(db, "SELECT value FROM meta WHERE key = 'schema'")).value, 4);
  db.batch = batch;
  await upgrade(db, now + DAY_MS);
  assert.deepEqual((await leftovers(db)).tables, []);
});

// Every .mjs file of a commit of this repository, in a folder of its own (null when the commit is not here).
function fromGit(commit) {
  const listed = spawnSync('git', ['ls-tree', '--name-only', commit], { cwd: repo, encoding: 'utf8' });
  if (listed.status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(tmp, 'schema4-'));
  for (const file of listed.stdout.split('\n').filter(name => name.endsWith('.mjs'))) {
    const shown = spawnSync('git', ['show', `${commit}:${file}`], { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (shown.status !== 0) return null;
    fs.writeFileSync(path.join(dir, file), shown.stdout);
  }
  return dir;
}
const schema4Dir = fromGit(SCHEMA_4);
const skip4 = !schema4Dir && `commit ${SCHEMA_4.slice(0, 7)} (the schema 4 server) is not in this checkout`;

test('the upgrade of a database the schema 4 server wrote (students, links, removed profiles, bands, per-student rollups, kept answers) gives what schema 5 would have stored', { skip: skip4 }, async () => {
  const old = await import(pathToFileURL(path.join(schema4Dir, 'store.mjs')).href);
  const oldSchema = await import(pathToFileURL(path.join(schema4Dir, 'schema.mjs')).href);
  const oldSimulate = await import(pathToFileURL(path.join(schema4Dir, 'simulate.mjs')).href);
  const now = Date.parse('2026-10-22T09:30:00Z'), at = now + 2 * DAY_MS, file = path.join(tmp, 'live.db');
  // The same batches (schema 4's school: student codes, age bands, profiles, older codes, removed profiles, level-ups)
  // into schema 4's store and into a new schema 5 one, each day rolled the next night by each store's own cron.
  const db4 = openDatabase(file), store4 = old.openStore(db4), db5 = openDatabase(':memory:'), store5 = openStore(db5);
  for (const day of oldSimulate.schoolDays({ days: 10, sessions: 70, seed: 6, now })) {
    for (const { batch, now: time } of day.batches) {
      assert.equal(await store4.ingest(oldSchema.validateBatch(batch), time), await store5.ingest(validateBatch(batch), time));
    }
    const night = Date.parse(day.day + 'T00:00:00Z') - 3 * 3600000 + DAY_MS + 65 * MIN;
    if (night < now) {
      for (let i = 0; i < 40; i++) {
        const [a, b] = [await store4.rollupStep(night + i * 300000), await store5.rollupStep(night + i * 300000)];
        assert.equal(a.rolled, b.rolled);
        if (!a.rolled) break;
      }
    }
  }
  for (const store of [store4, store5]) for (let i = 0; i < 20 && (await store.rollupStep(at + i * 300000)).rolled; i++);
  // The dashboard's last reads, kept in kpi_cache; and a few sessions playing (live) as the deploy happens.
  await store4.kpis({ from: '2026-10-01', to: '2026-10-24', band: null }, at);
  const students = JSON.parse((await import(pathToFileURL(path.join(schema4Dir, 'handler.mjs')).href)).serialize(
    await store4.students({ from: '2026-10-01', to: '2026-10-24', band: null }, at))).students;
  await store4.student({ u: students[0].u, from: '2026-10-01', to: '2026-10-24' }, at);
  await store4.cohorts({ from: '2026-10-01', to: '2026-10-24', band: null }, at);
  const late = { ...JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch-v3-accounts.json'), 'utf8')), w: 30 };
  await store4.ingest(oldSchema.validateBatch(late), at + 30000);
  await store5.ingest(validateBatch(late), at + 30000);
  const seeded = await leftovers(db4);
  for (const [what, n] of Object.entries(seeded)) assert.ok(what === 'tables' ? n.length === STUDENT_TABLES.length : n, `schema 4 wrote ${what}`);
  assert.ok((await one(db4, 'SELECT COUNT(*) AS n FROM st_students')).n > 100 && (await one(db4, 'SELECT COUNT(*) AS n FROM aliases')).n > 0);
  assert.ok((await one(db4, "SELECT COUNT(*) AS n FROM live WHERE u <> ''")).n > 0 && (await one(db4, 'SELECT COUNT(*) AS n FROM kpi_cache')).n > 0);
  const codes = (await all(db4, 'SELECT u FROM st_students')).map(r => r.u);
  const expected = await kept(db5), said = await answers(store5, '2026-10-01', '2026-10-24', at + MIN);
  // Schema 4 rounded each game's wall-clock seconds per day and age band (r_game_day.wall_s), so the bands of a day
  // add up to within half a second each of the day's own rounding: the one number its rows can hold differently.
  const wall = (rows, other) => rows.map((row, i) => {
    assert.ok(Math.abs(row.wall_s - other[i].wall_s) <= 2, `${row.day} ${row.slug}: ${row.wall_s} and ${other[i].wall_s}`);
    return { ...row, wall_s: null };
  });
  const rounded = answer => {
    const copy = JSON.parse(JSON.stringify(answer));
    for (const g of copy.kpis.games) { delete g.wallMinutes; delete g.actionsPerMinute; }
    return copy;
  };

  // The deploy: one request upgrades, inside D1's limits.
  const step = await upgrade(db4, at + MIN);
  assert.ok(step.prepared <= 45, `the upgrade took ${step.prepared} statements`);
  assert.ok(step.written < 500, `the upgrade wrote ${step.written} rows`);
  assert.deepEqual(rounded(await answers(openStore(db4), '2026-10-01', '2026-10-24', at + MIN)), rounded(said), 'the answers before the clearing');
  // Then the cron.
  const runs = await clearAll(db4, at + 5 * MIN);
  for (const run of runs) assert.ok(run.statements <= 35 && run.written <= 25000, JSON.stringify(run));
  assert.deepEqual(await leftovers(db4), NONE);
  const got = await kept(db4);
  got.r_game_day = wall(got.r_game_day, expected.r_game_day);
  expected.r_game_day = expected.r_game_day.map(row => ({ ...row, wall_s: null }));
  for (const table of Object.keys(expected)) assert.deepEqual(got[table], expected[table], 'every fact and rollup row as schema 5 stores the same batches: ' + table);
  assert.deepEqual(rounded(await answers(openStore(db4), '2026-10-01', '2026-10-24', at + DAY_MS)), rounded(said));
  db4.compact();
  const bytes = fs.readFileSync(file);
  assert.deepEqual(codes.filter(u => bytes.indexOf(u) >= 0), [], 'no student code is left in the file');
  db4.close();
});
