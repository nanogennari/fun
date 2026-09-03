/**
 * F.U.N. -- app controller.
 *
 * Cards are created once per probe and then mutated in place. A full re-render
 * on every advertisement would fight the user: it would collapse open <details>
 * panels and drop focus mid-rename.
 */

import {
  ProbeScanner, WakeLock, adapterAvailable, capabilities, describeScanError, unsupportedReason,
} from './ble.js';
import { fmtTemp } from './protocol.js';
import { ProbeRegistry } from './store.js';

const registry = new ProbeRegistry();
const scanner = new ProbeScanner();
const wake = new WakeLock();

const el = {
  unsupported: document.getElementById('unsupported'),
  unsupportedTitle: document.getElementById('unsupported-title'),
  unsupportedBody: document.getElementById('unsupported-body'),
  unsupportedSteps: document.getElementById('unsupported-steps'),
  unsupportedFlag: document.getElementById('unsupported-flag'),
  flagUrl: document.getElementById('flag-url'),
  copyFlag: document.getElementById('copy-flag'),
  scanPanel: document.getElementById('scan-panel'),
  scanBtn: document.getElementById('scan-btn'),
  scanStatus: document.getElementById('scan-status'),
  empty: document.getElementById('empty'),
  probes: document.getElementById('probes'),
  unitToggle: document.getElementById('unit-toggle'),
  unitLabel: document.getElementById('unit-label'),
  wakeToggle: document.getElementById('wake-toggle'),
  template: document.getElementById('probe-card-template'),
};

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
    cards.get(p.probeId)?.remove();
    cards.delete(p.probeId);
    renderEmptyState();
  });

  cards.set(p.probeId, node);
  el.probes.appendChild(node);
  return node;
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

  q('probe-id').textContent = p.probeId;
  q('rssi').textContent = p.last?.rssi === null || p.last?.rssi === undefined
    ? '--'
    : `${p.last.rssi} dBm`;
  q('raw').textContent = p.last ? `A ${p.last.rawA} / B ${p.last.rawB}` : '--';
  q('samples').textContent = String(p.samples.length);
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
  el.empty.hidden = any || !scanner.running;
  el.probes.hidden = !any;
}

// ------------------------------------------------------------------ scanning

async function startScan() {
  try {
    el.scanStatus.textContent = 'Requesting Bluetooth permission…';
    await scanner.start(
      (reading) => registry.ingest(reading),
      (err) => console.warn('advertisement parse failed', err),
    );
    hideNotice();
    el.scanBtn.textContent = 'Stop scanning';
    el.scanBtn.dataset.scanning = 'true';
    el.scanStatus.textContent = scanner.filtered
      ? 'Scanning. A probe can take ~10s to appear.'
      : 'Scanning (unfiltered). A probe can take ~10s to appear.';
    // Only worth holding the screen awake once data is actually flowing.
    if (WakeLock.supported) el.wakeToggle.hidden = false;
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
  scanner.stop();
  el.scanBtn.textContent = 'Start scanning';
  el.scanBtn.dataset.scanning = 'false';
  el.scanStatus.textContent = 'Stopped. Readings below are the last seen.';
  renderEmptyState();
}

// ------------------------------------------------------------------ wiring

el.scanBtn.addEventListener('click', () => {
  if (scanner.running) stopScan();
  else startScan();
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

registry.addEventListener('probe-added', () => renderEmptyState());
registry.addEventListener('change', (e) => {
  if (e.detail) updateCard(e.detail);
  else renderAll();
});
registry.addEventListener('unit-changed', () => {
  el.unitLabel.textContent = unitSuffix();
  renderAll();
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

  const reason = unsupportedReason();
  if (reason) {
    showNotice({ ...reason, steps: reason.steps ?? [] });
    el.scanBtn.disabled = true;
    el.scanStatus.textContent = 'Scanning is not available in this browser.';
  } else if (!(await adapterAvailable())) {
    showNotice({
      title: 'Bluetooth is off',
      body: 'No Bluetooth adapter is available. Switch Bluetooth on and reload.',
      steps: [],
    });
  }

  // Probes remembered from a previous session render immediately, marked
  // offline until a fresh advertisement arrives -- better than an empty screen,
  // and it keeps nicknames and history visible.
  renderAll();
  setInterval(refreshAges, 1000);

  if (capabilities().ok) {
    el.scanStatus.textContent = 'Switch a probe on and take it out of its dock.';
  }
}

boot();
