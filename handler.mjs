// The ingest server's HTTP rules as a Fetch-API handler (Request -> Response), shared by
// the Cloudflare Worker (worker.mjs) and the Node host (app.mjs): routing, CORS, the soft
// per-client token bucket, body limits, admin authentication and status codes. Paths
// outside /v1/ go to the host's static files (the dashboard). No IP, header or request
// body is ever stored or logged; the client key (an address) is only a key of the
// in-memory token bucket.
import { validateBatch } from './schema.mjs';
import { utcDay } from './store.mjs';

export const MAX_BODY = 64 * 1024;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86400000;
const BUCKET_CAP = 100000;
// The band query value and the stored band ('' is unknown).
const KPI_BANDS = { all: null, '6-7': '6-7', '8-9': '8-9', '10-11': '10-11', unknown: '' };
const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

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

// from/to default to the 30 days ending today (UTC).
function kpiParams(query, now) {
  const to = query.get('to') ?? utcDay(now);
  if (!validDay(to)) throw new HttpError(400, 'to');
  const from = query.get('from') ?? utcDay(Date.parse(to + 'T00:00:00Z') - 29 * DAY_MS);
  if (!validDay(from) || from > to) throw new HttpError(400, 'from');
  if ((Date.parse(to) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) throw new HttpError(400, 'range');
  const band = query.get('band') ?? 'all';
  if (!Object.hasOwn(KPI_BANDS, band)) throw new HttpError(400, 'band');
  return { from, to, band: KPI_BANDS[band] };
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
    // A repeated batch id is answered like a new one, so the client drops it.
    await store.ingest(valid.envelope, valid.events, now());
  }

  async function admin(request, kind, query) {
    if (!token) throw new HttpError(404, 'admin password not set');
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method', { Allow: 'GET, HEAD, OPTIONS' });
    if (!(await authorized(request))) throw new HttpError(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer realm="telemetry"' });
    const t = now();
    return kind === 'kpis' ? store.kpis(kpiParams(query, t), t) : store.live(t);
  }

  return async function handle(request, clientKey = '') {
    const headers = { Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const origin = request.headers.get('origin');
    if (origin !== null && origins.has(origin)) {
      // Retry-After is not a CORS-safelisted response header, so the page could not read it otherwise.
      Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Retry-After' });
    }
    const send = (status, body, extra = {}) => body === undefined
      ? new Response(null, { status, headers: { ...headers, ...extra } })
      : new Response(encoder.encode(JSON.stringify(body)), {
        status, headers: { ...headers, ...extra, 'Content-Type': 'application/json; charset=utf-8' }
      });
    try {
      const wait = limit(clientKey);
      if (wait) throw new HttpError(429, 'rate limited', { 'Retry-After': String(wait) });
      const url = new URL(request.url), { pathname } = url, method = request.method;
      if (method === 'OPTIONS') {
        const preflight = headers['Access-Control-Allow-Origin'] ? { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } : {};
        return send(204, undefined, preflight);
      }
      if (pathname === '/v1/batch') {
        if (method !== 'POST') throw new HttpError(405, 'method', { Allow: 'POST, OPTIONS' });
        await batch(request);
        return send(204);
      }
      if (pathname === '/v1/health') {
        if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method', { Allow: 'GET, HEAD, OPTIONS' });
        return send(200, { ok: true });
      }
      if (pathname === '/v1/admin/kpis' || pathname === '/v1/admin/live') return send(200, await admin(request, pathname.slice(10), url.searchParams));
      // Everything outside /v1/ is the dashboard's static files.
      if (assets && pathname !== '/v1' && !pathname.startsWith('/v1/') && (method === 'GET' || method === 'HEAD')) return await assets(request);
      throw new HttpError(404, 'not found');
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message }, error.headers);
      log('telemetry: request failed: ' + (error && error.message));
      return send(500, { error: 'server' });
    }
  };
}
