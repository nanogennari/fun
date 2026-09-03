/**
 * Web Bluetooth scanning layer for F.U.Ninja
 *
 * All ProChef telemetry lives in BLE advertisements (specifically the scan
 * response -- see PROTOCOL.md section 2), so this uses
 * `navigator.bluetooth.requestLEScan()` rather than the usual
 * `requestDevice()` + GATT flow. That has consequences worth knowing:
 *
 *  - requestLEScan is behind "Experimental Web Platform features" in Chrome and
 *    Edge. Without that flag the method simply does not exist. `capabilities()`
 *    detects this so the UI can explain it instead of failing silently.
 *  - It needs a secure context (https, or localhost for development).
 *  - It needs a user gesture, and shows a permission prompt.
 *  - One scan surfaces every probe in range at once, which is why multi-probe
 *    support costs us nothing: there is no connection and no per-device link.
 */

import { COMPANY_ID, parseMfgData } from './protocol.js';

export function capabilities() {
  const secure = globalThis.isSecureContext === true;
  const hasBluetooth = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  const hasScan = hasBluetooth && typeof navigator.bluetooth.requestLEScan === 'function';
  return {
    secure,
    hasBluetooth,
    hasScan,
    ok: secure && hasBluetooth && hasScan,
  };
}

/**
 * Turn a requestLEScan failure into something actionable.
 *
 * Chrome's own messages are terse and misleading here. The worst offender is
 * "Bluetooth adapter not available", which sounds like broken hardware but on
 * Android almost always means Chrome lacks the BLUETOOTH_SCAN runtime
 * permission -- shown to users as "Nearby devices". Chrome never prompts for
 * it, so nothing in the browser hints at the cause.
 *
 * @returns {{title:string, body:string, steps:string[]}}
 */
export function describeScanError(err) {
  const name = err?.name ?? '';
  const msg = String(err?.message ?? err ?? '');
  const android = /Android/i.test(navigator.userAgent ?? '');

  if (name === 'NotAllowedError') {
    return {
      title: 'Permission declined',
      body: 'The browser prompt was dismissed or blocked. Tap "Start scanning" and choose to allow it.',
      steps: [],
    };
  }

  // Chrome reports this as NotFoundError, sometimes only in the message text.
  if (name === 'NotFoundError' || /adapter|not available|no.*bluetooth/i.test(msg)) {
    return {
      title: 'Chrome is not allowed to scan',
      body: android
        ? 'Chrome can see the Bluetooth radio but is not permitted to scan with it. Android calls this permission "Nearby devices", and Chrome never asks for it.'
        : 'Chrome cannot reach a Bluetooth adapter. Check that Bluetooth is switched on and that the browser is allowed to use it.',
      steps: android
        ? [
            'Settings \u2192 Apps \u2192 Chrome \u2192 Permissions \u2192 Nearby devices \u2192 Allow',
            'Make sure Bluetooth is on',
            'Force-close Chrome: swipe it away in Recents. Backgrounding is not enough.',
            'Still failing? Also allow Location for Chrome and switch system Location on \u2014 older Android tied BLE scanning to location, and some builds still do.',
          ]
        : [
            'Switch Bluetooth on',
            'On Linux, check that the browser can reach BlueZ over D-Bus',
          ],
    };
  }

  if (name === 'InvalidStateError') {
    return {
      title: 'Bluetooth is not ready',
      body: 'The adapter is busy or still starting up. Switch Bluetooth off and on again, then retry.',
      steps: [],
    };
  }

  if (name === 'TypeError' || /requestLEScan is not a function/i.test(msg)) {
    return {
      title: 'Scanning API missing',
      body: 'This build of the browser does not expose requestLEScan. Enable the experimental flag and relaunch.',
      steps: ['chrome://flags/#enable-experimental-web-platform-features \u2192 Enabled', 'Relaunch the browser'],
    };
  }

  return {
    title: 'Could not start scanning',
    body: msg || 'The browser refused to start a scan and gave no reason.',
    steps: [],
  };
}

/** True if a Bluetooth adapter appears to be present and powered. */
export async function adapterAvailable() {
  try {
    if (!navigator.bluetooth?.getAvailability) return true; // can't tell; assume yes
    return await navigator.bluetooth.getAvailability();
  } catch {
    return true;
  }
}

/**
 * Snapshot of everything we can actually verify about the environment.
 *
 * The point is to avoid telling people to check things that are demonstrably
 * already fine. Note what is *not* here: whether Chrome holds Android's
 * BLUETOOTH_SCAN ("Nearby devices") permission. There is no API to query it, so
 * it can only be inferred from a scan failing -- which is why the checklist
 * marks that step as unverifiable rather than guessing.
 */
