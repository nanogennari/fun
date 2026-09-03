/**
 * Disclaimer gate: the acceptance record and the countdown behaviour.
 *
 * The gate must fail CLOSED -- anything unparseable, missing, or from an older
 * version of the text means show it again. Getting that backwards would let
 * someone reach the app without ever seeing the terms.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DISCLAIMER_VERSION, READ_SECONDS, needsAcceptance, readAcceptance,
  recordAcceptance, runDisclaimerGate,
} from '../public/js/disclaimer.js';

/** Minimal Storage stand-in. */
function store(initial) {
  const m = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/**
 * Just enough of a button to drive the gate, including AbortController
 * support -- the gate relies on signals to tear its listeners down, so a fake
 * that ignored them would hide handler stacking.
 */
function el(tag = 'button') {
  const listeners = new Set();
  return {
    tag,
    disabled: false,
    hidden: false,
    textContent: '',
    focused: false,
    focus() { this.focused = true; },
    addEventListener(type, fn, opts) {
      const entry = { type, fn, signal: opts?.signal };
      listeners.add(entry);
      opts?.signal?.addEventListener?.('abort', () => listeners.delete(entry));
    },
    listenerCount(type = 'click') {
      return [...listeners].filter((l) => l.type === type && !l.signal?.aborted).length;
    },
    click() {
      for (const l of [...listeners]) {
        if (l.type === 'click' && !l.signal?.aborted) l.fn();
      }
    },
  };
}

test('a fresh install must be shown the terms', () => {
  assert.equal(needsAcceptance(store()), true);
});

test('accepting is recorded with the version and a timestamp', () => {
  const s = store();
  assert.equal(recordAcceptance(s), true);
  const rec = readAcceptance(s);
  assert.equal(rec.version, DISCLAIMER_VERSION);
  assert.ok(!Number.isNaN(Date.parse(rec.at)), 'timestamp should be parseable');
  assert.equal(needsAcceptance(s), false);
});

test('an older accepted version re-prompts', () => {
  const s = store({ 'fun.disclaimer': JSON.stringify({ version: DISCLAIMER_VERSION - 1, at: 'x' }) });
  assert.equal(needsAcceptance(s), true, 'changed terms must be re-accepted');
});

test('a newer version does not re-prompt', () => {
  // Downgrading the app should not nag someone who accepted newer terms.
  const s = store({ 'fun.disclaimer': JSON.stringify({ version: DISCLAIMER_VERSION + 1, at: 'x' }) });
  assert.equal(needsAcceptance(s), false);
});

test('corrupt or bogus records fail closed', () => {
  for (const raw of ['{broken', '{}', 'null', '"yes"', JSON.stringify({ version: 'one' })]) {
    const s = store({ 'fun.disclaimer': raw });
    assert.equal(needsAcceptance(s), true, `should re-prompt for ${raw}`);
  }
});

test('storage being unavailable does not trap the user behind the gate', () => {
  // Private mode or a full quota: let them in rather than making the gate
  // impossible to satisfy. They will simply see it again next time.
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  assert.equal(needsAcceptance(broken), true);
  assert.equal(recordAcceptance(broken), false, 'reports that it could not persist');
});

test('a returning user goes straight through without any UI', async () => {
  const s = store();
  recordAcceptance(s);
  const accept = el();
  let viewed = null;
  const res = await runDisclaimerGate(
    { acceptBtn: accept, setView: (v) => { viewed = v; } },
    { store: s, seconds: 5 },
  );
  assert.equal(res, 'already-accepted');
  assert.equal(viewed, null, 'must not switch to the disclaimer view');
  assert.equal(accept.textContent, '', 'must not touch the button');
});

test('accept starts disabled and unlocks only after the countdown', async () => {
  const s = store();
  const accept = el();
  const hint = el('p');
  let viewed = null;

  const done = runDisclaimerGate(
    { acceptBtn: accept, hint, setView: (v) => { viewed = v; } },
    { store: s, seconds: 2 },
  );

  assert.equal(viewed, 'disclaimer');
  assert.equal(accept.disabled, true, 'must not be clickable immediately');
  assert.match(accept.textContent, /\(2\)$/);
  assert.equal(hint.hidden, false);

  // Clicking while disabled must do nothing at all.
  accept.click();
  assert.equal(needsAcceptance(s), true, 'a disabled click must not accept');

  await new Promise((r) => setTimeout(r, 2400));
  assert.equal(accept.disabled, false);
  assert.equal(accept.textContent, 'I have read and accept');
  assert.equal(accept.focused, true, 'focus once it is actionable');
  assert.equal(hint.hidden, true);

  accept.click();
  assert.equal(await done, 'accepted');
  assert.equal(needsAcceptance(s), false, 'acceptance persisted');
});

test('declining resolves as declined, records nothing, and shows that view', async () => {
  const s = store();
  const accept = el();
  const decline = el();
  const views = [];
  const done = runDisclaimerGate(
    { acceptBtn: accept, declineBtn: decline, setView: (v) => views.push(v) },
    { store: s, seconds: 1 },
  );
  decline.click();
  assert.equal(await done, 'declined');
  assert.deepEqual(views, ['disclaimer', 'declined']);
  assert.equal(needsAcceptance(s), true, 'declining must not be remembered as consent');
});

test('re-running after a decline restarts the countdown, so the wait cannot be skipped', async () => {
  const s = store();
  const accept = el();
  const decline = el();
  const views = [];
  const gate = { acceptBtn: accept, declineBtn: decline, setView: (v) => views.push(v) };

  const first = runDisclaimerGate(gate, { store: s, seconds: 3 });
  await new Promise((r) => setTimeout(r, 1100));   // burn part of the countdown
  decline.click();
  assert.equal(await first, 'declined');

  runDisclaimerGate(gate, { store: s, seconds: 3 });
  assert.equal(accept.disabled, true, 'countdown must restart, not resume');
  assert.match(accept.textContent, /\(3\)$/);
  assert.deepEqual(views, ['disclaimer', 'declined', 'disclaimer']);
});

test('listeners do not stack across repeated runs', async () => {
  // Without teardown, decline-review-decline would attach a second accept
  // handler and accept could fire twice.
  const s = store();
  const accept = el();
  const decline = el();
  const gate = { acceptBtn: accept, declineBtn: decline, setView: () => {} };

  const first = runDisclaimerGate(gate, { store: s, seconds: 1 });
  decline.click();
  await first;
  assert.equal(accept.listenerCount(), 0, 'accept listener should be torn down');

  runDisclaimerGate(gate, { store: s, seconds: 1 });
  assert.equal(accept.listenerCount(), 1, 'exactly one accept listener, not two');
});

test('a programmatic click cannot skip the read delay', async () => {
  // The disabled attribute alone would not stop a synthetic click.
  const s = store();
  const accept = el();
  runDisclaimerGate({ acceptBtn: accept, setView: () => {} }, { store: s, seconds: 30 });
  accept.click();
  accept.click();
  assert.equal(needsAcceptance(s), true, 'must still require acceptance');
});

test('the read delay is a sane length', () => {
  assert.ok(READ_SECONDS >= 5 && READ_SECONDS <= 30, `got ${READ_SECONDS}`);
});
