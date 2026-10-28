/*
 * ZIP files for the research download (docs/RESEARCH_TELEMETRY_SPEC.md, §F.6), built from
 * Blobs so that no file is ever held as one giant string. crc32() and the header layout
 * are those of js/teacher.js zip(), copied because server/ stays self-contained; here the
 * CRC streams over a Blob's chunks, and each entry is deflated with
 * CompressionStream('deflate-raw') where the browser has it (stored as it is otherwise, or
 * when deflating does not make it smaller). An entry or archive past 4 GB (ZIP64) is
 * refused. window.SGZip in the page; Node loads it as a plain script (module.exports),
 * where Blob and CompressionStream exist too.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.SGZip = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  var LIMIT = 0xffffffff;
  var crcTable = null;

  // The CRC-32 of bytes; pass the CRC of the bytes before them to go on from there.
  function crc32(bytes, crc) {
    if (!crcTable) {
      crcTable = [];
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var x = crc === undefined ? -1 : crc ^ -1;
    for (var i = 0; i < bytes.length; i++) x = crcTable[(x ^ bytes[i]) & 255] ^ (x >>> 8);
    return (x ^ -1) >>> 0;
  }
  // The CRC-32 of a Blob, chunk by chunk.
  function blobCrc(blob) {
    var reader = blob.stream().getReader(), crc = 0;
    function next() {
      return reader.read().then(function (r) {
        if (r.done) return crc;
        crc = crc32(r.value, crc);
        return next();
      });
    }
    return next();
  }
  // Whether this browser deflates (CompressionStream with 'deflate-raw').
  function canDeflate() {
    try { return typeof CompressionStream === 'function' && !!new CompressionStream('deflate-raw'); } catch (e) { return false; }
  }
  function deflate(blob) {
    return new Response(blob.stream().pipeThrough(new CompressionStream('deflate-raw'))).blob();
  }
  var encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  // A ZIP of entries [{ name, blob }] (names may be Arabic: they are written as UTF-8),
  // dated `when` (a Date, the local time of the files), deflated unless options.store.
  // options.onEntry(i, n) follows the entries. Resolves to a Blob of type application/zip.
  function zip(entries, options) {
    var o = options || {}, when = o.when && o.when.getFullYear() >= 1980 ? o.when : new Date(1980, 0, 1);
    var dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    var dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    var compress = !o.store && canDeflate();
    var parts = [], items = [], offset = 0;
    function header(it, central) {
      var size = (central ? 46 : 30) + it.name.length, out = new Uint8Array(size), view = new DataView(out.buffer), pos = 0;
      var u16 = function (v) { view.setUint16(pos, v, true); pos += 2; };
      var u32 = function (v) { view.setUint32(pos, v, true); pos += 4; };
      u32(central ? 0x02014b50 : 0x04034b50);
      if (central) u16(20);                      // made by: version 2.0
      u16(20); u16(0x0800); u16(it.method);       // version needed, UTF-8 names, stored (0) or deflated (8)
      u16(dosTime); u16(dosDate); u32(it.crc); u32(it.packed); u32(it.size);
      u16(it.name.length); u16(0);               // name length, no extra field
      if (central) { u16(0); u16(0); u16(0); u32(0); u32(it.offset); }
      out.set(it.name, pos);
      return out;
    }
    var i = 0;
    function step() {
      if (i >= entries.length) return Promise.resolve();
      var e = entries[i], blob = e.blob instanceof Blob ? e.blob : new Blob([e.blob == null ? '' : e.blob]);
      if (o.onEntry) o.onEntry(i, entries.length);
      if (blob.size >= LIMIT) return Promise.reject(new Error('zip: ' + e.name + ' is too big for a ZIP file'));
      return blobCrc(blob).then(function (crc) {
        return (compress && blob.size ? deflate(blob) : Promise.resolve(null)).then(function (packed) {
          var data = packed && packed.size < blob.size ? packed : blob;
          var it = { name: encoder.encode(e.name), crc: crc, size: blob.size, packed: data.size, method: data === blob ? 0 : 8, offset: offset };
          var local = header(it, false);
          offset += local.length + data.size;
          if (offset >= LIMIT) throw new Error('zip: the download is too big for a ZIP file');
          parts.push(local, data);
          items.push(it);
          i++;
          return step();
        });
      });
    }
    return step().then(function () {
      var start = offset, central = items.map(function (it) { return header(it, true); });
      var length = central.reduce(function (a, b) { return a + b.length; }, 0);
      var end = new Uint8Array(22), view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true);
      view.setUint16(8, items.length, true); view.setUint16(10, items.length, true);
      view.setUint32(12, length, true); view.setUint32(16, start, true);
      return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
    });
  }

  return Object.freeze({ crc32: crc32, blobCrc: blobCrc, canDeflate: canDeflate, zip: zip });
}));
