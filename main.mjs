#!/usr/bin/env node
// Starts the ingest server on Node from environment variables (see server/README.md):
//   PORT=8787 DB_PATH=/data/telemetry.db ALLOWED_ORIGINS=https://name.github.io \
//   ADMIN_TOKEN=... node server/main.mjs
// The dashboard is served at / from server/dashboard/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hideSqliteWarning } from './warnings.mjs';
import { isAdminToken, parseOrigins } from './handler.mjs';

// Before node:sqlite loads: the server modules are imported dynamically below.
hideSqliteWarning();

function fail(message) {
  console.error('telemetry: ' + message);
  process.exit(1);
}

function whole(name, fallback, min, max = Infinity) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    fail(`${name} must be a whole number ${max < Infinity ? `from ${min} to ${max}` : `of at least ${min}`}`);
  }
  return Number(raw);
}

function origins(raw = '') {
  const { origins: list, invalid } = parseOrigins(raw);
  if (invalid.length) fail(`ALLOWED_ORIGINS entry "${invalid[0]}" is not an origin such as https://name.github.io (no path, no trailing slash)`);
  return list;
}

const env = process.env;
const adminToken = env.ADMIN_TOKEN || '';
if (adminToken && !isAdminToken(adminToken)) fail('ADMIN_TOKEN must be at least 16 printable ASCII characters without spaces');
const config = {
  port: whole('PORT', 8787, 0, 65535),
  host: env.HOST || undefined,
  dbPath: env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'telemetry.db'),
  allowedOrigins: origins(env.ALLOWED_ORIGINS),
  adminToken,
  // Far larger values are past the dates JavaScript can hold, and every purge would fail.
  retentionDays: whole('RETENTION_DAYS', 180, 1, 36500),
  ratePerMin: whole('RATE_PER_MIN', 1200, 0),
  trustProxy: whole('TRUST_PROXY', 0, 0),
  log: message => console.log(message)
};

let createApp;
try {
  ({ createApp } = await import('./app.mjs'));
} catch (error) {
  if (error.code === 'ERR_UNKNOWN_BUILTIN_MODULE') fail(`node:sqlite is missing: use Node 22.13 or newer (this is ${process.version})`);
  throw error;
}
let app, address;
try {
  app = createApp(config);
  address = await app.listen(config.port, config.host);
} catch (error) {
  fail('cannot start: ' + error.message);
}
console.log(`telemetry: listening on port ${address.port}; ` +
  `${config.allowedOrigins.length} allowed origin(s), admin ${adminToken ? 'on' : 'off'}, ` +
  `retention ${config.retentionDays} days, ${config.ratePerMin || 'unlimited'} requests per minute per client`);
if (!config.allowedOrigins.length) console.warn('telemetry: ALLOWED_ORIGINS is empty, so batches from browsers are refused (403)');

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
