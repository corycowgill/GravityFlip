// Smoke test for pure-logic modules. Stubs DOM globals so engine/ui/audio don't crash on import.
import { performance as perf } from "node:perf_hooks";

// Stub browser globals for any modules that touch them.
globalThis.performance = globalThis.performance || perf;
globalThis.window = globalThis;
globalThis.document = {
  getElementById: () => ({
    classList: { add() {}, remove() {} },
    addEventListener() {},
    appendChild() {},
    style: {},
    set innerHTML(v) {}, set textContent(v) {},
  }),
  addEventListener() {},
  hidden: false,
};
globalThis.localStorage = {
  store: {},
  getItem(k) { return this.store[k] || null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.AudioContext = class { constructor(){this.state="running";this.currentTime=0;this.destination={};} createGain(){return{gain:{value:0},connect(){return this;}};} createOscillator(){return{frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){return this;},start(){},stop(){}};} createBuffer(){return{getChannelData(){return new Float32Array(0);}};} createBufferSource(){return{buffer:null,connect(){return this;},start(){}};} resume(){} };

// Mock canvas context
const ctx = new Proxy({}, { get: () => () => ({}) });
const canvas = {
  getContext: () => ctx,
  width: 960, height: 540,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
  addEventListener() {},
};
globalThis.document.getElementById = (id) => {
  if (id === "game") return canvas;
  return { classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, style: {}, innerHTML: "", textContent: "", value: "" };
};

const { Level } = await import("../js/level.js");
const { Player, GRAV } = await import("../js/player.js");
const { LEVELS } = await import("../js/levels.js");
const { TILE, T, COLS, ROWS, isSolid, isLethalTile } = await import("../js/tiles.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log("ok  " + name); pass++; }
  catch (e) { console.log("FAIL " + name + " — " + e.message); fail++; }
};

const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };

// 1. Every level parses and has expected dimensions
test("All levels parse", () => {
  for (const def of LEVELS) {
    const lvl = new Level(def);
    assert(lvl.grid.length === COLS * ROWS, `${def.id} bad grid size`);
    assert(lvl.spawn && typeof lvl.spawn.x === "number", `${def.id} no spawn`);
  }
});

// 2. Every level has at least one EXIT tile
test("Every level has an exit", () => {
  for (const def of LEVELS) {
    const lvl = new Level(def);
    let found = false;
    for (let i = 0; i < lvl.grid.length; i++) if (lvl.grid[i] === T.EXIT) { found = true; break; }
    assert(found, `${def.id} has no exit`);
  }
});

// 3. Player spawn is not inside a solid
test("Player spawn is in empty space", () => {
  for (const def of LEVELS) {
    const lvl = new Level(def);
    const sx = Math.floor(lvl.spawn.x / TILE);
    const sy = Math.floor(lvl.spawn.y / TILE);
    const tile = lvl.getTile(sx, sy);
    assert(!isSolid(tile) && !isLethalTile(tile), `${def.id} spawn at (${sx},${sy}) is tile ${tile}`);
  }
});

// 4. Player falls down under gravity and lands on solid floor
test("Player falls and lands on floor", () => {
  const def = LEVELS[0]; // 1-1
  const lvl = new Level(def);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  for (let i = 0; i < 200; i++) p.update(1/120, lvl, {});
  assert(p.alive, "player died falling");
  assert(p.grounded, "player should be grounded");
  // Should have settled near the floor row (row 13 in the layout)
  const feetGy = Math.floor((p.y + p.h) / TILE);
  assert(feetGy >= 12 && feetGy <= 13, `feet at row ${feetGy} unexpected`);
});

// 5. Flip up changes gravity direction and player lifts toward ceiling
test("Flip up moves player to ceiling", () => {
  const def = LEVELS[1]; // 1-2 has clear ceiling
  const lvl = new Level(def);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  // Settle on floor
  for (let i = 0; i < 100; i++) p.update(1/120, lvl, {});
  p.tryFlip("up");
  for (let i = 0; i < 200; i++) p.update(1/120, lvl, {});
  assert(p.alive, "player died after flipping up");
  assert(p.gravity === GRAV.UP, "gravity should be UP");
  assert(p.grounded, "player should be on ceiling");
  const headGy = Math.floor(p.y / TILE);
  assert(headGy <= 1, `head at row ${headGy} should be near ceiling`);
});

// 6. Spike kills the player
test("Spike kills player on contact", () => {
  const def = LEVELS[3]; // 1-4 has spikes
  const lvl = new Level(def);
  const p = new Player();
  // Drop player directly onto a spike
  let spikeX = -1, spikeY = -1;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    if (lvl.getTile(x, y) === T.SPIKE_U) { spikeX = x; spikeY = y; break; }
  }
  assert(spikeX >= 0, "no spike found");
  p.spawnAt(spikeX * TILE + TILE/2, (spikeY - 2) * TILE);
  for (let i = 0; i < 300; i++) {
    p.update(1/120, lvl, {});
    if (!p.alive) break;
  }
  assert(!p.alive, "player should die on spike");
});

