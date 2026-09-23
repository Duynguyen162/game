// Loads the Tiny Swords pack from /public/assets and exposes sprite sheets.
import { COLORS, type TeamColor } from "./constants";
import { BUILDING_KINDS } from "./map";

export function assetUrl(p: string) {
  return "/assets/" + p.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------- unit types & animations

export const WARRIOR = 0;
export const ARCHER = 1;
export const LANCER = 2;
export const MONK = 3;
export const PAWN = 4;
export const UNIT_NAMES = ["Warrior", "Archer", "Lancer", "Monk", "Pawn"] as const;
export const UNIT_VI = ["Kiếm sĩ", "Cung thủ", "Thương kỵ", "Tu sĩ", "Dân phu"];

export interface AnimDef {
  file: string; // path relative to "Units/<Color> Units/"
  frames: number;
  size: number; // frame size (square)
  fps: number;
  loop: boolean;
}

const A = (file: string, frames: number, fps: number, loop = true, size = 192): AnimDef => ({ file, frames, size, fps, loop });
const LANCER_DIRS = ["Right", "DownRight", "Down", "UpRight", "Up"] as const;
export const PAWN_TOOLS = ["", " Axe", " Gold", " Hammer", " Knife", " Meat", " Pickaxe", " Wood"] as const;

export const ANIMS: AnimDef[] = [];
const add = (d: AnimDef) => ANIMS.push(d) - 1;

export const AN = {
  W_IDLE: add(A("Warrior/Warrior_Idle.png", 8, 8)),
  W_RUN: add(A("Warrior/Warrior_Run.png", 6, 10)),
  W_ATK1: add(A("Warrior/Warrior_Attack1.png", 4, 10, false)),
  W_ATK2: add(A("Warrior/Warrior_Attack2.png", 4, 10, false)),
  W_GUARD: add(A("Warrior/Warrior_Guard.png", 6, 8)),
  A_IDLE: add(A("Archer/Archer_Idle.png", 6, 8)),
  A_RUN: add(A("Archer/Archer_Run.png", 4, 10)),
  A_SHOOT: add(A("Archer/Archer_Shoot.png", 8, 12, false)),
  L_IDLE: add(A("Lancer/Lancer_Idle.png", 12, 10, true, 320)),
  L_RUN: add(A("Lancer/Lancer_Run.png", 6, 10, true, 320)),
  L_ATK: LANCER_DIRS.map((d) => add(A(`Lancer/Lancer_${d}_Attack.png`, 3, 8, false, 320))),
  L_DEF: LANCER_DIRS.map((d) => add(A(`Lancer/Lancer_${d}_Defence.png`, 6, 8, true, 320))),
  M_IDLE: add(A("Monk/Idle.png", 6, 8)),
  M_RUN: add(A("Monk/Run.png", 4, 10)),
  M_HEAL: add(A("Monk/Heal.png", 11, 12, false)),
  M_HEAL_FX: add(A("Monk/Heal_Effect.png", 11, 14, false)),
  P_IDLE: PAWN_TOOLS.map((t) => add(A(`Pawn/Pawn_Idle${t}.png`, 8, 8))),
  P_RUN: PAWN_TOOLS.map((t) => add(A(`Pawn/Pawn_Run${t}.png`, 6, 10))),
  P_INT: {
    Axe: add(A("Pawn/Pawn_Interact Axe.png", 6, 10)),
    Hammer: add(A("Pawn/Pawn_Interact Hammer.png", 3, 8)),
    Knife: add(A("Pawn/Pawn_Interact Knife.png", 4, 10)),
    Pickaxe: add(A("Pawn/Pawn_Interact Pickaxe.png", 6, 10)),
  },
};

// Lancer sheet index from a direction vector (screen space, y down); returns [dirIndex, flip]
export function lancerDir(dx: number, dy: number): [number, boolean] {
  const flip = dx < 0;
  const a = Math.atan2(dy, Math.abs(dx)); // -pi/2 (up) .. pi/2 (down)
  const s = a / (Math.PI / 2);
  if (s < -0.75) return [4, flip];
  if (s < -0.25) return [3, flip];
  if (s < 0.25) return [0, flip];
  if (s < 0.75) return [1, flip];
  return [2, flip];
}

export const unitPath = (c: TeamColor, file: string) => `Units/${c} Units/${file}`;
export const buildingPath = (c: TeamColor, kind: string) => `Buildings/${c} Buildings/${kind}.png`;

// ---------------------------------------------------------------- static paths

const R = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1));
export const P = {
  tilemap: R(5, (i) => `Terrain/Tileset/Tilemap_color${i}.png`),
  waterBg: "Terrain/Tileset/Water Background color.png",
  foam: "Terrain/Tileset/Water Foam.png",
  shadow: "Terrain/Tileset/Shadow.png",
  bushes: R(4, (i) => `Terrain/Decorations/Bushes/Bushe${i}.png`),
  clouds: R(8, (i) => `Terrain/Decorations/Clouds/Clouds_0${i}.png`),
  waterRocks: R(4, (i) => `Terrain/Decorations/Rocks in the Water/Water Rocks_0${i}.png`),
  rocks: R(4, (i) => `Terrain/Decorations/Rocks/Rock${i}.png`),
  duck: "Terrain/Decorations/Rubber Duck/Rubber duck.png",
  goldRes: "Terrain/Resources/Gold/Gold Resource/Gold_Resource.png",
  goldResHi: "Terrain/Resources/Gold/Gold Resource/Gold_Resource_Highlight.png",
  goldStones: R(6, (i) => `Terrain/Resources/Gold/Gold Stones/Gold Stone ${i}.png`),
  goldStonesHi: R(6, (i) => `Terrain/Resources/Gold/Gold Stones/Gold Stone ${i}_Highlight.png`),
  meatRes: "Terrain/Resources/Meat/Meat Resource/Meat Resource.png",
  sheepGrass: "Terrain/Resources/Meat/Sheep/Sheep_Grass.png",
  sheepIdle: "Terrain/Resources/Meat/Sheep/Sheep_Idle.png",
  sheepMove: "Terrain/Resources/Meat/Sheep/Sheep_Move.png",
  tools: R(4, (i) => `Terrain/Resources/Tools/Tool_0${i}.png`),
  stumps: R(4, (i) => `Terrain/Resources/Wood/Trees/Stump ${i}.png`),
  trees: R(4, (i) => `Terrain/Resources/Wood/Trees/Tree${i}.png`),
  woodRes: "Terrain/Resources/Wood/Wood Resource/Wood Resource.png",
  dust: ["Particle FX/Dust_01.png", "Particle FX/Dust_02.png"],
  explosion: ["Particle FX/Explosion_01.png", "Particle FX/Explosion_02.png"],
  fire: ["Particle FX/Fire_01.png", "Particle FX/Fire_02.png", "Particle FX/Fire_03.png"],
  splash: "Particle FX/Water Splash.png",
};

