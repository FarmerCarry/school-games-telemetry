// The ingest server's HTTP rules as a Fetch-API handler (Request -> Response), shared by
// the Cloudflare Worker (worker.mjs) and the Node host (app.mjs): routing, CORS, the soft
// per-client token bucket, body limits, admin authentication, the admin router and status
// codes. Paths outside /v1/ go to the host's static files (the dashboard). No IP, header or
// request body is ever stored or logged; the client key (an address) is only a key of the
// in-memory token bucket. The request that upgrades the database does only that and is
// answered 503 with Retry-After (the portal sends the batch again). Admin reads answer 429
// once the day's free reading allowance is nearly used, and the owner's actions once the
// day's writes are (store.mjs, guard).
import { JsonText, SENT } from './admin.mjs';
import { zoneName } from './clock.mjs';
import { FILES } from './export.mjs';
import { METRICS } from './rollups.mjs';
import { U_RE, WIRES, isSlug, validateBatch } from './schema.mjs';
import { SCHEMA_VERSION, utcDay } from './store.mjs';

export const MAX_BODY = 64 * 1024;
export const MAX_ADMIN_BODY = 4 * 1024;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86400000;
const BUCKET_CAP = 100000;
// The band query value and the stored band ('' is unknown).
const KPI_BANDS = { all: null, '6-7': '6-7', '8-9': '8-9', '10-11': '10-11', unknown: '' };
const encoder = new TextEncoder();

// An answer other than 2xx: { error: message, ...more }.
export class HttpError extends Error {
  constructor(status, message, headers = {}, more = {}) { super(message); this.status = status; this.headers = headers; this.more = more; }
}
// The admin routes: each method they take (HEAD goes with GET) and the guard it passes:
// read (an admin read: 429 once today's reads pass 4.2 million), export (an export page:
// 3.5 million), write (an action that writes: 90,000 writes) or none (live and settings).
const ADMIN = {
  kpis: { GET: 'read' }, live: { GET: null }, settings: { GET: null, POST: null },
  students: { GET: 'read' }, student: { GET: 'read' }, game: { GET: 'read' }, stats: { GET: 'read' }, cohorts: { GET: 'read' },
  pcs: { GET: 'read' }, export: { GET: 'export' },
  forget: { POST: 'write' }, link: { POST: 'write', DELETE: 'write' }, rebuild: { POST: 'write' }
};
const SETTINGS_FIELDS = new Set(['tz', 'source', 'weekStart', 'keepDays']);

// Printable ASCII only: header bytes are read as latin1, so any other character could never match.
export const isAdminToken = token => typeof token === 'string' && /^[\x21-\x7e]{16,}$/.test(token);

// ALLOWED_ORIGINS: comma-separated origins such as https://name.github.io (no path, no
// trailing slash), or the literal null. Returns the valid ones and the rest.
export function parseOrigins(raw = '') {
  const list = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  const valid = origin => {
    if (origin === 'null') return true;
    try { return new URL(origin).origin === origin; } catch { return false; }
  };
  return { origins: list.filter(valid), invalid: list.filter(origin => !valid(origin)) };
}

const sha256 = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
// Digests have the same length whatever the input, and every byte is compared.
function sameDigest(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Token bucket per client: perMin tokens, refilled continuously. Returns the seconds to
// wait, or 0 when the request may go ahead. 0 per minute turns it off.
function rateLimiter(perMin, now) {
  const buckets = new Map();
  let swept = now();
  const refill = (bucket, t) => Math.min(perMin, bucket.tokens + Math.max(0, t - bucket.at) * perMin / 60000);
  return key => {
    if (!perMin) return 0;
    const t = now();
    if (t - swept >= 60000 || buckets.size >= BUCKET_CAP) {
      // A full bucket is the same as no bucket.
      for (const [k, bucket] of buckets) if (refill(bucket, t) >= perMin) buckets.delete(k);
      if (buckets.size >= BUCKET_CAP) buckets.clear();
      swept = t;
    }
    const bucket = buckets.get(key) || { tokens: perMin, at: t };
    bucket.tokens = refill(bucket, t);
    bucket.at = t;
    buckets.set(key, bucket);
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * 60 / perMin));
    bucket.tokens -= 1;
    return 0;
  };
}

