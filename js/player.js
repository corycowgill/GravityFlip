// Player: AABB physics with arbitrary gravity direction.
import { TILE, T, isSolid, isLethalTile } from "./tiles.js";

export const GRAV = {
  DOWN:  { x: 0, y: 1 },
  UP:    { x: 0, y: -1 },
  LEFT:  { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

export class Player {
  constructor() {
    this.w = 22;
    this.h = 22;
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.gravity = GRAV.DOWN;
    this.alive = true;
    this.flipCooldown = 0;
    this.flipFlash = 0;
    // Cosmetic visual rotation (degrees) follows gravity for a nice 'world rotates' feel
    this.visualRot = 0;
    this.visualRotTarget = 0;
    // Track grounded direction (the side currently 'down')
    this.grounded = false;
  }

  spawnAt(x, y) {
    this.x = x - this.w / 2;
    this.y = y - this.h / 2;
    this.vx = 0; this.vy = 0;
    this.gravity = GRAV.DOWN;
    this.alive = true;
    this.flipCooldown = 0;
    this.flipFlash = 0;
    this.visualRot = 0;
    this.visualRotTarget = 0;
    this.grounded = false;
  }

  // Returns true if the flip happened.
  tryFlip(dir) {
    if (!this.alive) return false;
    if (this.flipCooldown > 0) return false;
    const g = GRAV[dir.toUpperCase()];
    if (!g) return false;
    // No-op if already pointing that way
    if (g === this.gravity) return false;
    this.gravity = g;
    this.flipCooldown = 0.08; // short cooldown so spam flips don't break physics
    this.flipFlash = 0.18;
    // Reset perpendicular velocity to feel snappy; preserve component along new gravity
    if (g.x !== 0) {
      // Horizontal gravity: vy now means perpendicular drift, kill it; vx becomes 'fall'
      this.vy = 0;
      this.vx = Math.sign(g.x) * Math.abs(this.vx) * 0.3; // small carryover
    } else {
      this.vx = 0;
      this.vy = Math.sign(g.y) * Math.abs(this.vy) * 0.3;
    }
    // Visual rotation target: -90 for left, +90 for right, 180 for up.
    if (g === GRAV.DOWN)  this.visualRotTarget = 0;
    if (g === GRAV.UP)    this.visualRotTarget = 180;
    if (g === GRAV.LEFT)  this.visualRotTarget = -90;
    if (g === GRAV.RIGHT) this.visualRotTarget = 90;
    return true;
  }

  update(dt, level, opts) {
    if (!this.alive) return;
    this.flipCooldown = Math.max(0, this.flipCooldown - dt);
    this.flipFlash = Math.max(0, this.flipFlash - dt);

    // Use zone gravity if level overrides at player center
    const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
    const g = level.gravityAt(cx, cy, this.gravity);
    this.effGravity = g;

    const slow = opts && opts.slow ? 0.35 : 1.0;
    const ACCEL = 1700 * slow;
    const MAX_FALL = 700 * slow;

    // Apply gravity
    this.vx += g.x * ACCEL * dt;
    this.vy += g.y * ACCEL * dt;

    // Cap fall speed along gravity axis
    if (g.x !== 0) {
      const sign = Math.sign(g.x);
      if (sign > 0) this.vx = Math.min(this.vx, MAX_FALL);
      else this.vx = Math.max(this.vx, -MAX_FALL);
    }
    if (g.y !== 0) {
      const sign = Math.sign(g.y);
      if (sign > 0) this.vy = Math.min(this.vy, MAX_FALL);
      else this.vy = Math.max(this.vy, -MAX_FALL);
    }

    // Move + collide axis at a time
    const stepX = this.vx * dt;
    const stepY = this.vy * dt;

    this.grounded = false;

    if (Math.abs(stepX) > 0.0001) {
      this._moveAxis(level, stepX, 0);
    }
    if (Math.abs(stepY) > 0.0001) {
      this._moveAxis(level, 0, stepY);
    }

    // Conveyor / friction along surface (perpendicular to gravity)
    this._applySurfaceFx(level, g, dt);

    // Visual rotation easing
    let diff = this.visualRotTarget - this.visualRot;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    const rotSpeed = 540; // deg/s
    if (Math.abs(diff) <= rotSpeed * dt) this.visualRot = this.visualRotTarget;
    else this.visualRot += Math.sign(diff) * rotSpeed * dt;

    // Hazard checks
    this._checkHazards(level);
  }

  _moveAxis(level, dx, dy) {
    // Substep for very fast motion to avoid tunneling.
    const max = Math.max(Math.abs(dx), Math.abs(dy));
    const steps = Math.max(1, Math.ceil(max / 6));
    const sx = dx / steps, sy = dy / steps;
    for (let i = 0; i < steps; i++) {
      this.x += sx;
      if (sx !== 0) this._resolveX(level, sx);
      this.y += sy;
      if (sy !== 0) this._resolveY(level, sy);
    }
  }

  _resolveX(level, sx) {
    // Check tiles overlapped by current AABB
    const left = this.x;
    const right = this.x + this.w;
    const top = this.y;
    const bottom = this.y + this.h;
    const x0 = Math.floor(left / TILE);
    const x1 = Math.floor((right - 0.001) / TILE);
    const y0 = Math.floor(top / TILE);
    const y1 = Math.floor((bottom - 0.001) / TILE);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        if (level.isSolidAt(gx, gy)) {
          const eg = this.effGravity || this.gravity;
          if (sx > 0) {
            this.x = gx * TILE - this.w;
            if (eg.x > 0) this.grounded = true;
            this.vx = 0;
          } else {
            this.x = (gx + 1) * TILE;
            if (eg.x < 0) this.grounded = true;
            this.vx = 0;
          }
          return;
        }
      }
    }
  }

  _resolveY(level, sy) {
    const left = this.x;
    const right = this.x + this.w;
    const top = this.y;
    const bottom = this.y + this.h;
    const x0 = Math.floor(left / TILE);
    const x1 = Math.floor((right - 0.001) / TILE);
    const y0 = Math.floor(top / TILE);
    const y1 = Math.floor((bottom - 0.001) / TILE);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const tile = level.getTile(gx, gy);
        if (isSolid(tile)) {
          const eg = this.effGravity || this.gravity;
          if (sy > 0) {
            this.y = gy * TILE - this.h;
            if (eg.y > 0) this.grounded = true;
            if (tile === T.BOUNCE && eg.y > 0) {
              this.vy = -650;
              return;
            }
            this.vy = 0;
          } else {
            this.y = (gy + 1) * TILE;
            if (eg.y < 0) this.grounded = true;
            if (tile === T.BOUNCE && eg.y < 0) {
              this.vy = 650;
              return;
            }
            this.vy = 0;
          }
          return;
        }
      }
    }
  }

  _applySurfaceFx(level, g, dt) {
    if (!this.grounded) return;
    // Find the tile we're standing on (one cell in gravity direction from feet)
    const cx = this.x + this.w / 2;
    const cy = this.y + this.h / 2;
    let footX = cx, footY = cy;
    if (g.y > 0) footY = this.y + this.h + 1;
    else if (g.y < 0) footY = this.y - 1;
    else if (g.x > 0) footX = this.x + this.w + 1;
    else if (g.x < 0) footX = this.x - 1;
    const tile = level.getTile(Math.floor(footX / TILE), Math.floor(footY / TILE));

    // Conveyor: pushes player along world X axis
    if (tile === T.CONVEYOR_R) {
      const target = 160;
      this.vx += (target - this.vx) * Math.min(1, dt * 8);
    } else if (tile === T.CONVEYOR_L) {
      const target = -160;
      this.vx += (target - this.vx) * Math.min(1, dt * 8);
    } else if (tile === T.ICE) {
      // Slick: no friction (we already don't add any)
    } else {
      // Settle: damp the perpendicular velocity to zero
      // perpendicular axis to gravity
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
    // Sample a few inset points to detect spikes
    const insets = [
      { x: this.x + 4,            y: this.y + 4 },
      { x: this.x + this.w - 4,   y: this.y + 4 },
      { x: this.x + 4,            y: this.y + this.h - 4 },
      { x: this.x + this.w - 4,   y: this.y + this.h - 4 },
      { x: this.x + this.w / 2,   y: this.y + this.h / 2 },
    ];
    for (const p of insets) {
      const gx = Math.floor(p.x / TILE);
      const gy = Math.floor(p.y / TILE);
      const tile = level.getTile(gx, gy);
      if (isLethalTile(tile)) {
        this.alive = false;
        return;
      }
    }
  }
}

const GROUND_DRAG = 16.0;
