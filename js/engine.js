// Engine: canvas sizing, render loop, input
const TARGET_W = 960;
const TARGET_H = 540;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.width = TARGET_W;
    this.height = TARGET_H;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.running = false;
    this.paused = false;
    this.last = 0;

    this.input = new Input(this);

    window.addEventListener("resize", () => this.resize());
    window.addEventListener("orientationchange", () => this.resize());
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const sx = cssW / TARGET_W;
    const sy = cssH / TARGET_H;
    this.scale = Math.min(sx, sy);
    const drawW = TARGET_W * this.scale;
    const drawH = TARGET_H * this.scale;
    this.offsetX = (cssW - drawW) / 2;
    this.offsetY = (cssH - drawH) / 2;
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
    this.cssW = cssW;
    this.cssH = cssH;
  }

  start(tick) {
    this.tickFn = tick;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    if (!this.running) return;
    let dt = (now - this.last) / 1000;
    if (dt > 0.05) dt = 0.05; // clamp huge jumps (tab switch, etc.)
    this.last = now;
    if (!this.paused) {
      this._setupTransform();
      this.tickFn(dt);
    }
    requestAnimationFrame((t) => this._frame(t));
  }

  _setupTransform() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(
      this.dpr * this.scale, 0,
      0, this.dpr * this.scale,
      this.offsetX * this.dpr, this.offsetY * this.dpr
    );
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; this.last = performance.now(); }
}

// Input: keyboard + swipe gestures
export class Input {
  constructor(engine) {
    this.engine = engine;
    this.keys = new Set();
    this.listeners = { flip: [], action: [], slow: [], restart: [], escape: [] };
    this.slowHeld = false;
    this.enabled = true;

    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));

    const c = engine.canvas;
    let sx = 0, sy = 0, st = 0, holdTimer = null, moved = false, active = false;
    const SWIPE_MIN = 28;
    const TAP_MAX_TIME = 220;
    const HOLD_TIME = 280;

    c.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      active = true;
      sx = e.clientX; sy = e.clientY; st = performance.now(); moved = false;
      try { c.setPointerCapture(e.pointerId); } catch {}
      holdTimer = setTimeout(() => {
        if (!moved && active) {
          this.slowHeld = true;
          this.emit("slow", true);
        }
      }, HOLD_TIME);
    });

    const finish = (e) => {
      if (!active) return;
      active = false;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      const dur = performance.now() - st;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const ax = Math.abs(dx), ay = Math.abs(dy);
      if (this.slowHeld) {
        this.slowHeld = false;
        this.emit("slow", false);
        return;
      }
      if (!this.enabled) return;
      if (Math.max(ax, ay) >= SWIPE_MIN) {
        if (ax > ay) this.emit("flip", dx > 0 ? "right" : "left");
        else this.emit("flip", dy > 0 ? "down" : "up");
      } else if (dur < TAP_MAX_TIME) {
        this.emit("action");
      }
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", () => {
      active = false;
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (this.slowHeld) { this.slowHeld = false; this.emit("slow", false); }
    });
    c.addEventListener("pointermove", (e) => {
      if (!active) return;
      const dx = Math.abs(e.clientX - sx), dy = Math.abs(e.clientY - sy);
      if (dx > 6 || dy > 6) moved = true;
    }, { passive: true });
  }

  on(evt, fn) {
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(fn);
  }
  emit(evt, payload) { for (const fn of this.listeners[evt] || []) fn(payload); }
  setEnabled(v) { this.enabled = v; }

  onKeyDown(e) {
    if (this.keys.has(e.code)) return;
    this.keys.add(e.code);
    if (!this.enabled) return;
    switch (e.code) {
      case "ArrowUp": case "KeyW": this.emit("flip", "up"); e.preventDefault(); break;
      case "ArrowDown": case "KeyS": this.emit("flip", "down"); e.preventDefault(); break;
      case "ArrowLeft": case "KeyA": this.emit("flip", "left"); e.preventDefault(); break;
      case "ArrowRight": case "KeyD": this.emit("flip", "right"); e.preventDefault(); break;
      case "Space":
        if (!this.slowHeld) { this.slowHeld = true; this.emit("slow", true); }
        e.preventDefault();
        break;
      case "Enter": this.emit("action"); break;
      case "KeyR": this.emit("restart"); break;
      case "Escape": this.emit("escape"); break;
    }
  }
  onKeyUp(e) {
    this.keys.delete(e.code);
    if (e.code === "Space" && this.slowHeld) {
      this.slowHeld = false;
      this.emit("slow", false);
    }
  }
}
