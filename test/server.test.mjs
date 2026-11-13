import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an ExperimentalWarning on Node 22; keep every other warning.
const { hideSqliteWarning } = await import('../warnings.mjs');
hideSqliteWarning();
const { createApp, MAX_BODY } = await import('../app.mjs');
const { EVENTS, EVENTS_V3, validateBatch } = await import('../schema.mjs');
const { ROLLUPS, TABLES, SCHEMA_VERSION, openStore } = await import('../store.mjs');
const { openDatabase } = await import('../sqlite-d1.mjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch.json'), 'utf8'));
const fixture3 = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch-v3.json'), 'utf8'));
// The same batch from an older portal: a student code, an age band, a profile's fields, an older code, a removed profile and a level-up.
const fixture3old = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch-v3-accounts.json'), 'utf8'));
const ORIGIN = 'https://school.example';
const TOKEN = 'test-admin-token-0123456789';
const DAY_MS = 86400000;
const START = Date.parse('2026-10-20T09:15:00Z'), R0 = START / 1000;
// The tables that hold what a batch says (schema 5).
const FACTS = ['st_sessions', 'st_visits', 'st_rounds', 'st_marks', 'st_pcs'];
const U = '3f9a0c51e2b7', P = '8c21d0e94a6f';
const z6 = [0, 0, 0, 0, 0, 0], z4 = [0, 0, 0, 0];

let batchSeq = 0;
const batchId = () => (++batchSeq).toString(16).padStart(16, '0');
const envelope = (s, ev, extra = {}) => ({ v: 2, b: batchId(), s, k: 'src', m: 'web', a: '6-7', d: [4, 4, 1920], ev, ...extra });
const envelope3 = (s, ev, extra = {}) => ({ v: 3, b: batchId(), s, k: 'src', m: 'web', a: '8-9', d: [4, 4, 1920], u: U, p: P,
  z: 'Asia/Riyadh', ev, w: Math.max(0, ...ev.map(e => Array.isArray(e) && Number.isFinite(e[1]) ? e[1] : 0)) + 5, ...extra });
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
const series = (prefix, values) => Object.fromEntries(values.map((v, i) => [prefix + i, v]));
// Whole fact rows: the given fields, and every other column empty.
const visitRow = (n, slug, fields = {}) => ({ sid: 1, n, slug, t_open: null, t_close: null, src: null, plays: null, plays_b: null, fav: null,
  load_ms: null, err: null, engaged_ms: 0, closed: 0, ...series('il', Array(6).fill(null)), ...series('f', Array(4).fill(null)), ...fields });
const roundRow = (n, k, slug, id, fields = {}) => ({ sid: 1, n, k, slug, id, t0: null, tier0: null, replay: null, t: null, code: null, ms: null,
  score: null, tier: null, hits: null, misses: null, ...series('rt', Array(6).fill(null)), wall_ms: null, inputs: null, idle: null, pauses: null,
  rt_sum: null, rt_n: null, dda: null, duo: 0, attempt: null, ...fields });

function request(base, method, pathname, { headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request(base + pathname, { method, headers, agent: false }, res => {
      answered = true;
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    // An early answer (413) may close the socket while the body is still being written.
    req.on('error', error => { if (!answered) reject(error); });
    if (chunks) { for (const chunk of chunks) req.write(chunk); req.end(); } else req.end(body);
  });
}

// A dashboard folder with the real _headers file, so the static checks do not depend on
// which dashboard files exist in this checkout.
function dashboard(dir) {
  const folder = path.join(dir, 'dashboard');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'dashboard/_headers'), path.join(folder, '_headers'));
  fs.writeFileSync(path.join(folder, 'index.html'), '<!doctype html><title>Dashboard</title><script src="app.js"></script>');
  fs.writeFileSync(path.join(folder, 'app.js'), 'document.title = "ok";');
  fs.writeFileSync(path.join(folder, 'style.css'), 'body { color: black }');
  fs.writeFileSync(path.join(folder, 'sub', 'index.html'), '<!doctype html><title>Sub</title>');
  fs.writeFileSync(path.join(folder, '.secret'), 'SENTINEL-DOTFILE');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'SENTINEL-OUTSIDE');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(folder, 'link.txt'));
  return folder;
}

