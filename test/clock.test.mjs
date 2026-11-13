// The school's clock (server/clock.mjs): offsets, local days and the bounds of local days
// in IANA zones, including days of 23 and 25 hours and midnights that do not exist,
// checked against Intl read directly (no cache).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { isZone, zoneName, offsetMin, localDay, localParts, dayBounds, offsetsBetween, weekStartOf } = await import('../clock.mjs');

const at = iso => Date.parse(iso);
const sec = iso => Date.parse(iso) / 1000;
// The wall clock of zone at ms, read with formatToParts and no cache of offsets.
const formats = new Map();
function reference(zone, ms) {
  const p = {};
  const f = formats.get(zone) || formats.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric',
    month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })).get(zone);
  for (const { type, value } of f.formatToParts(ms)) p[type] = value;
  const t = Math.floor(ms / 1000) * 1000, wall = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return { offset: Math.round((wall - t) / 60000), day: new Date(wall).toISOString().slice(0, 10), hour: +p.hour, minute: +p.minute,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const ZONES = ['UTC', 'Asia/Riyadh', 'Europe/London', 'America/New_York', 'America/Santiago', 'Asia/Beirut', 'Asia/Kathmandu',
  'Australia/Lord_Howe', 'Pacific/Chatham', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];

test('offsets follow each zone\'s rules to the second, around both changes of the year', () => {
  assert.equal(offsetMin('UTC', at('2026-07-01T12:00:00Z')), 0);
  assert.equal(offsetMin('Asia/Riyadh', at('2026-01-15T03:00:00Z')), 180);
  assert.equal(offsetMin('Asia/Riyadh', at('2026-07-15T03:00:00Z')), 180);
  assert.equal(offsetMin('Asia/Kathmandu', at('2026-10-27T10:00:00Z')), 345);
  assert.equal(offsetMin('America/New_York', at('2026-01-15T12:00:00Z')), -300);
  assert.equal(offsetMin('America/New_York', at('2026-07-15T12:00:00Z')), -240);
  // Europe/London leaves summer time at 01:00 UTC on 25 October 2026 and starts it at 01:00 UTC on 29 March.
  assert.equal(offsetMin('Europe/London', at('2026-10-25T00:59:59Z')), 60);
  assert.equal(offsetMin('Europe/London', at('2026-10-25T01:00:00Z')), 0);
  assert.equal(offsetMin('Europe/London', at('2026-03-29T00:59:59.999Z')), 0);
  assert.equal(offsetMin('Europe/London', at('2026-03-29T01:00:00Z')), 60);
  // Lord Howe Island moves its clock by half an hour.
  assert.equal(offsetMin('Australia/Lord_Howe', at('2026-01-15T00:00:00Z')), 660);
  assert.equal(offsetMin('Australia/Lord_Howe', at('2026-07-15T00:00:00Z')), 630);
});

test('cached offsets and local parts agree with Intl read directly, all through a year in many zones', () => {
  const start = at('2026-01-01T00:00:00Z');
  for (const zone of ZONES) {
    // Every 41 minutes and 13 seconds, so the samples fall on every second of the quarter hour in turn.
    for (let ms = start; ms < start + 366 * 86400000; ms += 41 * 60000 + 13000) {
      const ref = reference(zone, ms);
      assert.equal(offsetMin(zone, ms), ref.offset);
      assert.deepEqual(localParts(zone, ms), { day: ref.day, hour: ref.hour, minute: ref.minute, weekday: ref.weekday }, zone + ' ' + new Date(ms).toISOString());
      assert.equal(localDay(zone, ms), ref.day);
    }
  }
  // Each second around a change, in both directions.
  for (const [zone, iso] of [['Europe/London', '2026-10-25T01:00:00Z'], ['Europe/London', '2026-03-29T01:00:00Z'],
    ['America/Santiago', '2026-09-06T04:00:00Z'], ['Australia/Lord_Howe', '2026-10-03T15:30:00Z']]) {
    for (let ms = at(iso) - 3000; ms <= at(iso) + 3000; ms += 500) assert.equal(offsetMin(zone, ms), reference(zone, ms).offset, zone + ' ' + ms);
  }
});

test('local days follow the school\'s zone: 21:30 UTC is already tomorrow in Riyadh', () => {
  const ms = at('2026-10-27T21:30:00Z');
  assert.equal(localDay('UTC', ms), '2026-10-27');
  assert.equal(localDay('Asia/Riyadh', ms), '2026-10-28');
  assert.deepEqual(localParts('Asia/Riyadh', ms), { day: '2026-10-28', hour: 0, minute: 30, weekday: 3 });
  assert.deepEqual(localParts('America/New_York', ms), { day: '2026-10-27', hour: 17, minute: 30, weekday: 2 });
  assert.equal(localDay('Asia/Riyadh', at('2026-10-27T20:59:59Z')), '2026-10-27');
  assert.equal(localDay('Asia/Riyadh', at('2026-10-27T21:00:00Z')), '2026-10-28');
});

test('day bounds: a plain day, the 25-hour and 23-hour days of Europe/London, and midnights that do not exist', () => {
  assert.deepEqual(dayBounds('UTC', '2026-10-27'), { lo: sec('2026-10-27T00:00:00Z'), hi: sec('2026-10-28T00:00:00Z'), o1: 0, ch: sec('2026-10-28T00:00:00Z'), o2: 0 });
  assert.deepEqual(dayBounds('Asia/Riyadh', '2026-10-28'),
    { lo: sec('2026-10-27T21:00:00Z'), hi: sec('2026-10-28T21:00:00Z'), o1: 180, ch: sec('2026-10-28T21:00:00Z'), o2: 180 });
  const autumn = dayBounds('Europe/London', '2026-10-25');
  assert.deepEqual(autumn, { lo: sec('2026-10-24T23:00:00Z'), hi: sec('2026-10-26T00:00:00Z'), o1: 60, ch: sec('2026-10-25T01:00:00Z'), o2: 0 });
  assert.equal(autumn.hi - autumn.lo, 25 * 3600);
  const spring = dayBounds('Europe/London', '2026-03-29');
  assert.deepEqual(spring, { lo: sec('2026-03-29T00:00:00Z'), hi: sec('2026-03-29T23:00:00Z'), o1: 0, ch: sec('2026-03-29T01:00:00Z'), o2: 60 });
  assert.equal(spring.hi - spring.lo, 23 * 3600);
  // The days on either side are 24 hours and meet them exactly.
  assert.equal(dayBounds('Europe/London', '2026-10-24').hi, autumn.lo);
  assert.equal(dayBounds('Europe/London', '2026-10-26').lo, autumn.hi);
  // Chile jumps from 23:59:59 to 01:00 on 6 September 2026: that day starts at 01:00 local.
  const chile = dayBounds('America/Santiago', '2026-09-06');
  assert.deepEqual(chile, { lo: sec('2026-09-06T04:00:00Z'), hi: sec('2026-09-07T03:00:00Z'), o1: -180, ch: sec('2026-09-07T03:00:00Z'), o2: -180 });
  assert.deepEqual(localParts('America/Santiago', chile.lo * 1000), { day: '2026-09-06', hour: 1, minute: 0, weekday: 0 });
  assert.equal(localDay('America/Santiago', chile.lo * 1000 - 1000), '2026-09-05');
  assert.deepEqual(dayBounds('America/Santiago', '2026-09-05'),
    { lo: sec('2026-09-05T04:00:00Z'), hi: chile.lo, o1: -240, ch: chile.lo, o2: -240 });
  // Beirut does the same on 29 March 2026.
  assert.deepEqual(dayBounds('Asia/Beirut', '2026-03-29'),
    { lo: sec('2026-03-28T22:00:00Z'), hi: sec('2026-03-29T21:00:00Z'), o1: 180, ch: sec('2026-03-29T21:00:00Z'), o2: 180 });
  // A copy is returned, so a caller cannot change the cached bounds.
  dayBounds('UTC', '2026-10-27').lo = 0;
  assert.equal(dayBounds('UTC', '2026-10-27').lo, sec('2026-10-27T00:00:00Z'));
});

test('every instant of a year lies in the bounds of its own local day, and the SQL offset rule gives its wall clock', () => {
  for (const zone of ['Europe/London', 'America/New_York', 'Asia/Riyadh', 'Australia/Lord_Howe', 'America/Santiago', 'Pacific/Chatham']) {
    const seen = new Map();
    for (let s = sec('2026-01-01T00:00:00Z'); s < sec('2027-01-01T00:00:00Z'); s += 3607) {
      const day = localDay(zone, s * 1000);
      const b = seen.get(day) || seen.set(day, dayBounds(zone, day)).get(day);
      assert.ok(s >= b.lo && s < b.hi, `${zone} ${new Date(s * 1000).toISOString()} in ${day}`);
      // start_s + t + (CASE WHEN start_s + t >= ?ch THEN ?o2 ELSE ?o1 END) * 60, as the store binds it.
      const wall = new Date((s + (s >= b.ch ? b.o2 : b.o1) * 60) * 1000);
      const ref = reference(zone, s * 1000);
      assert.deepEqual([wall.toISOString().slice(0, 10), wall.getUTCHours(), wall.getUTCMinutes()], [ref.day, ref.hour, ref.minute], zone);
    }
    // Consecutive days meet exactly, and every day is 23, 23.5, 24, 24.5 or 25 hours long.
    const days = [...seen.keys()].sort();
    for (let i = 1; i < days.length; i++) assert.equal(seen.get(days[i - 1]).hi, seen.get(days[i]).lo, zone + ' ' + days[i]);
    for (const b of seen.values()) assert.ok([23, 23.5, 24, 24.5, 25].includes((b.hi - b.lo) / 3600), zone);
  }
});

test('offsetsBetween finds each change of a range to the second', () => {
  const lo = dayBounds('Europe/London', '2026-01-01').lo, hi = dayBounds('Europe/London', '2026-12-31').hi;
  assert.deepEqual(offsetsBetween('Europe/London', lo, hi),
    { o: 0, changes: [[sec('2026-03-29T01:00:00Z'), 60], [sec('2026-10-25T01:00:00Z'), 0]] });
  assert.deepEqual(offsetsBetween('Asia/Riyadh', sec('2026-01-01T00:00:00Z'), sec('2027-01-01T00:00:00Z')), { o: 180, changes: [] });
  assert.deepEqual(offsetsBetween('Europe/London', sec('2026-10-25T01:00:00Z'), sec('2026-10-26T00:00:00Z')), { o: 0, changes: [] });
  assert.deepEqual(offsetsBetween('Europe/London', sec('2026-10-25T00:59:59Z'), sec('2026-10-25T01:00:01Z')),
    { o: 60, changes: [[sec('2026-10-25T01:00:00Z'), 0]] });
  // Read once a week over years (the admin reads' clock for every stored second), the same changes, Morocco's Ramadan hour included.
  for (const zone of ['Europe/London', 'America/New_York', 'Australia/Lord_Howe', 'Africa/Casablanca', 'Asia/Riyadh', 'Pacific/Chatham']) {
    const from = sec('2024-01-01T00:00:00Z'), to = sec('2027-01-01T00:00:00Z');
    assert.deepEqual(offsetsBetween(zone, from, to, 7), offsetsBetween(zone, from, to), zone);
  }
  assert.ok(offsetsBetween('Africa/Casablanca', sec('2024-01-01T00:00:00Z'), sec('2027-01-01T00:00:00Z'), 7).changes.length >= 6);
});

test('the week starts on Sunday where schools do, and on Monday elsewhere', () => {
  for (const zone of ['Asia/Riyadh', 'Asia/Kuwait', 'Asia/Bahrain', 'Asia/Qatar', 'Asia/Baghdad', 'Asia/Amman', 'Asia/Muscat',
    'Asia/Aden', 'Asia/Damascus', 'Asia/Jerusalem', 'Asia/Gaza', 'Asia/Hebron', 'Africa/Cairo', 'Africa/Tripoli', 'Africa/Algiers']) {
    assert.equal(weekStartOf(zone), 'sun', zone);
  }
  for (const zone of ['UTC', 'Europe/London', 'Asia/Dubai', 'America/New_York', 'Africa/Casablanca', '']) assert.equal(weekStartOf(zone), 'mon', zone);
});

test('isZone accepts the zones this runtime knows, and nothing else', () => {
  for (const zone of ['UTC', 'Asia/Riyadh', 'Europe/London', 'America/Indiana/Indianapolis', 'America/Port-au-Prince', 'Etc/GMT+3']) {
    assert.equal(isZone(zone), Intl.supportedValuesOf('timeZone').includes(zone) || zone === 'UTC', zone);
  }
  assert.equal(isZone('Asia/Riyadh'), true);
  assert.equal(isZone('UTC'), true);
  for (const bad of ['', 'utc ', ' Asia/Riyadh', 'Asia/Riyadh\n', 'Mars/Olympus_Mons', 'Asia/Atlantis', 'constructor', 'toString',
    '__proto__', 'Europe/../etc', 'Europe//London', 'A/B/C/D/E/F/G', 'x'.repeat(41), 'Asia/Riyadh;DROP', 42, null, undefined, {}, ['UTC']]) {
    assert.equal(isZone(bad), false, String(bad));
  }
});

test('every name of UTC a browser may report is UTC; other zones keep their name, and unknown ones are none', () => {
  for (const z of ['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/UCT', 'Etc/Universal', 'Etc/Zulu', 'GMT0', 'Etc/GMT+0', 'Etc/GMT-0']) assert.equal(zoneName(z), 'UTC', z);
  for (const z of ['Asia/Riyadh', 'Europe/London', 'America/Port-au-Prince']) assert.equal(zoneName(z), z);
  for (const bad of ['Mars/Olympus_Mons', 'utc', 'Etc/UTC ', 'constructor', '', null, 42]) assert.equal(zoneName(bad), null, String(bad));
});

test('the zone data loads with the module, so no request pays for the first DateTimeFormat', async () => {
  const { spawnSync } = await import('node:child_process');
  // A new process: the first local day after the import, in a zone the module has not used.
  const script = "const c = await import(process.argv[1]); const t = performance.now(); c.localDay('Asia/Riyadh', Date.now()); " +
    'console.log(performance.now() - t);';
  const times = Array.from({ length: 3 }, () => Number(spawnSync(process.execPath, ['--input-type=module', '-e', script,
    new URL('../clock.mjs', import.meta.url).href], { encoding: 'utf8' }).stdout));
  assert.ok(Math.min(...times) < 5, times.map(t => t.toFixed(1)).join(', ') + ' ms');
});
