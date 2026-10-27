// Node host of the ingest server: node:http in front of the Fetch-API handler
// (handler.mjs), the store (store.mjs) over one SQLite file (sqlite-d1.mjs), the
// dashboard's static files (static.mjs), a purge at start and every 24 hours, and a sweep
// of the live rows every minute.
// No IP, header or request body is ever stored or logged; the IP is only a key of the
// handler's in-memory token bucket.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHandler, MAX_BODY, MAX_RANGE_DAYS } from './handler.mjs';
import { openDatabase } from './sqlite-d1.mjs';
import { openStore } from './store.mjs';
import { staticFiles } from './static.mjs';

export { MAX_BODY, MAX_RANGE_DAYS };
const PURGE_EVERY_MS = 24 * 3600000;
const SWEEP_EVERY_MS = 60000;
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
    dbPath: ':memory:', allowedOrigins: [], adminToken: '', retentionDays: 180, ratePerMin: 1200,
    trustProxy: 0, now: Date.now, log: () => {}, dashboardDir: DASHBOARD, ...options
  };
  const { now, log } = config;
  const store = config.store || openStore(openDatabase(config.dbPath), { retentionDays: config.retentionDays });
  const handle = createHandler({
    store, allowedOrigins: config.allowedOrigins, adminToken: config.adminToken, ratePerMin: config.ratePerMin, now, log,
    assets: config.dashboardDir ? staticFiles(config.dashboardDir) : null
  });
  let timer = null, sweeper = null, closing = null;

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
      if (result.rows || result.batches) log(`telemetry: purged ${result.rows} rows before ${result.cutoff} and ${result.batches} old batch ids`);
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

  return {
    server, store, purge,
    // Creates or upgrades the tables (a newer or unreadable database stops here), purges
    // once, then every 24 hours, sweeps the live rows every minute and starts listening.
    // Resolves to the address.
    async listen(port = 0, host) {
      await store.setup?.();
      await purge();
      clearInterval(timer);
      clearInterval(sweeper);
      timer = setInterval(purge, PURGE_EVERY_MS);
      timer.unref();
      sweeper = setInterval(sweep, SWEEP_EVERY_MS);
      sweeper.unref();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    // Stops listening and closes the database (unless it was passed in). Safe to repeat.
    close() {
      clearInterval(timer);
      clearInterval(sweeper);
      closing ||= new Promise(resolve => {
        server.close(() => { if (!options.store) store.close(); resolve(); });
        server.closeAllConnections();
      });
      return closing;
    }
  };
}
