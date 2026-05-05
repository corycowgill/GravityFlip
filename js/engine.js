// Engine: canvas sizing, fixed-timestep loop, input
//
// The simulation runs at a fixed 120 Hz (FIXED_DT = 1/120 s). The render loop
// is driven by requestAnimationFrame and may run at any refresh rate. Each
// rAF frame, we accumulate elapsed wall time and run as many fixed updates
// as needed to catch up, then render once. This makes physics behave
// identically on a 30 Hz phone and a 144 Hz desktop and produces a stable
// monotonic tick counter for replays / leaderboards / future deterministic
// features.
const TARGET_W = 960;
const TARGET_H = 540;
const FIXED_HZ = 120;
const FIXED_DT = 1 / FIXED_HZ;
const MAX_CATCHUP_STEPS = 8; // panic cap: never run more than this many sims per render

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.width = TARGET_W;
    this.height = TARGET_H;
    this.scale = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.running = false;
    this.paused = false;
    this.last = 0;
    this.acc = 0;
    this.fixedDt = FIXED_DT;
    this.ticks = 0;          // monotonic simulation tick counter

    // FPS / perf tracking
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._fpsTickAcc = 0;
    this.tps = 0;            // ticks-per-second (should hover near FIXED_HZ)
    this.lastFrameMs = 0;

    // Debug overlay toggle (backtick key)
    this.debug = false;

    this.input = new Input(this);

    // Resize is debounced via rAF so layout-thrashy events don't recompute
    // the same math repeatedly.
    let resizePending = false;
    const onResize = () => {
      if (resizePending) return;
      resizePending = true;
      requestAnimationFrame(() => { resizePending = false; this.resize(); });
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    this.resize();

    // Toggle debug overlay
    this.input.on("debugToggle", () => { this.debug = !this.debug; });
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
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(cssW * this.dpr);
    this.canvas.height = Math.floor(cssH * this.dpr);
    this.cssW = cssW;
    this.cssH = cssH;
  }

  // Backwards-compatible: if a single-arg fn is passed, treat it as combined.
  // Preferred: Engine.start({ update, render }).
  start(arg) {
    if (typeof arg === "function") {
      this.updateFn = arg;
      this.renderFn = null;
    } else {
      this.updateFn = arg.update;
      this.renderFn = arg.render;
    }
    this.running = true;
    this.last = performance.now();
    this.acc = 0;
    requestAnimationFrame((t) => this._frame(t));
  }

  _frame(now) {
    if (!this.running) return;
    const frameStart = now;
    let elapsed = (now - this.last) / 1000;
    if (elapsed > 0.25) elapsed = 0.25; // panic clamp on long pauses
    this.last = now;

    if (!this.paused) {
      this.acc += elapsed;
      let steps = 0;
      while (this.acc >= this.fixedDt && steps < MAX_CATCHUP_STEPS) {
        this.updateFn(this.fixedDt);
        this.acc -= this.fixedDt;
        this.ticks++;
        this._fpsTickAcc++;
        steps++;
      }
      // If we ran out of step budget, drop accumulated time so we don't
      // keep falling further behind ("spiral of death").
      if (steps >= MAX_CATCHUP_STEPS) this.acc = 0;

      this._setupTransform();
      if (this.renderFn) this.renderFn(this.acc / this.fixedDt);
      else this.updateFn(0); // legacy combined path
    }

    // FPS / TPS smoothing
    this._fpsAcc += elapsed;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this.tps = this._fpsTickAcc / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
      this._fpsTickAcc = 0;
    }
    this.lastFrameMs = performance.now() - frameStart;

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
  resume() { this.paused = false; this.last = performance.now(); this.acc = 0; }
}

// Input: keyboard + swipe + gamepad
//
// Improvements over the previous version:
// - Swipe detection now considers velocity (px/sec) so a fast flick beats the
//   distance threshold even on small movements.
// - Gamepad polling: d-pad and left stick map to flips; A/B to action;
//   shoulder buttons to slow-mo.
// - Backtick toggles a debug overlay.
// - Haptic helper exposed via vibrate() — pages with no support no-op safely.
export class Input {
  constructor(engine) {
    this.engine = engine;
    this.keys = new Set();
    this.listeners = {
      flip: [], action: [], slow: [], restart: [], escape: [], debugToggle: [],
    };
    this.slowHeld = false;
    this.enabled = true;
    this.lastFlipDir = null;

    // Gamepad axis state (so we only emit one flip per axis push)
    this._padAxisLatched = { x: 0, y: 0 };
    this._padButtonsPrev = [];

    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.onKeyUp(e));

