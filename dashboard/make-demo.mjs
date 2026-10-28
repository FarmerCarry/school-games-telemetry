#!/usr/bin/env node
/*
 * Writes server/dashboard/demo/, the sample data behind /?demo:
 *
 *   node server/dashboard/make-demo.mjs
 *
 * server/simulate.mjs's school (wire version 3, Asia/Riyadh) plays 90 days into a
 * database in memory, the store rolls each night up as the cron would, and the real
 * Node server (server/app.mjs) answers every request the dashboard makes in demo mode:
 * the KPIs for each period and age group, "playing now", the settings, the students, the
 * research metrics, the cohorts, the PCs, three students' pages, six games' pages and one
 * morning of each research file. The files are those answers, unchanged, so they
 * always have the server's exact shapes; the clock is pinned (NOW), so the same code
 * always writes the same files, and tools/tests/dashboard-insights.test.mjs fails while
 * demo/ is not what this script writes. Nothing here is real.
 * (A development script: .assetsignore keeps it out of the deployed files.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
export const OUT = path.join(HERE, 'demo');

// "Now" in the sample: Tuesday 27 October 2026, 10:40 at the school (a lab period).
export const NOW = Date.parse('2026-10-27T07:40:00Z');
export const OPTIONS = { days: 90, sessions: 50, seed: 7 };
const ZONE = 'Asia/Riyadh';
const PERIODS = [1, 7, 30, 90];
const BANDS = ['all', '6-7', '8-9', '10-11'];
// The research metrics the dashboard's tabs ask for (app.js, habits.js, learning.js, students.js).
export const METRICS = ['hour', 'sesslen', 'daymin', 'games', 'flow', 'attempt', 'fatigue', 'persist'];
// The adaptive games always have a page; three more are the most opened of the last 30 days.
const DDA_GAMES = ['bubble-bop', 'dino-3d', 'road-hopper'];
const TOKEN = 'demo-admin-token-0123456789';
const DAY_MS = 86400000;
const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

// The sample: { 'kpis-30-all.json': text, ..., 'export-rounds.csv': text }. The JSON
// files are the answers as the server wrote them; each export file is the lines of its
// pages for today until NOW, without a header (the dashboard writes it).
export async function makeDemo({ now = NOW, days = OPTIONS.days, sessions = OPTIONS.sessions, seed = OPTIONS.seed } = {}) {
  const { hideSqliteWarning } = await import(path.join(SERVER, 'warnings.mjs'));
  hideSqliteWarning();
  const [{ openDatabase }, { openStore }, { createApp }, { schoolDays }, { validateBatch }, { localDay, dayBounds }, { FILES }] = await Promise.all(
    ['sqlite-d1.mjs', 'store.mjs', 'app.mjs', 'simulate.mjs', 'schema.mjs', 'clock.mjs', 'export.mjs'].map(f => import(path.join(SERVER, f))));
  const store = openStore(openDatabase(':memory:'));
  const today = localDay(ZONE, now);
  // As `node server/simulate.mjs --db` does, at a pinned clock: each day's batches as they
  // arrive, then the next night's 5-minute cron from 01:05 at the school until no day waits.
  for (const day of schoolDays({ days, sessions, seed, now })) {
    for (const { batch, now: at } of day.batches) await store.ingest(validateBatch(batch), at);
    if (day.day >= today) continue;
    for (let at = dayBounds(ZONE, day.day).hi * 1000 + 65 * 60000, i = 0; i < 40; i++, at += 5 * 60000) {
      if (!(await store.rollupStep(at)).rolled) break;
    }
  }
  const app = createApp({ store, adminToken: TOKEN, now: () => now });
  const out = {};
  try {
    const base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1')).port;
    const fetchOk = async route => {
      const res = await fetch(base + route, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (res.status !== 200) throw new Error(route + ': ' + res.status + ' ' + await res.text());
      return res;
    };
    const get = async (file, route) => {
      const text = await (await fetchOk(route)).text();
      out[file] = text.endsWith('\n') ? text : text + '\n';
      return JSON.parse(text);
    };
    const span = period => ({ from: addDays(today, 1 - period), to: today });
    const q = (period, extra = '') => `from=${span(period).from}&to=${span(period).to}${extra}`;
    // The settings first: the page reads them before anything else.
    await get('settings.json', '/v1/admin/settings');
    await get('live.json', '/v1/admin/live');
    let kpis30 = null, students30 = null;
    for (const period of PERIODS) {
      for (const band of BANDS) {
        const k = await get(`kpis-${period}-${band}.json`, '/v1/admin/kpis?' + q(period, band === 'all' ? '' : '&band=' + band));
        if (period === 30 && band === 'all') kpis30 = k;
      }
      const s = await get(`students-${period}.json`, '/v1/admin/students?' + q(period));
      if (period === 30) students30 = s;
      await get(`stats-${period}.json`, '/v1/admin/stats?' + q(period, '&metrics=' + METRICS.join(',')));
    }
    await get('cohorts-90.json', '/v1/admin/cohorts?' + q(90));
    await get('pcs-30.json', '/v1/admin/pcs?' + q(30));
    // Three students: the one with the most play who has a linked code (a child who
    // plays on two PCs), the one with the most play of an adaptive game, and the one with
    // the most play left.
    const list = students30.students.slice().sort((a, b) => b.minutes - a.minutes || (a.u < b.u ? -1 : 1));
    const chosen = [];
    for (const test of [s => s.linked.length > 0, s => s.top.some(slug => DDA_GAMES.includes(slug)), () => true]) {
      const s = list.find(x => test(x) && !chosen.includes(x.u));
      if (s) chosen.push(s.u);
    }
    for (const u of chosen) await get(`student-${u}.json`, `/v1/admin/student?u=${u}&` + q(30));
    const others = kpis30.games.filter(g => !DDA_GAMES.includes(g.slug)).sort((a, b) => b.opens - a.opens || (a.slug < b.slug ? -1 : 1));
    for (const slug of [...DDA_GAMES, ...others.slice(0, 3).map(g => g.slug)]) await get(`game-${slug}.json`, `/v1/admin/game?slug=${slug}&` + q(30));
    // Today's play so far in each research file, every page of it.
    for (const file of FILES) {
      let text = '', after = null;
      do {
        const res = await fetchOk(`/v1/admin/export?file=${file}&` + q(1) + (after ? '&after=' + encodeURIComponent(after) : ''));
        text += await res.text();
        after = res.headers.get('x-next');
      } while (after);
      out[`export-${file}.csv`] = text;
    }
  } finally {
    await app.close();
    store.close();
  }
  return Object.fromEntries(Object.keys(out).sort().map(file => [file, out[file]]));
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  const files = await makeDemo();
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT);
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(OUT, file), text);
  const size = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  console.log(`make-demo: wrote ${Object.keys(files).length} files to ${path.relative(process.cwd(), OUT)} (${Math.round(size / 1024)} KB)`);
}
