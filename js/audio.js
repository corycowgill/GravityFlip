// Web Audio: synthesized SFX (no asset files). Lazy-init on first user gesture.
export class AudioFx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
  }

  _ensure() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  resume() {
    this._ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  setMuted(v) {
    this.muted = v;
    if (this.master) this.master.gain.value = v ? 0 : 0.5;
  }

  // Solid "thunk" on flip
  flip() {
    this._tone({ freq: 90, type: "square", dur: 0.07, gain: 0.5, decay: 0.9 });
    this._tone({ freq: 180, type: "sine", dur: 0.12, gain: 0.25, decay: 0.85 });
  }
  land() {
    this._tone({ freq: 60, type: "square", dur: 0.06, gain: 0.35, decay: 0.6 });
  }
  die() {
    this._noiseBurst(0.18, 0.6);
    this._tone({ freq: 220, type: "sawtooth", dur: 0.18, gain: 0.4, decay: 0.4, slideTo: 80 });
  }
  win() {
    const t = this.ctx ? this.ctx.currentTime : 0;
    [523, 659, 784, 988].forEach((f, i) => {
      this._tone({ freq: f, type: "triangle", dur: 0.12, gain: 0.3, decay: 0.7, when: t + i * 0.07 });
    });
  }
  click() {
    this._tone({ freq: 720, type: "square", dur: 0.04, gain: 0.18, decay: 0.5 });
  }
  laser() {
    this._tone({ freq: 1200, type: "sawtooth", dur: 0.25, gain: 0.12, decay: 0.5 });
  }
  bounce() {
    this._tone({ freq: 320, type: "sine", dur: 0.1, gain: 0.3, decay: 0.6, slideTo: 720 });
  }
  pickup() {
    this._tone({ freq: 880, type: "triangle", dur: 0.08, gain: 0.25, decay: 0.6 });
  }

  _tone({ freq = 440, type = "sine", dur = 0.1, gain = 0.3, decay = 0.6, when = 0, slideTo = null }) {
    this._ensure();
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = when || ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (1 + decay));
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur * (1 + decay) + 0.02);
  }

  _noiseBurst(dur, gain) {
    this._ensure();
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
  }
}
