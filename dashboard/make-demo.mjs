#!/usr/bin/env node
/*
 * Writes server/dashboard/demo.json, the sample data behind /?demo:
 *
 *   node server/dashboard/make-demo.mjs [--seed 7]
 *
 * server/simulate.mjs fills a temporary database with 90 days of synthetic
 * sessions, a few more are posted "now" so the live view has something, and the
 * real Node server (server/app.mjs) answers /v1/admin/kpis for every period and
 * age filter of the dashboard and /v1/admin/live. demo.json is those answers,
 * unchanged, so it always has the server's exact shapes. Nothing here is real.
 * (A development script: .assetsignore keeps it out of the deployed files.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..');
const PERIODS = [1, 7, 30, 90];
const BANDS = ['all', '6-7', '8-9', '10-11'];
const TOKEN = 'demo-admin-token-0123456789';
const DAY_MS = 86400000;

const seedArg = process.argv.indexOf('--seed');
const seed = seedArg > 0 ? Number(process.argv[seedArg + 1]) : 7;
if (!Number.isInteger(seed) || seed < 0) throw new Error('--seed must be a whole number');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SERVER, 'simulate.mjs'), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('simulate.mjs exited with ' + code)));
  });
}

const { hideSqliteWarning } = await import(path.join(SERVER, 'warnings.mjs'));
hideSqliteWarning();
const { createApp } = await import(path.join(SERVER, 'app.mjs'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-dashboard-demo-'));
const dbPath = path.join(dir, 'demo.db');
let app;
try {
  await run(['--db', dbPath, '--days', '90', '--sessions', '80', '--seed', String(seed)]);
  app = createApp({ dbPath, adminToken: TOKEN });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + port;
  await run(['--url', base, '--sessions', '24', '--seed', String(seed + 1)]);
  const get = async route => {
    const res = await fetch(base + route, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (res.status !== 200) throw new Error(route + ': ' + res.status);
    return res.json();
  };
  const today = new Date().toISOString().slice(0, 10);
  const kpis = {};
  for (const period of PERIODS) {
    const from = new Date(Date.parse(today + 'T00:00:00Z') - (period - 1) * DAY_MS).toISOString().slice(0, 10);
    for (const band of BANDS) {
      kpis[period + '|' + band] = await get(`/v1/admin/kpis?from=${from}&to=${today}` + (band === 'all' ? '' : '&band=' + band));
    }
  }
  const demo = { v: 1, sample: true, made: today, kpis, live: await get('/v1/admin/live') };
  const out = path.join(HERE, 'demo.json');
  fs.writeFileSync(out, JSON.stringify(demo) + '\n');
  console.log(`make-demo: wrote ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB, seed ${seed})`);
} finally {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
