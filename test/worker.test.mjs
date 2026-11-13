// The Cloudflare Worker entry (server/worker.mjs) driven with real Fetch-API Requests,
// with env.DB a D1-style database over node:sqlite (server/sqlite-d1.mjs) and env.ASSETS a
// stub: D1's free-plan limits per invocation (the request that upgrades the database does
// only that and is answered 503), the batch interval, the usage meter, the 5-minute cron's
// rollups, the KPI and research parts kept in D1 and the CPU the admin answers take outside
// SQLite. (The upgrade from schema 4, from this repository's own history, is test/upgrade.test.mjs.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sqlite-d1.mjs hides node:sqlite's ExperimentalWarning before it loads node:sqlite.
const { openDatabase } = await import('../sqlite-d1.mjs');
const { default: worker } = await import('../worker.mjs');
const { openStore, TABLES, SCHEMA_VERSION } = await import('../store.mjs');
const { validateBatch } = await import('../schema.mjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch.json'), 'utf8'));
const fixture3 = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch-v3.json'), 'utf8'));
const wrangler = JSON.parse(fs.readFileSync(path.join(repo, 'wrangler.json'), 'utf8'));
const ORIGIN = 'https://farmercarry.github.io';
const TOKEN = 'worker-admin-token-0123456789';
const BASE = 'https://school-games-telemetry.example.workers.dev';
const DAY_MS = 86400000;
const START = Date.parse('2026-10-20T09:15:00Z');
const z6 = [0, 0, 0, 0, 0, 0], z4 = [0, 0, 0, 0];
const ctx = { waitUntil() {}, passThroughOnException() {} };
const U = '3f9a0c51e2b7', P = '8c21d0e94a6f';

let batchSeq = 0;
const batchId = () => (0xe000000000000000n + BigInt(++batchSeq)).toString(16);
const envelope = (s, ev, extra = {}) => ({ v: 2, b: batchId(), s, k: 'src', m: 'web', a: '6-7', d: [4, 4, 1920], ev, ...extra });
const envelope3 = (s, ev, extra = {}) => ({ v: 3, b: batchId(), s, k: 'src', m: 'web', a: '8-9', d: [4, 4, 1920], u: U, p: P, z: '', ev,
  w: Math.max(0, ...ev.map(e => e[1])) + 5, ...extra });

