/**
 * Registry tests -- in particular that several probes are tracked at once,
 * which is the whole point of reading advertisements instead of connecting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Minimal localStorage shim: the registry persists, and node has no DOM.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { ProbeRegistry, OFFLINE_MS, STALE_MS } = await import('../public/js/store.js');
const { parseMfgData } = await import('../public/js/protocol.js');

const hex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));

/** Build a frame with a chosen probe id and sensor values. */
function frame(probeIdHex, rawA, rawB, batt = 100) {
  const b = hex('06' + batt.toString(16).padStart(2, '0') + '0101' + probeIdHex + '00000000');
  b[10] = rawA & 0xff; b[11] = (rawA >> 8) & 0xff;
  b[12] = rawB & 0xff; b[13] = (rawB >> 8) & 0xff;
  return b;
}

const A = '5ce1024db36c';
const B = 'aabbccddeeff';

test('tracks multiple probes simultaneously, keyed by payload probe id', () => {
  mem.clear();
  const r = new ProbeRegistry();
  r.ingest(parseMfgData(frame(A, 761, 728), { id: 'dev-a', name: 'Ninja-WP100-R' }));
  r.ingest(parseMfgData(frame(B, 1400, 900), { id: 'dev-b', name: 'Ninja-WP100-R' }));
  r.ingest(parseMfgData(frame(A, 765, 730), { id: 'dev-a', name: 'Ninja-WP100-R' }));

  assert.equal(r.probes.size, 2);
  assert.equal(r.get(A).last.rawA, 765);
  assert.equal(r.get(B).last.rawA, 1400);
  // Both probes accumulate independent history.
  assert.equal(r.get(A).samples.length, 2);
  assert.equal(r.get(B).samples.length, 1);
});

test('identity survives a changed browser device id', () => {
  // Web Bluetooth mints a per-origin device id, so it can differ between
  // sessions while the probe is the same physical device.
  mem.clear();
  const r = new ProbeRegistry();
  r.ingest(parseMfgData(frame(A, 761, 728), { id: 'origin-1' }));
  r.ingest(parseMfgData(frame(A, 763, 728), { id: 'origin-2' }));
  assert.equal(r.probes.size, 1);
  assert.equal(r.get(A).deviceId, 'origin-2');
});

test('newly discovered probes are shown by default', () => {
  mem.clear();
  const r = new ProbeRegistry();
  r.ingest(parseMfgData(frame(A, 761, 728)));
  assert.equal(r.get(A).selected, true);
  r.setSelected(A, false);
  assert.equal(r.selected().length, 0);
});

test('history stores raw counts, not converted degrees', () => {
  // So a later correction to the scale reinterprets old data correctly rather
  // than having today's conversion baked in.
  mem.clear();
  const r = new ProbeRegistry();
  r.ingest(parseMfgData(frame(A, 761, 728)));
  const [, rawA, rawB] = r.get(A).samples[0];
  assert.equal(rawA, 761);
  assert.equal(rawB, 728);
});

test('suppresses immediate duplicate advertisements', () => {
  // The probe re-advertises unchanged values every ~10s between sensor
  // updates; recording every repeat would bloat history for no information.
  mem.clear();
  const r = new ProbeRegistry();
  const now = Date.now();
  r.ingest({ ...parseMfgData(frame(A, 761, 728)), t: now });
  r.ingest({ ...parseMfgData(frame(A, 761, 728)), t: now + 1000 });
  assert.equal(r.get(A).samples.length, 1);
  // ...but a repeat after the window is kept, so a flat cook still has data.
  r.ingest({ ...parseMfgData(frame(A, 761, 728)), t: now + 6000 });
  assert.equal(r.get(A).samples.length, 2);
});

test('status reflects reading age', () => {
  mem.clear();
  const r = new ProbeRegistry();
  const p = r.ingest(parseMfgData(frame(A, 761, 728)));
  const t = p.lastSeen;
  assert.equal(r.status(p, t + 1000), 'live');
  assert.equal(r.status(p, t + STALE_MS + 1000), 'stale');
  assert.equal(r.status(p, t + OFFLINE_MS + 1000), 'offline');
});

test('nicknames and unit persist across a reload', () => {
  mem.clear();
  const r1 = new ProbeRegistry();
  r1.ingest(parseMfgData(frame(A, 761, 728)));
  r1.setNickname(A, 'brisket');
  r1.setUnit('f');
  r1._save(); // bypass the debounce

  const r2 = new ProbeRegistry();
  assert.equal(r2.unit, 'f');
  assert.equal(r2.get(A).nickname, 'brisket');
  assert.equal(r2.get(A).samples.length, 1);
  // A remembered probe must not resurrect a stale temperature as current.
  assert.equal(r2.get(A).last, null);
  assert.equal(r2.status(r2.get(A)), 'offline');
});