export async function readiness() {
  const c = capabilities();
  const ua = navigator.userAgent ?? '';
  return {
    android: /Android/i.test(ua),
    ios: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1),
    secure: c.secure,
    hasBluetooth: c.hasBluetooth,
    hasScan: c.hasScan,
    // Only meaningful once the API exists; otherwise there is nothing to ask.
    adapter: c.hasScan ? await adapterAvailable() : null,
  };
}

export const FLAG_URL = 'chrome://flags/#enable-experimental-web-platform-features';

/**
 * A running advertisement scan.
 *
 * Emits parsed readings via the callback passed to start(). Every probe in
 * range is reported; filtering to a chosen subset is the caller's job, because
 * the app wants to keep seeing probes it is not currently displaying.
 */
export class ProbeScanner {
  constructor() {
    this._scan = null;
    this._onAdv = null;
    this._onReading = null;
    this._onError = null;
    this._filtered = true;
  }

  get running() {
    return Boolean(this._scan?.active);
  }

  /** Did we fall back to an unfiltered scan? Useful diagnostic for the UI. */
  get filtered() {
    return this._filtered;
  }

  /**
   * @param {(reading: object) => void} onReading
   * @param {(err: Error) => void} [onError]
   */
  async start(onReading, onError) {
    if (this.running) return;

    const cap = capabilities();
    if (!cap.ok) throw new Error('scanning unavailable: see readiness()');

    this._onReading = onReading;
    this._onError = onError;

    // Prefer a manufacturer-data filter: the permission prompt is narrower and
    // we are not woken for every beacon in the building. Not every
    // implementation supports manufacturerData filters, so fall back to
    // accepting everything and filtering in software.
    try {
      this._scan = await navigator.bluetooth.requestLEScan({
        filters: [{ manufacturerData: [{ companyIdentifier: COMPANY_ID }] }],
        keepRepeatedDevices: true, // essential: without it we get one event per device, ever
      });
      this._filtered = true;
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw err; // user declined -- do not retry
      this._scan = await navigator.bluetooth.requestLEScan({
        acceptAllAdvertisements: true,
        keepRepeatedDevices: true,
      });
      this._filtered = false;
    }

    this._onAdv = (event) => {
      try {
        const mfg = event.manufacturerData?.get(COMPANY_ID);
        if (!mfg) return;
        const reading = parseMfgData(mfg, {
          // Web Bluetooth hides the MAC. device.id is stable per origin, but
          // the payload's own probe id (protocol.js) is the durable one.
          id: event.device?.id ?? null,
          name: event.device?.name ?? event.name ?? null,
          rssi: typeof event.rssi === 'number' ? event.rssi : null,
          t: Date.now(),
        });
        if (reading) this._onReading?.(reading);
      } catch (err) {
        this._onError?.(err);
      }
    };

    navigator.bluetooth.addEventListener('advertisementreceived', this._onAdv);
  }

  stop() {
    if (this._onAdv) {
      navigator.bluetooth.removeEventListener('advertisementreceived', this._onAdv);
      this._onAdv = null;
    }
    try {
      this._scan?.stop();
    } catch {
      /* already stopped */
    }
    this._scan = null;
  }
}

/**
 * Keep the screen awake while monitoring a cook.
 *
 * Wrapped because Screen Wake Lock is absent on some browsers and the lock is
 * dropped whenever the page is hidden, so it has to be reacquired.
 */
export class WakeLock {
  constructor() {
    this._lock = null;
    this._want = false;
    this._onVis = () => {
      if (this._want && document.visibilityState === 'visible') this._acquire();
    };
    document.addEventListener('visibilitychange', this._onVis);
  }

  static get supported() {
    return 'wakeLock' in navigator;
  }

  get held() {
    return Boolean(this._lock && !this._lock.released);
  }

  async _acquire() {
    if (!WakeLock.supported || this.held) return;
    try {
      this._lock = await navigator.wakeLock.request('screen');
      this._lock.addEventListener?.('release', () => {
        this._lock = null;
      });
    } catch {
      this._lock = null; // denied or unsupported; not worth surfacing
    }
  }

  async enable() {
    this._want = true;
    await this._acquire();
  }

  async disable() {
    this._want = false;
    try {
      await this._lock?.release();
    } catch {
      /* ignore */
    }
    this._lock = null;
  }
}