// Brings a database to the current schema, as the first requests after a deploy do.
async function upgrade(db, now = Date.now()) {
  const store = openStore(db);
  while (await store.setup(now) === 'migrated');
}
// The bindings and variables wrangler.json gives the Worker, with a test database (at the
// current schema unless fresh) and password.
async function makeEnv(extra = {}, { fresh = false } = {}) {
  const assets = [];
  const env = {
    ...wrangler.vars, ADMIN_TOKEN: TOKEN, DB: openDatabase(':memory:'),
    ASSETS: {
      async fetch(request) {
        assets.push(request.method + ' ' + new URL(request.url).pathname);
        return new Response('<!doctype html><title>asset</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    },
    assets, ...extra
  };
  if (!fresh && env.DB) await upgrade(env.DB);
  return env;
}
// A database as milestone 2 left it (schema 3: the daily aggregates, seen and the old live table).
async function milestone2(db) {
  const keyList = key => ['day', 'a', ...key].join(', ');
  await db.batch([
    'CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT, WITHOUT ROWID',
    'CREATE TABLE batches (b TEXT PRIMARY KEY, day TEXT NOT NULL) STRICT, WITHOUT ROWID',
    'CREATE TABLE seen (day TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, s TEXT NOT NULL, PRIMARY KEY (day, kind, key, s)) STRICT, WITHOUT ROWID',
    'CREATE TABLE live (s TEXT PRIMARY KEY, slug TEXT NOT NULL, seen_minute INTEGER NOT NULL) STRICT, WITHOUT ROWID',
    'CREATE TABLE kpi_cache (key TEXT PRIMARY KEY, made TEXT NOT NULL, rows TEXT NOT NULL) STRICT, WITHOUT ROWID',
    ...Object.entries(TABLES).map(([table, { key, sums, cleared = [] }]) => `CREATE TABLE ${table} (day TEXT NOT NULL, a TEXT NOT NULL, ` +
      key.map(c => `${c} ${['slug', 'id', 'src'].includes(c) ? 'TEXT' : 'INTEGER'} NOT NULL, `).join('') +
      [...sums, ...cleared].map(c => `${c} INTEGER NOT NULL DEFAULT 0, `).join('') + `PRIMARY KEY (${keyList(key)})) STRICT, WITHOUT ROWID`),
    "INSERT INTO meta (key, value) VALUES ('schema', 3)",
    "INSERT INTO agg_days (day, a, sessions, opens) VALUES ('2026-10-19', '6-7', 3, 4)"
  ].map(text => db.prepare(text)));
  return db;
}
async function call(env, method, pathname, { headers = {}, body, ip = '203.0.113.9' } = {}) {
  const request = new Request(BASE + pathname, { method, body, headers: { ...(ip ? { 'CF-Connecting-IP': ip } : {}), ...headers } });
  const res = await worker.fetch(request, env, ctx);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}
const post = (env, body, { origin = ORIGIN, ...rest } = {}) => call(env, 'POST', '/v1/batch', {
  ...rest, body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...(origin ? { Origin: origin } : {}), ...rest.headers }
});
const admin = (env, pathname, token = TOKEN) => call(env, 'GET', pathname, { headers: { Authorization: 'Bearer ' + token } });
const rows = async (env, table) => (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
const scheduled = (env, cron = wrangler.triggers.crons[0]) => worker.scheduled({ scheduledTime: Date.now(), cron }, env, ctx);
// The Worker reads the time from Date.now(); the test moves it with clock.now.
function useClock(t) {
  const clock = { now: START };
  t.mock.method(Date, 'now', () => clock.now);
  return clock;
}
// The statements each piece of work prepares: D1's free plan allows 50 per invocation.
function counted(env) {
  const prepare = env.DB.prepare.bind(env.DB), counter = { n: 0, sql: [] };
  env.DB.prepare = sql => { counter.n++; counter.sql.push(sql); return prepare(sql); };
  return async work => { counter.n = 0; counter.sql = []; const result = await work(); return { n: counter.n, sql: counter.sql, result }; };
}

test('the Node driver binds values the way D1 does, so the tests see what D1 would do', async () => {
  const db = openDatabase(':memory:');
  // D1 binds every number, and a boolean, as REAL (wrangler dev: typeof(?1) is 'real').
  assert.deepEqual((await db.prepare('SELECT ?1 / 2 AS x, typeof(?1) AS a, typeof(?2) AS b').bind(7, true).all()).results,
    [{ x: 3.5, a: 'real', b: 'real' }]);
  // A STRICT INTEGER column still stores a whole number as an integer, and refuses 1.5.
  await db.prepare('CREATE TABLE t (v INTEGER NOT NULL) STRICT').run();
  await db.prepare('INSERT INTO t (v) VALUES (?1)').bind(5).run();
  assert.deepEqual((await db.prepare('SELECT v, typeof(v) AS t FROM t').all()).results, [{ v: 5, t: 'integer' }]);
  await assert.rejects(db.prepare('INSERT INTO t (v) VALUES (?1)').bind(1.5).run(), /^Error: D1_ERROR: cannot store REAL value/);
  for (const value of [undefined, 5n, {}]) assert.throws(() => db.prepare('SELECT ?1').bind(value), /^TypeError: D1_TYPE_ERROR/);
  // D1 runs every statement of one prepare and answers with the last; node:sqlite would run
  // only the first, so the driver refuses more than one.
  await assert.rejects(db.prepare('SELECT 1 AS a; SELECT 2 AS b').all(), /^Error: D1_ERROR: one statement per query/);
  assert.deepEqual((await db.prepare('SELECT 1 AS a; -- a comment\n').all()).results, [{ a: 1 }]);
});


test('the Node driver bills what D1 bills: a row per index entry written, and the database size', async () => {
  const db = openDatabase(':memory:');
  await db.batch([db.prepare('CREATE TABLE a (k TEXT PRIMARY KEY, v INTEGER) STRICT, WITHOUT ROWID'),
    db.prepare('CREATE TABLE b (id INTEGER PRIMARY KEY, s TEXT NOT NULL UNIQUE, u TEXT, t INTEGER)'),
    db.prepare('CREATE INDEX b_u ON b (u, t)'), db.prepare('CREATE INDEX b_t ON b (t)')]);
  const results = await db.batch([
    db.prepare("INSERT INTO a VALUES ('x', 1), ('y', 2)"), db.prepare("INSERT INTO b (s, u, t) VALUES ('s1', 'u', 1)"),
    db.prepare("INSERT INTO b (s, u, t) VALUES ('s1', 'u', 2) ON CONFLICT (s) DO UPDATE SET t = excluded.t"),
    db.prepare("UPDATE b SET u = 'v' WHERE s = 's1'"), db.prepare("DELETE FROM a WHERE k = 'x'"), db.prepare('SELECT * FROM b'),
    db.prepare("INSERT OR IGNORE INTO a VALUES ('y', 1) RETURNING k"), db.prepare("INSERT INTO a VALUES ('z', 3) RETURNING k")
  ]);
  // A WITHOUT ROWID table is its primary key; b has UNIQUE (s) and two indexes.
  assert.deepEqual(results.map(r => [r.meta.changes, r.meta.rows_written, r.meta.rows_read]),
    [[2, 2, 0], [1, 4, 0], [1, 4, 0], [1, 4, 0], [1, 1, 0], [0, 0, 1], [0, 0, 0], [1, 1, 1]]);
  const size = db.sqlite.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get().n;
  assert.ok(size > 0 && results.every(r => r.meta.size_after === size));
  // A new index is billed from the next statement on.
  await db.prepare('CREATE INDEX a_v ON a (v)').run();
  assert.equal((await db.prepare("INSERT INTO a VALUES ('w', 4)").run()).meta.rows_written, 2);
});

test('wrangler.json binds what the Worker reads and keeps request logs off', () => {
  assert.equal(wrangler.main, 'worker.mjs');
  assert.deepEqual(wrangler.d1_databases, [{ binding: 'DB', database_name: 'school-games-telemetry' }], 'no database_id: Wrangler provisions it');
  assert.deepEqual(wrangler.assets, { directory: './dashboard', binding: 'ASSETS' });
  assert.deepEqual(wrangler.vars, { ALLOWED_ORIGINS: ORIGIN, RETENTION_DAYS: '400' });
  assert.deepEqual(wrangler.triggers, { crons: ['23 3 * * *', '*/5 * * * *'] }, 'the daily purge and the 5-minute rollups');
  assert.deepEqual(wrangler.observability, { enabled: false });
  assert.ok(Date.parse(wrangler.compatibility_date) <= Date.now() - 14 * DAY_MS, 'a compatibility date at least two weeks old');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.devDependencies, { wrangler: '4.149.0' });
  assert.equal(pkg.dependencies, undefined, 'no runtime dependency');
  assert.deepEqual(Object.keys(pkg.cloudflare.bindings).sort(), ['ADMIN_TOKEN', 'DB']);
  assert.equal(fs.readFileSync(path.join(repo, '.dev.vars.example'), 'utf8'), 'ADMIN_TOKEN=\n', 'the password is asked for, never suggested');
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/wrangler'].version, '4.149.0');
  // The folder is deployed on its own: nothing it imports lives outside it.
  for (const file of fs.readdirSync(repo).filter(name => name.endsWith('.mjs'))) {
    const source = fs.readFileSync(path.join(repo, file), 'utf8');
    for (const [, spec] of source.matchAll(/^import\s[^;]*?from\s+'([^']+)'|\bimport\(\s*'([^']+)'/gm).map(m => [m[0], m[1] ?? m[2]])) {
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `${file} imports ${spec}`);
    }
  }
});


test('the Worker stores a batch from the portal once, with CORS and the batch interval for the portal only', async t => {
  useClock(t);
  const env = await makeEnv();
  const res = await post(env, fixture);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('access-control-expose-headers'), 'Retry-After, X-Batch-Every');
  assert.equal(res.headers.get('x-batch-every'), '60');
  assert.equal(res.headers.get('access-control-allow-credentials'), null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('vary'), /\bOrigin\b/);
  const before = await rows(env, 'st_rounds');
  assert.equal((await post(env, fixture)).status, 204, 'a repeat is answered the same');
  assert.deepEqual(await rows(env, 'st_rounds'), before, 'and adds nothing');
  assert.deepEqual(await rows(env, 'batches'), [{ b: fixture.b, day: '2026-10-20' }]);
  assert.equal((await rows(env, 'st_visits')).length, 2);
  // v3 needs no batch id: its repeat changes nothing either.
  assert.equal((await post(env, fixture3)).status, 204);
  const facts = JSON.stringify(await Promise.all(['st_sessions', 'st_visits', 'st_rounds', 'st_marks', 'st_pcs'].map(table => rows(env, table))));
  assert.equal((await post(env, fixture3)).status, 204);
  assert.equal(JSON.stringify(await Promise.all(['st_sessions', 'st_visits', 'st_rounds', 'st_marks', 'st_pcs'].map(table => rows(env, table)))), facts);
  assert.deepEqual((await rows(env, 'batches')).length, 1);

  for (const origin of ['https://evil.example', 'http://farmercarry.github.io', 'null']) {
    const denied = await post(env, { ...fixture, b: batchId() }, { origin });
    assert.equal(denied.status, 403, origin);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.equal(denied.headers.get('x-batch-every'), null);
  }
  assert.equal((await post(env, { ...fixture, b: batchId() }, { origin: '' })).status, 204, 'tools send no Origin');
  const preflight = await call(env, 'OPTIONS', '/v1/admin/kpis', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
  assert.equal((await call(env, 'OPTIONS', '/v1/batch', { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-methods'), null);
  assert.equal((await post(env, 'not json')).status, 400);
  assert.equal((await post(env, fixture, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await post(env, 'x'.repeat(64 * 1024 + 1))).status, 413);
  const streamed = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(40000).fill(32)); } });
  const request = new Request(BASE + '/v1/batch', { method: 'POST', body: streamed, duplex: 'half', headers: { 'Content-Type': 'text/plain' } });
  assert.equal((await worker.fetch(request, env, ctx)).status, 413, 'an endless body stops at 64 KB');
  assert.equal((await call(env, 'GET', '/v1/batch')).status, 405);
  assert.deepEqual((await call(env, 'GET', '/v1/health')).json(), { ok: true, accepts: [2, 3], schema: SCHEMA_VERSION });
});

test('without a valid ADMIN_TOKEN secret the admin endpoints answer 404 and say why; batches still count', async t => {
  for (const secret of [undefined, '', 'short', 'has a space in it 0123456789', 'ü'.repeat(20)]) {
    const env = await makeEnv({ ADMIN_TOKEN: secret });
    for (const pathname of ['/v1/admin/kpis', '/v1/admin/live']) {
      const res = await admin(env, pathname, secret || TOKEN);
      assert.equal(res.status, 404, `${secret} ${pathname}`);
      assert.deepEqual(res.json(), { error: 'admin password not set' });
    }
    assert.equal((await post(env, { ...fixture, b: batchId() })).status, 204);
  }
  const env = await makeEnv();
  const none = await call(env, 'GET', '/v1/admin/kpis');
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await admin(env, '/v1/admin/kpis', TOKEN + 'x')).status, 401);
  assert.equal((await admin(env, '/v1/admin/kpis', TOKEN.slice(1))).status, 401);
  const ok = await admin(env, '/v1/admin/kpis');
  assert.equal(ok.status, 200);
  assert.equal(ok.json().v, 1);
  assert.equal((await call(env, 'POST', '/v1/admin/live', { headers: { Authorization: 'Bearer ' + TOKEN } })).status, 405);
});

