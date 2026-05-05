// Player: AABB physics with arbitrary gravity direction.
import { TILE, T, isSolid, isLethalTile } from "./tiles.js";

export const GRAV = {
  DOWN:  { x: 0, y: 1 },
  UP:    { x: 0, y: -1 },
  LEFT:  { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

// Tuned constants.
//
// Arc physics: when gravity flips, the player's full velocity is preserved.
// Gravity simply changes direction and reshapes the velocity over time, which
// produces real parabolic trajectories — flipping while running launches you
// in an arc, and you have to factor your current speed into where you'll land.
const ACCEL = 2100;          // gravity acceleration (px/s^2)
const MAX_FALL = 800;        // terminal velocity along gravity axis
const MAX_PERP = 900;        // soft cap on the perpendicular axis (prevents runaway)
const BOUNCE_SPEED = 760;    // launch speed off bounce pads (any axis)
const FLIP_COOLDOWN = 0.04;  // sec between accepted flips
const ROT_SPEED = 720;       // visual rotation deg/s
const GROUND_DRAG = 14.0;    // settle perpendicular velocity when grounded
const AIR_DRAG = 0.18;       // very light air drag on perpendicular axis (per second)
const LAND_IMPACT_THRESH = 380;
const GLASS_BREAK_THRESH = 360;
const BUFFER_TIME = 0.14;
const SQUASH_TIME = 0.13;

export class Player {
  constructor() {
    this.w = 22;
    this.h = 22;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.gravity = GRAV.DOWN;
    this.effGravity = GRAV.DOWN;
    this.alive = true;
    this.flipCooldown = 0;
    this.flipFlash = 0;
    this.visualRot = 0;
    this.visualRotTarget = 0;
    this.grounded = false;
    this.wasGrounded = false;
    // Event queue (drained by Game each frame)
    this.events = [];
    // Squash/stretch on impact
    this.squashT = 0;
    this.squashAxis = "y"; // 'x' = squash horizontally, 'y' = vertically
    // Buffered flip
    this.bufferDir = null;
    this.bufferT = 0;
    // Trail samples for motion-blur ghost
    this.trail = [];
  }

  spawnAt(x, y) {
    this.x = x - this.w / 2;
    this.y = y - this.h / 2;
    this.vx = 0; this.vy = 0;
    this.gravity = GRAV.DOWN;
    this.effGravity = GRAV.DOWN;
    this.alive = true;
    this.flipCooldown = 0;
    this.flipFlash = 0;
    this.visualRot = 0;
    this.visualRotTarget = 0;
    this.grounded = false;
    this.wasGrounded = false;
    this.events.length = 0;
    this.squashT = 0;
    this.bufferDir = null;
    this.bufferT = 0;
    this.trail.length = 0;
  }

  // Returns:
  //   "ok"       — flip applied this call
  //   "buffered" — queued (cooldown active or no-op direction during cooldown)
  //   null       — rejected (dead, identical direction with no cooldown, or unknown)
  tryFlip(dir) {
    if (!this.alive) return null;
    const g = GRAV[dir.toUpperCase()];
    if (!g) return null;

    if (this.flipCooldown > 0) {
      // Buffer it — drain on cooldown end if still relevant
      this.bufferDir = dir;
      this.bufferT = BUFFER_TIME;
      return "buffered";
    }
    if (g === this.gravity) return null;

    this._applyFlip(g);
    return "ok";
  }

  _applyFlip(g) {
    const prev = this.gravity;
    this.gravity = g;
    this.flipCooldown = FLIP_COOLDOWN;
    this.flipFlash = 0.18;

    // ARC PHYSICS: preserve full velocity through the flip.
    // Whatever vx/vy the player has at this instant is kept. Gravity in the
    // new direction will reshape it over time, producing real parabolic
    // trajectories — flipping while running launches the player in an arc,
    // and they have to plan around momentum + distance.
    //
    // We do NOT zero or scale any axis here.

    if (g === GRAV.DOWN)  this.visualRotTarget = 0;
    if (g === GRAV.UP)    this.visualRotTarget = 180;
    if (g === GRAV.LEFT)  this.visualRotTarget = -90;
    if (g === GRAV.RIGHT) this.visualRotTarget = 90;

    this.events.push({ type: "flip", from: prev, to: g });
  }

  update(dt, level, opts) {
    if (!this.alive) return;
    this.flipCooldown = Math.max(0, this.flipCooldown - dt);
    this.flipFlash = Math.max(0, this.flipFlash - dt);
    this.squashT = Math.max(0, this.squashT - dt);

    // Drain buffered flip when cooldown ends
    if (this.bufferDir) {
      this.bufferT -= dt;
      if (this.bufferT <= 0) { this.bufferDir = null; }
      else if (this.flipCooldown === 0) {
        const g = GRAV[this.bufferDir.toUpperCase()];
        if (g && g !== this.gravity) this._applyFlip(g);
        this.bufferDir = null;
      }
    }

    const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
    const g = level.gravityAt(cx, cy, this.gravity);
    this.effGravity = g;

    // Apply gravity (slow-mo is applied at the Game.update level via dt scaling).
    this.vx += g.x * ACCEL * dt;
    this.vy += g.y * ACCEL * dt;

    // Light air drag on the perpendicular axis only — keeps arcs from being
    // perfectly endless without robbing them of feel.
    if (!this.grounded) {
      const dragFactor = Math.max(0, 1 - AIR_DRAG * dt);
      if (g.x !== 0) this.vy *= dragFactor;
      else           this.vx *= dragFactor;
    }

    // Cap fall speed along the gravity axis at terminal velocity.
    if (g.x !== 0) {
      if (g.x > 0) this.vx = Math.min(this.vx, MAX_FALL);
      else this.vx = Math.max(this.vx, -MAX_FALL);
    }
    if (g.y !== 0) {
      if (g.y > 0) this.vy = Math.min(this.vy, MAX_FALL);
      else this.vy = Math.max(this.vy, -MAX_FALL);
    }
    // Soft cap perpendicular axis (handles edge cases where flips chain a lot).
    if (g.x !== 0) {
      if (this.vy > MAX_PERP) this.vy = MAX_PERP;
      if (this.vy < -MAX_PERP) this.vy = -MAX_PERP;
    } else {
      if (this.vx > MAX_PERP) this.vx = MAX_PERP;
      if (this.vx < -MAX_PERP) this.vx = -MAX_PERP;
    }

    // Track velocity at impact for landing FX
    const preVx = this.vx, preVy = this.vy;

    this.wasGrounded = this.grounded;
    this.grounded = false;

    const stepX = this.vx * dt;
    const stepY = this.vy * dt;
    if (Math.abs(stepX) > 0.0001) this._moveAxis(level, stepX, 0);
    if (Math.abs(stepY) > 0.0001) this._moveAxis(level, 0, stepY);

    // Landing impact: just transitioned from airborne to grounded
    if (!this.wasGrounded && this.grounded) {
      // Speed lost on impact = preceding velocity along gravity axis
      const impactSpeed = (g.x !== 0) ? Math.abs(preVx) : Math.abs(preVy);
      if (impactSpeed > LAND_IMPACT_THRESH) {
        this.events.push({ type: "land", speed: impactSpeed });
        this.squashT = SQUASH_TIME;
        this.squashAxis = (g.y !== 0) ? "y" : "x";
      }
    }

    this._applySurfaceFx(level, g, dt);

    // Visual rotation easing
    let diff = this.visualRotTarget - this.visualRot;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    if (Math.abs(diff) <= ROT_SPEED * dt) this.visualRot = this.visualRotTarget;
    else this.visualRot += Math.sign(diff) * ROT_SPEED * dt;

    // Trail samples (for motion ghost rendering)
    const speed2 = this.vx * this.vx + this.vy * this.vy;
    if (speed2 > 200 * 200) {
      this.trail.push({ x: this.x, y: this.y, rot: this.visualRot, t: 0 });
      if (this.trail.length > 6) this.trail.shift();
    }
    for (const s of this.trail) s.t += dt;
    this.trail = this.trail.filter(s => s.t < 0.12);

    this._checkHazards(level);
  }

  _moveAxis(level, dx, dy) {
    const max = Math.max(Math.abs(dx), Math.abs(dy));
    const steps = Math.max(1, Math.ceil(max / 5)); // tighter substepping for high speeds
    const sx = dx / steps, sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      this.x += sx;
      if (sx !== 0) this._resolveX(level, sx);
      this.y += sy;
      if (sy !== 0) this._resolveY(level, sy);
    }
  }

  _resolveX(level, sx) {
    const x0 = Math.floor(this.x / TILE);
    const x1 = Math.floor((this.x + this.w - 0.001) / TILE);
    const y0 = Math.floor(this.y / TILE);
    const y1 = Math.floor((this.y + this.h - 0.001) / TILE);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const tile = level.getTile(gx, gy);
        if (!isSolid(tile)) continue;

        // Glass: shatter on sufficient impact, pass through.
        if (tile === T.GLASS && Math.abs(this.vx) >= GLASS_BREAK_THRESH) {
          level.setTile(gx, gy, T.EMPTY);
          this.events.push({ type: "glass", gx, gy });
          this.vx *= 0.7;
          continue;
        }

        const eg = this.effGravity || this.gravity;
        if (sx > 0) {
          this.x = gx * TILE - this.w;
          if (eg.x > 0) this.grounded = true;
          if (tile === T.BOUNCE) {
            this.vx = -BOUNCE_SPEED;
            this.events.push({ type: "bounce" });
            return;
          }
          this.vx = 0;
        } else {
          this.x = (gx + 1) * TILE;
          if (eg.x < 0) this.grounded = true;
          if (tile === T.BOUNCE) {
            this.vx = BOUNCE_SPEED;
            this.events.push({ type: "bounce" });
            return;
          }
          this.vx = 0;
        }
        return;
      }
    }
  }

  _resolveY(level, sy) {
    const x0 = Math.floor(this.x / TILE);
    const x1 = Math.floor((this.x + this.w - 0.001) / TILE);
    const y0 = Math.floor(this.y / TILE);
    const y1 = Math.floor((this.y + this.h - 0.001) / TILE);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const tile = level.getTile(gx, gy);
        if (!isSolid(tile)) continue;

        if (tile === T.GLASS && Math.abs(this.vy) >= GLASS_BREAK_THRESH) {
          level.setTile(gx, gy, T.EMPTY);
          this.events.push({ type: "glass", gx, gy });
          this.vy *= 0.7;
          continue;
        }

        const eg = this.effGravity || this.gravity;
        if (sy > 0) {
          this.y = gy * TILE - this.h;
          if (eg.y > 0) this.grounded = true;
          if (tile === T.BOUNCE) {
            this.vy = -BOUNCE_SPEED;
            this.events.push({ type: "bounce" });
            return;
          }
          this.vy = 0;
        } else {
          this.y = (gy + 1) * TILE;
          if (eg.y < 0) this.grounded = true;
          if (tile === T.BOUNCE) {
            this.vy = BOUNCE_SPEED;
            this.events.push({ type: "bounce" });
            return;
          }
          this.vy = 0;
        }
        return;
      }
    }
  }

  _applySurfaceFx(level, g, dt) {
    if (!this.grounded) return;
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2;
    let footX = cx, footY = cy;
    if (g.y > 0) footY = this.y + this.h + 1;
    else if (g.y < 0) footY = this.y - 1;
    else if (g.x > 0) footX = this.x + this.w + 1;
    else if (g.x < 0) footX = this.x - 1;
    const tile = level.getTile(Math.floor(footX / TILE), Math.floor(footY / TILE));

    if (tile === T.CONVEYOR_R || tile === T.CONVEYOR_L) {
      const target = tile === T.CONVEYOR_R ? 200 : -200;
      // Conveyor pushes along world X regardless of gravity axis.
      this.vx += (target - this.vx) * Math.min(1, dt * 9);
    } else if (tile === T.ICE) {
      // Slick: no perpendicular friction.
    } else {
      // Damp the perpendicular axis toward 0 so the player doesn't drift on plain ground.
      if (g.y !== 0) {
        const drag = Math.min(1, dt * GROUND_DRAG);
        this.vx -= this.vx * drag;
      } else {
        const drag = Math.min(1, dt * GROUND_DRAG);
        this.vy -= this.vy * drag;
      }
    }
  }

  _checkHazards(level) {
    // Directional spike check: each spike has a kill region only on its
    // dangerous half of the tile, so contact from the back side is safe.
    const x0 = Math.floor(this.x / TILE);
    const x1 = Math.floor((this.x + this.w - 0.001) / TILE);
    const y0 = Math.floor(this.y / TILE);
    const y1 = Math.floor((this.y + this.h - 0.001) / TILE);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const tile = level.getTile(gx, gy);
        if (!isLethalTile(tile)) continue;
        const tx = gx * TILE, ty = gy * TILE;
        let kx = tx, ky = ty, kw = TILE, kh = TILE;
        // Kill zone is only the dangerous half (~22 of 32 px).
        if (tile === T.SPIKE_U) { kh = 20; }
        else if (tile === T.SPIKE_D) { ky = ty + 12; kh = 20; }
        else if (tile === T.SPIKE_L) { kw = 20; }
        else if (tile === T.SPIKE_R) { kx = tx + 12; kw = 20; }
        // Inset the player a bit so corner-grazes don't kill.
        const px = this.x + 3, py = this.y + 3;
        const pw = this.w - 6, ph = this.h - 6;
        if (px < kx + kw && px + pw > kx && py < ky + kh && py + ph > ky) {
          this.alive = false;
          this.events.push({ type: "die" });
          return;
        }
      }
    }
  }
}
