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
    this._hookInput();
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

  _spawnFlipFx() {
    const cx = this.player.x + this.player.w / 2;
    const cy = this.player.y + this.player.h / 2;
    this.flipFx.push({ x: cx, y: cy, t: 0, max: 0.4 });
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 200;
      this.particles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.35 + Math.random() * 0.25, age: 0,
        color: Math.random() < 0.5 ? "#5cf2ff" : "#ff5cf2",
      });
    }
  }

  _killPlayer() {
    if (!this.player.alive) return;
    this.player.alive = false;
    this.audio.die();
    this.state = "dead";
    this.deathT = 0;
    // Burst
    const cx = this.player.x + this.player.w / 2;
    const cy = this.player.y + this.player.h / 2;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 80 + Math.random() * 240;
      this.particles.push({
        x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.5 + Math.random() * 0.4, age: 0, color: "#ff5c6b",
      });
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

    // Update lasers (now slowed by dt)
    for (const l of this.lasers) {
      if (l.period) {
        l.phase += dt;
        if (l.phase >= l.period) l.phase -= l.period;
        const duty = l.duty != null ? l.duty : 0.5;
        l.active = (l.phase / l.period) < duty;
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

    // Particles
    for (const p of this.particles) {
      p.age += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
    }
    this.particles = this.particles.filter(p => p.age < p.life);

    for (const f of this.flipFx) f.t += dt;
    this.flipFx = this.flipFx.filter(f => f.t < f.max);
  }

  _drainPlayerEvents() {
    const evts = this.player.events;
    if (evts.length === 0) return;
    for (const e of evts) {
      if (e.type === "land") {
        this.audio.land();
        // Stronger impact = more shake. Cap to avoid disorientation.
        const mag = Math.min(8, (e.speed - 380) / 60);
        this._shake(mag, 0.18);
      } else if (e.type === "bounce") {
        this.audio.bounce();
        this._shake(3, 0.12);
      } else if (e.type === "glass") {
        // Shatter SFX and particles
        this.audio.click();
        this._shake(4, 0.15);
        const px = e.gx * TILE + TILE / 2;
        const py = e.gy * TILE + TILE / 2;
        for (let i = 0; i < 16; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 100 + Math.random() * 220;
          this.particles.push({
            x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 0.4 + Math.random() * 0.3, age: 0, color: "#5cf2ff",
          });
        }
      } else if (e.type === "die") {
        this._shake(7, 0.35);
      } else if (e.type === "flip") {
        this.audio.flip();
        this._spawnFlipFx();
        this._updateBgRotTarget();
      }
    }
    evts.length = 0;
  }

  _updatePlatesAndDoors() {
    const lvl = this.level;
    if (!lvl) return;
    // Find all plates, check if player or any crate is on them.
    let anyActive = false;
    const plateActive = (gx, gy) => {
      // Check player
      const p = this.player;
      const px = p.x + p.w / 2, py = p.y + p.h / 2;
      if (Math.floor(px / TILE) === gx && Math.floor((py + 6) / TILE) === gy) return true;
      // Check any dyn obj
      for (const o of this.dynObjs) {
        const ox = o.x + o.w / 2, oy = o.y + o.h / 2;
        if (Math.floor(ox / TILE) === gx && Math.floor((oy + 4) / TILE) === gy) return true;
      }
      return false;
    };
    let activePlates = 0, totalPlates = 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (lvl.baseGrid[y * COLS + x] === T.PLATE) {
          totalPlates++;
          if (plateActive(x, y)) activePlates++;
        }
      }
    }
    // Doors open if ANY plate active (simple rule). Many designs use "all" — pick all.
    const open = totalPlates > 0 && activePlates >= totalPlates;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const i = y * COLS + x;
        if (lvl.baseGrid[i] === T.DOOR) {
          lvl.grid[i] = open ? T.EMPTY : T.DOOR;
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
      return;
    }
    // Camera shake offset (random per frame, magnitude decays with shakeT)
    let sx = 0, sy = 0;
    if (this.shakeT > 0 && this.shakeMag > 0) {
      const k = this.shakeMag * (this.shakeT / 0.35);
      sx = (Math.random() * 2 - 1) * k;
      sy = (Math.random() * 2 - 1) * k;
    }
    ctx.save();
    ctx.translate(sx, sy);
    this._renderBackground(ctx);
    this._renderLevel(ctx);
    this._renderObjects(ctx);
    this._renderLasers(ctx);
    this._renderPlayer(ctx);
    this._renderParticles(ctx);
    this._renderFlipFx(ctx);
    ctx.restore();
    // Overlays should NOT shake (they're UI)
    this._renderFlash(ctx);
    if (this.state === "dead") this._renderDeathOverlay(ctx);
    if (this.state === "win") this._renderWinOverlay(ctx);
    if (this.slow) this._renderSlowmoVignette(ctx);
  }

  _renderSlowmoVignette(ctx) {
    const W = this.engine.width, H = this.engine.height;
    const grad = ctx.createRadialGradient(W/2, H/2, Math.min(W,H)*0.2, W/2, H/2, Math.max(W,H)*0.7);
    grad.addColorStop(0, "rgba(92,242,255,0)");
    grad.addColorStop(1, "rgba(92,242,255,0.18)");
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  _renderBackground(ctx) {
    const W = this.engine.width, H = this.engine.height;
    // gradient
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((this.bgRot * Math.PI) / 180);
    ctx.translate(-W / 2, -H / 2);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "#0a0f25");
    grad.addColorStop(1, "#070912");
    ctx.fillStyle = grad;
    ctx.fillRect(-W, -H, W * 3, H * 3);

    // grid (subtle)
    ctx.strokeStyle = "rgba(92,242,255,0.06)";
    ctx.lineWidth = 1;
    const step = 32;
    for (let x = -W; x < W * 2; x += step) {
      ctx.beginPath(); ctx.moveTo(x, -H); ctx.lineTo(x, H * 2); ctx.stroke();
    }
    for (let y = -H; y < H * 2; y += step) {
      ctx.beginPath(); ctx.moveTo(-W, y); ctx.lineTo(W * 2, y); ctx.stroke();
    }
    ctx.restore();
  }

  _renderLevel(ctx) {
    const lvl = this.level;
    if (!lvl) return;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const tile = lvl.getTile(x, y);
        if (tile === T.EMPTY) continue;
        drawTile(ctx, tile, x * TILE, y * TILE, this.t);
      }
    }
    // gravity zone outlines
    if (lvl.gravityZones) {
      for (const z of lvl.gravityZones) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,92,242,0.35)";
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(z.x * TILE, z.y * TILE, z.w * TILE, z.h * TILE);
        ctx.fillStyle = "rgba(255,92,242,0.06)";
        ctx.fillRect(z.x * TILE, z.y * TILE, z.w * TILE, z.h * TILE);
        // Arrow indicating gravity direction
        const cx = (z.x + z.w / 2) * TILE;
        const cy = (z.y + z.h / 2) * TILE;
        drawArrow(ctx, cx, cy, z.dir, "rgba(255,92,242,0.5)");
        ctx.restore();
      }
    }
  }

  _renderObjects(ctx) {
    for (const o of this.dynObjs) {
      ctx.save();
      if (o.kind === "crate") {
        const heavy = (o.props.weight || 1) > 1;
        const fill = heavy ? "#7a5a2c" : "#a07642";
        const stroke = heavy ? "#d6a86a" : "#e6c08a";
        ctx.fillStyle = fill;
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
        // X cross
        ctx.beginPath();
        ctx.moveTo(o.x + 4, o.y + 4); ctx.lineTo(o.x + o.w - 4, o.y + o.h - 4);
        ctx.moveTo(o.x + o.w - 4, o.y + 4); ctx.lineTo(o.x + 4, o.y + o.h - 4);
        ctx.stroke();
      } else if (o.kind === "sphere") {
        ctx.fillStyle = "#5cf2ff";
        ctx.shadowColor = "#5cf2ff";
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.arc(o.x + o.w / 2, o.y + o.h / 2, o.w / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _renderLasers(ctx) {
    for (const l of this.lasers) {
      if (!l.active) {
        // dim guide
        ctx.save();
        ctx.strokeStyle = "rgba(255,92,107,0.15)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
        ctx.stroke();
        ctx.restore();
        continue;
      }
      ctx.save();
      ctx.strokeStyle = "rgba(255,92,107,0.9)";
      ctx.lineWidth = 4;
      ctx.shadowColor = "#ff5c6b";
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
      ctx.restore();
    }
  }

  _renderPlayer(ctx) {
    const p = this.player;
    if (!p.alive) return;

    // Motion trail ghosts (drawn behind the player at older positions)
    for (const s of p.trail) {
      const a = (1 - s.t / 0.12) * 0.35;
      ctx.save();
      ctx.translate(s.x + p.w / 2, s.y + p.h / 2);
      ctx.rotate((s.rot * Math.PI) / 180);
      ctx.globalAlpha = a;
      ctx.fillStyle = "#5cf2ff";
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    // Squash/stretch on impact: 1.25x along impact axis, 0.8 perp.
    let sx = 1, sy = 1;
    if (p.squashT > 0) {
      const k = p.squashT / 0.13; // 1 -> 0
      const stretch = 1 + 0.25 * k;
      const squash = 1 - 0.20 * k;
      if (p.squashAxis === "y") { sx = stretch; sy = squash; }
      else                       { sx = squash;  sy = stretch; }
    }

    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((p.visualRot * Math.PI) / 180);
    ctx.scale(sx, sy);
    if (p.flipFlash > 0) {
      const a = p.flipFlash / 0.18;
      ctx.shadowColor = "rgba(92,242,255," + a + ")";
      ctx.shadowBlur = 30 * a;
    } else {
      ctx.shadowColor = "rgba(92,242,255,0.5)";
      ctx.shadowBlur = 12;
    }
    // Body
    ctx.fillStyle = "#e6f1ff";
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    // Inner
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#5cf2ff";
    ctx.fillRect(-p.w / 2 + 4, -p.h / 2 + 4, p.w - 8, p.h - 8);
    // Eye (forward dot — indicates "down" for orientation)
    ctx.fillStyle = "#06080f";
    ctx.fillRect(-3, p.h / 2 - 7, 6, 3);
    ctx.restore();
  }

  _renderParticles(ctx) {
    ctx.save();
    for (const pt of this.particles) {
      const a = 1 - pt.age / pt.life;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - 1.5, pt.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _renderFlipFx(ctx) {
    for (const f of this.flipFx) {
      const a = 1 - f.t / f.max;
      const r = 10 + (f.t / f.max) * 80;
      ctx.save();
      ctx.strokeStyle = "rgba(92,242,255," + (a * 0.8) + ")";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
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
    const a = Math.min(0.6, this.deathT * 1.6);
    ctx.save();
    ctx.fillStyle = "rgba(255,92,107," + a + ")";
    ctx.fillRect(0, 0, this.engine.width, this.engine.height);
    ctx.restore();
  }

  _renderWinOverlay(ctx) {
    const a = Math.min(0.4, this.winT * 1.2);
    ctx.save();
    ctx.fillStyle = "rgba(255,211,92," + a + ")";
    ctx.fillRect(0, 0, this.engine.width, this.engine.height);
    ctx.restore();
  }
}

// --- helpers ---
function drawTile(ctx, tile, x, y, t) {
  const s = TILE;
  switch (tile) {
    case T.SOLID: {
      ctx.fillStyle = "#1f2a4a";
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "#2a3a66";
      ctx.fillRect(x, y, s, 3);
      ctx.fillRect(x, y, 3, s);
      ctx.fillStyle = "#0e1530";
      ctx.fillRect(x, y + s - 3, s, 3);
      ctx.fillRect(x + s - 3, y, 3, s);
      break;
    }
    case T.GLASS: {
      ctx.fillStyle = "rgba(92,242,255,0.18)";
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = "rgba(92,242,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 4); ctx.lineTo(x + s - 4, y + s - 6);
      ctx.stroke();
      break;
    }
    case T.SPIKE_U: drawSpike(ctx, x, y, s, "up"); break;
    case T.SPIKE_D: drawSpike(ctx, x, y, s, "down"); break;
    case T.SPIKE_L: drawSpike(ctx, x, y, s, "left"); break;
    case T.SPIKE_R: drawSpike(ctx, x, y, s, "right"); break;
    case T.EXIT: {
      const pulse = 0.6 + 0.4 * Math.sin(t * 4);
      ctx.fillStyle = "rgba(255,211,92,0.15)";
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = "rgba(255,211,92," + pulse + ")";
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, y + 3, s - 6, s - 6);
      ctx.fillStyle = "rgba(255,211,92," + (pulse * 0.8) + ")";
      ctx.fillRect(x + s / 2 - 2, y + 6, 4, s - 12);
      ctx.fillRect(x + 6, y + s / 2 - 2, s - 12, 4);
      break;
    }
    case T.PLATE: {
      ctx.fillStyle = "#3a2640";
      ctx.fillRect(x, y + s - 6, s, 6);
      ctx.fillStyle = "#ff5cf2";
      ctx.fillRect(x + 4, y + s - 8, s - 8, 4);
      break;
    }
    case T.DOOR: {
      ctx.fillStyle = "#3a4670";
      ctx.fillRect(x + 2, y, s - 4, s);
      ctx.strokeStyle = "#5c6f9e";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 2.5, y + 0.5, s - 5, s - 1);
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = "#22305c";
        ctx.fillRect(x + 6, y + 6 + i * 8, s - 12, 4);
      }
      break;
    }
    case T.CONVEYOR_R:
    case T.CONVEYOR_L: {
      ctx.fillStyle = "#252b3a";
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "#3a4660";
      ctx.fillRect(x, y, s, 5);
      ctx.fillRect(x, y + s - 5, s, 5);
      // Animated arrows
      const dir = tile === T.CONVEYOR_R ? 1 : -1;
      const off = (t * 60 * dir) % 16;
      ctx.fillStyle = "#5cf2ff";
      for (let i = -16; i < s; i += 16) {
        const xx = x + ((i + off + 32) % 32);
        ctx.beginPath();
        if (dir > 0) {
          ctx.moveTo(xx, y + s / 2 - 4);
          ctx.lineTo(xx + 6, y + s / 2);
          ctx.lineTo(xx, y + s / 2 + 4);
        } else {
          ctx.moveTo(xx + 6, y + s / 2 - 4);
          ctx.lineTo(xx, y + s / 2);
          ctx.lineTo(xx + 6, y + s / 2 + 4);
        }
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case T.BOUNCE: {
      ctx.fillStyle = "#1f2a4a";
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "#5cf2ff";
      ctx.fillRect(x + 2, y + 2, s - 4, 8);
      ctx.fillStyle = "#84f9ff";
      ctx.fillRect(x + 2, y + 2, s - 4, 3);
      break;
    }
    case T.STICKY: {
      ctx.fillStyle = "#3a2a1f";
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "#9b6a3a";
      for (let i = 0; i < 4; i++) {
        ctx.fillRect(x + 4 + i * 6, y + 4, 4, 4);
        ctx.fillRect(x + 4 + i * 6, y + 16, 4, 4);
      }
      break;
    }
    case T.ICE: {
      ctx.fillStyle = "#13314a";
      ctx.fillRect(x, y, s, s);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(x, y, s, 4);
      ctx.fillRect(x, y + s - 2, s, 2);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(x + 4, y + 8); ctx.lineTo(x + 12, y + 18);
      ctx.moveTo(x + 18, y + 6); ctx.lineTo(x + 26, y + 14);
      ctx.stroke();
      break;
    }
  }
}

function drawSpike(ctx, x, y, s, dir) {
  ctx.fillStyle = "#cdd9f0";
  ctx.strokeStyle = "#7c8aaa";
  ctx.lineWidth = 1;
  const N = 4;
  for (let i = 0; i < N; i++) {
    ctx.beginPath();
    if (dir === "up") {
      const xs = x + (i * s) / N;
      ctx.moveTo(xs, y + s);
      ctx.lineTo(xs + s / N / 2, y + 4);
      ctx.lineTo(xs + s / N, y + s);
    } else if (dir === "down") {
      const xs = x + (i * s) / N;
      ctx.moveTo(xs, y);
      ctx.lineTo(xs + s / N / 2, y + s - 4);
      ctx.lineTo(xs + s / N, y);
    } else if (dir === "left") {
      const ys = y + (i * s) / N;
      ctx.moveTo(x + s, ys);
      ctx.lineTo(x + 4, ys + s / N / 2);
      ctx.lineTo(x + s, ys + s / N);
    } else if (dir === "right") {
      const ys = y + (i * s) / N;
      ctx.moveTo(x, ys);
      ctx.lineTo(x + s - 4, ys + s / N / 2);
      ctx.lineTo(x, ys + s / N);
    }
    ctx.closePath();
    ctx.fill();
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
