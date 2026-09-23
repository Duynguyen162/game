// Flow fields: one Dijkstra pass from a goal area over the whole 512x512 grid,
// shared by every unit sent there. Costs follow terrain speed (fords cost 2x),
// so crowds naturally funnel through bridges, ramps and shallows.
import { MH, MW, N } from "./constants";
import { canStep, passable, tileSpeed, type GameMap } from "./map";

export const DX = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY = [0, 1, 1, 1, 0, -1, -1, -1];
export const DIR_GOAL = 8;
export const DIR_NONE = 255;
const DIAG = Math.SQRT2;

export interface FlowField {
  id: number;
  cost: Float32Array;
  dir: Uint8Array;
  tx: number;
  ty: number;
  radius: number;
  refs: number;
}

class Heap {
  nodes = new Int32Array(1 << 16);
  keys = new Float32Array(1 << 16);
  size = 0;
  push(n: number, k: number) {
    if (this.size >= this.nodes.length) {
      const nn = new Int32Array(this.nodes.length * 2);
      nn.set(this.nodes);
      const nk = new Float32Array(this.keys.length * 2);
      nk.set(this.keys);
      this.nodes = nn;
      this.keys = nk;
    }
    let i = this.size++;
    const { nodes, keys } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      nodes[i] = nodes[p];
      keys[i] = keys[p];
      i = p;
    }
    nodes[i] = n;
    keys[i] = k;
  }
  pop(): number {
    const { nodes, keys } = this;
    const top = nodes[0];
    const n = nodes[--this.size];
    const k = keys[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      nodes[i] = nodes[c];
      keys[i] = keys[c];
      i = c;
    }
    nodes[i] = n;
    keys[i] = k;
    return top;
  }
  topKey() {
    return this.keys[0];
  }
}

// Diagonal moves require both orthogonal detours to be legal (no corner cutting past cliffs).
function stepOk(m: GameMap, from: number, d: number): boolean {
  const x = from % MW;
  const y = (from / MW) | 0;
  const nx = x + DX[d];
  const ny = y + DY[d];
  if (nx < 0 || ny < 0 || nx >= MW || ny >= MH) return false;
  const to = ny * MW + nx;
  if (!canStep(m, from, to)) return false;
  if (d & 1) {
    const a = y * MW + nx;
    const b = ny * MW + x;
    if (!canStep(m, from, a) || !canStep(m, a, to)) return false;
    if (!canStep(m, from, b) || !canStep(m, b, to)) return false;
  }
  return true;
}

export function nearestPassable(m: GameMap, tx: number, ty: number): number {
  for (let r = 0; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= MW || y >= MH) continue;
        const i = y * MW + x;
        if (passable(m, i)) return i;
      }
    }
  }
  return -1;
}

let nextId = 1;

export function buildFlowField(m: GameMap, tx: number, ty: number, radius: number): FlowField | null {
  const start = nearestPassable(m, tx, ty);
  if (start < 0) return null;
  const sx = start % MW;
  const sy = (start / MW) | 0;
  const cost = new Float32Array(N).fill(Infinity);
  const heap = new Heap();
  // goal area: tiles within radius reachable from the start tile without leaving the area
  cost[start] = 0;
  const r2 = radius * radius;
  const queue = [start];
  while (queue.length) {
    const c = queue.pop()!;
    heap.push(c, 0);
    for (let d = 0; d < 8; d += 2) {
      if (!stepOk(m, c, d)) continue;
      const n = c + DY[d] * MW + DX[d];
      if (cost[n] === 0) continue;
      const x = n % MW;
      const y = (n / MW) | 0;
      if ((x - sx) ** 2 + (y - sy) ** 2 > r2) continue;
      cost[n] = 0;
      queue.push(n);
    }
  }
  while (heap.size) {
    const k = heap.topKey();
    const c = heap.pop();
    if (k > cost[c]) continue;
    // relax neighbours n → c (units move from n toward c)
    for (let d = 0; d < 8; d++) {
      const x = (c % MW) + DX[d];
      const y = ((c / MW) | 0) + DY[d];
      if (x < 0 || y < 0 || x >= MW || y >= MH) continue;
      const n = y * MW + x;
      const back = (d + 4) & 7;
      if (!stepOk(m, n, back)) continue;
      const nc = k + (d & 1 ? DIAG : 1) / tileSpeed(m, c);
      if (nc < cost[n]) {
        cost[n] = nc;
        heap.push(n, nc);
      }
    }
  }
  const dir = new Uint8Array(N).fill(DIR_NONE);
  for (let i = 0; i < N; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    if (ci === 0) {
      dir[i] = DIR_GOAL;
      continue;
    }
    let best = ci;
    let bd = DIR_NONE;
    for (let d = 0; d < 8; d++) {
      if (!stepOk(m, i, d)) continue;
      const n = i + DY[d] * MW + DX[d];
      if (cost[n] < best) {
        best = cost[n];
        bd = d;
      }
    }
    dir[i] = bd;
  }
  return { id: nextId++, cost, dir, tx: sx, ty: sy, radius, refs: 0 };
}
