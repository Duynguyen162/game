// Battle simulation for 40,000 units, stored as structure-of-arrays.
import { AN, ANIMS, ARCHER, LANCER, MONK, PAWN, WARRIOR, lancerDir } from "./assets";
import { FORD, MH, MW, N, SPAWN_W, T, WORLD_H, WORLD_W, type Side } from "./constants";
import { DIR_GOAL, DIR_NONE, DX, DY, buildFlowField, type FlowField } from "./flowfield";
import { canStep, passable, tileSpeed, type Building, type GameMap } from "./map";
import { mulberry32 } from "./rng";

export interface UnitStats {
  hp: number;
  dmg: number;
  range: number;
  cd: number;
  speed: number;
  aggro: number; // tiles
}
export const STATS: UnitStats[] = [
  { hp: 120, dmg: 14, range: 40, cd: 1.0, speed: 62, aggro: 5 }, // warrior
  { hp: 70, dmg: 10, range: 6 * T, cd: 1.8, speed: 58, aggro: 7 }, // archer
  { hp: 160, dmg: 22, range: 54, cd: 1.4, speed: 88, aggro: 6 }, // lancer
  { hp: 60, dmg: 14, range: 4 * T, cd: 2.2, speed: 56, aggro: 5 }, // monk (dmg = heal)
  { hp: 50, dmg: 4, range: 36, cd: 1.2, speed: 64, aggro: 3 }, // pawn
];
export const ARMY: [number, number][] = [
  [WARRIOR, 7000],
  [LANCER, 4000],
  [ARCHER, 6000],
  [MONK, 2000],
];
export const PAWNS_PER_SIDE = 1000;
export const PER_SIDE = ARMY.reduce((s, a) => s + a[1], 0) + PAWNS_PER_SIDE; // 20,000
const CAP = PER_SIDE * 2;

export const S_IDLE = 0;
export const S_MOVE = 1;
export const S_ATTACK = 2;
export const S_WORK = 3;

// pawn tasks / phases
const TK_GOLD = 0, TK_WOOD = 1, TK_MEAT = 2, TK_BUILD = 3, TK_IDLE = 4, TK_FIGHT = 5;
const PH_GO = 0, PH_WORK = 1, PH_BACK = 2, PH_DROP = 3;
// tool indices into PAWN_TOOLS
const TOOL_NONE = 0, TOOL_AXE = 1, TOOL_GOLD = 2, TOOL_HAMMER = 3, TOOL_KNIFE = 4, TOOL_MEAT = 5, TOOL_PICK = 6, TOOL_WOOD = 7;

export const FX_DUST = 0;
export const FX_EXPLOSION = 1;
export const FX_SPLASH = 2;
export const FX_HEAL = 3;
export interface Fx { k: number; x: number; y: number; t0: number; v: number }

const MAX_ARROWS = 8000;
const MAX_FX = 900;
const MAX_FIELDS = 24;
const SEP = 20; // separation radius (px)

export class World {
  m: GameMap;
  n = 0;
  x = new Float32Array(CAP);
  y = new Float32Array(CAP);
  side = new Uint8Array(CAP);
  type = new Uint8Array(CAP);
  state = new Uint8Array(CAP);
  anim = new Uint16Array(CAP);
  animT = new Float32Array(CAP);
  hp = new Float32Array(CAP);
  target = new Int32Array(CAP).fill(-1);
  btarget = new Int16Array(CAP).fill(-1);
  cd = new Float32Array(CAP);
  face = new Int8Array(CAP);
  field = new Int16Array(CAP).fill(-1);
  alive = new Uint8Array(CAP);
  hold = new Uint8Array(CAP);
  sel = new Uint8Array(CAP);
  tile = new Int32Array(CAP);
  stuck = new Float32Array(CAP);
  // pawn data
  task = new Uint8Array(CAP);
  phase = new Uint8Array(CAP);
  taskT = new Float32Array(CAP);
  gx = new Float32Array(CAP);
  gy = new Float32Array(CAP);
  // spatial grid (one cell per tile)
  head = new Int32Array(N);
  next = new Int32Array(CAP);
  presence: [Int32Array, Int32Array];
  aliveCount: [number, number] = [0, 0];
  typeCount: [number[], number[]] = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
  kills: [number, number] = [0, 0];
  res: [{ gold: number; wood: number; meat: number }, { gold: number; wood: number; meat: number }] = [
    { gold: 0, wood: 0, meat: 0 },
    { gold: 0, wood: 0, meat: 0 },
  ];
  fields: (FlowField | null)[] = new Array(MAX_FIELDS).fill(null);
  // arrows
  arN = 0;
  arX0 = new Float32Array(MAX_ARROWS);
  arY0 = new Float32Array(MAX_ARROWS);
  arX1 = new Float32Array(MAX_ARROWS);
  arY1 = new Float32Array(MAX_ARROWS);
  arT = new Float32Array(MAX_ARROWS);
  arDur = new Float32Array(MAX_ARROWS);
  arTgt = new Int32Array(MAX_ARROWS);
  arDmg = new Float32Array(MAX_ARROWS);
  arSide = new Uint8Array(MAX_ARROWS);
  fx: Fx[] = [];
  // sheep
  shN = 0;
  shX = new Float32Array(120);
  shY = new Float32Array(120);
  shS = new Uint8Array(120); // 0 idle, 1 move, 2 grass
  shT = new Float32Array(120);
  shGX = new Float32Array(120);
  shGY = new Float32Array(120);
  shF = new Int8Array(120);
  shSide = new Uint8Array(120);

