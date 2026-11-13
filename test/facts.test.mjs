// The store's facts (store.mjs, schema 5) on the Node driver: v3 batches written
// idempotently, v2 batches numbered by the server, the session's clock, the school's zone,
// late data, the usage meter, the query plans of every write and admin read, the export's
// pinned columns and values, and the simulated school (docs/RESEARCH_TELEMETRY_SPEC.md, §C,
// §D, §F.6 and §F.7). The batches here are mostly an older portal's (with a student code,
// an age band and a profile's fields), which every test stores as anonymous sessions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sqlite-d1.mjs hides node:sqlite's ExperimentalWarning before it loads node:sqlite.
const { openDatabase } = await import('../sqlite-d1.mjs');
const { openStore } = await import('../store.mjs');
const { validateBatch } = await import('../schema.mjs');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(repo, 'fixtures/sample-batch-v3.json'), 'utf8'));
const T0 = Date.parse('2026-10-20T09:15:00Z'), R0 = T0 / 1000;
const MIN = 60000, DAY_MS = 86400000;
const U1 = '3f9a0c51e2b7', U2 = '7b7b00112233', U3 = '1b2c3d4e5f60', P1 = '8c21d0e94a6f', P2 = '0a0b0c0d0e0f';
const z6 = [0, 0, 0, 0, 0, 0], z4 = [0, 0, 0, 0];

let seq = 0;
const bid = () => (0xf000000000000000n + BigInt(++seq)).toString(16);
const lastT = ev => ev.reduce((t, e) => Math.max(t, e[1]), 0);
const v3 = (s, ev, extra = {}) => ({ v: 3, b: bid(), s, k: 'src', m: 'web', a: '8-9', d: [4, 4, 1920], u: U1, p: P1, z: '', ev, w: lastT(ev) + 5, ...extra });
const v2 = (s, ev, extra = {}) => ({ v: 2, b: bid(), s, k: 'src', m: 'web', a: '6-7', d: [4, 4, 1920], ev, ...extra });
const ss3 = (age = 10, since = 1, np = 3) => ['ss', 0, 0, age, since, 3, np, 0];
const rs3 = (t, n, k, slug, id) => ['rs', t, n, k, slug, id, 1, 0];
const re3 = (t, n, k, slug, id, code) => ['re', t, n, k, slug, code, id, 20000, 10, 1, 3, 1, z6, null];

function open(db = openDatabase(':memory:')) {
  const store = openStore(db);
  const rows = async (table, order) => (await db.prepare(`SELECT * FROM ${table}${order ? ' ORDER BY ' + order : ''}`).all()).results;
  const ingest = (body, now) => {
    const valid = validateBatch(body);
    assert.ok(valid, 'a valid batch');
    assert.equal(valid.dropped, 0, 'no event dropped: ' + JSON.stringify(body.ev));
    return store.ingest(valid, now);
  };
  const settings = async () => Object.fromEntries((await rows('settings')).map(r => [r.key, r.value]));
  return { db, store, rows, ingest, settings };
}
// Every upgrade step, at the given time (it decides facts_since).
async function ready(store, now) {
  while (await store.setup(now) === 'migrated');
}
// Every table, apart from what a repeat may change (live.seen_minute and usage). Without
// live: a repeat sent out of order, or minutes later, moves who is playing what now.
async function snapshot(db, { live = true } = {}) {
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).results.map(r => r.name);
  const out = {};
  for (const table of tables.filter(name => name !== 'usage' && (live || name !== 'live'))) {
    const rows = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
    out[table] = table === 'live' ? rows.map(({ seen_minute: _minute, ...rest }) => rest) : rows;
  }
  return out;
}
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
// A day of the KPIs with play on it.
const hasPlay = day => day.sessions > 0;

test('a v3 batch delivered again, later or as a retry with a newer w, leaves every table as one delivery left it', async () => {
  const s = open();
  const later = v3(fixture.s, [rs3(170, 4, 1, 'road-hopper', 'L3'), ['gp', 175, 4, 'road-hopper', 4000]],
    { u: fixture.u, p: fixture.p, z: fixture.z, a: fixture.a, w: 180 });
  assert.equal(await s.ingest(fixture, T0), true);
  assert.equal(await s.ingest(later, T0 + MIN), true);
  const once = await snapshot(s.db);
  assert.equal(once.st_rounds.length, 4);
  assert.equal(await s.ingest(fixture, T0 + 2 * MIN), true, 'a repeat is answered like a new batch');
  // The sink's retry carries the same batch id and a newer w.
  assert.equal(await s.ingest({ ...fixture, w: fixture.w + 300 }, T0 + 7 * MIN), true);
  assert.equal(await s.ingest(later, T0 + 8 * MIN), true);
  // A fresh instance (no settings in memory) is no different.
  assert.equal(await open(s.db).ingest(fixture, T0 + 9 * MIN), true);
  assert.deepEqual(await snapshot(s.db), once);
});

test('the same v3 batch arriving at two instances at the same moment is stored as once', async () => {
  const db = openDatabase(':memory:'), a = open(db), b = open(db);
  await ready(a.store, T0);
  await ready(b.store, T0);
  // Both read the session before either writes, as two Workers would.
  const batch = db.batch.bind(db);
  let arrived = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  db.batch = async statements => {
    if (statements.some(st => st.sql.startsWith('INSERT INTO st_sessions'))) {
      if (++arrived === 2) release();
      await both;
    }
    return batch(statements);
  };
  assert.deepEqual(await Promise.all([a.ingest(fixture, T0), b.ingest(fixture, T0 + 1000)]), [true, true]);
  assert.equal(arrived, 2);
  db.batch = batch;
  const reference = open();
  await reference.ingest(fixture, T0);
  assert.deepEqual(await snapshot(db), await snapshot(reference.db));
});

