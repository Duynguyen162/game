import {
  BRIDGE,
  BRIDGE_ROWS,
  FORD,
  FORD_ROWS,
  LAND,
  MAX_LEVEL,
  MH,
  MW,
  N,
  RAMP_L_BOT,
  RAMP_L_TOP,
  RAMP_R_BOT,
  RAMP_R_TOP,
  SPAWN_W,
  SPEED_FORD,
  T,
  WATER,
  WORLD_H,
  WORLD_W,
  type Side,
} from "./constants";
import { makeNoise, mulberry32, type Rng } from "./rng";

// Decoration kinds (visual only, never block movement)
export const D_BUSH = 0; // Bushes/Bushe1-4 (8 frames, 128px)
export const D_ROCK = 1; // Rocks/Rock1-4 (64px)
export const D_STUMP = 2; // Trees/Stump 1-4 (192x256)
export const D_GOLD = 3; // Gold Stones/Gold Stone 1-6 (128px, highlight anim 6 frames)
export const D_WROCK = 4; // Rocks in the Water/Water Rocks_01-04 (16 frames, 64px)
export const D_DUCK = 5; // Rubber duck (3 frames, 32px)
export const D_GOLD_RES = 6; // Gold Resource pile
export const D_WOOD_RES = 7;
export const D_MEAT_RES = 8;
export const D_TOOL = 9; // Tool_01-04

export interface Decor {
  k: number;
  x: number;
  y: number;
  v: number;
  ph: number;
}

export const BUILDING_KINDS = ["Castle", "Barracks", "Archery", "Monastery", "Tower", "House1", "House2", "House3"] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export interface Building {
  kind: BuildingKind;
  side: Side;
  tx: number;
  ty: number;
  fw: number;
  fh: number;
  hp: number;
  maxHp: number;
}

export interface PawnNodes {
  gold: [number, number][];
  wood: [number, number][];
  meat: [number, number][];
  build: [number, number][];
  drop: [number, number];
}

export interface Bridge {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface GameMap {
  seed: number;
  ground: Uint8Array;
  level: Uint8Array;
  ramp: Uint8Array;
  cliff: Uint8Array;
  forest: Int32Array; // forest zone id (0 = none)
  block: Uint8Array; // buildings
  zoneCount: number;
  zoneSize: Int32Array;
  treeX: Float32Array;
  treeY: Float32Array;
  treeKind: Uint8Array;
  treeZone: Int32Array;
  treePh: Float32Array;
  treeCount: number;
  treeBuckets: Int32Array[]; // per 16x16 tile bucket, sorted by y
  decor: Decor[];
  decorBuckets: Int32Array[];
  bridges: Bridge[];
  buildings: Building[];
  pawnNodes: [PawnNodes, PawnNodes];
  pasture: [[number, number], [number, number]];
  riverL: Int16Array;
  riverR: Int16Array;
}

export const BK = 16; // bucket size in tiles
export const BW = MW / BK;
export const BH = MH / BK;

const idx = (x: number, y: number) => y * MW + x;
const rotIdx = (i: number) => N - 1 - i; // (x,y) → (MW-1-x, MH-1-y)

// ---------------------------------------------------------------- nav rules

export function passable(m: GameMap, i: number): boolean {
  const g = m.ground[i];
  if (g === LAND) return m.cliff[i] === 0 && m.block[i] === 0;
  return g === FORD || g === BRIDGE;
}

export function tileSpeed(m: GameMap, i: number): number {
  return m.ground[i] === FORD ? SPEED_FORD : 1;
}

// Elevation rule: same level, or one level apart when the lower tile is a ramp.
export function canStep(m: GameMap, a: number, b: number): boolean {
  if (!passable(m, a) || !passable(m, b)) return false;
  const la = m.level[a];
  const lb = m.level[b];
  if (la === lb) return true;
  if (lb === la + 1) return m.ramp[a] > 0;
  if (la === lb + 1) return m.ramp[b] > 0;
  return false;
}

// ---------------------------------------------------------------- generator

function label(mask: (i: number) => boolean, out: Int32Array): number {
  out.fill(0);
  let next = 0;
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (out[s] || !mask(s)) continue;
    next++;
    let sp = 0;
    stack[sp++] = s;
    out[s] = next;
    while (sp) {
      const c = stack[--sp];
      const x = c % MW;
      const y = (c / MW) | 0;
      if (x > 0 && !out[c - 1] && mask(c - 1)) { out[c - 1] = next; stack[sp++] = c - 1; }
      if (x < MW - 1 && !out[c + 1] && mask(c + 1)) { out[c + 1] = next; stack[sp++] = c + 1; }
      if (y > 0 && !out[c - MW] && mask(c - MW)) { out[c - MW] = next; stack[sp++] = c - MW; }
      if (y < MH - 1 && !out[c + MW] && mask(c + MW)) { out[c + MW] = next; stack[sp++] = c + MW; }
    }
  }
  return next;
}

