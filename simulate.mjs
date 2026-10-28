#!/usr/bin/env node
/*
 * Deterministic synthetic telemetry for dashboard development, demos and tests: one school
 * in Asia/Riyadh, sending wire version 3 at the portal sink's real cadence
 * (docs/RESEARCH_TELEMETRY_SPEC.md, §F.7).
 *
 *   node server/simulate.mjs [--url http://127.0.0.1:8787] [--sessions 300] [--seed 1]
 *       posts that many sessions of children playing in the last half hour to a running
 *       server (each batch's w is taken when it is sent).
 *   node server/simulate.mjs --db server/data/dev.db [--days 28] [--sessions 120] [--seed 1]
 *       writes the last --days days straight into a database file (stop the server first
 *       or use another file), --sessions per school day, and runs the store's own 5-minute
 *       rollups (rollupStep) after each day, as the cron would.
 *
 * The school: 600 children in 24 classes (8 per age band, a few without a band) and a lab
 * of 30 PCs, Sunday to Thursday, 07:30 to 13:30, one class per lab slot (six a day, or more
 * on a busy day; each slot's class from the next age band), with the classroom timer in half
 * the slots. Each child keeps a profile (a random code) on the PC they sit at, with their
 * own skill and taste; 5% also play on a second PC, and half of those had the two codes
 * joined by a teacher (the cd event). About a fifth of the sessions are guests; three PCs
 * still run the old portal (wire version 2); one PC forgets its profiles and its code every
 * night; two PCs fill up to 24 profiles. Games come from js/catalog.js (a built-in list
 * when the catalog is not next to this folder): the 3 DDA games adapt their tier, local
 * two-player games have duo rounds, 25 games show a tutorial, and the games without a
 * score send none. Skill rises with log(attempt), faster for older children; children
 * tire after 20 minutes; how often a child retries after a loss depends on the game.
 * Batches go out as the sink sends them: 60 seconds after the first waiting event (20 for
 * the old portal), at every game close and at the session's end; a few PCs are offline for
 * a while and deliver late. The same seed always gives the same batches, so a repeated run
 * adds nothing. Every batch is checked with server/schema.mjs.
 *
 * Tests import history() (the v3 school's batches) and historyV2() (milestone 2's
 * generator: v2 batches only, one per game close, kept for the comparisons with
 * milestone 2's store).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { MAX_EVENTS, validateBatch } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400000;
const BUILD = '5c18c6d2d1c052ad', OLD_BUILD = '0e3f2b9a7c41d258';
const ZONE = 'Asia/Riyadh', OFFSET_MS = 3 * 3600000;
const FALLBACK_GAMES = ['bubble-bop', 'road-hopper', 'dino-3d', 'neon-slope', 'tank-splat', 'block-burst', 'merge-2048', 'snake-arena',
  'hoop-heads', 'candy-rope', 'maze-dash', 'paint-grab', 'pizza-clicker', 'air-hockey', 'tic-tac-toe'];

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

/* ------------------------------------------------------- milestone 2 (v2) */
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

// One portal session of milestone 2 as a list of v2 batches (one at each game close).
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

