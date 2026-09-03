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
