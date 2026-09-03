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

import { cToRaw, fToRaw, fmtTemp, parseMfgData, rawToC, rawToF } from '../public/js/protocol.js';

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
    assert.equal(r.batteryPct, 100);
    assert.equal(r.probeId, '5ce1024db36c');
    assert.equal(r.unknown2, 1);
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
