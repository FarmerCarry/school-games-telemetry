/*
 * The Data & settings tab (#/data): the research files (export.js: every row of the
 * period in a ZIP, with its cost first, a progress bar, and a part 2 tomorrow when the
 * day's reading allowance runs out), the data dictionary (dictionary.js), the server's
 * settings (the school's clock, the first day of the week, how long data is kept, a full
 * recount), one child's data (find a code, then forget or link it, each asking twice) and
 * the meters (the free plan's daily allowance, the database size) with the data-quality
 * panel. Data: GET and POST /v1/admin/settings, POST /v1/admin/rebuild, /v1/admin/kpis
 * (the cost and the quality), /v1/admin/export, and /v1/admin/student or students to find
 * a code. The sample data changes nothing, and its research files are demo/export-*.csv.
 */
(function () {
  'use strict';
  var tabs = window.SGTabs = window.SGTabs || {};
  var SAVED = 'sg:dash:export';
  // The download in progress (it outlives a redraw of the tab): { job, from, to, phase:
  // 'fetch' | 'zip' | 'done' | 'stopped' | 'failed' | 'cancelled', progress, result, failure }.
  var current = null;

  tabs.data = {
    load: function (ctx) {
      var settings = ctx.demo() ? ctx.get('settings', {}) : ctx.request('/v1/admin/settings');
      return Promise.all([settings, ctx.part(ctx.get('kpis', {}))]).then(function (x) {
        ctx.state.settings = x[0];
        return { settings: x[0], kpis: x[1] };
      });
    },
    render: function (ctx, view, data) {
      var T = ctx.t();
      ctx.section(view, 'data-intro', T.tabs.data, T.introData);
      research(ctx, view, data);
      dictionary(ctx, view);
      settings(ctx, view, data.settings);
      meters(ctx, view, data.settings);
      quality(ctx, view, data.kpis);
    }
  };

  // ---- the research files ---------------------------------------------------------------
  function loadSaved(ctx) {
    try {
      var s = JSON.parse(ctx.store.load(SAVED) || 'null');
      return s && s.v === 1 && ctx.R.isDay(s.from) && ctx.R.isDay(s.to) && window.SGExport.FILES.indexOf(s.file) >= 0 && s.part > 1 ? s : null;
    } catch (e) { return null; }
  }
  function sizeText(ctx, bytes) {
    var T = ctx.t();
    return bytes >= 1e6 ? T.sizeMb(ctx.I.short(bytes / 1e6)) : T.sizeKb(Math.max(1, Math.round(bytes / 1e3)));
  }
  // The school's date and time now, 'YYYY-MM-DD HH:MM', for README.txt.
  function schoolNow(tz) {
    try {
      var p = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
    } catch (e) { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
  }
  // What games.csv and README.txt need besides the rows.
  function extras(ctx, data, from, to) {
    var k = ctx.failed(data.kpis) ? null : data.kpis, levels = {};
    var ids = {};
    (k && k.levels || []).forEach(function (l) { if (l && l.slug) (ids[l.slug] = ids[l.slug] || {})[l.id] = true; });
    Object.keys(ids).forEach(function (slug) { levels[slug] = Object.keys(ids[slug]).length; });
    var c = data.settings && data.settings.clock || {};
    return {
      games: { games: window.SG_GAME_NAMES || {}, about: window.SG_GAME_INFO || {}, scores: window.SG_SCORES || {}, levels: levels },
      readme: { from: from, to: to, tz: c.tz || 'UTC', exported: schoolNow(c.tz), factsSince: c.factsSince || '', legacyUntil: c.legacyUntil || '',
        v3Since: c.v3Since || '', sample: ctx.demo() }
    };
  }
  // One page of a file: the server's, or in the sample the whole of demo/export-<file>.csv.
  function pageOf(ctx, from, to) {
    if (ctx.demo()) {
      return function (file) {
        return fetch('demo/export-' + file + '.csv', { cache: 'no-cache' }).then(function (res) {
          if (!res.ok) throw { kind: 'server', status: res.status };
          return res.text();
        }, function () { throw { kind: 'network' }; }).then(function (text) { return { text: text, next: null }; });
      };
    }
    return function (file, after) {
      return ctx.requestPage('/v1/admin/export?file=' + file + '&from=' + from + '&to=' + to + (after ? '&after=' + encodeURIComponent(after) : ''));
    };
  }
  function start(ctx, data, opts) {
    var from = opts.from, to = opts.to;
    var job = window.SGExport.job({ from: from, to: to, part: opts.part || 1, file: opts.file, after: opts.after, page: pageOf(ctx, from, to),
      onProgress: function (p) { if (current && current.job === job) { current.progress = p; drawProgress(ctx); } } });
    current = { job: job, from: from, to: to, phase: 'fetch', progress: null, result: null, failure: null, estimate: opts.estimate || null };
    ctx.renderView();
    go(ctx, data, job);
  }
  function go(ctx, data, job) {
    job.run().then(function (how) {
      if (!current || current.job !== job) return;
      if (how === 'cancelled') { current.phase = 'cancelled'; ctx.renderView(); return; }
      current.phase = 'zip';
      drawProgress(ctx);
      return job.zip(extras(ctx, data, current.from, current.to), new Date()).then(function (result) {
        if (!current || current.job !== job) return;
        current.result = result;
        current.url = URL.createObjectURL(result.blob);
        if (how === 'stopped' && !ctx.demo()) {
          current.phase = 'stopped';
          ctx.store.save(SAVED, JSON.stringify({ v: 1, from: current.from, to: current.to, part: job.part + 1, file: job.stopped.file, after: job.stopped.after,
            day: ctx.today(), until: job.stopped.until }));
        } else {
          current.phase = 'done';
          ctx.store.save(SAVED, null);
        }
        ctx.renderView();
        save(current.url, result.name);
      });
    }).catch(function (f) {
      if (!current || current.job !== job) return;
      if (f && f.kind === 'wrong') { ctx.refreshView(); return; }
      current.phase = 'failed';
      current.failure = f;
      ctx.renderView();
    });
  }
  function save(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function drawProgress(ctx) {
    var bar = document.getElementById('exportBar'), text = document.getElementById('exportStatus');
    if (!bar || !text || !current) return;
    var T = ctx.t(), p = current.progress, est = current.estimate;
    if (current.phase === 'zip') { bar.removeAttribute('value'); text.textContent = T.exportZipping; return; }
    var share = p && est && est.lines ? Math.min(0.99, p.lines / est.lines) : 0;
    bar.value = Math.round(share * 100);
    text.textContent = p ? T.exportProgress(p.file + '.csv', p.rows, ctx.I.pct(share)) : T.exportStarting;
  }
  function research(ctx, parent, data) {
    var T = ctx.t(), h = ctx.h, I = ctx.I, D = window.SGDictionary, E = window.SGExport;
    var sec = ctx.section(parent, 'research-files', T.filesTitle, T.filesIntro);
    var box = h('div', { class: 'card export-card', id: 'export-card' }, sec);
    var r = ctx.range(), from = ctx.demo() ? ctx.today() : r.from, to = ctx.demo() ? ctx.today() : r.to;
    h('p', null, box, T.filesPeriod(r.from === r.to && !ctx.demo() ? ctx.longDay(r.from) : ctx.longDay(from) + (from === to ? '' : ' – ' + ctx.longDay(to))));
    if (ctx.demo()) ctx.note(box, T.exportDemo);
    var ul = h('ul', { class: 'file-list' }, box);
    E.FILES.concat(['games', 'dictionary']).forEach(function (f) {
      var li = h('li', null, ul);
      h('code', { dir: 'ltr' }, li, f + '.csv');
      li.appendChild(document.createTextNode(': ' + T.dictOne(D.file(f).one[ctx.lang() === 'ar' ? 1 : 0])));
    });
    h('li', null, ul).textContent = T.filesOthers;
    var est = ctx.failed(data.kpis) ? null : E.estimate(data.kpis, data.settings && data.settings.usage, r.days);
    var saved = ctx.demo() ? null : loadSaved(ctx);
    var busy = current && (current.phase === 'fetch' || current.phase === 'zip');
    if (saved && !busy && !(current && current.phase === 'stopped')) {
      var resume = h('div', { class: 'resume', id: 'exportResume', role: 'note' }, box);
      h('p', null, resume, T.exportResume(ctx.longDay(saved.from) + ' – ' + ctx.longDay(saved.to), saved.file + '.csv', ctx.longDay(saved.day), saved.part));
      var more = h('button', { type: 'button', class: 'btn-primary', id: 'exportContinue', 'data-focus': 'export:continue' }, resume, T.exportContinue(saved.part));
      more.addEventListener('click', function () { start(ctx, data, { from: saved.from, to: saved.to, part: saved.part, file: saved.file, after: saved.after, estimate: est }); });
      var drop = h('button', { type: 'button', class: 'btn-link', 'data-focus': 'export:forget' }, resume, T.exportForgetPart);
      drop.addEventListener('click', function () { ctx.store.save(SAVED, null); ctx.renderView(); });
    }
    if (est && !busy) {
      h('p', { class: 'export-cost', id: 'exportCost' }, box, T.exportCost(est.rows, I.pct(est.share)));
      if (est.stops && !ctx.demo()) ctx.note(box, T.exportStops);
    }
    var actions = h('div', { class: 'export-actions' }, box);
    if (!busy) {
      var b = h('button', { type: 'button', class: 'btn-primary', id: 'exportBtn', 'data-focus': 'export:start' }, actions, T.exportStart);
      b.addEventListener('click', function () { start(ctx, data, { from: from, to: to, estimate: est }); });
    }
    if (!current) return;
    var status = h('div', { class: 'export-status' }, box);
    if (busy) {
      h('progress', { id: 'exportBar', max: '100', value: '0', 'aria-labelledby': 'exportStatus' }, status);
      h('p', { id: 'exportStatus', role: 'status' }, status, '');
      var stop = h('button', { type: 'button', class: 'btn-quiet', id: 'exportStop', 'data-focus': 'export:stop' }, status, T.exportCancel);
      stop.addEventListener('click', function () { current.job.cancel(); });
      drawProgress(ctx);
      return;
    }
    var res = current.result;
    if (current.phase === 'done' || current.phase === 'stopped') {
      var p = h('p', { role: 'status', class: current.phase === 'done' ? 'done' : 'warn' }, status,
        current.phase === 'done' ? T.exportDone(res.name, sizeText(ctx, res.blob.size)) :
          T.exportStopped(current.job.part, current.job.stopped.until || '00:00', res.name, sizeText(ctx, res.blob.size)));
      p.id = 'exportResult';
      h('a', { href: current.url, download: res.name, class: 'btn-quiet', id: 'exportSave', 'data-focus': 'export:save' }, status, T.exportSave);
    } else if (current.phase === 'failed') {
      h('p', { class: 'field-error', role: 'alert', id: 'exportResult' }, status, ctx.failureText(current.failure));
      var again = h('button', { type: 'button', class: 'btn-quiet', id: 'exportAgain', 'data-focus': 'export:again' }, status, T.exportAgain);
      var job = current.job;
      again.addEventListener('click', function () { current.phase = 'fetch'; current.failure = null; ctx.renderView(); go(ctx, data, job); });
    } else if (current.phase === 'cancelled') {
      h('p', { role: 'status', id: 'exportResult' }, status, T.exportCancelled);
    }
  }

  // ---- the data dictionary ------------------------------------------------------------------
  function dictionary(ctx, parent) {
    var T = ctx.t(), h = ctx.h, C = ctx.C, D = window.SGDictionary, ar = ctx.lang() === 'ar';
    var sec = ctx.section(parent, 'dictionary', T.dictTitle, T.dictIntro);
    var box = h('div', { class: 'card', id: 'dictionary-card' }, sec);
    var files = D.FILES.map(function (f) { return f.file; });
    var pick = ctx.state.choice.dictFile && files.indexOf(ctx.state.choice.dictFile) >= 0 ? ctx.state.choice.dictFile : files[0];
    var row = h('div', { class: 'field dict-pick' }, box);
    h('label', { for: 'dictFile' }, row, T.dictFile);
    var select = h('select', { id: 'dictFile', 'data-focus': 'dict:file', dir: 'ltr' }, row);
    files.forEach(function (f) { h('option', { value: f, selected: f === pick }, select, f + '.csv'); });
    select.addEventListener('change', function () { ctx.state.choice.dictFile = select.value; ctx.renderView(); });
    var f = D.file(pick);
    ctx.note(box, T.dictOne(f.one[ar ? 1 : 0]));
    // A table on a wide screen; on a phone each column of the file is a block of its own.
    var wrap = h('div', { class: 'table-wrap' }, box);
    var table = h('table', { class: 'data dictionary' }, wrap);
    h('caption', { class: 'sr-only' }, table, T.dictTitle + ': ' + pick + '.csv');
    var labels = [T.dictColumn, T.dictType, T.dictUnit, T.dictValues, T.dictMeaning, T.dictSource, T.dictAvailable];
    var hr = h('tr', null, h('thead', null, table));
    labels.forEach(function (label) { h('th', { scope: 'col' }, hr, label); });
    var body = h('tbody', null, table);
    f.columns.forEach(function (col) {
      var tr = h('tr', null, body);
      h('span', { dir: 'ltr' }, h('th', { scope: 'row', class: 'dict-name' }, tr), col[0]);
      // Units, values and sources are the files' own tokens: they read left to right.
      [T.dictTypes[col[1]] || col[1], col[2], col[3], ar ? col[5] : col[4], col[6], T.available[col[7]] || col[7]].forEach(function (v, i) {
        var token = i === 1 || i === 2 || i === 4;
        var td = h('td', { 'data-label': labels[i + 1], class: (i === 3 ? 'dict-meaning' : '') + (v ? '' : ' is-empty') || null }, tr, token ? null : v);
        if (token) h('span', { dir: 'ltr' }, td, v);
      });
    });
  }

  // ---- settings -------------------------------------------------------------------------------
  function settings(ctx, parent, s) {
    var T = ctx.t(), h = ctx.h, I = ctx.I;
    var sec = ctx.section(parent, 'settings', T.settingsTitle);
    var grid = h('div', { class: 'settings' }, sec);
    // The school's clock: the zones the PCs report, one click.
    var clock = h('div', { class: 'card setting', id: 'setting-clock' }, grid);
    var c = s.clock || {};
    h('p', null, clock, T.clockNow(c.tz || 'UTC', T.clockSource[c.source] || ''));
    if (ctx.demo()) ctx.note(clock, T.demoAction);
    else ctx.zonePicker(clock, 'settingsClock', null);
    // The first day of the week (rows of the heatmaps, weekly charts).
    var week = h('div', { class: 'card setting', id: 'setting-week' }, grid);
    h('h3', { class: 'card-title', id: 'weekStartLabel' }, week, T.weekStartTitle);
    h('p', { class: 'note' }, week, c.weekSource === 'owner' ? T.weekChosen : T.weekAuto);
    choiceRow(ctx, week, 'weekStart', [{ value: 'sun', text: T.sunday }, { value: 'mon', text: T.monday }], c.weekStart, function (v) {
      return { weekStart: v };
    }, 'weekStartLabel');
    // How long the play records are kept.
    var keep = h('div', { class: 'card setting', id: 'setting-keep' }, grid);
    h('h3', { class: 'card-title', id: 'keepLabel' }, keep, T.keepTitle);
    var k = s.keep || {};
    h('p', { class: 'note' }, keep, T.keepNow(I.int(k.days || 400), I.int(k.rollupDays || 800)));
    choiceRow(ctx, keep, 'keepDays', [{ value: 400, text: T.keepOne }, { value: 760, text: T.keepTwo }], k.days, function (v) {
      return { keepDays: v };
    }, 'keepLabel');
    rebuild(ctx, grid, s);
    child(ctx, grid);
  }
  // When each one-click setting was last saved ({ id: ms }): "Saved." shows for a minute,
  // across the redraw that follows.
  var saved = {};
  // A one-click setting: POST /v1/admin/settings with the chosen value; the answer is the
  // new settings, and the note under the buttons says how it went.
  function choiceRow(ctx, parent, id, items, current, body, labelId) {
    var h = ctx.h, T = ctx.t();
    var group = h('div', { class: 'seg', role: 'group', 'aria-labelledby': labelId }, parent);
    var status = h('p', { class: 'note setting-note', role: 'status', id: 'note-' + id }, parent, saved[id] > Date.now() - 60000 ? T.settingSaved : '');
    items.forEach(function (item) {
      var b = h('button', { type: 'button', 'aria-pressed': String(item.value === current), 'data-value': String(item.value), 'data-focus': 'set:' + id + ':' + item.value,
        disabled: ctx.demo() ? true : null }, group, item.text);
      b.addEventListener('click', function () {
        if (item.value === current) return;
        b.disabled = true;
        ctx.request('/v1/admin/settings', 'POST', body(item.value)).then(function (next) {
          ctx.state.settings = next;
          saved[id] = Date.now();
          ctx.loadSettings();
          ctx.refreshView();
        }, function (f) {
          b.disabled = false;
          status.textContent = f && f.kind === 'server' && f.body && f.body.error === 'storage' ? T.keepTooBig : f && f.kind === 'busy' ? ctx.failureText(f) : T.settingFailed;
        });
      });
    });
  }
  // Recount all days (asks twice; shows the progress).
  function rebuild(ctx, grid, s) {
    var T = ctx.t(), h = ctx.h;
    var box = h('div', { class: 'card setting', id: 'setting-rebuild' }, grid);
    h('h3', { class: 'card-title' }, box, T.rebuildTitle);
    h('p', { class: 'note' }, box, T.rebuildIntro);
    var rb = s.rebuild || {};
    if (Number(rb.pending) > 0) h('p', { class: 'clock-note', role: 'status' }, box, T.rebuildProgress(Number(rb.done) || 0, (Number(rb.done) || 0) + Number(rb.pending), false));
    if (ctx.demo()) { ctx.note(box, T.demoAction); return; }
    var go = h('button', { type: 'button', class: 'btn-quiet', id: 'rebuildBtn', 'data-focus': 'rebuild' }, box, T.rebuildAction);
    var step = h('div', { class: 'link-step' }, box);
    go.addEventListener('click', function () {
      step.textContent = '';
      h('p', { class: 'warn' }, step, T.rebuildSure);
      var yes = h('button', { type: 'button', class: 'btn-quiet btn-danger', id: 'rebuildYes', 'data-focus': 'rebuild:yes' }, step, T.rebuildDo);
      h('button', { type: 'button', class: 'btn-link', 'data-focus': 'rebuild:no' }, step, T.cancel).addEventListener('click', function () { step.textContent = ''; go.focus(); });
      yes.addEventListener('click', function () {
        yes.disabled = true;
        ctx.request('/v1/admin/rebuild', 'POST', {}).then(function (res) {
          step.textContent = '';
          ctx.note(step, T.rebuildStarted(Number(res && res.pending) || 0), 'done');
          ctx.loadSettings();
        }, function (f) { yes.disabled = false; ctx.note(step, ctx.failureText(f), 'field-error'); });
      });
      yes.focus();
    });
  }
  // One child's data: a code from the teacher page (or its start), then the student's page,
  // forgetting them or linking another code (the student page's own panels, asking twice).
  function child(ctx, grid) {
    var T = ctx.t(), h = ctx.h, R = ctx.R, I = ctx.I;
    var box = h('div', { class: 'card setting', id: 'setting-child' }, grid);
    h('h3', { class: 'card-title' }, box, T.childTitle);
    h('p', { class: 'note' }, box, T.childIntro);
    var form = h('form', { class: 'child-form', novalidate: true }, box);
    h('label', { for: 'childCode', class: 'sr-only' }, form, T.codeSearch);
    var input = h('input', { id: 'childCode', type: 'search', class: 'code-search', dir: 'ltr', autocomplete: 'off', spellcheck: 'false', placeholder: T.codePlaceholder,
      'data-focus': 'child:code', maxlength: '20' }, form);
    h('button', { type: 'submit', class: 'btn-quiet', 'data-focus': 'child:find' }, form, T.childFind);
    var out = h('div', { class: 'child-result', id: 'childResult', 'aria-live': 'polite' }, box);
    var panel = h('div', { class: 'action-panel', id: 'actionPanel', hidden: true }, box);
    var close = function () { panel.hidden = true; panel.textContent = ''; };
    function show(s) {
      out.textContent = '';
      close();
      var who = h('p', { class: 'child-who' }, out);
      ctx.studentLink(who, s);
      who.appendChild(document.createTextNode(' · ' + I.bandLabel(s.band || 'unknown', ctx.lang()) + (s.lastDay ? ' · ' + T.lastPlayedOn(ctx.shortDay(s.lastDay)) : '') +
        ((s.linked || []).length ? ' · ' + T.nLinked(s.linked.length) : '')));
      var acts = h('div', { class: 'student-actions' }, out);
      var panels = tabs.student && tabs.student.panels;
      var a = { student: s };
      h('button', { type: 'button', class: 'btn-quiet', id: 'childLink', 'data-focus': 'child:link' }, acts, T.linkAction).addEventListener('click', function () {
        panel.textContent = ''; panel.hidden = false; panels.link(ctx, panel, a, close);
      });
      h('button', { type: 'button', class: 'btn-quiet btn-danger', id: 'childForget', 'data-focus': 'child:forget' }, acts, T.forgetAction).addEventListener('click', function () {
        panel.textContent = ''; panel.hidden = false; panels.forget(ctx, panel, a, close);
      });
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      out.textContent = '';
      close();
      var text = input.value, whole = R.fullCode(text);
      if (whole && whole.wrong) { ctx.note(out, T.childWrong, 'field-error'); return; }
      if (!R.codeQuery(text)) { ctx.note(out, T.codeSearchHint, 'field-error'); return; }
      ctx.note(out, T.loading);
      // A whole code: the server's own record of it, in any period (the sample: its list).
      if (whole && !ctx.demo()) {
        ctx.get('student', { u: whole.code }).then(function (x) { show(x.student); }, function (f) {
          out.textContent = '';
          ctx.note(out, f && f.body && f.body.error === 'student' ? T.studentUnknown : ctx.failureText(f), 'field-error');
        });
        return;
      }
      ctx.get('students', {}).then(function (x) {
        var found = R.findStudents(x.students || [], text);
        out.textContent = '';
        if (!found.length) { ctx.note(out, T.childNoneInPeriod(R.codeQuery(text).toUpperCase())); return; }
        if (found.length === 1) { show(found[0]); return; }
        var list = h('div', { class: 'link-results', role: 'list' }, out);
        found.slice(0, 12).forEach(function (s) {
          var b = h('button', { type: 'button', class: 'btn-quiet link-pick', role: 'listitem', 'data-u': s.u, 'data-focus': 'child:' + s.u }, list,
            R.studentLabel(s, ctx.lang()) + ' · ' + I.bandLabel(s.band || 'unknown', ctx.lang()) + ' · ' + ctx.minutesText(s.minutes || 0));
          b.addEventListener('click', function () { show(s); });
        });
      }, function (f) { out.textContent = ''; ctx.note(out, ctx.failureText(f), 'field-error'); });
    });
  }

  // ---- meters ---------------------------------------------------------------------------------
  function meters(ctx, parent, s) {
    var T = ctx.t(), h = ctx.h, I = ctx.I;
    var sec = ctx.section(parent, 'meters', T.metersTitle);
    var box = h('div', { class: 'tiles tiles-small' }, sec);
    var u = s.usage || {}, st = s.storage || {};
    var w = u.writesLimit ? (u.writes || 0) / u.writesLimit : null, r = u.readsLimit ? (u.reads || 0) / u.readsLimit : null;
    ctx.tile(box, 'writes', T.writesToday, w == null ? '—' : I.pct(w), '', T.writesHint(I.int(u.writes || 0), I.int(u.writesLimit || 0)), w);
    ctx.tile(box, 'reads', T.readsToday, r == null ? '—' : I.pct(r), '', T.readsHint(I.int(u.reads || 0), I.int(u.readsLimit || 0)), r);
    var mb = st.bytes != null ? st.bytes / 1e6 : null;
    ctx.tile(box, 'storage', T.databaseSize, mb == null ? '—' : I.int(mb), mb == null ? '' : T.mb, T.storageLine(I.int(mb || 0), I.int((st.limit || 5e8) / 1e6)), mb);
    ctx.tile(box, 'batchEvery', T.batchEvery, u.batchEvery ? I.int(u.batchEvery) : '—', u.batchEvery ? T.secondsUnit : '', T.batchEveryHint, u.batchEvery || null);
    if (w != null && r != null) ctx.note(sec, T.freePlan(I.pct(w), I.pct(r)));
    if (st.trimmedBefore) ctx.note(sec, T.trimmedNote(ctx.dayText(st.trimmedBefore, { day: 'numeric', month: 'short', year: 'numeric' })));
    var pcs = s.pcs || {};
    if (ctx.has(pcs.seen14d)) ctx.note(sec, T.pcsSeen(pcs.seen14d, pcs.new || 0));
  }

  // Data quality (how far each number can be trusted), from the KPIs of the period.
  function quality(ctx, parent, k) {
    var T = ctx.t(), h = ctx.h, I = ctx.I, C = ctx.C;
    var sec = ctx.section(parent, 'data-quality', T.qualityTitle, T.qualityIntro);
    var box = h('div', { class: 'card', id: 'quality-card' }, sec);
    if (ctx.failed(k) || !k.quality) { ctx.missing(box, ctx.failed(k) ? k : null); return; }
    var q = k.quality;
    var rows = [
      [T.q.linkedShare, I.pct(q.linkedShare), T.qHint.linkedShare],
      [T.q.v2Share, I.pct(q.v2Share), T.qHint.v2Share],
      [T.q.clockEstimatedShare, I.pct(q.clockEstimatedShare), T.qHint.clockEstimatedShare],
      [T.q.unclosedVisits, I.int(q.unclosedVisits), T.qHint.unclosedVisits],
      [T.q.unknownBandShare, I.pct(q.unknownBandShare), T.qHint.unknownBandShare],
      [T.q.idleHandovers, I.int(q.idleHandovers), T.qHint.idleHandovers],
      [T.q.pcsNew, I.int(q.pcsNew), T.qHint.pcsNew],
      [T.q.oldVersionSessionShare, I.pct(q.oldVersionSessionShare), T.qHint.oldVersionSessionShare],
      [T.q.profilesFullPcs, I.int(q.profilesFullPcs), T.qHint.profilesFullPcs],
      [T.q.forgetfulPcs, I.int(q.forgetfulPcs), T.qHint.forgetfulPcs]
    ];
    C.table(box, T.qualityTitle, [{ label: T.measure }, { label: T.value, num: true }, { label: T.whatItMeans }], rows);
    ctx.note(box, T.lateNote);
  }
}());