  time = 0;
  tick = 0;
  winner = -1;
  started = false;
  rnd = mulberry32(99);
  chargeField: [number, number] = [-1, -1];

  constructor(m: GameMap) {
    this.m = m;
    this.presence = [new Int32Array(m.zoneCount + 1), new Int32Array(m.zoneCount + 1)];
    this.spawn();
  }

  // ------------------------------------------------------------ helpers

  tileAt(px: number, py: number) {
    const tx = Math.min(MW - 1, Math.max(0, Math.floor(px / T)));
    const ty = Math.min(MH - 1, Math.max(0, Math.floor(py / T)));
    return ty * MW + tx;
  }

  // Continuous movement across a tile edge; a diagonal crossing is allowed via either neighbour.
  stepSim(a: number, b: number) {
    if (a === b) return true;
    const d = b - a;
    if (d === 1 || d === -1 || d === MW || d === -MW) return canStep(this.m, a, b);
    const ax = a % MW, bx = b % MW;
    const ay = (a / MW) | 0, by = (b / MW) | 0;
    if (Math.abs(ax - bx) > 1 || Math.abs(ay - by) > 1) return false;
    const c1 = ay * MW + bx;
    const c2 = by * MW + ax;
    return (canStep(this.m, a, c1) && canStep(this.m, c1, b)) || (canStep(this.m, a, c2) && canStep(this.m, c2, b));
  }

  tryMove(i: number, vx: number, vy: number): boolean {
    const ox = this.x[i], oy = this.y[i], ot = this.tile[i];
    const nx = Math.min(WORLD_W - 2, Math.max(2, ox + vx));
    const ny = Math.min(WORLD_H - 2, Math.max(2, oy + vy));
    let nt = this.tileAt(nx, ny);
    if (this.stepSim(ot, nt)) return this.commit(i, nx, ny, ot, nt);
    nt = this.tileAt(nx, oy);
    if (Math.abs(vx) > 0.01 && this.stepSim(ot, nt)) return this.commit(i, nx, oy, ot, nt);
    nt = this.tileAt(ox, ny);
    if (Math.abs(vy) > 0.01 && this.stepSim(ot, nt)) return this.commit(i, ox, ny, ot, nt);
    return false;
  }

  private commit(i: number, nx: number, ny: number, ot: number, nt: number) {
    this.x[i] = nx;
    this.y[i] = ny;
    if (nt !== ot) {
      this.tile[i] = nt;
      if (this.m.ground[nt] === FORD && this.m.ground[ot] !== FORD && this.rnd() < 0.25) this.addFx(FX_SPLASH, nx, ny, 0);
    }
    return true;
  }

  setAnim(i: number, a: number) {
    if (this.anim[i] !== a) {
      this.anim[i] = a;
      this.animT[i] = this.time;
    }
  }

  animDone(i: number) {
    const d = ANIMS[this.anim[i]];
    return this.time - this.animT[i] >= d.frames / d.fps;
  }

  addFx(k: number, x: number, y: number, v: number) {
    if (this.fx.length >= MAX_FX) this.fx.shift();
    this.fx.push({ k, x, y, t0: this.time, v });
  }

  // Can `s` see/target unit j? Units hidden in a forest zone are invisible
  // until `s` has its own units inside that same zone.
  targetable(s: number, j: number) {
    const z = this.m.forest[this.tile[j]];
    return z === 0 || this.presence[s][z] > 0;
  }

  // ------------------------------------------------------------ spawn