function computeCliffs(level: Uint8Array, cliff: Uint8Array) {
  cliff.fill(0);
  for (let i = 0; i < N - MW; i++) {
    const l = level[i];
    const s = level[i + MW];
    if (l > s) cliff[i + MW] = Math.max(cliff[i + MW], l);
  }
}

interface Rect { x: number; y: number; w: number; h: number }

export function generateMap(seed: number): GameMap {
  const rng: Rng = mulberry32(seed);
  const noise = makeNoise(seed * 7 + 1);
  const noise2 = makeNoise(seed * 13 + 5);

  const ground = new Uint8Array(N).fill(LAND);
  const level = new Uint8Array(N);
  const ramp = new Uint8Array(N);
  const cliff = new Uint8Array(N);
  const forest = new Int32Array(N);
  const block = new Uint8Array(N);
  const reserved = new Uint8Array(N); // no decor / trees
  const riverL = new Int16Array(MH);
  const riverR = new Int16Array(MH);

  // ---- 1-2. Great Divide: winding river, rotationally symmetric (odd offset, even width)
  const a1 = 13 + rng() * 7;
  const a2 = 4 + rng() * 4;
  const f1 = 1 + rng() * 0.5;
  const f2 = 2.6 + rng() * 1.2;
  const cx = (y: number) => {
    const u = (y - MH / 2) / MH;
    return MW / 2 + a1 * Math.sin(u * Math.PI * 2 * f1) + a2 * Math.sin(u * Math.PI * 2 * f2);
  };
  const hw = (y: number) => {
    const u = (y - MH / 2) / MH;
    return 8 + 2 * Math.cos(u * Math.PI * 4) + 1 * Math.cos(u * Math.PI * 10);
  };
  for (let y = 0; y < MH; y++) {
    const c = cx(y + 0.5);
    const h = hw(y + 0.5);
    riverL[y] = MW;
    riverR[y] = -1;
    for (let x = 0; x < MW; x++) {
      if (Math.abs(x + 0.5 - c) < h) {
        ground[idx(x, y)] = WATER;
        if (x < riverL[y]) riverL[y] = x;
        if (x > riverR[y]) riverR[y] = x;
      }
    }
  }
  for (const [y0, y1] of FORD_ROWS) {
    for (let y = y0; y <= y1; y++) for (let x = riverL[y]; x <= riverR[y]; x++) ground[idx(x, y)] = FORD;
  }
  const bridges: Bridge[] = [];
  for (const [y0, y1] of BRIDGE_ROWS) {
    let x0 = MW;
    let x1 = 0;
    for (let y = y0; y <= y1; y++) {
      x0 = Math.min(x0, riverL[y]);
      x1 = Math.max(x1, riverR[y]);
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ground[idx(x, y)] === WATER) ground[idx(x, y)] = BRIDGE;
    bridges.push({ x0, x1, y0, y1 });
  }

  // ---- 3. Tactical Highlands (west half, then rotated to the east)
  const corridors: [number, number][] = [
    ...BRIDGE_ROWS.map(([a, b]) => [a - 6, b + 6] as [number, number]),
    ...FORD_ROWS.map(([a, b]) => [a - 3, b + 3] as [number, number]),
  ].sort((a, b) => a[0] - b[0]);
  const sections: [number, number][] = [];
  let prev = 34;
  for (const [a, b] of corridors) {
    sections.push([prev, a - 1]);
    prev = b + 1;
  }
  sections.push([prev, MH - 36]);

  const stamp = (r: Rect, l: number, ys: number, ye: number) => {
    for (let y = Math.max(r.y, ys); y < Math.min(r.y + r.h, ye); y++) {
      const maxX = riverL[y] - 9;
      for (let x = Math.max(r.x, SPAWN_W + 5); x < Math.min(r.x + r.w, maxX, MW / 2); x++) {
        const i = idx(x, y);
        if (level[i] < l) level[i] = l;
      }
    }
  };
  sections.forEach(([ys, ye], si) => {
    const H = ye - ys;
    const halves = H > 40 ? 2 : 1;
    for (let k = 0; k < halves; k++) {
      const nearRiver = (si + k) % 2 === 1; // zig-zag
      const hs = ys + Math.floor((H / halves) * k);
      const he = ys + Math.floor((H / halves) * (k + 1));
      const maxH = Math.max(7, he - hs - 5);
      const h = Math.min(maxH, 12 + Math.floor(rng() * 10));
      const w = 20 + Math.floor(rng() * 16);
      const y = hs + 2 + Math.floor(rng() * Math.max(1, he - hs - h - 4));
      let riverMin = MW;
      for (let yy = y; yy < y + h; yy++) riverMin = Math.min(riverMin, riverL[yy]);
      const x = nearRiver
        ? riverMin - 11 - w - Math.floor(rng() * 6)
        : SPAWN_W + 6 + Math.floor(rng() * 16);
      const main: Rect = { x, y, w, h };
      stamp(main, 1, hs + 1, he - 1);
      // irregular extension
      const w2 = Math.floor(w * (0.45 + rng() * 0.3));
      const h2 = Math.floor(h * (0.5 + rng() * 0.3));
      const ext: Rect = {
        x: x + Math.floor(rng() * (w - w2)),
        y: rng() < 0.5 ? y - Math.floor(h2 * 0.5) : y + h - Math.floor(h2 * 0.5),
        w: w2,
        h: h2,
      };
      stamp(ext, 1, hs + 1, he - 1);
      if (w >= 18 && h >= 11) {
        const inset = 3 + Math.floor(rng() * 3);
        const inner: Rect = { x: x + inset, y: y + 2, w: w - inset * 2, h: h - 6 };
        stamp(inner, 2, hs + 1, he - 1);
        if (inner.w >= 12 && inner.h >= 7 && rng() < 0.55) {
          stamp({ x: inner.x + 3, y: inner.y + 1, w: inner.w - 6, h: inner.h - 4 }, 3, hs + 1, he - 1);
        }
      }
    }
  });
  // close 1-2 tile gaps so no cliff lands on another plateau's top edge
  for (let l = 1; l <= MAX_LEVEL; l++) {
    for (let x = 0; x < MW / 2; x++) {
      for (let y = 0; y < MH - 3; y++) {
        if (level[idx(x, y)] < l || level[idx(x, y + 1)] >= l) continue;
        for (let k = 2; k <= 3; k++) {
          if (level[idx(x, y + k)] >= l) {
            for (let j = 1; j < k; j++) level[idx(x, y + j)] = l;
            break;
          }
        }
      }
    }
    for (let y = 0; y < MH; y++) {
      for (let x = 1; x < MW / 2 - 1; x++) {
        const i = idx(x, y);
        if (level[i] < l && level[i - 1] >= l && level[i + 1] >= l) level[i] = l;
      }
    }
  }
  for (let i = 0; i < N; i++) if (i % MW >= MW / 2) level[i] = level[rotIdx(i)];
  computeCliffs(level, cliff);

  // ---- ramps (1-2 per plateau layer component, at bottom corners)
  const comp = new Int32Array(N);
  const okRamp = (x: number, y: number, l: number) => {
    if (x < 0 || x >= MW || y < 0 || y >= MH) return false;
    const i = idx(x, y);
    return ground[i] === LAND && level[i] === l - 1 && cliff[i] === 0 && ramp[i] === 0;
  };
  const okExit = (x: number, y: number, l: number) => {
    if (x < 0 || x >= MW || y < 0 || y >= MH) return false;
    const i = idx(x, y);
    return ground[i] === LAND && level[i] === l - 1 && cliff[i] === 0;
  };
  for (let l = 1; l <= MAX_LEVEL; l++) {
    const count = label((i) => level[i] >= l, comp);
    const cand: { left: number[]; right: number[] }[] = Array.from({ length: count + 1 }, () => ({ left: [], right: [] }));
    for (let y = 1; y < MH - 3; y++) {
      for (let x = 2; x < MW - 2; x++) {
        const i = idx(x, y);
        if (level[i] !== l || level[i + MW] >= l) continue;
        const c = comp[i];
        if (level[i - 1] < l && okRamp(x - 1, y, l) && okRamp(x - 1, y + 1, l) && okExit(x - 2, y, l) && okExit(x - 2, y + 1, l) && level[idx(x - 1, y + 2)] < l) {
          cand[c].left.push(i);
        }
        if (level[i + 1] < l && okRamp(x + 1, y, l) && okRamp(x + 1, y + 1, l) && okExit(x + 2, y, l) && okExit(x + 2, y + 1, l) && level[idx(x + 1, y + 2)] < l) {
          cand[c].right.push(i);
        }
      }
    }
    const demote: boolean[] = new Array(count + 1).fill(false);
    for (let c = 1; c <= count; c++) {
      const { left, right } = cand[c];
      const want = rng() < 0.5 ? 1 : 2;
      let placed = 0;
      const tryPlace = (list: number[], isLeft: boolean) => {
        if (!list.length) return;
        const i = list[Math.floor(rng() * list.length)];
        const x = i % MW;
        const y = (i / MW) | 0;
        const rx = isLeft ? x - 1 : x + 1;
        if (!okRamp(rx, y, l) || !okRamp(rx, y + 1, l)) return;
        ramp[idx(rx, y)] = isLeft ? RAMP_L_TOP : RAMP_R_TOP;
        ramp[idx(rx, y + 1)] = isLeft ? RAMP_L_BOT : RAMP_R_BOT;
        placed++;
      };
      if (want === 2 && left.length && right.length) {
        tryPlace(left, true);
        tryPlace(right, false);
      } else {
        const useLeft = left.length && (!right.length || rng() < 0.5);
        tryPlace(useLeft ? left : right, !!useLeft);
      }
      if (!placed) demote[c] = true;
    }
    for (let i = 0; i < N; i++) if (level[i] >= l && demote[comp[i]]) level[i] = l - 1;
    computeCliffs(level, cliff);
  }
  // a demotion could leave a ramp orphaned on top of a cliff; clear such ramps
  for (let i = 0; i < N; i++) if (ramp[i] && cliff[i]) ramp[i] = 0;

  // ---- buildings (west, rotated for east)
  const buildings: Building[] = [];
  const HP: Record<BuildingKind, number> = { Castle: 9000, Barracks: 3500, Archery: 3000, Monastery: 3000, Tower: 2500, House1: 1500, House2: 1500, House3: 1500 };
  const FOOT: Record<BuildingKind, [number, number, number]> = {
    // footprint w, h, sprite height in tiles
    Castle: [5, 2, 4], Barracks: [3, 2, 4], Archery: [3, 2, 4], Monastery: [3, 2, 5], Tower: [2, 1, 4], House1: [2, 1, 3], House2: [2, 1, 3], House3: [2, 1, 3],
  };
  const westLayout: [BuildingKind, number, number][] = [
    ["Castle", 24, 254], ["Barracks", 36, 238], ["Archery", 36, 272], ["Monastery", 14, 272],
    ["Tower", 44, 249], ["Tower", 44, 263], ["Tower", 22, 222], ["Tower", 22, 294],
    ["House1", 8, 243], ["House2", 13, 236], ["House3", 8, 257], ["House1", 30, 288], ["House2", 13, 262], ["House3", 30, 226],
  ];
  const addBuilding = (kind: BuildingKind, side: Side, tx: number, ty: number) => {
    const [fw, fh, sh] = FOOT[kind];
    buildings.push({ kind, side, tx, ty, fw, fh, hp: HP[kind], maxHp: HP[kind] });
    for (let y = ty; y < ty + fh; y++) for (let x = tx; x < tx + fw; x++) block[idx(x, y)] = 1;
    for (let y = ty + fh - sh - 1; y <= ty + fh; y++) for (let x = tx - 1; x <= tx + fw; x++) if (x >= 0 && y >= 0 && x < MW && y < MH) reserved[idx(x, y)] = 1;
  };
  for (const [k, tx, ty] of westLayout) addBuilding(k, 0, tx, ty);
  for (const [k, tx, ty] of westLayout) {
    const [fw, fh] = FOOT[k];
    addBuilding(k, 1, MW - tx - fw, MH - ty - fh);
  }

  // ---- 4. Ambush Woods
  const nearHigh = new Uint8Array(N);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const i = idx(x, y);
    if (level[i] > 0 || cliff[i] > 0 || ramp[i] > 0) {
      for (let dy = -2; dy <= 3; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < MW && yy < MH) nearHigh[idx(xx, yy)] = 1;
      }
    }
  }
  const fmask = new Uint8Array(N);
  const nearBridge = (y: number) => BRIDGE_ROWS.some(([a, b]) => y >= a - 3 && y <= b + 3) || FORD_ROWS.some(([a, b]) => y >= a - 1 && y <= b + 1);
  for (let y = 0; y < MH; y++) {
    const d = Math.min(y, MH - 1 - y);
    const edge = Math.max(0, 1 - d / 60);
    for (let x = SPAWN_W + 4; x < MW / 2; x++) {
      const i = idx(x, y);
      if (ground[i] !== LAND || level[i] || nearHigh[i] || reserved[i]) continue;
      const dr = riverL[y] - x;
      if (dr < 4) continue;
      if (dr < 26 && nearBridge(y)) continue;
      const score = noise(x / 18, y / 18) * 0.8 + edge * 1.0 + noise2(x / 8, y / 8) * 0.22 + 0.1;
      if (score > 0.72) fmask[i] = 1;
    }
  }
  // branching paths carved through the woods
  let fCount = 0;
  const fList: number[] = [];
  for (let i = 0; i < N; i++) if (fmask[i]) { fCount++; fList.push(i); }
  const walkers: [number, number, number, number][] = [];
  for (let k = 0; k < Math.floor(fCount / 1400); k++) {
    const s = fList[Math.floor(rng() * fList.length)];
    walkers.push([s % MW, (s / MW) | 0, rng() * Math.PI * 2, 40 + rng() * 60]);
  }
  const pathMask = new Uint8Array(N);
  while (walkers.length) {
    const w = walkers.pop()!;
    let [x, y, a] = w;
    for (let step = 0; step < w[3]; step++) {
      a += (rng() - 0.5) * 0.7;
      x += Math.cos(a);
      y += Math.sin(a);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 1 || yi < 1 || xi >= MW / 2 - 1 || yi >= MH - 1) break;
      for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
        const j = idx(xi + dx, yi + dy);
        fmask[j] = 0;
        pathMask[j] = 1;
      }
      if (rng() < 0.025 && walkers.length < 50) walkers.push([x, y, a + (rng() < 0.5 ? 1.2 : -1.2), 20 + rng() * 40]);
    }
  }
  for (let i = 0; i < N; i++) if (i % MW >= MW / 2) { fmask[i] = fmask[rotIdx(i)]; pathMask[i] = pathMask[rotIdx(i)]; }
  let zoneCount = label((i) => fmask[i] === 1, forest);
  let zoneSize = new Int32Array(zoneCount + 1);
  for (let i = 0; i < N; i++) zoneSize[forest[i]]++;
  // drop tiny clumps, relabel compactly
  for (let i = 0; i < N; i++) if (forest[i] && zoneSize[forest[i]] < 12) fmask[i] = 0;
  zoneCount = label((i) => fmask[i] === 1, forest);
  zoneSize = new Int32Array(zoneCount + 1);
  for (let i = 0; i < N; i++) zoneSize[forest[i]]++;
  zoneSize[0] = 0;

  // ---- trees (west half, rotated)
  const tx: number[] = [], ty: number[] = [], tk: number[] = [], tp: number[] = [];
  const addTree = (x: number, y: number, k: number, p: number) => { tx.push(x); ty.push(y); tk.push(k); tp.push(p); };
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW / 2; x++) {
    if (!fmask[idx(x, y)]) continue;
    if (rng() < 0.62) {
      const px = x * T + 32 + (rng() - 0.5) * 36;
      const py = y * T + 40 + (rng() - 0.5) * 30;
      const k = Math.floor(rng() * 4);
      const p = rng();
      addTree(px, py, k, p);
      addTree(WORLD_W - px, WORLD_H - py + 16, k, p);
    }
  }
  // wood grove behind each base (pawns chop here, zone 0 = never hides units)
  const grove: [number, number][] = [];
  for (let k = 0; k < 14; k++) {
    const gx = (4 + (k % 5) * 1.6 + rng() * 0.6) * T;
    const gy = (306 + Math.floor(k / 5) * 1.8 + rng() * 0.6) * T;
    grove.push([gx, gy]);
    const kk = Math.floor(rng() * 4);
    addTree(gx, gy, kk, rng());
    addTree(WORLD_W - gx, WORLD_H - gy + 16, kk, rng());
  }
  for (const [gx, gy] of grove) {
    const i = idx(Math.floor(gx / T), Math.floor(gy / T));
    reserved[i] = 1;
  }

  // ---- decorations
  const decor: Decor[] = [];
  const addDecor = (k: number, x: number, y: number, v: number, mirror = true) => {
    const ph = rng();
    decor.push({ k, x, y, v, ph });
    if (mirror) decor.push({ k, x: WORLD_W - x, y: WORLD_H - y, v, ph });
  };
  const jx = (x: number) => x * T + 12 + rng() * 40;
  const jy = (y: number) => y * T + 20 + rng() * 36;
  for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW / 2; x++) {
    const i = idx(x, y);
    if (reserved[i]) continue;
    const g = ground[i];
    const r = rng();
    if (g === FORD) {
      if (r < 0.22) addDecor(D_WROCK, jx(x), jy(y), Math.floor(rng() * 4));
      continue;
    }
    if (g === WATER) {
      if (r < 0.006) addDecor(D_WROCK, jx(x), jy(y), Math.floor(rng() * 4));
      continue;
    }
    if (g !== LAND || cliff[i] || ramp[i]) continue;
    if (fmask[i]) {
      if (r < 0.03) addDecor(D_STUMP, jx(x), jy(y), Math.floor(rng() * 4));
      continue;
    }
    if (level[i] > 0) {
      const edge = level[i - 1] < level[i] || level[i + 1] < level[i] || level[i - MW] < level[i] || level[i + MW] < level[i];
      if (edge) continue;
      if (r < 0.012) addDecor(D_GOLD, jx(x), jy(y), Math.floor(rng() * 6));
      else if (r < 0.022) addDecor(D_ROCK, jx(x), jy(y), Math.floor(rng() * 4));
      else if (r < 0.03) addDecor(D_BUSH, jx(x), jy(y), Math.floor(rng() * 4));
      continue;
    }
    const byForest = fmask[i - 1] || fmask[i + 1] || fmask[i - MW] || fmask[i + MW];
    if (byForest) {
      if (r < 0.1) addDecor(D_BUSH, jx(x), jy(y), Math.floor(rng() * 4));
      else if (r < 0.15) addDecor(D_STUMP, jx(x), jy(y), Math.floor(rng() * 4));
      else if (r < 0.19) addDecor(D_ROCK, jx(x), jy(y), Math.floor(rng() * 4));
    } else if (pathMask[i]) {
      if (r < 0.02) addDecor(D_ROCK, jx(x), jy(y), Math.floor(rng() * 4));
    } else if (x < SPAWN_W) {
      if (r < 0.005) addDecor(D_BUSH, jx(x), jy(y), Math.floor(rng() * 4));
      else if (r < 0.009) addDecor(D_ROCK, jx(x), jy(y), Math.floor(rng() * 4));
    } else if (r < 0.004) addDecor(D_BUSH, jx(x), jy(y), Math.floor(rng() * 4));
    else if (r < 0.007) addDecor(D_ROCK, jx(x), jy(y), Math.floor(rng() * 4));
  }
  // rubber duck floating in the river
  const dy0 = 212;
  addDecor(D_DUCK, (riverL[dy0] + riverR[dy0]) / 2 * T, dy0 * T + 20, 0, false);

  // base resources: gold mine, stock piles, tools
  const gold: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const gx = (5 + (k % 3) * 2) * T + 32;
    const gy = (214 + Math.floor(k / 3) * 2) * T + 40;
    gold.push([gx, gy]);
    addDecor(D_GOLD, gx, gy, k);
  }
  addDecor(D_GOLD_RES, 31 * T, 258 * T, 0);
  addDecor(D_WOOD_RES, 23 * T, 258 * T, 0);
  addDecor(D_MEAT_RES, 25 * T, 259 * T, 0);
  addDecor(D_WOOD_RES, 22 * T + 30, 259 * T, 0);
  for (let k = 0; k < 4; k++) addDecor(D_TOOL, (40 + k) * T, 242 * T + 20, k);

  const westNodes: PawnNodes = {
    gold,
    wood: grove.map(([x, y]) => [x + 40, y + 10] as [number, number]),
    meat: [[20 * T, 316 * T], [26 * T, 320 * T], [30 * T, 312 * T]],
    build: buildings.filter((b) => b.side === 0 && b.kind.startsWith("House")).map((b) => [(b.tx + b.fw) * T + 20, (b.ty + b.fh) * T + 10] as [number, number]),
    drop: [29 * T, 257 * T],
  };
  const rot = ([x, y]: [number, number]) => [WORLD_W - x, WORLD_H - y] as [number, number];
  const eastNodes: PawnNodes = {
    gold: westNodes.gold.map(rot),
    wood: westNodes.wood.map(rot),
    meat: westNodes.meat.map(rot),
    build: buildings.filter((b) => b.side === 1 && b.kind.startsWith("House")).map((b) => [(b.tx - 0.3) * T, (b.ty + b.fh) * T + 10] as [number, number]),
    drop: rot(westNodes.drop),
  };

  // ---- spatial buckets
  const treeCount = tx.length;
  const treeX = Float32Array.from(tx), treeY = Float32Array.from(ty);
  const treeKind = Uint8Array.from(tk), treePh = Float32Array.from(tp);
  const treeZone = new Int32Array(treeCount);
  for (let t = 0; t < treeCount; t++) {
    const xi = Math.min(MW - 1, Math.max(0, Math.floor(treeX[t] / T)));
    const yi = Math.min(MH - 1, Math.max(0, Math.floor(treeY[t] / T)));
    treeZone[t] = forest[idx(xi, yi)];
  }
  const bucketize = (count: number, gx: (i: number) => number, gy: (i: number) => number) => {
    const lists: number[][] = Array.from({ length: BW * BH }, () => []);
    for (let i = 0; i < count; i++) {
      const bx = Math.min(BW - 1, Math.max(0, Math.floor(gx(i) / (T * BK))));
      const by = Math.min(BH - 1, Math.max(0, Math.floor(gy(i) / (T * BK))));
      lists[by * BW + bx].push(i);
    }
    return lists.map((l) => Int32Array.from(l.sort((a, b) => gy(a) - gy(b))));
  };
  const treeBuckets = bucketize(treeCount, (i) => treeX[i], (i) => treeY[i]);
  const decorBuckets = bucketize(decor.length, (i) => decor[i].x, (i) => decor[i].y);

  return {
    seed, ground, level, ramp, cliff, forest, block, zoneCount, zoneSize,
    treeX, treeY, treeKind, treeZone, treePh, treeCount, treeBuckets,
    decor, decorBuckets, bridges, buildings,
    pawnNodes: [westNodes, eastNodes],
    pasture: [[24 * T, 316 * T], rot([24 * T, 316 * T])],
    riverL, riverR,
  };
}