test('CSV export includes raw counts and converted degrees', () => {
  mem.clear();
  const r = new ProbeRegistry();
  r.ingest(parseMfgData(frame(A, 761, 728)));
  const csv = r.toCSV(A);
  const [head, row] = csv.split('\n');
  assert.match(head, /tip_raw,ambient_raw/);
  assert.match(row, /,761,728,100$/);
  assert.match(row, /,24\.50,22\.67,/); // 76.1 F and 72.8 F in Celsius
});

test('surviving corrupt persisted state', () => {
  mem.clear();
  mem.set('fun.state.v1', '{not json');
  const r = new ProbeRegistry(); // must not throw
  assert.equal(r.probes.size, 0);
});

// ---------------------------------------------------------------- alarms

const { cToRaw } = await import('../public/js/protocol.js');

/** Feed a reading with a given food temperature in Celsius. */
function feed(r, c, ambientC = 100) {
  return r.ingest(parseMfgData(frame(A, cToRaw(c), cToRaw(ambientC))));
}

test('alarm fires when the food sensor reaches the target', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  r.setTarget(A, cToRaw(60));
  assert.equal(r.get(A).alarmState, 'idle');

  let fired = 0;
  r.addEventListener('alarm-fired', () => { fired++; });

  feed(r, 59.5);
  assert.equal(r.get(A).alarmState, 'idle');
  feed(r, 60.2);
  assert.equal(r.get(A).alarmState, 'fired');
  assert.equal(fired, 1);
});

test('a fired alarm does not re-fire on every advertisement', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  let fired = 0;
  r.addEventListener('alarm-fired', () => { fired++; });
  r.setTarget(A, cToRaw(60));
  for (const c of [61, 62, 63, 64]) feed(r, c);
  assert.equal(fired, 1, 'should latch, not fire once per reading');
});

test('acknowledging stops the alarm and it does not immediately return', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  r.setTarget(A, cToRaw(60));
  feed(r, 61);
  assert.equal(r.get(A).alarmState, 'fired');
  r.acknowledgeAlarm(A);
  assert.equal(r.get(A).alarmState, 'acked');
  // Hovering right on the threshold must not retrigger.
  for (const c of [60.5, 61, 60.1, 62]) feed(r, c);
  assert.equal(r.get(A).alarmState, 'acked');
});

test('alarm re-arms only after dropping clear of the target', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  r.setTarget(A, cToRaw(60));
  feed(r, 61);
  r.acknowledgeAlarm(A);
  feed(r, 59.5);             // inside the re-arm margin, still acked
  assert.equal(r.get(A).alarmState, 'acked');
  feed(r, 55);               // clearly below -> re-armed
  assert.equal(r.get(A).alarmState, 'idle');
  feed(r, 61);
  assert.equal(r.get(A).alarmState, 'fired');
});

test('a target already exceeded fires at once, not on the next advertisement', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 80);
  let fired = 0;
  r.addEventListener('alarm-fired', () => { fired++; });
  r.setTarget(A, cToRaw(60));
  assert.equal(r.get(A).alarmState, 'fired');
  assert.equal(fired, 1);
});

test('changing the target rearms an acknowledged alarm', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  r.setTarget(A, cToRaw(60));
  feed(r, 61);
  r.acknowledgeAlarm(A);
  r.setTarget(A, cToRaw(90));
  assert.equal(r.get(A).alarmState, 'idle');
  feed(r, 91);
  assert.equal(r.get(A).alarmState, 'fired');
});

test('clearing the target disarms', () => {
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  r.setTarget(A, cToRaw(60));
  feed(r, 61);
  assert.equal(r.get(A).alarmState, 'fired');
  r.setTarget(A, null);
  assert.equal(r.get(A).targetRaw, null);
  assert.equal(r.get(A).alarmState, 'idle');
  feed(r, 99);
  assert.equal(r.get(A).alarmState, 'idle');
});

test('a disconnected sensor sentinel never trips the target', () => {
  // 0x7FFF as a raw number is enormous and would clear any target; the guard
  // is on the decoded temperature being null, not on the raw value.
  mem.clear();
  const r = new ProbeRegistry();
  feed(r, 20);
  r.setTarget(A, cToRaw(60));
  const bad = frame(A, 0, cToRaw(100));
  bad[10] = 0xff; bad[11] = 0x7f;
  r.ingest(parseMfgData(bad));
  assert.equal(r.get(A).alarmState, 'idle');
});