test('a v2 batch is stored once: a repeat, even at the same moment on another instance, is refused by its batch id', async () => {
  const db = openDatabase(':memory:'), a = open(db), b = open(db);
  const body = v2('c00000000001', [['ss', 0, 0, 1, 1, 3], ['go', 2, 'road-hopper', 'featured', 1], ['lv', 5, 4]]);
  assert.equal(await a.ingest(body, T0), true);
  const once = await snapshot(db);
  assert.equal(await a.ingest(body, T0 + MIN), false);
  assert.equal(await b.ingest({ ...body, ev: [['lv', 9, 5]] }, T0 + 2 * MIN), false, 'the id alone decides');
  assert.deepEqual(await snapshot(db), once);
  const next = v2('c00000000002', [['go', 1, 'maze-dash', 'catalog', 0]]);
  const answers = await Promise.all([a.ingest(next, T0 + 3 * MIN), b.ingest(next, T0 + 3 * MIN)]);
  assert.deepEqual(answers.sort(), [false, true]);
  assert.equal((await a.rows('st_visits')).filter(v => v.slug === 'maze-dash').length, 1);
});

test('v2 batches are numbered by the server: visits from go, orphan visits for another game, rounds matched to the open one', async () => {
  const s = open(), S = 'c20000000001';
  const re2 = (t, slug, id, code) => ['re', t, slug, code, id, 15000, 5, 1, 2, 1, z6];
  await s.ingest(v2(S, [['ss', 0, 0, 1, 1, 3], ['go', 2, 'road-hopper', 'featured', 1], ['ld', 3, 'road-hopper', 700], ['rs', 4, 'road-hopper', 'L1', 1, 0]]), T0);
  // The open round ends in the next batch; a re of another level is a round of its own.
  await s.ingest(v2(S, [re2(30, 'road-hopper', 'L1', 'w'), ['rs', 31, 'road-hopper', 'L2', 1, 0], re2(50, 'road-hopper', 'L3', 'q'),
    ['gx', 55, 'road-hopper', 40000, z6, z4]]), T0 + MIN);
  // A game whose go never arrived, then a game with a round that never started.
  await s.ingest(v2(S, [['rs', 60, 'tank-splat', 'L1', 0, 0], re2(80, 'tank-splat', 'L1', 'l'), ['go', 90, 'maze-dash', 'catalog', 0],
    re2(100, 'maze-dash', 'L1', 'e'), ['lv', 101, 4], ['er', 102, 'maze-dash', 'x'], ['gx', 103, 'maze-dash', 9000, z6, z4], ['se', 110, 49000]]), T0 + 2 * MIN);
  assert.deepEqual((await s.rows('st_visits', 'n')).map(v => [v.n, v.slug, v.t_open, v.t_close, v.src, v.plays, v.plays_b, v.load_ms, v.err, v.engaged_ms, v.closed]), [
    [1, 'road-hopper', 2, 55, 'featured', null, 1, 700, null, 40000, 1],
    [2, 'tank-splat', null, null, null, null, null, null, null, 0, 0],
    [3, 'maze-dash', 90, 103, 'catalog', null, 0, null, 'x', 9000, 1]
  ]);
  assert.deepEqual((await s.rows('st_rounds', 'n, k')).map(r => [r.n, r.k, r.slug, r.id, r.t0, r.t, r.code, r.score, r.attempt]), [
    [1, 1, 'road-hopper', 'L1', 4, 30, 'w', 5, null], [1, 2, 'road-hopper', 'L2', 31, null, null, null, null],
    [1, 3, 'road-hopper', 'L3', null, 50, 'q', 5, null], [2, 1, 'tank-splat', 'L1', 60, 80, 'l', 5, null],
    [3, 1, 'maze-dash', 'L1', null, 100, 'e', 5, null]
  ]);
  const [session] = await s.rows('st_sessions');
  assert.deepEqual(pick(session, ['u', 'p', 'z', 'wire', 'clock', 'is_new', 'age_days', 'age_b', 'since_b', 'level0', 'np', 'se_t', 'se_ms', 'why',
    'vn', 'open_n', 'open_slug', 'open_k', 'last_k', 'a']), { u: '', p: '', z: '', wire: 2, clock: 'r', is_new: null, age_days: null, age_b: null, since_b: null,
    level0: null, np: null, se_t: 110, se_ms: 49000, why: null, vn: 3, open_n: null, open_slug: null, open_k: null, last_k: 1, a: '' });
  assert.deepEqual(await s.rows('st_marks'), [], 'the level-up is not kept');
});

test('a session is dated by the PC\'s elapsed seconds; its first batch sets the start for good', async () => {
  const s = open();
  await ready(s.store, T0 - 5 * DAY_MS);
  const start = async id => pick(await s.db.prepare('SELECT start_s, clock FROM st_sessions WHERE s = ?1').bind(id).first(), ['start_s', 'clock']);
  await s.ingest(v3('d00000000001', [ss3(), ['go', 150, 1, 'road-hopper', 'catalog', 0, 0]], { w: 200 }), T0);
  assert.deepEqual(await start('d00000000001'), { start_s: R0 - 200, clock: 'w' });
  // A later batch of the session, sent 5 minutes later, has a larger w and changes nothing.
  await s.ingest(v3('d00000000001', [['gx', 400, 1, 'road-hopper', 1000, z6, z4]], { w: 501 }), T0 + 5 * MIN);
  assert.deepEqual(await start('d00000000001'), { start_s: R0 - 200, clock: 'w' });
  // w is never less than the batch's last event time (a level-up an older portal sends is no event).
  await s.ingest(v3('d00000000002', [ss3(), ['ct', 150, 'c', 0], ['lv', 170, 4]], { w: 10 }), T0);
  assert.deepEqual(await start('d00000000002'), { start_s: R0 - 150, clock: 'w' });
  // A malformed w falls back to the receipt time, as for v2.
  for (const [id, w] of [['d00000000003', 691201], ['d00000000004', -1], ['d00000000005', 1.5], ['d00000000006', '64'], ['d00000000007', undefined]]) {
    await s.ingest(v3(id, [ss3(), ['ct', 30, 'c', 0]], { w }), T0);
    assert.deepEqual(await start(id), { start_s: R0 - 30 - 10, clock: 'r' }, String(w));
  }
  await s.ingest(v2('d00000000008', [['ss', 0, 0, 1, 1, 3], ['se', 40, 0]]), T0);
  assert.deepEqual(await start('d00000000008'), { start_s: R0 - 40 - 10, clock: 'r' });
  // A batch held offline for 3 days lands on the day it was played.
  const played = Date.parse('2026-10-17T10:00:00Z');
  await s.ingest(v3('d00000000009', [ss3(), ['go', 2, 1, 'road-hopper', 'catalog', 0, 0], ['gx', 100, 1, 'road-hopper', 60000, z6, z4]],
    { w: (T0 - played) / 1000 }), T0);
  assert.deepEqual(await start('d00000000009'), { start_s: played / 1000, clock: 'w' });
  const kpis = await s.store.kpis({ from: '2026-10-17', to: '2026-10-20' }, T0);
  assert.deepEqual(kpis.daily.map(d => [d.day, hasPlay(d)]), [['2026-10-17', true], ['2026-10-18', false], ['2026-10-19', false], ['2026-10-20', true]]);
});

