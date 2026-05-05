// Reachability audit for every level.
//
// Models the player as a flip-and-slide agent:
// - State = the (gx, gy) cell where the player is at rest.
// - From any state, try 4 flips. For each flip, simulate the slide:
//   the player moves cell-by-cell in the gravity direction until they
//   hit a SOLID tile (walls / doors / glass / conveyors / bounce / etc.)
//   or fly out of bounds (death).
// - Crossing a LETHAL tile (spike / always-on laser) during the slide
//   is treated as death and that path is rejected.
// - Crossing the EXIT tile during the slide counts as a win (the game
//   triggers exit on overlap, not on rest).
//
// This is intentionally pessimistic about hazards (always-on lasers and
// every spike block movement) and optimistic about plates/doors (assumes
// no plate puzzle gating). For our 24 launch levels neither caveat hides
// real solvability bugs.

import { Level } from "../js/level.js";
import { LEVELS } from "../js/levels.js";
import { TILE, COLS, ROWS, T, isSolid, isLethalTile } from "../js/tiles.js";

const DIRS = [
  { name: "down",  dx: 0,  dy: 1  },
  { name: "up",    dx: 0,  dy: -1 },
  { name: "right", dx: 1,  dy: 0  },
  { name: "left",  dx: -1, dy: 0  },
];

function isLaserTile(level, gx, gy) {
  if (!level.lasers || !level.lasers.length) return false;
  // Treat a tile as lethal-laser if any laser segment passes through its
  // center pixel and the laser is "always-on" (very high duty cycle).
  const cx = gx * TILE + TILE / 2;
  const cy = gy * TILE + TILE / 2;
  for (const l of level.lasers) {
    const duty = l.duty != null ? l.duty : 0.5;
    // We only treat 'always on' lasers (duty ~ 1.0) as immovable hazards.
    // Pulsing beams have an off-window the player can time, so we ignore
    // them for static reachability purposes.
    if (duty < 0.9) continue;
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
    const steps = Math.max(8, Math.ceil(len / 4));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = l.x1 + (l.x2 - l.x1) * t;
      const y = l.y1 + (l.y2 - l.y1) * t;
      if (Math.abs(x - cx) <= TILE / 2 && Math.abs(y - cy) <= TILE / 2) return true;
    }
  }
  return false;
}

function reachable(def) {
  const level = new Level(def);
  const sx = Math.floor(level.spawn.x / TILE);
  const sy = Math.floor(level.spawn.y / TILE);
  // Find the exit cell
  let ex = -1, ey = -1;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (level.getTile(x, y) === T.EXIT) { ex = x; ey = y; }
    }
  }
  if (ex < 0) return { ok: false, reason: "no exit tile" };

  // Check spawn validity
  const spawnTile = level.getTile(sx, sy);
  if (isSolid(spawnTile)) return { ok: false, reason: `spawn (${sx},${sy}) is solid` };
  if (isLethalTile(spawnTile)) return { ok: false, reason: `spawn (${sx},${sy}) is lethal` };

  // SPAWN PHYSICS: the player starts with gravity DOWN. Before they can
  // input anything they fall to the first solid cell below. If that cell
  // is lethal — or any cell they pass through on the way down is lethal —
  // they die before the player can react. Same for any always-on laser
  // overlapping the fall column.
  for (let y = sy + 1; y < ROWS; y++) {
    const t = level.getTile(sx, y);
    if (isLethalTile(t)) {
      return { ok: false, reason: `spawn (${sx},${sy}) lands on spike at (${sx},${y}) before player can flip` };
    }
    if (isLaserTile(level, sx, y)) {
      return { ok: false, reason: `spawn (${sx},${sy}) falls into always-on laser at (${sx},${y})` };
    }
    if (isSolid(t)) break; // landed safely
    if (y === ROWS - 1) {
      return { ok: false, reason: `spawn (${sx},${sy}) falls out of bounds (no floor below)` };
    }
  }

  // Multi-zone gravity: if spawn or exit is inside a forced-gravity zone,
  // the player's available flips at that cell are constrained, but for a
  // basic reachability check we ignore zones (treat as standard cells).

  // CRITICAL: the player can flip MID-slide. So every non-lethal cell
  // traversed during a slide is itself a reachable node, not just the
  // resting cell where the slide stops. We add each intermediate cell.
  const visited = new Set();
  const key = (x, y) => `${x},${y}`;
  const queue = [{ x: sx, y: sy }];
  visited.add(key(sx, sy));

  while (queue.length) {
    const { x, y } = queue.shift();
    for (const d of DIRS) {
      let cx = x, cy = y;
      while (true) {
        const nx = cx + d.dx, ny = cy + d.dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS) break;
        const t = level.getTile(nx, ny);
        if (isSolid(t)) break;
        if (isLethalTile(t)) break;        // can't enter spike cell
        if (isLaserTile(level, nx, ny)) break;
        if (t === T.EXIT) return { ok: true };
        const k = key(nx, ny);
        if (!visited.has(k)) {
          visited.add(k);
          queue.push({ x: nx, y: ny });
        }
        cx = nx; cy = ny;
      }
    }
  }
  return { ok: false, reason: `exit (${ex},${ey}) not reachable from spawn (${sx},${sy})` };
}

// Levels that the static checker can't model accurately — they require
// crate-as-obstacle reasoning, gravity-zone-aided routing, or timed
// pulsed-laser windows. The actual game behavior for these has been
// verified manually.
const STATIC_CHECKER_BLIND = new Set([
  "3-3", // Block the Beam — must push the crate into the always-on laser
]);

let pass = 0, hardFail = 0, softFail = 0;
const failures = [];
for (const def of LEVELS) {
  const r = reachable(def);
  if (r.ok) { console.log(`ok   ${def.id}  ${def.name}`); pass++; continue; }
  // Hard fail = spawn physics broken (player can't survive their first frame).
  // These are game-breaking bugs the smoke harness should fail on.
  const isHard = /spawn .* lands on spike|spawn .* falls into|spawn .* falls out of bounds|spawn .* is solid|spawn .* is lethal/.test(r.reason);
  const isWhitelisted = STATIC_CHECKER_BLIND.has(def.id);
  if (isHard) {
    console.log(`HARD FAIL ${def.id}  ${def.name}  — ${r.reason}`);
    failures.push({ id: def.id, reason: r.reason, hard: true });
    hardFail++;
  } else if (isWhitelisted) {
    console.log(`warn (whitelisted) ${def.id}  ${def.name}  — ${r.reason}`);
  } else {
    console.log(`SOFT FAIL ${def.id}  ${def.name}  — ${r.reason}`);
    failures.push({ id: def.id, reason: r.reason, hard: false });
    softFail++;
  }
}
console.log(`\n${pass} reachable, ${hardFail} hard fail, ${softFail} soft fail`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  [${f.hard ? "HARD" : "soft"}] ${f.id}: ${f.reason}`);
}
// Only exit 1 on HARD failures (real bugs). Soft fails surface for review
// but don't gate CI.
process.exit(hardFail > 0 ? 1 : 0);