test('target persists across a reload but a fired alarm does not', () => {
  mem.clear();
  const r1 = new ProbeRegistry();
  feed(r1, 20);
  r1.setTarget(A, cToRaw(60));
  feed(r1, 61);
  assert.equal(r1.get(A).alarmState, 'fired');
  r1._save();

  const r2 = new ProbeRegistry();
  assert.equal(r2.get(A).targetRaw, cToRaw(60));
  // Reviving a fired alarm on load would be alarming about a temperature from
  // a previous session.
  assert.equal(r2.get(A).alarmState, 'idle');
});

test('firing() lists only the probes currently sounding', () => {
  mem.clear();
  const r = new ProbeRegistry();
  r.ingest(parseMfgData(frame(A, cToRaw(20), cToRaw(100))));
  r.ingest(parseMfgData(frame(B, cToRaw(20), cToRaw(100))));
  r.setTarget(A, cToRaw(30));
  r.ingest(parseMfgData(frame(A, cToRaw(35), cToRaw(100))));
  assert.deepEqual(r.firing().map((p) => p.probeId), [A]);
});

test('a persisted phantom probe is purged on load', () => {
  // Builds before the placeholder-frame fix wrote these into localStorage.
  mem.clear();
  mem.set('fun.state.v1', JSON.stringify({
    unit: 'c',
    probes: [
      { probeId: '000000000000', name: 'Ninja-WP100-R', samples: [], selected: true },
      { probeId: A, name: 'Ninja-WP100-R', samples: [], selected: true },
    ],
  }));
  const r = new ProbeRegistry();
  assert.equal(r.probes.size, 1);
  assert.ok(r.get(A), 'the real probe must survive');
  assert.equal(r.get('000000000000'), undefined);
});

// ---------------------------------------------------------------- setup guide

test('setup guide dismissal persists across a reload', () => {
  mem.clear();
  const r1 = new ProbeRegistry();
  assert.equal(r1.setupDismissed, false, 'shown on a first visit');
  r1.setSetupDismissed(true);
  r1._save();

  const r2 = new ProbeRegistry();
  assert.equal(r2.setupDismissed, true, 'must not reappear on every load');
});

test('dismissal defaults to false for state saved before the flag existed', () => {
  mem.clear();
  mem.set('fun.state.v1', JSON.stringify({ unit: 'c', probes: [] }));
  const r = new ProbeRegistry();
  assert.equal(r.setupDismissed, false);
});

test('setSetupDismissed is idempotent and can be reversed', () => {
  mem.clear();
  const r = new ProbeRegistry();
  r.setSetupDismissed(true);
  r.setSetupDismissed(true);
  assert.equal(r.setupDismissed, true);
  r.setSetupDismissed(false);
  assert.equal(r.setupDismissed, false);
});

test('dismissal survives alongside probes and unit', () => {
  mem.clear();
  const r1 = new ProbeRegistry();
  r1.ingest(parseMfgData(frame(A, 761, 728)));
  r1.setNickname(A, 'brisket');
  r1.setUnit('f');
  r1.setSetupDismissed(true);
  r1._save();

  const r2 = new ProbeRegistry();
  assert.equal(r2.setupDismissed, true);
  assert.equal(r2.unit, 'f');
  assert.equal(r2.get(A).nickname, 'brisket');
});

test('corrupt state does not leave the guide permanently dismissed', () => {
  // Failing open matters: a user who has never seen the guide must get it.
  mem.clear();
  mem.set('fun.state.v1', '{broken');
  const r = new ProbeRegistry();
  assert.equal(r.setupDismissed, false);
});

test('shouldShowSetup: dismissal is respected only while nothing is blocking', async () => {
  const { shouldShowSetup } = await import('../public/js/store.js');
  // First visit: always show.
  assert.equal(shouldShowSetup({ dismissed: false, ready: true }), true);
  assert.equal(shouldShowSetup({ dismissed: false, ready: false }), true);
  // Dismissed and everything fine: stay out of the way. This is the branch a
  // headless browser cannot reach, since it exposes no Web Bluetooth.
  assert.equal(shouldShowSetup({ dismissed: true, ready: true }), false);
  // Dismissed but something is blocking: override, or the disabled scan button
  // has no visible explanation.
  assert.equal(shouldShowSetup({ dismissed: true, ready: false }), true);
});
