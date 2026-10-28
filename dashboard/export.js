/*
 * The research download (docs/RESEARCH_TELEMETRY_SPEC.md, §F.6): every page of each of the
 * server's research files (GET /v1/admin/export, at most 2,500 lines a page, without a
 * header), each file given its header from dictionary.js and a byte-order mark, plus
 * games.csv, dictionary.csv, README.txt, labels.sps and load.R, in one ZIP
 * (school-games-data_<from>_<to>.zip, zip.js). Files are kept as Blob parts page by page.
 * rounds.csv becomes rounds-YYYY-MM.csv when it has more than 500,000 rows (Excel stops at
 * 1,048,576). When the server's reading guard stops a download (429 "reads"), the files so
 * far become part 1 and the job says where it stopped, so the next part (tomorrow) goes on
 * from there: no row is in two parts. A network failure keeps what was fetched, and run()
 * again goes on. window.SGExport; the page draws it (data.js).
 */
(function () {
  'use strict';
  var D = window.SGDictionary, Z = window.SGZip;
  var FILES = D.SERVER_FILES;
  var BOM = '﻿';
  var SPLIT = 500000;
  // Export pages answer 429 once the day's reads pass this (server/README.md).
  var EXPORT_GUARD = 3500000;
  // The lines of an export page at most (server/export.mjs PAGE_LINES).
  var PAGE_LINES = 2500;
  var DAY_COLUMN = D.columns('rounds').indexOf('day');

  // How many lines the server's files will have, from the period's KPI answer, and what
  // reading them costs: { lines, rows (read), share (of the day's reading allowance), stops
  // (true when today's reads so far plus these pass the export guard) }.
  // D1 counts every table and index row a statement reads, and a line of server/export.mjs
  // reads far more than itself: a session line looks up its link, counts its visits twice,
  // its rounds and its marks; a visit line its session, link, previous and next visit, its
  // rounds twice and its session's heart and tutorial marks twice; a round or a mark line its
  // session, link and the round before or the visit; each students page reads every
  // student-day and student-game row of the period again, and each PCs page every session.
  // These are the rows those lookups match, so the estimate is a floor.
  function estimate(k, usage, days) {
    var t = k && k.totals || {}, st = t.students || {}, games = (k && k.games || []).filter(function (g) { return g && !g.suppressed; });
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : 0; };
    var levelUps = num(t.levelUps), others = 0;
    games.forEach(function (g) {
      others += num(g.hearts && g.hearts.on) + num(g.hearts && g.hearts.off) + num(g.tutorials && g.tutorials.start) + num(g.tutorials && g.tutorials.done);
    });
    var marks = levelUps + others, sessions = num(t.sessions), opens = num(t.gameOpens), rounds = Math.max(num(t.roundsStarted), num(t.roundsEnded));
    var students = num(st.active), studentDays = Math.max(0, sessions - num(st.guestSessions)), gameDays = games.length * Math.max(1, num(days));
    var pcs = num(k && k.quality && k.quality.pcsNew), perSession = sessions ? opens / sessions : 0;
    var pages = function (n) { return Math.max(1, Math.ceil(n / PAGE_LINES)); };
    var lines = students + sessions + opens + rounds + marks + studentDays + gameDays + pcs;
    var reads = {
      students: students * 3 + pages(students) * (studentDays + opens),
      sessions: sessions * 2 + opens * 2 + rounds + marks,
      visits: opens * 5 + rounds * 2 + 2 * others * perSession,
      rounds: rounds * 4,
      events: marks * 4,
      student_days: studentDays * 2,
      daily_games: gameDays,
      pcs: pcs * 2 + pages(pcs) * sessions
    };
    var rows = Math.round(FILES.reduce(function (a, f) { return a + (reads[f] || 0); }, 0)), u = usage || {}, limit = num(u.readsLimit) || 5000000;
    return { lines: Math.round(lines), rows: rows, share: rows / limit, stops: num(u.reads) + rows > EXPORT_GUARD };
  }

  // A download of the period. opts: { from, to, page(file, after) -> Promise<{ text, next }>,
  // part (1 when new), file and after (where an earlier part stopped), onProgress(p) }.
  // p: { file, rows (of that file), lines (all so far), done (files done) }.
  function Job(opts) {
    this.opts = opts;
    this.part = opts.part || 1;
    this.split = opts.split || SPLIT;
    this.index = Math.max(0, opts.file ? FILES.indexOf(opts.file) : 0);
    this.after = opts.after || null;
    this.started = this.index;
    this.files = {};     // file -> { parts: [text], months: { 'YYYY-MM': [text] }, monthRows: { 'YYYY-MM': n }, rows }
    this.lines = 0;
    this.stopped = null;
    this.cancelled = false;
  }
  Job.prototype.cancel = function () { this.cancelled = true; };
  // Fetches the pages left; resolves to 'done' or 'stopped' (the reading guard), rejects with
  // the page's failure (run() again goes on from the same page).
  Job.prototype.run = function () {
    var job = this;
    function next() {
      if (job.cancelled) return Promise.resolve('cancelled');
      if (job.index >= FILES.length) return Promise.resolve('done');
      var file = FILES[job.index];
      var into = job.files[file] || (job.files[file] = { parts: [], months: {}, monthRows: {}, rows: 0 });
      return job.opts.page(file, job.after).then(function (page) {
        var text = page.text || '';
        if (text) {
          var count = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
          into.rows += count; job.lines += count;
          if (file === 'rounds') {
            // The page's lines by the month of their day, one text per month and page.
            var byMonth = {};
            text.split('\n').forEach(function (line) {
              if (!line) return;
              var month = (line.split(',', DAY_COLUMN + 1)[DAY_COLUMN] || '').slice(0, 7);
              (byMonth[month] || (byMonth[month] = [])).push(line);
            });
            Object.keys(byMonth).forEach(function (m) {
              (into.months[m] || (into.months[m] = [])).push(byMonth[m].join('\n') + '\n');
              into.monthRows[m] = (into.monthRows[m] || 0) + byMonth[m].length;
            });
          } else into.parts.push(text);
        }
        if (page.next) job.after = page.next;
        else { job.index++; job.after = null; }
        if (job.opts.onProgress) job.opts.onProgress({ file: file, rows: into.rows, lines: job.lines, done: job.index - job.started });
        return next();
      }, function (f) {
        if (f && f.kind === 'busy' && f.body && f.body.error === 'reads') {
          job.stopped = { file: FILES[job.index], after: job.after, until: f.body.until || '' };
          return 'stopped';
        }
        throw f;
      });
    }
    return next();
  };
  // The files of this part: [{ name, blob, rows }] (the server's files, then the browser's).
  // extras: { games (gamesCsv info), readme (readme info without files and part) }.
  Job.prototype.entries = function (extras) {
    var job = this, out = [];
    var withHead = function (file, parts) { return new Blob([BOM + D.header(file) + '\n'].concat(parts)); };
    FILES.forEach(function (file, i) {
      var f = job.files[file];
      if (i < job.started || !f) return;
      if (file !== 'rounds') { out.push({ name: file + '.csv', blob: withHead(file, f.parts), rows: f.rows }); return; }
      var months = Object.keys(f.months).sort();
      if (f.rows > job.split) {
        months.forEach(function (m) { out.push({ name: 'rounds-' + m + '.csv', blob: withHead(file, f.months[m]), rows: f.monthRows[m] }); });
      } else {
        out.push({ name: 'rounds.csv', blob: withHead(file, [].concat.apply([], months.map(function (m) { return f.months[m]; }))), rows: f.rows });
      }
    });
    var names = out.map(function (e) { return e.name; });
    var x = extras || {};
    var info = Object.assign({}, x.readme || {}, { files: out.map(function (e) { return { name: e.name, rows: e.rows }; }), part: job.part,
      stopped: job.stopped ? { file: job.stopped.file } : null });
    var games = D.gamesCsv(x.games || {}), dictionary = D.dictionaryCsv();
    out.push({ name: 'games.csv', blob: new Blob([BOM + games]), rows: games.split('\n').length - 2 });
    out.push({ name: 'dictionary.csv', blob: new Blob([BOM + dictionary]), rows: dictionary.split('\n').length - 2 });
    out.push({ name: 'README.txt', blob: new Blob([BOM + D.readme(info)]) });
    out.push({ name: 'labels.sps', blob: new Blob([BOM + D.spss(names.concat(['games.csv', 'dictionary.csv']))]) });
    out.push({ name: 'load.R', blob: new Blob([D.rLoader(names.concat(['games.csv', 'dictionary.csv']))]) });
    return out;
  };
  // The ZIP of this part, and its name.
  Job.prototype.zip = function (extras, when) {
    var o = this.opts, name = 'school-games-data_' + o.from + '_' + o.to + (this.part > 1 ? '_part' + this.part : '') + '.zip';
    var entries = this.entries(extras);
    return Z.zip(entries, { when: when }).then(function (blob) { return { name: name, blob: blob, entries: entries }; });
  };

  window.SGExport = { FILES: FILES, SPLIT: SPLIT, EXPORT_GUARD: EXPORT_GUARD, estimate: estimate, job: function (opts) { return new Job(opts); } };
}());
