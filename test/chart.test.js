/** Tests for the chart's pure geometry -- no DOM needed. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ageLabel, buildModel, downsample, nearestIndex, niceStep, niceTicks, tickLabel,
} from '../public/js/chart.js';

const cToRaw = (c) => Math.round((c * 9 / 5 + 32) * 10);

function series(n, tipC, ambC, spanMs = 3600e3) {
  const now = 1_700_000_000_000;
  return Array.from({ length: n }, (_, i) => {
    const f = n === 1 ? 0 : i / (n - 1);
    return [now - (1 - f) * spanMs, cToRaw(tipC(f)), cToRaw(ambC(f)), 100];
  });
}

test('niceStep snaps to human increments', () => {
  assert.equal(niceStep(0.9), 1);
  assert.equal(niceStep(1.7), 2);
  assert.equal(niceStep(2.3), 2.5);
  assert.equal(niceStep(4), 5);
  assert.equal(niceStep(23), 25);
  assert.equal(niceStep(0), 1); // degenerate input must not hang or NaN
});

test('niceTicks stays inside the range and terminates', () => {
  const t = niceTicks(3.2, 47.8, 4);
  assert.ok(t.length >= 2 && t.length <= 8, `got ${t.length} ticks`);
  for (const v of t) assert.ok(v >= 3.2 && v <= 47.8, `${v} outside range`);
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(niceTicks(NaN, 3), []);
  // A pathological span must not spin forever.
  assert.ok(niceTicks(0, 1e12, 4).length <= 100);
});

test('tickLabel scales its unit to the span, never duplicating "now"', () => {
  // The bug this replaced: a 60s window produced three ticks all reading "now".
  assert.equal(tickLabel(0, 60e3), 'now');
  assert.equal(tickLabel(30e3, 60e3), '-30s');
  assert.equal(tickLabel(60e3, 60e3), '-60s');
  assert.equal(tickLabel(20 * 60e3, 40 * 60e3), '-20m');
  assert.equal(tickLabel(4.5 * 3600e3, 9 * 3600e3), '-4.5h');
  const span = 60e3;
  const labels = [span, span / 2, 0].map((d) => tickLabel(d, span));
  assert.equal(new Set(labels).size, 3, `duplicate axis labels: ${labels}`);
});

test('ageLabel is for prose, and still collapses recent to "now"', () => {
  assert.equal(ageLabel(1000), 'now');
  assert.equal(ageLabel(5 * 60e3), '-5m');
});

test('downsample caps the count but preserves extremes', () => {
  const s = series(2000, (f) => 20 + f * 50, () => 100);
  // Inject a spike that plain stride sampling would very likely drop.
  s[971][1] = cToRaw(240);
  const out = downsample(s, 60);
  assert.ok(out.length <= 60, `got ${out.length}`);
  const max = Math.max(...out.map((x) => x[1]));
  assert.equal(max, cToRaw(240), 'the spike was lost');
});

test('downsample keeps chronological order', () => {
  const out = downsample(series(900, (f) => 20 + f * 40, (f) => 100 + Math.sin(f * 30) * 20), 40);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i][0] >= out[i - 1][0], `out of order at ${i}`);
  }
});

test('downsample passes small inputs through untouched', () => {
  const s = series(5, (f) => 20 + f, () => 100);
  assert.equal(downsample(s, 60), s);
});

test('buildModel reports empty for no samples', () => {
  const m = buildModel({ samples: [], unit: 'c', width: 300, height: 150 });
  assert.equal(m.empty, true);
  assert.deepEqual(m.series, []);
});

test('buildModel keeps points inside the plot box', () => {
  const m = buildModel({
    samples: series(200, (f) => 20 + f * 60, (f) => 110 + Math.sin(f * 20) * 10),
    unit: 'c', width: 320, height: 160,
  });
  for (const s of m.series) {
    for (const pt of s.points) {
      assert.ok(pt.x >= m.plot.x - 0.5 && pt.x <= m.plot.x + m.plot.w + 0.5, `x ${pt.x}`);
      assert.ok(pt.y >= m.plot.y - 0.5 && pt.y <= m.plot.y + m.plot.h + 0.5, `y ${pt.y}`);
    }
  }
});

test('a flat trace still gets a visible band', () => {
  // Without a minimum span a constant reading lands exactly on the axis.
  const m = buildModel({
    samples: series(50, () => 22, () => 22), unit: 'c', width: 300, height: 150,
  });
  assert.ok(m.vMax - m.vMin >= 2, `band too narrow: ${m.vMax - m.vMin}`);
  for (const s of m.series) {
    for (const pt of s.points) {
      assert.ok(pt.y > m.plot.y && pt.y < m.plot.y + m.plot.h, 'flat line sits on an edge');
    }
  }
});

test('hiding a series rescales the axis to what remains', () => {
  const samples = series(100, (f) => 20 + f * 50, () => 180);
  const both = buildModel({ samples, unit: 'c', width: 320, height: 160 });
  const foodOnly = buildModel({
    samples, unit: 'c', width: 320, height: 160, visible: { tip: true, ambient: false },
  });
  // The whole point: dropping the 180C pit trace lets the food range breathe.
  assert.ok(both.vMax > 170, 'both-series range should include the pit');
  assert.ok(foodOnly.vMax < 100, `food-only range should shrink, got ${foodOnly.vMax}`);
  assert.equal(foodOnly.series.find((s) => s.key === 'ambient').hidden, true);
  assert.equal(foodOnly.shown.length, 1);
});

test('colour binding never depends on which series survive', () => {
  const samples = series(50, (f) => 20 + f * 10, () => 150);
  const a = buildModel({ samples, unit: 'c', width: 300, height: 150 });
  const b = buildModel({
    samples, unit: 'c', width: 300, height: 150, visible: { tip: false, ambient: true },
  });
  const varOf = (m, k) => m.series.find((s) => s.key === k).colorVar;
  assert.equal(varOf(a, 'tip'), varOf(b, 'tip'));
  assert.equal(varOf(a, 'ambient'), varOf(b, 'ambient'));
});

test('the target only widens the range while food is shown', () => {
  const samples = series(50, () => 20, () => 22);
  const withTarget = buildModel({
    samples, unit: 'c', width: 300, height: 150, targetRaw: cToRaw(95),
  });
  assert.ok(withTarget.vMax > 90, 'target should be on screen');
  const foodHidden = buildModel({
    samples, unit: 'c', width: 300, height: 150, targetRaw: cToRaw(95),
    visible: { tip: false, ambient: true },
  });
  assert.equal(foodHidden.target, null, 'target annotates food; hide food, hide target');
  assert.ok(foodHidden.vMax < 40);
});

test('unit choice changes the plotted values', () => {
  const samples = series(20, () => 100, () => 100);
  const c = buildModel({ samples, unit: 'c', width: 300, height: 150 });
  const f = buildModel({ samples, unit: 'f', width: 300, height: 150 });
  assert.ok(Math.abs(c.series[0].last.v - 100) < 0.5);
  assert.ok(Math.abs(f.series[0].last.v - 212) < 0.5);
});

test('nearestIndex snaps to the closest point and works with a hidden series', () => {
  const samples = series(60, (f) => 20 + f * 40, () => 150);
  const m = buildModel({
    samples, unit: 'c', width: 320, height: 160, visible: { tip: false, ambient: true },
  });
  const pts = m.shown[0].points;
  assert.equal(nearestIndex(m, pts[0].x - 999), 0);
  assert.equal(nearestIndex(m, pts[pts.length - 1].x + 999), pts.length - 1);
  const mid = Math.floor(pts.length / 2);
  assert.equal(nearestIndex(m, pts[mid].x), mid);
  assert.equal(nearestIndex(buildModel({ samples: [], unit: 'c', width: 300, height: 150 }), 5), -1);
});

test('a single sample does not crash the model', () => {
  const m = buildModel({ samples: series(1, () => 30, () => 90), unit: 'c', width: 300, height: 150 });
  assert.equal(m.empty, false);
  assert.equal(m.series[0].points.length, 1);
  assert.ok(Number.isFinite(m.series[0].last.x));
  assert.ok(Number.isFinite(m.series[0].last.y));
});