// A Node host on a new database, created (so its facts start) at `at`.
async function start(t, { at = START, ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-games-telemetry-'));
  const clock = { now: at };
  const dbPath = path.join(dir, 'db', 'telemetry.db');
  const app = createApp({ dbPath, allowedOrigins: [ORIGIN], adminToken: TOKEN, now: () => clock.now, dashboardDir: dashboard(dir), ...options });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const send = (method, pathname, init) => request(base, method, pathname, init);
  const post = (body, { origin = ORIGIN, type = 'text/plain;charset=UTF-8', headers = {} } = {}) =>
    send('POST', '/v1/batch', { headers: { 'content-type': type, ...(origin ? { origin } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body) });
  const admin = (pathname, headers = {}) => send('GET', pathname, { headers: { authorization: 'Bearer ' + TOKEN, ...headers } });
  const rows = async (table, order = '') => (await app.store.db.prepare(`SELECT * FROM ${table}${order && ' ORDER BY ' + order}`).all()).results;
  const count = async table => (await app.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  return { app, clock, dir, dbPath: dbPath, dbDir: path.dirname(dbPath), base, send, post, admin, rows, count };
}

// Every fact row, so that a check can see that nothing was added.
const storedFacts = async s => Object.fromEntries(await Promise.all(FACTS.map(async table => [table, await s.rows(table)])));

// A database as milestone 2 left it (schema 3: the daily aggregates, seen and the old
// live table, created as its store created them), with the given aggregate rows.
async function milestone2(file, rows = []) {
  const db = openDatabase(file);
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
    "INSERT INTO seen (day, kind, key, s) VALUES ('2026-10-19', 'd', '', 'a00000000009')",
    "INSERT INTO live (s, slug, seen_minute) VALUES ('a00000000009', 'road-hopper', 1)"
  ].map(text => db.prepare(text)));
  for (const [table, row] of rows) {
    await db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((_, i) => '?' + (i + 1)).join(', ')})`)
      .bind(...Object.values(row)).run();
  }
  db.close();
}

test('health answers which wire versions and schema this server takes, without the database; unknown routes are 404 and wrong methods 405', async t => {
  const s = await start(t);
  const db = s.app.store.db, batch = db.batch.bind(db);
  let used = 0;
  db.batch = statements => { used++; return batch(statements); };
  const health = await s.send('GET', '/v1/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { ok: true, accepts: [2, 3], schema: 5 });
  assert.match(health.headers['content-type'], /^application\/json/);
  assert.equal((await s.send('HEAD', '/v1/health')).status, 200);
  assert.equal(used, 0, 'no query');
  assert.equal((await s.send('GET', '/v1/nothing')).status, 404);
  assert.equal((await s.send('GET', '/v1')).status, 404);
  assert.equal((await s.send('GET', '/nothing.html')).status, 404);
  assert.equal((await s.send('POST', '/')).status, 404, 'the dashboard only answers GET and HEAD');
  const wrong = await s.send('GET', '/v1/batch');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.allow, 'POST, OPTIONS');
  assert.equal((await s.send('POST', '/v1/health')).status, 405);
});

test('the Node host serves the dashboard folder with the headers of its _headers file, and nothing else', async t => {
  const s = await start(t);
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  for (const pathname of ['/', '/index.html', '/%69ndex.html']) {
    const page = await s.send('GET', pathname);
    assert.equal(page.status, 200, pathname);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(page.text, /<title>Dashboard<\/title>/);
    assert.equal(page.headers['content-security-policy'], csp);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['cache-control'], 'no-store', pathname);
    assert.equal(page.headers['access-control-allow-origin'], undefined);
  }
  const script = await s.send('GET', '/app.js', { headers: { origin: ORIGIN } });
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['content-security-policy'], csp);
  assert.equal(script.headers['cache-control'], 'no-cache');
  assert.equal((await s.send('GET', '/style.css')).headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await s.send('GET', '/sub/')).status, 200);
  const head = await s.send('HEAD', '/');
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  for (const pathname of ['/_headers', '/.secret', '/%2esecret', '/link.txt', '/../outside.txt', '/%2e%2e/outside.txt',
    '/..%2foutside.txt', '/sub/..%2f..%2foutside.txt', '/%2e%2e%5coutside.txt', '/sub', '//index.html', '/index.html%00',
    '/%E0%A4%A', '/nothing/', '/v1/index.html']) {
    const res = await s.send('GET', pathname);
    assert.equal(res.status, 404, pathname);
    assert.match(res.headers['content-type'], /^application\/json/, pathname);
    assert.doesNotMatch(res.text, /SENTINEL/, pathname);
  }
  // Static files share the client's rate-limit bucket like every other request.
  const limited = await start(t, { ratePerMin: 1 });
  assert.equal((await limited.send('GET', '/')).status, 200);
  assert.equal((await limited.send('GET', '/')).status, 429);
});

test('the v2 fixture has every v2 kind and is stored as facts, its visits and rounds numbered by the server, without its age band, profile or level-up', async t => {
  assert.deepEqual([...new Set(fixture.ev.map(e => e[0]))].sort(), [...Object.keys(EVENTS), 'lv'].sort(), 'the fixture exercises every kind (and a level-up)');
  const s = await start(t);
  const res = await s.post(fixture);
  assert.equal(res.status, 204);
  assert.equal(res.text, '');
  assert.deepEqual(await s.rows('batches'), [{ b: fixture.b, day: '2026-10-20' }]);
  // No w: the session started 10 s before its first batch's last event, by the server's clock.
  assert.deepEqual(await s.rows('st_sessions'), [{
    id: 1, s: fixture.s, u: '', p: '', wire: 2, a: '', k: fixture.k, m: 'web', cores: 4, mem: 4, screen: 1920, start_s: R0 - 160 - 10,
    clock: 'r', z: '', is_new: null, age_days: null, since_days: null, age_b: null, since_b: null, level0: null, np: null, cls: null,
    se_t: 160, se_ms: 112000, why: null, vn: 2, open_n: null, open_slug: null, open_k: null, last_k: 0
  }]);
  assert.deepEqual(await s.rows('st_visits', 'n'), [
    visitRow(1, 'bubble-bop', { t_open: 2, t_close: 123, src: 'starter', plays_b: 2, load_ms: 840, engaged_ms: 112000, closed: 1,
      ...series('il', [180, 44, 6, 1, 0, 0]), ...series('f', [5830, 412, 37, 1]) }),
    visitRow(2, 'road-hopper', { t_open: 130, t_close: 152, src: 'featured', plays_b: 0, err: 't', closed: 1, ...series('il', z6), ...series('f', z4) })
  ]);
  assert.deepEqual(await s.rows('st_rounds', 'n, k'), [
    roundRow(1, 1, 'bubble-bop', 'w1-1', { t0: 4, tier0: 1, replay: 0, t: 41, code: 'w', ms: 36500, score: 12, tier: 2, hits: 12, misses: 1,
      ...series('rt', [6, 4, 2, 1, 0, 0]) }),
    roundRow(1, 2, 'bubble-bop', 'w1-2', { t0: 42, tier0: 2, replay: 0, t: 80, code: 'q', ms: 30250, tier: 2, hits: 5, misses: 3,
      ...series('rt', [2, 3, 1, 0, 1, 1]) }),
    roundRow(1, 3, 'bubble-bop', 'w1-2', { t0: 81, tier0: 2, replay: 1, t: 120, code: 'l', ms: 38000, score: 4, tier: 1, hits: 7, misses: 6,
      ...series('rt', [3, 4, 3, 2, 1, 0]) })
  ]);
  assert.deepEqual(await s.rows('st_marks'), [], 'no level-up');
  assert.deepEqual(await s.rows('st_pcs'), []);
  // The session closed everything with se: it is live with no game open.
  assert.deepEqual(await s.rows('live'), [{ s: fixture.s, slug: '', seen_minute: Math.floor(START / 60000), p: '', wire: 2 }]);
});

test('the v3 fixture has every v3 kind and is stored as exact facts, with its PC and the school\'s zone; an older portal\'s gives the same facts', async t => {
  assert.deepEqual([...new Set(fixture3.ev.map(e => e[0]))].sort(), Object.keys(EVENTS_V3).sort(), 'the fixture exercises every kind');
  assert.ok(!('u' in fixture3) && !('a' in fixture3) && fixture3.ev[0].length === 2, 'the current portal: no student code, age band or profile');
  assert.deepEqual([...new Set(fixture3old.ev.map(e => e[0]))].sort(), [...Object.keys(EVENTS_V3), 'cd', 'lv', 'pr'].sort());
  assert.ok(fixture3.ev.some(e => e[0] === 're' && e[13] === null) && fixture3.ev.some(e => e[0] === 're' && Array.isArray(e[13])), 're.x both ways');
  assert.equal(validateBatch(fixture3).dropped, 0);
  const s = await start(t);
  const res = await s.post(fixture3);
  assert.equal(res.status, 204);
  assert.deepEqual(await s.rows('batches'), [], 'v3 needs no batch ids: every write is idempotent');
  const at = R0 - fixture3.w;
  assert.deepEqual(await s.rows('st_sessions'), [{
    id: 1, s: fixture3.s, u: '', p: P, wire: 3, a: '', k: fixture3.k, m: 'web', cores: 4, mem: 4, screen: 1920, start_s: at, clock: 'w',
    z: 'Asia/Riyadh', is_new: null, age_days: null, since_days: null, age_b: null, since_b: null, level0: null, np: null, cls: null, se_t: 160, se_ms: 103000,
    why: 'h', vn: 0, open_n: null, open_slug: null, open_k: null, last_k: 0
  }]);
  assert.deepEqual(await s.rows('st_visits', 'n'), [
    visitRow(1, 'road-hopper', { t_open: 3, t_close: 84, src: 'catalog', plays: 12, plays_b: 4, fav: 1, load_ms: 910, engaged_ms: 71000, closed: 1,
      ...series('il', [190, 40, 8, 2, 0, 0]), ...series('f', [4100, 230, 18, 1]) }),
    visitRow(2, 'maze-dash', { t_open: 90, t_close: 106, src: 'featured', plays: 0, plays_b: 0, fav: 0, err: 't', closed: 1,
      ...series('il', z6), ...series('f', z4) }),
    visitRow(3, 'tic-tac-toe', { t_open: 110, t_close: 155, src: 'favorites', plays: 3, plays_b: 2, fav: 1, load_ms: 420, engaged_ms: 32000, closed: 1,
      ...series('il', [9, 0, 0, 0, 0, 0]), ...series('f', z4) })
  ]);
  assert.deepEqual(await s.rows('st_rounds', 'n, k'), [
    roundRow(1, 1, 'road-hopper', 'L1', { t0: 6, tier0: 2, replay: 0, t: 40, code: 'w', ms: 33500, score: 120, tier: 2, hits: 14, misses: 3,
      ...series('rt', [6, 5, 3, 2, 1, 0]), wall_ms: 34100, inputs: 41, idle: 1, pauses: 0, rt_sum: 9150, rt_n: 17, dda: 640 }),
    roundRow(1, 2, 'road-hopper', 'L2', { t0: 43, tier0: 3, replay: 0, t: 80, code: 'l', ms: 36000, score: 60, tier: 3, hits: 9, misses: 7,
      ...series('rt', [2, 4, 4, 3, 2, 1]) }),
    // A local two-player round, with no score (-1) and no DDA level (-1 is kept: the game reported it).
    roundRow(3, 1, 'tic-tac-toe', 'local', { t0: 112, tier0: 0, replay: 0, t: 150, code: 'd', ms: 37000, tier: 0, hits: 0, misses: 0,
      ...series('rt', z6), wall_ms: 37800, inputs: 9, idle: 0, pauses: 1, rt_sum: 0, rt_n: 0, dda: -1, duo: 1 })
  ]);
  assert.deepEqual((await s.rows('st_marks')).map(m => [m.kind, m.t, m.n, m.x]), [['ct', 1, 0, 's:20'],
    ['ct', 153, 0, 'e:0'], ['fv', 42, 1, '1'], ['tu', 5, 1, 's'], ['tu', 41, 1, 'd']]);
  assert.deepEqual(await s.rows('st_pcs'), [{ p: P, first_s: at, last_s: at, z: 'Asia/Riyadh', cores: 4, mem: 4, screen: 1920, k: fixture3.k }]);
  const settings = Object.fromEntries((await s.rows('settings')).map(r => [r.key, r.value]));
  // rv: 1, up once by the purge at start, and once by the change of zone.
  assert.deepEqual([settings.tz, settings.tz_source, settings.tz_epoch, settings.rv, settings.v3_since, settings.week_start, settings.rebuild],
    ['Asia/Riyadh', 'pc', '1', '3', '2026-10-20', 'sun', '1']);
  assert.deepEqual(await s.rows('live'), [{ s: fixture3.s, slug: '', seen_minute: Math.floor(START / 60000), p: P, wire: 3 }]);
  // An older portal's batch of the same session is stored as the very same facts.
  const facts = await storedFacts(s);
  const old = await start(t);
  assert.equal((await old.post(fixture3old)).status, 204);
  assert.deepEqual(await storedFacts(old), facts);
});

test('a batch writes few rows: the first v3 batch of a session at most 14, a later one at most 8, a long one one row per fact', async t => {
  const s = await start(t);
  const db = s.app.store.db, batch = db.batch.bind(db);
  let written = 0;
  db.batch = async statements => {
    const results = await batch(statements);
    written += results.reduce((n, r) => n + r.meta.rows_written, 0);
    return results;
  };
  // The rows written by every query of one request, which D1 bills (a session row is 4: the table, UNIQUE (s) and two indexes).
  const cost = async (body, ahead = 0) => {
    s.clock.now += ahead;
    const before = written;
    assert.equal((await s.post(body)).status, 204);
    return written - before;
  };
  const S = 'a00000000001', x = [30000, 40, 1, 0, 9000, 16, 600];
  // The school's zone and the first v3 day are written once, by the first v3 batch ever.
  await s.post(envelope3('a00000000000', [['ct', 1, 'c', 0]]));
  const first = await cost(envelope3(S, [['ss', 0, 0, 12, 1, 4, 6, 0], ['go', 2, 1, 'road-hopper', 'catalog', 3, 0], ['ld', 3, 1, 'road-hopper', 800],
    ['rs', 4, 1, 1, 'road-hopper', 'L1', 1, 0], ['re', 35, 1, 1, 'road-hopper', 'w', 'L1', 30000, 50, 1, 9, 2, [3, 3, 2, 1, 0, 0], x],
    ['gp', 40, 1, 'road-hopper', 31000]]), 60000);
  const later = await cost(envelope3(S, [['rs', 41, 1, 2, 'road-hopper', 'L2', 1, 0], ['re', 70, 1, 2, 'road-hopper', 'l', 'L2', 28000, 20, 1, 6, 4, z6, x],
    ['gx', 75, 1, 'road-hopper', 58000, [20, 4, 1, 0, 0, 0], [3000, 40, 2, 0]], ['go', 80, 2, 'maze-dash', 'recent', 1, 0], ['ld', 81, 2, 'maze-dash', 600]]), 20000);
  assert.ok(first <= 14, `the first batch of a session wrote ${first} rows`);
  assert.ok(later <= 8, `a later batch wrote ${later} rows`);
  // A batch of 200 events (99 rounds of one visit) writes a row per visit, round and counter, and the same few rows as any batch.
  const rounds = Array.from({ length: 99 }, (_, i) => [['rs', 100 + 2 * i, 3, i + 1, 'pizza-clicker', 'L1', 0, i],
    ['re', 101 + 2 * i, 3, i + 1, 'pizza-clicker', 'w', 'L1', 900, -1, 0, 1, 0, z6, null]]).flat();
  const long = envelope3(S, [['go', 99, 3, 'pizza-clicker', 'catalog', 0, 0], ...rounds, ['gx', 300, 3, 'pizza-clicker', 90000, z6, z4]]);
  assert.equal(long.ev.length, 200);
  const many = await cost(long, 20000);
  assert.ok(many <= 1 + 99 + 1 + 8, `a 200-event batch wrote ${many} rows`);
  // v2 batches, numbered by the server, cost about the same.
  const v2first = await cost(fixture, 60000);
  const v2later = await cost({ ...fixture, b: batchId(), ev: fixture.ev.filter(e => e[0] !== 'ss' && e[0] !== 'se') }, 20000);
  assert.ok(v2first <= 16, `the first v2 batch wrote ${v2first} rows`);
  assert.ok(v2later <= v2first, `a later v2 batch wrote ${v2later} rows`);
});

test('a repeated v2 batch id is answered 204 and stored once', async t => {
  const s = await start(t);
  assert.equal((await s.post(fixture)).status, 204);
  const before = await storedFacts(s);
  s.clock.now += 3600000;
  assert.equal((await s.post(fixture)).status, 204);
  assert.equal((await s.post({ ...fixture, ev: [['se', 1, 9]] })).status, 204, 'the id alone decides');
  assert.deepEqual(await storedFacts(s), before);
  assert.equal(await s.count('batches'), 1);
  assert.deepEqual((await s.rows('live'))[0].seen_minute, Math.floor(START / 60000), 'a repeat is not a sign of life');
});

test('the same batch arriving twice at once is stored once', async t => {
  const s = await start(t);
  const body = { ...fixture, b: batchId() };
  const answers = await Promise.all([s.post(body), s.post(body), s.post(body)]);
  assert.deepEqual(answers.map(res => res.status), [204, 204, 204]);
  assert.equal(await s.count('st_sessions'), 1);
  assert.equal(await s.count('st_visits'), 2);
  assert.equal(await s.count('st_rounds'), 3);
  assert.equal(await s.count('batches'), 1);
  const three = await Promise.all([1, 2, 3].map(() => s.post(fixture3)));
  assert.deepEqual(three.map(res => res.status), [204, 204, 204]);
  assert.equal(await s.count('st_sessions'), 2);
  assert.equal(await s.count('st_rounds'), 6);
});

// The store on the Node driver, with a hook in front of every db.batch call.
function hookedStore(hook) {
  const db = openDatabase(':memory:'), batch = db.batch.bind(db);
  db.batch = async statements => { await hook(statements); return batch(statements); };
  return { db, store: openStore(db) };
}
const writes = statements => statements.some(st => /^INSERT INTO st_sessions/.test(st.sql));
const factCounts = async db => Object.fromEntries(await Promise.all(['st_sessions', 'st_visits', 'st_rounds', 'st_marks', 'batches'].map(async table =>
  [table, (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n])));

test('a batch whose writes fail is kept whole for the retry', async () => {
  let fail = true;
  const { db, store } = hookedStore(statements => {
    if (fail && writes(statements)) { fail = false; throw new Error('D1_ERROR: Network connection lost.'); }
  });
  const valid = validateBatch(fixture);
  await assert.rejects(store.ingest(valid, START), /Network connection lost/);
  assert.deepEqual(await factCounts(db), { st_sessions: 0, st_visits: 0, st_rounds: 0, st_marks: 0, batches: 0 });
  // The PC got a 500 and sends the same batch again: it counts in full.
  assert.equal(await store.ingest(valid, START + 20000), true);
  assert.deepEqual(await factCounts(db), { st_sessions: 1, st_visits: 2, st_rounds: 3, st_marks: 0, batches: 1 });
});

test('the same v2 batch arriving twice at once is stored once, whichever finishes first', async () => {
  // The first copy is held back just before its writes, so the second copy (the portal
  // sends a batch again after a minute without an answer) is stored first.
  let held = null, release;
  const { db, store } = hookedStore(async statements => {
    if (!held && writes(statements)) { held = new Promise(resolve => { release = resolve; }); await held; }
  });
  const valid = validateBatch({ ...fixture, b: batchId() });
  const first = store.ingest(valid, START);
  while (!held) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await store.ingest(valid, START + 60000), true);
  release();
  assert.equal(await first, false, 'the held copy is the repeat');
  assert.deepEqual(await factCounts(db), { st_sessions: 1, st_visits: 2, st_rounds: 3, st_marks: 0, batches: 1 });
});

test('invalid envelopes are 400 and other media types 415, storing nothing', async t => {
  const s = await start(t);
  const { b: _b, ...noBatch } = fixture;
  const bad = [
    'not json', '', '[]', 'null', '2', JSON.stringify([fixture]),
    { ...fixture, v: 1 }, { ...fixture, v: '2' }, { ...fixture, v: 4 }, { ...fixture3, v: '3' }, { ...fixture3, v: 3.5 }, noBatch,
    { ...fixture, b: 'ABCDEF0123456789' }, { ...fixture, b: '9f3c0a17b2e44d1' }, { ...fixture, b: [fixture.b] },
    { ...fixture, s: '5d02be9a41c7aa' }, { ...fixture, s: 'p1' }, { ...fixture, s: undefined },
    { ...fixture, k: 'v1.2 build' }, { ...fixture, k: 7 }, { ...fixture, k: 'abcdef' }, { ...fixture, k: '5c18c6d2d1c052ad00' },
    { ...fixture, m: 'desktop' },
    { ...fixture, d: [4, 4] }, { ...fixture, d: [3, 4, 1920] },
    { ...fixture, d: [4, 4, '1920'] }, { ...fixture, d: [4, 3, 1920] }, { ...fixture, d: [4, 4, 1024] },
    { ...fixture, ev: {} }, { ...fixture, ev: undefined }, { ...fixture, ev: new Array(201).fill(['lv', 1, 2]) },
    // v3 keeps the core of v2 strict.
    { ...fixture3, b: 'XYZ' }, { ...fixture3, s: 'not-a-session' }, { ...fixture3, k: 'build-7' }, { ...fixture3, m: 'pwa' },
    { ...fixture3, d: [4, 4, 1280] }, { ...fixture3, ev: 'none' }, { ...fixture3, ev: new Array(201).fill(['lv', 1, 2]) }
  ];
  for (const body of bad) {
    const res = await s.post(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(res.headers['content-type'], /^application\/json/);
  }
  for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
    assert.equal((await s.post(fixture, { type })).status, 415, type);
  }
  assert.deepEqual(await storedFacts(s), Object.fromEntries(FACTS.map(table => [table, []])));
  assert.equal((await s.post(fixture, { type: 'application/json' })).status, 204);
  assert.equal((await s.post({ ...fixture, b: batchId(), ev: new Array(200).fill(['se', 1, 2]) })).status, 204, '200 events are fine');
  assert.equal((await s.post({ ...fixture3, ev: new Array(200).fill(['ct', 1, 'c', 0]) })).status, 204);
  assert.equal(await s.count('batches'), 2);
  assert.equal(await s.count('st_sessions'), 2);
  // An age band an older portal sends is never checked, nor kept: any value, or none, is a valid batch.
  for (const a of ['6', null, '12-13', 'SENTINEL-AGE', undefined]) {
    assert.equal((await s.post({ ...fixture, b: batchId(), s: 'aaaa00000001', a })).status, 204, String(a));
    assert.equal((await s.post({ ...fixture3old, s: 'aaaa00000002', a })).status, 204, String(a));
  }
  assert.deepEqual([...new Set((await s.rows('st_sessions')).map(r => r.a + '|' + r.u))], ['|']);
});

test('v3: a malformed optional field is stored as unknown and the batch is kept (the portal drops any batch a 4xx answers)', async t => {
  const s = await start(t);
  const base = envelope3('e00000000000', [['ss', 0, 0, 5, 1, 2, 3, 1], ['ct', 30, 'c', 0]]);
  // u is a student code an older portal sends: never kept, whatever it is.
  const cases = [
    [{}, ['', P, 'Asia/Riyadh', 'w']],
    [{ u: 'p1' }, ['', P, 'Asia/Riyadh', 'w']], [{ u: 'Sara' }, ['', P, 'Asia/Riyadh', 'w']], [{ u: U.toUpperCase() }, ['', P, 'Asia/Riyadh', 'w']],
    [{ u: 7 }, ['', P, 'Asia/Riyadh', 'w']], [{ u: 'c7f3a' }, ['', P, 'Asia/Riyadh', 'w']], [{ u: '' }, ['', P, 'Asia/Riyadh', 'w']],
    [{ p: 'PC-LAB-1' }, ['', '', 'Asia/Riyadh', 'w']], [{ p: P.slice(1) }, ['', '', 'Asia/Riyadh', 'w']], [{ p: 'c7f3a' }, ['', '', 'Asia/Riyadh', 'w']],
    [{ z: 'Mars/Base' }, ['', P, '', 'w']], [{ z: 'constructor' }, ['', P, '', 'w']], [{ z: 42 }, ['', P, '', 'w']], [{ z: 'utc' }, ['', P, '', 'w']],
    [{ w: -1 }, ['', P, 'Asia/Riyadh', 'r']], [{ w: 691201 }, ['', P, 'Asia/Riyadh', 'r']], [{ w: '35' }, ['', P, 'Asia/Riyadh', 'r']],
    [{ w: 1.5 }, ['', P, 'Asia/Riyadh', 'r']], [{ w: null }, ['', P, 'Asia/Riyadh', 'r']],
    [{ u: undefined, p: undefined, z: undefined, w: undefined }, ['', '', '', 'r']]
  ];
  for (const [i, [extra]] of cases.entries()) {
    const res = await s.post({ ...base, b: batchId(), s: 'e0000000' + String(i).padStart(4, '0'), ...extra });
    assert.equal(res.status, 204, JSON.stringify(extra));
  }
  assert.deepEqual((await s.rows('st_sessions', 'id')).map(r => [r.u, r.p, r.z, r.clock]), cases.map(([, stored]) => stored));
  // A round's extras are lenient too: anything but 7 valid numbers is null, and the round is kept.
  const re = x => ['re', 40, 1, 1, 'road-hopper', 'w', 'L1', 30000, 5, 1, 2, 1, z6, x];
  const extras = [[1, 2, 3], [1, 2, 3, 4, 5, 6, 'x'], [1, 2, 3, 4, 5, 6, 1001], [1, 2, 3, 4, 5, 6, -2], { wall: 1 }, 'none', 0, [1, 2, 3, 4, 5, 6, 7]];
  for (const [i, x] of extras.entries()) {
    assert.equal((await s.post(envelope3('f0000000' + String(i).padStart(4, '0'), [['go', 1, 1, 'road-hopper', 'catalog', 0, 0], re(x)]))).status, 204);
  }
  assert.deepEqual((await s.app.store.db.prepare("SELECT r.wall_ms, r.dda, r.code FROM st_rounds r JOIN st_sessions s ON s.id = r.sid WHERE s.s LIKE 'f%' ORDER BY s.id").all())
    .results.map(r => [r.wall_ms, r.dda, r.code]), [...extras.slice(0, -1).map(() => [null, null, 'w']), [1, 7, 'w']]);
  // Malformed v3 events are dropped whole, as in v2; a v2-shaped event is malformed in v3.
  const malformed = [['go', 1, 0, 'road-hopper', 'catalog', 0, 0], ['go', 1, 1, 'road-hopper', 'catalog', 0, 2], ['go', 1, 'road-hopper', 'catalog', 0],
    ['rs', 1, 1, 100000, 'road-hopper', 'L1', 1, 0], ['re', 40, 1, 1, 'road-hopper', 'w', 'L1', 30000, 5, 1, 2, 1, z6], ['gp', 1, 1, 'road-hopper', -5],
    ['tu', 1, 1, 'road-hopper', 'x'], ['fv', 1, 1, 'road-hopper', 2], ['ct', 1, 's', -1], ['ct', 1, 'started', 20],
    ['se', 1, 100, 'x'], ['se', 1, 100], ['ss'], ['ss', -1], ['ss', 'SENTINEL'], ['xx', 1]];
  // An older portal's level-ups, removed profiles and older codes are read past (whatever they hold), never kept; a
  // session start keeps only its time, whatever follows it.
  const ignored = [['lv', 1, 0], ['lv', 2, 3], ['pr', 1, 'p1'], ['cd', 1, 'C7F3A'], ['pr', 1, 'c7f3a'], ['cd', 1, 'c7f3a'], ['cd', 1, U]];
  const cleaned = validateBatch(envelope3('f00000000099', [...malformed, ...ignored, ['ss', 0, 0, 36501, 1, 3, 4, 0, 'SENTINEL'], ['ss', 3]]));
  assert.deepEqual([cleaned.dropped, cleaned.events], [malformed.length, [['ss', 0], ['ss', 3]]]);
});

test('a PC or owner that names UTC another way (Etc/UTC, GMT) sets the school\'s zone to UTC', async t => {
  const s = await start(t);
  assert.equal((await s.post(envelope3('c90000000001', [['ss', 0]], { z: 'Etc/UTC' }))).status, 204);
  assert.deepEqual((await s.rows('st_sessions')).map(r => r.z), ['UTC']);
  assert.deepEqual((await s.rows('st_pcs')).map(r => r.z), ['UTC']);
  const settings = Object.fromEntries((await s.rows('settings')).map(r => [r.key, r.value]));
  assert.deepEqual([settings.tz, settings.tz_source], ['UTC', 'pc']);
  const set = await s.send('POST', '/v1/admin/settings', { headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ tz: 'Etc/GMT' }) });
  assert.equal(set.status, 200);
  assert.deepEqual([set.json().clock.tz, set.json().clock.source], ['UTC', 'owner']);
});

test('bodies over 64 KB are 413, declared or streamed; exactly 64 KB is accepted', async t => {
  const s = await start(t);
  const json = JSON.stringify(fixture);
  const exact = json + ' '.repeat(MAX_BODY - Buffer.byteLength(json));
  assert.equal(Buffer.byteLength(exact), 65536);
  const over = exact + ' ';
  assert.equal((await s.post(over)).status, 413);
  const streamed = await s.send('POST', '/v1/batch', { headers: { 'content-type': 'text/plain', origin: ORIGIN },
    chunks: [over.slice(0, 40000), over.slice(40000)] });
  assert.equal(streamed.status, 413);
  assert.equal(streamed.headers['transfer-encoding'], undefined);
  // The rest of a large body is drained, so the answer is never lost to a connection reset.
  assert.equal((await s.post('x'.repeat(900 * 1024))).status, 413);
  assert.equal((await s.send('GET', '/v1/health')).status, 200);
  assert.equal(await s.count('batches'), 0);
  assert.equal((await s.post(exact)).status, 204);
  assert.equal(await s.count('batches'), 1);
});

test('a client that disconnects mid-body is not logged as a server error', async t => {
  const logs = [];
  const s = await start(t, { log: message => logs.push(message) });
  await new Promise((resolve, reject) => {
    const socket = net.connect(Number(new URL(s.base).port), '127.0.0.1', () => {
      socket.write('POST /v1/batch HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 1000\r\n\r\n{"v":2,');
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on('close', resolve);
    socket.on('error', reject);
  });
  const open = () => new Promise(resolve => s.app.server.getConnections((_, n) => resolve(n)));
  while (await open()) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await s.send('GET', '/v1/health')).status, 200);
  assert.deepEqual(logs, []);
  assert.equal(await s.count('batches'), 0);
});

test('unknown and malformed events are dropped while valid ones are kept; measures are clamped', async t => {
  // Facts since 12 October: a session of 7 days (the clamped ss) starts after them.
  const s = await start(t, { at: START - 8 * DAY_MS });
  s.clock.now = START;
  const malformed = [
    ['zz', 1], 'go', null, 42, {}, [], ['go'], [7, 1], ['toString', 1],
    ['go', -1, 'road-hopper', 'search', 1], ['go', 1, 'Road-Hopper', 'search', 1], ['go', 1, 'road--hopper', 'search', 1],
    ['go', 1, 'a'.repeat(41), 'search', 1], ['go', 1, 'constructor', 'search', 1], ['go', 1, 'road-hopper', 'email', 1],
    ['go', 1, 'road-hopper', 'search', 5], ['go', 1, 'road-hopper', 'search', '1'], ['go', '1', 'road-hopper', 'search', 1],
    ['go', 1, 'road-hopper', 'search'], ['go', 1, 'road-hopper', 'search', 1, 'extra'],
    ['rs', 1, 'road-hopper', 'L123', 1, 0], ['rs', 1, 'road-hopper', '1up', 1, 0], ['rs', 1, 'road-hopper', 'toString', 1, 0],
    ['rs', 1, 'road-hopper', 'Sara Ahmed', 1, 0], ['rs', 1, 'road-hopper', 'L'.repeat(25), 1, 0],
    ['rs', 1, 'road-hopper', 'L1', 10, 0], ['rs', 1, 'road-hopper', 'L1', 1.5, 0], ['rs', 1, 'road-hopper', 'L1', 1, -1],
    ['re', 1, 'road-hopper', 's', 'L1', 1, 1, 1, 1, 1, z6], ['re', 1, 'road-hopper', 'w', 'L1', 1, -2, 1, 1, 1, z6],
    ['re', 1, 'road-hopper', 'w', 'L1', 1, 1, 1, 1, 1, [0, 0, 0, 0, 0]], ['re', 1, 'road-hopper', 'w', 'L1', 1, 1, 1, 1, 1, [0, 0, 0, 0, 0, 'x']],
    ['re', 1, 'road-hopper', 'w', 'L1', 1, 1, 1, -1, 1, z6],
    ['gx', 1, 'road-hopper', 1000, z6, [0, 0, 0, null]], ['gx', 1, 'road-hopper', 1000, z6, [0, 0, 0]],
    ['er', 1, 'road-hopper', 'x', 'TypeError: secret is undefined'], ['er', 1, 'road-hopper', 'boom'],
    ['ss', -1, 0, 0, 0, 1], ['ss'], ['se', 1, null]
  ];
  // A level-up is read past; a session start keeps its time only (its profile's fields, valid or not, are read past).
  const valid = [
    ['go', 3.4, 'road-hopper', 'search', 1], ['ld', 5, 'road-hopper', 999999],
    ['rs', 6, 'road-hopper', 'w1-2', 9, 20000], ['re', 9, 'road-hopper', 'e', 'endless', 99999999, 5e12, 3, 7, 2, [1, 2, 3, 4, 5, 6]],
    ['lv', 10, 5000], ['lv', 1, 0], ['er', 11, 'road-hopper', 'l'], ['ss', 1e9, 1, 3, 4, 0], ['ss', 1, 2, 0, 0, 1], ['se', 12, 800.6]
  ];
  // 1e400 parses to Infinity, which is not a measure to clamp.
  const raw = JSON.stringify(envelope('b00000000001', [...malformed, ...valid])).slice(0, -2) + ',["ld",1,"road-hopper",1e400]]}';
  assert.equal((await s.post(raw)).status, 204);
  // The validator keeps exactly the valid events, rounded and clamped...
  const cleaned = validateBatch(JSON.parse(raw));
  assert.equal(cleaned.dropped, malformed.length + 1);
  assert.deepEqual(cleaned.events, [
    ['go', 3, 'road-hopper', 'search', 1], ['ld', 5, 'road-hopper', 120000], ['rs', 6, 'road-hopper', 'w1-2', 9, 9999],
    ['re', 9, 'road-hopper', 'e', 'endless', 10800000, 1e9, 3, 7, 2, [1, 2, 3, 4, 5, 6]],
    ['er', 11, 'road-hopper', 'l'], ['ss', 604800], ['ss', 1], ['se', 12, 801]
  ]);
  // ...and the store keeps exactly those: a re of another level than the open round is a round of its own.
  const [session] = await s.rows('st_sessions');
  assert.deepEqual([session.start_s, session.is_new, session.age_b, session.since_b, session.level0, session.se_t, session.se_ms],
    [R0 - 604800 - 10, null, null, null, null, 12, 801]);
  assert.deepEqual(await s.rows('st_visits'), [visitRow(1, 'road-hopper', { t_open: 3, src: 'search', plays_b: 1, load_ms: 120000, err: 'l' })]);
  assert.deepEqual(await s.rows('st_rounds', 'k'), [
    roundRow(1, 1, 'road-hopper', 'w1-2', { t0: 6, tier0: 9, replay: 9999 }),
    roundRow(1, 2, 'road-hopper', 'endless', { t: 9, code: 'e', ms: 10800000, score: 1e9, tier: 3, hits: 7, misses: 2, ...series('rt', [1, 2, 3, 4, 5, 6]) })
  ]);
  assert.deepEqual(await s.rows('st_marks'), []);
  const before = await storedFacts(s);
  // A batch whose events were all dropped is still a valid, de-duplicated batch.
  assert.equal((await s.post(envelope('b00000000002', malformed))).status, 204);
  assert.equal(await s.count('batches'), 2);
  assert.deepEqual(await storedFacts(s), before, 'no session row without a stored event');
  assert.equal(await s.count('live'), 1, 'nor a sign of life');
  // An empty v3 batch stores nothing at all.
  assert.equal((await s.post(envelope3('b00000000003', malformed))).status, 204);
  assert.deepEqual(await storedFacts(s), before);
  assert.equal(await s.count('batches'), 2);
});

// Every column schema 5 has (docs/RESEARCH_TELEMETRY_SPEC.md §D.2, without the per-student
// tables), written out here so that a column added anywhere fails this test until it is
// reviewed. Codes of sessions and PCs (s, p), the zone name (z) and times counted from a
// session's start are the only identifiers. The columns schema 4 kept a student's code,
// an age band, a profile's fields and per-student counts in stay, always empty ('', NULL or
// 0), so that its upgrade rewrites no row (the upgrade test checks they are empty).
const list = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
const CODES5 = ['w', 'l', 'd', 'e', 'q'];
const AGG_DAYS = ['sessions', 'web', 'app', 'engaged_ms', 'opens', 'starts', 'ends', 'errors'];
const AGG_DAYS_CLEARED = ['level_ups', 'session_starts', 'new_profiles', 'guests', ...list('profile_age', 4), ...list('since_last', 5)];
const AGG_GAMES = ['sessions', 'opens', 'closes', 'engaged_ms', 'starts', 'ends', ...CODES5, 'tier_sum', 'tier_n', 'hits', 'misses', ...list('rt', 6),
  ...list('il', 6), ...list('f', 4), 'loads', 'load_ms', 'error_t', 'error_x', 'error_l', 'src_featured', 'src_catalog', 'src_recent', 'src_favorites',
  'src_category', 'src_quick', 'src_search', 'src_related', 'src_surprise', 'src_reload', 'src_history', 'src_direct', 'src_starter',
  ...list('replay', 6), ...list('plays', 5)];
const AGG_LEVELS = ['sessions', 'starts', 'ends', ...CODES5, 'ms', 'tier_sum', 'tier_n'];
const AGG_DEVICES = ['sessions', ...list('f', 4), ...list('il', 6), 'loads', 'load_ms'];
const COLUMNS = {
  meta: ['key', 'value'], batches: ['b', 'day'], kpi_cache: ['key', 'made', 'rows'], settings: ['key', 'value'],
  usage: ['day', 'reads', 'writes', 'rebuild_reads', 'export_reads', 'size'], roll_days: ['day', 'dirty', 'rolled_s', 'rows'],
  live: ['s', 'slug', 'seen_minute', 'p', 'wire'],
  st_pcs: ['p', 'first_s', 'last_s', 'z', 'cores', 'mem', 'screen', 'k'],
  st_sessions: ['id', 's', 'u', 'p', 'wire', 'a', 'k', 'm', 'cores', 'mem', 'screen', 'start_s', 'clock', 'z', 'is_new', 'age_days', 'since_days',
    'age_b', 'since_b', 'level0', 'np', 'cls', 'se_t', 'se_ms', 'why', 'vn', 'open_n', 'open_slug', 'open_k', 'last_k'],
  st_visits: ['sid', 'n', 'slug', 't_open', 't_close', 'src', 'plays', 'plays_b', 'fav', 'load_ms', 'err', 'engaged_ms', 'closed', ...list('il', 6), ...list('f', 4)],
  st_rounds: ['sid', 'n', 'k', 'slug', 'id', 't0', 'tier0', 'replay', 't', 'code', 'ms', 'score', 'tier', 'hits', 'misses', ...list('rt', 6), 'wall_ms',
    'inputs', 'idle', 'pauses', 'rt_sum', 'rt_n', 'dda', 'duo', 'attempt'],
  st_marks: ['sid', 'kind', 't', 'n', 'x'],
  r_day: ['day', 'a', ...AGG_DAYS, 'v2_sessions', 'clock_r', 'unclosed', 'unended', 'duo', 'hearts_on', 'hearts_off', 'timer_sessions',
    'why_u', 'why_p', 'why_h', 'why_i', ...AGG_DAYS_CLEARED, 'students', 'new_students', 'guest_sessions', 'linked_ms'],
  r_game_day: ['day', 'a', 'slug', ...AGG_GAMES, 'wall_s', 'inputs', 'idle', 'pauses', 'rt_sum', 'rt_n', 'dda_sum', 'dda_n', 'score_sum',
    'score_n', 'score_max', 'unended', 'duo', 'hearts_on', 'hearts_off', 'tu_start', 'tu_done', 'fav_opens', 'students'],
  r_level_day: ['day', 'a', 'slug', 'id', ...AGG_LEVELS, 'unended', 'hits', 'misses', 'score_sum', 'score_n', 'score_max', 'wall_ms', 'dda_sum', 'dda_n',
    'students'],
  r_source_day: ['day', 'a', 'src', 'sessions', 'opens'],
  r_device_day: ['day', 'a', 'cores', 'mem', 'screen', ...AGG_DEVICES],
  r_pc_day: ['day', 'p', 'k', 'sessions', 'engaged_ms', 'opens', 'loads', 'load_ms', 'load_max', 'errors', 'quits', ...list('f', 4),
    ...list('il', 6), 'busy_s', 'first_s', 'last_s', 'wire', 'students', 'guests', 'np_max', 'new_profiles'],
  r_stat: ['day', 'a', 'metric', 'slug', 'k1', 'k2', 'n', 'w', 'l', 'q', 'ms', 'win_ms', 'hits', 'misses', 'rt_sum', 'rt_n', 'inputs', 'gap_sum', 'gap_n',
    'students', 'd', 'e', 'wall_ms', 'score_sum', 'score_n', 'tier_sum', 'tier_n', 'dda_sum', 'dda_n']
};

test('names, user agents, PC labels, typed text, profile keys, avatars, colours and addresses are never stored', async t => {
  const s = await start(t);
  const secrets = ['SENTINEL-NAME', 'SENTINEL-UA', 'SENTINEL-PC-LAB', 'SENTINEL-LABEL', 'SENTINEL-ERROR', 'p9z8y7', 'مختبر سارة', 'زرافة سرية',
    'SENTINEL-AVATAR', '🦊', '#e85d75', 'SENTINEL-COLOUR', '198.51.100.23', '127.0.0.1', 'SENTINEL-COOKIE', 'SENTINEL-REFERER', 'SENTINEL-UA-HEADER', 'sara'];
  const extra = { name: 'sara SENTINEL-NAME', ua: 'Mozilla/5.0 SENTINEL-UA', pc: 'SENTINEL-PC-LAB', label: 'مختبر سارة SENTINEL-LABEL',
    err: 'TypeError SENTINEL-ERROR', player: 'p9z8y7', avatar: 'SENTINEL-AVATAR 🦊', colour: '#e85d75', color: 'SENTINEL-COLOUR', ip: '198.51.100.23', time: Date.now() };
  const headers = { 'user-agent': 'SENTINEL-UA-HEADER', 'x-forwarded-for': '198.51.100.23', cookie: 'sid=SENTINEL-COOKIE',
    referer: 'https://school.example/SENTINEL-REFERER' };
  const v2body = {
    ...fixture, b: batchId(), ...extra, p: 'p9z8y7',
    ev: [
      ...fixture.ev,
      ['er', 200, 'road-hopper', 'x', 'TypeError SENTINEL-ERROR'], ['ss', 0, 0, 0, 4, 0, 'p9z8y7'],
      ['go', 201, 'road-hopper', 'search', 0, 'sara SENTINEL-NAME'], ['rs', 202, 'road-hopper', 'p9z8y7', 1, 0, 'SENTINEL-LABEL'],
      { t: 'go', name: 'SENTINEL-NAME' }
    ]
  };
  assert.equal((await s.post(v2body, { headers })).status, 204);
  // v3: the codes and the zone must have their exact forms, or they are stored as unknown.
  const v3body = {
    ...fixture3, ...extra, u: 'p9z8y7', p: 'SENTINEL-PC-LAB', z: 'مختبر سارة', w: 'SENTINEL-NAME',
    ev: [
      ...fixture3.ev,
      ['go', 200, 4, 'road-hopper', 'search', 0, 0, 'sara SENTINEL-NAME'], ['pr', 201, 'p9z8y7'], ['cd', 202, 'SENTINEL-NAME'], ['cd', 202, 'p1'],
      ['ct', 203, 'SENTINEL-LABEL', 20], ['tu', 204, 1, 'road-hopper', 'زرافة سرية'], ['fv', 205, 1, 'road-hopper', '🦊'],
      ['re', 206, 1, 9, 'road-hopper', 'w', 'Sara Ahmed', 1, 1, 1, 1, 1, z6, null], ['er', 207, 1, 'road-hopper', 'x', 'TypeError SENTINEL-ERROR']
    ]
  };
  assert.equal((await s.post(v3body, { headers })).status, 204);
  const [, session3] = await s.rows('st_sessions', 'id');
  assert.deepEqual([session3.u, session3.p, session3.z, session3.clock], ['', '', '', 'r'], 'unknown, not the text sent');
  // A child's real code, from an older portal, is not kept either; nor its age band or profile.
  assert.equal((await s.post({ ...fixture3old, b: batchId(), s: 'f1f1f1f1f1f1' }, { headers })).status, 204);
  assert.deepEqual((await s.rows('st_sessions', 'id')).map(r => [r.u, r.a, r.is_new, r.age_days, r.level0, r.np, r.cls]), Array(3).fill(['', '', null, null, null, null, null]));
  secrets.push(U, '1b2c3d4e5f60', '5e6f7a8b9c0d', '8-9');
  const db = s.app.store.db;
  const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).results.map(r => r.name);
  assert.deepEqual(tables.sort(), Object.keys(COLUMNS).sort());
  // One named index (the spec's five, less r_stat's by metric: every r_stat read finds its
  // rows by day and a, and less the three of per-student tables), and the one UNIQUE (s) of st_sessions; no other.
  const indexes = (await db.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' ORDER BY name").all()).results;
  assert.deepEqual(indexes.filter(i => i.sql).map(i => i.name), ['st_sessions_time']);
  assert.deepEqual(indexes.filter(i => !i.sql).map(i => i.tbl_name), ['st_sessions']);
  for (const table of tables) {
    const info = (await db.prepare(`PRAGMA table_info(${table})`).all()).results;
    assert.deepEqual(info.map(c => c.name), COLUMNS[table], table);
    for (const row of await s.rows(table)) {
      for (const [column, value] of Object.entries(row)) {
        for (const secret of secrets) assert.ok(!String(value).includes(secret), `${table}.${column} holds ${secret}`);
        assert.notEqual(value, 'p1', `${table}.${column} holds a profile key`);
      }
    }
  }
  assert.deepEqual((await s.rows('meta')), [{ key: 'schema', value: SCHEMA_VERSION }]);
  // Nor anywhere in the database files, including the write-ahead log.
  for (const file of fs.readdirSync(s.dbDir)) {
    const bytes = fs.readFileSync(path.join(s.dbDir, file));
    for (const secret of secrets.filter(x => Buffer.byteLength(x) > 5)) assert.equal(bytes.indexOf(secret), -1, `${file} holds ${secret}`);
  }
});

test('CORS echoes only listed origins, never with credentials, and null only when listed', async t => {
  const s = await start(t);
  const allowed = await s.post(fixture);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);
  // How long the portal waits before its next batch, readable by the page.
  assert.equal(allowed.headers['x-batch-every'], '60');
  assert.equal(allowed.headers['access-control-expose-headers'], 'Retry-After, X-Batch-Every');
  assert.match(allowed.headers.vary, /\bOrigin\b/);
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
  for (const origin of ['https://evil.example', 'http://school.example', 'https://school.example.evil', 'null']) {
    const health = await s.send('GET', '/v1/health', { headers: { origin } });
    assert.equal(health.status, 200);
    assert.equal(health.headers['access-control-allow-origin'], undefined, origin);
    assert.match(health.headers.vary, /\bOrigin\b/);
    const denied = await s.post({ ...fixture, b: batchId() }, { origin });
    assert.equal(denied.status, 403, origin);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
    assert.equal(denied.headers['access-control-expose-headers'], undefined);
  }
  assert.equal(await s.count('batches'), 1);
  // Tools without a browser send no Origin.
  assert.equal((await s.post({ ...fixture, b: batchId() }, { origin: '' })).status, 204);

  const withNull = await start(t, { allowedOrigins: [ORIGIN, 'null'] });
  const fromFile = await withNull.post(fixture, { origin: 'null' });
  assert.equal(fromFile.status, 204);
  assert.equal(fromFile.headers['access-control-allow-origin'], 'null');
  assert.equal(fromFile.headers['access-control-allow-credentials'], undefined);
});

test('OPTIONS preflight answers listed origins only', async t => {
  const s = await start(t);
  const preflight = { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' };
  const ok = await s.send('OPTIONS', '/v1/batch', { headers: preflight });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.match(ok.headers['access-control-allow-methods'], /\bPOST\b/);
  assert.match(ok.headers['access-control-allow-headers'], /Content-Type/i);
  assert.match(ok.headers['access-control-allow-headers'], /Authorization/i);
  assert.equal(ok.headers['access-control-max-age'], '86400');
  assert.equal(ok.headers['access-control-allow-credentials'], undefined);
  const admin = await s.send('OPTIONS', '/v1/admin/kpis', { headers: { ...preflight, 'access-control-request-method': 'GET' } });
  assert.equal(admin.status, 204);
  assert.equal(admin.headers['access-control-allow-origin'], ORIGIN);
  const denied = await s.send('OPTIONS', '/v1/batch', { headers: { ...preflight, origin: 'https://evil.example' } });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  assert.equal(denied.headers['access-control-allow-methods'], undefined);
  assert.match(denied.headers.vary, /\bOrigin\b/);
});

test('the per-client token bucket answers 429 with Retry-After and refills', async t => {
  const s = await start(t, { ratePerMin: 2 });
  assert.equal((await s.send('GET', '/v1/health')).status, 200);
  assert.equal((await s.post(fixture)).status, 204);
  const limited = await s.post({ ...fixture, b: batchId() });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '30');
  assert.equal(limited.headers['access-control-allow-origin'], ORIGIN, 'the page can read the status');
  assert.equal(limited.headers['access-control-expose-headers'], 'Retry-After, X-Batch-Every', 'and the wait');
  assert.equal(await s.count('batches'), 1);
  s.clock.now += 30000;
  assert.equal((await s.send('GET', '/v1/health')).status, 200);
  assert.equal((await s.send('GET', '/v1/health')).status, 429);
  s.clock.now += 60000;
  assert.equal((await s.send('GET', '/v1/health')).status, 200);
  assert.equal((await s.send('GET', '/v1/health')).status, 200);
  assert.equal((await s.send('GET', '/v1/health')).status, 429);

  // Behind a trusted proxy each client address gets its own bucket; spoofed entries do not help.
  const proxied = await start(t, { ratePerMin: 2, trustProxy: 1 });
  const from = xff => proxied.send('GET', '/v1/health', { headers: { 'x-forwarded-for': xff } });
  assert.equal((await from('203.0.113.1')).status, 200);
  assert.equal((await from('203.0.113.1')).status, 200);
  assert.equal((await from('203.0.113.1')).status, 429);
  assert.equal((await from('198.51.100.7, 203.0.113.1')).status, 429);
  assert.equal((await from('203.0.113.2')).status, 200);
  const off = await start(t, { ratePerMin: 0 });
  for (let i = 0; i < 5; i++) assert.equal((await off.send('GET', '/v1/health')).status, 200);
});

test('admin endpoints are 404 without ADMIN_TOKEN and 401 without the right bearer token', async t => {
  const closed = await start(t, { adminToken: '' });
  for (const pathname of ['/v1/admin/kpis', '/v1/admin/live', '/v1/admin/settings']) {
    assert.equal((await closed.send('GET', pathname)).status, 404);
    assert.equal((await closed.admin(pathname)).status, 404);
  }
  const s = await start(t);
  for (const pathname of ['/v1/admin/kpis', '/v1/admin/live', '/v1/admin/settings']) {
    const none = await s.send('GET', pathname);
    assert.equal(none.status, 401);
    assert.match(none.headers['www-authenticate'], /^Bearer/);
    for (const authorization of ['Bearer wrong-token-0123456789', 'Bearer ' + TOKEN + 'x', 'Bearer ' + TOKEN.slice(1),
      'Basic ' + Buffer.from('admin:' + TOKEN).toString('base64'), TOKEN, 'Bearer']) {
      assert.equal((await s.send('GET', pathname, { headers: { authorization } })).status, 401, authorization);
    }
    const ok = await s.admin(pathname);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    assert.equal((await s.send('GET', pathname, { headers: { authorization: 'bearer ' + TOKEN } })).status, 200);
    // Settings take a JSON body; the other reads take no POST.
    assert.equal((await s.send('POST', pathname, { headers: { authorization: 'Bearer ' + TOKEN } })).status, pathname.endsWith('settings') ? 415 : 405);
  }
});

// Four sessions on two days. S1 to S3 are 6-7 year olds on day one, S4 is 10-11 on day two.
const S1 = 'a00000000001', S2 = 'a00000000002', S3 = 'a00000000003', S4 = 'a00000000004';
const DAY_ONE = [
  envelope(S1, [
    ['ss', 0, 1, 0, 4, 1], ['go', 1, 'road-hopper', 'featured', 0], ['ld', 2, 'road-hopper', 800],
    ['rs', 3, 'road-hopper', 'L1', 1, 0], ['re', 30, 'road-hopper', 'w', 'L1', 27000, 120, 2, 10, 2, [5, 4, 2, 1, 0, 0]],
    ['rs', 31, 'road-hopper', 'L2', 2, 0], ['re', 60, 'road-hopper', 'l', 'L2', 29000, 80, 2, 6, 4, [2, 3, 3, 1, 1, 0]],
    ['gx', 61, 'road-hopper', 58000, [50, 10, 2, 0, 0, 0], [900, 80, 15, 5]], ['lv', 62, 2]
  ]),
  envelope(S1, [
    ['go', 70, 'tank-splat', 'catalog', 0], ['gx', 100, 'tank-splat', 30000, [10, 0, 0, 0, 0, 0], [500, 0, 0, 0]],
    ['se', 110, 88000]
  ]),
  envelope(S2, [
    ['ss', 0, 0, 1, 1, 3], ['go', 1, 'road-hopper', 'recent', 2], ['ld', 2, 'road-hopper', 1200],
    ['rs', 3, 'road-hopper', 'L1', 1, 0], ['re', 20, 'road-hopper', 'q', 'L1', 17000, -1, 1, 3, 5, [0, 1, 2, 2, 1, 1]],
    ['rs', 21, 'road-hopper', 'L1', 1, 1], ['re', 50, 'road-hopper', 'w', 'L1', 29000, 100, 1, 8, 1, [3, 3, 2, 1, 0, 0]],
    ['gx', 51, 'road-hopper', 46000, [20, 10, 5, 5, 0, 0], [400, 200, 90, 10]]
  ], { d: [4, 2, 1366] }),
  envelope(S3, [
    ['go', 1, 'road-hopper', 'featured', 1], ['ld', 3, 'road-hopper', 1000],
    ['rs', 4, 'road-hopper', 'L1', 0, 0], ['re', 40, 'road-hopper', 'w', 'L1', 36000, 150, 0, 0, 0, z6],
    ['gx', 41, 'road-hopper', 36000, z6, [100, 0, 0, 0]]
  ], { m: 'app' })
];
const DAY_TWO = [
  envelope(S4, [
    ['ss', 0, 0, 3, 0, 9], ['go', 1, 'tank-splat', 'featured', 4], ['er', 5, 'tank-splat', 't'],
    ['gx', 6, 'tank-splat', 0, z6, [0, 0, 0, 0]]
  ], { a: '10-11', d: [8, 8, 2560], k: '5c18c6d2d1c052ad' })
];

async function dataset(t) {
  const s = await start(t);
  for (const body of DAY_ONE) assert.equal((await s.post(body)).status, 204);
  s.clock.now += DAY_MS;
  for (const body of DAY_TWO) assert.equal((await s.post(body)).status, 204);
  return s;
}

test('settings: the school\'s clock, retention, storage and usage; the dashboard\'s zone yields to the PCs\', the owner\'s to nothing', async t => {
  const s = await start(t);
  const post = (body, headers = {}) => s.send('POST', '/v1/admin/settings', { headers: { authorization: 'Bearer ' + TOKEN,
    'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const get = async () => (await s.admin('/v1/admin/settings')).json();
  const first = await get();
  assert.deepEqual(first, {
    v: 1,
    clock: { tz: 'UTC', source: 'none', offsetMin: 0, today: '2026-10-20', now: '09:15', weekStart: 'mon', weekSource: 'auto', detected: [],
      factsSince: '2026-10-20', legacyUntil: '', v3Since: '' },
    keep: { days: 400, source: 'env', rollupDays: 800 },
    storage: { bytes: first.storage.bytes, limit: 500000000, guardAt: 425000000, trimmedBefore: '' },
    usage: { day: '2026-10-20', reads: first.usage.reads, writes: first.usage.writes, readsLimit: 5000000, writesLimit: 100000, batchEvery: 60 },
    rebuild: { pending: 0, full: 0, done: 0 }, accepts: [2, 3], pcs: { new: 0, seen14d: 0 }, clearing: null
  });
  assert.ok(first.storage.bytes > 0 && first.usage.writes > 0, 'the meters move');
  await s.app.store.db.batch([s.app.store.db.prepare("INSERT INTO roll_days (day, dirty, rolled_s) VALUES ('2026-10-19', 0, 1), ('2026-10-20', 0, 1)")]);
  const days = async () => (await s.rows('roll_days', 'day')).map(r => r.dirty);
  const clean = () => s.app.store.db.prepare('UPDATE roll_days SET dirty = 0').run();

  // Signed in, the dashboard sends its browser's zone while nothing better is known.
  let answer = (await post({ tz: 'Asia/Riyadh', source: 'dashboard' })).json();
  assert.deepEqual(pick(answer.clock, ['tz', 'source', 'offsetMin', 'now', 'weekStart', 'weekSource']),
    { tz: 'Asia/Riyadh', source: 'dashboard', offsetMin: 180, now: '12:15', weekStart: 'sun', weekSource: 'auto' });
  assert.deepEqual(await days(), [0, 2], 'the days since facts_since move to the new clock');
  assert.deepEqual(answer.rebuild, { pending: 1, full: 1, done: 0 });
  await clean();
  // A PC's zone wins over the dashboard's; then the dashboard's guess is ignored.
  assert.equal((await s.post(envelope3('ca0000000001', [['ct', 1, 'c', 0]], { z: 'Europe/London' }))).status, 204);
  s.clock.now += 6 * 60000;
  answer = await get();
  assert.deepEqual([answer.clock.tz, answer.clock.source, answer.clock.weekStart, answer.clock.detected], ['Europe/London', 'pc', 'mon', []]);
  assert.deepEqual(await days(), [0, 2]);
  await clean();
  assert.equal((await s.post(envelope3('ca0000000002', [['ss', 0, 0, 3, 1, 2, 4, 0]], { z: 'Europe/London' }))).status, 204);
  answer = (await post({ tz: 'Asia/Riyadh', source: 'dashboard' })).json();
  assert.deepEqual([answer.clock.tz, answer.clock.source, answer.clock.detected, answer.pcs], ['Europe/London', 'pc', [{ tz: 'Europe/London', pcs: 1 }],
    { new: 1, seen14d: 1 }]);
  assert.deepEqual(await days(), [0, 0]);
  // The owner's click wins, and no PC moves it.
  answer = (await post({ tz: 'Asia/Riyadh' })).json();
  assert.deepEqual([answer.clock.tz, answer.clock.source, answer.clock.weekStart], ['Asia/Riyadh', 'owner', 'sun']);
  assert.deepEqual(await days(), [0, 2]);
  assert.equal((await s.post(envelope3('ca0000000003', [['ct', 1, 'c', 0]], { z: 'Europe/Paris', p: '0a0b0c0d0e0f' }))).status, 204);
  s.clock.now += 6 * 60000;
  assert.deepEqual(pick((await get()).clock, ['tz', 'source']), { tz: 'Asia/Riyadh', source: 'owner' });
  // The same zone from the owner again changes nothing.
  await clean();
  await post({ tz: 'Asia/Riyadh' });
  assert.deepEqual(await days(), [0, 0]);
  // Week start and retention.
  answer = (await post({ weekStart: 'mon', keepDays: 760 })).json();
  assert.deepEqual([answer.clock.weekStart, answer.clock.weekSource, answer.keep], ['mon', 'owner', { days: 760, source: 'owner', rollupDays: 800 }]);
  answer = (await post({ tz: 'Europe/London' })).json();
  assert.deepEqual([answer.clock.tz, answer.clock.weekStart], ['Europe/London', 'mon'], 'the owner\'s week start stays');
  const nothing = (await post({})).json(), now = await get();
  assert.deepEqual({ ...nothing, usage: null }, { ...now, usage: null }, 'an empty body changes nothing');

  // Bad requests change nothing.
  const before = await s.rows('settings', 'key');
  for (const [body, status, error] of [[{ tz: 'Mars/Olympus' }, 400, 'tz'], [{ tz: 'constructor' }, 400, 'tz'], [{ tz: 3 }, 400, 'tz'],
    [{ source: 'dashboard' }, 400, 'source'], [{ tz: 'UTC', source: 'pc' }, 400, 'source'], [{ weekStart: 'tue' }, 400, 'weekStart'],
    [{ keepDays: 500 }, 400, 'keepDays'], [{ keepDays: '400' }, 400, 'keepDays'], [{ tz: 'UTC', name: 'x' }, 400, 'field'], [[], 400, 'body'],
    [null, 400, 'body'], ['{', 400, 'json'], [{ tz: 'UTC'.padEnd(5000, ' ') }, 413, 'too large']]) {
    const res = await post(body);
    assert.deepEqual([res.status, res.json()], [status, { error }], JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await post({ tz: 'UTC' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await s.send('POST', '/v1/admin/settings', { headers: { 'content-type': 'application/json' }, body: '{"tz":"UTC"}' })).status, 401);
  const wrong = await s.send('DELETE', '/v1/admin/settings', { headers: { authorization: 'Bearer ' + TOKEN } });
  assert.deepEqual([wrong.status, wrong.headers.allow], [405, 'GET, POST, HEAD, OPTIONS']);
  assert.deepEqual(await s.rows('settings', 'key'), before);
});

test('keeping two school years is refused when the database would outgrow the storage guard', async () => {
  const db = openDatabase(':memory:'), first = openStore(db);
  await first.ingest(validateBatch(fixture3), START);
  // A guard above the database's size now, and below it kept 760 days instead of 400.
  const size = (await first.settings(START)).storage.bytes, store = openStore(db, { guards: { bytes: Math.round(size * 1.5) } });
  assert.equal((await store.settings(START)).storage.bytes, size, 'the test database is ' + size + ' bytes');
  assert.deepEqual(await store.updateSettings({ keepDays: 760 }, START), { error: 'storage' });
  assert.equal((await store.settings(START)).keep.days, 400);
  assert.deepEqual((await store.updateSettings({ keepDays: 400 }, START)).keep, { days: 400, source: 'owner', rollupDays: 800 });
});

test('the read guard: once today\'s reads pass 4.2 million, admin reads but live and settings answer 429 until 00:00 UTC on the school\'s clock', async t => {
  const s = await start(t);
  await s.send('POST', '/v1/admin/settings', { headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ tz: 'Asia/Riyadh' }) });
  assert.equal((await s.admin('/v1/admin/kpis')).status, 200);
  await s.app.store.db.prepare('UPDATE usage SET reads = 4200001').run();
  // Each instance reads the day's usage again within 5 minutes.
  s.clock.now += 5 * 60000;
  const stopped = await s.admin('/v1/admin/kpis');
  assert.deepEqual([stopped.status, stopped.json()], [429, { error: 'reads', until: '03:00' }]);
  assert.equal((await s.admin('/v1/admin/live')).status, 200);
  assert.equal((await s.admin('/v1/admin/settings')).status, 200);
  assert.equal((await s.post(envelope('cb0000000001', [['se', 1, 2]]))).status, 204, 'batches are never refused');
  // A new UTC day starts again.
  s.clock.now = Date.parse('2026-10-21T00:00:00Z');
  assert.equal((await s.admin('/v1/admin/kpis')).status, 200);
});

const NO_EXTRAS = { hearts: { on: 0, off: 0 }, tutorials: { start: 0, done: 0 }, wallMinutes: 0, actionsPerMinute: null, unended: 0, duoRounds: 0 };
const UTC_CLOCK = today => ({ tz: 'UTC', source: 'none', offsetMin: 0, today });

test('KPIs are exact for a hand-built dataset, and every group is shown with its numbers, even one session', async t => {
  const s = await dataset(t);
  const res = await s.admin('/v1/admin/kpis?from=2026-10-20&to=2026-10-21');
  assert.equal(res.status, 200);
  const z6 = [0, 0, 0, 0, 0, 0], empty = { counts: [0, 0, 0, 0], smoothShare: null, stallShare: null };
  assert.deepEqual(res.json(), {
    v: 1, range: { from: '2026-10-20', to: '2026-10-21', days: 2, legacyUntil: '', factsSince: '2026-10-20' }, minSessions: 0,
    clock: UTC_CLOCK('2026-10-21'),
    totals: { sessions: 4, engagedMinutes: 2.8, avgEngagedMinutesPerSession: 0.71, gameOpens: 5, roundsStarted: 5, roundsEnded: 5, errors: 1 },
    daily: [{ day: '2026-10-20', sessions: 3, engagedMinutes: 2.8, opens: 4 }, { day: '2026-10-21', sessions: 1, engagedMinutes: 0, opens: 1 }],
    games: [
      {
        slug: 'road-hopper', sessions: 3, opens: 3, closes: 3, engagedMinutes: 2.3, avgEngagedSecPerOpen: 46.7,
        rounds: { starts: 5, ends: 5, codes: { w: 3, l: 1, d: 0, e: 0, q: 1 } },
        completionRate: 0.6, winRate: 0.75, dropOffRate: 0.2, avgTier: 1.25, hits: 27, misses: 12, accuracy: 0.6923,
        rt: [10, 11, 9, 5, 2, 1], il: [70, 20, 7, 5, 0, 0],
        frames: { counts: [1400, 280, 105, 15], smoothShare: 0.7778, stallShare: 0.0083 },
        loads: 3, avgLoadMs: 1000, errors: { t: 0, x: 0, l: 0 }, sources: { featured: 2, recent: 1 },
        replay: { replayIndex: [4, 1, 0, 0, 0, 0], playsBefore: [1, 1, 1, 0, 0] },
        ...NO_EXTRAS, avgScore: 112.5
      },
      // Two sessions on two days: shown in full.
      {
        slug: 'tank-splat', sessions: 2, opens: 2, closes: 2, engagedMinutes: 0.5, avgEngagedSecPerOpen: 15,
        rounds: { starts: 0, ends: 0, codes: { w: 0, l: 0, d: 0, e: 0, q: 0 } },
        completionRate: null, winRate: null, dropOffRate: null, avgTier: null, hits: 0, misses: 0, accuracy: null,
        rt: z6, il: [10, 0, 0, 0, 0, 0], frames: { counts: [500, 0, 0, 0], smoothShare: 1, stallShare: 0 },
        loads: 0, avgLoadMs: null, errors: { t: 1, x: 0, l: 0 }, sources: { featured: 1, catalog: 1 },
        replay: { replayIndex: z6, playsBefore: [1, 0, 0, 0, 1] }, ...NO_EXTRAS, avgScore: null
      }
    ],
    levels: [
      { slug: 'road-hopper', id: 'L1', sessions: 3, starts: 4, ends: 4, codes: { w: 3, l: 0, d: 0, e: 0, q: 1 },
        completionRate: 0.75, winRate: 1, dropOffRate: 0.25, avgMs: 27250, avgTier: 1, avgScore: 123.3, unended: 0 },
      { slug: 'road-hopper', id: 'L2', sessions: 1, starts: 1, ends: 1, codes: { w: 0, l: 1, d: 0, e: 0, q: 0 },
        completionRate: 0, winRate: 0, dropOffRate: 0, avgMs: 29000, avgTier: 2, avgScore: 80, unended: 0 }
    ],
    sources: [{ src: 'featured', sessions: 3, opens: 3 }, { src: 'catalog', sessions: 1, opens: 1 }, { src: 'recent', sessions: 1, opens: 1 }],
    devices: {
      cores: [
        { value: 4, sessions: 3, frames: { counts: [1900, 280, 105, 15], smoothShare: 0.8261, stallShare: 0.0065 },
          il: [80, 20, 7, 5, 0, 0], avgLoadMs: 1000 },
        { value: 8, sessions: 1, frames: empty, il: z6, avgLoadMs: null }
      ],
      memory: [
        { value: 2, sessions: 1, frames: { counts: [400, 200, 90, 10], smoothShare: 0.5714, stallShare: 0.0143 }, il: [20, 10, 5, 5, 0, 0], avgLoadMs: 1200 },
        { value: 4, sessions: 2, frames: { counts: [1500, 80, 15, 5], smoothShare: 0.9375, stallShare: 0.0031 }, il: [60, 10, 2, 0, 0, 0], avgLoadMs: 900 },
        { value: 8, sessions: 1, frames: empty, il: z6, avgLoadMs: null }
      ],
      screen: [
        { value: 1366, sessions: 1, frames: { counts: [400, 200, 90, 10], smoothShare: 0.5714, stallShare: 0.0143 }, il: [20, 10, 5, 5, 0, 0], avgLoadMs: 1200 },
        { value: 1920, sessions: 2, frames: { counts: [1500, 80, 15, 5], smoothShare: 0.9375, stallShare: 0.0031 }, il: [60, 10, 2, 0, 0, 0], avgLoadMs: 900 },
        { value: 2560, sessions: 1, frames: empty, il: z6, avgLoadMs: null }
      ]
    },
    modes: [{ mode: 'web', sessions: 3 }, { mode: 'app', sessions: 1 }],
    quality: { v2Share: 1, clockEstimatedShare: 1, unclosedVisits: 0, idleHandovers: 0, pcsNew: 0, oldVersionSessionShare: 1 }
  });
  assert.doesNotMatch(res.text, /suppressed|band|student|guest|profile|players|levelUps/);
  // An age band an older dashboard asks for is no filter: the answer is the same.
  assert.deepEqual({ ...(await s.admin('/v1/admin/kpis?from=2026-10-20&to=2026-10-21&band=6-7')).json(), clock: null }, { ...res.json(), clock: null });
  // A single session's day: its numbers, like any other.
  const lonely = (await s.admin('/v1/admin/kpis?from=2026-10-21&to=2026-10-21')).json();
  assert.equal(lonely.totals.sessions, 1);
  assert.deepEqual(lonely.games.map(g => [g.slug, g.sessions, g.opens, g.errors.t]), [['tank-splat', 1, 1, 1]]);
  assert.deepEqual(lonely.daily, [{ day: '2026-10-21', sessions: 1, engagedMinutes: 0, opens: 1 }]);

  // Once both days are rolled up (the cron, after 01:00 the next day), the answer is the same, from the rollups.
  const before = (await s.admin('/v1/admin/kpis?from=2026-10-20&to=2026-10-21')).json();
  s.clock.now = Date.parse('2026-10-22T01:30:00Z');
  assert.deepEqual(await s.app.roll(), { rolled: '2026-10-20', kind: 'first', voted: null, purged: null, deleted: null, cleared: null });
  assert.deepEqual((await s.app.roll()).rolled, '2026-10-21');
  assert.deepEqual((await s.rows('r_day', 'day, a')).map(r => [r.day, r.a, r.sessions]), [['2026-10-20', '', 3], ['2026-10-21', '', 1]]);
  const after = (await s.admin('/v1/admin/kpis?from=2026-10-20&to=2026-10-21')).json();
  assert.deepEqual({ ...after, clock: null }, { ...before, clock: null });
});

// Sessions of an older portal (with student codes, age bands and profile fields) on two
// days, zone UTC: the KPIs count sessions, play and PCs, never the children behind them.
const U1 = '1a1a1a1a1a1a', U2 = '2b2b2b2b2b2b', U3 = '3c3c3c3c3c3c', U4 = '4d4d4d4d4d4d', U5 = '5e5e5e5e5e5e';
const P2 = '0a0b0c0d0e0f';
const ss3 = (isNew, age, band) => ['ss', 0, isNew, age, age < 0 ? -1 : 1, band ? 3 : 0, 4, 0];
const visit = (n, slug, t, ms) => [['go', t, n, slug, 'catalog', 1, 0], ['gx', t + 30, n, slug, ms, [9, 0, 0, 0, 0, 0], [100, 0, 0, 0]]];
const STUDENT_DAYS = [
  [START - DAY_MS, envelope3('b10000000001', [ss3(0, 5, 1), ...visit(1, 'road-hopper', 2, 180000)], { u: U3, a: '6-7' })],
  [START - DAY_MS, envelope3('b10000000002', [ss3(0, 2, 1), ...visit(1, 'maze-dash', 2, 60000)], { u: U4, p: P2 })],
  [START, envelope3('b20000000001', [ss3(1, 0, 1), ['go', 2, 1, 'road-hopper', 'starter', 0, 0], ['tu', 3, 1, 'road-hopper', 's'],
    ['rs', 4, 1, 1, 'road-hopper', 'L1', 2, 0], ['re', 40, 1, 1, 'road-hopper', 'w', 'L1', 30000, 50, 2, 10, 2, z6, [30000, 40, 0, 0, 6000, 10, 500]],
    ['tu', 41, 1, 'road-hopper', 'd'], ['fv', 42, 1, 'road-hopper', 1], ['rs', 43, 1, 2, 'road-hopper', 'L2', 2, 0],
    ['re', 80, 1, 2, 'road-hopper', 'l', 'L2', 30000, 20, 2, 5, 5, z6, null], ['gx', 90, 1, 'road-hopper', 120000, z6, z4], ['lv', 90, 2]], { u: U1 })],
  [START, envelope3('b20000000002', [ss3(0, 30, 1), ['cd', 0, U4], ...visit(1, 'road-hopper', 2, 200000), ...visit(2, 'maze-dash', 40, 100000)],
    { u: U2, p: P2 })],
  [START, envelope3('b20000000003', [ss3(0, 6, 1), ...visit(1, 'road-hopper', 2, 60000), ['se', 50, 60000, 'i']], { u: U3, a: '6-7' })],
  [START, envelope3('b20000000004', [ss3(0, -1, 0), ['pr', 1, U3], ...visit(1, 'road-hopper', 2, 30000)], { u: '', a: '6-7' })],
  [START, envelope3('b20000000005', [ss3(0, 30, 1), ...visit(1, 'tank-splat', 2, 90000)], { u: U5, p: P2, a: '10-11' })]
];

test('KPIs of an older portal\'s sessions (student codes, bands, profiles) count the play, the PCs and the data quality, never a child', async t => {
  const s = await start(t, { at: START - DAY_MS });
  for (const [at, body] of STUDENT_DAYS) {
    s.clock.now = at;
    assert.equal((await s.post({ ...body, z: '' })).status, 204);
  }
  const check = async () => {
    const today = (await s.admin('/v1/admin/kpis?from=2026-10-20&to=2026-10-20')).json();
    assert.deepEqual(today.totals, { sessions: 5, engagedMinutes: 10, avgEngagedMinutesPerSession: 2, gameOpens: 6, roundsStarted: 2, roundsEnded: 2, errors: 0 });
    assert.deepEqual(today.daily, [{ day: '2026-10-20', sessions: 5, engagedMinutes: 10, opens: 6 }]);
    const game = slug => today.games.find(g => g.slug === slug);
    assert.deepEqual(pick(game('road-hopper'), ['hearts', 'tutorials', 'wallMinutes', 'actionsPerMinute', 'avgScore', 'unended', 'duoRounds']),
      { hearts: { on: 1, off: 0 }, tutorials: { start: 1, done: 1 }, wallMinutes: 0.5, actionsPerMinute: 80, avgScore: 35, unended: 0, duoRounds: 0 });
    assert.deepEqual(today.games.map(g => [g.slug, g.sessions]), [['maze-dash', 1], ['road-hopper', 4], ['tank-splat', 1]]);
    assert.deepEqual(today.levels.map(l => [l.id, l.sessions, l.avgScore]), [['L1', 1, 50], ['L2', 1, 20]]);
    assert.deepEqual(today.quality, { v2Share: 0, clockEstimatedShare: 0, unclosedVisits: 0, idleHandovers: 1, pcsNew: 2, oldVersionSessionShare: 0 });
    const both = (await s.admin('/v1/admin/kpis?from=2026-10-19&to=2026-10-20')).json();
    assert.deepEqual(both.daily.map(d => [d.day, d.sessions]), [['2026-10-19', 2], ['2026-10-20', 5]]);
    for (const k of [today, both]) assert.doesNotMatch(JSON.stringify(k), /student|band|guest|profile|players|6-7|8-9|10-11|1a1a|2b2b|3c3c|4d4d|5e5e/);
    return [today, both];
  };
  s.clock.now = START + 3600000;
  const open = await check();
  // Rolled up, the answers are the same.
  s.clock.now = Date.parse('2026-10-21T02:00:00Z');
  assert.equal((await s.app.roll()).rolled, '2026-10-19');
  assert.equal((await s.app.roll()).rolled, '2026-10-20');
  assert.deepEqual((await check()).map(k => ({ ...k, clock: null })), open.map(k => ({ ...k, clock: null })));
});

test('KPI query parameters are validated and default to the 30 days ending today on the school\'s clock', async t => {
  const s = await dataset(t);
  for (const query of ['from=2026-02-30&to=2026-03-01', 'from=2026-10-22&to=2026-10-21', 'from=2025-01-01&to=2026-10-21',
    'from=20261020&to=2026-10-21', 'to=yesterday']) {
    const res = await s.admin('/v1/admin/kpis?' + query);
    assert.equal(res.status, 400, query);
  }
  assert.equal((await s.admin('/v1/admin/kpis?from=2025-10-21&to=2026-10-21')).status, 200, '366 days are allowed');
  const defaults = (await s.admin('/v1/admin/kpis')).json();
  assert.deepEqual(defaults.range, { from: '2026-09-22', to: '2026-10-21', days: 30, legacyUntil: '', factsSince: '2026-10-20' });
  assert.equal(defaults.daily.length, 30);
  assert.equal(defaults.totals.sessions, 4);
  // An older dashboard's band (any value) is ignored, not refused.
  for (const band of ['5-6', '', 'All', '6-7']) assert.equal((await s.admin('/v1/admin/kpis?band=' + band)).status, 200, band);
});

test('live counts sessions seen in the last five minutes, their PCs, and the games they have open', async t => {
  const s = await start(t);
  const live = async () => (await s.admin('/v1/admin/live')).json();
  const nobody = { total: { sessions: 0 }, pcs: 0, games: [] };
  const answer = fields => ({ v: 1, windowSec: 300, minSessions: 0, ...fields, clock: { tz: 'UTC', source: 'none', offsetMin: 0, today: '2026-10-20' } });
  assert.deepEqual(await live(), answer(nobody));
  const ids = ['c00000000001', 'c00000000002', 'c00000000003', 'c00000000004', 'c00000000005', 'c00000000006'];
  for (const id of ids.slice(0, 3)) await s.post(envelope(id, [['go', 1, 'road-hopper', 'featured', 0]]));
  await s.post(envelope(ids[3], [['go', 1, 'road-hopper', 'featured', 0], ['gx', 9, 'road-hopper', 8000, z6, [1, 0, 0, 0]]]));
  for (const id of ids.slice(4)) await s.post(envelope(id, [['go', 1, 'tank-splat', 'catalog', 0]]));
  assert.deepEqual(await live(), answer({ total: { sessions: 6 }, pcs: 0,
    games: [{ slug: 'road-hopper', sessions: 3 }, { slug: 'tank-splat', sessions: 2 }] }));
  // v3 sessions on two PCs, one of them from an older portal that still sends a student code: no student is counted.
  const go3 = [['go', 1, 1, 'maze-dash', 'catalog', 0, 0]];
  await s.post(envelope3('c10000000001', go3, { z: '' }));
  await s.post(envelope3('c10000000002', [['cd', 0, '1b2c3d4e5f60'], ...go3], { z: '', p: '0a0b0c0d0e0f' }));
  await s.post(envelope3('c10000000003', go3, { z: '', u: '1b2c3d4e5f60', p: '0a0b0c0d0e0f' }));
  await s.post(envelope3('c10000000004', go3, { z: '', u: '' }));
  assert.deepEqual(await live(), answer({ total: { sessions: 10 }, pcs: 2,
    games: [{ slug: 'maze-dash', sessions: 4 }, { slug: 'road-hopper', sessions: 3 }, { slug: 'tank-splat', sessions: 2 }] }));
  assert.deepEqual((await s.rows('live')).map(r => Object.keys(r).sort()), Array(10).fill(['p', 's', 'seen_minute', 'slug', 'wire']));
  // A close, a session end and a switch to another game.
  s.clock.now += 4 * 60000;
  await s.post(envelope(ids[0], [['gx', 60, 'road-hopper', 50000, z6, [1, 0, 0, 0]]]));
  await s.post(envelope(ids[4], [['gx', 60, 'tank-splat', 50000, z6, [1, 0, 0, 0]], ['go', 61, 'road-hopper', 'related', 0]]));
  await s.post(envelope(ids[5], [['se', 70, 60000]]));
  assert.deepEqual((await live()).games, [{ slug: 'maze-dash', sessions: 4 }, { slug: 'road-hopper', sessions: 3 }]);
  // Five minutes after their last batch, sessions leave the window.
  s.clock.now += 60000;
  assert.deepEqual(await live(), answer({ total: { sessions: 3 }, pcs: 0,
    games: [{ slug: 'road-hopper', sessions: 1 }] }));
  s.clock.now += 4 * 60000 - 1;
  assert.deepEqual((await live()).total, { sessions: 3 });
  s.clock.now += 1;
  assert.deepEqual((await live()).total, { sessions: 0 });
  await s.post(envelope(ids[1], [['se', 90, 3]]));
  assert.deepEqual(await live(), answer({ ...nobody, total: { sessions: 1 } }));
  s.clock.now += 5 * 60000;
  // A repeated batch is not a sign of life.
  const repeat = envelope('c00000000007', [['go', 1, 'road-hopper', 'featured', 0]]);
  await s.post(repeat);
  s.clock.now += 5 * 60000;
  await s.post(repeat);
  assert.deepEqual((await live()).total, { sessions: 0 });
  // The database keeps a session's last minute only while it is in the window.
  assert.deepEqual(await s.rows('live'), []);
});

// ---- the research endpoints and the owner's actions (§F.4) ------------------------------
// An admin request with the password, and a JSON body when one is given (with its length, as
// a browser sends it: node:http would send a DELETE's body with neither length nor chunks).
function call(s, method, pathname, body, headers = {}) {
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return s.send(method, pathname, { headers: { authorization: 'Bearer ' + TOKEN,
    ...(text === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }), ...headers }, body: text });
}
// Every admin route and the methods it takes (HEAD goes with GET).
const ROUTES = { kpis: ['GET'], live: ['GET'], settings: ['GET', 'POST'], game: ['GET'], stats: ['GET'], pcs: ['GET'], export: ['GET'], rebuild: ['POST'] };
// A request each route answers 2xx on an empty server.
const VALID = { kpis: ['GET', ''], live: ['GET', ''], settings: ['GET', ''], game: ['GET', '?slug=road-hopper'], stats: ['GET', '?metrics=hour'],
  pcs: ['GET', ''], export: ['GET', '?file=sessions'], rebuild: ['POST', '', 200, {}] };

test('the admin router: each route takes its own methods only (405 with Allow), and every one needs the dashboard password', async t => {
  const closed = await start(t, { adminToken: '' }), s = await start(t);
  for (const [name, methods] of Object.entries(ROUTES)) {
    const pathname = '/v1/admin/' + name, allow = [...methods, ...(methods.includes('GET') ? ['HEAD'] : []), 'OPTIONS'].join(', ');
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH']) {
      const takes = methods.includes(method === 'HEAD' ? 'GET' : method);
      const res = await call(s, method, pathname);
      if (!takes) {
        assert.deepEqual([res.status, res.headers.allow], [405, allow], name + ' ' + method);
        continue;
      }
      assert.equal((await s.send(method, pathname)).status, 401, name + ' ' + method + ' without the password');
      assert.equal((await s.send(method, pathname, { headers: { authorization: 'Bearer ' + TOKEN + 'x' } })).status, 401);
      assert.equal((await closed.send(method, pathname, { headers: { authorization: 'Bearer ' + TOKEN } })).status, 404, 'no password set');
    }
    const [method, query, status = 200, body] = VALID[name];
    const res = await call(s, method, pathname + query, body);
    assert.equal(res.status, status, name + ': ' + res.text);
    assert.equal(res.headers['cache-control'], 'no-store');
    if (name === 'export') assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
    else assert.equal(res.json().v ?? status, status === 200 ? 1 : status, name);
    if (method === 'GET') {
      const head = await call(s, 'HEAD', pathname + query);
      assert.deepEqual([head.status, head.text], [status, ''], name + ' HEAD');
    }
  }
  // A preflight from an allowed origin lists the methods some route takes.
  const preflight = await s.send('OPTIONS', '/v1/admin/rebuild', { headers: { origin: ORIGIN } });
  assert.equal(preflight.headers['access-control-allow-methods'], 'GET, HEAD, POST, OPTIONS');
});

test('admin requests take a JSON body of at most 4 KB with exactly their fields; bad parameters are 400', async t => {
  const s = await start(t);
  for (const [method, pathname, body, headers, status, error] of [
    ['POST', '/v1/admin/rebuild', { pad: 'x'.repeat(4096) }, {}, 413, 'too large'],
    ['POST', '/v1/admin/rebuild', '{}', { 'content-type': 'text/plain' }, 415, 'content type'],
    ['POST', '/v1/admin/rebuild', '{', {}, 400, 'json'], ['POST', '/v1/admin/rebuild', [], {}, 400, 'body'], ['POST', '/v1/admin/rebuild', null, {}, 400, 'body'],
    ['POST', '/v1/admin/rebuild', { all: true }, {}, 400, 'field'],
    ['GET', '/v1/admin/game', undefined, {}, 400, 'slug'], ['GET', '/v1/admin/game?slug=Road%20Hopper', undefined, {}, 400, 'slug'],
    ['GET', '/v1/admin/game?slug=constructor', undefined, {}, 400, 'slug'], ['GET', '/v1/admin/game?slug=road-hopper&from=2026-13-01', undefined, {}, 400, 'from'],
    ['GET', '/v1/admin/stats', undefined, {}, 400, 'metrics'], ['GET', '/v1/admin/stats?metrics=hour,minutes', undefined, {}, 400, 'metrics'],
    // The metrics schema 4 counted per student are no metrics any more.
    ['GET', '/v1/admin/stats?metrics=hour,attempt', undefined, {}, 400, 'metrics'], ['GET', '/v1/admin/stats?metrics=daymin', undefined, {}, 400, 'metrics'],
    ['GET', '/v1/admin/stats?metrics=tenure', undefined, {}, 400, 'metrics'],
    ['GET', '/v1/admin/stats?metrics=hour&slug=x_y', undefined, {}, 400, 'slug'], ['GET', '/v1/admin/pcs?from=2025-01-01&to=2026-10-20', undefined, {}, 400, 'range'],
    ['GET', '/v1/admin/export', undefined, {}, 400, 'file'], ['GET', '/v1/admin/export?file=games', undefined, {}, 400, 'file'],
    ['GET', '/v1/admin/export?file=students', undefined, {}, 400, 'file'], ['GET', '/v1/admin/export?file=student_days', undefined, {}, 400, 'file'],
    ['GET', '/v1/admin/export?file=rounds&after=1.2', undefined, {}, 400, 'after'],
    ['GET', '/v1/admin/export?file=daily_games&after=2026-10-19.school.8-9.road-hopper', undefined, {}, 400, 'after']
  ]) {
    const res = await call(s, method, pathname, body, headers);
    assert.deepEqual([res.status, res.json()], [status, { error }], method + ' ' + pathname + ' ' + JSON.stringify(body)?.slice(0, 40));
  }
  // The same metrics in any order are one question, answered in the contract's order.
  const stats = (await call(s, 'GET', '/v1/admin/stats?metrics=tier,hour,tier')).json();
  assert.deepEqual([stats.metrics, stats.rows], [['hour', 'tier'], []]);
});

test('the routes of students, profiles and age groups are gone: students, student, cohorts, forget, link and cards answer 404, with or without the password', async t => {
  const s = await start(t);
  for (const route of ['students', 'student', 'cohorts', 'forget', 'link', 'cards']) {
    for (const [method, body] of [['GET'], ['HEAD'], ['POST', { u: U }], ['DELETE'], ['POST', { u: U, to: '1b2c3d4e5f60' }]]) {
      const pathname = '/v1/admin/' + route + (method === 'GET' ? '?u=' + U : '');
      const res = await call(s, method, pathname, body);
      assert.equal(res.status, 404, method + ' ' + pathname);
      if (method !== 'HEAD') assert.deepEqual(res.json(), { error: 'not found' });
      assert.equal((await s.send(method, pathname)).status, 404, method + ' ' + pathname + ' without the password');
    }
  }
  // Nothing was written.
  assert.deepEqual(await storedFacts(s), Object.fromEntries(FACTS.map(table => [table, []])));
});

// The hand-built school of STUDENT_DAYS (zone UTC), as the research endpoints see it.
async function studentDays(t) {
  const s = await start(t, { at: START - DAY_MS });
  for (const [at, body] of STUDENT_DAYS) {
    s.clock.now = at;
    assert.equal((await s.post({ ...body, z: '' })).status, 204);
  }
  s.clock.now = START + 3600000;
  return s;
}
const RANGE = { from: '2026-10-19', to: '2026-10-20', days: 2 };
const GAME = {
  v: 1, slug: 'road-hopper', range: RANGE,
  daily: [{ day: '2026-10-19', minutes: 3, opens: 1 }, { day: '2026-10-20', minutes: 6.8, opens: 4 }]
};
const STAT_COLUMNS = ['n', 'w', 'l', 'q', 'ms', 'win_ms', 'hits', 'misses', 'rt_sum', 'rt_n', 'inputs', 'gap_sum', 'gap_n'];
const pcRow = (p, fields) => ({ p, label: p.slice(0, 4).toUpperCase(), firstDay: '2026-10-19', lastDay: '2026-10-20', days: 2, smoothShare: 1, stallShare: 0,
  avgLoadMs: null, slowInputShare: 0, errors: 0, z: '', build: 'src', flags: [], ...fields });
const PCS_ANSWER = { v: 1, range: RANGE, pcs: [pcRow(P2, { sessions: 3, minutes: 7.5 }), pcRow(P, { sessions: 4, minutes: 6.5 })] };

test('a game, the r_stat metrics and the PCs are exact for a hand-built school, from the facts and from the rollups alike', async t => {
  const s = await studentDays(t);
  const get = async pathname => { const res = await s.admin(pathname); assert.equal(res.status, 200, pathname + ': ' + res.text); return res.json(); };
  const q = 'from=2026-10-19&to=2026-10-20';
  const check = async rolled => {
    const clock = UTC_CLOCK(rolled ? '2026-10-21' : '2026-10-20');
    const game = await get('/v1/admin/game?slug=road-hopper&' + q);
    // Game-to-game flows and r_stat rows are the rolled days' (up to last night).
    const flows = rolled ? { flowsIn: [{ from: '', n: 5 }], flowsOut: [{ to: '', n: 4 }, { to: 'maze-dash', n: 1 }] } : { flowsIn: [], flowsOut: [] };
    assert.deepEqual({ ...game, stats: undefined }, { ...GAME, ...flows, stats: undefined, clock });
    assert.deepEqual(game.stats.columns, ['metric', 'k1', 'k2', ...STAT_COLUMNS]);
    const rows = game.stats.rows.map(row => Object.fromEntries(game.stats.columns.map((c, i) => [c, row[i]])));
    assert.equal(rows.length > 0, rolled);
    if (rolled) {
      assert.deepEqual(rows.filter(r => r.metric === 'tier').map(r => [r.k1, r.n, r.w, r.l, r.ms, r.win_ms]), [['2', 2, 1, 1, 60000, 30000]]);
      assert.ok(rows.every(r => !['hour', 'rhour', 'sesslen', 'games'].includes(r.metric)), 'the metrics of all games are not the game\'s');
    }
    // An older dashboard's band is ignored.
    assert.deepEqual(await get('/v1/admin/game?slug=road-hopper&' + q + '&band=10-11'), game);
    assert.deepEqual(await get('/v1/admin/pcs?' + q), { ...PCS_ANSWER, clock });
    // The columns are the sums the metrics have.
    const stats = await get('/v1/admin/stats?' + q + '&metrics=tier,persist&slug=road-hopper');
    assert.deepEqual({ ...stats, rows: undefined }, { v: 1, range: { ...RANGE, rolledThrough: rolled ? '2026-10-20' : '' }, metrics: ['persist', 'tier'],
      slug: 'road-hopper', columns: ['metric', 'slug', 'k1', 'k2', 'n', 'w', 'l', 'q', 'ms', 'win_ms', 'gap_sum', 'gap_n'], rows: undefined, clock });
    assert.deepEqual(stats.rows, rolled ? [['persist', 'road-hopper', 'l', 'stop', 1, 0, 0, 0, 0, 0, 0, 0],
      ['persist', 'road-hopper', 'w', 'level', 1, 0, 0, 0, 0, 0, 3, 1], ['tier', 'road-hopper', '2', '', 2, 1, 1, 0, 60000, 30000, 0, 0]] : []);
    assert.deepEqual((await get('/v1/admin/stats?' + q + '&metrics=hour')).columns, ['metric', 'slug', 'k1', 'k2', 'n', 'ms']);
    // Session lengths by the wire version of the PC's portal (all v3 here).
    const lengths = await get('/v1/admin/stats?' + q + '&metrics=sesslen');
    assert.deepEqual(lengths.rows, rolled ? [['sesslen', '', '0', '3', 1, 30000], ['sesslen', '', '1', '3', 3, 210000], ['sesslen', '', '2', '3', 2, 300000],
      ['sesslen', '', '5', '3', 1, 300000]] : []);
  };
  await check(false);
  // Rolled up (the cron, after 01:00 the next day), the answers are the same.
  s.clock.now = Date.parse('2026-10-21T02:00:00Z');
  assert.equal((await s.app.roll()).rolled, '2026-10-19');
  assert.equal((await s.app.roll()).rolled, '2026-10-20');
  await check(true);
});

test('the guards: above 90,000 writes today the recount answers 429; above 4.2 million reads every admin read but live and settings; export pages above 3.5 million', async t => {
  const s = await start(t);
  const usage = (field, n) => s.app.store.db.prepare(`INSERT INTO usage (day, ${field}) VALUES ('2026-10-20', ?1) ON CONFLICT (day) DO UPDATE SET ${field} = ?1`).bind(n).run();
  const until = { until: '00:00' };
  await usage('writes', 90001);
  s.clock.now += 5 * 60000;
  const res = await call(s, 'POST', '/v1/admin/rebuild', {});
  assert.deepEqual([res.status, res.json()], [429, { error: 'writes', ...until }]);
  assert.equal((await call(s, 'POST', '/v1/admin/settings', { weekStart: 'sun' })).status, 200, 'settings are not an action that writes much');
  assert.equal((await s.admin('/v1/admin/pcs')).status, 200);
  assert.equal((await s.post(envelope('cb0000000002', [['se', 1, 2]]))).status, 204, 'batches are never refused');
  await usage('writes', 0);
  await usage('reads', 3500001);
  s.clock.now += 5 * 60000;
  const page = await s.admin('/v1/admin/export?file=rounds');
  assert.deepEqual([page.status, page.json()], [429, { error: 'reads', ...until }]);
  assert.equal((await s.admin('/v1/admin/pcs')).status, 200, 'other reads go on until 4.2 million');
  await usage('reads', 4200001);
  s.clock.now += 5 * 60000;
  for (const pathname of ['/v1/admin/kpis', '/v1/admin/game?slug=road-hopper', '/v1/admin/stats?metrics=hour', '/v1/admin/pcs', '/v1/admin/export?file=pcs']) {
    const res = await s.admin(pathname);
    assert.deepEqual([res.status, res.json()], [429, { error: 'reads', ...until }], pathname);
  }
  for (const pathname of ['/v1/admin/live', '/v1/admin/settings']) assert.equal((await s.admin(pathname)).status, 200, pathname);
  assert.equal((await call(s, 'POST', '/v1/admin/rebuild', {})).status, 200, 'the recount is guarded by writes');
});

// A simulated school (simulate.mjs) stored through `store`, with the cron's rolls after each day.
async function simulatedSchool(store, options) {
  const { schoolDays } = await import('../simulate.mjs');
  for (const day of schoolDays(options)) {
    for (const { batch, now } of day.batches) await store.ingest(validateBatch(batch), now);
    const night = Date.parse(day.day + 'T00:00:00Z') - 3 * 3600000 + DAY_MS + 65 * 60000;
    if (night < options.now) for (let i = 0; i < 40 && (await store.rollupStep(night + i * 300000)).rolled; i++);
  }
}

test('export: every file\'s pages hold each row once, with exactly its COLUMNS and no value that needs quoting; X-Rows, X-Next and cursors', async t => {
  const { COLUMNS, FILES } = await import('../export.mjs');
  const now = Date.parse('2026-10-22T08:00:00Z'), db = openDatabase(':memory:');
  // Small pages (13 sessions or 97 lines), so that every file has several.
  const store = openStore(db, { exportLimits: { lines: 97, sessions: 13 } });
  await simulatedSchool(store, { days: 9, sessions: 40, seed: 9, now });
  const clock = { now }, app = createApp({ store, adminToken: TOKEN, now: () => clock.now, dashboardDir: null });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const get = pathname => request(`http://127.0.0.1:${port}`, 'GET', pathname, { headers: { authorization: 'Bearer ' + TOKEN } });
  // The same database with pages of the real size: each file is one page here.
  // One page that holds a whole file, to compare the pages with.
  const whole = openStore(db, { exportLimits: { lines: 100000, sessions: 100000 } });
  const range = { from: '2026-10-13', to: '2026-10-22' };
  const lo = Date.parse('2026-10-13T00:00:00+03:00') / 1000, hi = Date.parse('2026-10-23T00:00:00+03:00') / 1000;
  const counted = async from => (await db.prepare(`SELECT COUNT(*) AS n FROM st_sessions s ${from} WHERE s.start_s >= ?1 AND s.start_s < ?2`).bind(lo, hi).first()).n;
  const expected = { sessions: await counted(''), visits: await counted('JOIN st_visits v ON v.sid = s.id'), rounds: await counted('JOIN st_rounds r ON r.sid = s.id'),
    events: await counted('JOIN st_marks m ON m.sid = s.id') };
  assert.ok(expected.rounds > 1000 && expected.events > 100, JSON.stringify(expected));
  for (const file of FILES) {
    const lines = [];
    let after = null, pages = 0;
    do {
      const res = await get(`/v1/admin/export?file=${file}&from=${range.from}&to=${range.to}` + (after ? '&after=' + encodeURIComponent(after) : ''));
      assert.equal(res.status, 200, file + ' ' + after + ': ' + res.text);
      assert.equal(res.headers['content-type'], 'text/csv; charset=utf-8');
      const page = res.text ? res.text.replace(/\n$/, '').split('\n') : [];
      assert.equal(Number(res.headers['x-rows']), page.length);
      assert.ok(page.length <= (file === 'sessions' ? 13 : 97), file + ' page ' + pages);
      lines.push(...page);
      after = res.headers['x-next'] ?? null;
      pages++;
    } while (after && pages < 1000);
    assert.equal(after, null, file + ' ends');
    for (const line of lines) {
      assert.doesNotMatch(line, /["\r]/, file);
      assert.equal(line.split(',').length, COLUMNS[file].length, file + ': ' + line);
    }
    const one = await whole.exportPage({ file, ...range }, now);
    assert.equal(one.next, null, file + ' is one page');
    assert.deepEqual(lines, one.text.replace(/\n$/, '').split('\n'), file + ': the pages hold every row once, in order');
    if (expected[file] !== undefined) assert.equal(lines.length, expected[file], file);
    assert.ok(lines.length > 0 && (file === 'pcs' || pages > 1), `${file}: ${lines.length} lines in ${pages} pages`);
  }
  // A cursor of another file, or a forged one, is refused; a cursor past the end gives an empty last page.
  assert.equal((await get('/v1/admin/export?file=visits&after=1760000000.1')).status, 400);
  const end = await get('/v1/admin/export?file=sessions&after=99999999999.999');
  assert.deepEqual([end.status, end.text, end.headers['x-rows'], end.headers['x-next']], [200, '', '0', undefined]);
});

test('export lines are exact for a hand-built school: dates and times on the school\'s clock, words for codes, empty for unknown', async t => {
  const s = await studentDays(t);
  const lines = async (file, q = 'from=2026-10-19&to=2026-10-20') => {
    const res = await s.admin(`/v1/admin/export?file=${file}&${q}`);
    assert.equal(res.status, 200);
    return res.text.replace(/\n$/, '').split('\n');
  };
  // U1's session: it started 95 s before its batch arrived (09:15:00 UTC).
  const sessions = await lines('sessions');
  assert.equal(sessions.length, 7);
  // A Tuesday (weekday 3, Sunday being 1); an older portal's student code, band and profile fields are nowhere.
  assert.equal(sessions.find(line => line.startsWith('b20000000001')), ['b20000000001', P, 3, '2026-10-20', 3, '09:13:25', 553,
    '2026-10-20T09:13:25Z', 'w', 'web', 'src', 4, 4, 1920, 1, 2, '120.0', '', '', '', ''].join(','));
  assert.equal(sessions.find(line => line.startsWith('b20000000004')), ['b20000000004', P, 3, '2026-10-20', 3, '09:14:23', 554,
    '2026-10-20T09:14:23Z', 'w', 'web', 'src', 4, 4, 1920, 1, 0, '30.0', '', '', '', ''].join(','));
  // One ended by the idle hand-over.
  assert.match(sessions.find(line => line.startsWith('b20000000003')), /,50,idle,,$/);
  const rounds = await lines('rounds');
  assert.deepEqual(rounds, [
    ['b20000000001', 1, 1, P, '2026-10-20', 3, '09:13:29', 4, 0.1, 'road-hopper', 'L1', 'win', '', 0, 0, 30000, 30000, 50, 2, 2, 500,
      10, 2, 0.8333, 0, 0, 0, 0, 0, 0, 600, 10, 40, '80.0', 0, 0].join(','),
    ['b20000000001', 1, 2, P, '2026-10-20', 3, '09:14:08', 43, 0.7, 'road-hopper', 'L2', 'loss', 'win', 0, 0, 30000, '', 20, 2, 2, '',
      5, 5, 0.5, 0, 0, 0, 0, 0, 0, '', '', '', '', '', ''].join(',')]);
  const events = await lines('events');
  // A session's marks in key order: kind, then time. No level-up, no older code and no removed profile is a mark.
  assert.deepEqual(events.filter(line => line.startsWith('b20000000001')), [
    'b20000000001,2026-10-20,09:14:07,42,heart_on,road-hopper,',
    'b20000000001,2026-10-20,09:13:28,3,tutorial_start,road-hopper,',
    'b20000000001,2026-10-20,09:14:06,41,tutorial_done,road-hopper,']);
  assert.equal(events.length, 3);
  const games = await lines('daily_games');
  // A game's day is one line, whatever ages played it.
  assert.deepEqual(games.map(line => line.split(',').slice(0, 5)), [['2026-10-19', 'school', 'maze-dash', '1', '1'],
    ['2026-10-19', 'school', 'road-hopper', '1', '1'], ['2026-10-20', 'school', 'maze-dash', '1', '1'],
    ['2026-10-20', 'school', 'road-hopper', '4', '4'], ['2026-10-20', 'school', 'tank-splat', '1', '1']]);
  assert.equal(games[3], '2026-10-20,school,road-hopper,4,4,6.8,2,2,1,1,0,0,0,1,0,2.0,0.6818');
  assert.deepEqual(await lines('pcs'), [`${P2},0A0B,2026-10-19,2026-10-20,2,,src,4,4,1920,3,7.5,1.0,0.0,,0.0,0`,
    `${P},8C21,2026-10-19,2026-10-20,2,,src,4,4,1920,4,6.5,1.0,0.0,,0.0,0`]);
  // Every file, rolled up or not, holds no student code, age band or profile.
  s.clock.now = Date.parse('2026-10-21T02:00:00Z');
  await s.app.roll();
  await s.app.roll();
  for (const file of ['sessions', 'visits', 'rounds', 'events', 'daily_games', 'pcs']) {
    const text = (await lines(file)).join('\n');
    assert.doesNotMatch(text, /1a1a|2b2b|3c3c|4d4d|5e5e|6-7|8-9|10-11|student|guest|profile|linked|level_up/, file);
  }
  assert.deepEqual(await lines('daily_games'), games, 'the same lines from the rollups');
});

test('daily_games holds milestone 2\'s frozen days too, on UTC receipt days, next to the school\'s days', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-games-telemetry-export-m2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.db');
  await milestone2(file, [['agg_games', { day: '2026-10-20', a: '6-7', slug: 'road-hopper', sessions: 3, opens: 5, engaged_ms: 120000, starts: 4, ends: 4,
    w: 2, l: 2, tier_sum: 6, tier_n: 3, hits: 3, misses: 1 }], ['agg_games', { day: '2026-10-20', a: '8-9', slug: 'road-hopper', sessions: 1, opens: 2,
    engaged_ms: 60000, starts: 1, ends: 1, w: 1 }], ['agg_games', { day: '2026-10-19', a: '', slug: 'maze-dash', sessions: 1, opens: 1 }]]);
  const clock = { now: START };
  const app = createApp({ dbPath: file, now: () => clock.now, adminToken: TOKEN, dashboardDir: null });
  t.after(() => app.close());
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await request(base, 'POST', '/v1/batch', { headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(envelope('a00000000001', [['go', 1, 'road-hopper', 'featured', 0], ['gx', 20, 'road-hopper', 15000, z6, z4]])) })).status, 204);
  const res = await request(base, 'GET', '/v1/admin/export?file=daily_games&from=2026-10-19&to=2026-10-20', { headers: { authorization: 'Bearer ' + TOKEN } });
  // The overlap day has both: the frozen totals (no heart counts then; the age bands milestone 2 kept added up) and the
  // school's day from the facts.
  assert.deepEqual(res.text.trim().split('\n'), ['2026-10-19,utc,maze-dash,1,1,0.0,0,0,0,0,0,0,0,,,,',
    '2026-10-20,school,road-hopper,1,1,0.3,0,0,0,0,0,0,0,0,0,,', '2026-10-20,utc,road-hopper,4,7,3.0,5,5,3,2,0,0,0,,,2.0,0.75']);
});

