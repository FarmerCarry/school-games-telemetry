// The school's clock: UTC offsets, local days and the bounds of a local day in an IANA
// zone, from Intl alone (docs/RESEARCH_TELEMETRY_SPEC.md, "Time"). Pure: it reads no
// clock and stores nothing but caches. SQL never applies zone rules row by row: the store
// computes bounds and offsets here and binds them, as
// start_s + t + (CASE WHEN start_s + t >= ?ch THEN ?o2 ELSE ?o1 END) * 60.

const ZONE = /^[A-Za-z]+(?:[\/_+-][A-Za-z0-9]+){0,4}$/;
// Offsets change only at whole minutes, in practice at quarter hours, so they are cached
// per 15-minute slot (a slot with a change inside is never cached).
const SLOT_MS = 15 * 60000;
const SLOT_CAP = 20000;
const DAY_S = 86400;
// Where the school week starts on Sunday; everywhere else it starts on Monday.
const SUNDAY = new Set(['Asia/Riyadh', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Qatar', 'Asia/Baghdad', 'Asia/Amman',
  'Asia/Muscat', 'Asia/Aden', 'Asia/Damascus', 'Asia/Jerusalem', 'Asia/Gaza', 'Asia/Hebron', 'Africa/Cairo',
  'Africa/Tripoli', 'Africa/Algiers']);

let known = null;
const formats = new Map(), slots = new Map(), days = new Map();
const DAYS_CAP = 2000;

// An IANA zone this runtime knows (its canonical names, plus UTC).
export function isZone(z) {
  if (typeof z !== 'string' || z.length > 40 || !ZONE.test(z) || z in Object.prototype) return false;
  known ||= new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  return known.has(z);
}
// The names of UTC that a browser may report (Chromium on some Linux builds reports
// Etc/UTC), none of them canonical.
const UTC_NAMES = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/UCT', 'UCT', 'Etc/Universal', 'Universal', 'Etc/Zulu', 'Zulu',
  'Etc/Greenwich', 'Greenwich', 'GMT0', 'Etc/GMT0', 'GMT+0', 'GMT-0', 'Etc/GMT+0', 'Etc/GMT-0']);
// A zone as the school's clock keeps it: any name of UTC is 'UTC', a zone isZone knows is
// itself, anything else null.
export function zoneName(z) {
  if (typeof z === 'string' && UTC_NAMES.has(z)) return 'UTC';
  return isZone(z) ? z : null;
}

function format(zone) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formats.set(zone, f);
  }
  return f;
}
// The first DateTimeFormat loads the runtime's time zone data (about 15 ms): done when the
// module loads, which a Worker does at startup, not within a request's CPU time.
format('UTC').format(0);

// The offset at the whole second of ms, from the zone's wall clock ("10/25/2026, 01:59:59"
// in en-US with a 24-hour clock; read as six numbers, which is three times faster than
// formatToParts).
function exact(zone, ms) {
  const t = Math.floor(ms / 1000) * 1000, n = format(zone).format(t).split(/\D+/).map(Number);
  if (n.length !== 6) {
    const p = {};
    for (const { type, value } of format(zone).formatToParts(t)) p[type] = Number(value);
    n.splice(0, n.length, p.month, p.day, p.year, p.hour, p.minute, p.second);
  }
  return Math.round((Date.UTC(n[2], n[0] - 1, n[1], n[3], n[4], n[5]) - t) / 60000);
}

// The UTC offset of zone in minutes at the instant ms (east of Greenwich is positive).
export function offsetMin(zone, ms) {
  const slot = Math.floor(ms / SLOT_MS), key = zone + ' ' + slot;
  const cached = slots.get(key);
  if (cached !== undefined) return cached;
  const first = exact(zone, slot * SLOT_MS);
  if (first !== exact(zone, slot * SLOT_MS + SLOT_MS - 1000)) return exact(zone, ms);
  if (slots.size >= SLOT_CAP) slots.clear();
  slots.set(key, first);
  return first;
}