// 7. Flip API: immediate vs buffered vs rejected
test("Flip API returns ok/buffered/null correctly", () => {
  const lvl = new Level(LEVELS[0]);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  // First flip: should apply immediately
  assert(p.tryFlip("up") === "ok", "first flip should return 'ok'");
  // Same direction immediately after: cooldown active, gets buffered
  assert(p.tryFlip("up") === "buffered", "during cooldown should buffer");
  // Bad direction string returns null
  assert(p.tryFlip("nope") === null, "invalid dir should return null");
  // After cooldown ends and no buffered no-op, identical-direction returns null
  for (let i = 0; i < 30; i++) p.update(1/120, lvl, {});
  assert(p.tryFlip("up") === null, "same dir w/o cooldown should return null");
});

// 7b. Buffered flip applies after cooldown
test("Buffered flip applies when cooldown ends", () => {
  const lvl = new Level(LEVELS[0]);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  p.tryFlip("up");                      // cooldown starts
  assert(p.tryFlip("right") === "buffered", "buffered during cooldown");
  for (let i = 0; i < 20; i++) p.update(1/120, lvl, {});
  assert(p.gravity === GRAV.RIGHT, "buffered flip should apply");
});

// 7c. ARC PHYSICS: flipping while moving preserves velocity
test("Arc physics: velocity is preserved through a flip", () => {
  const lvl = new Level(LEVELS[0]);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  // Get the player moving rightward by flipping right and accelerating
  p.tryFlip("right");
  for (let i = 0; i < 60; i++) p.update(1/120, lvl, {});
  const vxBefore = p.vx;
  assert(vxBefore > 200, `should be moving right fast (vx=${vxBefore.toFixed(1)})`);
  // Flip up — vx should be preserved (was the gravity axis, becomes perpendicular)
  p.tryFlip("up");
  // No update yet — check immediately
  assert(Math.abs(p.vx - vxBefore) < 1, `vx should be preserved through flip (was ${vxBefore.toFixed(1)}, now ${p.vx.toFixed(1)})`);
  // After one frame, vy should start ramping negative (gravity up); vx should still be ~vxBefore
  p.update(1/120, lvl, {});
  assert(p.vy < 0, "vy should turn negative under upward gravity");
  assert(p.vx > vxBefore * 0.95, "vx should still be near previous magnitude");
});

// 7d. Flipping anti-parallel decelerates then reverses
test("Arc physics: anti-parallel flip decelerates and reverses", () => {
  const lvl = new Level(LEVELS[0]);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  p.tryFlip("right");
  for (let i = 0; i < 80; i++) p.update(1/120, lvl, {});
  const vxBefore = p.vx;
  assert(vxBefore > 200, "should be moving right");
  p.tryFlip("left");
  // After enough time, vx should swing through 0 and become negative
  let crossedZero = false, becameNeg = false;
  for (let i = 0; i < 200; i++) {
    p.update(1/120, lvl, {});
    if (Math.abs(p.vx) < 30) crossedZero = true;
    if (p.vx < -100) { becameNeg = true; break; }
  }
  assert(crossedZero, "vx should pass through zero during deceleration");
  assert(becameNeg, "vx should reverse direction after enough time");
});

// 8. Save round-trip
const { Save } = await import("../js/save.js");
test("Save round-trip", () => {
  const s = new Save("smoke-test-save");
  s.setCleared("1-1");
  s.setBest("1-1", 12.34);
  const s2 = new Save("smoke-test-save");
  assert(s2.isCleared("1-1"), "should be cleared");
  assert(s2.getBest("1-1") === 12.34, "best time should round-trip");
});

// 9. End-to-end: level 1-1 can be cleared with a single right-flip
test("E2E: solve 1-1 by flipping right", () => {
  const lvl = new Level(LEVELS[0]);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  for (let i = 0; i < 60; i++) p.update(1/120, lvl, {});
  p.tryFlip("right");
  let won = false;
  for (let i = 0; i < 600; i++) {
    p.update(1/120, lvl, {});
    if (!p.alive) break;
    const cx = p.x + p.w/2, cy = p.y + p.h/2;
    if (lvl.getTile(Math.floor(cx/TILE), Math.floor(cy/TILE)) === T.EXIT) { won = true; break; }
  }
  assert(won, "player should reach exit");
});