test('simulate.mjs --db writes a school\'s days of v3 batches and rolls them up with the store\'s own cron', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-games-telemetry-simulate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'school.db');
  const run = spawnSync(process.execPath, [path.join(repo, 'simulate.mjs'), '--db', file, '--days', '8', '--sessions', '30', '--seed', '4'],
    { encoding: 'utf8', timeout: 120000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^simulate: (\d+) of \1 batches stored in .* \(8 days, seed 4, \d+ days rolled up\)/);
  const db = openDatabase(file);
  t.after(() => db.close());
  const one = async text => (await db.prepare(text).first());
  const settings = Object.fromEntries((await db.prepare('SELECT key, value FROM settings').all()).results.map(r => [r.key, r.value]));
  assert.deepEqual([settings.tz, settings.tz_source], ['Asia/Riyadh', 'pcs']);
  // Batches an offline PC delivers today, of a day rolled already, wait for the next re-roll: the cron of the coming hours.
  const store = openStore(db);
  for (let i = 0, at = Date.now() + 2 * 3600000; i < 20 && (await store.rollupStep(at)).rolled; i++, at += 300000);
  // Every past school day is rolled, and its rollups equal the facts' own numbers.
  const rolled = (await db.prepare('SELECT day FROM roll_days ORDER BY day').all()).results.map(r => r.day);
  assert.ok(rolled.length >= 4, rolled.join());
  assert.equal((await one('SELECT COUNT(*) AS n FROM roll_days WHERE dirty > 0')).n, 0);
  assert.equal((await one('SELECT TOTAL(sessions) AS n FROM r_day')).n, (await one(`SELECT COUNT(*) AS n FROM st_sessions WHERE start_s < ${Date.parse(rolled.at(-1) + 'T21:00:00Z') / 1000}`)).n);
  assert.ok((await one("SELECT COUNT(*) AS n FROM st_sessions WHERE wire = 2")).n > 0, 'some PCs still run the old portal');
  assert.ok((await one("SELECT COUNT(*) AS n FROM st_rounds WHERE duo = 1")).n > 0, 'local two-player rounds');
  assert.ok((await one("SELECT COUNT(*) AS n FROM st_rounds WHERE dda >= 0")).n > 0, 'DDA levels');
});

