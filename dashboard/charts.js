/*
 * Small inline-SVG charts for the dashboard (window.SGCharts), drawn from
 * already-prepared rows. Every label goes in with textContent. The dataviz rules:
 * thin marks with a rounded data end and a square baseline, hairline grid, one
 * axis per chart, a tooltip on hover and on keyboard focus, a table twin for
 * every chart (built by the caller with SGCharts.table). In right-to-left pages
 * the charts are mirrored: bars grow from the right and time runs right to left.
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

  // ---- line chart: one series over days ---------------------------------------
  // opts: { points: [{ title, tick, value (null = hidden) }], color, rtl, name,
  //         format(v) -> text, hiddenText, height }
  function lineChart(host, opts) {
    host.textContent = '';
    var points = opts.points, n = points.length, rtl = !!opts.rtl;
    var W = Math.max(260, Math.floor(host.clientWidth || 600)), H = opts.height || 200;
    var values = points.map(function (p) { return p.value; }).filter(function (v) { return v != null; });
    var max = Math.max.apply(null, values.concat([0]));
    var yt = ticks(max || 1, H < 180 ? 3 : 4), yMax = yt[yt.length - 1];
    var font = '12px ' + getComputedStyle(host).fontFamily;
    var axisW = Math.ceil(Math.max.apply(null, yt.map(function (v) { return textWidth(compact(v), font); }))) + 10;
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
      s('text', { x: rtl ? W - axisW + 8 : axisW - 8, y: y + 4, class: 'tick', 'text-anchor': rtl ? 'start' : 'end', direction: 'ltr' }, grid, compact(v));
    });
    // Day labels, counted back from the newest day so the latest always has one;
    // a label that would touch one already placed is skipped (measured, not guessed).
    var widths = points.map(function (p) { return textWidth(p.tick, font); });
    var widest = Math.max.apply(null, widths.concat([10]));
    var every = Math.max(1, Math.ceil((widest + 14) / (n > 1 ? Math.abs(right - left) / (n - 1) : 1e9)));
    if (every > 1) every = [2, 3, 4, 5, 7, 10, 14, 15, 30].filter(function (v) { return v >= every; })[0] || every;
    var placed = [];
    // Arabic day names read right to left; text-anchor follows the text's direction.
    var dir = rtl ? 'rtl' : 'ltr', leftEdge = rtl ? 'end' : 'start', rightEdge = rtl ? 'start' : 'end';
    for (var i = n - 1; i >= 0; i -= every) {
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

    // The line breaks at hidden days; an isolated day is a dot.
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
      var d = seg.map(function (i, k) { return (k ? 'L' : 'M') + r1(X(i)) + ' ' + r1(Y(points[i].value)); }).join('');
      s('path', { d: d + 'L' + r1(X(seg[seg.length - 1])) + ' ' + r1(Y(0)) + 'L' + r1(X(seg[0])) + ' ' + r1(Y(0)) + 'Z',
        fill: opts.color, class: 'area' }, marks);
      s('path', { d: d, stroke: opts.color, class: 'line' }, marks);
    });
    points.forEach(function (p, i) {
      if (p.value == null) s('rect', { x: r1(X(i)) - 3, y: r1(Y(0)) - 1, width: 6, height: 3, rx: 1.5, class: 'hidden-day' }, marks);
    });
    // The newest shown value gets a dot and its number.
    for (var last = n - 1; last >= 0 && points[last].value == null; last--);
    if (last >= 0) {
      var lx = X(last), ly = Y(points[last].value);
      s('circle', { cx: r1(lx), cy: r1(ly), r: 4, fill: opts.color, class: 'end-dot' }, marks);
      var atEdge = last === n - 1;
      s('text', { x: r1(lx), y: r1(ly) - 10, class: 'end-label', direction: 'ltr',
        'text-anchor': atEdge ? (rtl ? 'start' : 'end') : 'middle' }, marks, opts.format(points[last].value));
    }

    // Crosshair: snaps to the nearest day.
    var cross = s('g', { class: 'cross', visibility: 'hidden' }, svg);
    var crossLine = s('line', { y1: top - 6, y2: Y(0), class: 'cross-line' }, cross);
    var crossDot = s('circle', { r: 4.5, fill: opts.color, class: 'end-dot' }, cross);
    var hit = s('rect', { x: Math.min(left, right) - 6, y: 0, width: Math.abs(right - left) + 12, height: H, fill: 'transparent', class: 'hit' }, svg);
    var at = -1;
    function content(i) {
      var p = points[i];
      return p.value == null
        ? { title: p.title, note: opts.hiddenText }
        : { title: p.title, rows: [{ value: opts.format(p.value), label: opts.unit || '', color: opts.color, swatch: 'line' }] };
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

  // ---- bar list: one row per item ---------------------------------------------
  // Wide: label | bar | value at the bar's tip (or, over a 0-100 % track, in a
  // column after it). Narrow: the label and value on a line above the bar.
  // Text anchors are logical (start = the reading side) and follow the page direction.
  // opts: { rows: [{ label, value, valueText, sub, tip, color }], max, color, rtl, name, track }
  function barList(host, opts) {
    host.textContent = '';
    var rows = opts.rows, rtl = !!opts.rtl, track = !!opts.track;
    var W = Math.max(240, Math.floor(host.clientWidth || 400));
    var max = opts.max || Math.max.apply(null, rows.map(function (r) { return r.value || 0; }).concat([1]));
    var X = function (x) { return rtl ? W - x : x; };
    var family = getComputedStyle(host).fontFamily;
    var labelFont = '13px ' + family, valueFont = '600 13px ' + family, subFont = '12px ' + family;
    var valueW = Math.max.apply(null, rows.map(function (r) { return textWidth(r.valueText, valueFont); }).concat([0]));
    var subW = Math.max.apply(null, rows.map(function (r) { return r.sub ? textWidth(r.sub, subFont) : 0; }).concat([0]));
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
        s('text', { x: X(0), y: base, class: 'bar-label', 'text-anchor': 'start', direction: dir }, g, fit(row.label, labelW - 12, labelFont));
        if (track) s('path', { d: barPath(X(labelW), X(barEnd), by, barH, 4), class: 'track' }, g);
        if (w) s('path', { d: barPath(X(labelW), X(labelW + w), by, barH, 4), fill: color, class: 'bar' }, g);
        var vx = track ? barEnd + 10 : labelW + w + 8;
        s('text', { x: X(vx), y: base, class: 'bar-value', 'text-anchor': 'start', direction: dir }, g, row.valueText);
        if (row.sub) s('text', { x: X(vx + textWidth(row.valueText, valueFont) + 8), y: base, class: 'bar-sub', 'text-anchor': 'start', direction: dir }, g, row.sub);
      } else {
        var rowValueW = textWidth(row.valueText, valueFont), rowSubW = row.sub ? textWidth(row.sub, subFont) + 10 : 0;
        s('text', { x: X(0), y: y + 14, class: 'bar-label', 'text-anchor': 'start', direction: dir }, g, fit(row.label, W - rowValueW - rowSubW - 14, labelFont));
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
  // columns: [{ label, num }]; rows: arrays of cell text (or { text, hidden }).
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
        var hidden = cell && typeof cell === 'object';
        var td = h(i ? 'td' : 'th', { scope: i ? null : 'row', class: (columns[i].num ? 'num' : '') + (hidden ? ' muted' : '') || null }, tr,
          hidden ? cell.text : cell);
        if (hidden && cell.colspan) td.setAttribute('colspan', cell.colspan);
      });
    });
    return t;
  }

  window.SGCharts = {
    h: h, s: s, lineChart: lineChart, barList: barList, stackedBar: stackedBar, table: table, fit: fit, textWidth: textWidth,
    interactive: interactive, showTip: showTip, hideTip: hideTip, ticks: ticks, compact: compact, barPath: barPath
  };
}());
