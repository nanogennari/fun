/**
 * F.U.Ninja -- app controller.
 *
 * Cards are created once per probe and then mutated in place. A full re-render
 * on every advertisement would fight the user: it would collapse open <details>
 * panels and drop focus mid-rename.
 */

import {
  FLAG_URL, ProbeScanner, WakeLock, capabilities, describeScanError, readiness,
} from './ble.js';
import { Alarm } from './alarm.js';
import { runDisclaimerGate } from './disclaimer.js';
import { createChartPanel } from './chart.js';
import { cToRaw, fToRaw, fmtTemp, rawToC, rawToF } from './protocol.js';
import { ProbeRegistry, shouldShowSetup } from './store.js';

const registry = new ProbeRegistry();
const scanner = new ProbeScanner();
const wake = new WakeLock();
const alarm = new Alarm();

/** probeId -> chart panel, built lazily when a Details panel first opens. */
const charts = new Map();

const el = {
  unsupported: document.getElementById('unsupported'),
  unsupportedTitle: document.getElementById('unsupported-title'),
  unsupportedBody: document.getElementById('unsupported-body'),
  unsupportedSteps: document.getElementById('unsupported-steps'),
  unsupportedFlag: document.getElementById('unsupported-flag'),
  flagUrl: document.getElementById('flag-url'),
  copyFlag: document.getElementById('copy-flag'),
  setup: document.getElementById('setup'),
  setupTitle: document.getElementById('setup-title'),
  setupIntro: document.getElementById('setup-intro'),
  setupSteps: document.getElementById('setup-steps'),
  setupLegend: document.getElementById('setup-legend'),
  setupDismiss: document.getElementById('setup-dismiss'),
  helpToggle: document.getElementById('help-toggle'),
  scanPanel: document.getElementById('scan-panel'),
  scanBtn: document.getElementById('scan-btn'),
  scanStatus: document.getElementById('scan-status'),
  empty: document.getElementById('empty'),
  probes: document.getElementById('probes'),
  unitToggle: document.getElementById('unit-toggle'),
  unitLabel: document.getElementById('unit-label'),
  wakeToggle: document.getElementById('wake-toggle'),
  template: document.getElementById('probe-card-template'),
  disclaimerAccept: document.getElementById('disclaimer-accept'),
  disclaimerDecline: document.getElementById('disclaimer-decline'),
  declinedReview: document.getElementById('declined-review'),
  gateHint: document.getElementById('gate-hint'),
};

/** Swap the top-level view. Only one is ever on screen. */
function setView(name) {
  document.body.dataset.view = name;
}

/** @type {Map<string, HTMLElement>} probeId -> card */
const cards = new Map();

// ------------------------------------------------------------------ helpers

const unitSuffix = () => (registry.unit === 'f' ? '°F' : '°C');

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** Raw counts -> the number shown in the current unit. */
function rawToUnit(raw) {
  return registry.unit === 'f' ? rawToF(raw) : rawToC(raw);
}

/** A number typed in the current unit -> raw counts. */
function unitToRaw(v) {
  return registry.unit === 'f' ? fToRaw(v) : cToRaw(v);
}