test('the Node host sweeps live rows every minute, so none outlives 10 minutes without requests', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const s = await start(t);
  assert.equal((await s.post(fixture)).status, 204);
  s.clock.now += 4 * 60000;
  t.mock.timers.tick(60000);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await s.count('live'), 1, 'still in the window');
  s.clock.now += 60000;
  t.mock.timers.tick(60000);
  for (let i = 0; i < 100 && await s.count('live'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await s.count('live'), 0);
});

test('retention: facts after 400 days (or the owner\'s choice), rollups after 800, batch ids after 30, usage after 60, the frozen daily totals by RETENTION_DAYS', async t => {
  const day0 = Date.parse('2026-01-01T09:00:00Z');
  const s = await start(t, { at: day0 });
  const counts = async () => Object.fromEntries(await Promise.all(['st_sessions', 'st_visits', 'st_rounds', 'st_marks', 'st_pcs',
    'batches', 'r_day', 'r_stat', 'roll_days'].map(async table => [table, await s.count(table)])));
  // A v3 session (with marks), then a v2 session the next day.
  assert.equal((await s.post(envelope3('d10000000001', [['ss', 0], ['ct', 0, 's', 10], ['go', 1, 1, 'road-hopper', 'catalog', 0, 0],
    ['rs', 2, 1, 1, 'road-hopper', 'L1', 1, 0], ['re', 30, 1, 1, 'road-hopper', 'w', 'L1', 20000, 10, 1, 3, 1, z6, null], ['fv', 31, 1, 'road-hopper', 1],
    ['tu', 31, 1, 'road-hopper', 's']], { z: '' }))).status, 204);
  s.clock.now = day0 + DAY_MS;
  assert.equal((await s.post(envelope('d00000000002', [['go', 1, 'road-hopper', 'featured', 0], ['lv', 2, 3]]))).status, 204);
  // The cron rolls both days.
  s.clock.now = day0 + 2 * DAY_MS;
  assert.deepEqual([(await s.app.roll()).rolled, (await s.app.roll()).rolled], ['2026-01-01', '2026-01-02']);
  const all = await counts();
  assert.deepEqual(all, { st_sessions: 2, st_visits: 2, st_rounds: 1, st_marks: 3, st_pcs: 1, batches: 1, r_day: 2, r_stat: all.r_stat, roll_days: 2 });
  assert.ok(all.r_stat > 10);

  s.clock.now = day0 + 31 * DAY_MS;
  let result = await s.app.purge();
  assert.deepEqual(pick(result, ['cutoff', 'sessions', 'batches']), { cutoff: '2024-12-28', sessions: 0, batches: 0 });
  s.clock.now = day0 + 32 * DAY_MS;
  assert.equal((await s.app.purge()).batches, 1, 'the batch id is forgotten after 30 days');
  assert.deepEqual((await s.rows('usage', 'day')).map(r => r.day).slice(0, 2), ['2026-01-01', '2026-01-02']);
  s.clock.now = day0 + 62 * DAY_MS;
  await s.app.purge();
  assert.ok((await s.rows('usage')).every(r => r.day >= '2026-01-03'), 'usage rows are kept 60 days');

  // Exactly 400 days old is kept; a day later the session goes with its visits, rounds and
  // marks. Its PC stays as long as the rollups that name it.
  const oldPeriod = async () => {
    const pcs = (await s.admin('/v1/admin/pcs?from=2026-01-01&to=2026-01-02')).json().pcs;
    const kpis = (await s.admin('/v1/admin/kpis?from=2026-01-01&to=2026-01-02')).json();
    return [pcs.map(x => pick(x, ['p', 'firstDay', 'lastDay', 'sessions'])), kpis.totals.sessions];
  };
  const answers = await oldPeriod();
  assert.deepEqual(answers, [[{ p: P, firstDay: '2026-01-01', lastDay: '2026-01-01', sessions: 1 }], 2]);
  s.clock.now = day0 + 400 * DAY_MS;
  assert.deepEqual(pick(await s.app.purge(), ['cutoff', 'sessions']), { cutoff: '2026-01-01', sessions: 0 });
  s.clock.now = day0 + 401 * DAY_MS;
  result = await s.app.purge();
  assert.deepEqual(pick(result, ['cutoff', 'sessions', 'rounds', 'pcs']), { cutoff: '2026-01-02', sessions: 1, rounds: 1, pcs: 0 });
  assert.deepEqual(await counts(), { ...all, st_sessions: 1, st_visits: 1, st_rounds: 0, st_marks: 0, batches: 0 }, 'the rollups and the PC stay');
  assert.deepEqual(await oldPeriod(), answers, 'the period the rollups hold answers as before');
  const settings = async () => Object.fromEntries((await s.rows('settings')).map(r => [r.key, r.value]));
  assert.equal((await settings()).facts_since, '2026-01-02', 'the facts start at the cutoff');
  // The rollups go after 800 days, when the 5-minute cron has nothing to roll.
  // The cron's runs until one has no day to roll: what that one did.
  const idle = async () => {
    for (let i = 0; i < 1000; i++) { const done = await s.app.roll(); if (!done.rolled) return done; }
    throw new Error('the cron never ran out of days');
  };
  s.clock.now = day0 + 800 * DAY_MS + 3600000;
  await s.app.purge();
  assert.equal((await idle()).purged, null, 'exactly 800 days old is kept');
  assert.equal((await s.rows('r_day')).length, 2);
  s.clock.now += DAY_MS;
  assert.equal((await idle()).purged, '2026-01-01', 'the rollups of the oldest day go');
  assert.deepEqual((await s.rows('r_day')).map(r => r.day), ['2026-01-02']);
  assert.equal((await s.rows('roll_days', 'day'))[0].day, '2026-01-02');
  // With them, the PC.
  assert.deepEqual(pick(await s.app.purge(), ['pcs']), { pcs: 1 });
  assert.equal((await counts()).st_pcs, 0);

  // The owner keeps two school years: facts stay 760 days, rollups still 800.
  const owner = await start(t, { at: day0 });
  await owner.post(envelope3('d20000000001', [['ss', 0, 0, 3, 1, 2, 4, 0], ['ct', 1, 'c', 0]], { z: '' }));
  const set = await owner.send('POST', '/v1/admin/settings', { headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ keepDays: 760 }) });
  assert.equal(set.status, 200);
  assert.deepEqual(set.json().keep, { days: 760, source: 'owner', rollupDays: 800 });
  owner.clock.now = day0 + 760 * DAY_MS;
  assert.equal((await owner.app.purge()).sessions, 0);
  owner.clock.now += DAY_MS;
  assert.deepEqual(pick(await owner.app.purge(), ['cutoff', 'sessions']), { cutoff: '2026-01-02', sessions: 1 });

  // A database the milestone-2 server filled: its daily totals stay, read only, until RETENTION_DAYS.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-games-telemetry-m2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.db');
  await milestone2(file, [['agg_days', { day: '2026-01-01', a: '6-7', sessions: 4, level_ups: 2 }], ['agg_days', { day: '2026-01-02', a: '6-7', sessions: 3 }],
    ['agg_devices', { day: '2026-01-01', a: '6-7', cores: 4, mem: 4, screen: 1920, sessions: 4 }]]);
  const clock = { now: day0 + 180 * DAY_MS };
  const old = createApp({ dbPath: file, now: () => clock.now, retentionDays: 180 });
  t.after(() => old.close());
  await old.listen(0, '127.0.0.1');
  assert.deepEqual((await old.store.db.prepare('SELECT day FROM agg_days ORDER BY day').all()).results.map(r => r.day), ['2026-01-01', '2026-01-02'],
    'exactly 180 days old is kept');
  clock.now = day0 + 181 * DAY_MS;
  assert.deepEqual(pick(await old.purge(), ['legacyCutoff', 'rows', 'batches']), { legacyCutoff: '2026-01-02', rows: 2, batches: 0 },
    'one daily-totals row and one device row');
  assert.deepEqual((await old.store.db.prepare('SELECT day, sessions FROM agg_days').all()).results, [{ day: '2026-01-02', sessions: 3 }]);
  await old.close();
  // A restart purges at once. legacy_until (the day of the update) goes once it is past retention too.
  const later = createApp({ dbPath: file, now: () => clock.now, retentionDays: 180 });
  t.after(() => later.close());
  clock.now = day0 + 182 * DAY_MS;
  await later.listen(0, '127.0.0.1');
  for (const table of Object.keys(TABLES)) assert.equal((await later.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0, table);
  const legacyUntil = async () => (await later.store.db.prepare("SELECT value FROM settings WHERE key = 'legacy_until'").first()).value;
  assert.equal(await legacyUntil(), '2026-06-30');
  clock.now = Date.parse('2026-06-30T12:00:00Z') + 181 * DAY_MS;
  await later.purge();
  assert.equal(await legacyUntil(), '');
});

