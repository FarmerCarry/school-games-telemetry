// Node host of the ingest server: node:http in front of the Fetch-API handler
// (handler.mjs), the store (store.mjs) over one SQLite file (sqlite-d1.mjs), the
// dashboard's static files (static.mjs), a purge at start and every 24 hours, the rollups
// at start and every 5 minutes, and a sweep of the live rows every minute.
// No IP, header or request body is ever stored or logged; the IP is only a key of the
// handler's in-memory token bucket.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, MAX_BODY, MAX_RANGE_DAYS } from './handler.mjs';
import { openDatabase } from './sqlite-d1.mjs';
import { RETENTION_DAYS, openStore } from './store.mjs';
import { staticFiles } from './static.mjs';

export { MAX_BODY, MAX_RANGE_DAYS };
const PURGE_EVERY_MS = 24 * 3600000;
const SWEEP_EVERY_MS = 60000;
const ROLL_EVERY_MS = 5 * 60000;
const DRAIN_LIMIT = 1024 * 1024;
const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard');

// The client address: the socket's, or with TRUST_PROXY=n the address the n-th
// trusted proxy from the server appended to X-Forwarded-For.
function clientKey(req, hops) {
  if (hops > 0) {
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.length >= hops) return list[list.length - hops];
  }
  return req.socket.remoteAddress || '';
}

// The request body as a web stream that reads the socket only when the handler asks.
// What the handler leaves (a body past the limit, or one it never read) is read and
// thrown away, so that closing the socket cannot reset the connection before the
// client reads the answer. A client that sends DRAIN_LIMIT more is disconnected (as is
// one slower than the request timeout).
function requestBody(req) {
  let controller, attached = false, drained = false;
  const onData = chunk => { controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); req.pause(); };
  const onEnd = () => { detach(); controller.close(); };
  const onGone = () => { detach(); controller.error(new Error('the client went away')); };
  const detach = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onGone); req.off('close', onGone); };
  const drain = () => {
    detach();
    if (drained || req.complete || req.destroyed) return;
    drained = true;
    let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > DRAIN_LIMIT) req.destroy(); });
    req.on('error', () => {});
    req.resume();
  };
  const stream = new ReadableStream({
    start(c) { controller = c; },
    pull() {
      if (!attached) {
        attached = true;
        req.on('data', onData); req.on('end', onEnd); req.on('error', onGone); req.on('close', onGone);
      }
      req.resume();
    },
    cancel: drain
  }, { highWaterMark: 0 });
  return { stream, drain };
}

export function createApp(options = {}) {
  const config = {
    dbPath: ':memory:', allowedOrigins: [], adminToken: '', retentionDays: RETENTION_DAYS, ratePerMin: 1200,
    trustProxy: 0, now: Date.now, log: () => {}, dashboardDir: DASHBOARD, ...options
  };
  const { now, log } = config;
  const store = config.store || openStore(openDatabase(config.dbPath), { retentionDays: config.retentionDays });
  const handle = createHandler({
    store, allowedOrigins: config.allowedOrigins, adminToken: config.adminToken, ratePerMin: config.ratePerMin, now, log,
    assets: config.dashboardDir ? staticFiles(config.dashboardDir) : null
  });
  let timer = null, sweeper = null, roller = null, closing = null;

  async function respond(req, res) {
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : requestBody(req);
    let response;
    try {
      const headers = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      // The path as sent (never resolved against another host), on a placeholder origin.
      const url = 'http://localhost' + (req.url.startsWith('/') ? '' : '/') + req.url;
      const request = new Request(url, { method: req.method, headers, body: body?.stream, duplex: 'half' });
      response = await handle(request, clientKey(req, config.trustProxy));
    } catch {
      // Only a request that the Fetch API cannot represent (such as TRACE) gets here.
      response = new Response('{"error":"request"}', { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' } });
    }
    body?.drain();
    // The client went away or was too slow (Node has answered 408): nothing failed here.
    if (res.destroyed || req.destroyed && !req.complete) return;
    const payload = Buffer.from(await response.arrayBuffer());
    const headers = Object.fromEntries(response.headers);
    if (response.body !== null) headers['content-length'] = payload.length;
    res.writeHead(response.status, headers);
    res.end(payload);
  }

  const server = http.createServer((req, res) => {
    respond(req, res).catch(error => {
      log('telemetry: request failed: ' + (error && error.message));
      res.destroy();
    });
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;

  async function purge() {
    try {
      const result = await store.purge(now());
      // Write the zeroed pages back and empty the write-ahead log, so purged rows leave the files.
      store.db?.compact?.();
      if (result.sessions || result.rows || result.batches) {
        log(`telemetry: purged ${result.sessions} sessions before ${result.cutoff}, ${result.rows} frozen daily rows and ${result.batches} old batch ids`);
      }
      if (result.trimmed) log(`telemetry: the database is near its size limit: removing the round details before ${result.trimmed.to}`);
      return result;
    } catch (error) {
      log('telemetry: purge failed: ' + error.message);
      return null;
    }
  }
  // The live rows that have left the window go even when no request comes.
  async function sweep() {
    try { await store.sweep?.(now()); } catch (error) { log('telemetry: sweep failed: ' + error.message); }
  }
  // At most one of the school's days rolled up (or rolled again) per call, one call at a time.
  let rolling = null;
  function roll() {
    rolling ||= (async () => {
      try {
        return await store.rollupStep?.(now());
      } catch (error) {
        log('telemetry: rollup failed: ' + error.message);
        return null;
      } finally {
        rolling = null;
      }
    })();
    return rolling;
  }

  return {
    server, store, purge, roll,
    // Creates or upgrades the tables, every version step (a newer or unreadable database
    // stops here, so no request ever waits for an upgrade), purges once, then every 24
    // hours, rolls up once, then every 5 minutes, sweeps the live rows every minute and
    // starts listening. Resolves to the address.
    async listen(port = 0, host) {
      for (let step = 0; await store.setup?.(now()) === 'migrated'; step++) {
        if (step > 3) throw new Error('the database did not reach the current schema');
      }
      await purge();
      await roll();
      clearInterval(timer);
      clearInterval(sweeper);
      clearInterval(roller);
      timer = setInterval(purge, PURGE_EVERY_MS);
      timer.unref();
      sweeper = setInterval(sweep, SWEEP_EVERY_MS);
      sweeper.unref();
      roller = setInterval(roll, ROLL_EVERY_MS);
      roller.unref();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    // Stops listening and closes the database (unless it was passed in). Safe to repeat.
    close() {
      clearInterval(timer);
      clearInterval(sweeper);
      clearInterval(roller);
      closing ||= new Promise(resolve => {
        server.close(() => { if (!options.store) store.close(); resolve(); });
        server.closeAllConnections();
      });
      return closing;
    }
  };
}
