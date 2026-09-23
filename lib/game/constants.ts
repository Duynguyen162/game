// Grid & world constants shared by map generator, simulation and renderer.
export const T = 64; // tile size in world pixels (matches the Tiny Swords tileset)
export const MW = 512;
export const MH = 512;
export const N = MW * MH;
export const WORLD_W = MW * T;
export const WORLD_H = MH * T;

// ground[] values
export const WATER = 0;
export const LAND = 1;
export const FORD = 2;
export const BRIDGE = 3;

// ramp[] values: art from tileset columns 0 (left slope) and 3 (right slope), rows 4-5
export const RAMP_L_TOP = 1;
export const RAMP_L_BOT = 2;
export const RAMP_R_TOP = 3;
export const RAMP_R_BOT = 4;

export const MAX_LEVEL = 3;

// Tactical zone geometry (fraction of map width)
export const SPAWN_FRAC = 0.2;
export const SPAWN_W = Math.floor(MW * SPAWN_FRAC); // 102 tiles

// Rows where the river is crossed. Rotationally symmetric: y ↔ MH-1-y.
export const BRIDGE_ROWS: [number, number][] = [
  [92, 95],
  [254, 257],
  [416, 419],
];
export const FORD_ROWS: [number, number][] = [
  [168, 181],
  [330, 343],
];

export const SPEED_FORD = 0.5;
export const FOREST_REVEAL_ALPHA = 0.4;

export type Side = 0 | 1; // 0 = West, 1 = East
export const COLORS = ["Blue", "Red", "Yellow", "Purple", "Black"] as const;
export type TeamColor = (typeof COLORS)[number];
export const COLOR_HEX: Record<TeamColor, string> = {
  Blue: "#4f8fd6",
  Red: "#e0524a",
  Yellow: "#e6c34a",
  Purple: "#a26ad0",
  Black: "#5b6470",
};
export const COLOR_VI: Record<TeamColor, string> = {
  Blue: "Lam",
  Red: "Đỏ",
  Yellow: "Vàng",
  Purple: "Tím",
  Black: "Đen",
};