// Reads at most limit bytes of the body. A declared or streamed body over the limit is
// 413 (the host reads and throws away the rest); a client that goes away mid-body gets
// an answer nobody reads, and nothing is logged.
async function readBody(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new HttpError(413, 'too large');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    let step;
    try { step = await reader.read(); } catch { throw new HttpError(400, 'body'); }
    if (step.done) break;
    size += step.value.byteLength;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new HttpError(413, 'too large');
    }
    chunks.push(step.value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.byteLength; }
  return body;
}

const validDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v + 'T00:00:00Z')) && utcDay(Date.parse(v + 'T00:00:00Z')) === v;

// from/to default to the 30 days ending today (the school's day when the store knows it).
function kpiParams(query, today) {
  const to = query.get('to') ?? today;
  if (!validDay(to)) throw new HttpError(400, 'to');
  const from = query.get('from') ?? utcDay(Date.parse(to + 'T00:00:00Z') - 29 * DAY_MS);
  if (!validDay(from) || from > to) throw new HttpError(400, 'from');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) throw new HttpError(400, 'range');
  const band = query.get('band') ?? 'all';
  if (!Object.hasOwn(KPI_BANDS, band)) throw new HttpError(400, 'band');
  return { from, to, band: KPI_BANDS[band] };
}

// A query parameter that must match: a student code, a game, the r_stat metrics (a
// comma-separated subset, answered in the contract's order) or an export file.
function code(query, name) {
  const value = query.get(name);
  if (typeof value !== 'string' || !U_RE.test(value)) throw new HttpError(400, name);
  return value;
}
function slugParam(query, name, optional = false) {
  const value = query.get(name);
  if (value === null && optional) return null;
  if (!isSlug(value)) throw new HttpError(400, name);
  return value;
}
function metricsParam(query) {
  const list = (query.get('metrics') ?? '').split(',');
  if (!list.every(metric => METRICS.includes(metric))) throw new HttpError(400, 'metrics');
  return METRICS.filter(metric => list.includes(metric));
}
// The JSON body of an action: an object with exactly these fields.
function fields(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body');
  const field = Object.keys(body).find(key => !names.includes(key));
  if (field !== undefined) throw new HttpError(400, 'field');
  return body;
}
function bodyCode(body, name) {
  if (typeof body[name] !== 'string' || !U_RE.test(body[name])) throw new HttpError(400, name);
  return body[name];
}

// An export page: its CSV lines (each ending in a line break, as SQL joined them), how many,
// and the next page's cursor.
class CsvPage {
  constructor(text, rows, next) { this.text = text; this.rows = rows; this.next = next; }
}

// POST /v1/admin/settings: { tz?, source?: 'dashboard', weekStart?: 'sun' | 'mon',
// keepDays?: 400 | 760 }, nothing else.
function settingsBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body');
  const field = Object.keys(body).find(key => !SETTINGS_FIELDS.has(key));
  if (field !== undefined) throw new HttpError(400, 'field');
  const { tz, source, weekStart, keepDays } = body;
  if (tz !== undefined && !zoneName(tz)) throw new HttpError(400, 'tz');
  if (source !== undefined && (source !== 'dashboard' || tz === undefined)) throw new HttpError(400, 'source');
  if (weekStart !== undefined && weekStart !== 'sun' && weekStart !== 'mon') throw new HttpError(400, 'weekStart');
  if (keepDays !== undefined && keepDays !== 400 && keepDays !== 760) throw new HttpError(400, 'keepDays');
  return { tz: tz === undefined ? tz : zoneName(tz), source, weekStart, keepDays };
}

// An answer as JSON; one that is JSON text already (admin.mjs JsonText, or SENT), or a field
// that is, is written as it is.
export function serialize(body) {
  if (body instanceof JsonText) return body.text;
  if (body[SENT]) return body[SENT];
  if (!Object.values(body).some(value => value instanceof JsonText)) return JSON.stringify(body);
  return '{' + Object.entries(body).filter(([, value]) => value !== undefined)
    .map(([key, value]) => JSON.stringify(key) + ':' + (value instanceof JsonText ? value.text : JSON.stringify(value))).join(',') + '}';
}