test('days follow the school\'s zone: in Riyadh a session that starts at 21:30 UTC counts on the next day', async () => {
  const s = open();
  await ready(s.store, T0);
  await s.ingest(v3('e00000000001', [ss3(), ['lv', 5, 4]], { z: 'Asia/Riyadh' }), T0);
  const late = Date.parse('2026-10-21T21:30:00Z');
  await s.ingest(v3('e00000000002', [ss3(), ['go', 1, 1, 'road-hopper', 'catalog', 0, 0], ['gx', 50, 1, 'road-hopper', 40000, z6, z4]], { w: 0 }), late);
  assert.equal(s.store.today(late), '2026-10-22');
  const kpis = await s.store.kpis({ from: '2026-10-21', to: '2026-10-22' }, late);
  assert.deepEqual(kpis.daily.map(d => [d.day, hasPlay(d)]), [['2026-10-21', false], ['2026-10-22', true]]);
});

test('the school\'s zone: unknown until a PC reports one; the dashboard\'s guess yields to a PC; a PC never moves a PC\'s or the owner\'s choice', async () => {
  const db = openDatabase(':memory:');
  let s = open(db);
  await ready(s.store, T0);
  const keys = ['tz', 'tz_source', 'tz_epoch', 'rv', 'v3_since', 'facts_since', 'legacy_until', 'week_start', 'week_source', 'keep_days', 'rolled_through'];
  assert.deepEqual(pick(await s.settings(), keys), { tz: 'UTC', tz_source: 'none', tz_epoch: '0', rv: '1', v3_since: '', facts_since: '2026-10-20',
    legacy_until: '', week_start: 'mon', week_source: 'auto', keep_days: '', rolled_through: '' });
  // Days as the cron will have rolled them.
  await db.batch([db.prepare("INSERT INTO roll_days (day, dirty, rolled_s) VALUES ('2026-10-19', 0, 1), ('2026-10-20', 0, 1), ('2026-10-21', 1, 1)")]);
  const dirty = async () => (await s.rows('roll_days', 'day')).map(r => [r.day, r.dirty]);
  // v2 changes nothing; the first v3 batch marks the first v3 day, without a zone.
  await s.ingest(v2('f00000000001', [['lv', 1, 2]]), T0);
  assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'v3_since']), { tz: 'UTC', tz_source: 'none', v3_since: '' });
  await s.ingest(v3('f00000000002', [ss3()], { z: 'Mars/Olympus' }), T0 + MIN);
  assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'tz_epoch', 'rv', 'v3_since']), { tz: 'UTC', tz_source: 'none', tz_epoch: '0', rv: '1', v3_since: '2026-10-20' });
  // A PC reports its zone: it becomes the school's, every day since facts_since is rebuilt.
  await s.ingest(v3('f00000000003', [ss3()], { z: 'Asia/Riyadh' }), T0 + 2 * MIN);
  assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'tz_epoch', 'rv', 'v3_since']), { tz: 'Asia/Riyadh', tz_source: 'pc', tz_epoch: '1', rv: '2', v3_since: '2026-10-20' });
  assert.deepEqual(await dirty(), [['2026-10-19', 0], ['2026-10-20', 2], ['2026-10-21', 2]]);
  assert.equal((await s.rows('st_pcs')).find(pc => pc.p === P1).z, 'Asia/Riyadh');
  // Another PC's zone does not move it, even on an instance that still believes the source is none.
  await s.ingest(v3('f00000000004', [ss3()], { z: 'Europe/London', p: P2 }), T0 + 3 * MIN);
  await open(db).ingest(v3('f00000000005', [ss3()], { z: 'Europe/London', p: P2 }), T0 + 4 * MIN);
  assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'tz_epoch', 'rv']), { tz: 'Asia/Riyadh', tz_source: 'pc', tz_epoch: '1', rv: '2' });
  // The dashboard's guess (its browser's zone) yields to the first PC that reports one.
  const set = (tz, source) => db.batch([db.prepare("UPDATE settings SET value = CASE key WHEN 'tz' THEN ?1 ELSE ?2 END WHERE key IN ('tz', 'tz_source')").bind(tz, source),
    db.prepare('UPDATE roll_days SET dirty = 0')]);
  await set('Europe/Paris', 'dashboard');
  s = open(db);
  await s.ingest(v3('f00000000006', [ss3()], { z: 'Asia/Riyadh' }), T0 + 5 * MIN);
  assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'tz_epoch', 'rv']), { tz: 'Asia/Riyadh', tz_source: 'pc', tz_epoch: '2', rv: '3' });
  assert.deepEqual(await dirty(), [['2026-10-19', 0], ['2026-10-20', 2], ['2026-10-21', 2]]);
  // The same zone as the dashboard's: the source becomes the PCs', and nothing is rebuilt.
  await set('Asia/Riyadh', 'dashboard');
  s = open(db);
  await s.ingest(v3('f00000000007', [ss3()], { z: 'Asia/Riyadh' }), T0 + 6 * MIN);
  assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'tz_epoch', 'rv']), { tz: 'Asia/Riyadh', tz_source: 'pc', tz_epoch: '2', rv: '3' });
  assert.deepEqual(await dirty(), [['2026-10-19', 0], ['2026-10-20', 0], ['2026-10-21', 0]]);
  // The nightly vote's lock and the owner's click are never changed by a batch.
  for (const source of ['pcs', 'owner']) {
    await set('Asia/Riyadh', source);
    s = open(db);
    await s.ingest(v3('f0000000000' + (source === 'pcs' ? 8 : 9), [ss3()], { z: 'Europe/London', p: P2 }), T0 + 7 * MIN);
    assert.deepEqual(pick(await s.settings(), ['tz', 'tz_source', 'tz_epoch', 'rv']), { tz: 'Asia/Riyadh', tz_source: source, tz_epoch: '2', rv: '3' });
  }
});