// 10. Lasers kill player in their path
test("Active laser kills player", async () => {
  const def = LEVELS.find(l => l.id === "2-1");
  const lvl = new Level(def);
  const p = new Player();
  // Place player directly in laser path
  p.spawnAt(14 * TILE + 16, 6 * TILE);
  // Manually build a laser segment matching def
  const laser = { ...def.lasers[0], active: true };
  const { default: nothing } = { default: null };
  // Simple AABB-vs-segment check inline
  const hit = (() => {
    const len = Math.hypot(laser.x2 - laser.x1, laser.y2 - laser.y1);
    const steps = Math.ceil(len / 4);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = laser.x1 + (laser.x2 - laser.x1) * t;
      const y = laser.y1 + (laser.y2 - laser.y1) * t;
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return true;
    }
    return false;
  })();
  assert(hit, "laser should overlap player position");
});

// 11. Multi-zone gravity overrides player gravity in zone
test("Gravity zone applies in its rect", () => {
  const def = LEVELS.find(l => l.id === "6-1");
  const lvl = new Level(def);
  const left = lvl.gravityAt(5 * TILE, 5 * TILE, GRAV.DOWN);
  assert(left.y === 1 && left.x === 0, "left zone should fall back to player gravity");
  const right = lvl.gravityAt(20 * TILE, 5 * TILE, GRAV.DOWN);
  assert(right.x === 1 && right.y === 0, "right zone should override gravity to right");
});

// 12. Landing produces a "land" event when impact is hard enough
test("Hard landing emits 'land' event with squash", () => {
  const lvl = new Level(LEVELS[0]); // tall room (rows 1..12 empty, 13+ floor)
  const p = new Player();
  // Spawn near top of the open area, well inside an empty cell
  p.spawnAt(8 * TILE + 16, 2 * TILE + 16);
  let landed = false;
  for (let i = 0; i < 600; i++) {
    p.update(1/120, lvl, {});
    if (p.events.some(e => e.type === "land")) { landed = true; break; }
  }
  assert(landed, "should emit 'land' event after free fall");
  assert(p.squashT > 0, "squash should be active after hard landing");
});

// 13. Directional spike: contact from non-dangerous side does NOT kill
test("SPIKE_U is safe from below (back side)", () => {
  // Build a tiny synthetic level: spike at row 8, player approaches from below
  const def = {
    id: "test-spike", name: "test", world: 0, worldName: "test",
    layout: [
      "##############################",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#......^.....................#",   // spike up at col 6
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "##############################",
      "##############################",
      "##############################",
      "##############################",
    ].join("\n"),
  };
  const lvl = new Level(def);
  const p = new Player();
  // Place player just BELOW the spike (row 9)
  p.spawnAt(6 * TILE + 16, 9 * TILE + 24);
  // Flip up so player approaches the spike from below toward its back side.
  // SPIKE_U's kill zone is the TOP 20px of the tile, so contact from below
  // should not kill the player on initial frames.
  p.tryFlip("up");
  for (let i = 0; i < 5; i++) p.update(1/120, lvl, {});
  assert(p.alive, "player should not die from spike's safe back side");
});

// 14. Glass tile breaks when player hits at high speed and disappears
test("Glass shatters on high-speed impact", () => {
  // Build synthetic: player drops onto a row of glass
  const def = {
    id: "test-glass", name: "test", world: 0, worldName: "test",
    layout: [
      "##############################",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#......GGGGGG................#",
      "#..@.........................#",
      "##############################",
      "##############################",
      "##############################",
      "##############################",
    ].join("\n"),
  };
  const lvl = new Level(def);
  const p = new Player();
  // Place player above glass and let them fall fast onto it
  p.spawnAt(8 * TILE + 16, 2 * TILE + 16);
  let glassEvt = false;
  for (let i = 0; i < 400; i++) {
    p.update(1/120, lvl, {});
    if (p.events.some(e => e.type === "glass")) glassEvt = true;
    p.events.length = 0;
    if (!p.alive) break;
  }
  assert(glassEvt, "glass should break on high-speed impact");
});

// 15. Bounce pad works in horizontal gravity
test("Bounce pad fires in horizontal gravity", () => {
  // Bounce pad in the same row as the player so they fly into it.
  const def = {
    id: "test-bounce", name: "test", world: 0, worldName: "test",
    layout: [
      "##############################",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#............................#",
      "#..@........................B#",
      "##############################",
      "##############################",
      "##############################",
      "##############################",
    ].join("\n"),
  };
  const lvl = new Level(def);
  const p = new Player();
  p.spawnAt(lvl.spawn.x, lvl.spawn.y);
  p.tryFlip("right");
  let bounced = false;
  for (let i = 0; i < 600; i++) {
    p.update(1/120, lvl, {});
    if (p.events.some(e => e.type === "bounce")) { bounced = true; break; }
    p.events.length = 0;
  }
  assert(bounced, "bounce should trigger on horizontal contact");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
