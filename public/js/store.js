/**
 * Multi-probe state for F.U.Ninja
 *
 * One BLE scan surfaces every probe in range, so the registry tracks them all
 * simultaneously and the UI decides what to show. Probes are keyed by the
 * payload's own probe id (protocol.js), not by the browser's device id: Web
 * Bluetooth hides MAC addresses and mints a per-origin device id, so the
 * payload id is the only identity that survives a reload or a different
 * browser.
 *
 * History is recorded from the first reading, whether or not anything is
 * plotting it yet, so the data is already there when charts and the
 * time-at-temperature integral arrive.
 */

/** Readings arrive roughly every 10 s; see PROTOCOL.md section 6. */
export const STALE_MS = 35_000;
export const OFFLINE_MS = 120_000;

/** ~14 h at one sample per 10 s. Well inside what localStorage will hold. */
const MAX_SAMPLES = 5000;

const LS_KEY = 'fun.state.v1';

export class ProbeRegistry extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.probes = new Map();
    this.unit = 'c';
    this._saveTimer = null;
    this._load();
  }

  /** Ingest a parsed reading. Creates the probe entry on first sight. */
  ingest(reading) {
    const key = reading.probeId;
    let p = this.probes.get(key);
    const isNew = !p;

    if (!p) {
      p = {
        probeId: key,
        deviceId: reading.deviceId,
        name: reading.name || 'Ninja probe',
        nickname: '',
        firstSeen: reading.t,
        lastSeen: reading.t,
        last: reading,
        samples: [],
        selected: true, // a newly discovered probe is shown by default
      };
      this.probes.set(key, p);
    }

    p.deviceId = reading.deviceId ?? p.deviceId;
    if (reading.name) p.name = reading.name;
    p.lastSeen = reading.t;
    p.last = reading;

    // Store compactly: [t, rawA, rawB, battery]. Raw counts, not converted
    // degrees, so a later correction to the scale reinterprets old data
    // correctly instead of baking in today's conversion.
    const s = p.samples;
    const prev = s[s.length - 1];
    // The probe re-advertises the same values between sensor updates; skip an
    // exact duplicate unless enough time has passed to be worth a data point.
    const dup = prev && prev[1] === reading.rawA && prev[2] === reading.rawB
      && reading.t - prev[0] < 5000;
    if (!dup) {
      s.push([reading.t, reading.rawA, reading.rawB, reading.batteryPct]);
      if (s.length > MAX_SAMPLES) s.splice(0, s.length - MAX_SAMPLES);
    }

    this._scheduleSave();
    this.dispatchEvent(new CustomEvent(isNew ? 'probe-added' : 'probe-updated', { detail: p }));
    this.dispatchEvent(new CustomEvent('change', { detail: p }));
    return p;
  }

  list() {
    // Strongest signal first, so the probe you are standing next to is on top.
    return [...this.probes.values()].sort(
      (a, b) => (b.last?.rssi ?? -999) - (a.last?.rssi ?? -999),
    );
  }

  get(probeId) {
    return this.probes.get(probeId);
  }

  selected() {
    return this.list().filter((p) => p.selected);
  }

  setSelected(probeId, on) {
    const p = this.probes.get(probeId);
    if (!p) return;
    p.selected = Boolean(on);
    this._scheduleSave();
    this.dispatchEvent(new CustomEvent('change', { detail: p }));
  }

  setNickname(probeId, nickname) {
    const p = this.probes.get(probeId);
    if (!p) return;
    p.nickname = nickname.slice(0, 32);
    this._scheduleSave();
    this.dispatchEvent(new CustomEvent('change', { detail: p }));
  }

  setUnit(unit) {
    this.unit = unit === 'f' ? 'f' : 'c';
    this._scheduleSave();
    this.dispatchEvent(new CustomEvent('unit-changed', { detail: this.unit }));
    this.dispatchEvent(new CustomEvent('change', { detail: null }));
  }

  clearHistory(probeId) {
    const p = this.probes.get(probeId);
    if (!p) return;
    p.samples = [];
    this._scheduleSave();
    this.dispatchEvent(new CustomEvent('change', { detail: p }));
  }

  forget(probeId) {
    this.probes.delete(probeId);
    this._scheduleSave();
    this.dispatchEvent(new CustomEvent('change', { detail: null }));
  }

  /** 'live' | 'stale' | 'offline' -- drives the freshness badge. */
  status(p, now = Date.now()) {
    // A probe restored from storage has a recent lastSeen but no live reading.
    // Age alone would call that 'live' and show a temperature from a previous
    // session as if it were current, so require an actual reading first.
    if (!p?.last) return 'offline';
    const age = now - (p.lastSeen ?? 0);
    if (age > OFFLINE_MS) return 'offline';
    if (age > STALE_MS) return 'stale';
    return 'live';
  }

  /** Export one probe's history as CSV, raw counts included. */
  toCSV(probeId) {
    const p = this.probes.get(probeId);
    if (!p) return '';
    const rows = [
      'unix_ms,iso,probe_id,tip_c,ambient_c,tip_raw,ambient_raw,battery_pct',
    ];
    const c = (raw) => (((raw / 10 - 32) * 5) / 9).toFixed(2);
    for (const [t, a, b, batt] of p.samples) {
      rows.push([t, new Date(t).toISOString(), p.probeId, c(a), c(b), a, b, batt].join(','));
    }
    return rows.join('\n');
  }

  // -- persistence -------------------------------------------------------

  _scheduleSave() {
    if (this._saveTimer) return;
    // Coalesce: readings arrive in bursts and writing localStorage is sync.
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 1500);
  }

  _save() {
    try {
      const probes = [...this.probes.values()].map((p) => ({
        probeId: p.probeId,
        deviceId: p.deviceId,
        name: p.name,
        nickname: p.nickname,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        selected: p.selected,
        samples: p.samples,
      }));
      localStorage.setItem(LS_KEY, JSON.stringify({ unit: this.unit, probes }));
    } catch {
      // Quota exceeded or storage disabled. Losing persistence is acceptable;
      // losing the live session is not, so never let this throw upward.
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      this.unit = data.unit === 'f' ? 'f' : 'c';
      for (const p of data.probes ?? []) {
        this.probes.set(p.probeId, {
          ...p,
          samples: Array.isArray(p.samples) ? p.samples : [],
          // No reading yet this session -- the card shows "offline" until one
          // arrives, rather than resurrecting a stale temperature as current.
          last: null,
        });
      }
    } catch {
      /* corrupt state: start clean rather than refuse to boot */
    }
  }
}