// Milestone 2's --db history: { batch, now } for `sessions` per weekday (a sixth at the
// weekend) over the `days` UTC days that end with the day of `today` (ms). Each session
// starts between 07:00 and 14:59 UTC and its batches arrive 20 to 240 s apart, so no
// session crosses midnight. Only v2 batches, as milestone 2's store takes them.
export function* historyV2({ days = 28, sessions = 120, seed = 1, today = Date.now(), games = catalogSlugs() } = {}) {
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

/* --------------------------------------------------------- the v3 school */
const DDA_GAMES = new Set(['bubble-bop', 'dino-3d', 'road-hopper']);
const DUO_GAMES = new Set(['air-hockey', 'hoop-heads', 'wacky-soccer', 'sumo-bonk', 'pool-party', 'fire-and-ice', 'connect-four', 'tic-tac-toe']);
const NO_SCORE = new Set(['block-world', 'connect-four', 'critter-mart', 'pizza-clicker', 'tank-splat', 'tic-tac-toe']);
const NO_FRAMES = new Set(['connect-four', 'tic-tac-toe', 'typing-test']);
const CHILDREN = 600, CLASS_SIZE = 25, CLASSES = CHILDREN / CLASS_SIZE, PCS = 30, MAX_PROFILES = 24, PERIODS = 6;
// PCs 26 to 28 still run the old portal; 29 forgets everything each night; the second PCs
// of the children who play on two are 5 and 6, which fill up.
const OLD_PCS = new Set([26, 27, 28]), FORGETFUL_PC = 29, SECOND_PCS = [5, 6];
// Skill by age band: the chance to win a first try, and how much it rises with log(attempt).
const LEARNING = { '6-7': [0.3, 0.1], '8-9': [0.38, 0.13], '10-11': [0.45, 0.16], '': [0.38, 0.12] };
const WHY = [['h', 55], ['u', 20], ['p', 15], ['i', 10]];
const ERRORS = [['t', 3], ['x', 1], ['l', 1]];

// Whether a game shows a tutorial (it calls Kit.stats.tutorial), from its files when the
// games are next to this folder.
function hasTutorial(slug) {
  try {
    const dir = path.join(HERE, '../games', slug);
    return fs.readdirSync(dir).some(name => /\.(?:js|html)$/.test(name) && /\bstats\.tutorial\b|\btutorial\s*\(/.test(fs.readFileSync(path.join(dir, name), 'utf8')));
  } catch {
    return hashString(slug) % 10 < 7;
  }
}

// Games of the v3 school: popularity per band, levels, round length, how often a child
// retries after a loss, and what the game reports.
function schoolGame(slug) {
  const r = random(hashString('v3 ' + slug)), g = gameTraits(slug);
  return {
    slug, starter: g.starter, popularity: g.popularity, roundSec: g.roundSec, loadMs: g.loadMs, heavy: g.heavy,
    levels: DUO_GAMES.has(slug) ? ['cpu', 'L1', 'L2', 'L3'] : g.levels, dda: DDA_GAMES.has(slug), duo: DUO_GAMES.has(slug),
    score: !NO_SCORE.has(slug), frames: !NO_FRAMES.has(slug), tutorial: hasTutorial(slug), persist: 0.35 + r.next() * 0.5,
    hard: 0.005 + r.next() * 0.01
  };
}

// The children and PCs, the same for a seed.
function makeSchool(seed, slugs) {
  const r = random(seed * 7919 + 17), games = slugs.map(schoolGame);
  const pcs = Array.from({ length: PCS }, (_, i) => ({
    i, code: r.hex(12), d: [r.pick(DEVICES.cores), r.pick(DEVICES.memory), r.pick(DEVICES.screen)], m: r.chance(0.15) ? 'app' : 'web',
    wire: OLD_PCS.has(i) ? 2 : 3, profiles: new Map(), favs: new Map(), forgets: i === FORGETFUL_PC, offline: 0
  }));
  const children = Array.from({ length: CHILDREN }, (_, i) => {
    const cls = Math.floor(i / CLASS_SIZE), seat = i % CLASS_SIZE;
    const band = r.chance(0.04) ? '' : ['6-7', '8-9', '10-11'][Math.floor(cls / (CLASSES / 3))];
    const second = r.chance(0.05) ? SECOND_PCS[i % 2] : null;
    return {
      i, cls, band, home: (seat + cls) % PCS, second, linked: second !== null && r.chance(0.5), skill: (r.next() - 0.5) * 0.24,
      taste: Object.fromEntries(games.map(g => [g.slug, g.popularity[band] * (0.3 + r.next() * 1.4) ** 3])), sessions: 0,
      // Most children already had a profile when the server first sees them.
      madeBefore: r.chance(0.6) ? r.int(10, 200) : null, attempts: new Map(), tiers: new Map()
    };
  });
  return { games, pcs, children };
}

const localDay = ms => new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
const dayStart = day => Date.parse(day + 'T00:00:00Z') - OFFSET_MS;
const daysApart = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

// A child's profile on a PC: its code, the day it was made, its level and history there.
function profileOf(school, r, child, pc, day) {
  let p = pc.profiles.get(child.i);
  if (!p) {
    if (pc.profiles.size >= MAX_PROFILES) return null;
    const before = !pc.forgets && pc.i === child.home ? child.madeBefore : null;
    p = { code: r.hex(12), made: before ? localDay(dayStart(day) - before * DAY_MS) : day, fresh: !before, level: before ? r.int(2, 12) : 1,
      last: before ? localDay(dayStart(day) - r.int(1, 30) * DAY_MS) : null, plays: new Map(), favs: new Set(), sessions: 0, pending: null };
    // A profile made before brings the games it played then.
    if (before) for (const g of school.games) if (r.chance(0.4)) p.plays.set(g.slug, r.int(1, 15));
    pc.profiles.set(child.i, p);
  }
  // The teacher joined this second PC's code to the child's home code after a session here.
  if (child.linked && pc.i === child.second && p.sessions >= 1 && !p.joined) {
    const home = school.pcs[child.home].profiles.get(child.i);
    if (home && home.code !== p.code) { p.pending = p.code; p.code = home.code; p.joined = true; }
  }
  return p;
}

// The events of one session that starts at startMs and may last until endMs, in a neutral
// form ({ t, kind, ... }) rendered as v2 or v3 later. timer: the classroom timer's minutes
// (0: none).
function play(school, r, child, pc, startMs, endMs, timer, day) {
  const game = slug => school.games.find(g => g.slug === slug);
  // The PC that forgets everything starts each day with a new code and no profiles.
  if (pc.forgets && pc.day !== day) { pc.day = day; pc.code = r.hex(12); pc.profiles.clear(); }
  // Some children play as guests (or must: the PC already has 24 profiles).
  const profile = r.chance(0.15) ? null : profileOf(school, r, child, pc, day), guest = !profile;
  const old = pc.wire === 2, events = [], slow = pc.d[0] <= 2 || pc.d[1] <= 2;
  const level = profile ? profile.level : 0, np = pc.profiles.size;
  const fresh = !!profile?.fresh && profile.sessions === 0;
  const age = profile ? Math.max(0, daysApart(profile.made, day)) : -1;
  const since = profile && profile.last && !fresh ? Math.max(0, daysApart(profile.last, day)) : -1;
  events.push({ t: 0, kind: 'ss', isNew: fresh ? 1 : 0, age, since, level, np, cls: 1 });
  if (profile?.pending) { events.push({ t: 0, kind: 'cd', code: profile.pending }); profile.pending = null; }
  // Rarely, a profile of another child was removed on this PC.
  if (!old && !pc.forgets && r.chance(0.004)) {
    const other = [...pc.profiles].find(([i]) => i !== child.i);
    if (other) { events.push({ t: 0, kind: 'pr', code: other[1].code }); pc.profiles.delete(other[0]); }
  }
  if (timer) events.push({ t: 1, kind: 'ct', what: 's', minutes: timer });
  // A child plays 5 to 14 minutes, or (with the classroom timer, most often) until their turn runs out.
  const playFor = timer && r.chance(0.6) ? timer * 60 + 30 : r.int(5, 14) * 60;
  const limit = Math.min(Math.floor((endMs - startMs) / 1000), playFor), timerEnd = timer ? timer * 60 : Infinity;
  let t = 1, n = 0, engaged = 0, lastSlug = null, plays = profile ? profile.plays : new Map();
  while (t < Math.min(limit, timerEnd) - 30) {
    const g = game(r.pick(school.games.filter(x => x.slug !== lastSlug).map(x => [x.slug, child.taste[x.slug]])));
    lastSlug = g.slug;
    t += r.int(3, 25);
    const v = { n: ++n, slug: g.slug, rounds: [], ms: 0 };
    const before = plays.get(g.slug) || 0, fav = profile ? (profile.favs.has(g.slug) ? 1 : 0) : 0;
    events.push({ t, kind: 'go', n: v.n, slug: g.slug, src: g.starter && fresh && n === 1 ? 'starter' : r.pick(SOURCES), plays: before, fav });
    plays.set(g.slug, before + 1);
    if (r.chance(slow && g.heavy ? 0.05 : 0.01)) {
      t += 15;
      events.push({ t, kind: 'er', n: v.n, slug: g.slug, err: r.pick(ERRORS) }, { t, kind: 'gx', n: v.n, slug: g.slug, ms: 0, il: [0, 0, 0, 0, 0, 0], f: [0, 0, 0, 0] });
      continue;
    }
    events.push({ t: t + 1, kind: 'ld', n: v.n, slug: g.slug, ms: Math.round(g.loadMs * (slow ? 1.9 : 1) * (0.7 + r.next() * 0.6)) });
    t += 2;
    if (g.tutorial && before === 0 && profile) events.push({ t, kind: 'tu', n: v.n, slug: g.slug, step: 's' });
    let at = 0, k = 0, lost = 0, keys = 0, leave = false;
    const patience = r.int(3, 9);
    const key = child.i + ' ' + g.slug;
    while (!leave && t < Math.min(limit, timerEnd) - 10) {
      const duo = g.duo && r.chance(0.35), id = duo ? 'local' : g.levels[Math.min(at, g.levels.length - 1)];
      const tier = g.dda ? child.tiers.get(key) || 1 : 0, attempt = (child.attempts.get(key) || 0) + 1, minutes = t / 60;
      const replay = v.rounds.filter(x => x === id).length;
      v.rounds.push(id);
      events.push({ t, kind: 'rs', n: v.n, k: ++k, slug: g.slug, id, tier, replay, visit: v });
      const ms = Math.round(g.roundSec * 1000 * (0.5 + r.next()) * (child.band === '6-7' ? 1.15 : 1));
      const [base, slope] = LEARNING[child.band], tired = Math.max(0, minutes - 20) * 0.012;
      const p = Math.min(0.95, Math.max(0.05, base + slope * Math.log(attempt) + child.skill - g.hard * at - tired - (g.dda ? 0.09 * (tier - 1) - 0.3 : 0)));
      const quit = !duo && r.chance(0.05 + 0.04 * lost + (child.band === '6-7' ? 0.03 : 0) + (slow && g.heavy ? 0.05 : 0));
      const won = !quit && r.chance(duo ? 0.5 : p);
      const code = quit ? 'q' : duo ? r.pick([['w', 45], ['l', 45], ['d', 10]]) : id === 'endless' ? 'e' : won ? 'w' : 'l';
      const actions = Math.round(ms / 1000 * (0.6 + p) * (1 - tired)), hits = g.dda ? Math.round(actions * (0.4 + p * 0.5)) : 0;
      const misses = g.dda ? actions - hits : 0, rts = g.dda ? spread(r, hits, RT[child.band]) : [0, 0, 0, 0, 0, 0];
      const rtSum = rts.reduce((sum, c, i) => sum + c * [220, 400, 650, 1000, 1600, 2400][i], 0) * (1 + tired);
      t += Math.ceil(ms / 1000);
      // Old Kit builds of a game send no round extras (x null).
      const x = r.chance(0.04) ? null : [Math.round(ms * 1.06), actions, r.int(0, 2), r.chance(0.1) ? 1 : 0, Math.round(rtSum), hits,
        g.dda ? Math.min(1000, Math.round(tier * 180 + r.int(0, 80))) : -1];
      events.push({ t, kind: 're', n: v.n, k, slug: g.slug, code, id, ms, score: g.score && code !== 'q' ? r.int(1, 60) * 10 : -1, tier, hits, misses, rt: rts, x,
        visit: v });
      if (!duo) child.attempts.set(key, attempt);
      v.ms += ms; engaged += ms; keys += actions;
      v.ends = (v.ends || []).concat([[t, v.ms]]);
      if (k === 1 && g.tutorial && before === 0 && profile && r.chance(0.85)) events.push({ t, kind: 'tu', n: v.n, slug: g.slug, step: 'd' });
      if (g.dda && !duo) child.tiers.set(key, Math.max(1, Math.min(5, tier + (won ? (r.chance(0.5) ? 1 : 0) : -1))));
      if (code === 'w') { at++; lost = 0; } else if (code === 'l') lost++;
      if (profile && r.chance(0.1)) events.push({ t, kind: 'lv', level: ++profile.level });
      if (profile && r.chance(0.02)) {
        const on = profile.favs.has(g.slug) ? 0 : 1;
        if (on) profile.favs.add(g.slug); else profile.favs.delete(g.slug);
        events.push({ t, kind: 'fv', n: v.n, slug: g.slug, on });
      }
      leave = code === 'q' || k >= patience || (code === 'l' ? !r.chance(0.5 + g.persist / 2) : r.chance(0.05));
      t += r.int(1, 4);
    }
    const frames = Math.round(v.ms / 1000 * 58), strain = (slow ? 2.5 : 1) * (g.heavy ? 2 : 1);
    const f = g.frames ? spread(r, Math.min(frames, 3000), [100, 6 * strain, 1.5 * strain, 0.08 * strain]).map(c => Math.round(c * frames / Math.min(frames, 3000) || 0)) : [0, 0, 0, 0];
    t += r.int(1, 3);
    events.push({ t, kind: 'gx', n: v.n, slug: g.slug, ms: v.ms, il: spread(r, keys, slow ? [30, 35, 20, 8, 5, 2] : [60, 28, 8, 2, 1, 1]), f });
  }
  // The end: the timer ran out (the hand-over overlay), the slot ended, the child left the
  // PC idle (the portal hands over after 20 minutes), or the page died with nothing sent.
  if (timer && timerEnd <= limit) events.push({ t: timerEnd, kind: 'ct', what: 'e', minutes: 0 });
  events.sort((a, b) => a.t - b.t);
  if (r.chance(0.02)) {
    // The page died in the last round: it never ended and its game never closed.
    const lastStart = events.findLastIndex(e => e.kind === 'rs');
    if (lastStart >= 0) events.splice(lastStart + 1);
  } else {
    const why = timer && timerEnd <= limit ? 'h' : r.pick(WHY);
    events.push({ t: Math.max(t, timer && timerEnd <= limit ? timerEnd : 0) + (why === 'i' ? 1200 : r.int(2, 20)), kind: 'se', ms: engaged, why });
  }
  if (profile) { profile.sessions++; profile.last = day; }
  return { events, profile, guest, old };
}

// The event in its wire form (v3, or v2 for the old portal: no visit or round numbers and
// no kinds it did not have).
function render(e, old) {
  if (old) {
    switch (e.kind) {
      case 'ss': return ['ss', e.t, e.isNew, e.age < 1 ? 0 : e.age < 7 ? 1 : e.age < 30 ? 2 : 3, e.since < 0 ? 4 : e.since < 1 ? 0 : e.since < 2 ? 1 : e.since < 7 ? 2 : 3, e.level];
      case 'go': return ['go', e.t, e.slug, e.src, e.plays < 2 ? e.plays : e.plays < 5 ? 2 : e.plays < 10 ? 3 : 4];
      case 'ld': return ['ld', e.t, e.slug, e.ms];
      case 'er': return ['er', e.t, e.slug, e.err];
      case 'rs': return ['rs', e.t, e.slug, e.id, e.tier, e.replay];
      case 're': return ['re', e.t, e.slug, e.code, e.id, e.ms, e.score, e.tier, e.hits, e.misses, e.rt];
      case 'gx': return ['gx', e.t, e.slug, e.ms, e.il, e.f];
      case 'lv': return ['lv', e.t, e.level];
      case 'se': return ['se', e.t, e.ms];
      default: return null;
    }
  }
  switch (e.kind) {
    case 'ss': return ['ss', e.t, e.isNew, e.age, e.since, e.level, e.np, e.cls];
    case 'go': return ['go', e.t, e.n, e.slug, e.src, e.plays, e.fav];
    case 'ld': return ['ld', e.t, e.n, e.slug, e.ms];
    case 'er': return ['er', e.t, e.n, e.slug, e.err];
    case 'rs': return ['rs', e.t, e.n, e.k, e.slug, e.id, e.tier, e.replay];
    case 're': return ['re', e.t, e.n, e.k, e.slug, e.code, e.id, e.ms, e.score, e.tier, e.hits, e.misses, e.rt, e.x];
    case 'gp': return ['gp', e.t, e.n, e.slug, e.ms];
    case 'gx': return ['gx', e.t, e.n, e.slug, e.ms, e.il, e.f];
    case 'tu': return ['tu', e.t, e.n, e.slug, e.step];
    case 'fv': return ['fv', e.t, e.n, e.slug, e.on];
    case 'ct': return ['ct', e.t, e.what, e.minutes];
    case 'lv': return ['lv', e.t, e.level];
    case 'pr': return ['pr', e.t, e.code];
    case 'cd': return ['cd', e.t, e.code];
    case 'se': return ['se', e.t, e.ms, e.why];
  }
  return null;
}

// The sink's sends: a batch 'every' seconds after the first event waiting (60, or 20 for
// the old portal), right away at a game close and at the session's end; a timed send also
// reports the open game's engaged time so far (gp) when it moved. Answers [{ at, ev }].
function sends(events, every, old) {
  const out = [];
  let pending = [], due = null, open = null, reported = -1;
  const seal = at => {
    if (!pending.length) return;
    if (!old && open) {
      const ms = (open.ends || []).filter(([t]) => t <= at).reduce((_, [, total]) => total, 0);
      if (ms > 0 && ms !== reported) { pending.push({ t: at, kind: 'gp', n: open.n, slug: open.slug, ms }); reported = ms; }
    }
    out.push({ at, ev: pending });
    pending = [];
    due = null;
  };
  for (const e of events) {
    if (due !== null && e.t >= due) seal(due);
    if (e.kind === 'go') { open = null; reported = -1; }
    pending.push(e);
    due ??= e.t + every;
    if (e.kind === 'gx' || e.kind === 'se') { if (e.kind === 'gx') { open = null; reported = -1; } seal(e.t); }
    else if (e.kind === 'rs' || e.kind === 're') open = e.visit || open;
  }
  seal(due);
  return out;
}

// The batches of one session: envelopes for each send (at most MAX_EVENTS events each),
// with the time each arrives (late when the PC was offline) and w, the seconds from the
// session's start to the send.
function batchesOf(r, school, child, pc, startMs, played) {
  const { events, profile, old } = played, out = [];
  // Offline: from a point in the session, sends wait until the PC is back (hours or days later).
  const offline = r.chance(0.02) ? { from: r.int(0, 600), back: startMs + r.int(3, 50) * 3600000 } : null;
  const base = old ? { v: 2, s: r.hex(12), k: OLD_BUILD, m: pc.m, a: child.band, d: pc.d }
    : { v: 3, s: r.hex(12), k: BUILD, m: pc.m, a: child.band, d: pc.d, u: profile ? profile.code : '', p: pc.code, z: ZONE };
  for (const { at, ev } of sends(events, old ? 20 : 60, old)) {
    const wire = ev.map(e => render(e, old)).filter(Boolean);
    for (let i = 0; i < wire.length; i += MAX_EVENTS) {
      let now = startMs + at * 1000 + r.int(50, 1500);
      if (offline && at >= offline.from) now = Math.max(now, offline.back + r.int(0, 600) * 1000);
      const batch = { ...base, b: r.hex(16), ev: wire.slice(i, i + MAX_EVENTS) };
      if (!old) batch.w = Math.min(691200, Math.max(0, Math.round((now - startMs) / 1000)));
      out.push({ batch, now, startMs });
    }
  }
  return out;
}

const check = batch => {
  const valid = validateBatch(batch);
  if (!valid || valid.dropped) throw new Error('simulator produced an invalid batch: ' + JSON.stringify(batch).slice(0, 200));
};

// The lab's timetable: one class per slot, each slot's class from the next age band.
const TIMETABLE = Array.from({ length: CLASSES }, (_, j) => (j % 3) * (CLASSES / 3) + Math.floor(j / 3));

// One school day: its lab slots (the day's six periods, or more and shorter ones on a busy
// day), each with one class at the PCs, `sessions` in all, shared out between the slots.
function schoolDay(school, r, day, dayIndex, sessions) {
  const slots = Math.max(PERIODS, Math.ceil(sessions / CLASS_SIZE)), slotMs = Math.floor(360 / slots) * 60000;
  const out = [];
  let left = sessions;
  for (let s = 0; s < slots && left > 0; s++) {
    const start = dayStart(day) + (7 * 60 + 30) * 60000 + s * slotMs, end = start + Math.min(slotMs, 45 * 60000) - 3 * 60000;
    // Half the slots use the classroom timer: each child's turn lasts 10 to 20 minutes.
    const cls = TIMETABLE[(dayIndex * slots + s) % CLASSES], timer = r.chance(0.5) ? Math.min(r.int(10, 20), Math.floor((end - start) / 60000)) : 0;
    const kids = school.children.filter(c => c.cls === cls).filter(() => r.chance(0.92)).slice(0, Math.ceil(left / (slots - s)));
    for (const child of kids) {
      // A child with two PCs takes turns: the second one first.
      const pc = school.pcs[child.second !== null && child.sessions++ % 2 === 0 ? child.second : child.home];
      const startMs = start + r.int(0, 180) * 1000 + r.int(0, 999);
      const played = play(school, r, child, pc, startMs, end, timer, day);
      out.push(...batchesOf(r, school, child, pc, startMs, played));
    }
    left -= kids.length;
  }
  return out;
}

// The --db history: per school day (oldest first, the last one being the school's day of
// `now`), the batches that arrive that day in the order they arrive: { day, batches: [{
// batch, now }] }; batches held offline arrive on a later day. Only school days that have
// begun by `now` are played, and only sessions that started by then.
export function* schoolDays({ days = 28, sessions = 120, seed = 1, now = Date.now(), games = catalogSlugs() } = {}) {
  const school = makeSchool(seed, games), today = localDay(now);
  let late = [], dayIndex = 0;
  for (let d = days - 1; d >= 0; d--) {
    const day = localDay(dayStart(today) - d * DAY_MS), weekday = new Date(day + 'T00:00:00Z').getUTCDay();
    const r = random(seed * 100003 + Date.parse(day) / DAY_MS);
    let batches = weekday <= 4 ? schoolDay(school, r, day, dayIndex++, sessions).filter(b => b.startMs <= now) : [];
    const end = dayStart(day) + DAY_MS;
    batches = [...batches, ...late].filter(b => b.now <= now);
    late = batches.filter(b => b.now >= end);
    batches = batches.filter(b => b.now < end).sort((a, b) => a.now - b.now);
    for (const { batch } of batches) check(batch);
    yield { day, batches: batches.map(({ batch, now: at }) => ({ batch, now: at })) };
  }
}
// The same batches as one list, in the order they arrive.
export function* history(options = {}) {
  for (const { batches } of schoolDays(options)) yield* batches;
}

// Children playing now: `sessions` sessions that began in the last half hour, cut at now
// (their open game is still open). Answers sessions as lists of { batch, startMs }; w is
// set when each batch is sent.
function playingNow({ sessions, seed, now = Date.now(), games = catalogSlugs() }) {
  const school = makeSchool(seed, games), r = random(seed * 31337), day = localDay(now), out = [];
  for (let i = 0; i < sessions; i++) {
    // Children of each age band in turn (a band's classes hold a third of the children).
    const child = school.children[(i % 3) * (CHILDREN / 3) + r.int(0, CHILDREN / 3 - 1)], pc = school.pcs[child.home];
    const startMs = now - r.int(5, 30) * 60000;
    const played = play(school, r, child, pc, startMs, startMs + 45 * 60000, 0, day);
    const cut = Math.floor((now - startMs) / 1000);
    played.events = played.events.filter(e => e.t <= cut);
    out.push(batchesOf(r, school, child, pc, startMs, played).map(({ batch }) => ({ batch, startMs })));
  }
  return out;
}

async function post(url, batch) {
  for (;;) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(batch) });
    if (res.status !== 429 && res.status !== 503) return res.status;
    await new Promise(resolve => setTimeout(resolve, Number(res.headers.get('retry-after') || 1) * 1000));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.db) {
    const { openDatabase } = await import('./sqlite-d1.mjs');
    const { openStore } = await import('./store.mjs');
    const store = openStore(openDatabase(options.db)), today = localDay(Date.now());
    let stored = 0, batches = 0, rolled = 0;
    for (const day of schoolDays(options)) {
      for (const { batch, now } of day.batches) {
        batches++;
        if (await store.ingest(validateBatch(batch), now)) stored++;
      }
      // The 5-minute cron of the next night, from 01:05 at the school, until no day waits.
      if (day.day < today) {
        for (let at = dayStart(day.day) + DAY_MS + 65 * 60000, i = 0; i < 40; i++, at += 5 * 60000) {
          if (!(await store.rollupStep(at)).rolled) break;
          rolled++;
        }
      }
    }
    store.close();
    console.log(`simulate: ${stored} of ${batches} batches stored in ${options.db} (${options.days} days, seed ${options.seed}, ${rolled} days rolled up)`);
    return;
  }
  const url = options.url.replace(/\/+$/, '') + '/v1/batch';
  const sessions = playingNow(options), statuses = {};
  // A few sessions at a time; each session's batches stay in order, each dated when sent.
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < sessions.length) {
      for (const { batch, startMs } of sessions[next++]) {
        if (batch.v === 3) batch.w = Math.min(691200, Math.round((Date.now() - startMs) / 1000));
        check(batch);
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