  private addUnit(s: Side, t: number, px: number, py: number) {
    const i = this.n++;
    this.x[i] = px;
    this.y[i] = py;
    this.side[i] = s;
    this.type[i] = t;
    this.hp[i] = STATS[t].hp;
    this.alive[i] = 1;
    this.face[i] = s === 0 ? 1 : -1;
    this.tile[i] = this.tileAt(px, py);
    this.animT[i] = -this.rnd() * 2;
    this.anim[i] = this.idleAnim(i);
    this.aliveCount[s]++;
    this.typeCount[s][t]++;
    return i;
  }

  private spawn() {
    const m = this.m;
    const rnd = mulberry32(m.seed ^ 0x5eed);
    const sp = 40;
    const blk = 10;
    const frontX = (SPAWN_W - 5) * T;
    const cy = (MH / 2) * T;
    const rows = Math.floor(((MH - 70) * T) / ((blk + 2) * sp));
    const order: number[] = [0];
    for (let k = 1; order.length < rows; k++) { order.push(k); if (order.length < rows) order.push(-k); }
    const west: [number, number, number][] = [];
    let ai = 0, left = ARMY[0][1];
    outer: for (let cb = 0; cb < 8; cb++) {
      for (const rb of order) {
        const bx = frontX - cb * (blk + 2) * sp;
        const by = cy + rb * (blk + 2) * sp - (blk * sp) / 2;
        for (let c = 0; c < blk; c++) for (let r = 0; r < blk; r++) {
          const px = bx - c * sp + (rnd() - 0.5) * 6;
          const py = by + r * sp + (rnd() - 0.5) * 6;
          const t = this.tileAt(px, py);
          if (!passable(m, t) || m.level[t] !== 0 || m.forest[t] || m.ramp[t]) continue;
          west.push([ARMY[ai][0], px, py]);
          if (--left === 0) {
            if (++ai >= ARMY.length) break outer;
            left = ARMY[ai][1];
          }
        }
      }
    }
    for (const [t, px, py] of west) this.addUnit(0, t, px, py);
    for (const [t, px, py] of west) this.addUnit(1, t, WORLD_W - px, WORLD_H - py);
    // pawns around each base
    const pawnW: [number, number][] = [];
    while (pawnW.length < PAWNS_PER_SIDE) {
      const px = (4 + rnd() * 46) * T;
      const py = (212 + rnd() * 112) * T;
      const t = this.tileAt(px, py);
      if (passable(m, t) && m.level[t] === 0 && !m.forest[t]) pawnW.push([px, py]);
    }
    for (let s = 0 as Side; s <= 1; s = (s + 1) as Side) {
      for (let k = 0; k < pawnW.length; k++) {
        let [px, py] = pawnW[k];
        if (s === 1) { px = WORLD_W - px; py = WORLD_H - py; }
        const i = this.addUnit(s, PAWN, px, py);
        const r = rnd();
        this.task[i] = r < 0.3 ? TK_GOLD : r < 0.6 ? TK_WOOD : r < 0.8 ? TK_MEAT : r < 0.95 ? TK_BUILD : TK_IDLE;
        this.phase[i] = PH_GO;
        this.pickNode(i);
      }
      if (s === 1) break;
    }
    // sheep
    for (let s = 0; s < 2; s++) {
      const [px, py] = m.pasture[s];
      for (let k = 0; k < 40; k++) {
        const i = this.shN++;
        this.shX[i] = this.shGX[i] = px + (rnd() - 0.5) * 8 * T;
        this.shY[i] = this.shGY[i] = py + (rnd() - 0.5) * 6 * T;
        this.shT[i] = rnd() * 4;
        this.shF[i] = rnd() < 0.5 ? 1 : -1;
        this.shSide[i] = s;
      }
    }
  }

  private pickNode(i: number) {
    const nodes = this.m.pawnNodes[this.side[i]];
    const list = [nodes.gold, nodes.wood, nodes.meat, nodes.build][this.task[i]];
    if (!list || !list.length) {
      this.gx[i] = this.x[i] + (this.rnd() - 0.5) * 6 * T;
      this.gy[i] = this.y[i] + (this.rnd() - 0.5) * 6 * T;
      return;
    }
    const [nx, ny] = list[Math.floor(this.rnd() * list.length)];
    this.gx[i] = nx + (this.rnd() - 0.5) * 50;
    this.gy[i] = ny + (this.rnd() - 0.5) * 30;
  }

  // ------------------------------------------------------------ animation choice