    const c = engine.canvas;
    let sx = 0, sy = 0, st = 0, holdTimer = null, moved = false, active = false;
    let lastMoveX = 0, lastMoveY = 0, lastMoveT = 0;
    const SWIPE_MIN_PX = 28;
    const SWIPE_MIN_VEL = 700; // px/sec — fast flick threshold (alternative to distance)
    const TAP_MAX_TIME = 220;
    const HOLD_TIME = 260;

    c.addEventListener("pointerdown", (e) => {
      if (!this.enabled) return;
      active = true;
      sx = lastMoveX = e.clientX;
      sy = lastMoveY = e.clientY;
      st = lastMoveT = performance.now();
      moved = false;
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
      // Velocity at last move sample
      const lastDt = (performance.now() - lastMoveT) / 1000;
      const vx = lastDt > 0 ? (e.clientX - lastMoveX) / lastDt : 0;
      const vy = lastDt > 0 ? (e.clientY - lastMoveY) / lastDt : 0;
      const speed = Math.hypot(vx, vy);
      if (this.slowHeld) {
        this.slowHeld = false;
        this.emit("slow", false);
        return;
      }
      if (!this.enabled) return;
      const distOk = Math.max(ax, ay) >= SWIPE_MIN_PX;
      const velOk = speed >= SWIPE_MIN_VEL && Math.max(ax, ay) >= 12;
      if (distOk || velOk) {
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
      lastMoveX = e.clientX;
      lastMoveY = e.clientY;
      lastMoveT = performance.now();
    }, { passive: true });

    // Poll gamepad on every animation frame.
    if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") {
      const tick = () => { this._pollGamepad(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
  }

  on(evt, fn) {
    if (!this.listeners[evt]) this.listeners[evt] = [];
    this.listeners[evt].push(fn);
  }
  emit(evt, payload) { for (const fn of this.listeners[evt] || []) fn(payload); }
  setEnabled(v) {
    this.enabled = v;
    if (!v && this.slowHeld) {
      this.slowHeld = false;
      this.emit("slow", false);
    }
  }

  // Lightweight haptic helper. No-ops on platforms without vibrate.
  vibrate(pattern) {
    try {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        navigator.vibrate(pattern);
      }
    } catch {}
  }

  onKeyDown(e) {
    if (this.keys.has(e.code)) return;
    this.keys.add(e.code);
    if (e.code === "Backquote") { this.emit("debugToggle"); return; }
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

  _pollGamepad() {
    if (!this.enabled) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (!pads) return;
    for (const pad of pads) {
      if (!pad) continue;
      // D-pad buttons (12 up, 13 down, 14 left, 15 right)
      const down = (i) => pad.buttons[i] && pad.buttons[i].pressed;
      const wasDown = (i) => this._padButtonsPrev[i] === true;
      const press = (i, dir) => {
        if (down(i) && !wasDown(i)) this.emit("flip", dir);
      };
      press(12, "up"); press(13, "down"); press(14, "left"); press(15, "right");
      // Slow-mo on left or right shoulder (4, 5)
      const slowDown = down(4) || down(5);
      if (slowDown && !this.slowHeld) { this.slowHeld = true; this.emit("slow", true); }
      else if (!slowDown && this.slowHeld) { this.slowHeld = false; this.emit("slow", false); }
      // A button (0) = action; Start (9) = restart; Back (8) = escape
      if (down(0) && !wasDown(0)) this.emit("action");
      if (down(9) && !wasDown(9)) this.emit("restart");
      if (down(8) && !wasDown(8)) this.emit("escape");

      // Stash button state for next frame's edge detection
      this._padButtonsPrev = pad.buttons.map(b => b && b.pressed);

      // Left stick: only emit flip on threshold cross.
      const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
      const TH = 0.55;
      const sx = Math.abs(ax) > TH ? Math.sign(ax) : 0;
      const sy = Math.abs(ay) > TH ? Math.sign(ay) : 0;
      if (sx !== this._padAxisLatched.x) {
        this._padAxisLatched.x = sx;
        if (sx === 1) this.emit("flip", "right");
        else if (sx === -1) this.emit("flip", "left");
      }
      if (sy !== this._padAxisLatched.y) {
        this._padAxisLatched.y = sy;
        if (sy === 1) this.emit("flip", "down");
        else if (sy === -1) this.emit("flip", "up");
      }
      break; // first connected pad only
    }
  }
}
