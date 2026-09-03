/**
 * Tests for the browser parser, against bytes actually captured off the air.
 *
 * The fixtures are shared verbatim with the companion Python parser,
 * deliberately: the two implementations must agree, so they are pinned to
 * identical bytes. See PROTOCOL.md section 9.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cToRaw, fToRaw, fmtTemp, isUnsetProbeId, parseMfgData, rawToC, rawToF,
} from '../public/js/protocol.js';

const hex = (s) => new Uint8Array(s.match(/../g).map((b) => parseInt(b, 16)));

// Real payloads, in capture order, from
// a 90s capture of a probe resting in free air -- see PROTOCOL.md section 9.
const REAL = [
  '066401015ce1024db36c0203da02',
  '066401015ce1024db36cfe02d802',
  '066401015ce1024db36cf902d802',
  '066401015ce1024db36cf702d802',
  '066401015ce1024db36cf502d802',
];

test('parses every real captured frame', () => {
  for (const h of REAL) {
    const r = parseMfgData(hex(h));
    assert.ok(r, `failed to parse ${h}`);
    assert.equal(r.frameType, 0x06);
    // byte 1 under a legacy name -- a constant, not a battery level; see
    // 'byte 1 is a constant, not a battery level' below
    assert.equal(r.batteryPct, 100);
    assert.equal(r.probeId, '5ce1024db36c');
    assert.equal(r.readingValid, true);   // byte 2 == 1
    assert.equal(r.unknown3, 1);
  }
});

test('temperatures match the hand decode', () => {
  const r = parseMfgData(hex(REAL[2]));
  assert.equal(r.rawA, 761);
  assert.equal(r.rawB, 728);
  assert.ok(Math.abs(r.tipF - 76.1) < 1e-9);
  assert.ok(Math.abs(r.ambientF - 72.8) < 1e-9);
  // The owner's reference thermometer read 24.2 C at this moment.
  assert.ok(Math.abs(r.tipC - 24.5) < 0.05);
});

test('sensor A drifts while B holds steady', () => {
  // This is the physical observation the tip/ambient assignment rests on.
  const a = REAL.map((h) => parseMfgData(hex(h)).rawA);
  const b = REAL.map((h) => parseMfgData(hex(h)).rawB);
  assert.deepEqual(a, [770, 766, 761, 759, 757]);
  assert.deepEqual(a, [...a].sort((x, y) => y - x));
  assert.ok(new Set(b).size <= 2);
});

test('accepts DataView and ArrayBuffer, as Web Bluetooth hands them over', () => {
  const bytes = hex(REAL[2]);
  const fromView = parseMfgData(new DataView(bytes.buffer));
  const fromBuffer = parseMfgData(bytes.buffer);
  assert.equal(fromView.rawA, 761);
  assert.equal(fromBuffer.rawA, 761);
});

test('honours a non-zero byteOffset in a DataView', () => {
  // Chrome hands out views onto a larger buffer; ignoring byteOffset would
  // silently decode the wrong bytes.
  const bytes = hex(REAL[2]);
  const padded = new Uint8Array(8 + bytes.length);
  padded.set(bytes, 8);
  const view = new DataView(padded.buffer, 8, bytes.length);
  assert.equal(parseMfgData(view).rawA, 761);
});

test('known fixpoints', () => {
  assert.ok(Math.abs(rawToC(320) - 0) < 1e-9); // 32.0 F is 0 C
  assert.ok(Math.abs(rawToC(2120) - 100) < 1e-9); // 212.0 F is 100 C
});

test('conversions round-trip', () => {
  for (const f of [32, 76.1, 165, 212]) assert.ok(Math.abs(rawToF(fToRaw(f)) - f) < 0.05);
  for (const c of [0, 24.5, 60, 100]) assert.ok(Math.abs(rawToC(cToRaw(c)) - c) < 0.06);
});

test('negative temperatures decode (freezer)', () => {
  // -0.4 F is raw -4, which only decodes correctly with a signed read.
  const b = hex('066401015ce1024db36c0000d802');
  b[10] = 0xfc; b[11] = 0xff; // -4 little-endian
  const r = parseMfgData(b);
  assert.equal(r.rawA, -4);
  assert.ok(Math.abs(r.tipF - -0.4) < 1e-9);
});

test('rejects garbage without throwing', () => {
  assert.equal(parseMfgData(null), null);
  assert.equal(parseMfgData(new Uint8Array(0)), null);
  assert.equal(parseMfgData(hex('0664')), null); // too short
  assert.equal(parseMfgData(new Uint8Array(14)), null); // frame type 0
  assert.equal(parseMfgData(hex('99' + '00'.repeat(13))), null); // wrong frame type
  assert.equal(parseMfgData('not bytes'), null);
});

test('sentinel becomes null rather than a nonsense temperature', () => {
  const b = hex('066401015ce1024db36cffffd802');
  b[10] = 0xff; b[11] = 0x7f; // 0x7FFF
  const r = parseMfgData(b);
  assert.equal(r.tipC, null);
  assert.equal(r.rawA, 0x7fff);
  assert.notEqual(r.ambientC, null);
});

test('fmtTemp shows one decimal and handles missing data', () => {
  const r = parseMfgData(hex(REAL[2]));
  assert.equal(fmtTemp(r, 'tip', 'f'), '76.1');
  assert.equal(fmtTemp(r, 'tip', 'c'), '24.5');
  assert.equal(fmtTemp(null, 'tip', 'c'), '--');
});

// ---- power-on placeholder frame -----------------------------------------
// Observed in the field: a probe being switched on broadcasts a frame with a
// valid type and battery but an all-zero id and both temperatures at 0xFFFF.
// Accepting it created a phantom probe keyed "000000000000" showing "--".

test('rejects the power-on placeholder frame', () => {
  const placeholder = hex('06640101000000000000ffffffff');
  // exactly what the phone saw: id all zeros, both sensors 0xFFFF (-1 signed)
  const b = hex('066401010000000000000000ffff');
  b.set([0, 0, 0, 0, 0, 0], 4);
  b[10] = 0xff; b[11] = 0xff; b[12] = 0xff; b[13] = 0xff;
  assert.equal(parseMfgData(b), null, 'phantom probe must not be created');
  assert.equal(placeholder.length, 14); // fixture sanity
});

test('rejects an all-0xFF probe id too', () => {
  const b = hex('066401015ce1024db36cf902d802');
  b.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 4);
  assert.equal(parseMfgData(b), null);
});

test('a real frame with a valid id still parses when a sensor reads 0xFFFF', () => {
  // Only the id makes a frame unusable. A real probe reporting one bad sensor
  // must still be shown, with that sensor blank.
  const b = hex('066401015ce1024db36cf902d802');
  b[10] = 0xff; b[11] = 0xff;
  const r = parseMfgData(b);
  assert.ok(r, 'must not drop a frame from an identified probe');
  assert.equal(r.probeId, '5ce1024db36c');
  assert.equal(r.tipC, null);
  assert.notEqual(r.ambientC, null);
});

test('isUnsetProbeId recognises the unpopulated patterns', () => {
  assert.equal(isUnsetProbeId('000000000000'), true);
  assert.equal(isUnsetProbeId('FFFFFFFFFFFF'), true);
  assert.equal(isUnsetProbeId(''), true);
  assert.equal(isUnsetProbeId(null), true);
  assert.equal(isUnsetProbeId('5ce1024db36c'), false);
});


// Two probes captured simultaneously, one near-full and one running on the
// partial charge it shipped from the factory with. See PROTOCOL.md section 9.1
// -- this is the capture that disproved the "byte 1 is battery percent"
// reading. Shared verbatim with the Python suite.
const TWO_PROBES = [
  { addr: '48:31:B7:C5:D8:9A', charge: 'near full', hex: '066401015ce1024db36c0c03f902', probeId: '5ce1024db36c' },
  { addr: '48:31:B7:C6:05:2E', charge: 'low',       hex: '0664010130eb024db36c14031003', probeId: '30eb024db36c' },
];

test('byte 1 is a constant, not a battery level', () => {
  // Two cells at different states of charge cannot both be 100%, so the byte
  // carries no charge information. Pinned so nobody re-derives "battery
  // percent" from a single fully charged probe again.
  for (const p of TWO_PROBES) {
    const r = parseMfgData(hex(p.hex));
    assert.ok(r, p.addr);
    assert.equal(r.batteryPct, 100, `${p.addr} (${p.charge})`);
  }
});

test('only the serial and the temperatures differ between probes', () => {
  const [a, b] = TWO_PROBES.map((p) => hex(p.hex));

  const differing = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differing.push(i);

  // Every difference falls inside the serial (4-5) or the temperatures
  // (10-13). Bytes inside those fields can still coincide, as byte 11 does
  // here: both probes sat near 78 F, so both high bytes are 0x03.
  const allowed = new Set([4, 5, 10, 11, 12, 13]);
  assert.deepEqual(differing.filter((i) => !allowed.has(i)), []);

  // The real claim: nothing outside those two fields varies at all, so no byte
  // is available to carry a battery level.
  assert.deepEqual(Array.from(a.slice(0, 4)), [0x06, 0x64, 0x01, 0x01]);
  assert.deepEqual(Array.from(b.slice(0, 4)), [0x06, 0x64, 0x01, 0x01]);

  // Bytes 6-9 are a constant shared by both units, so the probe id is really a
  // 2-byte serial plus a 4-byte model/batch code.
  assert.deepEqual(Array.from(a.slice(6, 10)), [0x02, 0x4d, 0xb3, 0x6c]);
  assert.deepEqual(Array.from(b.slice(6, 10)), [0x02, 0x4d, 0xb3, 0x6c]);

  for (const p of TWO_PROBES) {
    assert.equal(parseMfgData(hex(p.hex)).probeId, p.probeId);
  }
});

// ---- byte 1 and byte 2 semantics ----------------------------------------

test('byte 1 is exposed without claiming to be a battery level', () => {
  // Two probes at very different states of charge both report 0x64 in every
  // frame ever captured, so it is a constant, not a measurement.
  // PROTOCOL.md 3.1. batteryPct survives only as a compatibility alias.
  const r = parseMfgData(hex(REAL[2]));
  assert.equal(r.byte1, 0x64);
  assert.equal(r.batteryPct, r.byte1, 'alias must track the same byte');
});

test('byte 2 = 0 means no reading, whatever the temperature bytes say', () => {
  const b = hex('066401015ce1024db36cf902d802');
  b[2] = 0;
  const r = parseMfgData(b);
  assert.ok(r, 'the frame is still from an identified probe');
  assert.equal(r.readingValid, false);
  assert.equal(r.tipC, null, 'must not report a temperature it has disowned');
  assert.equal(r.ambientC, null);
  // Raw values stay available for anyone investigating the protocol.
  assert.equal(r.rawA, 761);
  assert.equal(r.rawB, 728);
});

test('byte 2 = 0 with 0xFFFF temperatures is the observed no-reading frame', () => {
  const b = hex('066400015ce1024db36cffffffff');
  const r = parseMfgData(b);
  assert.ok(r);
  assert.equal(r.readingValid, false);
  assert.equal(r.tipC, null);
  assert.equal(r.ambientC, null);
});
