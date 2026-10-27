#!/usr/bin/env node
/*
 * Deterministic synthetic telemetry for dashboard development (milestone 2).
 *
 *   node server/simulate.mjs [--url http://127.0.0.1:8787] [--sessions 300] [--seed 1]
 *       posts to a running server; every batch lands on today's receipt day.
 *   node server/simulate.mjs --db server/data/dev.db [--days 28] [--sessions 120] [--seed 1]
 *       writes straight into a database file (stop the server first or use another
 *       file), --sessions per day for the last --days days, so daily series have history.
 *
 * Sessions spread over the age bands, games from js/catalog.js (a built-in list when
 * the catalog is not next to this folder), devices, launch sources, difficulty tiers,
 * wins, losses and quits. The same seed always gives the same sessions and batch ids,
 * so a repeated run is de-duplicated and adds nothing: use another --seed for more.
 * Every batch is checked with server/schema.mjs before it is sent. Tests import
 * history() for the same --db batches without running the command.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { validateBatch } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;
const BUILD = '5c18c6d2d1c052ad';
const FALLBACK_GAMES = ['bubble-bop', 'road-hopper', 'neon-slope', 'tank-splat', 'block-burst', 'merge-2048', 'snake-arena',
  'hoop-heads', 'candy-rope', 'maze-dash', 'paint-grab', 'pizza-clicker'];

function parseArgs(args) {
  const options = { url: 'http://127.0.0.1:8787', sessions: null, seed: 1, db: '', days: 28 };
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, ''), value = args[++i];
    if (!Object.hasOwn(options, name) || value === undefined) throw new Error('usage: see the header of server/simulate.mjs');
    options[name] = ['sessions', 'seed', 'days'].includes(name) ? Number(value) : value;
    if (typeof options[name] === 'number' && !(Number.isInteger(options[name]) && options[name] >= 0)) throw new Error(`--${name} must be a whole number`);
  }
  options.sessions ??= options.db ? 120 : 300;
  return options;
}

// mulberry32: small, fast and the same everywhere.
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: p => next() < p,
    // Weighted pick from [[value, weight], ...].
    pick: table => {
      let x = next() * table.reduce((sum, [, w]) => sum + w, 0);
      for (const [value, w] of table) if ((x -= w) < 0) return value;
      return table[table.length - 1][0];
    },
    hex: n => { let out = ''; while (out.length < n) out += Math.floor(next() * 0x100000000).toString(16).padStart(8, '0'); return out.slice(0, n); }
  };
  return r;
}

const hashString = text => { let h = 2166136261; for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

function catalogSlugs() {
  try {
    const window = {};
    vm.runInNewContext(fs.readFileSync(path.join(HERE, '../js/catalog.js'), 'utf8'), { window });
    const slugs = window.GAMES.filter(g => !g.hidden).map(g => g.slug);
    return slugs.includes('bubble-bop') ? slugs : ['bubble-bop', ...slugs];
  } catch {
    return FALLBACK_GAMES;
  }
}

// Stable traits per game, derived from its slug.
function gameTraits(slug) {
  const r = random(hashString(slug));
  const starter = slug === 'bubble-bop';
  return {
    slug, starter,
    popularity: { '6-7': 0.3 + r.next() * (starter ? 3 : 1), '8-9': 0.3 + r.next(), '10-11': 0.2 + r.next() * 1.2, '': 0.5 },
    levels: starter ? ['w1-1', 'w1-2', 'w1-3', 'w2-1', 'w2-2', 'w2-3', 'party'] : r.chance(0.3) ? ['endless'] : Array.from({ length: r.int(4, 12) }, (_, i) => 'L' + (i + 1)),
    dda: starter || r.chance(0.5),
    winRate: starter ? 0.9 : 0.35 + r.next() * 0.4,
    roundSec: r.int(20, 90),
    loadMs: r.int(400, 1600),
    heavy: r.chance(0.25) // a 3D or busy game that strains slow PCs
  };
}

const BANDS = [['6-7', 30], ['8-9', 34], ['10-11', 30], ['', 6]];
const SKILL = { '6-7': 0.15, '8-9': 0.4, '10-11': 0.62, '': 0.38 };
const SOURCES = [['featured', 22], ['catalog', 30], ['recent', 18], ['favorites', 8], ['category', 6], ['quick', 3],
  ['search', 4], ['related', 5], ['surprise', 3], ['reload', 2], ['history', 1], ['direct', 2]];
const DEVICES = { cores: [[1, 2], [2, 25], [4, 50], [8, 20], [16, 3]], memory: [[0, 7], [1, 3], [2, 20], [4, 45], [8, 25]],
  screen: [[1366, 45], [1600, 10], [1920, 40], [2560, 5]] };
const RT = { '6-7': [1, 3, 6, 6, 4, 2], '8-9': [3, 6, 6, 3, 1, 1], '10-11': [6, 7, 4, 2, 1, 0], '': [3, 5, 5, 3, 2, 1] };

function spread(r, total, weights) {
  const out = weights.map(() => 0), sum = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < total; i++) {
    let x = r.next() * sum, k = 0;
    while ((x -= weights[k]) >= 0 && k < weights.length - 1) k++;
    out[k]++;
  }
  return out;
}

// One portal session as a list of batches (the sink sends one when a game closes).
function session(r, games) {
  const band = r.pick(BANDS), guest = r.chance(0.2), fresh = !guest && r.chance(0.12);
  const d = [r.pick(DEVICES.cores), r.pick(DEVICES.memory), r.pick(DEVICES.screen)];
  const slow = d[0] <= 2 || d[1] <= 2;
  const base = { v: 2, s: r.hex(12), k: BUILD, m: r.chance(0.15) ? 'app' : 'web', a: band, d };
  let level = guest ? 0 : fresh ? 1 : r.int(1, band === '6-7' ? 8 : 20);
  // A quarter of the sessions are still playing (or their tab died): the last game never closes.
  const batches = [], starts = new Map(), open = r.chance(0.25);
  let t = 0, engaged = 0, ev = [['ss', 0, fresh ? 1 : 0, fresh ? 0 : guest ? 0 : r.int(1, 3), guest ? 4 : fresh ? 4 : r.int(0, 3), level]];
  const flush = () => { if (ev.length) batches.push({ ...base, b: r.hex(16), ev }); ev = []; };
  for (let g = 0, n = r.int(1, 4); g < n; g++) {
    const game = fresh && g === 0 ? games.find(x => x.starter) || games[0] : r.pick(games.map(x => [x, x.popularity[band]]));
    t += r.int(2, 20);
    ev.push(['go', t, game.slug, fresh && g === 0 && game.starter ? 'starter' : r.pick(SOURCES), guest || fresh ? 0 : r.int(0, 4)]);
    if (r.chance(slow && game.heavy ? 0.06 : 0.015)) {
      t += 15;
      ev.push(['er', t, game.slug, r.pick([['t', 3], ['x', 1], ['l', 1]])], ['gx', t, game.slug, 0, [0, 0, 0, 0, 0, 0], [0, 0, 0, 0]]);
      flush();
      continue;
    }
    ev.push(['ld', t + 1, game.slug, Math.round(game.loadMs * (slow ? 1.9 : 1) * (0.7 + r.next() * 0.6))]);
    t += 2;
    let skill = Math.min(1, Math.max(0, SKILL[band] + (r.next() - 0.5) * 0.3)), at = 0, gameMs = 0, keys = 0;
    for (let round = 0, rounds = r.int(1, 8); round < rounds; round++) {
      const id = game.levels[Math.min(at, game.levels.length - 1)];
      const replay = starts.get(game.slug + id) || 0;
      starts.set(game.slug + id, replay + 1);
      const tier = game.dda ? 1 + Math.min(4, Math.floor(skill * 5)) : 0;
      ev.push(['rs', t, game.slug, id, tier, replay]);
      const ms = Math.round(game.roundSec * 1000 * (0.4 + r.next() * 1.2));
      const quit = r.chance(0.08 + (band === '6-7' ? 0.06 : 0) + (slow && game.heavy ? 0.08 : 0));
      const won = !quit && r.chance(Math.min(0.95, game.winRate + (skill - 0.4) * 0.5 - at * 0.02));
      const code = quit ? 'q' : id === 'endless' ? 'e' : won ? 'w' : 'l';
      const actions = Math.round(ms / 1000 * (0.4 + skill)), hits = Math.round(actions * (0.45 + skill * 0.5));
      t += Math.ceil(ms / 1000);
      ev.push(['re', t, game.slug, code, id, ms, code === 'q' ? -1 : r.int(0, 50) * 10, tier, hits, actions - hits, spread(r, hits, RT[band])]);
      if (won) at++;
      if (game.dda) skill = Math.min(1, Math.max(0, skill + (won ? 0.06 : -0.08)));
      gameMs += ms; keys += actions;
      if (!guest && r.chance(0.12)) ev.push(['lv', t, ++level]);
      if (ev.length > 150) flush();
    }
    const frames = Math.round(gameMs / 1000 * 58), strain = (slow ? 2.5 : 1) * (game.heavy ? 2 : 1);
    const f = spread(r, Math.min(frames, 4000), [100, 6 * strain, 1.5 * strain, 0.08 * strain]).map(x => Math.round(x * frames / Math.min(frames, 4000) || 0));
    t += r.int(1, 5);
    if (open && g === n - 1) break;
    ev.push(['gx', t, game.slug, gameMs, spread(r, keys, slow ? [30, 35, 20, 8, 5, 2] : [60, 28, 8, 2, 1, 1]), f]);
    engaged += gameMs;
    flush();
  }
  if (!open) ev.push(['se', t + r.int(5, 60), engaged]);
  flush();
  for (const batch of batches) {
    const valid = validateBatch(batch);
    if (!valid || valid.dropped) throw new Error('simulator produced an invalid batch');
  }
  return batches;
}

async function post(url, batch) {
  for (;;) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(batch) });
    if (res.status !== 429) return res.status;
    await new Promise(resolve => setTimeout(resolve, Number(res.headers.get('retry-after') || 1) * 1000));
  }
}

// The --db history: { batch, now } for --sessions per weekday (a sixth at the weekend)
// over the `days` UTC days that end with the day of `today` (ms). Each session starts
// between 07:00 and 14:59 UTC and its batches arrive 20 to 240 s apart, so no session
// crosses midnight. The same options always give the same batches and receipt times.
export function* history({ days = 28, sessions = 120, seed = 1, today = Date.now(), games = catalogSlugs() } = {}) {
  const traits = games.map(gameTraits), first = Math.floor(today / DAY_MS) * DAY_MS;
  for (let day = days - 1; day >= 0; day--) {
    const r = random(seed * 100003 + day);
    // Fewer children at the weekend, more mid-week.
    const weekday = new Date(first - day * DAY_MS).getUTCDay(), count = weekday % 6 ? sessions : Math.round(sessions / 6);
    for (let i = 0; i < count; i++) {
      let now = first - day * DAY_MS + r.int(7, 14) * 3600000 + r.int(0, 3599) * 1000;
      for (const batch of session(r, traits)) {
        yield { batch, now };
        now += r.int(20, 240) * 1000;
      }
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.db) {
    const { openDatabase } = await import('./sqlite-d1.mjs');
    const { openStore } = await import('./store.mjs');
    const store = openStore(openDatabase(options.db));
    let stored = 0, batches = 0;
    for (const { batch, now } of history(options)) {
      const { envelope, events } = validateBatch(batch);
      batches++;
      if (await store.ingest(envelope, events, now)) stored++;
    }
    store.close();
    console.log(`simulate: ${stored} of ${batches} batches stored in ${options.db} (${options.days} days, seed ${options.seed})`);
    return;
  }
  const r = random(options.seed), games = catalogSlugs().map(gameTraits);
  const url = options.url.replace(/\/+$/, '') + '/v1/batch';
  const sessions = Array.from({ length: options.sessions }, () => session(r, games));
  const statuses = {};
  // A few sessions at a time; each session's batches stay in order.
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < sessions.length) {
      for (const batch of sessions[next++]) {
        const status = await post(url, batch);
        statuses[status] = (statuses[status] || 0) + 1;
      }
    }
  }));
  console.log(`simulate: ${options.sessions} sessions posted to ${url} (seed ${options.seed}): ` +
    Object.entries(statuses).map(([status, n]) => `${n}× ${status}`).join(', '));
  if (Object.keys(statuses).some(status => status !== '204')) process.exitCode = 1;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) main().catch(error => { console.error('simulate: ' + error.message); process.exit(1); });
