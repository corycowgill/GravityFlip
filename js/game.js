// Game: ties level + player + hazards + render together.
import { Level } from "./level.js";
import { Player, GRAV } from "./player.js";
import { TILE, COLS, ROWS, T, isSolid } from "./tiles.js";

export class Game {
  constructor(engine, audio, save) {
    this.engine = engine;
    this.audio = audio;
    this.save = save;
    this.player = new Player();
    this.level = null;
    this.def = null;
    this.state = "menu";  // menu | play | win | dead
    this.t = 0;            // total runtime since level load
    this.flipFx = []; // particle/ring effects for flips
    this.deathT = 0;
    this.winT = 0;
    this.slow = false;
    this.dynObjs = []; // crates/spheres
    this.lasers = []; // [{x1,y1,x2,y2,active,phase,period,dir}]
    this.particles = [];
    this.flashT = 0;
    this.bgRot = 0;
    this.targetBgRot = 0;
    this.startTime = 0;
    this.elapsed = 0;
    this.onWin = null;
    this.onDeath = null;
    // Camera shake
    this.shakeT = 0;
    this.shakeMag = 0;
    // Door animation (shared across all doors in a level): 0=closed, 1=open.
    this.doorAnim = 0;
    this.doorAnimTarget = 0;
    // Ambient drifting motes for atmosphere (drawn behind the level).
    this.ambient = [];
    this._initAmbient();
    // Sparks emitted at laser endpoints.
    this.sparks = [];
    this._hookInput();
  }

