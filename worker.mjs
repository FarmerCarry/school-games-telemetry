// Cloudflare Workers entry of the ingest server: the shared handler (handler.mjs) and
// store (store.mjs) on the D1 database bound as env.DB, the dashboard from the static
// assets bound as env.ASSETS, and the rollups and the purge from the cron triggers
// (wrangler.json).
// Settings come from env: ALLOWED_ORIGINS and RETENTION_DAYS (plain variables),
// ADMIN_TOKEN (a secret: the dashboard password) and the optional RATE_PER_MIN and
// BATCH_PER_MIN. Nothing about a request is logged; the client address
// (CF-Connecting-IP) only keys the in-memory rate limits of this instance. A
// BATCH_LIMIT binding, if one is present, is used as well. It is not declared in
// wrangler.json: Workers Builds for this account fails the deploy when it is.
import { createHandler, DEFAULT_BATCH_PER_MIN, DEFAULT_RATE_PER_MIN, isAdminToken, parseOrigins } from './handler.mjs';
import { RETENTION_DAYS, openStore } from './store.mjs';

const SWEEP_CRON = '*/5 * * * *';
// The KPIs of the days not rolled yet are kept 10 minutes and shared through D1, so a
// dashboard left open reads today's facts at most every 10 minutes.
const OPEN_CACHE_MS = 10 * 60000;
const whole = (raw, fallback, min, max) =>
  /^\d+$/.test(String(raw ?? '')) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : fallback;

const missingDatabase = {
  prepare() { throw new Error('the D1 binding DB is missing (wrangler.json, d1_databases)'); },
  batch() { return Promise.reject(new Error('the D1 binding DB is missing (wrangler.json, d1_databases)')); }
};

// One store and handler per database binding and settings, kept for the life of the
// instance (so the rate limit and the schema check carry over between requests).
const instances = new WeakMap();
function instance(env) {
  const db = env.DB || missingDatabase;
  const settings = [env.ALLOWED_ORIGINS, env.ADMIN_TOKEN, env.RETENTION_DAYS, env.RATE_PER_MIN, env.BATCH_PER_MIN,
    env.BATCH_LIMIT ? '1' : '0'].join('\n');
  const cached = instances.get(db);
  if (cached && cached.settings === settings && cached.assets === env.ASSETS) return cached;
  const store = openStore(db, { retentionDays: whole(env.RETENTION_DAYS, RETENTION_DAYS, 1, 36500), openCacheMs: OPEN_CACHE_MS });
  const handle = createHandler({
    store,
    allowedOrigins: parseOrigins(env.ALLOWED_ORIGINS).origins,
    // Without a valid password the admin endpoints answer 404, and the dashboard says
    // that the password was not set.
    adminToken: isAdminToken(env.ADMIN_TOKEN) ? env.ADMIN_TOKEN : '',
    ratePerMin: whole(env.RATE_PER_MIN, DEFAULT_RATE_PER_MIN, 0, 1e9),
    batchPerMin: whole(env.BATCH_PER_MIN, DEFAULT_BATCH_PER_MIN, 0, 1e9),
    // Optional. Not declared in wrangler.json, because the account's Workers Build
    // cannot provision a rate-limit binding. The in-memory limit above still applies.
    // The key is the client address and is not stored.
    batchLimit: env.BATCH_LIMIT ? async key => {
      try {
        const { success } = await env.BATCH_LIMIT.limit({ key: key || 'unknown' });
        return success ? 0 : 60;
      } catch {
        console.error('telemetry: batch rate limit unavailable');
        return 0;
      }
    } : null,
    // Internal errors only (a message, never the request).
    log: message => console.error(message),
    assets: env.ASSETS ? request => env.ASSETS.fetch(request) : null
  });
  const entry = { settings, assets: env.ASSETS, store, handle };
  instances.set(db, entry);
  return entry;
}

export default {
  async fetch(request, env) {
    return instance(env).handle(request, request.headers.get('CF-Connecting-IP') || '');
  },
  // The crons of wrangler.json. Every 5 minutes (store.rollupStep): the live rows that have
  // left the window are deleted, so none outlives 10 minutes while no request comes, and at
  // most one of the school's days is rolled up (or rolled again after late data or a change
  // of zone). Any other (the daily one, store.purge): facts past RETENTION_DAYS or the
  // owner's choice, frozen aggregate days, batch ids past 30 days, usage rows past 60 days,
  // old kept KPI parts and those live rows are deleted. A run that upgrades the database
  // does only that.
  async scheduled(controller, env) {
    const { store } = instance(env), now = Date.now();
    if (await store.setup(now) === 'migrated') return;
    await (controller.cron === SWEEP_CRON ? store.rollupStep(now) : store.purge(now));
  }
};