test('KPIs and live through the Worker; the daily cron forgets old batch ids and live rows', async t => {
  const clock = useClock(t);
  const env = await makeEnv();
  const ids = ['f00000000001', 'f00000000002', 'f00000000003'];
  for (const [i, s] of ids.entries()) {
    assert.equal((await post(env, envelope(s, [
      ['ss', 0, 0, 1, 1, 2], ['go', 1, 'road-hopper', 'featured', 0], ['ld', 2, 'road-hopper', 900 + i * 100],
      ['rs', 3, 'road-hopper', 'L1', 2, 0], ['re', 30, 'road-hopper', i ? 'w' : 'q', 'L1', 27000, 10, 2, 5, 1, [1, 2, 1, 1, 0, 0]]
    ]))).status, 204);
  }
  const live = (await admin(env, '/v1/admin/live')).json();
  assert.deepEqual(live, { v: 1, windowSec: 300, minSessions: 0, total: { sessions: 3 }, pcs: 0,
    games: [{ slug: 'road-hopper', sessions: 3 }], clock: { tz: 'UTC', source: 'none', offsetMin: 0, today: '2026-10-20' } });
  const kpis = (await admin(env, '/v1/admin/kpis?from=2026-10-20&to=2026-10-20')).json();
  assert.deepEqual(kpis.totals, { sessions: 3, engagedMinutes: 0, avgEngagedMinutesPerSession: 0, gameOpens: 3, roundsStarted: 3, roundsEnded: 3, errors: 0 });
  const game = kpis.games[0];
  assert.deepEqual([game.slug, game.sessions, game.opens, game.rounds.codes, game.completionRate, game.dropOffRate, game.avgLoadMs, game.avgTier],
    ['road-hopper', 3, 3, { w: 2, l: 0, d: 0, e: 0, q: 1 }, 0.6667, 0.3333, 1000, 2]);
  assert.equal(kpis.bands, undefined);
  assert.equal((await admin(env, '/v1/admin/kpis?from=2026-10-21&to=2026-10-20')).status, 400);

  // Ten minutes later the live rows are gone; 31 days later the batch ids are too.
  clock.now += 10 * 60000;
  await scheduled(env);
  assert.deepEqual(await rows(env, 'live'), []);
  assert.equal((await rows(env, 'batches')).length, 3);
  clock.now += 31 * DAY_MS;
  await scheduled(env);
  assert.deepEqual(await rows(env, 'batches'), []);
});

test('with no request at all, a live row is gone within 10 minutes: a cron sweeps every 5 minutes', async t => {
  const clock = useClock(t);
  const env = await makeEnv(), every5 = '*/5 * * * *', measure = counted(env);
  assert.ok(wrangler.triggers.crons.includes(every5), 'wrangler.json: ' + wrangler.triggers.crons);
  assert.equal((await post(env, fixture)).status, 204);
  const sweep = () => measure(() => worker.scheduled({ scheduledTime: Date.now(), cron: every5 }, env, ctx));
  // The cron fires at minutes 0, 5, 10...: a batch at 09:15 is swept at 09:20 at the latest.
  clock.now = Date.parse('2026-10-20T09:19:00Z');
  await sweep();
  assert.equal((await rows(env, 'live')).length, 1, 'still in the window');
  clock.now = Date.parse('2026-10-20T09:20:00Z');
  const { sql } = await sweep();
  assert.ok(sql.includes('DELETE FROM live WHERE seen_minute <= ?1'));
  // With the settings read every 5 minutes and the usage flush; the daily purge waits for its own cron.
  assert.ok(sql.every(text => /^DELETE FROM live |^INSERT INTO usage |^SELECT \(SELECT value FROM meta/.test(text)), sql.join('\n'));
  assert.deepEqual(await rows(env, 'live'), []);
});

test('the soft rate limit is keyed by CF-Connecting-IP, in memory only', async () => {
  const env = await makeEnv({ RATE_PER_MIN: '2' });
  assert.equal((await call(env, 'GET', '/v1/health', { ip: '198.51.100.1' })).status, 200);
  assert.equal((await post(env, { ...fixture, b: batchId() }, { ip: '198.51.100.1' })).status, 204);
  const limited = await post(env, { ...fixture, b: batchId() }, { ip: '198.51.100.1' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.equal(limited.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await call(env, 'GET', '/v1/health', { ip: '198.51.100.2' })).status, 200, 'another school has its own bucket');
  assert.equal((await call(env, 'GET', '/', { ip: '198.51.100.1' })).status, 429, 'what reaches the Worker counts');
  // The same bindings keep the same bucket from one request to the next.
  assert.equal((await call({ ...env }, 'GET', '/v1/health', { ip: '198.51.100.1' })).status, 429);
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(r => r.name);
  const all = JSON.stringify(await Promise.all(tables.map(table => rows(env, table))));
  assert.doesNotMatch(all, /198\.51\.100/, 'no address is stored');
});

test('paths outside /v1/ go to the static assets; the API never does', async () => {
  const env = await makeEnv();
  const page = await call(env, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>asset<\/title>/);
  assert.equal((await call(env, 'HEAD', '/app.js')).status, 200);
  assert.equal((await call(env, 'GET', '/v1/nothing')).status, 404);
  assert.equal((await call(env, 'GET', '/v1')).status, 404);
  assert.equal((await call(env, 'POST', '/')).status, 404);
  assert.deepEqual(env.assets, ['GET /', 'HEAD /app.js']);
  const bare = await makeEnv({ ASSETS: undefined });
  assert.equal((await call(bare, 'GET', '/')).status, 404);
});


test('a missing DB binding is an internal error for the API only, logged without the request', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const env = await makeEnv({ DB: undefined });
  assert.equal((await call(env, 'GET', '/v1/health')).status, 200);
  const res = await post(env, { ...fixture, b: batchId() });
  assert.equal(res.status, 500);
  assert.deepEqual(res.json(), { error: 'server' });
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /^telemetry: request failed: the D1 binding DB is missing/);
  assert.doesNotMatch(logged.mock.calls[0].arguments[0], /203\.0\.113|farmercarry|5d02be9a41c7/);
  assert.equal((await call(env, 'GET', '/')).status, 200, 'the dashboard still loads');
});