function displayName(p) {
  return p.nickname || p.name || 'Ninja probe';
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download on some mobile browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Render the notice card. Used both for "this browser cannot scan at all" at
 * boot and for a scan that failed once started, so the guidance looks the same
 * either way.
 */
function showNotice({ title, body, steps = [], flag = null }) {
  el.unsupported.hidden = false;
  el.unsupportedTitle.textContent = title;
  el.unsupportedBody.textContent = body;

  el.unsupportedSteps.replaceChildren();
  if (steps.length) {
    for (const step of steps) {
      const li = document.createElement('li');
      li.textContent = step;
      el.unsupportedSteps.appendChild(li);
    }
    el.unsupportedSteps.hidden = false;
  } else {
    el.unsupportedSteps.hidden = true;
  }

  if (flag) {
    el.unsupportedFlag.hidden = false;
    el.flagUrl.textContent = flag;
  } else {
    el.unsupportedFlag.hidden = true;
  }
  el.unsupported.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function hideNotice() {
  el.unsupported.hidden = true;
}

// ------------------------------------------------------------------ setup guide

/**
 * Build the readiness checklist.
 *
 * Steps carry one of three states:
 *   ok     -- verified satisfied, nothing to do
 *   action -- verified NOT satisfied, the user must do something
 *   info   -- cannot be verified from the browser, so just explain it
 *
 * Being honest about the third case matters. Android's "Nearby devices"
 * permission is the single most common cause of failure and there is no API to
 * check it, so claiming it is fine would be a lie and claiming it is broken
 * would cry wolf.
 */
function buildSetupSteps(r) {
  const steps = [];

  if (r.ios) {
    steps.push({
      state: 'action',
      label: 'This will not work on iOS',
      detail: 'Every iOS browser is required to use Apple\u2019s WebKit engine, and WebKit does not implement Web Bluetooth. Chrome for iOS cannot help. Use an Android phone, or a desktop Chrome or Edge.',
    });
    return steps;
  }

  steps.push({
    state: r.hasBluetooth ? 'ok' : 'action',
    label: r.hasBluetooth ? 'Browser supports Web Bluetooth' : 'Use Chrome or Edge',
    detail: r.hasBluetooth
      ? null
      : 'Firefox and Safari do not implement Web Bluetooth, and no polyfill is possible \u2014 it needs OS-level radio access.',
  });

  steps.push({
    state: r.secure ? 'ok' : 'action',
    label: r.secure ? 'Served over a secure connection' : 'Open this page over HTTPS',
    detail: r.secure
      ? null
      : 'Web Bluetooth only works on HTTPS or localhost. An address like http://192.168.x.x will never work, whatever else you change.',
  });

  steps.push({
    state: r.hasScan ? 'ok' : 'action',
    label: r.hasScan
      ? 'Bluetooth scanning is enabled'
      : 'Turn on experimental web platform features',
    detail: r.hasScan
      ? null
      : 'Reading a probe needs requestLEScan, which sits behind a flag. Paste the address below into the address bar, set it to Enabled, then fully relaunch the browser.',
    copy: r.hasScan ? null : FLAG_URL,
  });

  // Only ask about Android's permission once the API is actually present --
  // otherwise it is noise on top of a more fundamental problem.
  if (r.android && r.hasScan) {
    steps.push({
      state: 'info',
      label: 'Allow Chrome to find nearby devices',
      detail: 'Settings \u2192 Apps \u2192 Chrome \u2192 Permissions \u2192 Nearby devices \u2192 Allow. Chrome never asks for this, and without it scanning fails with a misleading message about the Bluetooth adapter. Afterwards, force-close Chrome by swiping it away in Recents \u2014 backgrounding it is not enough.',
    });
  }

  if (r.hasScan) {
    steps.push({
      state: r.adapter === false ? 'action' : r.adapter ? 'ok' : 'info',
      label: r.adapter === false ? 'Switch Bluetooth on' : 'Bluetooth is on',
      detail: r.adapter === false ? 'The browser reports no available Bluetooth adapter.' : null,
    });
  }

  steps.push({
    state: 'info',
    label: 'Switch the probe on and take it out of its dock',
    detail: 'A docked or sleeping probe does not broadcast.',
  });

  steps.push({
    state: 'info',
    label: 'Tap \u201cStart scanning\u201d and allow the prompt',
    detail: 'The first reading can take 10\u201315 seconds: that is how often the probe broadcasts, not a hang.',
  });

  return steps;
}

function renderSetupSteps(steps) {
  el.setupSteps.replaceChildren();
  for (const s of steps) {
    const li = document.createElement('li');
    li.className = 'check';
    li.dataset.state = s.state;

    const mark = document.createElement('span');
    mark.className = 'check-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = s.state === 'ok' ? '\u2713' : s.state === 'action' ? '!' : '\u2022';

    const body = document.createElement('div');
    body.className = 'check-body';

    const label = document.createElement('p');
    label.className = 'check-label';
    label.textContent = s.label;
    // Screen readers get the state as words, not as a bare glyph.
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = s.state === 'ok' ? ' (done) ' : s.state === 'action' ? ' (needs attention) ' : ' ';
    label.prepend(sr);
    body.appendChild(label);

    if (s.detail) {
      const d = document.createElement('p');
      d.className = 'check-detail';
      d.textContent = s.detail;
      body.appendChild(d);
    }

    if (s.copy) {
      const code = document.createElement('code');
      code.className = 'flag';
      code.textContent = s.copy;
      body.appendChild(code);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Copy address';
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(s.copy);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy address'; }, 2000);
        } catch {
          btn.textContent = 'Copy failed \u2014 select it by hand';
        }
      });
      body.appendChild(btn);
    }

    li.append(mark, body);
    el.setupSteps.appendChild(li);
  }
}