test('late data marks the rolled day of its session for a re-roll, once', async () => {
  const db = openDatabase(':memory:');
  let s = open(db);
  await ready(s.store, T0 - 2 * DAY_MS);
  await db.batch([db.prepare("INSERT INTO roll_days (day, dirty, rolled_s) VALUES ('2026-10-18', 0, 1), ('2026-10-19', 0, 1)"),
    db.prepare("UPDATE settings SET value = '2026-10-19' WHERE key = 'rolled_through'")]);
  s = open(db);
  const sent = [];
  const batch = db.batch.bind(db);
  db.batch = async statements => { sent.push(...statements.map(st => st.sql)); return batch(statements); };
  // A session played yesterday, sent today; then one played today.
  await s.ingest(v3('ad0000000001', [ss3(), ['ct', 10, 'c', 0]], { w: DAY_MS / 1000 }), T0);
  assert.deepEqual((await s.rows('roll_days', 'day')).map(r => [r.day, r.dirty]), [['2026-10-18', 0], ['2026-10-19', 1]]);
  sent.length = 0;
  await s.ingest(v3('ad0000000002', [ss3(), ['ct', 10, 'c', 0]]), T0 + MIN);
  assert.ok(!sent.some(text => text.startsWith('UPDATE roll_days')), 'today is not rolled yet: no statement');
  // A v2 batch of yesterday's session (its start is read back) marks it again only after a roll.
  await db.batch([db.prepare("UPDATE roll_days SET dirty = 0 WHERE day = '2026-10-19'")]);
  await s.ingest(v3('ad0000000001', [['ct', 20, 'e', 0]], { w: DAY_MS / 1000 + 60 }), T0 + 2 * MIN);
  assert.deepEqual((await s.rows('roll_days', 'day')).map(r => [r.day, r.dirty]), [['2026-10-18', 0], ['2026-10-19', 1]]);
  // A session of 20 October; this instance reads the settings at 01:08, another one rolls the 20th at 01:10, and a
  // late batch of that session at 01:11 is still marked, though this instance's copy says only the 19th is rolled.
  const evening = Date.parse('2026-10-20T23:00:00Z'), night = Date.parse('2026-10-21T01:10:00Z');
  await s.ingest(v3('ad0000000003', [ss3(), ['ct', 10, 'c', 0]]), evening);
  await s.ingest(v3('ad0000000004', [ss3(), ['ct', 10, 'c', 0]]), night - 2 * MIN);
  assert.equal((await open(db).store.rollupStep(night)).rolled, '2026-10-20');
  await s.ingest(v3('ad0000000003', [['ct', 30, 'e', 0]], { w: (night + MIN - evening) / 1000 + 15 }), night + MIN);
  assert.deepEqual((await s.rows('roll_days', 'day')).map(r => [r.day, r.dirty]), [['2026-10-18', 0], ['2026-10-19', 1], ['2026-10-20', 1]]);
});

test('the usage meter adds up every result\'s rows and writes them at most once a minute; it sets the batch interval', async () => {
  const db = openDatabase(':memory:');
  const batch = db.batch.bind(db), written = [], read = [], flushes = new Map();
  let now = T0;
  db.batch = async statements => {
    const results = await batch(statements);
    written.push(results.reduce((n, r) => n + r.meta.rows_written, 0));
    read.push(results.reduce((n, r) => n + r.meta.rows_read, 0));
    if (statements.some(st => st.sql.startsWith('INSERT INTO usage'))) {
      const minute = Math.floor(now / MIN);
      flushes.set(minute, (flushes.get(minute) || 0) + 1);
    }
    return results;
  };
  const s = open(db);
  for (let i = 0; i < 12; i++) {
    now = T0 + i * 20000;
    await s.ingest(v3('ae000000000' + (i % 3), [ss3(), ['go', 1, 1, 'road-hopper', 'catalog', 0, 0], rs3(2, 1, 1, 'road-hopper', 'L1'),
      re3(30 + i, 1, 1, 'road-hopper', 'L1', 'w')]), now);
  }
  assert.ok([...flushes.values()].every(n => n === 1), 'at most once a minute: ' + JSON.stringify([...flushes]));
  now = T0 + 10 * MIN;
  await s.store.sweep(now);
  // Every batch but the last (whose counts wait for the next minute) is in the table.
  const [usage] = await s.rows('usage');
  const sum = list => list.slice(0, -1).reduce((x, y) => x + y, 0);
  assert.deepEqual(pick(usage, ['day', 'writes', 'reads']), { day: '2026-10-20', writes: sum(written), reads: sum(read) });
  assert.equal(usage.size, db.sqlite.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get().n);
  // X-Batch-Every: 60 s while today's writes are up to 60,000, 180 s up to 80,000, then 300 s.
  for (const [writes, every] of [[0, 60], [60000, 60], [60001, 180], [80000, 180], [80001, 300], [99000, 300]]) {
    await db.prepare("UPDATE usage SET writes = ?1 WHERE day = '2026-10-20'").bind(writes).run();
    const fresh = open(db);
    await ready(fresh.store, now);
    assert.equal(fresh.store.batchEvery(now), every, String(writes));
  }
  // The day's writes of this instance that wait for a flush count too.
  const fresh = open(db);
  await db.prepare("UPDATE usage SET writes = 59999 WHERE day = '2026-10-20'").run();
  await fresh.ingest(v3('af0000000001', [ss3(), ['go', 1, 1, 'road-hopper', 'catalog', 0, 0], ['lv', 2, 4]]), now);
  assert.equal(fresh.store.batchEvery(now), 180);
  assert.equal(fresh.store.batchEvery(now + DAY_MS), 60, 'a new UTC day starts again');
});

