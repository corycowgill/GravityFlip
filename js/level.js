// Level: parses compact string layouts and tracks dynamic state
import { TILE, COLS, ROWS, CHAR, T, isSolid } from "./tiles.js";

export class Level {
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.world = def.world;
    this.intro = def.intro || null;

    // Parse 17 rows of 30 chars (whitespace tolerated)
    const grid = new Uint8Array(COLS * ROWS);
    let spawn = { x: 4 * TILE, y: 8 * TILE };
    const objects = []; // {kind, gx, gy, props}
    const lasers = def.lasers || [];

    const rows = def.layout
      .split("\n")
      .map(r => r.replace(/\r/g, ""))
      .filter(r => r.length > 0);

    for (let y = 0; y < Math.min(ROWS, rows.length); y++) {
      const row = rows[y];
      for (let x = 0; x < Math.min(COLS, row.length); x++) {
        const ch = row[x];
        const i = y * COLS + x;
        if (ch === "@") { spawn = { x: x * TILE + TILE / 2, y: y * TILE + TILE / 2 }; grid[i] = T.EMPTY; }
        else if (ch === "C") { objects.push({ kind: "crate", gx: x, gy: y, props: { weight: 1 } }); grid[i] = T.EMPTY; }
        else if (ch === "H") { objects.push({ kind: "crate", gx: x, gy: y, props: { weight: 2 } }); grid[i] = T.EMPTY; }
        else if (ch === "O") { objects.push({ kind: "sphere", gx: x, gy: y, props: {} }); grid[i] = T.EMPTY; }
        else if (CHAR[ch] !== undefined) grid[i] = CHAR[ch];
        else grid[i] = T.EMPTY;
      }
    }

    this.grid = grid;
    this.baseGrid = new Uint8Array(grid);
    this.spawn = spawn;
    this.objects = objects;
    this.lasers = lasers;

    // Per-level gravity rules
    // gravityZones: optional list of {x,y,w,h,dir} in tile units
    this.gravityZones = def.gravityZones || null;

    // desyncObjects: which dynamic objects respond to gravity flips with delay
    // (frames or seconds delay)
    this.desync = def.desync || null;
  }

  reset() {
    this.grid = new Uint8Array(this.baseGrid);
  }

  getTile(gx, gy) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return T.SOLID; // outside = wall
    return this.grid[gy * COLS + gx];
  }
  setTile(gx, gy, v) {
    if (gx < 0 || gy < 0 || gx >= COLS || gy >= ROWS) return;
    this.grid[gy * COLS + gx] = v;
  }

  isSolidAt(gx, gy) { return isSolid(this.getTile(gx, gy)); }

  // Pixel-space helpers
  isSolidPx(x, y) {
    return this.isSolidAt(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  // Returns the gravity vector at a given pixel (for multi-zone levels).
  // Defaults to whatever the player's currentGravity is if no zones; pass through.
  gravityAt(x, y, fallback) {
    if (!this.gravityZones) return fallback;
    const gx = x / TILE, gy = y / TILE;
    for (const z of this.gravityZones) {
      if (gx >= z.x && gx < z.x + z.w && gy >= z.y && gy < z.y + z.h) {
        return z.dir;
      }
    }
    return fallback;
  }
}