async function renderSetup() {
  const r = await readiness();
  const steps = buildSetupSteps(r);
  const blocking = steps.filter((s) => s.state === 'action');

  el.setupTitle.textContent = blocking.length ? 'Before you can scan' : 'Getting started';
  el.setupIntro.textContent = blocking.length
    ? 'A couple of things need changing first.'
    : 'Everything the browser can check looks ready.';
  el.setupLegend.textContent = steps.some((s) => s.state === 'info')
    ? '\u2713 checked automatically \u00b7 ! needs your attention \u00b7 \u2022 cannot be checked from the browser'
    : '';

  renderSetupSteps(steps);
  return { ready: capabilities().ok, blocking: blocking.length };
}

function setSetupVisible(on) {
  el.setup.hidden = !on;
  el.helpToggle.setAttribute('aria-pressed', String(Boolean(on)));
}

// ------------------------------------------------------------------ cards

function makeCard(p) {
  const node = el.template.content.firstElementChild.cloneNode(true);
  node.dataset.probeId = p.probeId;

  const q = (role) => node.querySelector(`[data-role="${role}"]`);

  q('selected').addEventListener('change', (e) => {
    registry.setSelected(p.probeId, e.target.checked);
    node.dataset.selected = String(e.target.checked);
  });

  node.querySelector('.probe-name').addEventListener('click', () => {
    const current = registry.get(p.probeId);
    if (!current) return;
    const name = prompt('Name this probe (e.g. "brisket", "pork shoulder")', current.nickname || '');
    if (name === null) return;
    registry.setNickname(p.probeId, name.trim());
    updateCard(registry.get(p.probeId));
  });

  // -- target temperature ------------------------------------------------
  const form = q('target-form');
  const input = q('target-input');

  function openTargetEditor() {
    const cur = registry.get(p.probeId)?.targetRaw;
    input.value = cur === null || cur === undefined ? '' : rawToUnit(cur).toFixed(1);
    q('target-buttons').hidden = true;
    form.hidden = false;
    input.focus();
    input.select?.();
  }

  function closeTargetEditor() {
    form.hidden = true;
    q('target-buttons').hidden = false;
  }

  q('target-edit').addEventListener('click', openTargetEditor);
  q('target-cancel').addEventListener('click', closeTargetEditor);

  q('target-clear').addEventListener('click', () => {
    registry.setTarget(p.probeId, null);
    closeTargetEditor();
    syncAlarmSound();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Number.parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    // This submit is a real user gesture, which is the only moment autoplay
    // policy lets us unlock audio. Miss it and the alarm fires silently.
    await alarm.prime();
    registry.setTarget(p.probeId, unitToRaw(v));
    closeTargetEditor();
    updateCard(registry.get(p.probeId));
    syncAlarmSound();
  });

  q('ack').addEventListener('click', () => {
    registry.acknowledgeAlarm(p.probeId);
    updateCard(registry.get(p.probeId));
    syncAlarmSound();
  });

  // -- chart -------------------------------------------------------------
  q('more').addEventListener('toggle', (e) => {
    if (!e.target.open) return;
    ensureChart(p.probeId);
    refreshChart(p.probeId);
  });

  q('export').addEventListener('click', () => {
    const current = registry.get(p.probeId);
    const csv = registry.toCSV(p.probeId);
    if (!csv || !current?.samples.length) {
      alert('No samples recorded for this probe yet.');
      return;
    }
    const safe = (displayName(current) || 'probe').replace(/[^\w-]+/g, '_');
    download(`fun-${safe}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`, csv);
  });

  q('clear').addEventListener('click', () => {
    if (!confirm('Clear recorded history for this probe? The live reading is kept.')) return;
    registry.clearHistory(p.probeId);
    updateCard(registry.get(p.probeId));
  });

  q('forget').addEventListener('click', () => {
    if (!confirm('Forget this probe and delete its history?')) return;
    registry.forget(p.probeId);
    charts.get(p.probeId)?.destroy();
    charts.delete(p.probeId);
    cards.get(p.probeId)?.remove();
    cards.delete(p.probeId);
    renderEmptyState();
    syncAlarmSound();
  });

  cards.set(p.probeId, node);
  el.probes.appendChild(node);
  return node;
}