test('every invocation stays inside D1\'s free limits: the upgrade alone (503), then a batch and an admin request at most 20 statements, the crons 35 and 25', async t => {
  const clock = useClock(t);
  // A new database: the first request creates schema 5 and does nothing else.
  const env = await makeEnv({}, { fresh: true }), measure = counted(env);
  let { n, result: res } = await measure(() => post(env, fixture));
  assert.equal(res.status, 503);
  assert.deepEqual(res.json(), { error: 'updating' });
  assert.equal(res.headers.get('retry-after'), '2');
  assert.equal(res.headers.get('access-control-expose-headers'), 'Retry-After, X-Batch-Every', 'the page can read the wait');
  assert.ok(n <= 45, `the upgrade took ${n} statements`);
  assert.deepEqual((await rows(env, 'meta'))[0], { key: 'schema', value: SCHEMA_VERSION });
  assert.deepEqual(await rows(env, 'st_sessions'), [], 'nothing else happened');
  // The portal sends the batch again.
  ({ n, result: res } = await measure(() => post(env, fixture)));
  assert.equal(res.status, 204);
  assert.ok(n <= 20, `the first batch after the upgrade took ${n} statements`);

  // Milestone 2's database: an admin request meets the upgrade and gets the same answer.
  const old = await makeEnv({ DB: await milestone2(openDatabase(':memory:')) }, { fresh: true }), measureOld = counted(old);
  ({ n, result: res } = await measureOld(() => admin(old, '/v1/admin/kpis')));
  assert.deepEqual([res.status, res.headers.get('retry-after'), res.json()], [503, '2', { error: 'updating' }]);
  assert.ok(n <= 45, `the upgrade from schema 3 took ${n} statements`);
  assert.equal((await rows(old, 'agg_days')).length, 1, 'the frozen totals stay');
  // The worst first batch of an instance: a late session (a rolled day) from a PC that
  // reports the zone first, from an older portal (a student code, a removed profile and an
  // older code, all read past), over 200 events of every kind.
  await old.DB.batch([old.DB.prepare("UPDATE settings SET value = '2026-10-18' WHERE key = 'facts_since'"),
    old.DB.prepare("UPDATE settings SET value = '2026-10-19' WHERE key = 'rolled_through'"),
    old.DB.prepare("INSERT INTO roll_days (day, dirty, rolled_s) VALUES ('2026-10-19', 0, 1)")]);
  const games = Array.from({ length: 38 }, (_, i) => 'game-' + i);
  const wide = envelope3('f0000000000a', [['ss', 0, 0, 30, 1, 5, 7, 1], ['pr', 0, '77aa00bb11cc'], ['cd', 0, '1b2c3d4e5f60'], ['ct', 1, 's', 20],
    ...games.flatMap((slug, i) => [['go', 2 + i, i + 1, slug, 'catalog', 1, 0], ['rs', 2 + i, i + 1, 1, slug, 'L1', 1, 0],
      ['re', 3 + i, i + 1, 1, slug, 'w', 'L1', 9000, 5, 1, 2, 1, z6, null], ['tu', 3 + i, i + 1, slug, 's'], ['gx', 4 + i, i + 1, slug, 9000, z6, z4]]),
    ['lv', 60, 6], ['se', 61, 50000, 'p']], { z: 'Asia/Riyadh', w: DAY_MS / 1000 });
  assert.equal(wide.ev.length, 196);
  wide.ev.push(['fv', 62, 1, 'game-0', 1], ['gp', 62, 1, 'game-0', 9000], ['ld', 62, 1, 'game-0', 500], ['er', 62, 1, 'game-0', 'x']);
  assert.equal(validateBatch(wide).events.length, 197, 'the level-up, the removed profile and the older code are read past');
  assert.equal(validateBatch(wide).dropped, 0);
  clock.now += 5000;
  // A new instance (other settings): its first statement reads the schema and the settings.
  const next = { ...old, RATE_PER_MIN: '600' }, measureNext = counted(next);
  ({ n, result: res } = await measureNext(() => post(next, wide)));
  assert.equal(res.status, 204);
  assert.ok(n <= 20, `the worst batch took ${n} statements`);
  assert.deepEqual((await rows(next, 'roll_days')).map(r => r.dirty), [2], 'it marked the late day, then the zone change rebuilt it');
  assert.equal((await rows(next, 'st_rounds')).length, 38);
  // 200 events over 100 games and levels (v2): still one statement per table.
  const v2wide = envelope('f00000000009', [
    ...Array.from({ length: 100 }, (_, i) => ['go', i, 'game-' + i, 'catalog', 0]),
    ...Array.from({ length: 100 }, (_, i) => ['rs', i, 'game-' + i, 'L' + (i % 50 + 1), 1, 0])
  ]);
  ({ n, result: res } = await measureNext(() => post(next, v2wide)));
  assert.equal(res.status, 204);
  assert.ok(n <= 20, `a wide v2 batch took ${n} statements`);
  // Admin requests and the crons. The KPIs read the frozen days, the rolled ones and today's
  // facts; the 5-minute cron re-rolls a day in full (the zone changed).
  const setZone = () => call(next, 'POST', '/v1/admin/settings', { headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tz: 'Asia/Riyadh', source: 'dashboard', weekStart: 'sun', keepDays: 400 }) });
  // The research reads over frozen, rolled and open days (nothing kept yet, on a new instance each), every export file, and the recount.
  const period = 'from=2026-07-23&to=2026-10-20';
  const research = [['game', '/v1/admin/game?slug=game-0&' + period],
    ['stats', '/v1/admin/stats?metrics=hour,rhour,sesslen,games,visitlen,flow,persist,fatigue,qrun,tier,tutorial&' + period],
    ['stats of a game', '/v1/admin/stats?metrics=persist,fatigue&slug=game-0&' + period], ['pcs', '/v1/admin/pcs?' + period],
    ...['sessions', 'visits', 'rounds', 'events', 'daily_games', 'pcs'].map(file => ['export ' + file, `/v1/admin/export?file=${file}&` + period])];
  let instance = 0;
  const fresh = () => { const env = { ...next, RATE_PER_MIN: String(700 + ++instance) }; return [env, counted(env)]; };
  const action = (method, pathname, body) => () => call(next, method, pathname, { body: body && JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) } });
  for (const [label, work, limit, sql] of [['kpis', () => admin(next, '/v1/admin/kpis?from=2026-07-23&to=2026-10-20'), 20, /FROM agg_days.*FROM r_day/],
    ['live', () => admin(next, '/v1/admin/live'), 20], ['settings', () => admin(next, '/v1/admin/settings'), 20], ['settings POST', setZone, 20],
    ...research.map(([name, pathname]) => [name, async () => { const [env, measure] = fresh(); const counts = await measure(() => admin(env, pathname)); return counts; }, 20]),
    ['recount', action('POST', '/v1/admin/rebuild', {}), 20],
    ['5-minute cron', () => scheduled(next, '*/5 * * * *'), 35, /^DELETE FROM r_stat WHERE day/], ['purge', () => scheduled(next, '23 3 * * *'), 25]]) {
    clock.now += 6 * 60000;
    let counts = await measureNext(work);
    // A research read measured itself, on its own new instance.
    if (counts.result && counts.result.n !== undefined) counts = counts.result;
    assert.ok(counts.n <= limit, `${label} took ${counts.n} statements`);
    if (counts.result) assert.equal(counts.result.status, 200, label + ': ' + counts.result.text);
    if (sql) assert.ok(counts.sql.some(text => sql.test(text)), label + ' did its work');
  }
  // The first roll of yesterday with the PCs' vote, after 01:00 in Riyadh.
  clock.now = Date.parse('2026-10-20T22:30:00Z');
  const vote = await measureNext(() => scheduled(next, '*/5 * * * *'));
  assert.ok(vote.n <= 35, `the first roll with the vote took ${vote.n} statements`);
  assert.ok(vote.sql.some(text => /^INSERT INTO r_stat /.test(text)) && vote.sql.some(text => /^UPDATE settings SET value = CASE key WHEN 'tz'/.test(text)));
  // The purge at its worst: frozen days to delete and the storage guard trimming.
  const guarded = openStore(next.DB, { guards: { bytes: 1 } }), counter = counted(next);
  clock.now += DAY_MS;
  const purge = await counter(() => guarded.purge(Date.now()));
  assert.ok(purge.result.trimmed && purge.n <= 25, `the purge with the storage guard took ${purge.n} statements`);
  assert.ok(purge.sql.some(text => /^DELETE FROM agg_days/.test(text)));
});

