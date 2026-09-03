/**
 * First-run disclaimer gate.
 *
 * This app drives decisions about whether food is safely cooked, from a
 * protocol that was reverse-engineered by watching radio packets. The user
 * needs to know what it does not do before they rely on it, so acceptance is
 * required once and recorded.
 *
 * Acceptance lives under its own storage key rather than inside the app state
 * blob, so clearing probe history does not silently un-accept, and a corrupt
 * state blob cannot accidentally mark it accepted.
 */

const KEY = 'fun.disclaimer';

/**
 * Bump when the disclaimer's substance changes, which re-prompts everyone.
 * Do not bump for typo fixes -- re-prompting has a cost in goodwill.
 */
export const DISCLAIMER_VERSION = 1;

/** Seconds the accept button stays disabled, so the text gets read. */
export const READ_SECONDS = 10;

/** Parse the stored record; never throws. */
export function readAcceptance(store = globalThis.localStorage) {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data?.version !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * True if the gate must be shown.
 *
 * Fails closed: anything unparseable, missing, or from an older version of the
 * text means "show it again".
 */
export function needsAcceptance(store = globalThis.localStorage) {
  const rec = readAcceptance(store);
  return !rec || rec.version < DISCLAIMER_VERSION;
}

export function recordAcceptance(store = globalThis.localStorage) {
  try {
    store?.setItem(KEY, JSON.stringify({
      version: DISCLAIMER_VERSION,
      at: new Date().toISOString(),
    }));
    return true;
  } catch {
    // Private mode or a full quota. Let them through rather than trapping them
    // behind a gate that can never be satisfied; they will see it again.
    return false;
  }
}

/**
 * Run the disclaimer gate once.
 *
 * Presented as its own view rather than an overlay on the app: nothing of the
 * main interface should be visible, let alone reachable, before the terms are
 * accepted.
 *
 * Resolves with a terminal outcome every time -- 'already-accepted',
 * 'accepted', or 'declined' -- rather than hanging forever on a decline. The
 * caller decides what a decline means; this function does not assume it can
 * strand the user. Listeners are torn down on resolution, so calling it again
 * (after "review the terms") does not stack handlers.
 *
 * @param {{
 *   acceptBtn: HTMLButtonElement,
 *   declineBtn?: HTMLElement,
 *   hint?: HTMLElement,
 *   setView: (name: 'disclaimer'|'declined'|'main') => void,
 * }} els
 * @param {{seconds?: number, store?: Storage}} [opts]
 * @returns {Promise<'already-accepted'|'accepted'|'declined'>}
 */
export function runDisclaimerGate(els, opts = {}) {
  const seconds = opts.seconds ?? READ_SECONDS;
  const store = opts.store ?? globalThis.localStorage;

  if (!needsAcceptance(store)) return Promise.resolve('already-accepted');

  return new Promise((resolve) => {
    const label = 'I have read and accept';
    const ac = new AbortController();
    let timer = null;

    function finish(outcome) {
      clearInterval(timer);
      timer = null;
      ac.abort(); // drop our listeners, so a later call starts clean
      resolve(outcome);
    }

    els.acceptBtn.addEventListener('click', () => {
      // Guard rather than trust the disabled attribute: a synthetic or
      // programmatic click would otherwise skip the read delay entirely.
      if (els.acceptBtn.disabled) return;
      recordAcceptance(store);
      finish('accepted');
    }, { signal: ac.signal });

    els.declineBtn?.addEventListener('click', () => {
      // Nothing is recorded, so the terms return on the next visit.
      els.setView('declined');
      finish('declined');
    }, { signal: ac.signal });

    els.setView('disclaimer');

    let left = seconds;
    els.acceptBtn.disabled = true;
    els.acceptBtn.textContent = `${label} (${left})`;
    if (els.hint) els.hint.hidden = false;

    timer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        els.acceptBtn.textContent = `${label} (${left})`;
        return;
      }
      clearInterval(timer);
      timer = null;
      els.acceptBtn.disabled = false;
      els.acceptBtn.textContent = label;
      if (els.hint) els.hint.hidden = true;
      // Focus only once it is actionable, so assistive tech is not pointed at
      // a button that cannot yet be pressed.
      els.acceptBtn.focus?.();
    }, 1000);
  });
}