// The small tables a statement may scan: settings, roll_days and usage always (live holds a few
// minutes of sessions); the PCs for the zone vote and the settings' zone list; the PCs for the
// daily purge (it finds those last seen before the cutoff, and the v2 batch ids older than 30 days, as
// milestone 2 did: an index on their day would cost every v2 batch a row written); kpi_cache when a roll
// forgets its old parts.
const SCANS = [[/FROM st_pcs WHERE last_s >= /, 'st_pcs'], [/^DELETE FROM st_pcs WHERE last_s /, 'st_pcs'], [/^DELETE FROM batches WHERE day < /, 'batches'],
  [/^DELETE FROM kpi_cache WHERE made /, 'kpi_cache']];

test('every write, pre-read, roll, admin read and purge finds its rows by key: none scans a fact or rollup table', async () => {
  const db = openDatabase(':memory:'), seen = new Map();
  const batch = db.batch.bind(db);
  db.batch = async statements => {
    for (const st of statements) if (!seen.has(st.sql)) seen.set(st.sql, st.params);
    return batch(statements);
  };
  const s = open(db);
  await ready(s.store, T0 - DAY_MS);
  await db.batch([db.prepare("INSERT INTO roll_days (day, dirty, rolled_s) VALUES ('2026-10-19', 0, 1)"),
    db.prepare("UPDATE settings SET value = '2026-10-19' WHERE key = 'rolled_through'")]);
  const stores = [open(db), open(db)];
  await stores[0].ingest(fixture, T0);
  await stores[0].ingest(v3(fixture.s, [re3(200, 3, 2, 'tic-tac-toe', 'local', 'w'), ['pr', 201, U3], ['cd', 202, U3]], { u: fixture.u, w: 210 }), T0 + MIN);
  await stores[1].ingest(v3('ba0000000001', [ss3(), ['ct', 3, 's', 10]], { u: U3, w: DAY_MS / 1000, z: 'Europe/London' }), T0 + 2 * MIN);
  await stores[1].ingest(v2('ba0000000002', [['ss', 0, 0, 1, 1, 3], ['go', 2, 'road-hopper', 'featured', 1], ['rs', 3, 'road-hopper', 'L1', 1, 0]]), T0 + 3 * MIN);
  await stores[1].ingest(v2('ba0000000002', [['re', 9, 'road-hopper', 'w', 'L1', 6000, 1, 1, 1, 1, z6], ['gx', 10, 'road-hopper', 6000, z6, z4]]), T0 + 4 * MIN);
  await stores[1].store.kpis({ from: '2026-10-19', to: '2026-10-20' }, T0 + 5 * MIN);
  await stores[1].store.live(T0 + 5 * MIN);
  // The cron's rolls (a first roll with the vote, a diff, a full one), the closed and open KPIs, settings and the purge.
  const store = stores[1].store, night = Date.parse('2026-10-20T22:30:00Z');
  assert.equal((await store.rollupStep(night)).kind, 'first');
  await db.batch([db.prepare('UPDATE roll_days SET dirty = 1, rolled_s = 0')]);
  assert.equal((await store.rollupStep(night + MIN)).kind, 'diff');
  await store.updateSettings({ tz: 'Europe/London', weekStart: 'sun', keepDays: 400 }, night + 2 * MIN);
  assert.equal((await store.rollupStep(night + 3 * MIN)).kind, 'full');
  await store.kpis({ from: '2026-10-18', to: '2026-10-21' }, night + 4 * MIN);
  await store.settings(night + 4 * MIN);
  await store.purge(night + 5 * MIN);
  // The research reads (rolled and open days), every export file (its first page and a later one), the recount, and the upgrade's clearing.
  const q = { from: '2026-10-18', to: '2026-10-21' }, at = night + 6 * MIN;
  await store.game({ slug: 'road-hopper', ...q }, at);
  await store.game({ slug: 'road-hopper', from: '2026-10-12', to: '2026-10-21' }, at);
  for (const slug of [null, 'road-hopper']) await store.stats({ ...q, metrics: ['sesslen', 'flow'], slug }, at);
  await store.pcs(q, at);
  const cursors = { sessions: `${R0}.1`, visits: `${R0}.1.1`, rounds: `${R0}.1.1.1`, events: `${R0}.1.fv.42.1.1`, daily_games: '2026-10-19.school.road-hopper', pcs: P1 };
  for (const [file, after] of Object.entries(cursors)) for (const cursor of [null, after]) await store.exportPage({ file, ...q, after: cursor }, at);
  await db.batch([db.prepare("UPDATE settings SET value = CASE key WHEN 'scrub' THEN '1' WHEN 'scrub_end' THEN '9' ELSE '' END WHERE key IN ('scrub', 'scrub_end', 'scrub_day')")]);
  assert.equal((await openStore(db).rollupStep(at)).cleared, 'facts');
  assert.deepEqual((await openStore(db).rollupStep(at + MIN)).cleared, ['2026-10-19', '2026-10-20']);
  await store.rebuild(at + 2 * MIN);
  const r_stat_reads = new Set();
  for (const [text, params] of seen) {
    if (!/^(?:SELECT|INSERT|UPDATE|DELETE|WITH)/.test(text) || /sqlite_master/.test(text)) continue;
    const plan = db.sqlite.prepare('EXPLAIN QUERY PLAN ' + text).all(...params).map(row => row.detail);
    const allowed = SCANS.filter(([pattern]) => pattern.test(text)).map(([, tables]) => tables).join('|');
    for (const step of plan) {
      const scan = /^SCAN (st_\w+|r_\w+|batches|kpi_cache)\b/.exec(step);
      assert.ok(!scan || allowed && new RegExp(`^(?:${allowed})$`).test(scan[1]), text.slice(0, 120) + '\n' + plan.join('\n'));
    }
    // r_stat has no index by metric: its reads find the rows of each day and a by key.
    if (/x\.metric = 'sesslen' AND x\.slug = ''|metric = 'flow' AND x\.slug = f\.slug/.test(text)) {
      assert.ok(plan.some(step => /^SEARCH x USING PRIMARY KEY \(day=\? AND a=\? AND metric=\? AND slug=\?/.test(step)), text.slice(0, 120) + '\n' + plan.join('\n'));
      r_stat_reads.add(/metric = 'flow' AND x\.slug = f\.slug/.test(text) ? 'flow' : 'sesslen');
    }
    // Sessions are found by their start.
    if (/FROM st_sessions s/.test(text) && /start_s >= \?1/.test(text)) {
      assert.ok(plan.some(step => /SEARCH s USING (?:COVERING )?INDEX st_sessions_time/.test(step)), text.slice(0, 120) + '\n' + plan.join('\n'));
    }
  }
  assert.deepEqual([...r_stat_reads].sort(), ['flow', 'sesslen']);
  // Every kind of write and pre-read was checked.
  for (const statement of ['INSERT INTO st_sessions', 'INSERT INTO st_visits', 'INSERT INTO st_rounds', 'INSERT INTO st_pcs',
    'INSERT OR IGNORE INTO st_marks', 'UPDATE roll_days SET', 'UPDATE settings SET', 'INSERT INTO live', 'DELETE FROM live', 'INSERT INTO batches',
    'INSERT INTO usage', 'SELECT s.id, s.start_s,', 'INSERT INTO r_stat', 'DELETE FROM r_day', 'INSERT INTO roll_days',
    'INSERT INTO kpi_cache (key, made, rows) SELECT ?5', "SELECT (SELECT rows -> '$.extras' FROM kpi_cache",
    'SELECT key, rows FROM kpi_cache', 'DELETE FROM st_rounds', 'DELETE FROM r_stat WHERE day = ?1 AND (', 'UPDATE roll_days SET rows',
    // The research reads: a game, r_stat and the PCs.
    "INSERT INTO kpi_cache (key, made, rows) SELECT ?5, ?6, json_object('days'", "SELECT json_object('days'",
    'INSERT INTO kpi_cache (key, made, rows) SELECT ?4, ?5, (SELECT json_group_array(json_array(metric, slug', 'SELECT x.p AS p', 'SELECT p, z, k',
    'SELECT k FROM st_pcs',
    // Export pages of every file.
    ...["SELECT IFNULL(s.s, '') || ',' || IFNULL(s.p", "SELECT IFNULL(s.s, '') || ',' || IFNULL(v.n", "SELECT IFNULL(s.s, '') || ',' || IFNULL(r.n",
      "SELECT IFNULL(s.s, '') || ',' || IFNULL(date(", "SELECT IFNULL(x.day", 'WITH d AS (SELECT p, sessions'].map(text => 'WITH page AS MATERIALIZED (' + text),
    // The recount, and the upgrade's clearing of the facts and of the rollups.
    'UPDATE roll_days SET dirty = 3 WHERE day >=', "UPDATE st_sessions SET u = ''", 'UPDATE st_rounds SET attempt = NULL', "DELETE FROM st_marks WHERE sid IN",
    "INSERT INTO r_day (day, a, sessions", "DELETE FROM r_stat WHERE day BETWEEN ?1 AND ?2", 'UPDATE r_pc_day SET students = 0']) {
    assert.ok([...seen.keys()].some(text => text.startsWith(statement)), 'covered: ' + statement);
  }
});

// The research files' columns, in the order §F.6 of the spec pins (the dashboard's dictionary.js lists the same).
const SPEC_COLUMNS = {
  sessions: 'session, pc, wire_version, day, weekday, start_time, minute_of_day, start_utc, clock_source, mode, build, ' +
    'cores, memory_gb, screen, games_opened, rounds, engaged_s, end_t_s, end_reason, timer_minutes, timer_ended',
  visits: 'session, visit, day, open_time, open_s, close_s, open_seconds, engaged_s, game, source, plays_before, ' +
    'plays_before_bucket, favourite_at_open, load_ms, error, rounds_started, rounds_ended, tutorial, hearts_on, hearts_off, il_lt8, il_lt16, il_lt33, ' +
    'il_lt50, il_lt100, il_ge100, frames_smooth, frames_ok, frames_choppy, frames_stall, closed, previous_game, next_game',
  rounds: 'session, visit, round, pc, day, weekday, time, start_s, minutes_into_session, game, level, outcome, ' +
    'previous_outcome, two_player, replay_in_session, engaged_ms, wall_ms, score, tier_start, tier_end, dda_level, hits, misses, accuracy, ' +
    'rt_lt300, rt_lt500, rt_lt800, rt_lt1200, rt_lt2000, rt_ge2000, rt_mean_ms, rt_n, inputs, inputs_per_min, idle_lapses, pauses',
  events: 'session, day, time, t_s, kind, game, value',
  daily_games: 'day, clock, game, sessions, opens, minutes, starts, ends, wins, losses, draws, ends_neutral, quits, hearts_on, hearts_off, ' +
    'avg_tier, accuracy',
  pcs: 'pc, pc_label, first_day, last_day, days, time_zone, build, cores, memory_gb, screen, sessions, minutes, smooth_share, ' +
    'stall_share, avg_load_ms, slow_input_share, failures'
};

test('the research files have exactly the columns the spec pins, in its order', async () => {
  const { COLUMNS, FILES } = await import('../export.mjs');
  assert.deepEqual(FILES, Object.keys(SPEC_COLUMNS));
  for (const file of FILES) assert.deepEqual(COLUMNS[file], SPEC_COLUMNS[file].split(', '), file);
});

test('no value of a research file can hold a comma, a quote or a line break: every text a line holds is a token the ingest validated', async () => {
  const { isSlug, isId, SOURCES, CODES, ERRORS } = await import('../schema.mjs');
  const { isZone } = await import('../clock.mjs');
  const bad = [',', '"', "'", '\n', '\r', ';', ' '];
  for (const c of bad) {
    for (const [name, valid, sample] of [['slug', isSlug, 'road-hopper'], ['round id', isId, 'w1-2'], ['zone', isZone, 'Asia/Riyadh']]) {
      assert.ok(valid(sample), name);
      for (const value of [sample + c, c + sample, sample.slice(0, 2) + c + sample.slice(2)]) assert.ok(!valid(value), `${name} ${JSON.stringify(value)}`);
    }
    for (const list of [SOURCES, CODES, ERRORS]) assert.ok(list.every(value => !value.includes(c)), JSON.stringify(list));
    // The build (k) and the session and batch ids are exact; a wrong one refuses the batch.
    for (const field of ['k', 's', 'b']) assert.equal(validateBatch({ ...fixture, [field]: fixture[field].slice(0, -1) + c }), null, field + JSON.stringify(c));
    // A PC code that is not exact is stored as unknown; a student code or an age band is never kept, whatever it holds.
    const lenient = validateBatch({ ...fixture, p: fixture.p + c, u: fixture.u + c, a: c });
    assert.deepEqual([lenient.envelope.p, 'u' in lenient.envelope, 'a' in lenient.envelope], ['', false, false]);
  }
  // The most unusual tokens the ingest takes still give lines of exactly COLUMNS fields.
  const { COLUMNS, FILES } = await import('../export.mjs');
  const s = open();
  await s.ingest(v3('fa0000000001', [ss3(), ['go', 1, 1, 'a-b-c', 'surprise', 0, 0], ['rs', 2, 1, 1, 'a-b-c', 'w1-2:duo.b_x', 0, 0],
    ['re', 9, 1, 1, 'a-b-c', 'd', 'w1-2:duo.b_x', 7000, -1, 0, 0, 0, z6, [7000, 3, 0, 0, 0, 0, -1]], ['er', 10, 1, 'a-b-c', 'x'], ['ct', 11, 'c', 0],
    ['pr', 12, U2], ['se', 13, 7000, 'p']], { a: '', z: 'America/Port-au-Prince', m: 'app', k: 'src' }), T0);
  await s.store.rollupStep(T0 + DAY_MS);
  for (const file of FILES) {
    const page = await s.store.exportPage({ file, from: '2026-10-19', to: '2026-10-21' }, T0 + DAY_MS), lines = page.text.replace(/\n$/, '').split('\n');
    assert.ok(page.rows > 0 && lines.length === page.rows, file);
    for (const line of lines) {
      assert.doesNotMatch(line, /["\n\r]/);
      assert.equal(line.split(',').length, COLUMNS[file].length, file + ': ' + line);
    }
  }
});

test('simulate.mjs: one school in Riyadh at the sink\'s cadence, on the current portal (no accounts) and a few old PCs, with late batches', async () => {
  const { history } = await import('../simulate.mjs');
  const now = Date.parse('2026-10-22T12:00:00Z'), options = { days: 21, sessions: 200, seed: 2, now };
  const list = [...history(options)];
  assert.equal(JSON.stringify([...history(options)].slice(0, 50)), JSON.stringify(list.slice(0, 50)), 'the same seed, the same batches');
  const sessions = new Map(), kinds = new Set();
  let late = 0, last = 0;
  for (const { batch, now: at } of list) {
    const valid = validateBatch(batch);
    assert.equal(valid.dropped, 0);
    assert.ok(at >= last, 'in the order they arrive');
    last = at;
    const s = sessions.get(batch.s) || sessions.set(batch.s, { batches: 0, v: batch.v, p: batch.p, start: batch.v === 3 ? at - batch.w * 1000 : at }).get(batch.s);
    s.batches++;
    if (batch.v === 3) {
      assert.equal(batch.z, 'Asia/Riyadh');
      // The current portal: no student code, no age band, a session start without a profile's fields.
      assert.ok(!('u' in batch) && !('a' in batch), JSON.stringify(batch).slice(0, 120));
      for (const e of batch.ev) assert.ok(e[0] !== 'ss' || e.length === 2, JSON.stringify(e));
      if (at - s.start > 3 * 3600000) late++;
      // gp rides along with other events, never alone.
      if (batch.ev.some(e => e[0] === 'gp')) assert.ok(batch.ev.some(e => e[0] !== 'gp'));
    }
    for (const e of batch.ev) {
      kinds.add(batch.v + e[0] + (e[0] === 're' && e[batch.v === 3 ? 6 : 4] === 'local' ? ':duo' : ''));
      // Only the three DDA games report a DDA level.
      if (batch.v === 3 && e[0] === 're' && e[13]) assert.equal(e[13][6] >= 0, ['bubble-bop', 'dino-3d', 'road-hopper'].includes(e[4]), e[4]);
    }
  }
  const all = [...sessions.values()], v3 = all.filter(s => s.v === 3);
  assert.ok(all.length > 2000, all.length + ' sessions');
  // Sunday to Thursday, 07:30 to 13:30 at the school.
  for (const s of v3) {
    const local = new Date(s.start + 3 * 3600000);
    assert.ok(local.getUTCDay() <= 4, 'a school day');
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    assert.ok(minute >= 450 && minute < 810, 'school hours: ' + local.toISOString());
  }
  const share = (part, whole) => part.length / whole.length;
  assert.ok(share(all.filter(s => s.v === 2), all) > 0.05 && share(all.filter(s => s.v === 2), all) < 0.2, 'a v2 minority');
  const perSession = all.reduce((n, s) => n + s.batches, 0) / all.length;
  assert.ok(perSession > 6 && perSession < 16, perSession + ' batches per session');
  assert.ok(new Set(v3.map(s => s.p)).size > 30, 'one PC has a new code each day');
  assert.ok(late > 0, 'late batches from offline PCs');
  for (const kind of ['ss', 'go', 'ld', 'er', 'rs', 're', 're:duo', 'gp', 'gx', 'tu', 'fv', 'ct', 'se']) assert.ok(kinds.has('3' + kind), kind);
  for (const kind of ['lv', 'pr', 'cd']) assert.ok(!kinds.has('3' + kind), 'the current portal sends no ' + kind);
  // The old portal still sends its level-ups (which the server ignores).
  for (const kind of ['ss', 'go', 'rs', 're', 'gx', 'lv']) assert.ok(kinds.has('2' + kind), 'v2 ' + kind);
});

test('a school clock moved west after the UTC day was rolled: today is read from the facts, and rolled again only once it is over', async () => {
  const s = open();
  const D0 = Date.parse('2026-10-20T10:00:00Z'), H = 3600000;
  await ready(s.store, D0);
  const play = (sid, slug, ms, u) => v3(sid, [ss3(), ['go', 1, 1, slug, 'catalog', 0, 0], ['gx', 60, 1, slug, ms, z6, z4]], { u });
  await s.ingest(play('fc0000000001', 'road-hopper', 60000, U1), D0);
  await s.ingest(play('fc0000000002', 'road-hopper', 60000, U2), D0 + DAY_MS);
  // On UTC, the cron rolls 20 and 21 October by 01:00 UTC on the 22nd.
  for (let t = D0 + DAY_MS / 2; t <= Date.parse('2026-10-22T02:00:00Z'); t += 5 * MIN) await s.store.rollupStep(t);
  assert.equal((await s.settings()).rolled_through, '2026-10-21');
  // At 03:00 UTC (23:00 on the 21st in New York) the owner sets the school's zone: today there is the 21st again.
  const T = Date.parse('2026-10-22T03:00:00Z');
  await s.store.updateSettings({ tz: 'America/New_York' }, T);
  assert.equal(s.store.today(T), '2026-10-21');
  await s.ingest(play('fc0000000003', 'maze-dash', 300000, U3), T + 20 * MIN);
  const day = async (at, slug) => {
    const k = await s.store.kpis({ from: '2026-10-20', to: '2026-10-21' }, at);
    return [k.daily.find(d => d.day === '2026-10-21').sessions, k.games.find(g => g.slug === slug)?.sessions ?? 0];
  };
  assert.deepEqual(await day(T + 25 * MIN, 'maze-dash'), [2, 1], 'today, from the facts');
  // The cron does not roll the 21st while it lasts; a child plays at 23:50 New York time.
  const kinds = [];
  for (let t = T + 25 * MIN; t < T + H; t += 5 * MIN) { const r = await s.store.rollupStep(t); if (r.rolled === '2026-10-21') kinds.push(r.kind); }
  assert.deepEqual(kinds, []);
  await s.ingest(play('fc0000000004', 'maze-dash', 300000, '2c3d4e5f6071'), T + 50 * MIN);
  // From midnight in New York it rebuilds the 21st, with every session of it.
  for (let t = T + H; t <= T + 2 * H; t += 5 * MIN) { const r = await s.store.rollupStep(t); if (r.rolled === '2026-10-21') kinds.push(r.kind); }
  assert.deepEqual(kinds, ['full']);
  assert.deepEqual(await day(T + 2 * H, 'maze-dash'), [3, 2]);
});

test('a v2 session open across the deploy starts no earlier than the facts: its play after the deploy is rolled and shown', async () => {
  const s = open();
  // Deployed at 00:30 UTC: the facts start on 28 October. A tab opened at 23:50 the evening
  // before (v2: no hand-over when idle) sends its first batch to the new server at 00:48.
  const DEPLOY = Date.parse('2026-10-28T00:30:00Z');
  await ready(s.store, DEPLOY);
  assert.equal((await s.settings()).facts_since, '2026-10-28');
  await s.ingest(v2('c00000000031', [['gx', 2990, 'road-hopper', 2900000, z6, z4], ['go', 3000, 'maze-dash', 'catalog', 0],
    ['gx', 3500, 'maze-dash', 480000, z6, z4]]), Date.parse('2026-10-28T00:48:00Z'));
  assert.deepEqual((await s.rows('st_sessions')).map(r => new Date(r.start_s * 1000).toISOString()), ['2026-10-28T00:00:00.000Z']);
  for (let t = DEPLOY; t < DEPLOY + 3 * DAY_MS; t += 30 * MIN) await s.store.rollupStep(t);
  const k = await s.store.kpis({ from: '2026-10-26', to: '2026-10-30' }, DEPLOY + 3 * DAY_MS);
  assert.deepEqual([k.totals.engagedMinutes, k.games.map(g => g.slug)], [56.3, ['maze-dash', 'road-hopper']]);
  assert.deepEqual(k.daily.filter(hasPlay).map(d => d.day), ['2026-10-28']);
});