  idleAnim(i: number) {
    switch (this.type[i]) {
      case WARRIOR: return this.hold[i] ? AN.W_GUARD : AN.W_IDLE;
      case ARCHER: return AN.A_IDLE;
      case LANCER: return this.hold[i] ? AN.L_DEF[0] : AN.L_IDLE;
      case MONK: return AN.M_IDLE;
      default: return AN.P_IDLE[this.task[i] === TK_FIGHT ? TOOL_KNIFE : TOOL_NONE];
    }
  }
  runAnim(i: number) {
    switch (this.type[i]) {
      case WARRIOR: return AN.W_RUN;
      case ARCHER: return AN.A_RUN;
      case LANCER: return AN.L_RUN;
      case MONK: return AN.M_RUN;
      default: return AN.P_RUN[TOOL_KNIFE];
    }
  }

  // ------------------------------------------------------------ orders

  private allocField(f: FlowField): number {
    let slot = this.fields.findIndex((x) => x === null || x.refs <= 0);
    if (slot < 0) {
      let min = Infinity;
      this.fields.forEach((x, k) => { if (x && x.refs < min) { min = x.refs; slot = k; } });
      for (let i = 0; i < this.n; i++) if (this.field[i] === slot) this.field[i] = -1;
    }
    this.fields[slot] = f;
    return slot;
  }

  private setField(i: number, slot: number) {
    const old = this.field[i];
    if (old >= 0 && this.fields[old]) this.fields[old]!.refs--;
    this.field[i] = slot;
    if (slot >= 0) this.fields[slot]!.refs++;
  }

  // Attack-move the given units to a tile. Returns false if unreachable.
  orderMove(units: number[], tx: number, ty: number): boolean {
    const list = units.filter((i) => this.alive[i] && !(this.type[i] === PAWN && this.task[i] !== TK_FIGHT));
    if (!list.length) return false;
    const radius = Math.min(26, Math.max(2, Math.sqrt(list.length) * 0.4));
    const f = buildFlowField(this.m, tx, ty, radius);
    if (!f) return false;
    const slot = this.allocField(f);
    for (const i of list) {
      this.setField(i, slot);
      this.hold[i] = 0;
      this.target[i] = -1;
      this.btarget[i] = -1;
    }
    this.started = true;
    return true;
  }

  orderHold(units: number[]) {
    for (const i of units) {
      if (!this.alive[i] || this.type[i] === PAWN) continue;
      this.setField(i, -1);
      this.hold[i] = 1;
      this.target[i] = -1;
    }
  }

  castleOf(s: number): Building | undefined {
    return this.m.buildings.find((b) => b.side === s && b.kind === "Castle");
  }

  // Both armies (or one side) attack-move toward the enemy castle.
  orderCharge(sides: number[]) {
    for (const s of sides) {
      const c = this.castleOf(1 - s);
      if (!c) continue;
      const units: number[] = [];
      for (let i = 0; i < this.n; i++) if (this.alive[i] && this.side[i] === s && this.type[i] !== PAWN) units.push(i);
      const f = buildFlowField(this.m, c.tx + (s === 0 ? c.fw + 2 : -3), c.ty + 1, 12);
      if (!f) continue;
      const slot = this.allocField(f);
      for (const i of units) {
        this.setField(i, slot);
        this.hold[i] = 0;
      }
      this.chargeField[s] = slot;
    }
    this.started = true;
  }