test('the 5-minute cron rolls yesterday once, after 01:00 at the school, whichever instance runs it; then the PCs vote for the zone', async t => {
  const clock = useClock(t);
  const env = await makeEnv(), other = { ...env, RATE_PER_MIN: '600' }, measure = counted(env), measureOther = counted(other);
  const cron = async (e = env, m = measure) => {
    const { n } = await m(() => scheduled(e, '*/5 * * * *'));
    assert.ok(n <= 35, `the cron took ${n} statements`);
  };
  const settings = async () => Object.fromEntries((await rows(env, 'settings')).map(r => [r.key, r.value]));
  const sessionsOn = async day => (await rows(env, 'r_day')).filter(r => r.day === day).reduce((n, r) => n + r.sessions, 0);
  const days = async () => (await rows(env, 'roll_days')).map(r => [r.day, r.dirty]);
  const late = (s, at) => envelope3(s, [['ss', 0, 0, 30, 1, 3, 4, 0], ['go', 1, 1, 'maze-dash', 'catalog', 0, 0]],
    { z: 'Asia/Riyadh', w: Math.round((clock.now - Date.parse(at)) / 1000) });
  // Three PCs in Riyadh, a session each on 20 October.
  for (const [i, p] of ['8c21d0e94a6f', '0a0b0c0d0e0f', '1a2b3c4d5e6f'].entries()) {
    assert.equal((await post(env, envelope3('f3000000000' + i, [['ss', 0, 0, 30, 1, 3, 4, 0], ['go', 1, 1, 'road-hopper', 'catalog', 0, 0]],
      { p, z: 'Asia/Riyadh' }))).status, 204);
  }
  let now = await settings();
  assert.deepEqual([now.tz, now.tz_source, now.rolled_through], ['Asia/Riyadh', 'pc', '']);
  // 00:30 in Riyadh: yesterday is not rolled yet.
  clock.now = Date.parse('2026-10-20T21:30:00Z');
  await cron();
  assert.deepEqual(await days(), []);
  // 01:05: two instances at once, and one roll.
  clock.now = Date.parse('2026-10-20T22:05:00Z');
  await Promise.all([cron(), cron(other, measureOther)]);
  assert.deepEqual(await days(), [['2026-10-20', 0]]);
  assert.equal(await sessionsOn('2026-10-20'), 3);
  // Three PCs seen in the last 14 days report Riyadh: the zone is locked, and no PC moves it.
  now = await settings();
  assert.deepEqual([now.tz, now.tz_source, now.rolled_through, now.tz_epoch], ['Asia/Riyadh', 'pcs', '2026-10-20', '1']);
  assert.equal((await post(env, envelope3('f30000000009', [['ss', 0], ['ct', 1, 'c', 0]], { p: '9a8b7c6d5e4f', z: 'Europe/London' }))).status, 204);
  assert.equal((await settings()).tz, 'Asia/Riyadh');

  // A batch of 20 October arrives late: its day is rolled again, at most once an hour.
  clock.now = Date.parse('2026-10-20T22:10:00Z');
  assert.equal((await post(env, late('f3000000000a', '2026-10-20T10:00:00Z'))).status, 204);
  assert.deepEqual(await days(), [['2026-10-20', 1]]);
  clock.now = Date.parse('2026-10-20T22:15:00Z');
  await cron();
  assert.equal(await sessionsOn('2026-10-20'), 3, 'not within the hour');
  clock.now = Date.parse('2026-10-20T23:06:00Z');
  await cron();
  assert.deepEqual([await sessionsOn('2026-10-20'), await days()], [4, [['2026-10-20', 0]]]);

  // The owner moves the school to London: the day is rolled again in full, before any other re-roll.
  const set = await call(env, 'POST', '/v1/admin/settings', { headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tz: 'Europe/London' }) });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json().rebuild, { pending: 1, full: 1, done: 0 });
  clock.now = Date.parse('2026-10-20T23:11:00Z');
  const { sql } = await measure(() => scheduled(env, '*/5 * * * *'));
  assert.ok(sql.includes('DELETE FROM r_day WHERE day = ?1'), 'a full re-roll');
  assert.deepEqual(await days(), [['2026-10-20', 0]]);
  // 20 October in London also holds the session that started at 22:05 UTC (01:05 on the 21st in Riyadh).
  assert.equal(await sessionsOn('2026-10-20'), 5);
  assert.equal((await settings()).rebuild, '1');
  await cron();
  assert.equal((await settings()).rebuild, '', 'no day waits for a full re-roll');

  // While today's reads are high, re-rolls wait for the next UTC day; first rolls do not.
  clock.now = Date.parse('2026-10-20T23:20:00Z');
  assert.equal((await post(env, { ...late('f3000000000b', '2026-10-20T11:00:00Z'), z: '' })).status, 204);
  await env.DB.prepare("UPDATE usage SET reads = 3000001 WHERE day = '2026-10-20'").run();
  clock.now = Date.parse('2026-10-20T23:55:00Z');
  await cron();
  assert.deepEqual([await sessionsOn('2026-10-20'), await days()], [5, [['2026-10-20', 1]]]);
  clock.now = Date.parse('2026-10-21T00:25:00Z');
  await cron();
  assert.deepEqual([await sessionsOn('2026-10-20'), await days()], [6, [['2026-10-20', 0]]]);
  // So do writes above 80,000.
  assert.equal((await post(env, { ...late('f3000000000c', '2026-10-20T12:00:00Z'), z: '' })).status, 204);
  clock.now = Date.parse('2026-10-22T00:30:00Z');
  await env.DB.prepare("INSERT INTO usage (day, writes) VALUES ('2026-10-22', 80001)").run();
  await cron();
  assert.deepEqual(await days(), [['2026-10-20', 1], ['2026-10-21', 0]], 'the first roll of 21 October ran');
  await cron();
  assert.deepEqual(await days(), [['2026-10-20', 1], ['2026-10-21', 0]]);
});