// { day: 'YYYY-MM-DD', hour, minute, weekday (0 = Sunday) } of the instant ms in zone.
export function localParts(zone, ms) {
  const d = new Date(ms + offsetMin(zone, ms) * 60000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes(), weekday: d.getUTCDay() };
}

export const localDay = (zone, ms) => new Date(ms + offsetMin(zone, ms) * 60000).toISOString().slice(0, 10);

// The first UTC second whose wall clock reads local midnight t (in seconds, as if UTC) or
// later. That second lies within 14 hours before t and 12 hours after it (offsets run
// from -12 to +14 hours), and at most one change falls in that span, so the offsets at its
// two ends are the only candidates. Midnight can fall in a gap (the clock jumps from
// 23:59:59 to 01:00); when the clock goes back across midnight, the first midnight starts
// the day.
function startOf(zone, t) {
  const wall = s => s + offsetMin(zone, s * 1000) * 60;
  const early = t - offsetMin(zone, (t - 14 * 3600) * 1000) * 60, late = t - offsetMin(zone, (t + 12 * 3600) * 1000) * 60;
  const [a0, b0] = early < late ? [early, late] : [late, early];
  for (const s of [a0, b0]) if (wall(s) >= t && wall(s - 1) < t) return s;
  // In a gap the wall clock only moves forward, so the first second at or after midnight is found by halving.
  let a = a0, b = b0;
  while (b - a > 1) {
    const m = Math.floor((a + b) / 2);
    if (wall(m) >= t) b = m; else a = m;
  }
  return b;
}

// The first second in (a, b] whose offset differs from the offset at a.
function change(zone, a, b) {
  const o = offsetMin(zone, a * 1000);
  while (b - a > 1) {
    const m = Math.floor((a + b) / 2);
    if (offsetMin(zone, m * 1000) === o) a = m; else b = m;
  }
  return b;
}

// The local day `day` (YYYY-MM-DD) of zone as UTC seconds [lo, hi): o1 is the offset in
// minutes before ch and o2 from ch on. On a day without a change, ch = hi and o2 = o1; a
// day of 23 or 25 hours is exact.
export function dayBounds(zone, day) {
  const key = zone + ' ' + day, cached = days.get(key);
  if (cached) return { ...cached };
  const t = Date.parse(day + 'T00:00:00Z') / 1000;
  const lo = startOf(zone, t), hi = startOf(zone, t + DAY_S);
  const o1 = offsetMin(zone, lo * 1000), o2 = offsetMin(zone, (hi - 1) * 1000);
  const bounds = { lo, hi, o1, ch: o1 === o2 ? hi : change(zone, lo, hi - 1), o2 };
  if (days.size >= DAYS_CAP) days.clear();
  days.set(key, bounds);
  return { ...bounds };
}

// The offsets over the UTC seconds [lo, hi): { o, changes: [[ch, offset from ch on], ...] },
// o being the offset at lo. For queries over many days: the wall clock is read once a day
// (a change and its return within one day never happens), then each change to the second.
// Over years of days, stepDays 7 reads it once a week: no zone's rules change its offset
// and back within a week (the shortest such span, Morocco's Ramadan hour, is about a month).
export function offsetsBetween(zone, lo, hi, stepDays = 1) {
  const o = offsetMin(zone, lo * 1000), changes = [];
  let at = lo, last = o;
  while (at < hi - 1) {
    const next = Math.min(at + stepDays * DAY_S, hi - 1), now = exact(zone, next * 1000);
    if (now !== last) {
      const ch = change(zone, at, next);
      changes.push([ch, offsetMin(zone, ch * 1000)]);
      last = now;
    }
    at = next;
  }
  return { o, changes };
}

export const weekStartOf = zone => SUNDAY.has(zone) ? 'sun' : 'mon';