  selectRect(x0: number, y0: number, x1: number, y1: number, sideFilter: number, add = false) {
    if (!add) this.sel.fill(0);
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    let c = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      if (sideFilter >= 0 && this.side[i] !== sideFilter) continue;
      const px = this.x[i], py = this.y[i] - 20;
      if (px >= ax && px <= bx && py >= ay && py <= by) { this.sel[i] = 1; c++; }
    }
    return c;
  }

  selectType(t: number, sideFilter: number) {
    this.sel.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (this.alive[i] && (t < 0 || this.type[i] === t) && (sideFilter < 0 || this.side[i] === sideFilter) && (t === PAWN || this.type[i] !== PAWN)) this.sel[i] = 1;
    }
  }

  selected(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) if (this.sel[i] && this.alive[i]) out.push(i);
    return out;
  }

  // ------------------------------------------------------------ simulation

  step(dt: number) {
    this.time += dt;
    this.tick++;
    this.rebuildGrid();
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      if (this.type[i] === PAWN && this.task[i] !== TK_FIGHT) this.updatePawn(i, dt);
      else this.updateUnit(i, dt);
    }
    this.updateArrows(dt);
    this.updateSheep(dt);
    const now = this.time;
    this.fx = this.fx.filter((f) => now - f.t0 < 1.6);
    if (this.winner < 0) {
      for (const s of [0, 1]) {
        const c = this.castleOf(s);
        if ((c && c.hp <= 0) || this.aliveCount[s] - this.typeCount[s][PAWN] <= 0) this.winner = 1 - s;
      }
    }
  }

  private rebuildGrid() {
    this.head.fill(-1);
    const p0 = this.presence[0], p1 = this.presence[1];
    p0.fill(0);
    p1.fill(0);
    const forest = this.m.forest;
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i]) continue;
      const t = this.tile[i];
      this.next[i] = this.head[t];
      this.head[t] = i;
      const z = forest[t];
      if (z) (this.side[i] ? p1 : p0)[z]++;
    }
  }

  private findEnemy(i: number, radius: number): number {
    const s = this.side[i];
    const t0 = this.tile[i];
    const tx = t0 % MW, ty = (t0 / MW) | 0;
    const px = this.x[i], py = this.y[i];
    let best = -1, bd = Infinity;
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const yy = ty + dy;
        if (yy < 0 || yy >= MH) continue;
        const edge = dy === -r || dy === r;
        for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r || 1) {
          const xx = tx + dx;
          if (xx < 0 || xx >= MW) continue;
          for (let j = this.head[yy * MW + xx]; j >= 0; j = this.next[j]) {
            if (this.side[j] === s || !this.alive[j]) continue;
            const d = (this.x[j] - px) ** 2 + (this.y[j] - py) ** 2;
            if (d < bd && this.targetable(s, j)) { bd = d; best = j; }
          }
        }
      }
      if (best >= 0 && bd <= (r * T) ** 2) break;
    }
    return best;
  }

  private findWounded(i: number, radius: number): number {
    const s = this.side[i];
    const t0 = this.tile[i];
    const tx = t0 % MW, ty = (t0 / MW) | 0;
    let best = -1, bd = Infinity;
    for (let yy = Math.max(0, ty - radius); yy <= Math.min(MH - 1, ty + radius); yy++) {
      for (let xx = Math.max(0, tx - radius); xx <= Math.min(MW - 1, tx + radius); xx++) {
        for (let j = this.head[yy * MW + xx]; j >= 0; j = this.next[j]) {
          if (j === i || this.side[j] !== s || !this.alive[j]) continue;
          if (this.hp[j] > STATS[this.type[j]].hp * 0.85) continue;
          const d = (this.x[j] - this.x[i]) ** 2 + (this.y[j] - this.y[i]) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
      }
    }
    return best;
  }

  // Straight-line walkability (so melee units don't chase across rivers/cliffs).
  private clearLine(i: number, x1: number, y1: number): boolean {
    const x0 = this.x[i], y0 = this.y[i];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / 24);
    let prev = this.tile[i];
    for (let k = 1; k <= n; k++) {
      const t = this.tileAt(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
      if (t !== prev && !this.stepSim(prev, t)) return false;
      prev = t;
    }
    return true;
  }

  private findBuilding(i: number): number {
    const s = this.side[i];
    const r = STATS[this.type[i]].aggro * T;
    const bs = this.m.buildings;
    for (let k = 0; k < bs.length; k++) {
      const b = bs[k];
      if (b.side === s || b.hp <= 0) continue;
      if (this.distToBuilding(i, b) < r) return k;
    }
    return -1;
  }

  distToBuilding(i: number, b: Building) {
    const cx = Math.max(b.tx * T, Math.min((b.tx + b.fw) * T, this.x[i]));
    const cy = Math.max(b.ty * T, Math.min((b.ty + b.fh) * T, this.y[i]));
    return Math.hypot(cx - this.x[i], cy - this.y[i]);
  }

  private separate(i: number) {
    const t = this.tile[i];
    let pushX = 0, pushY = 0, c = 0;
    const px = this.x[i], py = this.y[i];
    for (let j = this.head[t]; j >= 0 && c < 8; j = this.next[j], c++) {
      if (j === i) continue;
      let dx = px - this.x[j];
      let dy = py - this.y[j];
      const d2 = dx * dx + dy * dy;
      if (d2 >= SEP * SEP) continue;
      if (d2 < 0.01) { dx = this.rnd() - 0.5; dy = this.rnd() - 0.5; }
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const k = (SEP - d) / d * 0.35;
      pushX += dx * k;
      pushY += dy * k;
    }
    if (pushX || pushY) this.tryMove(i, Math.max(-4, Math.min(4, pushX)), Math.max(-4, Math.min(4, pushY)));
  }

  damage(j: number, amount: number, attackerSide: number) {
    if (!this.alive[j]) return;
    if (this.hold[j]) amount *= 0.6;
    this.hp[j] -= amount;
    if (this.hp[j] <= 0) {
      this.alive[j] = 0;
      const s = this.side[j];
      this.aliveCount[s]--;
      this.typeCount[s][this.type[j]]--;
      this.kills[attackerSide]++;
      this.setField(j, -1);
      this.sel[j] = 0;
      this.addFx(FX_DUST, this.x[j], this.y[j], this.rnd() < 0.5 ? 0 : 1);
    }
  }

  private damageBuilding(k: number, amount: number) {
    const b = this.m.buildings[k];
    if (b.hp <= 0) return;
    b.hp -= amount;
    if (b.hp <= 0) {
      b.hp = 0;
      for (let y = b.ty; y < b.ty + b.fh; y++) for (let x = b.tx; x < b.tx + b.fw; x++) this.m.block[y * MW + x] = 0;
      for (let e = 0; e < 5; e++) this.addFx(FX_EXPLOSION, (b.tx + this.rnd() * b.fw) * T, (b.ty + b.fh - this.rnd() * 3) * T, e & 1);
    }
  }

  private updateUnit(i: number, dt: number) {
    const t = this.type[i];
    const st = STATS[t];
    const s = this.side[i];
    this.cd[i] -= dt;
    const retarget = (i + this.tick) % 8 === 0;

    // --- validate / acquire target
    let tg = this.target[i];
    if (tg >= 0) {
      const lost = !this.alive[tg] || (t === MONK ? this.hp[tg] >= STATS[this.type[tg]].hp : !this.targetable(s, tg));
      if (lost) tg = -1;
    }
    if (retarget && (tg < 0 || t === ARCHER)) {
      if (t === MONK) tg = this.findWounded(i, 4);
      else {
        let range = st.aggro;
        if (t === ARCHER && this.m.level[this.tile[i]] > 0) range += 2;
        const e = this.findEnemy(i, this.hold[i] && t !== ARCHER ? 2 : range);
        if (e >= 0 && (t === ARCHER || this.clearLine(i, this.x[e], this.y[e]))) tg = e;
        else if (t === ARCHER) tg = -1;
      }
    }
    this.target[i] = tg;
    let bt = this.btarget[i];
    if (bt >= 0 && this.m.buildings[bt].hp <= 0) bt = -1;
    if (tg < 0 && bt < 0 && t !== MONK && (i + this.tick) % 16 === 0) bt = this.findBuilding(i);
    this.btarget[i] = bt;

    // --- engage
    if (tg >= 0 || bt >= 0) {
      let dx: number, dy: number, dist: number;
      if (tg >= 0) {
        dx = this.x[tg] - this.x[i];
        dy = this.y[tg] - this.y[i];
        dist = Math.hypot(dx, dy);
      } else {
        const b = this.m.buildings[bt];
        dx = (b.tx + b.fw / 2) * T - this.x[i];
        dy = (b.ty + b.fh / 2) * T - this.y[i];
        dist = this.distToBuilding(i, b);
      }
      let range = st.range;
      const high = tg >= 0 && this.m.level[this.tile[i]] > this.m.level[this.tile[tg]];
      if (t === ARCHER && high) range += 2 * T;
      if (dist <= range + (t === ARCHER || t === MONK ? 0 : 14)) {
        this.state[i] = S_ATTACK;
        if (Math.abs(dx) > 4) this.face[i] = dx > 0 ? 1 : -1;
        if (this.cd[i] <= 0) {
          this.cd[i] = st.cd * (0.85 + this.rnd() * 0.3);
          this.attack(i, tg, bt, dx, dy, dist, high);
        } else if (this.animDone(i) || this.anim[i] === this.runAnim(i)) {
          this.setAnim(i, this.idleAnim(i));
        }
        this.separate(i);
        return;
      }
      if (!this.hold[i]) {
        const sp = (st.speed * tileSpeed(this.m, this.tile[i]) * dt) / (dist || 1);
        this.face[i] = dx > 0 ? 1 : -1;
        if (this.tryMove(i, dx * sp, dy * sp)) {
          this.state[i] = S_MOVE;
          this.setAnim(i, this.runAnim(i));
          this.stuck[i] = 0;
          this.separate(i);
          return;
        }
        this.stuck[i] += dt;
        if (this.stuck[i] > 0.6) { this.target[i] = -1; this.btarget[i] = -1; this.stuck[i] = 0; }
      }
    }

    // --- follow flow field
    const fi = this.field[i];
    if (fi >= 0 && this.fields[fi]) {
      const f = this.fields[fi]!;
      const cur = this.tile[i];
      const d = f.dir[cur];
      if (d === DIR_NONE) {
        this.setField(i, -1);
      } else if (d !== DIR_GOAL) {
        const tx = (cur % MW) + DX[d], ty = ((cur / MW) | 0) + DY[d];
        let vx = tx * T + 32 - this.x[i];
        let vy = ty * T + 32 - this.y[i];
        const l = Math.hypot(vx, vy) || 1;
        const dl = Math.hypot(DX[d], DY[d]);
        vx = vx / l * 0.6 + (DX[d] / dl) * 0.4;
        vy = vy / l * 0.6 + (DY[d] / dl) * 0.4;
        const sp = st.speed * tileSpeed(this.m, cur) * dt;
        if (Math.abs(vx) > 0.1) this.face[i] = vx > 0 ? 1 : -1;
        if (!this.tryMove(i, vx * sp, vy * sp)) this.tryMove(i, (this.rnd() - 0.5) * 6, (this.rnd() - 0.5) * 6);
        this.state[i] = S_MOVE;
        this.setAnim(i, this.runAnim(i));
        this.separate(i);
        return;
      }
    }
    this.state[i] = S_IDLE;
    const a = this.anim[i];
    const ad = ANIMS[a];
    if (ad.loop || this.animDone(i)) this.setAnim(i, this.idleAnim(i));
    if ((i + this.tick) % 2 === 0) this.separate(i);
  }

  private attack(i: number, tg: number, bt: number, dx: number, dy: number, dist: number, high: boolean) {
    const t = this.type[i];
    const st = STATS[t];
    const s = this.side[i];
    const roll = 0.8 + this.rnd() * 0.4;
    switch (t) {
      case WARRIOR:
        this.anim[i] = this.rnd() < 0.5 ? AN.W_ATK1 : AN.W_ATK2;
        this.animT[i] = this.time;
        break;
      case LANCER: {
        const [d, flip] = lancerDir(dx, dy);
        this.face[i] = flip ? -1 : 1;
        this.anim[i] = AN.L_ATK[d];
        this.animT[i] = this.time;
        break;
      }
      case ARCHER: {
        this.anim[i] = AN.A_SHOOT;
        this.animT[i] = this.time;
        if (this.arN < MAX_ARROWS) {
          const k = this.arN++;
          this.arX0[k] = this.x[i] + this.face[i] * 10;
          this.arY0[k] = this.y[i] - 34;
          this.arX1[k] = this.x[i] + dx;
          this.arY1[k] = this.y[i] + dy - (tg >= 0 ? 24 : 40);
          this.arT[k] = 0;
          this.arDur[k] = Math.max(0.25, dist / 520);
          this.arTgt[k] = tg >= 0 ? tg : -2 - bt;
          this.arDmg[k] = st.dmg * roll * (high ? 1.3 : 1);
          this.arSide[k] = s;
        }
        return;
      }
      case MONK:
        this.anim[i] = AN.M_HEAL;
        this.animT[i] = this.time;
        if (tg >= 0) {
          this.hp[tg] = Math.min(STATS[this.type[tg]].hp, this.hp[tg] + st.dmg);
          this.addFx(FX_HEAL, this.x[tg], this.y[tg], 0);
        }
        return;
      default:
        this.anim[i] = AN.P_INT.Knife;
        this.animT[i] = this.time;
    }
    if (tg >= 0) this.damage(tg, st.dmg * roll, s);
    else if (bt >= 0) this.damageBuilding(bt, st.dmg * roll);
  }

  private updateArrows(dt: number) {
    let k = 0;
    while (k < this.arN) {
      this.arT[k] += dt;
      if (this.arT[k] >= this.arDur[k]) {
        const tg = this.arTgt[k];
        if (tg >= 0) {
          if (this.alive[tg] && Math.hypot(this.x[tg] - this.arX1[k], this.y[tg] - 24 - this.arY1[k]) < 48) this.damage(tg, this.arDmg[k], this.arSide[k]);
        } else if (tg <= -2) this.damageBuilding(-2 - tg, this.arDmg[k]);
        // swap-remove
        const l = --this.arN;
        this.arX0[k] = this.arX0[l]; this.arY0[k] = this.arY0[l];
        this.arX1[k] = this.arX1[l]; this.arY1[k] = this.arY1[l];
        this.arT[k] = this.arT[l]; this.arDur[k] = this.arDur[l];
        this.arTgt[k] = this.arTgt[l]; this.arDmg[k] = this.arDmg[l]; this.arSide[k] = this.arSide[l];
        continue;
      }
      k++;
    }
  }

  // Workers: go to node → interact → carry resource back to the castle.
  private updatePawn(i: number, dt: number) {
    if ((i + this.tick) % 16 === 0) {
      const e = this.findEnemy(i, 3);
      if (e >= 0) {
        this.task[i] = TK_FIGHT;
        this.target[i] = e;
        return;
      }
    }
    const s = this.side[i];
    const task = this.task[i];
    const tools = [TOOL_PICK, TOOL_AXE, TOOL_KNIFE, TOOL_HAMMER, TOOL_NONE];
    const carry = [TOOL_GOLD, TOOL_WOOD, TOOL_MEAT, TOOL_HAMMER, TOOL_NONE];
    const interact = [AN.P_INT.Pickaxe, AN.P_INT.Axe, AN.P_INT.Knife, AN.P_INT.Hammer, AN.P_IDLE[0]];
    const walkTo = (x: number, y: number, a: number) => {
      const dx = x - this.x[i], dy = y - this.y[i];
      const d = Math.hypot(dx, dy);
      if (d < 10) return true;
      const sp = STATS[PAWN].speed * dt / d;
      this.face[i] = dx > 0 ? 1 : -1;
      if (!this.tryMove(i, dx * sp, dy * sp)) {
        this.stuck[i] += dt;
        if (this.stuck[i] > 1.5) { this.stuck[i] = 0; this.pickNode(i); }
      }
      this.setAnim(i, a);
      this.state[i] = S_MOVE;
      return false;
    };
    switch (this.phase[i]) {
      case PH_GO:
        if (walkTo(this.gx[i], this.gy[i], AN.P_RUN[tools[task]])) {
          this.phase[i] = PH_WORK;
          this.taskT[i] = 3 + this.rnd() * 4;
          if (task === TK_IDLE) this.taskT[i] = 2 + this.rnd() * 3;
        }
        break;
      case PH_WORK:
        this.state[i] = S_WORK;
        this.setAnim(i, task === TK_IDLE ? AN.P_IDLE[0] : interact[task]);
        this.taskT[i] -= dt;
        if (this.taskT[i] <= 0) {
          if (task === TK_BUILD || task === TK_IDLE) {
            this.phase[i] = PH_DROP;
            this.taskT[i] = 1.5;
          } else this.phase[i] = PH_BACK;
        }
        break;
      case PH_BACK: {
        const [dx, dy] = this.m.pawnNodes[s].drop;
        if (walkTo(dx + (i % 7 - 3) * 12, dy + (i % 5 - 2) * 8, AN.P_RUN[carry[task]])) {
          this.phase[i] = PH_DROP;
          this.taskT[i] = 0.8;
          const r = this.res[s];
          if (task === TK_GOLD) r.gold++;
          else if (task === TK_WOOD) r.wood++;
          else if (task === TK_MEAT) r.meat++;
        }
        break;
      }
      default:
        this.state[i] = S_IDLE;
        this.setAnim(i, AN.P_IDLE[carry[task]]);
        this.taskT[i] -= dt;
        if (this.taskT[i] <= 0) {
          this.phase[i] = PH_GO;
          this.pickNode(i);
        }
    }
  }

  private updateSheep(dt: number) {
    for (let i = 0; i < this.shN; i++) {
      this.shT[i] -= dt;
      if (this.shS[i] === 1) {
        const dx = this.shGX[i] - this.shX[i], dy = this.shGY[i] - this.shY[i];
        const d = Math.hypot(dx, dy);
        if (d < 4) { this.shS[i] = this.rnd() < 0.6 ? 2 : 0; this.shT[i] = 2 + this.rnd() * 5; continue; }
        const nx = this.shX[i] + (dx / d) * 22 * dt, ny = this.shY[i] + (dy / d) * 22 * dt;
        if (passable(this.m, this.tileAt(nx, ny))) { this.shX[i] = nx; this.shY[i] = ny; }
        else this.shS[i] = 0;
        this.shF[i] = dx > 0 ? 1 : -1;
      } else if (this.shT[i] <= 0) {
        const [px, py] = this.m.pasture[this.shSide[i]];
        this.shGX[i] = px + (this.rnd() - 0.5) * 9 * T;
        this.shGY[i] = py + (this.rnd() - 0.5) * 6 * T;
        this.shS[i] = 1;
      }
    }
  }
}