test('X-Batch-Every tells the PCs to wait longer as the day\'s writes near the free limit, and the page can read it', async t => {
  useClock(t);
  for (const [writes, every] of [[0, '60'], [59900, '60'], [60001, '180'], [79900, '180'], [80001, '300'], [99000, '300']]) {
    const env = await makeEnv();
    await env.DB.prepare("INSERT INTO usage (day, writes) VALUES ('2026-10-20', ?1)").bind(writes).run();
    const res = await post(env, { ...fixture, b: batchId() });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('x-batch-every'), every, String(writes));
    assert.match(res.headers.get('access-control-expose-headers'), /\bX-Batch-Every\b/);
  }
});

test('the usage meter adds up the rows of every result and writes them once a minute, so the guards see every instance', async t => {
  const clock = useClock(t);
  const env = await makeEnv(), batch = env.DB.batch.bind(env.DB), sums = [];
  let flushes = 0, flushed = 0;
  env.DB.batch = async statements => {
    const results = await batch(statements);
    // A flush writes the counts of the batches before it (and the cron's last one its own rows too).
    if (statements.some(st => st.sql.startsWith('INSERT INTO usage'))) { flushes++; flushed = sums.length; }
    sums.push([results.reduce((n, r) => n + r.meta.rows_written, 0), results.reduce((n, r) => n + r.meta.rows_read, 0)]);
    return results;
  };
  for (let i = 0; i < 6; i++) {
    assert.equal((await post(env, envelope('f1000000000' + i, [['ss', 0, 0, 1, 1, 2], ['go', 1, 'road-hopper', 'featured', 0]]))).status, 204);
    clock.now += 9000;
  }
  assert.equal(flushes, 1, 'once in the first minute');
  clock.now = START + 5 * 60000;
  await scheduled(env, '*/5 * * * *');
  assert.equal(flushes, 3, 'the cron writes the counts first, and its own last: a cron in a new instance still counts');
  // Every batch is in the table, the cron's own and its last flush (which counts its own rows) included.
  const [usage] = await rows(env, 'usage');
  const total = i => sums.slice(0, flushed + 1).reduce((n, s) => n + s[i], 0);
  assert.deepEqual([usage.day, usage.writes, usage.reads], ['2026-10-20', total(0), total(1)]);
  assert.ok(usage.size > 0);
});

// A school's last days (simulate.mjs), each rolled by the cron the next night (the last one
// too); and a counter of the rows D1 itself writes per UTC day.
async function rolledSchool({ days = 5, sessions = 60, now = Date.parse('2026-10-22T09:30:00Z') } = {}) {
  const { schoolDays } = await import('../simulate.mjs');
  const db = openDatabase(':memory:'), store = openStore(db), written = new Map(), batch = db.batch.bind(db);
  db.batch = async list => {
    const results = await batch(list), day = new Date(Date.now()).toISOString().slice(0, 10);
    written.set(day, (written.get(day) || 0) + results.reduce((n, r) => n + r.meta.rows_written, 0));
    return results;
  };
  for (const day of schoolDays({ days, sessions, seed: 5, now })) {
    for (const { batch: b, now: at } of day.batches) await store.ingest(validateBatch(b), at);
    const night = Date.parse(day.day + 'T00:00:00Z') - 3 * 3600000 + DAY_MS + 65 * 60000;
    for (let i = 0; i < 40 && (await store.rollupStep(night + i * 300000)).rolled; i++);
  }
  return { db, written };
}
// The cron every 5 minutes of a UTC day, each run a new instance (nothing in memory): the kinds of re-roll it made (first rolls aside).
async function cronDay(t, db, day, guards) {
  const clock = useClock(t), kinds = [];
  for (let at = Date.parse(day + 'T00:00:00Z'); at < Date.parse(day + 'T00:00:00Z') + DAY_MS; at += 300000) {
    clock.now = at;
    const done = await openStore(db, { guards }).rollupStep(at);
    if (done.kind && done.kind !== 'first') kinds.push(done.kind);
  }
  t.mock.restoreAll();
  return kinds;
}

