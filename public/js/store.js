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

/**
 * Staleness thresholds.
 *
 * The probe broadcasts about three times a second (PROTOCOL.md section 6), but
 * the rate the browser actually delivers is stack-dependent and has not been
 * measured for Chrome's requestLEScan. These stay deliberately generous: too
 * tight and every card would flicker to "stale" on a stack that coalesces,
 * which is worse than being slow to notice a probe that really has gone away.
 */
import { isUnsetProbeId } from './protocol.js';

export const STALE_MS = 35_000;
export const OFFLINE_MS = 120_000;

/** ~14 h at one sample per 10 s. Well inside what localStorage will hold. */
const MAX_SAMPLES = 5000;

/**
 * Re-arm margin, in raw counts (tenths of degF). 18 counts is 1.8 degF ~ 1 degC.
 * After an alarm is acknowledged it only re-arms once the food drops this far
 * back below target, so a reading hovering on the threshold cannot retrigger
 * the alarm every ten seconds.
 */
const ALARM_REARM_MARGIN = 18;

const LS_KEY = 'fun.state.v1';

/**
 * Should the setup guide be on screen at boot?
 *
 * Pure so the rule is testable: headless browsers expose no Web Bluetooth at
 * all, so the `ready === true` branch cannot be reached in an automated
 * browser check.
 *
 * @param {{dismissed:boolean, ready:boolean}} o
 */
export function shouldShowSetup({ dismissed, ready }) {
  // Respect a dismissal -- but never hide a genuine blocker, or the scan button
  // sits disabled with its explanation hidden.
  return !dismissed || !ready;
}

export class ProbeRegistry extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.probes = new Map();
    this.unit = 'c';
    /** Has the user (or a successful scan) already retired the setup guide? */
    this.setupDismissed = false;
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
        targetRaw: null,
        alarmState: 'idle', // idle -> fired -> acked
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

    this._evaluateAlarm(p);

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

  /**
   * Set (or clear, with null) the food-temperature target in raw counts.
   * Always resets the alarm, so a new target can fire even if the previous one
   * was already acknowledged.
   */
  setTarget(probeId, raw) {
    const p = this.probes.get(probeId);
    if (!p) return;
    p.targetRaw = raw === null || raw === undefined ? null : Math.round(raw);
    p.alarmState = 'idle';
    // Re-check at once: a target set below the current temperature should fire
    // immediately rather than waiting for the next advertisement to arrive.
    this._evaluateAlarm(p);
    this._scheduleSave();
    this.dispatchEvent(new CustomEvent('change', { detail: p }));
  }

  acknowledgeAlarm(probeId) {
    const p = this.probes.get(probeId);
    if (!p || p.alarmState !== 'fired') return;
    p.alarmState = 'acked';
    this.dispatchEvent(new CustomEvent('change', { detail: p }));
  }

  /** Any probe currently sounding. */
  firing() {
    return this.list().filter((p) => p.alarmState === 'fired');
  }

  /**
   * Decide whether the food sensor has reached its target.
   *
   * Guards on tipC rather than rawA: a disconnected sensor reports a sentinel
   * (0x7FFF), which as a raw number is enormous and would trip every target.
   */
  _evaluateAlarm(p) {
    if (p.targetRaw === null || p.targetRaw === undefined) {
      p.alarmState = 'idle';
      return;
    }
    if (!p.last || p.last.tipC === null || p.last.tipC === undefined) return;

    const raw = p.last.rawA;
    if (p.alarmState === 'idle' && raw >= p.targetRaw) {
      p.alarmState = 'fired';
      this.dispatchEvent(new CustomEvent('alarm-fired', { detail: p }));
    } else if (p.alarmState === 'acked' && raw < p.targetRaw - ALARM_REARM_MARGIN) {
      p.alarmState = 'idle';
    }
  }

  /**
   * Retire the setup guide so it stops appearing on every load.
   *
   * Set both when the user dismisses it and when a probe is first found -- a
   * probe arriving proves the whole chain works, which is the same information
   * the guide exists to convey. It stays reachable from the ? button, and the
   * app overrides this if something later actually blocks scanning.
   */
  setSetupDismissed(on = true) {
    if (this.setupDismissed === Boolean(on)) return;
    this.setupDismissed = Boolean(on);
    this._scheduleSave();
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
        targetRaw: p.targetRaw ?? null,
      }));
      localStorage.setItem(LS_KEY, JSON.stringify({
        unit: this.unit,
        setupDismissed: this.setupDismissed,
        probes,
      }));
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
      this.setupDismissed = data.setupDismissed === true;
      for (const p of data.probes ?? []) {
        // Drop phantoms persisted by an earlier build that accepted the
        // power-on placeholder frame.
        if (isUnsetProbeId(p.probeId)) continue;
        this.probes.set(p.probeId, {
          ...p,
          samples: Array.isArray(p.samples) ? p.samples : [],
          targetRaw: p.targetRaw ?? null,
          // Never restore a fired alarm: there is no live reading yet, so an
          // alarm on load would be about a temperature from a previous session.
          alarmState: 'idle',
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