test('a shorter retention deletes the old facts a few hundred sessions a run, the 5-minute cron catching up, never a year at once', async () => {
  const db = openDatabase(':memory:'), day0 = Date.parse('2026-01-05T09:00:00Z'), store = openStore(db);
  // 500 sessions on each of three days.
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 500; i++) {
      await store.ingest(validateBatch(envelope3('e3' + String(d * 1000 + i).padStart(10, '0'), [['ss', 0, 0, 3, 1, 2, 4, 0],
        ['go', 1, 1, 'road-hopper', 'catalog', 0, 0], ['rs', 2, 1, 1, 'road-hopper', 'L1', 1, 0],
        ['re', 30, 1, 1, 'road-hopper', 'w', 'L1', 20000, 10, 1, 3, 1, z6, null], ['gx', 31, 1, 'road-hopper', 29000, z6, z4]], { z: '' })), day0 + d * DAY_MS + i * 1000);
    }
  }
  // 500 days later, with the default 400 days, all of it is past retention; every day is rolled.
  let at = day0 + 500 * DAY_MS;
  await db.prepare("UPDATE settings SET value = ?1 WHERE key = 'rolled_through'").bind(new Date(at - DAY_MS).toISOString().slice(0, 10)).run();
  const batch = db.batch.bind(db);
  let most = 0, total = 0;
  db.batch = async list => {
    const results = await batch(list), n = results.reduce((x, r) => x + r.meta.rows_written, 0);
    most = Math.max(most, n);
    total += n;
    return results;
  };
  const sessions = async () => (await db.prepare('SELECT COUNT(*) AS n FROM st_sessions').first()).n;
  const since = async () => (await db.prepare("SELECT value FROM settings WHERE key = 'facts_since'").first()).value;
  assert.equal((await store.purge(at)).sessions, 600, 'the purge deletes 600 sessions');
  const steps = [[await sessions(), await since()]];
  for (let i = 0; i < 3; i++) {
    const done = await store.rollupStep(at += 300000);
    steps.push([await sessions(), await since(), done.deleted]);
  }
  // facts_since follows: a day whose facts are partly gone is before it.
  assert.deepEqual(steps, [[900, '2026-01-07'], [300, '2026-01-08', 'facts'], [0, '2026-04-15', 'facts'], [0, '2026-04-15', null]]);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM st_rounds').first('n'), 0);
  assert.ok(most <= 600 * 25 && total > 2 * most, `at most ${most} of ${total} rows written in one batch`);
});

