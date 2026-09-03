/**
 * Temperature history chart.
 *
 * Two series -- food tip and ambient -- both in the same unit, so they share
 * ONE y axis. A second scale would invent a correlation that is not in the
 * data, and here it would be doubly silly: they are the same measure.
 *
 * The y axis is deliberately NOT zero-based. Temperature has no meaningful zero
 * in degC or degF, and a line chart carries no "area from the baseline"
 * implication that would require one. Zero-basing would squash a 60->70 degC
 * cook into a flat line.
 *
 * Geometry is separated from painting: buildModel() is pure, so the same maths
 * can be rendered to SVG offline and eyeballed without a browser.
 */

/** Round a span to human tick values (1, 2, 2.5, 5, 10 x 10^n). */
export function niceStep(rawStep) {
  if (!(rawStep > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** Tick values covering [min,max] at roughly `count` intervals. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const step = niceStep((max - min) / Math.max(1, count));
  const first = Math.ceil(min / step) * step;
  const out = [];
  // Guard the loop: floating point can otherwise run away near the boundary.
  for (let v = first, i = 0; v <= max + step * 1e-9 && i < 100; v += step, i++) {
    out.push(Math.round(v / step) * step);
  }
  return out;
}

/**
 * Reduce to at most `maxPoints` by bucketing on x and keeping each bucket's
 * extremes, so spikes survive. Plain stride sampling would drop the peak of a
 * sear, which is the one thing you want to see.
 */
export function downsample(samples, maxPoints) {
  if (samples.length <= maxPoints) return samples;
  const bucketCount = Math.max(1, Math.floor(maxPoints / 2));
  const t0 = samples[0][0];
  const span = samples[samples.length - 1][0] - t0 || 1;
  const buckets = new Map();
  for (const s of samples) {
    const b = Math.min(bucketCount - 1, Math.floor(((s[0] - t0) / span) * bucketCount));
    const cur = buckets.get(b);
    if (!cur) buckets.set(b, [s, s]);
    else {
      if (s[1] < cur[0][1]) cur[0] = s;
      if (s[1] > cur[1][1]) cur[1] = s;
    }
  }
  const out = [];
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const [lo, hi] = buckets.get(b);
    const pair = lo[0] <= hi[0] ? [lo, hi] : [hi, lo];
    out.push(pair[0]);
    if (pair[1] !== pair[0]) out.push(pair[1]);
  }
  return out;
}

/** Relative age label: "now", "-5m", "-2h". Used for prose summaries. */
export function ageLabel(ms) {
  const s = Math.round(ms / 1000);
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `-${m}m`;
  const h = m / 60;
  return `-${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
}

/**
 * Axis tick label, with the unit chosen from the visible span.
 *
 * `ageLabel` alone is wrong for an axis: it calls anything under 45s "now", so
 * a one-minute window rendered three ticks all reading "now". Ticks are
 * measured from the newest sample, not wall-clock now, so the right-hand tick
 * is always exactly "now" and the others cannot duplicate it.
 */
export function tickLabel(msAgo, spanMs) {
  if (msAgo < 500) return 'now';
  if (spanMs <= 150e3) return `-${Math.round(msAgo / 1000)}s`;
  if (spanMs <= 2 * 3600e3) {
    const m = Math.round(msAgo / 60e3);
    return m <= 0 ? 'now' : `-${m}m`;
  }
  const h = msAgo / 3600e3;
  return h < 0.05 ? 'now' : `-${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)}h`;
}

const toC = (raw) => ((raw / 10 - 32) * 5) / 9;
const toF = (raw) => raw / 10;

/**
 * Build the plottable model.
 *
 * @param {object} o
 * @param {Array<[number,number,number,number]>} o.samples [t, rawA, rawB, batt]
 * @param {'c'|'f'} o.unit
 * @param {number|null} o.targetRaw  optional threshold annotation
 * @param {number} o.width  CSS pixels
 * @param {number} o.height CSS pixels
 * @param {{tip:boolean,ambient:boolean}} [o.visible] which series to plot
 *
 * Hiding a series rescales the y axis to what remains. That is the honest way
 * to see detail in the food trace when pit temperature is 100 degrees higher:
 * a second y axis would manufacture a correlation that is not in the data.
 * Colours stay bound to the entity, so the survivor never gets repainted.
 */
export function buildModel({
  samples, unit, targetRaw = null, width, height, now = Date.now(),
  visible = { tip: true, ambient: true },
}) {
  const conv = unit === 'f' ? toF : toC;
  const pad = { top: 14, right: 52, bottom: 20, left: 38 };
  const plot = {
    x: pad.left,
    y: pad.top,
    w: Math.max(10, width - pad.left - pad.right),
    h: Math.max(10, height - pad.top - pad.bottom),
  };

  if (!samples || samples.length === 0) {
    return { empty: true, plot, width, height, series: [], yTicks: [], xTicks: [], target: null };
  }

  // ~2 CSS px per point is plenty; more just costs battery.
  const pts = downsample(samples, Math.max(24, Math.floor(plot.w / 2)));

  const tMin = pts[0][0];
  const tMax = Math.max(pts[pts.length - 1][0], tMin + 1);

  const vals = [];
  for (const s of pts) {
    if (visible.tip) vals.push(conv(s[1]));
    if (visible.ambient) vals.push(conv(s[2]));
  }
  // The target annotates the food series, so it only widens the range when
  // food is on screen.
  if (targetRaw !== null && visible.tip) vals.push(conv(targetRaw));
  if (vals.length === 0) { vals.push(0, 1); }
  let vMin = Math.min(...vals);
  let vMax = Math.max(...vals);
  // A flat trace still needs a band, or it lands on the axis.
  if (vMax - vMin < 2) { const mid = (vMax + vMin) / 2; vMin = mid - 1; vMax = mid + 1; }
  const headroom = (vMax - vMin) * 0.12;
  vMin -= headroom;
  vMax += headroom;

  const sx = (t) => plot.x + ((t - tMin) / (tMax - tMin)) * plot.w;
  const sy = (v) => plot.y + plot.h - ((v - vMin) / (vMax - vMin)) * plot.h;

  const mk = (key, idx, colorVar) => {
    const points = pts.map((s) => {
      const v = conv(s[idx]);
      return { t: s[0], raw: s[idx], v, x: sx(s[0]), y: sy(v) };
    });
    return { key, colorVar, points, last: points[points.length - 1], hidden: !visible[key] };
  };

  const series = [
    mk('tip', 1, '--series-food'),
    mk('ambient', 2, '--series-ambient'),
  ];
  const shown = series.filter((x) => !x.hidden);

  const yTicks = niceTicks(vMin, vMax, 4).map((v) => ({ v, y: sy(v), label: String(Math.round(v)) }));

  // Three x ticks: oldest, middle, newest. More would collide on a phone.
  const span = tMax - tMin;
  const xTicks = [tMin, (tMin + tMax) / 2, tMax].map((t) => ({
    t, x: sx(t), label: tickLabel(tMax - t, span),
  }));

  return {
    empty: false,
    plot, width, height, series, yTicks, xTicks,
    tMin, tMax, vMin, vMax,
    target: targetRaw === null || !visible.tip
      ? null
      : { v: conv(targetRaw), y: sy(conv(targetRaw)) },
    points: pts,
    shown,
  };
}

/** Index of the model point nearest a plot-space x. */
export function nearestIndex(model, px) {
  if (model.empty) return -1;
  const pts = (model.shown?.[0] ?? model.series[0]).points;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i].x - px);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Paint the model onto a canvas.
 *
 * Colours are read from CSS custom properties so the theme lives in one place
 * and the chart is written against roles, not hex.
 */
export function drawChart(canvas, model, { hoverIndex = -1, unit = 'c' } = {}) {
  const css = getComputedStyle(canvas);
  const col = (name, fallback) => (css.getPropertyValue(name) || fallback).trim();
  const surface = col('--chart-surface', '#0f1113');
  const grid = col('--line', '#2e343a');
  const ink = col('--text', '#e8eaed');
  const muted = col('--muted', '#9aa0a6');

  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  canvas.width = Math.round(model.width * dpr);
  canvas.height = Math.round(model.height * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, model.width, model.height);

  g.fillStyle = surface;
  g.fillRect(0, 0, model.width, model.height);

  g.font = '10px system-ui, sans-serif';
  g.textBaseline = 'middle';

  if (model.empty) {
    g.fillStyle = muted;
    g.textAlign = 'center';
    g.fillText('No history yet', model.width / 2, model.height / 2);
    return;
  }

  const { plot } = model;

  // Gridlines: hairline, solid, recessive. Never dashed.
  g.strokeStyle = grid;
  g.lineWidth = 1;
  g.textAlign = 'right';
  for (const t of model.yTicks) {
    const y = Math.round(t.y) + 0.5; // crisp hairline
    g.beginPath();
    g.moveTo(plot.x, y);
    g.lineTo(plot.x + plot.w, y);
    g.stroke();
    g.fillStyle = muted;
    g.fillText(t.label, plot.x - 6, t.y);
  }

  g.textAlign = 'center';
  g.fillStyle = muted;
  for (let i = 0; i < model.xTicks.length; i++) {
    const t = model.xTicks[i];
    const x = i === 0 ? plot.x + 10 : i === model.xTicks.length - 1 ? plot.x + plot.w - 10 : t.x;
    g.fillText(t.label, x, plot.y + plot.h + 11);
  }

  // Target threshold: an annotation, not a series, so it takes muted ink rather
  // than stealing a categorical hue.
  if (model.target) {
    const y = Math.round(model.target.y) + 0.5;
    g.save();
    g.strokeStyle = muted;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(plot.x, y);
    g.lineTo(plot.x + plot.w, y);
    g.stroke();
    g.fillStyle = muted;
    g.textAlign = 'left';
    // Carry the value: a bare "target" next to solid gridlines is ambiguous.
    g.fillText(`target ${model.target.v.toFixed(0)}\u00b0`, plot.x + 4, model.target.y - 7);
    g.restore();
  }

  // Series: 2px, round join/cap.
  for (const s of model.series) {
    if (s.hidden) continue;
    const color = col(s.colorVar, '#888');
    g.strokeStyle = color;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    s.points.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.stroke();

    // End dot, >=8px, with a 2px surface ring so it stays legible where the
    // two traces cross.
    const last = s.last;
    g.beginPath();
    g.arc(last.x, last.y, 4, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = surface;
    g.stroke();
  }

  // Direct end labels in TEXT ink, never the series colour -- identity comes
  // from the coloured dot beside them. Nudge apart if they would collide.
  const labels = model.series.filter((s) => !s.hidden).map((s) => ({
    text: s.last.v.toFixed(1),
    y: s.last.y,
    x: Math.min(s.last.x + 8, plot.x + plot.w + 6),
  }));
  if (labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 12) {
    const mid = (labels[0].y + labels[1].y) / 2;
    const [hi, lo] = labels[0].y <= labels[1].y ? [labels[0], labels[1]] : [labels[1], labels[0]];
    hi.y = mid - 7;
    lo.y = mid + 7;
  }
  g.textAlign = 'left';
  g.fillStyle = ink;
  for (const l of labels) {
    g.fillText(l.text, l.x, Math.max(plot.y + 5, Math.min(plot.y + plot.h - 5, l.y)));
  }

  // Crosshair: finds the X, so the reader aims at a time, not at a 2px line.
  const hoverRef = model.shown?.[0] ?? model.series[0];
  if (hoverIndex >= 0 && hoverIndex < hoverRef.points.length) {
    const hx = hoverRef.points[hoverIndex].x;
    g.strokeStyle = muted;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(hx) + 0.5, plot.y);
    g.lineTo(Math.round(hx) + 0.5, plot.y + plot.h);
    g.stroke();
    for (const s of model.series) {
      if (s.hidden) continue;
      const p = s.points[hoverIndex];
      if (!p) continue;
      g.beginPath();
      g.arc(p.x, p.y, 4, 0, Math.PI * 2);
      g.fillStyle = col(s.colorVar, '#888');
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = surface;
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------- panel
//
// The whole interactive unit -- canvas, legend, crosshair tooltip and table
// view -- built once and updated in place. Packaged here rather than in app.js
// so the dev preview harness renders byte-identical code to the real app.

const LABELS = { tip: 'Food', ambient: 'Ambient' };

/**
 * @param {HTMLElement} host
 * @returns {{update:(o:object)=>void, destroy:()=>void}}
 */
export function createChartPanel(host) {
  host.replaceChildren();
  host.classList.add('chart-panel');

  // Legend is always present for two or more series: identity must never rest
  // on colour-matching alone.
  const legend = document.createElement('ul');
  legend.className = 'chart-legend';
  const legendBtns = {};
  for (const key of ['tip', 'ambient']) {
    const li = document.createElement('li');
    // Tapping a legend entry hides that series and rescales the axis -- the
    // sanctioned alternative to a second y axis when one series dwarfs the
    // other. The last visible series cannot be hidden, or the chart is blank.
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'legend-item';
    btn.setAttribute('aria-pressed', 'true');
    const mark = document.createElement('span');
    // A line key, mirroring the mark -- these are lines, not filled areas.
    mark.className = `legend-key legend-key-${key}`;
    mark.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.textContent = LABELS[key];
    btn.append(mark, name);
    btn.addEventListener('click', () => toggleSeries(key));
    legendBtns[key] = btn;
    li.appendChild(btn);
    legend.appendChild(li);
  }

  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';

  const canvas = document.createElement('canvas');
  canvas.className = 'chart-canvas';
  // Canvas is opaque to assistive tech, so it carries a text summary and the
  // table view below is the real accessible path to the numbers.
  canvas.setAttribute('role', 'img');

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  wrap.append(canvas, tip);

  const tableWrap = document.createElement('details');
  tableWrap.className = 'chart-table';
  const tableSummary = document.createElement('summary');
  tableSummary.textContent = 'Values';
  const table = document.createElement('table');
  tableWrap.append(tableSummary, table);

  host.append(legend, wrap, tableWrap);

  let model = null;
  let state = { samples: [], unit: 'c', targetRaw: null };
  let visible = { tip: true, ambient: true };
  let hoverIndex = -1;

  function toggleSeries(key) {
    const others = Object.keys(visible).filter((k) => k !== key);
    // Refuse to hide the last one rather than rendering an empty plot.
    if (visible[key] && !others.some((k) => visible[k])) return;
    visible = { ...visible, [key]: !visible[key] };
    for (const [k, btn] of Object.entries(legendBtns)) {
      btn.setAttribute('aria-pressed', String(visible[k]));
    }
    hoverIndex = -1;
    tip.hidden = true;
    paint();
  }

  function measure() {
    const w = Math.max(200, Math.round(wrap.clientWidth || host.clientWidth || 300));
    return { w, h: Math.round(Math.min(220, Math.max(140, w * 0.5))) };
  }

  function summarise() {
    if (!model || model.empty) return 'Temperature history: no data yet.';
    const u = state.unit === 'f' ? 'degrees Fahrenheit' : 'degrees Celsius';
    const parts = model.series.filter((s) => !s.hidden).map((s) => {
      const vs = s.points.map((p) => p.v);
      return `${LABELS[s.key]} from ${Math.min(...vs).toFixed(0)} to ${Math.max(...vs).toFixed(0)}, now ${s.last.v.toFixed(1)}`;
    });
    return `Temperature history in ${u} over ${ageLabel(Date.now() - model.tMin).replace('-', '')}. ${parts.join('. ')}.`;
  }

  function renderTable() {
    table.replaceChildren();
    tableWrap.hidden = !model || model.empty;
    if (tableWrap.hidden) return;
    const head = document.createElement('tr');
    for (const h of ['Time', LABELS.tip, LABELS.ambient]) {
      const th = document.createElement('th');
      th.textContent = h; // untrusted-by-default: always textContent
      head.appendChild(th);
    }
    table.appendChild(head);
    // Newest first, capped: this is a reference view on a phone, not an export.
    const rows = downsample(state.samples, 14).slice().reverse();
    const conv = state.unit === 'f' ? (r) => r / 10 : (r) => ((r / 10 - 32) * 5) / 9;
    for (const s of rows) {
      const tr = document.createElement('tr');
      for (const text of [
        new Date(s[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        conv(s[1]).toFixed(1),
        conv(s[2]).toFixed(1),
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
  }

  function paint() {
    const { w, h } = measure();
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    model = buildModel({ ...state, visible, width: w, height: h });
    drawChart(canvas, model, { hoverIndex, unit: state.unit });
    canvas.setAttribute('aria-label', summarise());
  }

  function showTip(i) {
    if (!model || model.empty || i < 0) { tip.hidden = true; return; }
    tip.replaceChildren();
    const when = document.createElement('div');
    when.className = 'chart-tip-when';
    when.textContent = new Date((model.shown?.[0] ?? model.series[0]).points[i].t).toLocaleTimeString();
    tip.appendChild(when);
    // Value leads, series name follows: the reader already knows the series.
    for (const s of model.series) {
      if (s.hidden) continue;
      const p = s.points[i];
      if (!p) continue;
      const row = document.createElement('div');
      row.className = 'chart-tip-row';
      const k = document.createElement('span');
      k.className = `legend-key legend-key-${s.key}`;
      k.setAttribute('aria-hidden', 'true');
      const v = document.createElement('strong');
      v.textContent = `${p.v.toFixed(1)}°`;
      const n = document.createElement('span');
      n.textContent = LABELS[s.key];
      row.append(k, v, n);
      tip.appendChild(row);
    }
    const x = (model.shown?.[0] ?? model.series[0]).points[i].x;
    tip.hidden = false;
    // Flip side near the right edge so the tooltip never leaves the card.
    const half = tip.offsetWidth / 2 || 50;
    tip.style.left = `${Math.max(half, Math.min(model.width - half, x))}px`;
  }

  function onPointer(ev) {
    if (!model || model.empty) return;
    const rect = canvas.getBoundingClientRect();
    hoverIndex = nearestIndex(model, ev.clientX - rect.left);
    drawChart(canvas, model, { hoverIndex, unit: state.unit });
    showTip(hoverIndex);
  }

  function clearHover() {
    hoverIndex = -1;
    if (model) drawChart(canvas, model, { hoverIndex, unit: state.unit });
    tip.hidden = true;
  }

  // Pointer events cover mouse and touch alike. touch-action is set in CSS so a
  // horizontal scrub does not fight page scroll.
  canvas.addEventListener('pointerdown', onPointer);
  canvas.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') onPointer(e); });
  canvas.addEventListener('pointerup', clearHover);
  canvas.addEventListener('pointerleave', clearHover);
  canvas.addEventListener('pointercancel', clearHover);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paint()) : null;
  ro?.observe(wrap);

  return {
    update(next) {
      state = { ...state, ...next };
      paint();
      renderTable();
    },
    destroy() {
      ro?.disconnect();
    },
  };
}