// Options: store (store.mjs), allowedOrigins, adminToken ('' turns the admin endpoints
// off), ratePerMin, now, log (internal errors only), assets (request => Response for
// paths outside /v1/, or null). Returns handle(request, clientKey) => Promise<Response>.
export function createHandler(options) {
  const { store, allowedOrigins = [], adminToken = '', ratePerMin = 1200, now = Date.now, log = () => {}, assets = null } = options;
  const origins = new Set(allowedOrigins);
  const token = adminToken ? sha256(adminToken) : null;
  const limit = rateLimiter(ratePerMin, now);

  async function authorized(request) {
    const match = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') || '');
    return !!match && sameDigest(await sha256(match[1]), await token);
  }

  // The database is created or upgraded by the first request that needs it, one version
  // step at a time; that request is answered 503 and does nothing else.
  async function ready(t) {
    if (await store.setup?.(t) === 'migrated') throw new HttpError(503, 'updating', { 'Retry-After': '2' });
  }

  async function batch(request) {
    const origin = request.headers.get('origin');
    // Browsers always send Origin; a page from another site must not add rows.
    if (origin !== null && !origins.has(origin)) throw new HttpError(403, 'origin');
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'text/plain' && type !== 'application/json') throw new HttpError(415, 'content type');
    const raw = await readBody(request, MAX_BODY);
    let body;
    // Invalid UTF-8 becomes U+FFFD; a byte-order mark is kept, so such a body is not JSON.
    try { body = JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw)); } catch { throw new HttpError(400, 'json'); }
    const valid = validateBatch(body);
    if (!valid) throw new HttpError(400, 'envelope');
    const t = now();
    await ready(t);
    // A repeated batch is answered like a new one, so the client drops it.
    await store.ingest(valid, t);
    // How long the PCs should wait between batches, by today's writes (the free plan's limit).
    return store.batchEvery?.(t);
  }

  // A JSON body of at most MAX_ADMIN_BODY bytes, sent as application/json (optional: an
  // empty body is no body).
  async function jsonBody(request, optional = false) {
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const raw = await readBody(request, MAX_ADMIN_BODY);
    if (optional && !raw.byteLength) return null;
    if (type !== 'application/json') throw new HttpError(415, 'content type');
    try { return JSON.parse(new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw)); } catch { throw new HttpError(400, 'json'); }
  }

  // What each admin route and method does, with its parameters validated first.
  function work(name, method, query, body, t) {
    const period = () => kpiParams(query, store.today?.(t) ?? utcDay(t));
    switch (name + ' ' + method) {
      case 'kpis GET': return store.kpis(period(), t);
      case 'live GET': return store.live(t);
      case 'settings GET': return store.settings(t);
      case 'settings POST': return store.updateSettings(settingsBody(body), t);
      case 'students GET': {
        // A later page starts after the code `after` (its answer's next).
        const after = query.has('after') ? code(query, 'after') : null;
        return store.students({ ...period(), after }, t);
      }
      case 'student GET': { const u = code(query, 'u'); return store.student({ ...period(), u }, t); }
      case 'game GET': { const slug = slugParam(query, 'slug'); return store.game({ ...period(), slug }, t); }
      case 'stats GET': { const metrics = metricsParam(query), slug = slugParam(query, 'slug', true); return store.stats({ ...period(), metrics, slug }, t); }
      case 'cohorts GET': return store.cohorts(period(), t);
      case 'pcs GET': { const { from, to } = period(); return store.pcs({ from, to }, t); }
      case 'export GET': {
        const file = query.get('file');
        if (!FILES.includes(file)) throw new HttpError(400, 'file');
        const { from, to } = period();
        return store.exportPage({ file, from, to, after: query.get('after') }, t).then(page => page.error ? page : new CsvPage(page.text, page.rows, page.next));
      }
      case 'forget POST': return store.forget({ u: bodyCode(fields(body, ['u']), 'u') }, t);
      case 'link POST': { const b = fields(body, ['u', 'to']); return store.link({ u: bodyCode(b, 'u'), to: bodyCode(b, 'to') }, t); }
      case 'link DELETE': {
        // The code from the query (DELETE /v1/admin/link?u=), or from a JSON body { u }.
        if (query.has('u') || body === null) return store.unlink({ u: code(query, 'u') }, t);
        return store.unlink({ u: bodyCode(fields(body, ['u']), 'u') }, t);
      }
      case 'rebuild POST': fields(body, []); return store.rebuild(t);
    }
  }

  async function admin(request, name, query) {
    const route = ADMIN[name];
    if (!token) throw new HttpError(404, 'admin password not set');
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    if (!Object.hasOwn(route, method)) {
      const allow = [...Object.keys(route), ...(Object.hasOwn(route, 'GET') ? ['HEAD'] : []), 'OPTIONS'];
      throw new HttpError(405, 'method', { Allow: allow.join(', ') });
    }
    if (!(await authorized(request))) throw new HttpError(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="telemetry"' });
    // POST takes a JSON body; DELETE may (its code can also be in the query).
    let body = null;
    if (method === 'POST') body = await jsonBody(request);
    else if (method === 'DELETE' && request.body && request.headers.get('content-length') !== '0') body = await jsonBody(request, true);
    const t = now();
    await ready(t);
    const stop = route[method] ? await store.guard?.(route[method], t) : null;
    if (stop) throw new HttpError(429, stop.error, {}, { until: stop.until });
    const answer = await work(name, method, query, body, t);
    if (answer.error) throw new HttpError(answer.status || 400, answer.error);
    return answer;
  }

  return async function handle(request, clientKey = '') {
    const headers = { Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const origin = request.headers.get('origin');
    if (origin !== null && origins.has(origin)) {
      // Retry-After and X-Batch-Every are not CORS-safelisted response headers, so the page could not read them otherwise.
      Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After, X-Batch-Every' });
    }
    const send = (status, body, extra = {}) => body === undefined
      ? new Response(null, { status, headers: { ...headers, ...extra } })
      : new Response(encoder.encode(serialize(body)), {
        status, headers: { ...headers, ...extra, 'Content-Type': 'application/json; charset=utf-8' }
      });
    try {
      const wait = limit(clientKey);
      if (wait) throw new HttpError(429, 'rate limited', { 'Retry-After': String(wait) });
      const url = new URL(request.url), { pathname } = url, method = request.method;
      if (method === 'OPTIONS') {
        const preflight = headers['Access-Control-Allow-Origin'] ? { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } : {};
        return send(204, undefined, preflight);
      }
      if (pathname === '/v1/batch') {
        if (method !== 'POST') throw new HttpError(405, 'method', { Allow: 'POST, OPTIONS' });
        const every = await batch(request);
        return send(204, undefined, every ? { 'X-Batch-Every': String(every) } : {});
      }
      if (pathname === '/v1/health') {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method', { Allow: 'GET, HEAD, OPTIONS' });
        // Answered without the database: which wire versions this server accepts.
        return send(200, { ok: true, accepts: WIRES, schema: SCHEMA_VERSION });
      }
      if (pathname.startsWith('/v1/admin/') && Object.hasOwn(ADMIN, pathname.slice(10))) {
        const answer = await admin(request, pathname.slice(10), url.searchParams);
        if (!(answer instanceof CsvPage)) return send(200, answer);
        // An export page: lines without a header, how many, and the next page's cursor.
        return new Response(encoder.encode(answer.text), { status: 200, headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8',
          'X-Rows': String(answer.rows), ...(answer.next ? { 'X-Next': answer.next } : {}) } });
      }
      // Everything outside /v1/ is the dashboard's static files.
      if (assets && pathname !== '/v1' && !pathname.startsWith('/v1/') && (method === 'GET' || method === 'HEAD')) return await assets(request);
      throw new HttpError(404, 'not found');
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message, ...error.more }, error.headers);
      log('telemetry: request failed: ' + (error && error.message));
      return send(500, { error: 'server' });
    }
  };
}
