/**
 * Ninja ProChef WP100 advertisement parser.
 *
 * The executable form of PROTOCOL.md sections 3 and 4. Field offsets,
 * signedness and sentinel handling are specified there; if this file and that
 * document ever disagree, the document is authoritative.
 *
 * A companion research project keeps a Python parser with identical offsets and
 * the same test fixtures. If you change the layout here, change it there too.
 */

/** SharkNinja Operating LLC, per the Bluetooth SIG company identifier list. */
export const COMPANY_ID = 0x0c4f;

export const NAME_PREFIX = 'Ninja-';
export const MFG_LEN = 14;
export const FRAME_TYPE_TELEMETRY = 0x06;

/**
 * A sensor with nothing attached / out of range has never been observed, so the
 * real sentinel is unknown. These are the usual suspects: treat them as "no
 * reading" rather than surfacing a nonsense temperature.
 */
const SENTINELS = new Set([0x7fff, -0x8000, -1]);

/**
 * Probe-id values that mean "not populated yet".
 *
 * Observed in the field: a probe that has just been switched on broadcasts a
 * placeholder telemetry frame before its identity and sensors are ready --
 * correct frame type, plausible battery, but an all-zero id and both
 * temperatures at 0xFFFF. Accepting it creates a phantom probe keyed on
 * "000000000000" that sits in the list forever showing "--".
 */
const UNSET_PROBE_IDS = new Set(['000000000000', 'ffffffffffff']);

/** True if this id cannot identify a real probe. */
export function isUnsetProbeId(probeId) {
  return !probeId || UNSET_PROBE_IDS.has(probeId.toLowerCase());
}

export const rawToF = (raw) => raw / 10;
export const rawToC = (raw) => ((raw / 10 - 32) * 5) / 9;
export const fToRaw = (f) => Math.round(f * 10);
export const cToRaw = (c) => fToRaw((c * 9) / 5 + 32);

/** Signed 16-bit little-endian read. Signed so a freezer check decodes. */
function i16le(bytes, off) {
  const v = bytes[off] | (bytes[off + 1] << 8);
  return v & 0x8000 ? v - 0x10000 : v;
}

const temp = (raw) => (SENTINELS.has(raw) ? null : raw);

/**
 * Decode the 14-byte SharkNinja manufacturer payload.
 *
 * Returns null for anything that is not a telemetry frame. Never throws:
 * advertisements are lossy, and a scanner should skip a bad packet rather than
 * die on it.
 *
 * @param {Uint8Array|DataView|ArrayBuffer} data
 * @param {{id?:string,name?:string,rssi?:number,t?:number}} [meta]
 */
export function parseMfgData(data, meta = {}) {
  if (!data) return null;
  let b;
  if (data instanceof Uint8Array) b = data;
  else if (data instanceof DataView) b = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) b = new Uint8Array(data);
  else return null;

  if (b.length < MFG_LEN) return null;
  if (b[0] !== FRAME_TYPE_TELEMETRY) return null;

  const rawA = i16le(b, 10);
  const rawB = i16le(b, 12);

  // Bytes 4-9 are a stable per-probe id. This matters more in the browser than
  // anywhere else: Web Bluetooth deliberately hides the MAC address, so this is
  // our only durable device identity across sessions and origins.
  //
  // The field is the probe's own BLE address stored little-endian: reversed,
  // 30eb024db36c is 6C:B3:4D:02:EB:30, and 6c:b3:4d is SharkNinja's OUI. That
  // is why bytes 6-9 look constant -- only the low two vary per unit
  // (PROTOCOL.md 3.2).
  //
  // Keying on this rather than the advertising address is not just a Web
  // Bluetooth workaround: the radio that broadcasts a reading is not always
  // the probe the reading is about (PROTOCOL.md 1.1).
  const probeId = Array.from(b.slice(4, 10), (x) => x.toString(16).padStart(2, '0')).join('');

  // Drop the power-on placeholder frame. Without an id there is nothing to key
  // a probe on, and every field in it is a placeholder anyway.
  if (isUnsetProbeId(probeId)) return null;

  const tipRaw = temp(rawA);
  const ambientRaw = temp(rawB);

  return {
    frameType: b[0],
    // NOT a battery level, despite the name, which is kept for compatibility.
    // Byte 1 is a hard-coded 0x64: two probes at very different states of
    // charge both report 100. See PROTOCOL.md 3.2. Do not present this to a
    // user as a battery reading.
    batteryPct: b[1],
    unknown2: b[2],
    unknown3: b[3],
    probeId,
    rawA,
    rawB,
    // A = tip, B = ambient. INFERRED from drift, not confirmed -- see
    // PROTOCOL.md section 5. rawA/rawB stay exposed for callers that want
    // to remain agnostic.
    tipC: tipRaw === null ? null : rawToC(tipRaw),
    tipF: tipRaw === null ? null : rawToF(tipRaw),
    ambientC: ambientRaw === null ? null : rawToC(ambientRaw),
    ambientF: ambientRaw === null ? null : rawToF(ambientRaw),
    deviceId: meta.id ?? null,
    name: meta.name ?? null,
    rssi: meta.rssi ?? null,
    t: meta.t ?? Date.now(),
  };
}

export const isProChefName = (name) => Boolean(name) && name.startsWith(NAME_PREFIX);

/** Format a temperature for display, honouring the unit setting. */
export function fmtTemp(reading, which, unit) {
  if (!reading) return '--';
  const v = unit === 'f' ? reading[`${which}F`] : reading[`${which}C`];
  if (v === null || v === undefined) return '--';
  // The sensor's real resolution is ~0.1 C (~0.2 F), so one decimal is the
  // honest maximum -- see PROTOCOL.md section 4.
  return v.toFixed(1);
}
