// Tile constants and helpers
export const TILE = 32;
export const COLS = 30;  // 30 * 32 = 960
export const ROWS = 17;  // 17 * 32 = 544 (we crop to 540)

// Tile codes
export const T = {
  EMPTY:    0,
  SOLID:    1,
  SPIKE_U:  2,  // points up
  SPIKE_D:  3,  // points down
  SPIKE_L:  4,
  SPIKE_R:  5,
  EXIT:     6,
  PLATE:    7,  // pressure plate (toggles linked doors)
  DOOR:     8,  // closed door (becomes empty when plate active)
  CONVEYOR_R: 9,
  CONVEYOR_L: 10,
  BOUNCE:   11, // bounce pad (top-facing)
  STICKY:   12, // sticky tile (player sticks to surface, ignores gravity briefly)
  ZONE_MARK: 13, // visual only, marks gravity-zone boundary
  ICE:      14, // low-friction
  GLASS:    15, // breakable solid (breaks when player lands on it)
};

// Map characters used in compact level strings to tile codes.
// '.' = empty, '#' = solid, '^' = spike up, 'v' = spike down,
// '<' = spike left, '>' = spike right, 'E' = exit,
// 'P' = pressure plate, 'D' = door, '~' = conveyor right, '_' = conveyor left,
// 'B' = bounce, 'S' = sticky, 'Z' = zone marker, 'I' = ice, 'G' = glass
// Player spawn = '@', Crate = 'C', Heavy crate = 'H', Sphere = 'O',
// Laser source markers (configured per-level): 'L'
export const CHAR = {
  ".": T.EMPTY,
  " ": T.EMPTY,
  "#": T.SOLID,
  "^": T.SPIKE_U,
  "v": T.SPIKE_D,
  "<": T.SPIKE_L,
  ">": T.SPIKE_R,
  "E": T.EXIT,
  "P": T.PLATE,
  "D": T.DOOR,
  "~": T.CONVEYOR_R,
  "_": T.CONVEYOR_L,
  "B": T.BOUNCE,
  "S": T.STICKY,
  "Z": T.ZONE_MARK,
  "I": T.ICE,
  "G": T.GLASS,
};

export function isSolid(tile) {
  return tile === T.SOLID || tile === T.DOOR || tile === T.GLASS ||
         tile === T.CONVEYOR_R || tile === T.CONVEYOR_L ||
         tile === T.BOUNCE || tile === T.STICKY || tile === T.ICE;
}

export function isLethalTile(tile) {
  return tile === T.SPIKE_U || tile === T.SPIKE_D ||
         tile === T.SPIKE_L || tile === T.SPIKE_R;
}

// For directional spike: returns the direction it kills from (the side it points).
export function spikeDir(tile) {
  switch (tile) {
    case T.SPIKE_U: return { x: 0, y: -1 };
    case T.SPIKE_D: return { x: 0, y: 1 };
    case T.SPIKE_L: return { x: -1, y: 0 };
    case T.SPIKE_R: return { x: 1, y: 0 };
  }
  return null;
}