export function staticPaths(): string[] {
  const out: string[] = [];
  for (const v of Object.values(P)) {
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

export function colorPaths(c: TeamColor): string[] {
  const s = new Set<string>();
  for (const a of ANIMS) s.add(unitPath(c, a.file));
  s.add(unitPath(c, "Archer/Arrow.png"));
  for (const k of BUILDING_KINDS) s.add(buildingPath(c, k));
  return [...s];
}

export const ALL_COLORS = COLORS;

// ---------------------------------------------------------------- loader

export class Assets {
  private images = new Map<string, HTMLImageElement>();
  private flips = new Map<string, HTMLCanvasElement>();
  private pending = new Map<string, Promise<void>>();
  waterColor = "#47aba9";

  load(paths: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    let done = 0;
    const total = paths.length;
    return Promise.all(
      paths.map((p) => {
        let pr = this.pending.get(p);
        if (!pr) {
          pr = new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.images.set(p, img);
              resolve();
            };
            img.onerror = () => {
              console.warn("asset failed", p);
              resolve();
            };
            img.src = assetUrl(p);
          });
          this.pending.set(p, pr);
        }
        return pr.then(() => onProgress?.(++done, total));
      }),
    ).then(() => {
      const bg = this.images.get(P.waterBg);
      if (bg) {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const g = c.getContext("2d")!;
        g.drawImage(bg, 0, 0, 1, 1);
        const d = g.getImageData(0, 0, 1, 1).data;
        this.waterColor = `rgb(${d[0]},${d[1]},${d[2]})`;
      }
    });
  }

  has(p: string) {
    return this.images.has(p);
  }

  get(p: string): HTMLImageElement | undefined {
    return this.images.get(p);
  }

  // Horizontally mirrored copy of a whole sheet: frame f becomes frame (n-1-f).
  flipped(p: string): HTMLCanvasElement | undefined {
    let c = this.flips.get(p);
    if (c) return c;
    const img = this.images.get(p);
    if (!img) return undefined;
    c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.translate(img.width, 0);
    g.scale(-1, 1);
    g.drawImage(img, 0, 0);
    this.flips.set(p, c);
    return c;
  }
}