  _initAmbient() {
    const W = COLS * TILE, H = ROWS * TILE;
    for (let i = 0; i < 36; i++) {
      this.ambient.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: 0.3 + Math.random() * 0.7,           // depth: 0.3 = far, 1.0 = near
        size: 0.6 + Math.random() * 1.6,
        phase: Math.random() * Math.PI * 2,
        hue: Math.random() < 0.5 ? "#5cf2ff" : "#ff5cf2",
      });
    }
  }

  _hookInput() {
    const inp = this.engine.input;
    inp.on("flip", (dir) => {
      if (this.state !== "play") return;
      this.audio.resume();
      // The Player emits a "flip" event for both immediate and buffered flips.
      // FX/audio happen there so we never double-fire.
      this.player.tryFlip(dir);
    });
    inp.on("slow", (v) => { this.slow = !!v; });
    inp.on("restart", () => { if (this.state === "play" || this.state === "dead") this.restart(); });
  }

  _shake(mag, dur) {
    if (mag > this.shakeMag) this.shakeMag = mag;
    if (dur > this.shakeT) this.shakeT = dur;
  }

  load(def) {
    this.def = def;
    this.level = new Level(def);
    this.player.spawnAt(this.level.spawn.x, this.level.spawn.y);
    this.state = "play";
    this.t = 0;
    this.elapsed = 0;
    this.startTime = performance.now();
    this.deathT = 0; this.winT = 0;
    this.flipFx.length = 0;
    this.particles.length = 0;
    this.flashT = 0;
    this.bgRot = 0; this.targetBgRot = 0;
    this.shakeT = 0; this.shakeMag = 0;

    // Build dynamic objects
    this.dynObjs = this.level.objects.map((o, i) => ({
      id: i,
      kind: o.kind,
      x: o.gx * TILE,
      y: o.gy * TILE,
      w: o.kind === "sphere" ? 28 : 28,
      h: o.kind === "sphere" ? 28 : 28,
      vx: 0, vy: 0,
      gravity: { x: 0, y: 1 },
      desyncTimer: 0,
      pendingGravity: null,
      props: o.props || {},
    }));

    // Build lasers
    this.lasers = (this.level.lasers || []).map(l => ({
      ...l,
      phase: l.phase || 0,
      active: true,
    }));

    this.engine.input.setEnabled(true);
  }

  restart() {
    if (this.def) this.load(this.def);
  }

  _updateBgRotTarget() {
    const g = this.player.gravity;
    if (g === GRAV.DOWN) this.targetBgRot = 0;
    else if (g === GRAV.UP) this.targetBgRot = 180;
    else if (g === GRAV.LEFT) this.targetBgRot = -90;
    else if (g === GRAV.RIGHT) this.targetBgRot = 90;
    // Notify dynamic objects (desync support)
    for (const o of this.dynObjs) {
      if (this.level.desync && this.level.desync.kinds && this.level.desync.kinds.includes(o.kind)) {
        o.pendingGravity = g;
        o.desyncTimer = this.level.desync.delay || 0.35;
      } else if (this.level.desync && this.level.desync.ignore && this.level.desync.ignore.includes(o.kind)) {
        // never flip
      } else {
        o.gravity = g;
      }
    }
    this.flashT = 0.18;
  }

  // Pooled particle spawn — reuses dead slots in this.particles instead of
  // allocating new objects each frame. Caps active particle count.
  // kind: "dot" (default) | "shard" — shards render as rotating rounded rects
  // and accept an optional `gy` for simulated gravity (used for confetti).
  _spawnParticle(x, y, vx, vy, life, color, kind = "dot", opts = null) {
    const rot = opts && opts.rot != null ? opts.rot : Math.random() * Math.PI * 2;
    const vrot = opts && opts.vrot != null ? opts.vrot : (Math.random() - 0.5) * 8;
    const gy = opts && opts.gy != null ? opts.gy : 0;
    const size = opts && opts.size != null ? opts.size : (kind === "shard" ? 7 : 0);
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.age >= p.life) {
        p.x = x; p.y = y; p.vx = vx; p.vy = vy;
        p.life = life; p.age = 0; p.color = color;
        p.kind = kind; p.rot = rot; p.vrot = vrot; p.gy = gy; p.size = size;
        return;
      }
    }
    if (this.particles.length >= 240) return;
    this.particles.push({ x, y, vx, vy, life, age: 0, color, kind, rot, vrot, gy, size });
  }

  _spawnFlipFx() {
    const cx = this.player.x + this.player.w / 2;
    const cy = this.player.y + this.player.h / 2;
    this.flipFx.push({ x: cx, y: cy, t: 0, max: 0.4 });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 200;
      this._spawnParticle(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp,
                          0.35 + Math.random() * 0.25,
                          Math.random() < 0.5 ? "#5cf2ff" : "#ff5cf2");
    }
  }

  _killPlayer() {
    if (!this.player.alive) return;
    this.player.alive = false;
    this.audio.die();
    this.state = "dead";
    this.deathT = 0;
    const cx = this.player.x + this.player.w / 2;
    const cy = this.player.y + this.player.h / 2;
    // Big chunky shards: the player visibly fragments outward.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.random() * 0.4;
      const sp = 220 + Math.random() * 220;
      this._spawnParticle(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp,
                          0.7 + Math.random() * 0.3, "#9efbff", "shard",
                          { vrot: (Math.random() - 0.5) * 16, size: 9 });
    }
    // Red dust burst on top
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 260;
      this._spawnParticle(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp,
                          0.5 + Math.random() * 0.4, "#ff5c6b");
    }
  }
  _onWin() {
    if (this.state !== "play") return;
    this.state = "win";
    this.winT = 0;
    this.elapsed = (performance.now() - this.startTime) / 1000;
    this.audio.win();
    this.save.setCleared(this.def.id);
    this.save.setBest(this.def.id, this.elapsed);
    if (this.onWin) this.onWin({ id: this.def.id, time: this.elapsed });
    // Confetti rain from above + celebratory burst from the exit
    const colors = ["#ff5c6b", "#ffd35c", "#5cf2ff", "#a3ff5c", "#ff5cf2", "#ffffff"];
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * COLS * TILE;
      const y = -10 - Math.random() * 80;
      const vx = (Math.random() - 0.5) * 90;
      const vy = 60 + Math.random() * 90;
      this._spawnParticle(x, y, vx, vy, 1.8 + Math.random() * 1.2,
                          colors[Math.floor(Math.random() * colors.length)],
                          "shard", { vrot: (Math.random() - 0.5) * 12, size: 6, gy: 240 });
    }
    // Burst at exit center
    const cx = this.player.x + this.player.w / 2;
    const cy = this.player.y + this.player.h / 2;
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 120 + Math.random() * 220;
      this._spawnParticle(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp,
                          0.6 + Math.random() * 0.4, "#ffd884");
    }
  }

  update(dtRaw) {
    if (this.state === "menu") return;
    // Slow-mo affects EVERYTHING (lasers, crates, particles, rotations) so the
    // world reads consistently. Render-side effects (camera shake decay) use
    // raw dt so the screen still feels responsive.
    const dt = this.slow ? dtRaw * 0.4 : dtRaw;
    this.t += dt;

    // Camera shake decays on real time so it always feels punchy.
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dtRaw);
      if (this.shakeT === 0) this.shakeMag = 0;
    }

    // Background rotation easing
    let diff = this.targetBgRot - this.bgRot;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    const rs = 360;
    if (Math.abs(diff) <= rs * dt) this.bgRot = this.targetBgRot;
    else this.bgRot += Math.sign(diff) * rs * dt;

    if (this.flashT > 0) this.flashT = Math.max(0, this.flashT - dt);

    // Door animation easing
    const doorEase = Math.min(1, dtRaw * 9);
    this.doorAnim += (this.doorAnimTarget - this.doorAnim) * doorEase;

    // Update lasers (now slowed by dt) — also emit endpoint sparks while active.
    for (const l of this.lasers) {
      if (l.period) {
        l.phase += dt;
        if (l.phase >= l.period) l.phase -= l.period;
        const duty = l.duty != null ? l.duty : 0.5;
        l.active = (l.phase / l.period) < duty;
      }
      if (l.active && this.state === "play" && Math.random() < dt * 24) {
        // Random spark at one endpoint, kicked outward along the beam line.
        const useStart = Math.random() < 0.5;
        const ex = useStart ? l.x1 : l.x2;
        const ey = useStart ? l.y1 : l.y2;
        const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
        const nx = (l.x2 - l.x1) / len, ny = (l.y2 - l.y1) / len;
        const dirSign = useStart ? -1 : 1;
        const angOff = (Math.random() - 0.5) * 1.4;
        const c = Math.cos(angOff), s = Math.sin(angOff);
        const vx = dirSign * (nx * c - ny * s) * (40 + Math.random() * 90);
        const vy = dirSign * (nx * s + ny * c) * (40 + Math.random() * 90);
        this._spawnParticle(ex, ey, vx, vy, 0.25 + Math.random() * 0.2, "#ffb0a0");
      }
    }

    // Gravity zone field particles: occasionally spawn a particle inside
    // each zone, drifting in the zone's gravity direction. Makes the field
    // visible at a glance.
    if (this.level && this.level.gravityZones && this.state === "play") {
      for (const z of this.level.gravityZones) {
        if (Math.random() < dt * 4) {
          const px = (z.x + Math.random() * z.w) * TILE;
          const py = (z.y + Math.random() * z.h) * TILE;
          const sp = 70 + Math.random() * 50;
          this._spawnParticle(px, py, z.dir.x * sp, z.dir.y * sp,
                              0.9 + Math.random() * 0.6, "#ff90ec");
        }
      }
    }

    this._updatePlatesAndDoors();

    if (this.state === "play") {
      this.player.update(dt, this.level, {});
      this._drainPlayerEvents();
      this._updateDynObjs(dt);

      // Win check
      const cx = this.player.x + this.player.w / 2;
      const cy = this.player.y + this.player.h / 2;
      const tile = this.level.getTile(Math.floor(cx / TILE), Math.floor(cy / TILE));
      if (tile === T.EXIT) this._onWin();

      // Out of bounds
      if (cx < -32 || cy < -32 || cx > COLS * TILE + 32 || cy > ROWS * TILE + 32) {
        this._killPlayer();
      }

      // Lasers
      if (this.player.alive) {
        for (const l of this.lasers) {
          if (l.active && this._segmentHitsRect(l, this.player)) {
            this._killPlayer();
            break;
          }
        }
      }

      if (!this.player.alive && this.state === "play") {
        // Player died inside its own update (spike). Sync game state.
        this._killPlayer();
      }
    } else if (this.state === "dead") {
      this.deathT += dtRaw; // restart timer uses real time
      if (this.deathT > 0.85) this.restart();
    } else if (this.state === "win") {
      this.winT += dtRaw;
    }

    // Particles — pooled. Dead slots (age >= life) stay in place so
    // _spawnParticle can reuse them without allocating.
    for (const p of this.particles) {
      if (p.age >= p.life) continue;
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Per-particle gravity (used by confetti). 0 for normal sparks.
      if (p.gy) p.vy += p.gy * dt;
      // Drag: shards drag less so they fly farther
      if (p.kind === "shard") {
        p.vx *= 0.985;
        p.vy *= 0.985;
        p.rot += (p.vrot || 0) * dt;
      } else {
        p.vx *= 0.96;
        p.vy *= 0.96;
      }
    }
    // Trim a contiguous tail of dead slots once the pool grows large to
    // bound memory; we never shrink mid-array (would invalidate slots).
    if (this.particles.length > 120) {
      while (this.particles.length > 80) {
        const last = this.particles[this.particles.length - 1];
        if (last.age >= last.life) this.particles.pop(); else break;
      }
    }

    for (const f of this.flipFx) f.t += dt;
    this.flipFx = this.flipFx.filter(f => f.t < f.max);
  }

  _drainPlayerEvents() {
    const evts = this.player.events;
    if (evts.length === 0) return;
    const haptic = (pattern) => this.engine.input.vibrate(pattern);
    for (const e of evts) {
      if (e.type === "land") {
        this.audio.land();
        const mag = Math.min(8, (e.speed - 380) / 60);
        this._shake(mag, 0.18);
        if (mag > 4) haptic(15);
      } else if (e.type === "bounce") {
        this.audio.bounce();
        this._shake(3, 0.12);
        haptic(20);
      } else if (e.type === "glass") {
        this.audio.click();
        this._shake(4, 0.15);
        haptic(25);
        const px = e.gx * TILE + TILE / 2;
        const py = e.gy * TILE + TILE / 2;
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 100 + Math.random() * 220;
          this._spawnParticle(px, py, Math.cos(a) * sp, Math.sin(a) * sp,
                              0.4 + Math.random() * 0.3, "#5cf2ff");
        }
      } else if (e.type === "die") {
        this._shake(7, 0.35);
        haptic([60, 30, 60]);
      } else if (e.type === "flip") {
        this.audio.flip();
        this._spawnFlipFx();
        this._updateBgRotTarget();
        haptic(8);
      }
    }
    evts.length = 0;
  }

  _updatePlatesAndDoors() {
    const lvl = this.level;
    if (!lvl) return;
    const plateActive = (gx, gy) => {
      const p = this.player;
      const px = p.x + p.w / 2, py = p.y + p.h / 2;
      if (Math.floor(px / TILE) === gx && Math.floor((py + 6) / TILE) === gy) return true;
      for (const o of this.dynObjs) {
        const ox = o.x + o.w / 2, oy = o.y + o.h / 2;
        if (Math.floor(ox / TILE) === gx && Math.floor((oy + 4) / TILE) === gy) return true;
      }
      return false;
    };
    let activePlates = 0, totalPlates = 0;
    const prevActive = this._activePlates || new Set();
    this._activePlates = new Set();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        if (lvl.baseGrid[i] === T.PLATE) {
          totalPlates++;
          if (plateActive(x, y)) {
            activePlates++;
            this._activePlates.add(i);
            // Edge-trigger: plate JUST pressed → magenta pop FX + click SFX
            if (!prevActive.has(i)) {
              const cx = x * TILE + TILE / 2;
              const cy = y * TILE + TILE / 2;
              for (let n = 0; n < 10; n++) {
                const a = Math.random() * Math.PI - Math.PI; // upward fan
                const sp = 90 + Math.random() * 110;
                this._spawnParticle(cx, cy - 4, Math.cos(a) * sp, Math.sin(a) * sp,
                                    0.4 + Math.random() * 0.3, "#ff8aff");
              }
              this.audio.click();
            }
          }
        }
      }
    }
    const open = totalPlates > 0 && activePlates >= totalPlates;
    this.doorAnimTarget = open ? 1 : 0;
    // Collision: solid until the door is mostly open.
    const collidable = this.doorAnim < 0.55;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        if (lvl.baseGrid[i] === T.DOOR) {
          lvl.grid[i] = collidable ? T.DOOR : T.EMPTY;
        }
      }
    }
  }

  _updateDynObjs(dt) {
    const lvl = this.level;
    const ACCEL = 2100;        // match player accel
    const MAX_FALL = 760;
    for (const o of this.dynObjs) {
      // Desync delay
      if (o.pendingGravity && o.desyncTimer > 0) {
        o.desyncTimer -= dt;
        if (o.desyncTimer <= 0) {
          o.gravity = o.pendingGravity;
          o.pendingGravity = null;
        }
      }
      const g = lvl.gravityAt(o.x + o.w / 2, o.y + o.h / 2, o.gravity);
      const w = o.props.weight || 1;

      // Heavier objects fall slower and accelerate slower.
      const wScale = 1 / w;
      o.vx += g.x * ACCEL * dt * wScale;
      o.vy += g.y * ACCEL * dt * wScale;
      const cap = MAX_FALL * wScale;
      if (o.vx > cap) o.vx = cap;
      if (o.vx < -cap) o.vx = -cap;
      if (o.vy > cap) o.vy = cap;
      if (o.vy < -cap) o.vy = -cap;

      this._moveDyn(o, o.vx * dt, 0);
      this._moveDyn(o, 0, o.vy * dt);

      // Surface effects on dyn objects: conveyors push them too.
      const grounded = this._dynGrounded(o, g);
      if (grounded) {
        let footX = o.x + o.w / 2, footY = o.y + o.h / 2;
        if (g.y > 0) footY = o.y + o.h + 1;
        else if (g.y < 0) footY = o.y - 1;
        else if (g.x > 0) footX = o.x + o.w + 1;
        else if (g.x < 0) footX = o.x - 1;
        const tile = lvl.getTile(Math.floor(footX / TILE), Math.floor(footY / TILE));
        if (tile === T.CONVEYOR_R) {
          const target = 200 / w;
          o.vx += (target - o.vx) * Math.min(1, dt * 6);
        } else if (tile === T.CONVEYOR_L) {
          const target = -200 / w;
          o.vx += (target - o.vx) * Math.min(1, dt * 6);
        } else if (tile === T.BOUNCE) {
          // Bounce dyn objs too
          if (g.y > 0)      { o.vy = -700; this.audio.bounce(); }
          else if (g.y < 0) { o.vy =  700; this.audio.bounce(); }
          else if (g.x > 0) { o.vx = -700; this.audio.bounce(); }
          else if (g.x < 0) { o.vx =  700; this.audio.bounce(); }
        } else if (tile === T.ICE) {
          // no friction
        } else {
          // Light friction on perpendicular axis so crates don't drift forever.
          if (g.y !== 0) o.vx *= 1 - Math.min(1, dt * 8);
          else o.vy *= 1 - Math.min(1, dt * 8);
        }
      } else {
        // Air drag
        if (g.y !== 0) o.vx *= 1 - Math.min(1, dt * 0.6);
        else o.vy *= 1 - Math.min(1, dt * 0.6);
      }
    }

    // Player vs crate interaction
    for (const o of this.dynObjs) {
      this._resolvePlayerVsObj(o);
    }
  }

  _dynGrounded(o, g) {
    const lvl = this.level;
    let probeX = o.x + o.w / 2, probeY = o.y + o.h / 2;
    if (g.y > 0) probeY = o.y + o.h + 1;
    else if (g.y < 0) probeY = o.y - 1;
    else if (g.x > 0) probeX = o.x + o.w + 1;
    else if (g.x < 0) probeX = o.x - 1;
    return lvl.isSolidAt(Math.floor(probeX / TILE), Math.floor(probeY / TILE));
  }

  _moveDyn(o, dx, dy) {
    const lvl = this.level;
    const max = Math.max(Math.abs(dx), Math.abs(dy));
    const steps = Math.max(1, Math.ceil(max / 6));
    const sx = dx / steps, sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      // X
      let nx = o.x + sx;
      if (this._objCollides(o, nx, o.y)) {
        if (sx > 0) nx = Math.floor((nx + o.w) / TILE) * TILE - o.w;
        else nx = Math.floor(nx / TILE + 1) * TILE;
        if (sx !== 0) o.vx = 0;
      }
      o.x = nx;
      // Y
      let ny = o.y + sy;
      if (this._objCollides(o, o.x, ny)) {
        if (sy > 0) ny = Math.floor((ny + o.h) / TILE) * TILE - o.h;
        else ny = Math.floor(ny / TILE + 1) * TILE;
        if (sy !== 0) o.vy = 0;
      }
      o.y = ny;
    }
  }

  _objCollides(o, x, y) {
    const lvl = this.level;
    const x0 = Math.floor(x / TILE);
    const x1 = Math.floor((x + o.w - 0.001) / TILE);
    const y0 = Math.floor(y / TILE);
    const y1 = Math.floor((y + o.h - 0.001) / TILE);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        if (lvl.isSolidAt(gx, gy)) return true;
      }
    }
    // Also: collide with other dyn objs
    for (const other of this.dynObjs) {
      if (other === o) continue;
      if (x < other.x + other.w && x + o.w > other.x &&
          y < other.y + other.h && y + o.h > other.y) {
        return true;
      }
    }
    return false;
  }

  _resolvePlayerVsObj(o) {
    const p = this.player;
    if (!(p.x < o.x + o.w && p.x + p.w > o.x &&
          p.y < o.y + o.h && p.y + p.h > o.y)) return;

    // Find smallest-axis overlap for clean separation.
    const overlapL = (p.x + p.w) - o.x;
    const overlapR = (o.x + o.w) - p.x;
    const overlapT = (p.y + p.h) - o.y;
    const overlapB = (o.y + o.h) - p.y;
    const minH = Math.min(overlapL, overlapR);
    const minV = Math.min(overlapT, overlapB);
    const eg = p.effGravity || p.gravity;
    const w = o.props.weight || 1;

    // Pre-bias toward the gravity axis: if the player is "on top" of the
    // crate (in their gravity sense), prefer vertical resolution.
    const gravAxisIsY = eg.y !== 0;
    const preferVertical = gravAxisIsY ? minV <= minH * 1.4 : minV * 1.4 < minH;

    if (preferVertical) {
      // Resolve on Y axis
      if (overlapT < overlapB) {
        // Player's bottom is colliding with crate's top → land on crate
        p.y = o.y - p.h;
        if (eg.y > 0) p.grounded = true;
        if (p.vy > 0) {
          // Transfer some velocity to crate (only if crate can move)
          const transfer = Math.min(p.vy, 220 / w);
          o.vy = Math.max(o.vy, transfer * 0.5);
          p.vy = 0;
        }
      } else {
        p.y = o.y + o.h;
        if (eg.y < 0) p.grounded = true;
        if (p.vy < 0) {
          const transfer = Math.max(p.vy, -220 / w);
          o.vy = Math.min(o.vy, transfer * 0.5);
          p.vy = 0;
        }
      }
    } else {
      // Resolve on X axis (push the crate)
      const dir = overlapL < overlapR ? 1 : -1; // +1: player on left side, push right
      const speedCap = 220 / w;
      const desired = Math.sign(p.vx) === dir ? Math.min(Math.abs(p.vx), speedCap) * dir : 0;
      // Try to move the crate by a tiny step in the player's direction.
      const before = o.x;
      this._moveDyn(o, dir * Math.min(Math.abs(p.vx) * 0.016, 4), 0);
      const moved = o.x - before;
      if (Math.abs(moved) < 0.5) {
        // Crate didn't move (wall behind it) — stop the player
        if (dir > 0) p.x = o.x - p.w; else p.x = o.x + o.w;
        if (Math.sign(p.vx) === dir) p.vx = 0;
      } else {
        // Crate moved — keep player flush with crate
        if (dir > 0) p.x = o.x - p.w; else p.x = o.x + o.w;
        // Boost crate vel toward desired so it carries momentum
        if (Math.abs(o.vx) < Math.abs(desired)) o.vx = desired;
      }
    }
  }

  _segmentHitsRect(seg, rect) {
    // seg: {x1,y1,x2,y2}; rect: {x,y,w,h}
    return segIntersectRect(seg.x1, seg.y1, seg.x2, seg.y2, rect.x, rect.y, rect.w, rect.h);
  }

  // ----------------- RENDER -----------------
  render(ctx) {
    if (this.state === "menu") {
      this._renderBackground(ctx);
      this._renderVignette(ctx);
      return;
    }
    // Camera shake offset
    let sx = 0, sy = 0;
    if (this.shakeT > 0 && this.shakeMag > 0) {
      const k = this.shakeMag * (this.shakeT / 0.35);
      sx = (Math.random() * 2 - 1) * k;
      sy = (Math.random() * 2 - 1) * k;
    }
    // Subtle camera zoom-in on flip — scales up briefly while flipFlash > 0
    // and eases back. Adds a punchy, cinematic emphasis to each input.
    const flashK = this.player ? this.player.flipFlash / 0.18 : 0;
    const zoom = 1 + Math.max(0, flashK) * 0.04;

    this._renderBackground(ctx);

    const W = this.engine.width, H = this.engine.height;
    ctx.save();
    // Anchor zoom around the player when one exists — feels more dramatic
    // because the player stays centered in their personal frame.
    let ax = W / 2, ay = H / 2;
    if (this.player && this.player.alive) {
      ax = this.player.x + this.player.w / 2;
      ay = this.player.y + this.player.h / 2;
    }
    ctx.translate(ax, ay);
    ctx.scale(zoom, zoom);
    ctx.translate(-ax + sx, -ay + sy);
    this._renderLevel(ctx);
    this._renderObjects(ctx);
    this._renderSparks(ctx);
    this._renderLasers(ctx);
    this._renderPlayer(ctx);
    this._renderParticles(ctx);
    this._renderFlipFx(ctx);
    ctx.restore();

    this._renderVignette(ctx);
    if (this.state !== "menu") this._renderScanlines(ctx);
    this._renderFlash(ctx);
    if (this.state === "dead") this._renderDeathOverlay(ctx);
    if (this.state === "win") this._renderWinOverlay(ctx);
    if (this.slow) this._renderSlowmoVignette(ctx);
  }

  _renderSlowmoVignette(ctx) {
    const W = this.engine.width, H = this.engine.height;
    const grad = ctx.createRadialGradient(W/2, H/2, Math.min(W,H)*0.18, W/2, H/2, Math.max(W,H)*0.7);
    grad.addColorStop(0, "rgba(92,242,255,0)");
    grad.addColorStop(0.7, "rgba(92,242,255,0.06)");
    grad.addColorStop(1, "rgba(92,242,255,0.22)");
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // chromatic edge: thin cyan border ramp
    ctx.strokeStyle = "rgba(92,242,255,0.35)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
    ctx.restore();
  }

  _renderVignette(ctx) {
    const W = this.engine.width, H = this.engine.height;
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.max(W, H) * 0.85);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  _renderScanlines(ctx) {
    const W = this.engine.width, H = this.engine.height;
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = "#000";
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    ctx.restore();
  }

  _renderSparks(ctx) {
    if (!this.sparks.length) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of this.sparks) {
      const a = 1 - s.t / s.life;
      ctx.fillStyle = `rgba(255,180,140,${a})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Each world gets its own background palette so they feel different.
  // Returns three gradient stops (bg0..bg2) plus three additive glow-blob
  // colors as "r,g,b" strings.
  _worldPalette() {
    const w = this.def ? this.def.world : 1;
    switch (w) {
      case 2: // Timing — warm orange/red urgency
        return { bg0: "#1a0d10", bg1: "#0e0710", bg2: "#040206",
                 glowA: "255,140,80", glowB: "255,90,140", glowC: "180,90,255" };
      case 3: // Objects — green industrial
        return { bg0: "#0b1a14", bg1: "#06110d", bg2: "#020806",
                 glowA: "120,255,170", glowB: "92,242,255", glowC: "200,200,120" };
      case 4: // Desync — deep violet, off-kilter
        return { bg0: "#160c2a", bg1: "#0a0518", bg2: "#03020a",
                 glowA: "180,100,255", glowB: "92,242,255", glowC: "255,92,242" };
      case 5: // Chaos — yellow / amber
        return { bg0: "#1a1505", bg1: "#0f0c04", bg2: "#040302",
                 glowA: "255,210,100", glowB: "255,140,80", glowC: "92,242,255" };
      case 6: // Multi-Zone — mixed rainbow
        return { bg0: "#0e0c25", bg1: "#080518", bg2: "#02020a",
                 glowA: "92,242,255", glowB: "255,92,242", glowC: "255,210,100" };
      case 1: default: // Basics — classic cyan lab
        return { bg0: "#0b0f24", bg1: "#070a18", bg2: "#03050d",
                 glowA: "92,242,255", glowB: "255,92,242", glowC: "120,160,255" };
    }
  }

  _renderBackground(ctx) {
    const W = this.engine.width, H = this.engine.height;
    const palette = this._worldPalette();

    // Base gradient (does not rotate — feels stable). Tinted per world.
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, palette.bg0);
    grad.addColorStop(0.55, palette.bg1);
    grad.addColorStop(1, palette.bg2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Layer 1: drifting glow blobs (additive, world-tinted)
    const t = this.t || 0;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const blobs = [
      { cx: W * 0.20, cy: H * 0.30, r: H * 0.55, hue: palette.glowA, base: 0.10, drift: 1.0 },
      { cx: W * 0.80, cy: H * 0.75, r: H * 0.55, hue: palette.glowB, base: 0.08, drift: 1.4 },
      { cx: W * 0.50, cy: H * 0.50, r: H * 0.40, hue: palette.glowC, base: 0.06, drift: 0.7 },
    ];
    for (const b of blobs) {
      const ox = Math.cos(t * 0.15 * b.drift) * 30;
      const oy = Math.sin(t * 0.12 * b.drift) * 22;
      const cx = b.cx + ox, cy = b.cy + oy;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, b.r);
      g.addColorStop(0, `rgba(${b.hue},${b.base})`);
      g.addColorStop(1, `rgba(${b.hue},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - b.r, cy - b.r, b.r * 2, b.r * 2);
    }
    ctx.restore();

    // Layer 2: rotating subtle grid (rotates with gravity for the world-flip vibe)
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((this.bgRot * Math.PI) / 180);
    ctx.translate(-W / 2, -H / 2);
    ctx.strokeStyle = "rgba(92,242,255,0.045)";
    ctx.lineWidth = 1;
    const step = 32;
    for (let x = -W; x < W * 2; x += step) {
      ctx.beginPath(); ctx.moveTo(x, -H); ctx.lineTo(x, H * 2); ctx.stroke();
    }
    for (let y = -H; y < H * 2; y += step) {
      ctx.beginPath(); ctx.moveTo(-W, y); ctx.lineTo(W * 2, y); ctx.stroke();
    }
    // Brighter grid lines every 8 cells (lab corridor vibe)
    ctx.strokeStyle = "rgba(92,242,255,0.10)";
    for (let x = -W; x < W * 2; x += step * 8) {
      ctx.beginPath(); ctx.moveTo(x, -H); ctx.lineTo(x, H * 2); ctx.stroke();
    }
    for (let y = -H; y < H * 2; y += step * 8) {
      ctx.beginPath(); ctx.moveTo(-W, y); ctx.lineTo(W * 2, y); ctx.stroke();
    }
    ctx.restore();

    // Layer 3: ambient drifting motes (atmospheric depth particles)
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const m of this.ambient) {
      m.x += Math.cos(m.phase + t * 0.4) * 0.25 * m.z;
      m.y += Math.sin(m.phase + t * 0.5) * 0.18 * m.z;
      if (m.x < -10) m.x = W + 10;
      else if (m.x > W + 10) m.x = -10;
      if (m.y < -10) m.y = H + 10;
      else if (m.y > H + 10) m.y = -10;
      const pulse = 0.5 + 0.5 * Math.sin(m.phase + t * 1.4);
      const a = (0.20 + 0.25 * pulse) * m.z;
      const r = m.size * (1 + pulse * 0.6) * m.z;
      const rgb = m.hue === "#5cf2ff" ? "92,242,255" : "255,92,242";
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, r * 4);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(0.4, `rgba(${rgb},${a * 0.4})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(m.x - r * 4, m.y - r * 4, r * 8, r * 8);
    }
    ctx.restore();
  }

  _renderLevel(ctx) {
    const lvl = this.level;
    if (!lvl) return;

    // Pass 1: shadow drop for solid walls (subtle depth offset, additive-dim).
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = lvl.getTile(x, y);
        if (t === T.SOLID) ctx.fillRect(x * TILE + 2, y * TILE + 4, TILE, TILE);
      }
    }
    ctx.restore();

    // Pass 2: actual tiles, neighbor-aware
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const tile = lvl.getTile(x, y);
        if (tile === T.EMPTY) continue;
        drawTile(ctx, lvl, x, y, this.t, this);
      }
    }

    // Pass 3: rim-lighting on exposed solid edges (additive cyan whisper).
    this._renderWallRimGlow(ctx);

    // Gravity zone outlines (drawn over tiles, dashed)
    if (lvl.gravityZones) {
      for (const z of lvl.gravityZones) {
        ctx.save();
        ctx.fillStyle = "rgba(255,92,242,0.05)";
        ctx.fillRect(z.x * TILE, z.y * TILE, z.w * TILE, z.h * TILE);
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -this.t * 8;
        ctx.strokeStyle = "rgba(255,92,242,0.45)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(z.x * TILE, z.y * TILE, z.w * TILE, z.h * TILE);
        const cx = (z.x + z.w / 2) * TILE;
        const cy = (z.y + z.h / 2) * TILE;
        drawArrow(ctx, cx, cy, z.dir, "rgba(255,92,242,0.55)");
        ctx.restore();
      }
    }
  }

  // Rim-light: thin additive cyan lines just outside each solid edge that
  // faces empty space, as if reflecting the ambient lab glow. Cheap because
  // we batch all draws per layer and avoid creating gradients.
  _renderWallRimGlow(ctx) {
    const lvl = this.level;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // Inner bright line (1 px, 0.22 alpha)
    ctx.fillStyle = "rgba(92,242,255,0.22)";
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (lvl.getTile(x, y) !== T.SOLID) continue;
        const tx = x * TILE, ty = y * TILE;
        if (lvl.getTile(x, y - 1) !== T.SOLID) ctx.fillRect(tx,            ty - 1,    TILE, 1);
        if (lvl.getTile(x, y + 1) !== T.SOLID) ctx.fillRect(tx,            ty + TILE, TILE, 1);
        if (lvl.getTile(x - 1, y) !== T.SOLID) ctx.fillRect(tx - 1,        ty,        1,    TILE);
        if (lvl.getTile(x + 1, y) !== T.SOLID) ctx.fillRect(tx + TILE,     ty,        1,    TILE);
      }
    }
    // Outer dim line (1 px, 0.10 alpha) — a softer halo
    ctx.fillStyle = "rgba(92,242,255,0.10)";
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (lvl.getTile(x, y) !== T.SOLID) continue;
        const tx = x * TILE, ty = y * TILE;
        if (lvl.getTile(x, y - 1) !== T.SOLID) ctx.fillRect(tx,            ty - 2,    TILE, 1);
        if (lvl.getTile(x, y + 1) !== T.SOLID) ctx.fillRect(tx,            ty + TILE + 1, TILE, 1);
        if (lvl.getTile(x - 1, y) !== T.SOLID) ctx.fillRect(tx - 2,        ty,        1,    TILE);
        if (lvl.getTile(x + 1, y) !== T.SOLID) ctx.fillRect(tx + TILE + 1, ty,        1,    TILE);
      }
    }
    ctx.restore();
  }

  _renderObjects(ctx) {
    for (const o of this.dynObjs) {
      // Drop shadow
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(o.x + 2, o.y + 4, o.w, o.h);
      ctx.restore();

      ctx.save();
      if (o.kind === "crate") {
        const heavy = (o.props.weight || 1) > 1;
        const fill1   = heavy ? "#5d3f1f" : "#8a5a2a";
        const fill2   = heavy ? "#3a2614" : "#5b3a1c";
        const trim    = heavy ? "#d4a25a" : "#e8c481";
        const accent  = heavy ? "#ffb24a" : "#ffd884";

        // Body gradient
        const grad = ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h);
        grad.addColorStop(0, fill1);
        grad.addColorStop(1, fill2);
        ctx.fillStyle = grad;
        roundRect(ctx, o.x, o.y, o.w, o.h, 3);
        ctx.fill();

        // Plank groove (horizontal)
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(o.x + 2, o.y + o.h / 2);
        ctx.lineTo(o.x + o.w - 2, o.y + o.h / 2);
        ctx.stroke();

        // Trim
        ctx.strokeStyle = trim;
        ctx.lineWidth = 1.5;
        roundRect(ctx, o.x + 1.5, o.y + 1.5, o.w - 3, o.h - 3, 2.5);
        ctx.stroke();

        // Corner rivets
        ctx.fillStyle = accent;
        const r = 1.5;
        for (const [px, py] of [[o.x+4, o.y+4],[o.x+o.w-4, o.y+4],[o.x+4, o.y+o.h-4],[o.x+o.w-4, o.y+o.h-4]]) {
          ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
        }

        // Heavy chevron glyph
        if (heavy) {
          ctx.strokeStyle = accent;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(o.x + 8, o.y + o.h/2 + 4); ctx.lineTo(o.x + o.w/2, o.y + o.h/2 - 2); ctx.lineTo(o.x + o.w - 8, o.y + o.h/2 + 4);
          ctx.stroke();
        }
      } else if (o.kind === "sphere") {
        const cx = o.x + o.w / 2, cy = o.y + o.h / 2, r = o.w / 2 - 1;
        // Glow halo
        ctx.globalCompositeOperation = "lighter";
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.5);
        glow.addColorStop(0, "rgba(92,242,255,0.6)");
        glow.addColorStop(1, "rgba(92,242,255,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);
        ctx.globalCompositeOperation = "source-over";
        // Body gradient
        const body = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.1, cx, cy, r);
        body.addColorStop(0, "#d6f9ff");
        body.addColorStop(0.6, "#5cf2ff");
        body.addColorStop(1, "#1a8aa8");
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        // Highlight
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        ctx.beginPath();
        ctx.arc(cx - r * 0.35, cy - r * 0.4, r * 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _renderLasers(ctx) {
    const t = this.t;
    for (const l of this.lasers) {
      const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
      const nx = (l.x2 - l.x1) / len, ny = (l.y2 - l.y1) / len;

      // Source/end emitter discs (always visible, even when laser off)
      this._drawEmitter(ctx, l.x1, l.y1, !!l.active);
      this._drawEmitter(ctx, l.x2, l.y2, !!l.active);

      if (!l.active) {
        // Idle: dashed thin guide
        ctx.save();
        ctx.strokeStyle = "rgba(255,92,107,0.18)";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 6]);
        ctx.lineDashOffset = -t * 24;
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      // Active beam: thick glow + bright core + animated stripes + pulse
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      // Glow pass
      ctx.strokeStyle = "rgba(255,92,107,0.55)";
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
      // Mid pass
      ctx.strokeStyle = "rgba(255,140,150,0.85)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
      // Animated diagonal stripes inside the beam (energy flow). Each stripe
      // is a short perpendicular tick that slides along the beam over time.
      const px2 = -ny, py2 = nx; // perpendicular unit
      const stripeSpacing = 14;
      const stripeOffset = (t * 280) % stripeSpacing;
      ctx.strokeStyle = "rgba(255,235,235,0.55)";
      ctx.lineWidth = 1.2;
      for (let s2 = -stripeSpacing; s2 < len; s2 += stripeSpacing) {
        const dist = s2 + stripeOffset;
        if (dist < -2 || dist > len + 2) continue;
        const mx = l.x1 + nx * dist, my = l.y1 + ny * dist;
        ctx.beginPath();
        ctx.moveTo(mx + px2 * 1.6, my + py2 * 1.6);
        ctx.lineTo(mx - px2 * 1.6, my - py2 * 1.6);
        ctx.stroke();
      }
      // Core
      ctx.strokeStyle = "rgba(255,255,255,1)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
      ctx.stroke();

      // Traveling pulse: bright dot moving along beam
      const phase = (t * 380) % (len + 60) - 30;
      const ppx = l.x1 + nx * phase, ppy = l.y1 + ny * phase;
      const grad = ctx.createRadialGradient(ppx, ppy, 0, ppx, ppy, 18);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.4, "rgba(255,180,180,0.7)");
      grad.addColorStop(1, "rgba(255,90,107,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(ppx - 18, ppy - 18, 36, 36);
      ctx.restore();
    }
  }

  _drawEmitter(ctx, x, y, active) {
    ctx.save();
    // Base disc
    ctx.fillStyle = "#251218";
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#5a2a32";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
    // Inner light
    if (active) {
      ctx.globalCompositeOperation = "lighter";
      const grad = ctx.createRadialGradient(x, y, 0, x, y, 14);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.4, "rgba(255,90,107,0.9)");
      grad.addColorStop(1, "rgba(255,90,107,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x - 14, y - 14, 28, 28);
    } else {
      ctx.fillStyle = "#3a1a22";
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  _renderPlayer(ctx) {
    const p = this.player;
    if (!p.alive) return;

    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;

    // Motion trail ghosts: additive cyan smears behind recent positions
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < p.trail.length; i++) {
      const s = p.trail[i];
      const a = (1 - s.t / 0.12) * 0.35 * (i + 1) / p.trail.length;
      ctx.save();
      ctx.translate(s.x + p.w / 2, s.y + p.h / 2);
      ctx.rotate((s.rot * Math.PI) / 180);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#5cf2ff";
      roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, 5);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // Squash/stretch on impact, plus a subtle idle breathing pulse so the
    // player never feels static. Breathing fades out while squash is active.
    let sx = 1, sy = 1;
    if (p.squashT > 0) {
      const k = p.squashT / 0.13;
      const stretch = 1 + 0.30 * k;
      const squash = 1 - 0.22 * k;
      if (p.squashAxis === "y") { sx = stretch; sy = squash; }
      else                       { sx = squash;  sy = stretch; }
    } else {
      const breath = 1 + 0.025 * Math.sin(this.t * 2.5);
      sx *= breath; sy *= breath;
    }

    // Player as a light source: a wide soft cyan glow that "lights up"
    // nearby tiles via additive blending. Render BEFORE the player body so
    // it shines through onto adjacent walls/floor.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const flash = p.flipFlash > 0 ? p.flipFlash / 0.18 : 0;
    // Wide ambient light radius
    const lightR = 96 + flash * 30;
    const light = ctx.createRadialGradient(cx, cy, 0, cx, cy, lightR);
    light.addColorStop(0, `rgba(140,248,255,${0.18 + flash * 0.20})`);
    light.addColorStop(0.35, `rgba(92,242,255,${0.10 + flash * 0.12})`);
    light.addColorStop(1, "rgba(92,242,255,0)");
    ctx.fillStyle = light;
    ctx.fillRect(cx - lightR, cy - lightR, lightR * 2, lightR * 2);
    // Tighter inner glow halo
    const glowR = 28 + flash * 60;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    glow.addColorStop(0, `rgba(180,250,255,${0.45 + flash * 0.4})`);
    glow.addColorStop(0.45, `rgba(92,242,255,${0.22 + flash * 0.22})`);
    glow.addColorStop(1, "rgba(92,242,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(cx - glowR, cy - glowR, glowR * 2, glowR * 2);
    ctx.restore();

    // Body (rounded, gradient, with eyes)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((p.visualRot * Math.PI) / 180);
    ctx.scale(sx, sy);

    // Outer shell (white)
    ctx.fillStyle = "#eaf6ff";
    roundRect(ctx, -p.w / 2, -p.h / 2, p.w, p.h, 5);
    ctx.fill();
    // Inner gradient
    const body = ctx.createLinearGradient(0, -p.h / 2, 0, p.h / 2);
    body.addColorStop(0, "#9efbff");
    body.addColorStop(0.5, "#5cf2ff");
    body.addColorStop(1, "#1a9fcc");
    ctx.fillStyle = body;
    roundRect(ctx, -p.w / 2 + 3, -p.h / 2 + 3, p.w - 6, p.h - 6, 4);
    ctx.fill();
    // Top sheen
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    roundRect(ctx, -p.w / 2 + 4, -p.h / 2 + 4, p.w - 8, 4, 2);
    ctx.fill();
    // Eyes track velocity in the LOCAL frame (the player is rotated to match
    // gravity, so we counter-rotate the world velocity to figure out where
    // they should "look"). Mouth changes shape by state: neutral when idle,
    // shocked "o" on hard impact (squashing), small line when zooming.
    const eyeBaseY = -p.h / 2 + 7;
    const rot = (p.visualRot * Math.PI) / 180;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    // Counter-rotate by -rot: local_vx = world_vx*cos + world_vy*sin
    const localVx = p.vx * cosR + p.vy * sinR;
    const localVy = -p.vx * sinR + p.vy * cosR;
    const speed = Math.hypot(p.vx, p.vy);
    const lookK = Math.min(1, speed / 600);
    const eyeOffX = Math.max(-2, Math.min(2, localVx / 600 * 1.6 * lookK));
    const eyeOffY = Math.max(-1.5, Math.min(1.5, localVy / 600 * 1.2 * lookK));
    const blink = (Math.sin(this.t * 2.0 + p.x * 0.01) > 0.985) ? 0 : 1;
    ctx.fillStyle = "#06080f";
    if (blink) {
      ctx.beginPath(); ctx.arc(-4 + eyeOffX, eyeBaseY + eyeOffY, 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( 4 + eyeOffX, eyeBaseY + eyeOffY, 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(-4.6 + eyeOffX, eyeBaseY - 1.2 + eyeOffY, 1, 1);
      ctx.fillRect( 3.4 + eyeOffX, eyeBaseY - 1.2 + eyeOffY, 1, 1);
    } else {
      ctx.fillRect(-5.5, eyeBaseY - 0.5, 3, 1);
      ctx.fillRect( 2.5, eyeBaseY - 0.5, 3, 1);
    }
    // Mouth — three states:
    //   shocked "o" on hard impact (squashT > 0)
    //   slight smile when calm
    //   tight line when moving fast
    const mouthY = p.h / 2 - 6;
    ctx.fillStyle = "#06080f";
    if (p.squashT > 0.04) {
      // Shocked open mouth
      ctx.beginPath();
      ctx.arc(0, mouthY, 1.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (speed > 460) {
      // Tight line, focused
      ctx.fillRect(-3, mouthY, 6, 0.8);
    } else {
      // Subtle smile arc
      ctx.strokeStyle = "#06080f";
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(0, mouthY - 0.5, 2.4, Math.PI * 0.18, Math.PI - Math.PI * 0.18);
      ctx.stroke();
    }
    ctx.restore();
  }

  _renderParticles(ctx) {
    // Pass 1: dot particles use additive blending for glow.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const pt of this.particles) {
      if (pt.age >= pt.life) continue;
      if (pt.kind === "shard") continue;
      const a = Math.max(0, 1 - pt.age / pt.life);
      const size = 1.6 + a * 2.2;
      const m = pt.color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      let rgb = "92,242,255";
      if (m) rgb = `${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)}`;
      const grad = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, size * 3);
      grad.addColorStop(0, `rgba(${rgb},${a})`);
      grad.addColorStop(0.5, `rgba(${rgb},${a * 0.4})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(pt.x - size * 3, pt.y - size * 3, size * 6, size * 6);
      ctx.fillStyle = `rgba(255,255,255,${a * 0.9})`;
      ctx.fillRect(pt.x - 0.7, pt.y - 0.7, 1.4, 1.4);
    }
    ctx.restore();
    // Pass 2: shard particles (non-additive, rotating colored rectangles).
    for (const pt of this.particles) {
      if (pt.age >= pt.life) continue;
      if (pt.kind !== "shard") continue;
      const a = Math.max(0, 1 - pt.age / pt.life);
      const sz = (pt.size || 7) * (0.7 + 0.3 * a);
      ctx.save();
      ctx.translate(pt.x, pt.y);
      ctx.rotate(pt.rot || 0);
      ctx.globalAlpha = a;
      ctx.fillStyle = pt.color;
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.55);
      // Highlight
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fillRect(-sz / 2, -sz / 2, sz, 1);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  _renderFlipFx(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const f of this.flipFx) {
      const k = f.t / f.max;
      const a = 1 - k;
      // Two stacked rings expanding at different rates
      ctx.strokeStyle = `rgba(140,248,255,${a * 0.85})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 10 + k * 90, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(92,242,255,${a * 0.45})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, 6 + k * 60, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _renderFlash(ctx) {
    if (this.flashT <= 0) return;
    ctx.save();
    ctx.globalAlpha = (this.flashT / 0.18) * 0.18;
    ctx.fillStyle = "#5cf2ff";
    ctx.fillRect(0, 0, this.engine.width, this.engine.height);
    ctx.restore();
  }

  _renderDeathOverlay(ctx) {
    const W = this.engine.width, H = this.engine.height;
    const a = Math.min(0.55, this.deathT * 1.4);
    ctx.save();
    // Red vignette emanating from edges
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.85);
    grad.addColorStop(0, `rgba(255,92,107,${a * 0.2})`);
    grad.addColorStop(1, `rgba(255,40,60,${a})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  // Dev overlay: toggle with backtick. Useful for tuning physics + watching
  // ticks-per-second to verify the fixed-timestep loop is healthy.
  renderDebug(ctx, engine) {
    const p = this.player;
    const W = engine.width;
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(W - 232, 8, 224, 152);
    ctx.fillStyle = "#9efbff";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "top";
    const lines = [
      `FPS  ${engine.fps.toFixed(1)}   TPS ${engine.tps.toFixed(1)}`,
      `tick ${engine.ticks}   frame ${engine.lastFrameMs.toFixed(2)}ms`,
      `state ${this.state}   slow ${this.slow ? "ON" : "off"}`,
      `pos  ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`,
      `vel  ${p.vx.toFixed(1)}, ${p.vy.toFixed(1)}  spd ${Math.hypot(p.vx,p.vy).toFixed(0)}`,
      `grav ${p.gravity.x},${p.gravity.y}  eff ${(p.effGravity||p.gravity).x},${(p.effGravity||p.gravity).y}`,
      `gnd  ${p.grounded}   alive ${p.alive}   cd ${p.flipCooldown.toFixed(2)}`,
      `buf  ${p.bufferDir || "-"}  bufT ${p.bufferT.toFixed(2)}`,
      `ptcl ${this.particles.length}  shake ${this.shakeT.toFixed(2)}`,
      `door ${this.doorAnim.toFixed(2)} -> ${this.doorAnimTarget.toFixed(0)}`,
    ];
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], W - 224, 14 + i * 14);
    }
    ctx.restore();
  }

  _renderWinOverlay(ctx) {
    const W = this.engine.width, H = this.engine.height;
    const a = Math.min(0.45, this.winT * 1.1);
    ctx.save();
    // Gold flash from center
    const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    grad.addColorStop(0, `rgba(255,232,140,${a * 1.0})`);
    grad.addColorStop(0.4, `rgba(255,200,90,${a * 0.5})`);
    grad.addColorStop(1, `rgba(255,200,90,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    // Expanding ring
    ctx.globalCompositeOperation = "lighter";
    const r = this.winT * 600;
    ctx.strokeStyle = `rgba(255,232,160,${Math.max(0, 0.8 - this.winT * 1.2)})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// --- helpers ---

// Rounded-rect path helper (uses native if available)
function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawTile(ctx, lvl, gx, gy, t, game) {
  const s = TILE;
  const x = gx * s, y = gy * s;
  const tile = lvl.getTile(gx, gy);

  switch (tile) {
    case T.SOLID: {
      // Neighbor check for auto-tiling. We treat any solid as a continuous wall.
      const N = lvl.getTile(gx, gy - 1) === T.SOLID;
      const S = lvl.getTile(gx, gy + 1) === T.SOLID;
      const E = lvl.getTile(gx + 1, gy) === T.SOLID;
      const W = lvl.getTile(gx - 1, gy) === T.SOLID;
      // Base fill (subtle vertical gradient so walls don't look flat)
      const grad = ctx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, "#1c2748");
      grad.addColorStop(1, "#121a36");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, s, s);

      // Edge highlights on EXPOSED edges only (where neighbor is empty)
      if (!N) { ctx.fillStyle = "#2e3e72"; ctx.fillRect(x, y, s, 3); }
      if (!W) { ctx.fillStyle = "#2a3a6a"; ctx.fillRect(x, y, 3, s); }
      if (!S) { ctx.fillStyle = "#0a1126"; ctx.fillRect(x, y + s - 3, s, 3); }
      if (!E) { ctx.fillStyle = "#0c1430"; ctx.fillRect(x + s - 3, y, 3, s); }
      // Cross-section seams: only between two SOLIDs, draw a thin darker line
      if (S) { ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(x, y + s - 1, s, 1); }
      if (E) { ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(x + s - 1, y, 1, s); }
      // Subtle dot cluster for texture
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      const dx = (gx * 7 + gy * 11) % 16;
      ctx.fillRect(x + 6 + dx % 12, y + 8 + (dx * 3) % 12, 1, 1);
      ctx.fillRect(x + 12 + (dx * 5) % 10, y + 18 + (dx * 7) % 10, 1, 1);
      break;
    }
    case T.GLASS: {
      // Crystal-blue glass with diagonal sheen
      const grad = ctx.createLinearGradient(x, y, x + s, y + s);
      grad.addColorStop(0, "rgba(92,242,255,0.10)");
      grad.addColorStop(0.5, "rgba(92,242,255,0.25)");
      grad.addColorStop(1, "rgba(92,242,255,0.10)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = "rgba(140,248,255,0.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 4); ctx.lineTo(x + s - 6, y + s - 8);
      ctx.moveTo(x + 8, y + 4); ctx.lineTo(x + s - 10, y + s - 8);
      ctx.stroke();
      break;
    }
    case T.SPIKE_U: drawSpike(ctx, lvl, gx, gy, "up"); break;
    case T.SPIKE_D: drawSpike(ctx, lvl, gx, gy, "down"); break;
    case T.SPIKE_L: drawSpike(ctx, lvl, gx, gy, "left"); break;
    case T.SPIKE_R: drawSpike(ctx, lvl, gx, gy, "right"); break;
    case T.EXIT: {
      // Portal: rotating rings + soft cyan-gold glow + orbiting dots
      const cx = x + s / 2, cy = y + s / 2;
      const pulse = 0.6 + 0.4 * Math.sin(t * 4);
      // Glow halo (additive)
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 32);
      halo.addColorStop(0, `rgba(255,232,140,${0.55 * pulse})`);
      halo.addColorStop(0.5, `rgba(255,200,90,${0.28 * pulse})`);
      halo.addColorStop(1, "rgba(255,200,90,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(cx - 32, cy - 32, 64, 64);
      // Orbiting dots — three at offset phases, drawing a gentle "magnetic
      // field" feel around the portal center.
      for (let i = 0; i < 3; i++) {
        const ang = t * 2.3 + i * (Math.PI * 2 / 3);
        const orbR = 13 + Math.sin(t * 3 + i) * 1.5;
        const ox = cx + Math.cos(ang) * orbR;
        const oy = cy + Math.sin(ang) * orbR;
        const dotGrad = ctx.createRadialGradient(ox, oy, 0, ox, oy, 5);
        dotGrad.addColorStop(0, `rgba(255,250,200,${0.9 * pulse})`);
        dotGrad.addColorStop(1, "rgba(255,212,100,0)");
        ctx.fillStyle = dotGrad;
        ctx.fillRect(ox - 5, oy - 5, 10, 10);
      }
      ctx.restore();
      // Rotating outer ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 1.2);
      ctx.strokeStyle = `rgba(255,212,100,${0.85 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 1.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 11, Math.PI * 1.6, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      // Inner ring (counter-rotating)
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-t * 1.8);
      ctx.strokeStyle = `rgba(255,232,160,${0.95 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 1.7);
      ctx.stroke();
      ctx.restore();
      // Center dot
      ctx.fillStyle = `rgba(255,255,200,${pulse})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case T.PLATE: {
      const i = gy * COLS + gx;
      const pressed = game && game._activePlates && game._activePlates.has(i);
      // Base
      ctx.fillStyle = "#1c1428";
      ctx.fillRect(x, y + s - 8, s, 8);
      // Plate top (lower when pressed)
      const plateY = pressed ? y + s - 5 : y + s - 9;
      const grad = ctx.createLinearGradient(x, plateY, x, plateY + 5);
      grad.addColorStop(0, pressed ? "#ff7cff" : "#ff5cf2");
      grad.addColorStop(1, pressed ? "#a82eb0" : "#c733c8");
      ctx.fillStyle = grad;
      roundRect(ctx, x + 3, plateY, s - 6, 5, 1.5);
      ctx.fill();
      // Glow when pressed
      if (pressed) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const halo = ctx.createRadialGradient(x + s/2, plateY + 2, 0, x + s/2, plateY + 2, 22);
        halo.addColorStop(0, "rgba(255,140,255,0.6)");
        halo.addColorStop(1, "rgba(255,92,242,0)");
        ctx.fillStyle = halo;
        ctx.fillRect(x - 8, plateY - 12, s + 16, 28);
        ctx.restore();
      }
      // Side rivets
      ctx.fillStyle = "#5e3a64";
      ctx.fillRect(x + 1, y + s - 7, 2, 6);
      ctx.fillRect(x + s - 3, y + s - 7, 2, 6);
      break;
    }
    case T.DOOR: {
      // Sliding door driven by game.doorAnim (0=closed, 1=open)
      const k = game ? Math.max(0, Math.min(1, game.doorAnim)) : 0;
      const slide = k * (s / 2 - 2); // each half slides outward by `slide`
      // Frame
      ctx.fillStyle = "#0c1024";
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = "#2a3458";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      // Two halves (top & bottom) slide apart
      const halfH = (s / 2) - slide;
      if (halfH > 0) {
        const grad1 = ctx.createLinearGradient(x, y, x, y + halfH);
        grad1.addColorStop(0, "#46568a");
        grad1.addColorStop(1, "#2c3a64");
        ctx.fillStyle = grad1;
        ctx.fillRect(x + 2, y, s - 4, halfH);
        const grad2 = ctx.createLinearGradient(x, y + s - halfH, x, y + s);
        grad2.addColorStop(0, "#2c3a64");
        grad2.addColorStop(1, "#46568a");
        ctx.fillStyle = grad2;
        ctx.fillRect(x + 2, y + s - halfH, s - 4, halfH);
        // Stripes
        ctx.fillStyle = "#1a2240";
        for (let i = 0; i < 2; i++) {
          if (halfH > 6) ctx.fillRect(x + 6, y + 4 + i * 8, s - 12, 3);
          if (halfH > 6) ctx.fillRect(x + 6, y + s - halfH + (halfH - 7) - i * 8, s - 12, 3);
        }
      }
      // Status light along the seam
      const seamY = y + s / 2;
      ctx.fillStyle = `rgba(${k > 0.5 ? "92,242,140" : "255,150,90"},0.9)`;
      ctx.fillRect(x + s / 2 - 2, seamY - 0.5, 4, 1);
      break;
    }
    case T.CONVEYOR_R:
    case T.CONVEYOR_L: {
      // Belt body
      const grad = ctx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, "#2a3247");
      grad.addColorStop(0.5, "#1d2434");
      grad.addColorStop(1, "#2a3247");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, s, s);
      // Roller bumps top/bottom
      ctx.fillStyle = "#3e4a68";
      ctx.fillRect(x, y, s, 5);
      ctx.fillRect(x, y + s - 5, s, 5);
      ctx.fillStyle = "#1a2030";
      ctx.fillRect(x, y + 4, s, 1);
      ctx.fillRect(x, y + s - 5, s, 1);
      // Animated cyan chevrons
      const dir = tile === T.CONVEYOR_R ? 1 : -1;
      const off = (t * 90 * dir) % 16;
      ctx.fillStyle = "#5cf2ff";
      ctx.shadowColor = "#5cf2ff";
      ctx.shadowBlur = 4;
      for (let i = -16; i < s; i += 14) {
        const xx = x + ((i + off + 32) % 32);
        ctx.beginPath();
        if (dir > 0) {
          ctx.moveTo(xx, y + s / 2 - 5);
          ctx.lineTo(xx + 7, y + s / 2);
          ctx.lineTo(xx, y + s / 2 + 5);
          ctx.lineTo(xx + 2, y + s / 2);
        } else {
          ctx.moveTo(xx + 7, y + s / 2 - 5);
          ctx.lineTo(xx, y + s / 2);
          ctx.lineTo(xx + 7, y + s / 2 + 5);
          ctx.lineTo(xx + 5, y + s / 2);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      break;
    }
    case T.BOUNCE: {
      // Spring-pad: dark base + glowing cyan top bar with springs visible
      ctx.fillStyle = "#10162e";
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = "#2a3458";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      // Springs (zigzags)
      ctx.strokeStyle = "#6e7da0";
      ctx.lineWidth = 1.3;
      for (let i = 0; i < 3; i++) {
        const sx = x + 6 + i * 8;
        ctx.beginPath();
        ctx.moveTo(sx, y + s - 4);
        ctx.lineTo(sx + 4, y + s - 8);
        ctx.lineTo(sx, y + s - 12);
        ctx.lineTo(sx + 4, y + s - 16);
        ctx.stroke();
      }
      // Top bar (animated pulse)
      const bp = 0.7 + 0.3 * Math.sin(t * 6);
      const grad = ctx.createLinearGradient(x, y, x, y + 12);
      grad.addColorStop(0, `rgba(180,250,255,${bp})`);
      grad.addColorStop(1, `rgba(92,242,255,${bp})`);
      ctx.fillStyle = grad;
      roundRect(ctx, x + 2, y + 2, s - 4, 9, 2);
      ctx.fill();
      // Bar glow
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const halo = ctx.createLinearGradient(x, y, x, y + 16);
      halo.addColorStop(0, "rgba(92,242,255,0.5)");
      halo.addColorStop(1, "rgba(92,242,255,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(x, y, s, 16);
      ctx.restore();
      break;
    }
    case T.STICKY: {
      // Honey/amber dotted surface
      const grad = ctx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, "#5a3a1c");
      grad.addColorStop(1, "#3a2410");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "#cf9244";
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.arc(x + 6 + i * 6, y + 8, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + 9 + i * 6, y + 20, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case T.ICE: {
      // Frosted blue with crystal lines
      const grad = ctx.createLinearGradient(x, y, x, y + s);
      grad.addColorStop(0, "#1d4a72");
      grad.addColorStop(1, "#0e2640");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x, y, s, 3);
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(x, y + s - 2, s, 2);
      ctx.strokeStyle = "rgba(180,230,255,0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 4,  y + 6);  ctx.lineTo(x + 12, y + 18);
      ctx.moveTo(x + 18, y + 4);  ctx.lineTo(x + 26, y + 14);
      ctx.moveTo(x + 6,  y + 22); ctx.lineTo(x + 14, y + 28);
      ctx.stroke();
      // Sparkles
      const sp = (Math.sin(t * 3 + gx + gy) + 1) * 0.5;
      ctx.fillStyle = `rgba(255,255,255,${sp * 0.5})`;
      ctx.fillRect(x + 22, y + 22, 1.5, 1.5);
      ctx.fillRect(x + 8,  y + 12, 1, 1);
      break;
    }
  }
}

function drawSpike(ctx, lvl, gx, gy, dir) {
  const s = TILE;
  const x = gx * s, y = gy * s;
  // Base pad behind spikes (helps spikes feel "mounted")
  ctx.fillStyle = "#13192d";
  if (dir === "up") ctx.fillRect(x, y + s - 6, s, 6);
  else if (dir === "down") ctx.fillRect(x, y, s, 6);
  else if (dir === "left") ctx.fillRect(x + s - 6, y, 6, s);
  else if (dir === "right") ctx.fillRect(x, y, 6, s);
  // Mounting bolts on the base pad — two small darker dots so the spikes
  // read as installed hardware, not floating triangles.
  ctx.fillStyle = "#070a16";
  if (dir === "up") {
    ctx.fillRect(x + 4,     y + s - 3, 1.5, 1.5);
    ctx.fillRect(x + s - 6, y + s - 3, 1.5, 1.5);
  } else if (dir === "down") {
    ctx.fillRect(x + 4,     y + 1.5,   1.5, 1.5);
    ctx.fillRect(x + s - 6, y + 1.5,   1.5, 1.5);
  } else if (dir === "left") {
    ctx.fillRect(x + s - 3, y + 4,     1.5, 1.5);
    ctx.fillRect(x + s - 3, y + s - 6, 1.5, 1.5);
  } else if (dir === "right") {
    ctx.fillRect(x + 1.5,   y + 4,     1.5, 1.5);
    ctx.fillRect(x + 1.5,   y + s - 6, 1.5, 1.5);
  }

  const N = 4;
  for (let i = 0; i < N; i++) {
    let xs, ys, tipX, tipY, baseAX, baseAY, baseBX, baseBY;
    if (dir === "up") {
      xs = x + (i * s) / N;
      baseAX = xs;            baseAY = y + s;
      baseBX = xs + s / N;    baseBY = y + s;
      tipX  = xs + s / N / 2; tipY  = y + 3;
    } else if (dir === "down") {
      xs = x + (i * s) / N;
      baseAX = xs;            baseAY = y;
      baseBX = xs + s / N;    baseBY = y;
      tipX  = xs + s / N / 2; tipY  = y + s - 3;
    } else if (dir === "left") {
      ys = y + (i * s) / N;
      baseAX = x + s;         baseAY = ys;
      baseBX = x + s;         baseBY = ys + s / N;
      tipX  = x + 3;          tipY  = ys + s / N / 2;
    } else {
      ys = y + (i * s) / N;
      baseAX = x;             baseAY = ys;
      baseBX = x;             baseBY = ys + s / N;
      tipX  = x + s - 3;      tipY  = ys + s / N / 2;
    }
    // Gradient fill: bright tip, dim base
    const grad = ctx.createLinearGradient(baseAX, baseAY, tipX, tipY);
    grad.addColorStop(0, "#7c8aaa");
    grad.addColorStop(0.6, "#cdd9f0");
    grad.addColorStop(1, "#ffffff");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(baseAX, baseAY);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(baseBX, baseBY);
    ctx.closePath();
    ctx.fill();
    // Edge stroke
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
}

function drawArrow(ctx, cx, cy, dir, color) {
  ctx.save();
  ctx.translate(cx, cy);
  let rot = 0;
  if (dir.x === 1) rot = 0;
  else if (dir.x === -1) rot = Math.PI;
  else if (dir.y === 1) rot = Math.PI / 2;
  else if (dir.y === -1) rot = -Math.PI / 2;
  ctx.rotate(rot);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-14, -8);
  ctx.lineTo(8, -8);
  ctx.lineTo(8, -14);
  ctx.lineTo(20, 0);
  ctx.lineTo(8, 14);
  ctx.lineTo(8, 8);
  ctx.lineTo(-14, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function segIntersectRect(x1, y1, x2, y2, rx, ry, rw, rh) {
  // Liang-Barsky-ish quick test
  if (Math.max(x1, x2) < rx || Math.min(x1, x2) > rx + rw) return false;
  if (Math.max(y1, y2) < ry || Math.min(y1, y2) > ry + rh) return false;
  // Sample points along segment
  const len = Math.hypot(x2 - x1, y2 - y1);
  const steps = Math.ceil(len / 4);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return true;
  }
  return false;
}