test('the cron writes its own usage even when every run is a new instance, and starts a re-roll only with room left for the school day', async t => {
  const { db, written } = await rolledSchool();
  const rolls = (await db.prepare('SELECT day, rows FROM roll_days ORDER BY day').all()).results;
  assert.ok(rolls.length >= 3 && rolls.every(r => r.rows > 500), JSON.stringify(rolls));
  // Room for one full re-roll (estimated at twice the day's rows) above the reserve for the school day, not two.
  const most = Math.max(...rolls.map(r => r.rows)), guards = { rollWrites: 50000 + 3 * most, reserveWrites: 50000 };
  // The owner moves the clock: every rolled day waits for a full re-roll.
  await openStore(db).updateSettings({ tz: 'Asia/Dubai' }, Date.parse('2026-10-22T23:00:00Z'));
  const usage = async day => (await db.prepare('SELECT writes FROM usage WHERE day = ?1').bind(day).first())?.writes ?? 0;
  assert.deepEqual(await cronDay(t, db, '2026-10-23', guards), ['full']);
  // What the guards read is what D1 wrote, the crons' own rows included.
  assert.equal(await usage('2026-10-23'), written.get('2026-10-23'));
  assert.deepEqual(await cronDay(t, db, '2026-10-24', guards), ['full']);
  assert.equal(await usage('2026-10-24'), written.get('2026-10-24'));
  assert.ok(written.get('2026-10-24') <= guards.rollWrites - guards.reserveWrites, written.get('2026-10-24') + ' rows written');
});

test('a recount re-rolls every day with the diff, writing only what changed, so it finishes in a night', async t => {
  const { db, written } = await rolledSchool();
  const store = openStore(db), now = Date.parse('2026-10-22T23:00:00Z');
  const rolls = (await db.prepare('SELECT day, rows FROM roll_days ORDER BY day').all()).results;
  // Some sessions' facts are gone (as the purge of a shorter retention, or the storage guard, removes them): a recount follows.
  const gone = '(SELECT id FROM st_sessions ORDER BY id LIMIT 10)';
  await db.batch(['st_rounds', 'st_visits', 'st_marks'].map(table => db.prepare(`DELETE FROM ${table} WHERE sid IN ${gone}`))
    .concat(db.prepare(`DELETE FROM st_sessions WHERE id IN ${gone}`)));
  assert.equal((await store.rebuild(now)).pending, rolls.length);
  const kinds = await cronDay(t, db, '2026-10-23', {});
  assert.deepEqual(kinds, rolls.map(() => 'recount'));
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM roll_days WHERE dirty > 0').first()).n, 0);
  // A full re-roll of every day would write each day's rows twice.
  const full = 2 * rolls.reduce((n, r) => n + r.rows, 0);
  assert.ok(written.get('2026-10-23') < full / 5, `${written.get('2026-10-23')} rows written, against ${full} for full re-rolls`);
});

test('the Worker keeps the open days\' KPIs for 10 minutes, shared through D1, so a dashboard left open reads today\'s facts at most every 10 minutes', async t => {
  const clock = useClock(t);
  const env = await makeEnv(), measure = counted(env);
  assert.equal((await post(env, fixture)).status, 204);
  const first = await measure(() => admin(env, '/v1/admin/kpis'));
  assert.ok(first.sql.some(text => /SELECT day, 1 AS part/.test(text)), 'today from the facts');
  // A new batch, then a refresh on another instance in the same 10-minute slot (09:10 to 09:20): the same answer, from the kept part.
  clock.now += 3 * 60000;
  assert.equal((await post(env, envelope('f20000000001', [['go', 1, 'road-hopper', 'featured', 0]]))).status, 204);
  const other = { ...env, RATE_PER_MIN: '600' }, measureOther = counted(other);
  const again = await measureOther(() => admin(other, '/v1/admin/kpis'));
  assert.equal(again.result.json().totals.sessions, first.result.json().totals.sessions);
  assert.ok(!again.sql.some(text => /SELECT day, 1 AS part/.test(text)));
  // In the next slot it is read again.
  clock.now += 3 * 60000;
  const later = await measureOther(() => admin(other, '/v1/admin/kpis'));
  assert.equal(later.result.json().totals.sessions, first.result.json().totals.sessions + 1);
});

test('a session that crosses midnight counts once, on the school\'s day it started', async () => {
  const store = openStore(openDatabase(':memory:'));
  const late = Date.parse('2026-10-20T23:58:00Z');
  for (const [s, offset] of [['a10000000001', 0], ['a10000000002', 0], ['a10000000003', 0], ['a10000000001', 5 * 60000]]) {
    await store.ingest(validateBatch(envelope(s, [['go', 1, 'road-hopper', 'featured', 0]])), late + offset);
  }
  const kpis = await store.kpis({ from: '2026-10-20', to: '2026-10-21' }, late + 10 * 60000);
  assert.equal(kpis.totals.sessions, 3);
  assert.deepEqual(kpis.daily.map(d => [d.day, d.sessions]), [['2026-10-20', 3], ['2026-10-21', 0]]);
  // In Riyadh the same evening is after midnight already: those sessions count on the 21st there.
  const riyadh = openStore(openDatabase(':memory:'));
  await riyadh.ingest(validateBatch(envelope3('a10000000009', [['ss', 0]], { z: 'Asia/Riyadh' })), late - DAY_MS);
  for (const [s, offset] of [['a10000000001', 0], ['a10000000002', 0], ['a10000000003', 0], ['a10000000001', 5 * 60000]]) {
    await riyadh.ingest(validateBatch(envelope(s, [['go', 1, 'road-hopper', 'featured', 0]])), late + offset);
  }
  const there = await riyadh.kpis({ from: '2026-10-20', to: '2026-10-21' }, late + 10 * 60000);
  // (The session that told the zone counts on the 20th there.)
  assert.deepEqual(there.daily.map(d => [d.day, d.sessions]), [['2026-10-20', 1], ['2026-10-21', 3]]);
});