test('the storage guard removes the round details of the oldest 30 days of facts, a few hundred sessions a run, and again only once the database grows', async () => {
  const db = openDatabase(':memory:'), day0 = Date.parse('2026-01-05T09:00:00Z');
  const store = openStore(db, { guards: { bytes: 1 } });
  const round = (s, at) => store.ingest(validateBatch(envelope3(s, [['ss', 0, 0, 3, 1, 2, 4, 0], ['go', 1, 1, 'road-hopper', 'catalog', 0, 0],
    ['rs', 2, 1, 1, 'road-hopper', 'L1', 1, 0], ['re', 30, 1, 1, 'road-hopper', 'w', 'L1', 20000, 10, 1, 3, 1, z6, null]], { z: '' })), at);
  // A session every 10 days for 100 days, and 900 sessions on day 20.
  for (let i = 0; i < 10; i++) await round('e0000000000' + i, day0 + i * 10 * DAY_MS);
  for (let i = 0; i < 900; i++) await round('e2' + String(i).padStart(10, '0'), day0 + 20 * DAY_MS + 3600000 + i * 1000);
  const settings = async () => Object.fromEntries((await db.prepare('SELECT key, value FROM settings').all()).results.map(r => [r.key, r.value]));
  const left = async () => (await db.prepare('SELECT s.s FROM st_rounds r JOIN st_sessions s ON s.id = r.sid WHERE s.s LIKE ? ORDER BY s.start_s').bind('e0%').all()).results.map(r => r.s);
  const rounds = async () => (await db.prepare('SELECT COUNT(*) AS n FROM st_rounds').first()).n;
  // The purge marks the 30 days to trim; the 5-minute cron trims them once it has nothing to roll, at most 800 sessions a run.
  let at = day0 + 100 * DAY_MS;
  while ((await store.rollupStep(at)).rolled) at += 1000;
  const result = await store.purge(at);
  assert.deepEqual(result.trimmed, { to: '2026-02-04' });
  assert.equal(await rounds(), 910, 'nothing is deleted at once');
  const steps = [];
  for (let i = 0; i < 5; i++) {
    const before = await rounds(), done = await store.rollupStep(at += 300000);
    steps.push([done.deleted, before - await rounds(), (await settings()).trimmed_before]);
  }
  assert.deepEqual(steps, [['rounds', 800, '2026-01-26'], ['rounds', 103, '2026-02-04'], [null, 0, '2026-02-04'], [null, 0, '2026-02-04'], [null, 0, '2026-02-04']]);
  assert.deepEqual(await left(), ['e00000000003', 'e00000000004', 'e00000000005', 'e00000000006', 'e00000000007', 'e00000000008', 'e00000000009']);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM st_sessions').first()).n, 910, 'sessions and visits stay');
  // SQLite reuses the freed pages: the next purge waits until the file has grown.
  assert.equal((await store.purge(day0 + 101 * DAY_MS)).trimmed, null);
  for (let i = 0; i < 300; i++) await round('e1' + String(i).padStart(10, '0'), day0 + 100 * DAY_MS + i * 1000);
  assert.deepEqual((await store.purge(day0 + 102 * DAY_MS)).trimmed, { to: '2026-03-06' });
  // The days since the last purge are rolled first; the first run with nothing to roll trims.
  at = day0 + 102 * DAY_MS;
  let done;
  do done = await store.rollupStep(at += 1000); while (done.rolled);
  assert.equal(done.deleted, 'rounds');
  assert.equal((await settings()).trimmed_before, '2026-03-06');
  assert.deepEqual(await left(), ['e00000000006', 'e00000000007', 'e00000000008', 'e00000000009']);
  // A change of zone does not re-roll the days without round details.
  await store.updateSettings({ tz: 'Asia/Riyadh' }, at);
  const days = (await db.prepare('SELECT day, dirty FROM roll_days ORDER BY day').all()).results;
  assert.ok(days.length > 90 && days.some(r => r.day < '2026-03-06'));
  assert.deepEqual(days.filter(r => r.dirty !== (r.day >= '2026-03-06' ? 2 : 0)), []);
});

