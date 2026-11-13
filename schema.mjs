// Validation of the telemetry envelope and events: wire version 2 (docs/ARCHITECTURE.md,
// "Telemetry sink") and version 3 (docs/RESEARCH_TELEMETRY_SPEC.md, "Wire format v3").
// Everything not described there is dropped here, so nothing else can ever reach the
// database: unknown envelope fields are ignored, unknown event kinds and malformed events
// are dropped, and measured numbers are rounded and clamped. The core of the envelope
// (v b s k m d ev), enumerations, flags and buckets must be exact. The fields v3 adds to
// the envelope (p z w) and a round's extras (re.x) are lenient: a malformed value becomes
// '' or null and the rest is kept, because the portal drops a batch for good on any 4xx
// answer.
// Every session is anonymous. The site has no student accounts, player profiles or age
// groups any more, but PCs with an older portal (or a cached one) still send them, and a
// batch is never refused for them: the age band (a), the student code (u), the session
// start's profile fields (ss: new profile, profile age, days since the last play, level,
// profiles on the PC, classroom mode), level-ups (lv), removed profiles (pr) and older
// codes of a student (cd) are read past and never returned, so they cannot be stored.
import { zoneName } from './clock.mjs';

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
export const WIRES = [2, 3];
// Envelope fields of older portals that are read past (never validated, never kept).
export const IGNORED_FIELDS = ['a', 'u'];
// Event kinds of older portals that are read past: a level-up, a profile removed on the
// PC and an older code of a student. They are neither kept nor counted as dropped.
export const IGNORED_KINDS = ['lv', 'pr', 'cd'];
// The longest a session can have been open when a batch is sent (8 days, in seconds).
export const MAX_W = 691200;

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
const count = measure(LIMITS.count);
// v3: the visit number in the session and the round number in the visit.
const visit = whole(1, 9999);
const roundNo = whole(1, 99999);
// re.x: [wallMs, inputs, idleLapses, pauses, rtSumMs, rtN, ddaPermille], or null. Lenient:
// anything else (an older Kit sends null) is null, and the round is kept.
const EXTRAS = [measure(108e5), measure(1e5), measure(1e4), measure(1e4), measure(1e9), measure(1e5), whole(-1, 1000)];
const extras = v => {
  if (!Array.isArray(v) || v.length !== EXTRAS.length) return null;
  const out = EXTRAS.map((field, i) => field(v[i]));
  return out.includes(undefined) ? null : out;
};

// Fields after the kind, in the contract's order. An event must have exactly these, except
// the session start (ss), which keeps only its time: the fields after it (a profile's, in
// older portals) are read past, whatever they are, so that every portal's ss counts.
export const EVENTS = {
  ss: [time],
  go: [time, slug, oneOf(SOURCES), whole(0, 4)],
  ld: [time, slug, measure(LIMITS.loadMs)],
  er: [time, slug, oneOf(ERRORS)],
  rs: [time, slug, id, tier, measure(LIMITS.replay)],
  re: [time, slug, oneOf(CODES), id, measure(LIMITS.roundMs), score, tier, count, count, histogram(6, LIMITS.count)],
  gx: [time, slug, measure(LIMITS.gameMs), histogram(6, LIMITS.count), histogram(4, LIMITS.frames)],
  se: [time, measure(LIMITS.sessionMs)]
};
// Wire version 3: visit and round numbers, the round's extras, and the new kinds gp
// (engaged time so far), tu (tutorial), fv (heart) and ct (classroom timer).
export const EVENTS_V3 = {
  ss: [time],
  go: [time, visit, slug, oneOf(SOURCES), measure(1e6), whole(0, 1)],
  ld: [time, visit, slug, measure(LIMITS.loadMs)],
  er: [time, visit, slug, oneOf(ERRORS)],
  rs: [time, visit, roundNo, slug, id, tier, measure(LIMITS.replay)],
  re: [time, visit, roundNo, slug, oneOf(CODES), id, measure(LIMITS.roundMs), score, tier, count, count,
    histogram(6, LIMITS.count), extras],
  gp: [time, visit, slug, measure(LIMITS.gameMs)],
  gx: [time, visit, slug, measure(LIMITS.gameMs), histogram(6, LIMITS.count), histogram(4, LIMITS.frames)],
  tu: [time, visit, slug, oneOf(['s', 'd'])],
  fv: [time, visit, slug, whole(0, 1)],
  ct: [time, oneOf(['s', 'c', 'e']), measure(120)],
  se: [time, measure(LIMITS.sessionMs), oneOf(['u', 'p', 'h', 'i'])]
};
// The kinds whose fields after the declared ones are read past (the declared ones must
// be there and valid).
const OPEN_ENDED = new Set(['ss']);

// The cleaned event as a new array, or null when it is unknown or malformed.
export function cleanEvent(event, kinds = EVENTS) {
  if (!Array.isArray(event) || typeof event[0] !== 'string' || !Object.hasOwn(kinds, event[0])) return null;
  const fields = kinds[event[0]];
  if (OPEN_ENDED.has(event[0]) ? event.length < fields.length + 1 : event.length !== fields.length + 1) return null;
  const out = [event[0]];
  for (let i = 0; i < fields.length; i++) {
    const value = fields[i](event[i + 1]);
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

// { wire: 2 | 3, envelope: { b, s, k, m, d, p, z, w }, events, dropped } for a valid
// envelope, or null (answered with 400). A v2 envelope has p = z = '' and w = null. The
// fields of older portals (IGNORED_FIELDS, IGNORED_KINDS) are left out whatever they hold.
export function validateBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { v, b, s, k, m, d, ev } = body;
  if (!WIRES.includes(v) || !isHex(b, 16) || !isHex(s, 12)) return null;
  if (typeof k !== 'string' || !VERSION.test(k) || !MODES.includes(m)) return null;
  if (!Array.isArray(d) || d.length !== 3 || !CORES.includes(d[0]) || !MEMORY.includes(d[1]) || !SCREENS.includes(d[2])) return null;
  if (!Array.isArray(ev) || ev.length > MAX_EVENTS) return null;
  const kinds = v === 3 ? EVENTS_V3 : EVENTS, events = [];
  let ignored = 0;
  for (const event of ev) {
    if (Array.isArray(event) && IGNORED_KINDS.includes(event[0])) { ignored++; continue; }
    const clean = cleanEvent(event, kinds);
    if (clean) events.push(clean);
  }
  const envelope = { b, s, k, m, d: [d[0], d[1], d[2]], p: '', z: '', w: null };
  if (v === 3) {
    if (isHex(body.p, 12)) envelope.p = body.p;
    if (zoneName(body.z)) envelope.z = zoneName(body.z);
    if (Number.isInteger(body.w) && body.w >= 0 && body.w <= MAX_W) envelope.w = body.w;
  }
  return { wire: v, envelope, events, dropped: ev.length - ignored - events.length };
}
