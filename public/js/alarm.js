/**
 * Target-temperature alarm.
 *
 * An important limitation, stated plainly because it shapes the design: this
 * alarm only sounds while the page is open. That is not a shortcut we took --
 * BLE scanning stops when the page is closed or discarded, so with the page
 * gone we are not receiving temperatures at all and there would be nothing to
 * alarm about. A background push notification would need a service worker AND
 * a server that knew the temperature, which nothing here does.
 *
 * The honest mitigation is the screen wake lock, which keeps the page alive and
 * scanning. The UI says so rather than implying the phone can be locked.
 *
 * Sound needs a user gesture to start. prime() must therefore be called from a
 * real tap -- setting the target is the natural one -- or the alarm will be
 * silently muted by autoplay policy when it eventually fires.
 */

/** Repeating two-tone beep via Web Audio, plus vibration where supported. */
export class Alarm {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.running = false;
  }

  static get canVibrate() {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  /**
   * Unlock audio. Call from inside a user-gesture handler.
   * Safe to call repeatedly.
   */
  async prime() {
    try {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) return false;
      if (!this.ctx) this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  /** True if audio is unlocked and would actually be audible. */
  get audioReady() {
    return Boolean(this.ctx && this.ctx.state === 'running');
  }

  _tone(at, freq, dur) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square'; // carries better than a sine through kitchen noise
    osc.frequency.value = freq;
    // Ramped envelope: a bare start/stop on a square wave clicks audibly.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.28, at + 0.012);
    gain.gain.setValueAtTime(0.28, at + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.01);
  }

  _burst() {
    if (this.ctx && this.ctx.state === 'running') {
      const t = this.ctx.currentTime;
      this._tone(t, 880, 0.16);
      this._tone(t + 0.22, 1170, 0.16);
    }
    if (Alarm.canVibrate) {
      try {
        navigator.vibrate([220, 90, 220]);
      } catch { /* some browsers throw when the page is hidden */ }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._burst();
    this.timer = setInterval(() => this._burst(), 1600);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (Alarm.canVibrate) {
      try { navigator.vibrate(0); } catch { /* ignore */ }
    }
  }
}