test('the store creates schema 5, upgrades schema 2 and 3 one step at a time keeping the frozen totals (their age bands cleared), and refuses a newer one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-games-telemetry-schema-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = async db => (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).results.map(r => r.name);
  const settings = async db => Object.fromEntries((await db.prepare('SELECT key, value FROM settings').all()).results.map(r => [r.key, r.value]));
  const v5 = ['batches', 'kpi_cache', 'live', 'meta', 'r_day', 'r_device_day', 'r_game_day', 'r_level_day', 'r_pc_day', 'r_source_day',
    'r_stat', 'roll_days', 'settings', 'st_marks', 'st_pcs', 'st_rounds', 'st_sessions', 'st_visits', 'usage'];
  // A new database: schema 5 at once, without the aggregates, with nothing to clear.
  const fresh = path.join(dir, 'fresh.db');
  const first = createApp({ dbPath: fresh, now: () => START });
  t.after(() => first.close());
  await first.listen(0, '127.0.0.1');
  assert.deepEqual(await names(first.store.db), v5);
  assert.deepEqual((await first.store.db.prepare('SELECT * FROM meta').all()).results, [{ key: 'schema', value: 5 }]);
  assert.deepEqual(await settings(first.store.db), { tz: 'UTC', tz_source: 'none', tz_epoch: '0', week_start: 'mon', week_source: 'auto', keep_days: '',
    facts_since: '2026-10-20', legacy_until: '', v3_since: '', rv: '2', rolled_through: '', trimmed_before: '', rebuild: '', trimmed_size: '', trim_to: '',
    scrub: '', scrub_id: '0', scrub_end: '0', scrub_day: '' }, 'rv went up with the purge at start');
  await first.close();

  // Milestone 2's schema 3 with a day of totals in two age bands: one step to 5; the totals stay, the bands added up.
  const m2 = path.join(dir, 'm2.db');
  await milestone2(m2, [['agg_days', { day: '2026-10-20', a: '6-7', sessions: 3, web: 3, opens: 5, engaged_ms: 120000, new_profiles: 1, level_ups: 2 }],
    ['agg_days', { day: '2026-10-20', a: '8-9', sessions: 1, web: 1, opens: 2, engaged_ms: 60000, guests: 1 }],
    ['agg_games', { day: '2026-10-20', a: '6-7', slug: 'road-hopper', sessions: 3, opens: 5 }]]);
  const upgraded = createApp({ dbPath: m2, now: () => START, adminToken: TOKEN, allowedOrigins: [ORIGIN] });
  t.after(() => upgraded.close());
  const { port } = await upgraded.listen(0, '127.0.0.1');
  assert.deepEqual(await names(upgraded.store.db), [...v5, ...Object.keys(TABLES)].sort());
  // The cron at start cleared the frozen days; its next run finds nothing left to clear.
  assert.deepEqual(pick(await settings(upgraded.store.db), ['facts_since', 'legacy_until', 'tz', 'scrub', 'scrub_day']),
    { facts_since: '2026-10-20', legacy_until: '2026-10-20', tz: 'UTC', scrub: '1', scrub_day: '2026-10-20' });
  assert.equal((await upgraded.roll()).cleared, 'done');
  assert.equal((await settings(upgraded.store.db)).scrub, '');
  assert.deepEqual((await upgraded.store.db.prepare('SELECT day, a, sessions, opens, engaged_ms, new_profiles, level_ups, guests FROM agg_days').all()).results,
    [{ day: '2026-10-20', a: '', sessions: 4, opens: 7, engaged_ms: 180000, new_profiles: 0, level_ups: 0, guests: 0 }]);
  assert.deepEqual((await upgraded.store.db.prepare('PRAGMA table_info(live)').all()).results.map(c => c.name), ['s', 'slug', 'seen_minute', 'p', 'wire']);
  assert.deepEqual(await upgraded.store.db.prepare('SELECT * FROM live').all().then(r => r.results), [], 'live starts again');
  // The overlap day adds up: the frozen totals and the facts of the same day.
  const base = `http://127.0.0.1:${port}`;
  for (const s of ['a00000000001', 'a00000000002', 'a00000000003']) {
    const res = await request(base, 'POST', '/v1/batch', { headers: { 'content-type': 'text/plain', origin: ORIGIN },
      body: JSON.stringify(envelope(s, [['go', 1, 'road-hopper', 'featured', 0], ['gx', 20, 'road-hopper', 15000, z6, z4]])) });
    assert.equal(res.status, 204);
  }
  const kpis = (await request(base, 'GET', '/v1/admin/kpis?from=2026-10-20&to=2026-10-20', { headers: { authorization: 'Bearer ' + TOKEN } })).json();
  assert.deepEqual([kpis.totals.sessions, kpis.totals.gameOpens, kpis.totals.engagedMinutes, kpis.games[0].sessions, kpis.games[0].opens], [7, 10, 3.8, 6, 8]);
  await upgraded.close();

  // Schema 2 (milestone 2 before kpi_cache): to 3, then to 5, at start.
  const older = path.join(dir, 'older.db');
  await milestone2(older);
  let db = openDatabase(older);
  await db.batch([db.prepare('DROP TABLE kpi_cache'), db.prepare("UPDATE meta SET value = 2 WHERE key = 'schema'")]);
  db.close();
  const two = openStore(openDatabase(older));
  assert.deepEqual([await two.setup(START), await two.setup(START), await two.setup(START)], ['migrated', 'migrated', 'ready']);
  assert.deepEqual(await names(two.db), [...v5, ...Object.keys(TABLES)].sort());
  two.close();

  // A database of a newer server is refused, and left as it is.
  db = openDatabase(fresh);
  await db.prepare("UPDATE meta SET value = ?1 WHERE key = 'schema'").bind(SCHEMA_VERSION + 1).run();
  db.close();
  const newer = createApp({ dbPath: fresh });
  t.after(() => newer.close());
  await assert.rejects(newer.listen(0, '127.0.0.1'), new RegExp(`database schema ${SCHEMA_VERSION + 1} is newer than this server \\(${SCHEMA_VERSION}\\)`));
});