test('the research reads keep their closed part in D1 for every instance, made again when a recount changes the rollup version', async t => {
  const clock = useClock(t);
  const env = await makeEnv();
  // Four sessions on 19 and 20 October (an older portal's, with student codes: read past); the cron rolls both days the next night.
  for (const [day, s, u] of [['2026-10-19', 'f50000000001', U], ['2026-10-19', 'f50000000002', '1b2c3d4e5f60'], ['2026-10-20', 'f50000000003', U],
    ['2026-10-20', 'f50000000004', '2c3d4e5f6071']]) {
    clock.now = Date.parse(day + 'T09:15:00Z');
    assert.equal((await post(env, envelope3(s, [['ss', 0, 0, 30, 1, 3, 4, 0], ['go', 1, 1, 'road-hopper', 'catalog', 0, 0],
      ['rs', 2, 1, 1, 'road-hopper', 'L1', 1, 0], ['re', 30, 1, 1, 'road-hopper', 'w', 'L1', 20000, 10, 1, 3, 1, z6, null],
      ['gx', 31, 1, 'road-hopper', 20000, z6, z4]], { u }))).status, 204);
  }
  clock.now = Date.parse('2026-10-21T01:30:00Z');
  await scheduled(env, '*/5 * * * *');
  await scheduled(env, '*/5 * * * *');
  // A closed part is made: read from the rollups (a game's: kept in kpi_cache by SQL, which then writes a row).
  const closed = /^SELECT x\.p AS p/;
  const made = [], execute = env.DB.execute.bind(env.DB);
  env.DB.execute = (statement, ...rest) => {
    const result = execute(statement, ...rest);
    if (/^INSERT INTO kpi_cache \(key, made, rows\) SELECT (?:\?5, \?6, json_object\('days'|\?4, \?5, \()/.test(statement.sql) && result.meta.changes) made.push(statement.sql);
    return result;
  };
  const paths = ['/v1/admin/game?slug=road-hopper&from=2026-10-19&to=2026-10-20', '/v1/admin/pcs?from=2026-10-19&to=2026-10-20',
    '/v1/admin/stats?metrics=flow,persist&from=2026-10-19&to=2026-10-20'];
  const read = async instance => {
    const other = { ...env, RATE_PER_MIN: String(instance) }, measure = counted(other), out = [];
    for (const pathname of paths) {
      made.length = 0;
      const { sql, result } = await measure(() => admin(other, pathname));
      assert.equal(result.status, 200, pathname);
      out.push([result.json(), made.length > 0 || sql.some(text => closed.test(text))]);
    }
    return out;
  };
  const first = await read(601);
  assert.deepEqual(first.map(([, made]) => made), [true, true, true], 'the first instance makes every closed part');
  clock.now += 60000;
  const second = await read(602);
  assert.deepEqual(second.map(([, made]) => made), [false, false, false], 'another instance finds them in kpi_cache');
  assert.deepEqual(second.map(([answer]) => ({ ...answer, clock: null })), first.map(([answer]) => ({ ...answer, clock: null })));
  // A recount re-rolls the days, which raises the rollup version: every kept part is made again, with the same numbers.
  const recount = await call(env, 'POST', '/v1/admin/rebuild', { headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: '{}' });
  assert.ok(recount.json().pending >= 1);
  clock.now += 60000;
  await scheduled(env, '*/5 * * * *');
  await scheduled(env, '*/5 * * * *');
  const third = await read(603);
  assert.deepEqual(third.map(([, made]) => made), [true, true, true]);
  assert.deepEqual(third.map(([answer]) => ({ ...answer, clock: null })), first.map(([answer]) => ({ ...answer, clock: null })));
});

test('the CPU each admin answer and export page spends in JavaScript (outside SQLite, with the D1 binding\'s own work) stays inside the Workers limit on a simulated school', async () => {
  const { schoolDays } = await import('../simulate.mjs');
  const { serialize } = await import('../handler.mjs');
  const now = Date.parse('2026-10-22T09:30:00Z'), db = openDatabase(':memory:'), store = openStore(db);
  for (const day of schoolDays({ days: 21, sessions: 120, seed: 3, now })) {
    for (const { batch, now: at } of day.batches) await store.ingest(validateBatch(batch), at);
    const night = Date.parse(day.day + 'T00:00:00Z') - 3 * 3600000 + DAY_MS + 65 * 60000;
    if (night < now) for (let i = 0; i < 40 && (await store.rollupStep(night + i * 300000)).rolled; i++);
  }
  // The time of a call less the time inside the driver's statements (which D1 spends, not the Worker): node:sqlite
  // runs on this thread, and the test files run one at a time, so this is the JavaScript's own CPU. What the Worker's D1
  // binding does is added back: it writes the request as JSON, and reads the answer as JSON (each statement's columns and
  // rows of values), making an object of every row.
  let inSql = 0, received = 0, sent = 0;
  const batch = db.batch.bind(db);
  db.batch = async list => {
    const t0 = performance.now(), results = await batch(list);
    const wire = JSON.stringify(results.map(r => ({ results: { columns: Object.keys(r.results[0] || {}), rows: r.results.map(Object.values) }, meta: r.meta })));
    received += wire.length;
    inSql += performance.now() - t0;
    JSON.stringify({ batch: list.map(st => ({ sql: st.sql, params: st.params })) });
    sent += JSON.stringify(list.map(st => st.params)).length;
    for (const { results: { columns, rows } } of JSON.parse(wire)) rows.map(row => Object.fromEntries(row.map((v, i) => [columns[i], v])));
    return results;
  };
  // Each run asks about another period, so that nothing is kept from the run before (the cold case).
  const periods = Array.from({ length: 7 }, (_, i) => ({ from: '2026-09-' + String(20 + i).padStart(2, '0'), to: '2026-10-22' }));
  const work = {
    kpis: q => store.kpis(q, now), game: q => store.game({ ...q, slug: 'road-hopper' }, now),
    stats: q => store.stats({ ...q, metrics: ['fatigue', 'persist', 'flow'], slug: null }, now),
    pcs: q => store.pcs(q, now), live: () => store.live(now), settings: () => store.settings(now),
    'export rounds': q => store.exportPage({ file: 'rounds', ...q }, now), 'export sessions': q => store.exportPage({ file: 'sessions', ...q }, now),
    'export daily_games': q => store.exportPage({ file: 'daily_games', ...q }, now)
  };
  const medians = {}, ratios = {}, back = {};
  for (const [name, run] of Object.entries(work)) {
    const spent = [];
    for (const q of periods) {
      inSql = 0;
      received = 0;
      sent = 0;
      const t0 = performance.now(), answer = await run(q);
      // Writing the answer is part of it: the handler's JSON, or the export page's lines.
      const text = answer.text !== undefined ? answer.text : serialize(answer);
      spent.push(performance.now() - t0 - inSql);
      ratios[name] = Math.max(ratios[name] || 0, received / text.length);
      back[name] = Math.max(back[name] || 0, sent / text.length);
    }
    medians[name] = spent.sort((a, b) => a - b)[3];
  }
  // The KPI answer comes from SQL about once, and no part of an answer goes back to D1 through the Worker.
  for (const name of ['kpis']) assert.ok(ratios[name] < 1.5, `${name}: ${ratios[name].toFixed(2)} times its answer through the binding`);
  for (const name of ['game', 'stats']) assert.ok(back[name] < 0.25, `${name}: ${back[name].toFixed(2)} times its answer sent back to D1`);
  const limit = name => name.startsWith('export') ? 3 : 5;
  for (const [name, ms] of Object.entries(medians)) assert.ok(ms <= limit(name), `${name}: ${ms.toFixed(1)} ms of JavaScript (${JSON.stringify(medians)})`);
});