function ensureChart(probeId) {
  if (charts.has(probeId)) return charts.get(probeId);
  const node = cards.get(probeId);
  const host = node?.querySelector('[data-role="chart"]');
  if (!host) return null;
  const panel = createChartPanel(host);
  charts.set(probeId, panel);
  return panel;
}

function refreshChart(probeId) {
  const panel = charts.get(probeId);
  if (!panel) return;
  // Skip work for a collapsed panel: the canvas is not visible and would be
  // re-rendered on open anyway.
  const node = cards.get(probeId);
  if (!node?.querySelector('[data-role="more"]')?.open) return;
  const p = registry.get(probeId);
  if (!p) return;
  panel.update({ samples: p.samples, unit: registry.unit, targetRaw: p.targetRaw ?? null });
}

/** Start or stop the sound to match whether anything is actually firing. */
function syncAlarmSound() {
  if (registry.firing().length > 0) alarm.start();
  else alarm.stop();
}

function updateCard(p) {
  if (!p) return;
  const node = cards.get(p.probeId) ?? makeCard(p);
  const q = (role) => node.querySelector(`[data-role="${role}"]`);

  const status = registry.status(p);
  node.dataset.status = status;
  node.dataset.selected = String(p.selected);

  node.querySelector('.probe-name').textContent = displayName(p);
  q('status').textContent = status;
  q('selected').checked = p.selected;

  q('battery').textContent = p.last ? `${p.last.batteryPct}%` : '';
  q('age').textContent = p.lastSeen ? fmtAge(Date.now() - p.lastSeen) : 'never seen';

  q('tip').textContent = fmtTemp(p.last, 'tip', registry.unit);
  q('ambient').textContent = fmtTemp(p.last, 'ambient', registry.unit);
  q('tip-unit').textContent = unitSuffix();
  q('ambient-unit').textContent = unitSuffix();

  // -- target + alarm --
  const hasTarget = p.targetRaw !== null && p.targetRaw !== undefined;
  const u = unitSuffix();
  q('target-value').textContent = hasTarget
    ? `${rawToUnit(p.targetRaw).toFixed(1)}${u}`
    : 'not set';
  q('target-clear').hidden = !hasTarget;
  q('target-edit').textContent = hasTarget ? 'Change' : 'Set target';
  q('target-unit').textContent = u;

  const firing = p.alarmState === 'fired';
  node.dataset.alarm = firing ? 'firing' : p.alarmState === 'acked' ? 'acked' : 'off';
  q('alarm').hidden = !firing;
  if (firing) {
    const reached = fmtTemp(p.last, 'tip', registry.unit);
    q('alarm-text').textContent = alarm.audioReady
      ? `${displayName(p)} reached ${reached}${u}`
      : `${displayName(p)} reached ${reached}${u} \u2014 sound is blocked, tap Stop`;
  }

  q('probe-id').textContent = p.probeId;
  q('rssi').textContent = p.last?.rssi === null || p.last?.rssi === undefined
    ? '--'
    : `${p.last.rssi} dBm`;
  q('raw').textContent = p.last ? `A ${p.last.rawA} / B ${p.last.rawB}` : '--';
  q('samples').textContent = String(p.samples.length);

  refreshChart(p.probeId);
}