test('main.mjs starts from the environment without the SQLite warning and refuses bad settings', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-games-telemetry-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', DB_PATH: path.join(dir, 'sub', 't.db'),
    ALLOWED_ORIGINS: ORIGIN + ', null', ADMIN_TOKEN: TOKEN, RETENTION_DAYS: '30', RATE_PER_MIN: '600' };
  const child = spawn(process.execPath, [path.join(repo, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', d => { stdout += d; const m = /listening on port (\d+)/.exec(stdout); if (m) resolve(Number(m[1])); });
    child.on('exit', () => reject(new Error('main.mjs exited: ' + stderr)));
  });
  try {
    assert.match(stdout, /2 allowed origin\(s\), admin on, retention 30 days, 600 requests per minute/);
    assert.equal((await request(`http://127.0.0.1:${port}`, 'GET', '/v1/health')).status, 200);
    assert.equal((await request(`http://127.0.0.1:${port}`, 'GET', '/v1/admin/live', { headers: { authorization: 'Bearer ' + TOKEN } })).status, 200);
  } finally {
    child.kill('SIGTERM');
  }
  assert.equal(await exited, 0);
  assert.doesNotMatch(stderr, /ExperimentalWarning|SQLite/);
  assert.ok(fs.existsSync(env.DB_PATH));
  for (const [name, value, message] of [['ALLOWED_ORIGINS', ORIGIN + '/', /not an origin/], ['ALLOWED_ORIGINS', 'school.example', /not an origin/],
    ['ADMIN_TOKEN', 'short', /at least 16/], ['ADMIN_TOKEN', 'ü'.repeat(20), /printable ASCII/],
    ['RETENTION_DAYS', '0', /RETENTION_DAYS/], ['RETENTION_DAYS', '1000000000', /RETENTION_DAYS must be a whole number from 1 to 36500/],
    ['PORT', '70000', /PORT must be a whole number from 0 to 65535/],
    ['RATE_PER_MIN', 'many', /RATE_PER_MIN/]]) {
    const run = spawnSync(process.execPath, [path.join(repo, 'main.mjs')], { env: { ...env, [name]: value }, encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 1, name + '=' + value);
    assert.match(run.stderr, message);
  }
});

