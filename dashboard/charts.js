/*
 * Small inline-SVG charts for the dashboard (window.SGCharts), drawn from
 * already-prepared rows. Every label goes in with textContent. The dataviz rules:
 * thin marks with a rounded data end and a square baseline, hairline grid, one
 * axis per chart, a tooltip on hover and on keyboard focus, a table twin for
 * every chart (built by the caller with SGCharts.table). In right-to-left pages
 * the charts are mirrored: bars grow from the right and time runs right to left.
 * Magnitudes on a grid (heatmaps, cohorts, the calendar) use the sequential ramp
 * --q1..--q5; ordered parts of a whole (same, level, game, stop) the ordinal --o1..--o4.
 */
(function () {
  'use strict';
  var SVG = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, parent, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) if (attrs[k] != null && attrs[k] !== false) node.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  // Series colours are CSS custom properties, so they go in style (and follow the theme).
  function s(tag, attrs, parent, text) {
    var node = document.createElementNS(SVG, tag);
    if (attrs) {
      for (var k in attrs) {
        if (attrs[k] == null) continue;
        if (k === 'fill' || k === 'stroke') node.style[k] = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  var r1 = function (v) { return Math.round(v * 10) / 10; };
  // A label made of numbers only ("4–5", "+3", "07") reads left to right even in an
  // Arabic page: in right-to-left text the bidi rules would show "5–4" and "3+".
  var NUMERIC = /^[\d\s.,:+%–<>-]+$/;
  var dirOf = function (text, rtl) { return NUMERIC.test(String(text)) ? 'ltr' : rtl ? 'rtl' : 'ltr'; };

  // ---- tooltip: one for the page ------------------------------------------
  var tip = null, live = null;
  function tipNode() {
    if (!tip) {
      tip = h('div', { class: 'tip', role: 'tooltip', hidden: true }, document.body);
      live = h('div', { class: 'sr-only', 'aria-live': 'polite' }, document.body);
    }
    return tip;
  }
  // content: { title, rows: [{ value, label, swatch: 'line' | 'bar', color }] , note }
  function showTip(content, anchor) {
    var t = tipNode();
    t.textContent = '';
    if (content.title) h('div', { class: 'tip-title' }, t, content.title);
    (content.rows || []).forEach(function (row) {
      var line = h('div', { class: 'tip-row' }, t);
      if (row.color) {
        var key = h('span', { class: 'tip-key ' + (row.swatch === 'bar' ? 'is-bar' : 'is-line') }, line);
        key.style.background = row.color;
      }
      h('span', { class: 'tip-value' }, line, row.value);
      if (row.label) h('span', { class: 'tip-label' }, line, row.label);
    });
    if (content.note) h('div', { class: 'tip-note' }, t, content.note);
    t.hidden = false;
    var w = t.offsetWidth, ht = t.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var x = anchor.x + 14, y = anchor.y - ht - 12;
    if (x + w > vw - 8) x = anchor.x - w - 14;
    if (x < 8) x = Math.max(8, Math.min(vw - w - 8, anchor.x - w / 2));
    if (y < 8) y = anchor.y + 18;
    if (y + ht > vh - 8) y = Math.max(8, vh - ht - 8);
    t.style.left = Math.round(x + window.scrollX) + 'px';
    t.style.top = Math.round(y + window.scrollY) + 'px';
  }
  function hideTip() { if (tip) tip.hidden = true; }
  function say(text) { tipNode(); live.textContent = text; }
  function anchorOf(node) {
    var r = node.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }
  function tipText(content) {
    return [content.title].concat((content.rows || []).map(function (r) { return r.value + (r.label ? ' ' + r.label : ''); }))
      .concat(content.note ? [content.note] : []).filter(Boolean).join(', ');
  }
  // A mark that shows its tooltip on hover and on keyboard focus. The listeners sit
  // on the whole mark (its bar, its labels and its larger transparent hit area).
  function interactive(node, content) {
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-label', tipText(content));
    node.addEventListener('pointermove', function (e) { node.classList.add('is-hover'); showTip(content, { x: e.clientX, y: e.clientY }); });
    node.addEventListener('pointerleave', function () { node.classList.remove('is-hover'); hideTip(); });
    node.addEventListener('focus', function () { node.classList.add('is-hover'); showTip(content, anchorOf(node)); });
    node.addEventListener('blur', function () { node.classList.remove('is-hover'); hideTip(); });
  }

  // ---- scales ----------------------------------------------------------------
  function niceStep(max, count) {
    var raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  // The charts count play sessions and whole minutes: a step is never below 1.
  function ticks(max, count) {
    if (!(max > 0)) return [0, 1];
    var step = Math.max(1, niceStep(max, count || 4)), out = [];
    for (var v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 1000) / 1000);
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
  }
  function compact(v) {
    if (v >= 1e6) return r1(v / 1e6) + 'M';
    if (v >= 1000) return r1(v / 1000) + 'K';
    return String(r1(v));
  }

  // A bar from x0 (baseline) to x1 with a rounded data end; works both ways.
  function barPath(x0, x1, y, height, radius) {
    var w = Math.abs(x1 - x0);
    if (w < 0.5) return '';
    var r = Math.min(radius, w, height / 2), dir = x1 >= x0 ? 1 : -1;
    var xe = x1 - dir * r;
    return 'M' + r1(x0) + ' ' + r1(y) + 'H' + r1(xe) +
      'A' + r + ' ' + r + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + r1(x1) + ' ' + r1(y + r) +
      'V' + r1(y + height - r) +
      'A' + r + ' ' + r + ' 0 0 ' + (dir > 0 ? 1 : 0) + ' ' + r1(xe) + ' ' + r1(y + height) +
      'H' + r1(x0) + 'Z';
  }
  var measureCtx = null;
  function textWidth(text, font) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  // Shortens a label with an ellipsis until it fits (never clipped by its neighbour).
  function fit(text, width, font) {
    if (textWidth(text, font) <= width) return text;
    var chars = Array.from(text);
    while (chars.length > 1 && textWidth(chars.join('') + '…', font) > width) chars.pop();
    return chars.join('').trim() + '…';
  }

  // ---- line chart: one series over days (or any ordered steps) ----------------
  // opts: { points: [{ title, tick, value (null = no number for that day), tip }], color, rtl, name,
  //         format(v) -> text, emptyText (the tooltip of a day without a number), height,
  //         max (a shared scale for small multiples), step (a step line), axis(v) -> tick text,
  //         keysHint, minWidth }
  function lineChart(host, opts) {
    host.textContent = '';
    var points = opts.points, n = points.length, rtl = !!opts.rtl;
    var W = Math.max(opts.minWidth || 260, Math.floor(host.clientWidth || 600)), H = opts.height || 200;
    var values = points.map(function (p) { return p.value; }).filter(function (v) { return v != null; });
    var max = Math.max.apply(null, values.concat([0, opts.max || 0]));
    var yt = ticks(max || 1, H < 180 ? 3 : 4), yMax = yt[yt.length - 1];
    var axis = opts.axis || compact, format = opts.format || compact;
    var font = '12px ' + getComputedStyle(host).fontFamily;
    var axisW = Math.ceil(Math.max.apply(null, yt.map(function (v) { return textWidth(axis(v), font); }))) + 10;
    var top = 22, bottom = 26, padEnd = 12;
    var left = rtl ? padEnd : axisW, right = rtl ? W - axisW : W - padEnd;
    var plotH = H - top - bottom;
    var X = function (i) { var f = n > 1 ? i / (n - 1) : 0.5; return rtl ? right - f * (right - left) : left + f * (right - left); };
    var Y = function (v) { return top + plotH - (v / yMax) * plotH; };

    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', tabindex: '0',
      'aria-label': opts.name + '. ' + opts.keysHint }, host);
    var grid = s('g', { class: 'grid' }, svg);
    // The numbers sit beside the plot, aligned to it: to its left, or mirrored to its right.
    yt.forEach(function (v) {
      var y = r1(Y(v)) + 0.5;
      s('line', { x1: left, x2: right, y1: y, y2: y, class: v === 0 ? 'baseline' : 'gridline' }, grid);
      s('text', { x: rtl ? W - axisW + 8 : axisW - 8, y: y + 4, class: 'tick', 'text-anchor': rtl ? 'start' : 'end', direction: 'ltr' }, grid, axis(v));
    });
    // Day labels, counted back from the newest day so the latest always has one;
    // a label that would touch one already placed is skipped (measured, not guessed).
    var widths = points.map(function (p) { return textWidth(p.tick, font); });
    var widest = Math.max.apply(null, widths.concat([10]));
    var every = Math.max(1, Math.ceil((widest + 14) / (n > 1 ? Math.abs(right - left) / (n - 1) : 1e9)));
    if (every > 1) every = [2, 3, 4, 5, 7, 10, 14, 15, 30].filter(function (v) { return v >= every; })[0] || every;
    var placed = [];
    // Arabic day names read right to left; text-anchor follows the text's direction.
    for (var i = n - 1; i >= 0; i -= every) {
      var dir = dirOf(points[i].tick, rtl), leftEdge = dir === 'rtl' ? 'end' : 'start', rightEdge = dir === 'rtl' ? 'start' : 'end';
      var x = X(i), w = widths[i], anchor = 'middle', x0 = x - w / 2;
      // The end labels stay inside the chart: anchored at their outer edge.
      var atLeft = rtl ? i === n - 1 : i === 0, atRight = rtl ? i === 0 : i === n - 1;
      if (n > 1 && atRight && x + w / 2 > W - 2) { anchor = rightEdge; x0 = x - w; }
      if (n > 1 && atLeft && x - w / 2 < (rtl ? 2 : left - 2)) { anchor = leftEdge; x0 = x; }
      var x1 = x0 + w;
      if (placed.some(function (b) { return x0 < b[1] + 10 && x1 > b[0] - 10; })) continue;
      placed.push([x0, x1]);
      s('text', { x: r1(x), y: H - 7, class: 'tick', 'text-anchor': anchor, direction: dir }, svg, points[i].tick);
    }

    // The line breaks at a day without a number (an older server's); an isolated day is a dot.
    var segs = [], cur = [];
    points.forEach(function (p, i) {
      if (p.value == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(i);
    });
    if (cur.length) segs.push(cur);
    var marks = s('g', {}, svg);
    segs.forEach(function (seg) {
      if (seg.length === 1) {
        s('circle', { cx: r1(X(seg[0])), cy: r1(Y(points[seg[0]].value)), r: 3, fill: opts.color }, marks);
        return;
      }
      // A step line holds each value until the next step (a level that changes by attempt).
      var d = seg.map(function (i, k) {
        if (!k) return 'M' + r1(X(i)) + ' ' + r1(Y(points[i].value));
        return opts.step ? 'H' + r1(X(i)) + 'V' + r1(Y(points[i].value)) : 'L' + r1(X(i)) + ' ' + r1(Y(points[i].value));
      }).join('');
      s('path', { d: d + 'L' + r1(X(seg[seg.length - 1])) + ' ' + r1(Y(0)) + 'L' + r1(X(seg[0])) + ' ' + r1(Y(0)) + 'Z',
        fill: opts.color, class: 'area' }, marks);
      s('path', { d: d, stroke: opts.color, class: 'line' }, marks);
    });
    points.forEach(function (p, i) {
      if (p.value == null) s('rect', { x: r1(X(i)) - 3, y: r1(Y(0)) - 1, width: 6, height: 3, rx: 1.5, class: 'no-day' }, marks);
    });
    // The newest shown value gets a dot and its number.
    for (var last = n - 1; last >= 0 && points[last].value == null; last--);
    if (last >= 0) {
      var lx = X(last), ly = Y(points[last].value);
      s('circle', { cx: r1(lx), cy: r1(ly), r: 4, fill: opts.color, class: 'end-dot' }, marks);
      var atEdge = last === n - 1;
      s('text', { x: r1(lx), y: r1(ly) - 10, class: 'end-label', direction: 'ltr',
        'text-anchor': atEdge ? (rtl ? 'start' : 'end') : 'middle' }, marks, format(points[last].value));
    }

    // Crosshair: snaps to the nearest day.
    var cross = s('g', { class: 'cross', visibility: 'hidden' }, svg);
    var crossLine = s('line', { y1: top - 6, y2: Y(0), class: 'cross-line' }, cross);
    var crossDot = s('circle', { r: 4.5, fill: opts.color, class: 'end-dot' }, cross);
    var hit = s('rect', { x: Math.min(left, right) - 6, y: 0, width: Math.abs(right - left) + 12, height: H, fill: 'transparent', class: 'hit' }, svg);
    var at = -1;
    function content(i) {
      var p = points[i];
      if (p.tip) return p.tip;
      return p.value == null
        ? { title: p.title, note: opts.emptyText }
        : { title: p.title, rows: [{ value: format(p.value), label: opts.unit || '', color: opts.color, swatch: 'line' }] };
    }
    function move(i, anchor) {
      at = Math.max(0, Math.min(n - 1, i));
      var x = r1(X(at)) + 0.5;
      cross.setAttribute('visibility', 'visible');
      crossLine.setAttribute('x1', x); crossLine.setAttribute('x2', x);
      var v = points[at].value;
      crossDot.setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) { crossDot.setAttribute('cx', x); crossDot.setAttribute('cy', r1(Y(v))); }
      var c = content(at);
      if (anchor) showTip(c, anchor);
      else { var b = svg.getBoundingClientRect(); showTip(c, { x: b.left + x, y: b.top + (v == null ? Y(0) : Y(v)) }); }
      say(tipText(c));
    }
    function nearest(clientX) {
      var b = svg.getBoundingClientRect(), x = clientX - b.left, best = 0, dist = Infinity;
      for (var i = 0; i < n; i++) { var d = Math.abs(X(i) - x); if (d < dist) { dist = d; best = i; } }
      return best;
    }
    function leave() { cross.setAttribute('visibility', 'hidden'); hideTip(); }
    hit.addEventListener('pointermove', function (e) { move(nearest(e.clientX), { x: e.clientX, y: e.clientY }); });
    hit.addEventListener('pointerleave', leave);
    svg.addEventListener('blur', leave);
    svg.addEventListener('focus', function () { move(at < 0 ? last : at); });
    svg.addEventListener('keydown', function (e) {
      var step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (e.key === 'Home') { move(0); e.preventDefault(); } else if (e.key === 'End') { move(n - 1); e.preventDefault(); } else if (step) { move((at < 0 ? last : at) + step); e.preventDefault(); }
    });
    return svg;
  }

  // ---- columns: histograms and weekly columns ---------------------------------
  // One column per bar, on one axis from 0, with a 2px gap between columns and a rounded
  // data end. A bar may be a stack of parts (2 to 4 ordered parts: returning and new).
  // opts: { bars: [{ tick, title, value | parts: [{ value, color, label }], tip }], color,
  //         rtl, name, format(v), axis(v), height, max (shared scale), keysHint, minWidth }
  function columns(host, opts) {
    host.textContent = '';
    var bars = opts.bars, n = bars.length, rtl = !!opts.rtl;
    var W = Math.max(opts.minWidth || 240, Math.floor(host.clientWidth || 500)), H = opts.height || 180;
    var totals = bars.map(function (b) { return b.parts ? b.parts.reduce(function (a, p) { return a + (p.value || 0); }, 0) : b.value || 0; });
    var yt = ticks(Math.max.apply(null, totals.concat([opts.max || 0, 0])) || 1, H < 160 ? 3 : 4), yMax = yt[yt.length - 1];
    var axis = opts.axis || compact;
    var font = '12px ' + getComputedStyle(host).fontFamily;
    var axisW = Math.ceil(Math.max.apply(null, yt.map(function (v) { return textWidth(axis(v), font); }))) + 10;
    var top = 14, bottom = 26, padEnd = 6;
    var left = rtl ? padEnd : axisW, right = rtl ? W - axisW : W - padEnd, plotW = right - left, plotH = H - top - bottom;
    var slot = plotW / Math.max(1, n), gap = Math.min(8, Math.max(2, slot * 0.18)), bw = Math.max(2, slot - gap);
    var X = function (i) { return rtl ? right - (i + 1) * slot + gap / 2 : left + i * slot + gap / 2; };
    var Y = function (v) { return top + plotH - (v / yMax) * plotH; };
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart cols', role: 'img', tabindex: '0',
      'aria-label': opts.name + (opts.keysHint ? '. ' + opts.keysHint : '') }, host);
    var grid = s('g', { class: 'grid' }, svg);
    yt.forEach(function (v) {
      var y = r1(Y(v)) + 0.5;
      s('line', { x1: left, x2: right, y1: y, y2: y, class: v === 0 ? 'baseline' : 'gridline' }, grid);
      s('text', { x: rtl ? W - axisW + 8 : axisW - 8, y: y + 4, class: 'tick', 'text-anchor': rtl ? 'start' : 'end', direction: 'ltr' }, grid, axis(v));
    });
    // Tick labels under the columns; one that would touch its neighbour is skipped.
    var placed = [];
    bars.forEach(function (b, i) {
      if (!b.tick) return;
      var w = textWidth(b.tick, font), cx = X(i) + bw / 2, x0 = Math.max(0, Math.min(W - w, cx - w / 2));
      if (placed.some(function (p) { return x0 < p[1] + 6 && x0 + w > p[0] - 6; })) return;
      placed.push([x0, x0 + w]);
      s('text', { x: r1(x0 + w / 2), y: H - 8, class: 'tick', 'text-anchor': 'middle', direction: dirOf(b.tick, rtl) }, svg, b.tick);
    });
    var marks = s('g', {}, svg), nodes = [];
    bars.forEach(function (b, i) {
      var g = s('g', { class: 'mark' }, marks);
      s('rect', { x: r1(X(i) - gap / 2), y: top - 6, width: r1(slot), height: plotH + 6, class: 'col-hit' }, g);
      var parts = b.parts || [{ value: b.value || 0, color: opts.color }];
      var shown = parts.filter(function (p) { return p.value > 0; });
      var y0 = Y(0);
      shown.forEach(function (p, k) {
        var hgt = Math.max(1, (p.value / yMax) * plotH), y1 = y0 - hgt;
        var lastOne = k === shown.length - 1;
        // A 2px surface gap between stacked parts; only the data end (the top) is rounded.
        var h1 = lastOne ? hgt : Math.max(0.5, hgt - 2);
        if (lastOne) s('path', { d: colPath(X(i), bw, y0, y0 - h1, 4), fill: p.color || opts.color, class: 'bar' }, g);
        else s('rect', { x: r1(X(i)), y: r1(y0 - h1), width: r1(bw), height: r1(h1), fill: p.color || opts.color, class: 'bar' }, g);
        y0 = y1;
      });
      nodes.push(g);
      if (b.tip) {
        g.addEventListener('pointermove', function (e) { nodes.forEach(function (x) { x.classList.remove('is-hover'); }); g.classList.add('is-hover'); showTip(b.tip, { x: e.clientX, y: e.clientY }); });
        g.addEventListener('pointerleave', function () { g.classList.remove('is-hover'); hideTip(); });
      }
    });
    // The keyboard reads one column at a time, like the line chart's days.
    var at = -1;
    function move(i) {
      at = Math.max(0, Math.min(n - 1, i));
      nodes.forEach(function (x, k) { x.classList.toggle('is-hover', k === at); });
      var b = bars[at], box = svg.getBoundingClientRect(), tip = b.tip || { title: b.title || b.tick, rows: [{ value: (opts.format || compact)(totals[at]) }] };
      showTip(tip, { x: box.left + X(at) + bw / 2, y: box.top + Y(totals[at]) });
      say(tipText(tip));
    }
    svg.addEventListener('focus', function () { if (n) move(at < 0 ? n - 1 : at); });
    svg.addEventListener('blur', function () { nodes.forEach(function (x) { x.classList.remove('is-hover'); }); hideTip(); });
    svg.addEventListener('keydown', function (e) {
      var step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (!n) return;
      if (e.key === 'Home') { move(0); e.preventDefault(); } else if (e.key === 'End') { move(n - 1); e.preventDefault(); } else if (step) { move((at < 0 ? n - 1 : at) + step); e.preventDefault(); }
    });
    return svg;
  }
  // A column from the baseline y0 up to y1, rounded at the top only.
  function colPath(x, w, y0, y1, radius) {
    var hgt = y0 - y1;
    if (hgt < 0.5) return '';
    var r = Math.min(radius, w / 2, hgt);
    return 'M' + r1(x) + ' ' + r1(y0) + 'V' + r1(y1 + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + r1(x + r) + ' ' + r1(y1) +
      'H' + r1(x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + r1(x + w) + ' ' + r1(y1 + r) + 'V' + r1(y0) + 'Z';
  }

  // ---- small multiples: one panel per group, one shared scale -------------------
  // panels: [{ title, sub, chip, draw: 'line' | 'columns', points | bars, empty, format, axis }]
  // opts: { max (shared; default the largest value of every panel), shared (false: each
  //         panel its own scale, for panels that show different measures), rtl, color,
  //         format, axis, height }
  // Returns the panel hosts, so the caller can add a note under one.
  function multiples(host, panels, opts) {
    host.textContent = '';
    var o = opts || {};
    var all = [];
    panels.forEach(function (p) {
      (p.points || []).forEach(function (x) { if (x.value != null) all.push(x.value); });
      (p.bars || []).forEach(function (b) { all.push(b.parts ? b.parts.reduce(function (a, x) { return a + (x.value || 0); }, 0) : b.value || 0); });
    });
    var max = o.max != null ? o.max : Math.max.apply(null, all.concat([0]));
    var wrap = h('div', { class: 'multiples' }, host), out = [];
    // Every panel is laid out before any is drawn: a panel measured before its
    // neighbours exist would be drawn too wide and then shrunk.
    var plots = panels.map(function (p) {
      var panel = h('div', { class: 'panel' }, wrap);
      var head = h('div', { class: 'panel-head' }, panel);
      h('h4', { class: 'panel-title' }, head, p.title);
      var sub = h('span', { class: 'panel-sub' }, head, p.sub || '');
      if (p.chip) { sub.appendChild(document.createTextNode(p.sub ? ' ' : '')); h('span', { class: 'chip' }, sub, p.chip); }
      out.push(panel);
      return h('div', { class: 'chart-host' }, panel);
    });
    panels.forEach(function (p, i) {
      var plot = plots[i];
      var empty = p.draw === 'columns' ? !(p.bars || []).length : !(p.points || []).some(function (x) { return x.value != null; });
      if (empty) { h('p', { class: 'note' }, plot, p.empty || ''); return; }
      var common = { rtl: o.rtl, color: p.color || o.color, name: p.name || p.title, format: p.format || o.format, axis: p.axis || o.axis,
        height: o.height || 150, max: o.shared === false ? null : max, keysHint: o.keysHint, minWidth: 200 };
      if (p.draw === 'columns') columns(plot, Object.assign(common, { bars: p.bars }));
      else lineChart(plot, Object.assign(common, { points: p.points, step: p.step, unit: p.unit || '' }));
    });
    return out;
  }

  // ---- sparkline: a table cell's small trend --------------------------------------
  // values: numbers (oldest first). A 2px line, its newest value dotted; the numbers
  // themselves go in label (read by screen readers and shown as the tooltip).
  function sparkline(host, values, opts) {
    var o = opts || {}, n = values.length, W = o.width || 72, H = o.height || 20, pad = 3;
    var max = Math.max.apply(null, values.concat([0])) || 1, rtl = !!o.rtl;
    var X = function (i) { var f = n > 1 ? i / (n - 1) : 0.5; return rtl ? W - pad - f * (W - 2 * pad) : pad + f * (W - 2 * pad); };
    var Y = function (v) { return H - pad - (v / max) * (H - 2 * pad); };
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'spark', role: 'img', 'aria-label': o.label || values.join(', ') }, host);
    if (o.label) s('title', {}, svg, o.label);
    s('line', { x1: pad, x2: W - pad, y1: H - pad + 0.5, y2: H - pad + 0.5, class: 'baseline' }, svg);
    if (n) {
      s('path', { d: values.map(function (v, i) { return (i ? 'L' : 'M') + r1(X(i)) + ' ' + r1(Y(v)); }).join(''), stroke: o.color || 'var(--s1)', class: 'line' }, svg);
      s('circle', { cx: r1(X(n - 1)), cy: r1(Y(values[n - 1])), r: 2.5, fill: o.color || 'var(--s1)' }, svg);
    }
    return svg;
  }

  // ---- heatmap: a grid of cells on the sequential ramp -------------------------------
  // HTML cells (CSS grid), so each label sits on its own cell's colour and the page
  // direction mirrors the columns. A value of 0 or null is an empty cell (the track
  // colour); others take one of five steps (--q1..--q5) by value / max. Arrow keys move
  // a single focus stop (roving tabindex); every cell has a tooltip. The legend shows
  // the lowest and highest value.
  // opts: { rows: [{ label }], cols: [{ label, tick (shown, or '' to skip) }],
  //         value(r, c) -> number | null, text(r, c) -> cell label | '', tip(r, c) -> content,
  //         name, rtl, legend: { low, high (value -> text), empty (the 0 cell's text), none (a null cell's) },
  //         cellSize, minCell, rowLabelWidth, className }
  function heatmap(host, opts) {
    host.textContent = '';
    var R = opts.rows.length, Cn = opts.cols.length;
    var values = [], max = 0, min = Infinity;
    for (var r = 0; r < R; r++) {
      values.push([]);
      for (var c = 0; c < Cn; c++) {
        var v = opts.value(r, c);
        values[r].push(v);
        if (v != null && v > 0) { max = Math.max(max, v); min = Math.min(min, v); }
      }
    }
    var step = function (v) { return v == null || !(v > 0) || !max ? 0 : Math.max(1, Math.min(5, Math.ceil((v / max) * 5))); };
    var wrap = h('div', { class: 'heatmap' + (opts.className ? ' ' + opts.className : '') }, host);
    var grid = h('div', { class: 'hm-grid', role: 'grid', 'aria-label': opts.name, 'aria-rowcount': String(R + 1), 'aria-colcount': String(Cn + 1) }, wrap);
    // Cells shrink to fit a narrow card (down to minCell); below that the grid scrolls inside the card.
    var cell = opts.cellSize || 14, avail = host.clientWidth || 0;
    if (avail) cell = Math.max(opts.minCell || 10, Math.min(cell, Math.floor((avail - 76) / Cn) - 2));
    grid.style.gridTemplateColumns = (opts.rowLabelWidth || 'max-content') + ' repeat(' + Cn + ', minmax(' + cell + 'px, 1fr))';
    var head = h('div', { class: 'hm-row hm-head', role: 'row' }, grid);
    h('span', { class: 'hm-corner', role: 'columnheader' }, head, opts.corner || '');
    opts.cols.forEach(function (col) {
      var text = col.tick == null ? col.label : col.tick;
      h('span', { class: 'hm-col', role: 'columnheader', 'aria-label': col.label, dir: NUMERIC.test(text) ? 'ltr' : null }, head, text);
    });
    var cells = [];
    opts.rows.forEach(function (row, ri) {
      var line = h('div', { class: 'hm-row', role: 'row' }, grid);
      h('span', { class: 'hm-label', role: 'rowheader' }, line, row.label);
      cells.push([]);
      opts.cols.forEach(function (col, ci) {
        var v = values[ri][ci], q = step(v), text = opts.text ? opts.text(ri, ci) : '';
        var cell = h('span', { class: 'hm-cell q' + q + (v == null ? ' is-none' : ''), role: 'gridcell', tabindex: '-1', 'data-row': String(ri), 'data-col': String(ci) }, line, text || null);
        var tip = opts.tip(ri, ci);
        cell.setAttribute('aria-label', tipText(tip));
        cell.addEventListener('pointermove', function (e) { cell.classList.add('is-hover'); showTip(tip, { x: e.clientX, y: e.clientY }); });
        cell.addEventListener('pointerleave', function () { cell.classList.remove('is-hover'); hideTip(); });
        cell.addEventListener('focus', function () { cell.classList.add('is-hover'); showTip(tip, anchorOf(cell)); });
        cell.addEventListener('blur', function () { cell.classList.remove('is-hover'); hideTip(); });
        cells[ri].push(cell);
      });
    });
    // One tab stop: the first cell with a value (or the first cell).
    var start = null;
    for (var a = 0; a < R && !start; a++) for (var b = 0; b < Cn && !start; b++) if (values[a][b] > 0) start = cells[a][b];
    start = start || (cells[0] && cells[0][0]);
    if (start) start.setAttribute('tabindex', '0');
    grid.addEventListener('keydown', function (e) {
      var cur = e.target.closest && e.target.closest('.hm-cell');
      if (!cur) return;
      var ri = Number(cur.getAttribute('data-row')), ci = Number(cur.getAttribute('data-col'));
      // Columns follow the reading direction: the right arrow goes back in RTL pages.
      var dc = { ArrowRight: opts.rtl ? -1 : 1, ArrowLeft: opts.rtl ? 1 : -1 }[e.key] || 0, dr = { ArrowDown: 1, ArrowUp: -1 }[e.key] || 0;
      if (e.key === 'Home') { ci = 0; } else if (e.key === 'End') { ci = Cn - 1; } else if (!dc && !dr) return;
      e.preventDefault();
      ri = Math.max(0, Math.min(R - 1, ri + dr)); ci = Math.max(0, Math.min(Cn - 1, ci + dc));
      cur.setAttribute('tabindex', '-1');
      cells[ri][ci].setAttribute('tabindex', '0');
      cells[ri][ci].focus();
    });
    // Legend: lowest and highest value with the five steps between them.
    if (opts.legend && max) {
      var legend = h('div', { class: 'hm-legend', 'aria-hidden': 'true' }, wrap);
      h('span', { class: 'hm-legend-text' }, legend, opts.legend.low(min));
      var ramp = h('span', { class: 'hm-ramp' }, legend);
      for (var k = 1; k <= 5; k++) h('span', { class: 'hm-swatch q' + k }, ramp);
      h('span', { class: 'hm-legend-text' }, legend, opts.legend.high(max));
      if (opts.legend.empty) {
        h('span', { class: 'hm-swatch q0 hm-empty' }, legend);
        h('span', { class: 'hm-legend-text' }, legend, opts.legend.empty);
      }
      // A cell with no value at all (null: not reached yet) is outlined, not the 0 colour.
      if (opts.legend.none) {
        h('span', { class: 'hm-swatch is-none hm-empty' }, legend);
        h('span', { class: 'hm-legend-text' }, legend, opts.legend.none);
      }
    }
    return wrap;
  }

  // ---- calendar strip: one cell per day, weeks as columns -------------------------------
  // days: [{ day, value, tip }] over a range; weekStart 'sun' | 'mon'; weekdays: the row
  // labels in that order; the columns are weeks (oldest first, mirrored in RTL).
  function calendarStrip(host, days, opts) {
    var o = opts || {};
    var first = o.weekStart === 'mon' ? 1 : 0;
    var byDay = {};
    days.forEach(function (d) { byDay[d.day] = d; });
    var weekday = function (day) { return new Date(day + 'T00:00:00Z').getUTCDay(); };
    var add = function (day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); };
    var from = o.from || (days[0] && days[0].day), to = o.to || (days.length && days[days.length - 1].day);
    if (!from || !to) { host.textContent = ''; return null; }
    var week0 = add(from, -((weekday(from) - first + 7) % 7)), weeks = [];
    for (var w = week0; w <= to; w = add(w, 7)) weeks.push(w);
    var rows = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return (i + first) % 7; });
    return heatmap(host, {
      name: o.name, rtl: o.rtl, className: 'calendar', cellSize: 12, corner: '',
      rows: rows.map(function (wd) { return { label: o.weekdayLabel(wd) }; }),
      cols: weeks.map(function (wk, i) { return { label: o.weekLabel(wk), tick: i % 4 === 0 ? o.weekTick(wk) : '' }; }),
      value: function (r, c) {
        var day = add(weeks[c], (rows[r] - first + 7) % 7);
        if (day < from || day > to) return null;
        return byDay[day] ? byDay[day].value : 0;
      },
      tip: function (r, c) {
        var day = add(weeks[c], (rows[r] - first + 7) % 7);
        return byDay[day] && byDay[day].tip ? byDay[day].tip : { title: o.dayTitle(day), rows: [{ value: day < from || day > to ? '—' : o.none }] };
      },
      legend: o.legend
    });
  }

  // ---- dumbbell: before -> after for the same children ---------------------------------
  // rows: [{ label, a, b, aText, bText, tip, chip }] on one scale [0, max]; the first value
  // is a ring, the later one a filled dot, joined by a line (the change).
  function dumbbell(host, opts) {
    host.textContent = '';
    var rows = opts.rows, rtl = !!opts.rtl;
    var W = Math.max(260, Math.floor(host.clientWidth || 500));
    var family = getComputedStyle(host).fontFamily, labelFont = '13px ' + family, valueFont = '600 13px ' + family, subFont = '12px ' + family;
    var labelW = Math.round(Math.min(W * 0.34, Math.max(90, Math.max.apply(null, rows.map(function (r) {
      return Math.max(textWidth(r.label, labelFont), r.chip ? textWidth(r.chip, subFont) : 0); }).concat([0])) + 14)));
    var valueW = Math.max.apply(null, rows.map(function (r) { return textWidth(r.aText + ' → ' + r.bText, valueFont); }).concat([0])) + 12;
    var narrow = W - labelW - valueW < 140;
    // A small group's chip: after the label on a phone, on a line under it on a wide screen.
    var chipLine = !narrow && rows.some(function (r) { return r.chip; });
    var rowH = narrow || chipLine ? 44 : 32, top = 4, H = rows.length * rowH + top + 22;
    var x0 = narrow ? 8 : labelW, x1 = narrow ? W - 8 : W - valueW;
    var max = opts.max || 1, min = opts.min || 0;
    var X = function (v) { var f = (v - min) / (max - min || 1); var x = x0 + f * (x1 - x0); return rtl ? W - x : x; };
    var dir = rtl ? 'rtl' : 'ltr';
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart bars dumbbell', role: 'list', 'aria-label': opts.name }, host);
    var axis = s('g', { class: 'grid' }, svg);
    (opts.ticks || [min, max]).forEach(function (v) {
      var x = r1(X(v)) + 0.5;
      s('line', { x1: x, x2: x, y1: top, y2: H - 20, class: 'gridline' }, axis);
      s('text', { x: x, y: H - 6, class: 'tick', 'text-anchor': 'middle', direction: 'ltr' }, axis, (opts.axis || compact)(v));
    });
    rows.forEach(function (row, i) {
      var y = top + i * rowH, g = s('g', { class: 'mark', role: 'listitem' }, svg);
      s('rect', { x: 0, y: y, width: W, height: rowH, class: 'row-hit' }, g);
      var cy = narrow ? y + 30 : y + rowH / 2, ty = narrow ? y + 14 : cy + 4.5;
      s('text', { x: rtl ? W : 0, y: row.chip && !narrow ? cy - 3 : ty, class: 'bar-label' + (row.chip ? ' is-small' : ''), 'text-anchor': 'start', direction: dir }, g,
        fit(row.label + (row.chip && narrow ? ' · ' + row.chip : ''), narrow ? W - valueW - 8 : labelW - 12, labelFont));
      if (row.chip && !narrow) s('text', { x: rtl ? W : 0, y: cy + 13, class: 'bar-sub chip-text', 'text-anchor': 'start', direction: dir }, g, fit(row.chip, labelW - 12, subFont));
      // "62% → 71%" always reads left to right (first, then latest), in its own column.
      var atEnd = rtl ? !narrow : narrow;
      s('text', { x: rtl ? (narrow ? 0 : valueW - 8) : (narrow ? W : W - valueW + 8), y: ty, class: 'bar-value', 'text-anchor': atEnd ? 'end' : 'start', direction: 'ltr' }, g,
        row.aText + ' → ' + row.bText);
      if (row.a != null && row.b != null) {
        s('line', { x1: r1(X(row.a)), x2: r1(X(row.b)), y1: cy, y2: cy, stroke: opts.color || 'var(--s1)', class: 'db-line' }, g);
        s('circle', { cx: r1(X(row.a)), cy: cy, r: 5, class: 'db-before', stroke: opts.color || 'var(--s1)' }, g);
        s('circle', { cx: r1(X(row.b)), cy: cy, r: 5, fill: opts.color || 'var(--s1)', class: 'db-after' }, g);
      }
      if (row.tip) interactive(g, row.tip);
    });
    return svg;
  }

  // ---- stacked rows with a legend: ordered parts of one whole per row ------------------
  // rows: [{ label, parts: [{ value }], tip, chip }]; colors: one per part (an ordinal ramp);
  // legend: the part names. HTML rows with the stacked bar in each.
  function stackRows(host, opts) {
    host.textContent = '';
    var legend = h('ul', { class: 'legend', 'aria-label': opts.legendName || opts.name }, host);
    opts.legend.forEach(function (name, i) {
      var li = h('li', null, legend);
      h('span', { class: 'swatch' }, li).style.background = opts.colors[i];
      h('span', null, li, name);
    });
    var box = h('div', { class: 'stack-rows', role: 'list', 'aria-label': opts.name }, host), draws = [];
    opts.rows.forEach(function (row) {
      var line = h('div', { class: 'stack-row mark', role: 'listitem' }, box);
      var label = h('span', { class: 'stack-label' + (row.chip ? ' is-small' : '') }, line, row.label);
      if (row.chip) { label.appendChild(document.createTextNode(' ')); h('span', { class: 'chip' }, label, row.chip); }
      var bar = h('span', { class: 'stack-host' }, line);
      if (row.valueText) h('span', { class: 'stack-value' }, line, row.valueText);
      var parts = row.parts.map(function (p, i) { return { value: p.value || 0, color: opts.colors[i] }; });
      draws.push(function () { stackedBar(bar, parts, { rtl: opts.rtl, height: 12 }); });
      if (row.tip) interactive(line, row.tip);
    });
    draws.forEach(function (fn) { fn(); });
    return box;
  }

  // ---- bar list: one row per item ---------------------------------------------
  // Wide: label | bar | value at the bar's tip (or, over a 0-100 % track, in a
  // column after it). Narrow: the label and value on a line above the bar.
  // Text anchors are logical (start = the reading side) and follow the page direction.
  // opts: { rows: [{ label, value, valueText, sub, chip, tip, color }], max, color, rtl, name, track }
  // chip: the small-sample note ("based on 2 children"), drawn as a pill after the
  // value (in the narrow layout, after the sub text); that row's label turns secondary.
  function barList(host, opts) {
    host.textContent = '';
    var rows = opts.rows.map(function (r) {
      return r.chip ? Object.assign({}, r, { sub: r.sub ? r.sub + ' · ' + r.chip : r.chip, pill: r.chip }) : r;
    }), rtl = !!opts.rtl, track = !!opts.track;
    var W = Math.max(240, Math.floor(host.clientWidth || 400));
    var max = opts.max || Math.max.apply(null, rows.map(function (r) { return r.value || 0; }).concat([1]));
    var X = function (x) { return rtl ? W - x : x; };
    var family = getComputedStyle(host).fontFamily;
    var labelFont = '13px ' + family, valueFont = '600 13px ' + family, subFont = '12px ' + family;
    var valueW = Math.max.apply(null, rows.map(function (r) { return textWidth(r.valueText, valueFont); }).concat([0]));
    // Wide rows draw the chip as a pill (its text plus 8px padding each side) instead of in the sub text.
    var subOf = function (r) { return r.pill ? (r.sub === r.pill ? '' : r.sub.slice(0, r.sub.length - r.pill.length - 3)) : r.sub; };
    var subW = Math.max.apply(null, rows.map(function (r) {
      return (subOf(r) ? textWidth(subOf(r), subFont) : 0) + (r.pill ? textWidth(r.pill, subFont) + 16 + (subOf(r) ? 8 : 0) : 0);
    }).concat([0]));
    var labelNeed = Math.max.apply(null, rows.map(function (r) { return textWidth(r.label, labelFont); }).concat([0]));
    var tail = valueW + (subW ? subW + 10 : 0) + 10;
    var inline = W >= 520 && W - Math.min(labelNeed + 16, 260) - tail >= 160;
    var dir = rtl ? 'rtl' : 'ltr';
    var rowH = inline ? 30 : 40, barH = inline ? 10 : 8, top = 2;
    var H = rows.length * rowH + top;
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart bars' + (inline ? ' is-inline' : ''),
      role: 'list', 'aria-label': opts.name }, host);
    var labelW = inline ? Math.round(Math.max(110, Math.min(labelNeed + 16, 260, W * 0.36))) : 0;
    var barEnd = inline ? W - tail : W;
    rows.forEach(function (row, i) {
      var y = top + i * rowH;
      var g = s('g', { class: 'mark', role: 'listitem' }, svg);
      s('rect', { x: 0, y: y, width: W, height: rowH, class: 'row-hit' }, g);
      var w = row.value > 0 ? Math.max(2, (row.value / max) * (barEnd - labelW)) : 0;
      var color = row.color || opts.color;
      if (inline) {
        var mid = y + rowH / 2, by = mid - barH / 2, base = mid + 4.5;
        s('text', { x: X(0), y: base, class: 'bar-label' + (row.pill ? ' is-small' : ''), 'text-anchor': 'start', direction: dir }, g, fit(row.label, labelW - 12, labelFont));
        if (track) s('path', { d: barPath(X(labelW), X(barEnd), by, barH, 4), class: 'track' }, g);
        if (w) s('path', { d: barPath(X(labelW), X(labelW + w), by, barH, 4), fill: color, class: 'bar' }, g);
        var vx = track ? barEnd + 10 : labelW + w + 8;
        s('text', { x: X(vx), y: base, class: 'bar-value', 'text-anchor': 'start', direction: dir }, g, row.valueText);
        var sx = vx + textWidth(row.valueText, valueFont) + 8, sub = subOf(row);
        if (sub) { s('text', { x: X(sx), y: base, class: 'bar-sub', 'text-anchor': 'start', direction: dir }, g, sub); sx += textWidth(sub, subFont) + 8; }
        if (row.pill) {
          var pw = textWidth(row.pill, subFont) + 16;
          s('rect', { x: r1(rtl ? W - sx - pw : sx), y: mid - 9, width: r1(pw), height: 18, rx: 9, class: 'chip-pill' }, g);
          s('text', { x: X(sx + 8), y: base - 0.5, class: 'bar-sub chip-text', 'text-anchor': 'start', direction: dir }, g, row.pill);
        }
      } else {
        var rowValueW = textWidth(row.valueText, valueFont), rowSubW = row.sub ? textWidth(row.sub, subFont) + 10 : 0;
        s('text', { x: X(0), y: y + 14, class: 'bar-label' + (row.pill ? ' is-small' : ''), 'text-anchor': 'start', direction: dir }, g, fit(row.label, W - rowValueW - rowSubW - 14, labelFont));
        if (row.sub) s('text', { x: X(W - rowValueW - 8), y: y + 14, class: 'bar-sub', 'text-anchor': 'end', direction: dir }, g, row.sub);
        s('text', { x: X(W), y: y + 14, class: 'bar-value', 'text-anchor': 'end', direction: dir }, g, row.valueText);
        var sy = y + 22, sw = row.value > 0 ? Math.max(2, (row.value / max) * W) : 0;
        if (track) s('path', { d: barPath(X(0), X(W), sy, barH, 4), class: 'track' }, g);
        if (sw) s('path', { d: barPath(X(0), X(sw), sy, barH, 4), fill: color, class: 'bar' }, g);
      }
      if (row.tip) interactive(g, row.tip);
    });
    return svg;
  }

  // ---- stacked bar: shares of one whole, with a 2px surface gap -------------
  // parts: [{ value, color, label }]; total = sum of values.
  function stackedBar(host, parts, opts) {
    host.textContent = '';
    var rtl = !!opts.rtl, W = Math.max(80, Math.floor(opts.width || host.clientWidth || 200)), H = opts.height || 10;
    var total = parts.reduce(function (a, p) { return a + p.value; }, 0);
    var svg = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, class: 'chart stack', 'aria-hidden': 'true' }, host);
    if (!total) { s('rect', { x: 0, y: 0, width: W, height: H, rx: 4, class: 'track' }, svg); return svg; }
    var shown = parts.filter(function (p) { return p.value > 0; });
    var gap = 2, usable = W - gap * (shown.length - 1), x = 0;
    shown.forEach(function (p, k) {
      var w = Math.max(1, (p.value / total) * usable), lastOne = k === shown.length - 1;
      var x0 = rtl ? W - x : x, x1 = rtl ? W - x - w : x + w;
      // Only the data end (the far end of the last segment) is rounded.
      if (lastOne) s('path', { d: barPath(x0, x1, 0, H, 4), fill: p.color }, svg);
      else s('rect', { x: r1(Math.min(x0, x1)), y: 0, width: r1(w), height: H, fill: p.color }, svg);
      x += w + gap;
    });
    return svg;
  }

  // ---- table twin -------------------------------------------------------------
  // columns: [{ label, num }]; rows: arrays of cell text, or { text, colspan } for a muted
  // cell, or { node } for a cell built by the caller (a sparkline, a link).
  function table(host, caption, columns, rows) {
    host.textContent = '';
    var wrap = h('div', { class: 'table-wrap' }, host);
    var t = h('table', { class: 'data' }, wrap);
    h('caption', { class: 'sr-only' }, t, caption);
    var hr = h('tr', null, h('thead', null, t));
    columns.forEach(function (c) { h('th', { scope: 'col', class: c.num ? 'num' : null }, hr, c.label); });
    var body = h('tbody', null, t);
    rows.forEach(function (row) {
      var tr = h('tr', null, body);
      row.forEach(function (cell, i) {
        var muted = cell && typeof cell === 'object' && !cell.node;
        var td = h(i ? 'td' : 'th', { scope: i ? null : 'row', class: (columns[i].num ? 'num' : '') + (muted ? ' muted' : '') || null }, tr,
          muted ? cell.text : cell && cell.node ? null : cell);
        if (cell && cell.node) td.appendChild(cell.node);
        if (muted && cell.colspan) td.setAttribute('colspan', cell.colspan);
      });
    });
    return t;
  }

  window.SGCharts = {
    h: h, s: s, lineChart: lineChart, barList: barList, stackedBar: stackedBar, table: table, fit: fit, textWidth: textWidth,
    columns: columns, multiples: multiples, sparkline: sparkline, heatmap: heatmap, calendarStrip: calendarStrip,
    dumbbell: dumbbell, stackRows: stackRows,
    interactive: interactive, showTip: showTip, hideTip: hideTip, ticks: ticks, compact: compact, barPath: barPath
  };
}());