function refreshAges() {
  const now = Date.now();
  for (const [probeId, node] of cards) {
    const p = registry.get(probeId);
    if (!p) continue;
    const status = registry.status(p, now);
    node.dataset.status = status;
    node.querySelector('[data-role="status"]').textContent = status;
    node.querySelector('[data-role="age"]').textContent =
      p.lastSeen ? fmtAge(now - p.lastSeen) : 'never seen';
  }
}

function renderAll() {
  for (const p of registry.list()) updateCard(p);
  renderEmptyState();
}

function renderEmptyState() {
  const any = registry.probes.size > 0;
  el.empty.hidden = any || !scanner.wantRunning;
  el.probes.hidden = !any;
}

// ------------------------------------------------------------------ scanning

/**
 * Chrome kills LE scans unpredictably -- switching a probe off was observed to
 * take the scan down with it. The scanner restarts itself; this just keeps the
 * UI honest about which state we are in, so a dropped scan is never mistaken
 * for a probe that has gone quiet.
 */
scanner.onState = (state) => {
  if (state === 'scanning') {
    el.scanBtn.disabled = false;
    el.scanBtn.textContent = 'Stop scanning';
    el.scanBtn.dataset.scanning = 'true';
    el.scanStatus.textContent = scanner.filtered
      ? 'Scanning. A probe can take ~10s to appear.'
      : 'Scanning (unfiltered). A probe can take ~10s to appear.';
  } else if (state === 'resuming') {
    el.scanBtn.dataset.scanning = 'true';
    el.scanStatus.textContent = 'Scan dropped by the browser — resuming…';
  } else if (state === 'needs-gesture') {
    el.scanBtn.disabled = false;
    el.scanBtn.textContent = 'Resume scanning';
    el.scanBtn.dataset.scanning = 'false';
    el.scanStatus.textContent = 'The browser stopped the scan and needs a tap to restart it.';
  } else {
    el.scanBtn.textContent = 'Start scanning';
    el.scanBtn.dataset.scanning = 'false';
    el.scanStatus.textContent = 'Stopped. Readings below are the last seen.';
  }
  renderEmptyState();
};

async function startScan() {
  try {
    el.scanStatus.textContent = 'Requesting Bluetooth permission…';
    await scanner.start(
      (reading) => registry.ingest(reading),
      (err) => console.warn('advertisement parse failed', err),
    );
    hideNotice();
    // Only worth holding the screen awake once data is actually flowing.
    if (WakeLock.supported) el.wakeToggle.hidden = false;
    // onState has already painted the scanning state.
    renderEmptyState();
  } catch (err) {
    el.scanBtn.dataset.scanning = 'false';
    el.scanBtn.textContent = 'Start scanning';
    const d = describeScanError(err);
    el.scanStatus.textContent = d.title;
    showNotice(d);
    console.warn('requestLEScan failed', err);
  }
}

function stopScan() {
  scanner.stop(); // emits 'stopped', which repaints the button and status
}

// ------------------------------------------------------------------ wiring

el.scanBtn.addEventListener('click', () => {
  // wantRunning, not running: mid-restart the scan is briefly inactive and a
  // tap should still mean "stop", not "start a second one".
  if (scanner.wantRunning) stopScan();
  else startScan();
});

