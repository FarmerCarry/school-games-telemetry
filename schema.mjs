// Strict validation of the telemetry v2 envelope and events
// (docs/ARCHITECTURE.md, "Telemetry sink"). Everything not described there is
// dropped here, so nothing else can ever reach the database: unknown envelope
// fields are ignored, unknown event kinds and malformed events are dropped, and
// measured numbers are rounded and clamped. Enumerations, flags and buckets must
// be exact.

export const BANDS = ['6-7', '8-9', '10-11', ''];
export const MODES = ['web', 'app'];
// The v1 launch sources (docs/PLAY_STATS.md, "Launch source") plus the starter title.
export const SOURCES = ['featured', 'catalog', 'recent', 'favorites', 'category', 'quick', 'search',
  'related', 'surprise', 'reload', 'history', 'direct', 'starter'];
export const CODES = ['w', 'l', 'd', 'e', 'q'];
export const ERRORS = ['t', 'x', 'l'];
export const CORES = [1, 2, 4, 8, 16];
export const MEMORY = [0, 1, 2, 4, 8];
export const SCREENS = [1366, 1600, 1920, 2560];
export const MAX_EVENTS = 200;

// Upper bounds for measured numbers; larger values are clamped, not dropped.
export const LIMITS = {
  t: 7 * 86400,            // seconds since the session started
  level: 999,
  loadMs: 120000,
  replay: 9999,
  roundMs: 3 * 3600000,    // the v1 round-time cap
  score: 1e9,
  count: 100000,           // hits, misses and each reaction-time or input-latency bucket
  frames: 1e7,             // each frame bucket of one game visit
  gameMs: 6 * 3600000,
  sessionMs: 24 * 3600000
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^[A-Za-z][A-Za-z0-9_:.-]{0,23}$/;
// The fast build's version: the first 16 hex digits of a SHA-256 (tools/build.mjs).
const VERSION = /^(?:src|[0-9a-f]{16})$/;
// A name such as 'constructor' matches the patterns but is a plain-object key
// (the v1 portal rejects those too).
const reserved = v => v in Object.prototype;

export const isSlug = v => typeof v === 'string' && v.length <= 40 && SLUG.test(v) && !reserved(v);
// Round ids follow the v1 rules: from the game's own list, never typed text or a code.
export const isId = v => typeof v === 'string' && ID.test(v) && !/[0-9]{3}/.test(v) && !reserved(v);
const isHex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v);

// Field validators return the cleaned value, or undefined when the field is malformed.
const oneOf = list => v => list.includes(v) ? v : undefined;
const whole = (min, max) => v => Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const measure = (max, min = 0) => v =>
  typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.min(Math.round(v), max) : undefined;
const histogram = (n, max) => v => {
  if (!Array.isArray(v) || v.length !== n) return undefined;
  const out = v.map(measure(max));
  return out.includes(undefined) ? undefined : out;
};
const time = measure(LIMITS.t);
const slug = v => isSlug(v) ? v : undefined;
const id = v => isId(v) ? v : undefined;
const tier = whole(0, 9);
const score = v => v === -1 ? -1 : measure(LIMITS.score)(v);

// Fields after the kind, in the contract's order. An event must have exactly these.
export const EVENTS = {
  ss: [time, whole(0, 1), whole(0, 3), whole(0, 4), measure(LIMITS.level)],
  go: [time, slug, oneOf(SOURCES), whole(0, 4)],
  ld: [time, slug, measure(LIMITS.loadMs)],
  er: [time, slug, oneOf(ERRORS)],
  rs: [time, slug, id, tier, measure(LIMITS.replay)],
  re: [time, slug, oneOf(CODES), id, measure(LIMITS.roundMs), score, tier,
    measure(LIMITS.count), measure(LIMITS.count), histogram(6, LIMITS.count)],
  gx: [time, slug, measure(LIMITS.gameMs), histogram(6, LIMITS.count), histogram(4, LIMITS.frames)],
  lv: [time, measure(LIMITS.level, 1)],
  se: [time, measure(LIMITS.sessionMs)]
};

// The cleaned event as a new array, or null when it is unknown or malformed.
export function cleanEvent(event) {
  if (!Array.isArray(event) || typeof event[0] !== 'string' || !Object.hasOwn(EVENTS, event[0])) return null;
  const fields = EVENTS[event[0]];
  if (event.length !== fields.length + 1) return null;
  const out = [event[0]];
  for (let i = 0; i < fields.length; i++) {
    const value = fields[i](event[i + 1]);
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

// { envelope, events, dropped } for a valid envelope, or null (answered with 400).
export function validateBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { v, b, s, k, m, a, d, ev } = body;
  if (v !== 2 || !isHex(b, 16) || !isHex(s, 12)) return null;
  if (typeof k !== 'string' || !VERSION.test(k) || !MODES.includes(m) || !BANDS.includes(a)) return null;
  if (!Array.isArray(d) || d.length !== 3 || !CORES.includes(d[0]) || !MEMORY.includes(d[1]) || !SCREENS.includes(d[2])) return null;
  if (!Array.isArray(ev) || ev.length > MAX_EVENTS) return null;
  const events = [];
  for (const event of ev) {
    const clean = cleanEvent(event);
    if (clean) events.push(clean);
  }
  return { envelope: { b, s, k, m, a, d: [d[0], d[1], d[2]] }, events, dropped: ev.length - events.length };
}