el.helpToggle.addEventListener('click', async () => {
  const showing = el.helpToggle.getAttribute('aria-pressed') === 'true';
  if (!showing) await renderSetup(); // re-check: they may have just fixed something
  setSetupVisible(!showing);
});

el.setupDismiss.addEventListener('click', () => {
  registry.setSetupDismissed(true);
  setSetupVisible(false);
});

el.unitToggle.addEventListener('click', () => {
  registry.setUnit(registry.unit === 'c' ? 'f' : 'c');
});

el.wakeToggle.addEventListener('click', async () => {
  const on = el.wakeToggle.getAttribute('aria-pressed') === 'true';
  if (on) {
    await wake.disable();
    el.wakeToggle.setAttribute('aria-pressed', 'false');
  } else {
    await wake.enable();
    el.wakeToggle.setAttribute('aria-pressed', 'true');
  }
});

registry.addEventListener('probe-added', () => {
  // A probe arriving proves the whole chain works, so the guide has served its
  // purpose -- permanently, not just for this session. Still reachable from
  // the ? button.
  registry.setSetupDismissed(true);
  setSetupVisible(false);
  renderEmptyState();
});
registry.addEventListener('alarm-fired', (e) => {
  updateCard(e.detail);
  syncAlarmSound();
  // A fired alarm is worth interrupting a collapsed view for.
  window.navigator.vibrate?.([220, 90, 220]);
});

registry.addEventListener('change', (e) => {
  if (e.detail) updateCard(e.detail);
  else renderAll();
});
registry.addEventListener('unit-changed', () => {
  el.unitLabel.textContent = unitSuffix();
  renderAll();
  for (const probeId of charts.keys()) refreshChart(probeId);
});

el.copyFlag?.addEventListener('click', async () => {
  const text = el.flagUrl.textContent;
  try {
    await navigator.clipboard.writeText(text);
    el.copyFlag.textContent = 'Copied';
    setTimeout(() => { el.copyFlag.textContent = 'Copy address'; }, 2000);
  } catch {
    el.copyFlag.textContent = 'Copy failed — select it by hand';
  }
});

// ------------------------------------------------------------------ boot

async function boot() {
  el.unitLabel.textContent = unitSuffix();
  if (WakeLock.supported) el.wakeToggle.hidden = true; // revealed once scanning

  // The checklist is the single place setup guidance lives; the notice card is
  // reserved for runtime scan failures, so the two never look interchangeable.
  const { ready } = await renderSetup();
  setSetupVisible(shouldShowSetup({ dismissed: registry.setupDismissed, ready }));
  el.scanBtn.disabled = !ready;
  el.scanStatus.textContent = ready
    ? 'Switch a probe on and take it out of its dock.'
    : 'Work through the checklist above first.';

  // Probes remembered from a previous session render immediately, marked
  // offline until a fresh advertisement arrives -- better than an empty screen,
  // and it keeps nicknames and history visible.
  renderAll();
  setInterval(refreshAges, 1000);

}

/**
 * Nothing of the app runs before the terms are accepted -- no scanning, no
 * timers, no probe state rendered.
 *
 * A decline is not a dead end: it parks on the declined view until the user
 * asks to review the terms, at which point the gate runs again from the start.
 * Re-running it also restarts the read countdown, so decline-then-review is not
 * a way to skip the wait.
 */
async function main() {
  const gate = {
    acceptBtn: el.disclaimerAccept,
    declineBtn: el.disclaimerDecline,
    hint: el.gateHint,
    setView,
  };

  for (;;) {
    const outcome = await runDisclaimerGate(gate);
    if (outcome !== 'declined') break;
    await new Promise((resume) => {
      el.declinedReview.addEventListener('click', resume, { once: true });
    });
    window.scrollTo({ top: 0 });
  }

  setView('main');
  await boot();
}

main();
