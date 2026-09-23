// Canvas 2D renderer with three levels of detail:
//   far  (tile < 14px): cached terrain chunks @4px/tile with trees baked in, units as dots
//   mid  (tile < 30px): cached terrain chunks @16px/tile with trees baked in, units as dots
//   near (tile ≥ 30px): terrain drawn live (animated foam / water rocks / bushes), trees,
//                       buildings and unit sprites depth-sorted, forest canopy fades to 40%
import { type Assets } from "./assets";
import { ANIMS, AN, P, PAWN, buildingPath, unitPath } from "@game/shared";
import {
  COLOR_HEX, FOREST_REVEAL_ALPHA, FORD, LAND, MAX_LEVEL, MH, MW, N, RAMP_L_TOP, RAMP_R_TOP, T, WATER,
  WORLD_H, WORLD_W, type TeamColor,
} from "@game/shared";
import {
  BH, BK, BW, D_BUSH, D_DUCK, D_GOLD, D_GOLD_RES, D_MEAT_RES, D_ROCK, D_STUMP, D_TOOL, D_WOOD_RES, D_WROCK,
  type Building, type GameMap,
} from "@game/shared";
import { hash2 } from "@game/shared";
import { FX_DUST, FX_EXPLOSION, FX_HEAL, FX_SPLASH, VIS_RADIUS, type World } from "@game/shared";

export interface Camera { x: number; y: number; zoom: number; targetX?: number; targetY?: number; }

export interface ViewOptions {
  viewer: number; // -1 spectator, 0 west, 1 east
  colors: [TeamColor, TeamColor];
  showClouds: boolean;
  showNav: boolean;
}

const UNIT_SCALE = 0.72;
const LAYER_TILESET = [0, 2, 1, 3]; // Tilemap_colorN index per elevation level
const BUILD_MARGIN: Record<string, number> = { Castle: 8, Barracks: 12, Archery: 12, Monastery: 11, Tower: 27, House1: 20, House2: 20, House3: 20 };

interface Chunk { canvas: HTMLCanvasElement; }

export class Renderer {
  private chunks = new Map<string, Chunk>();
  private far = new Map<string, Chunk>();
  minimap: HTMLCanvasElement;
  dpr = 1;
  // ---- Sương mù chiến tranh: canvas 1px/ô, lerp alpha để mắp sương không giật
  private fogCanvas: HTMLCanvasElement;
  private fogCtx: CanvasRenderingContext2D;
  private fogImg: ImageData;           // buffer 4-byte/ô
  private fogAlpha = new Float32Array(N); // alpha hiện tại (lerp’d), 0.0–1.0

  constructor(private m: GameMap, private a: Assets) {
    this.minimap = this.buildMinimap();
    // Khởi tạo fog canvas (512x512 pixel, mỗi pixel ứng với 1 ô bản đồ)
    this.fogCanvas = document.createElement("canvas");
    this.fogCanvas.width = MW;
    this.fogCanvas.height = MH;
    this.fogCtx = this.fogCanvas.getContext("2d")!;
    this.fogImg = this.fogCtx.createImageData(MW, MH);
    // Khởi tạo mờ 55% (đã biết địa hình, chưa có tầm nhìn) — không đen đặc
    this.fogAlpha.fill(0.55);
  }

  dispose() {
    this.chunks.clear();
    this.far.clear();
  }

  // ------------------------------------------------------------ minimap (1px per tile)

  private buildMinimap() {
    const c = document.createElement("canvas");
    c.width = MW;
    c.height = MH;
    const g = c.getContext("2d")!;
    const img = g.createImageData(MW, MH);
    const m = this.m;
    const put = (i: number, r: number, gg: number, b: number) => { img.data[i * 4] = r; img.data[i * 4 + 1] = gg; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255; };
    for (let i = 0; i < N; i++) {
      const gr = m.ground[i];
      if (gr === WATER) put(i, 71, 171, 169);
      else if (gr === FORD) put(i, 140, 205, 190);
      else if (gr === 3) put(i, 168, 110, 60);
      else if (m.block[i]) put(i, 90, 80, 70);
      else if (m.cliff[i]) put(i, 85, 110, 115);
      else if (m.ramp[i]) put(i, 200, 190, 110);
      else if (m.forest[i]) put(i, 44, 92, 52);
      else if (m.level[i] === 1) put(i, 120, 165, 70);
      else if (m.level[i] === 2) put(i, 150, 185, 70);
      else if (m.level[i] === 3) put(i, 140, 140, 70);
      else put(i, 165, 190, 80);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ------------------------------------------------------------ terrain

  private isLand(x: number, y: number) {
    if (x < 0 || y < 0 || x >= MW || y >= MH) return true;
    return this.m.ground[y * MW + x] === LAND;
  }
  private inLayer(x: number, y: number, l: number) {
    if (x < 0 || y < 0 || x >= MW || y >= MH) return false;
    return this.m.level[y * MW + x] >= l;
  }

  // Autotile: column from W/E neighbours, row from N/S neighbours (Tiny Swords 3x3 + strips layout)
  private auto(x: number, y: number, inSet: (x: number, y: number) => boolean): [number, number] {
    const w = inSet(x - 1, y), e = inSet(x + 1, y), n = inSet(x, y - 1), s = inSet(x, y + 1);
    const col = w && e ? 1 : !w && e ? 0 : w && !e ? 2 : 3;
    const row = n && s ? 1 : !n && s ? 0 : n && !s ? 2 : 3;
    return [col, row];
  }

  drawTerrain(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, time: number, animated: boolean, trees: boolean) {
    const m = this.m, a = this.a;
    const tm = P.tilemap.map((p) => a.get(p)!);
    const foam = a.get(P.foam), shadow = a.get(P.shadow);
    const M = 2;
    const ex0 = Math.max(0, x0 - M), ey0 = Math.max(0, y0 - M);
    const ex1 = Math.min(MW, x1 + M), ey1 = Math.min(MH, y1 + M);
    g.save();
    g.beginPath();
    g.rect(x0 * T, y0 * T, (x1 - x0) * T, (y1 - y0) * T);
    g.clip();
    g.fillStyle = a.waterColor;
    g.fillRect(x0 * T, y0 * T, (x1 - x0) * T, (y1 - y0) * T);

    // shallow fords
    g.fillStyle = "rgba(200,240,220,0.32)";
    for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) if (m.ground[y * MW + x] === FORD) g.fillRect(x * T, y * T, T, T);

    // foam around shorelines
    if (foam) {
      for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
        const i = y * MW + x;
        if (m.ground[i] !== LAND) continue;
        let wet = false;
        for (let dy = -1; dy <= 1 && !wet; dy++) for (let dx = -1; dx <= 1; dx++) if (!this.isLand(x + dx, y + dy)) { wet = true; break; }
        if (!wet) continue;
        const h = hash2(x, y, 3);
        const f = animated ? Math.floor(time * 8 + h * 16) % 16 : Math.floor(h * 16);
        g.drawImage(foam, f * 192, 0, 192, 192, x * T - 64, y * T - 64, 192, 192);
      }
    }
    // flat ground (level 0 art under everything)
    const isLand = (x: number, y: number) => this.isLand(x, y);
    for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
      if (m.ground[y * MW + x] !== LAND) continue;
      const [c, r] = this.auto(x, y, isLand);
      g.drawImage(tm[0], c * 64, r * 64, 64, 64, x * T, y * T, T, T);
    }
    // water rocks & duck (below bridges)
    this.drawDecor(g, x0, y0, x1, y1, time, animated, true);
    this.drawBridges(g, x0, y0, x1, y1);

    // stacked highlands
    for (let l = 1; l <= MAX_LEVEL; l++) {
      const inL = (x: number, y: number) => this.inLayer(x, y, l);
      const set = tm[LAYER_TILESET[l]];
      if (shadow) {
        for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
          if (!inL(x, y)) continue;
          if (inL(x - 1, y) && inL(x + 1, y) && inL(x, y - 1) && inL(x, y + 1)) continue;
          g.drawImage(shadow, x * T - 64, y * T - 40, 192, 192);
        }
      }
      for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
        const i = y * MW + x;
        if (m.cliff[i] === l && y > 0) {
          const [c] = this.auto(x, y - 1, inL);
          g.drawImage(set, (5 + c) * 64, 5 * 64, 64, 64, x * T, y * T, T, T);
        }
      }
      for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
        if (!inL(x, y)) continue;
        const [c, r] = this.auto(x, y, inL);
        g.drawImage(set, (5 + c) * 64, r * 64, 64, 64, x * T, y * T, T, T);
      }
      for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
        const i = y * MW + x;
        const r = m.ramp[i];
        if ((r === RAMP_L_TOP || r === RAMP_R_TOP) && m.level[i] === l - 1) {
          g.drawImage(set, r === RAMP_L_TOP ? 0 : 192, 256, 64, 128, x * T, y * T, T, T * 2);
        }
      }
    }
    this.drawDecor(g, x0, y0, x1, y1, time, animated, false);
    if (trees) this.drawTreesBaked(g, x0, y0, x1, y1);
    g.restore();
  }

  private drawBridges(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
    for (const b of this.m.bridges) {
      if (b.x1 + 1 < x0 || b.x0 - 1 > x1 || b.y1 + 1 < y0 || b.y0 - 1 > y1) continue;
      const X0 = b.x0 * T - 24, X1 = (b.x1 + 1) * T + 24;
      const Y0 = b.y0 * T + 10, Y1 = (b.y1 + 1) * T - 8;
      const w = X1 - X0, h = Y1 - Y0;
      g.fillStyle = "rgba(20,40,50,0.28)";
      g.fillRect(X0, Y0 + 14, w, h);
      g.fillStyle = "#3b2416";
      g.fillRect(X0 - 4, Y0 - 4, w + 8, h + 8);
      for (let x = X0, k = 0; x < X1; x += 16, k++) {
        g.fillStyle = k % 2 ? "#b37443" : "#c4834d";
        g.fillRect(x, Y0, Math.min(14, X1 - x), h);
        g.fillStyle = "#d9a066";
        g.fillRect(x, Y0, Math.min(14, X1 - x), 4);
        g.fillStyle = "#6e4225";
        g.fillRect(x + 4, Y0 + 20 + ((k * 37) % (h - 40)), 3, 3);
      }
      for (const ry of [Y0 - 10, Y1 - 4]) {
        g.fillStyle = "#3b2416";
        g.fillRect(X0 - 8, ry - 2, w + 16, 16);
        g.fillStyle = "#8a552d";
        g.fillRect(X0 - 6, ry, w + 12, 10);
        g.fillStyle = "#c98b52";
        g.fillRect(X0 - 6, ry, w + 12, 3);
        for (let x = X0; x <= X1; x += 96) {
          g.fillStyle = "#3b2416";
          g.fillRect(x - 8, ry - 10, 16, 26);
          g.fillStyle = "#9b6236";
          g.fillRect(x - 6, ry - 8, 12, 20);
          g.fillStyle = "#d9a066";
          g.fillRect(x - 6, ry - 8, 12, 4);
        }
      }
    }
  }

  private forBuckets(x0: number, y0: number, x1: number, y1: number, padX: number, padDown: number, fn: (b: number) => void) {
    const bx0 = Math.max(0, Math.floor((x0 - padX) / BK)), bx1 = Math.min(BW - 1, Math.floor((x1 + padX) / BK));
    const by0 = Math.max(0, Math.floor(y0 / BK)), by1 = Math.min(BH - 1, Math.floor((y1 + padDown) / BK));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) fn(by * BW + bx);
  }

  private drawDecor(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, time: number, animated: boolean, water: boolean) {
    const a = this.a, m = this.m;
    this.forBuckets(x0, y0, x1, y1, 2, 4, (b) => {
      for (const di of m.decorBuckets[b]) {
        const d = m.decor[di];
        const isWater = d.k === D_WROCK || d.k === D_DUCK;
        if (isWater !== water) continue;
        let img: HTMLImageElement | undefined;
        switch (d.k) {
          case D_BUSH: {
            img = a.get(P.bushes[d.v]);
            if (!img) break;
            const f = animated ? Math.floor(time * 6 + d.ph * 8) % 8 : 0;
            g.drawImage(img, f * 128, 0, 128, 128, d.x - 64, d.y - 76, 128, 128);
            break;
          }
          case D_WROCK: {
            img = a.get(P.waterRocks[d.v]);
            if (!img) break;
            const f = animated ? Math.floor(time * 8 + d.ph * 16) % 16 : 0;
            g.drawImage(img, f * 64, 0, 64, 64, d.x - 32, d.y - 40, 64, 64);
            break;
          }
          case D_DUCK: {
            img = a.get(P.duck);
            if (!img) break;
            const f = animated ? Math.floor(time * 4) % 3 : 0;
            g.drawImage(img, f * 32, 0, 32, 32, d.x - 16 + Math.sin(time * 0.5) * 20, d.y - 27, 32, 32);
            break;
          }
          case D_ROCK: img = a.get(P.rocks[d.v]); if (img) g.drawImage(img, d.x - 31, d.y - 48); break;
          case D_STUMP: img = a.get(P.stumps[d.v]); if (img) g.drawImage(img, d.x - 98, d.y - 236); break;
          case D_GOLD: img = a.get(P.goldStones[d.v]); if (img) g.drawImage(img, d.x - 64, d.y - 76); break;
          case D_GOLD_RES: img = a.get(P.goldRes); if (img) g.drawImage(img, d.x - 64, d.y - 80); break;
          case D_WOOD_RES: img = a.get(P.woodRes); if (img) g.drawImage(img, d.x - 32, d.y - 45); break;
          case D_MEAT_RES: img = a.get(P.meatRes); if (img) g.drawImage(img, d.x - 32, d.y - 45); break;
          case D_TOOL: img = a.get(P.tools[d.v]); if (img) g.drawImage(img, d.x - 32, d.y - 45); break;
        }
      }
    });
  }

  private treeImg(k: number) {
    return this.a.get(P.trees[k]);
  }
  private drawTree(g: CanvasRenderingContext2D, t: number, frame: number) {
    const m = this.m;
    const k = m.treeKind[t];
    const img = this.treeImg(k);
    if (!img) return;
    const h = k < 2 ? 256 : 192;
    const ay = k < 2 ? 236 : 166;
    g.drawImage(img, frame * 192, 0, 192, h, m.treeX[t] - 96, m.treeY[t] - ay, 192, h);
  }
  private drawTreesBaked(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
    const m = this.m;
    const list: number[] = [];
    this.forBuckets(x0, y0, x1, y1, 2, 4, (b) => { for (const t of m.treeBuckets[b]) list.push(t); });
    list.sort((p, q) => m.treeY[p] - m.treeY[q]);
    for (const t of list) this.drawTree(g, t, 0);
  }

  // ------------------------------------------------------------ chunk cache

  private getChunk(level: 0 | 1, cx: number, cy: number, build: boolean): Chunk | undefined {
    const map = level === 0 ? this.far : this.chunks;
    const key = `${cx},${cy}`;
    const hit = map.get(key);
    if (hit) {
      if (level === 1) { map.delete(key); map.set(key, hit); }
      return hit;
    }
    if (!build) return undefined;
    const tiles = level === 0 ? 64 : 32;
    const ppt = level === 0 ? 4 : 16;
    const c = document.createElement("canvas");
    c.width = c.height = tiles * ppt;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    const s = ppt / T;
    g.setTransform(s, 0, 0, s, -cx * tiles * ppt, -cy * tiles * ppt);
    this.drawTerrain(g, cx * tiles, cy * tiles, (cx + 1) * tiles, (cy + 1) * tiles, 0, false, true);
    const ch = { canvas: c };
    map.set(key, ch);
    if (level === 1 && map.size > 110) map.delete(map.keys().next().value!);
    return ch;
  }

  // Far chunks are baked up front during loading (8x8 chunks of 64 tiles)
  buildFarChunk(k: number) {
    this.getChunk(0, k % (MW / 64), Math.floor(k / (MW / 64)), true);
  }

  // ------------------------------------------------------------ frame

  render(ctx: CanvasRenderingContext2D, w: World, cam: Camera, vw: number, vh: number, opt: ViewOptions, time: number, selBox: [number, number, number, number] | null, hoverTile: number, dt = 0.016) {
    const ts = T * cam.zoom;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = "#1d3b44";
    ctx.fillRect(0, 0, vw, vh);
    const wx0 = cam.x - vw / 2 / cam.zoom, wy0 = cam.y - vh / 2 / cam.zoom;
    const wx1 = cam.x + vw / 2 / cam.zoom, wy1 = cam.y + vh / 2 / cam.zoom;
    const tx0 = Math.max(0, Math.floor(wx0 / T)), ty0 = Math.max(0, Math.floor(wy0 / T));
    const tx1 = Math.min(MW, Math.ceil(wx1 / T)), ty1 = Math.min(MH, Math.ceil(wy1 / T));
    ctx.setTransform(cam.zoom * d, 0, 0, cam.zoom * d, -wx0 * cam.zoom * d, -wy0 * cam.zoom * d);

    const presence = this.revealPresence(w, opt.viewer);
    if (ts < 30) {
      const level: 0 | 1 = ts < 14 ? 0 : 1;
      const tiles = level === 0 ? 64 : 32;
      ctx.imageSmoothingEnabled = true;
      let built = 0;
      for (let cy = Math.floor(ty0 / tiles); cy * tiles < ty1; cy++) for (let cx = Math.floor(tx0 / tiles); cx * tiles < tx1; cx++) {
        if (level === 0) {
          const ch = this.getChunk(0, cx, cy, true)!;
          ctx.drawImage(ch.canvas, cx * 64 * T, cy * 64 * T, 64 * T, 64 * T);
          continue;
        }
        const had = this.chunks.has(`${cx},${cy}`);
        const ch = this.getChunk(1, cx, cy, built < 3);
        if (ch) {
          if (!had) built++;
          ctx.drawImage(ch.canvas, cx * 32 * T, cy * 32 * T, 32 * T, 32 * T);
        } else {
          // not built yet this frame: upscale the matching quarter of the far chunk
          const far = this.getChunk(0, cx >> 1, cy >> 1, true)!;
          ctx.drawImage(far.canvas, (cx & 1) * 128, (cy & 1) * 128, 128, 128, cx * 32 * T, cy * 32 * T, 32 * T, 32 * T);
        }
      }
      this.drawBuildings(ctx, w, opt, time, tx0, ty0, tx1, ty1, false);
      this.drawUnitDots(ctx, w, opt, presence, wx0, wy0, wx1, wy1, ts);
    } else {
      ctx.imageSmoothingEnabled = false;
      this.drawTerrain(ctx, tx0, ty0, tx1, ty1, time, true, false);
      this.drawSorted(ctx, w, opt, presence, time, tx0, ty0, tx1, ty1, wx0, wy0, wx1, wy1);
      this.drawArrows(ctx, w, opt, wx0, wy0, wx1, wy1);
      this.drawFx(ctx, w, wx0, wy0, wx1, wy1);
    }
    // ---- Sương mù: vẽ sau units, trước mây và UI
    this.drawFog(ctx, w, opt.viewer, wx0, wy0, wx1, wy1, dt);
    if (opt.showNav) this.drawNav(ctx, tx0, ty0, tx1, ty1);
    if (hoverTile >= 0 && ts >= 14) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 2 / cam.zoom;
      ctx.strokeRect((hoverTile % MW) * T, Math.floor(hoverTile / MW) * T, T, T);
    }
    if (opt.showClouds) this.drawClouds(ctx, time, wx0, wy0, wx1, wy1, ts);
    if (selBox) {
      ctx.setTransform(d, 0, 0, d, 0, 0);
      const [ax, ay, bx, by] = selBox;
      ctx.fillStyle = "rgba(255,240,180,0.12)";
      ctx.strokeStyle = "rgba(255,240,180,0.9)";
      ctx.lineWidth = 1.5;
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
      ctx.strokeRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    }
  }

  // Which forest zones are "opened" for the viewer (their own units inside).
  private revealPresence(w: World, viewer: number): Int32Array | null {
    if (viewer === 0 || viewer === 1) return w.presence[viewer];
    return null;
  }

  private unitVisible(w: World, i: number, opt: ViewOptions, presence: Int32Array | null) {
    // Lính của phe mình luôn thấy
    if (opt.viewer < 0 || w.side[i] === opt.viewer) return true;
    // Kiểm tra sương mù: ô có visCount > 0 mới thấy lính địch
    if (opt.viewer >= 0) {
      const vc = w.visCount[opt.viewer as 0 | 1];
      if (vc[w.tile[i]] === 0) return false;
    }
    // Kiểm tra rừng cây (cơ chế cũ)
    const z = this.m.forest[w.tile[i]];
    return z === 0 || (presence !== null && presence[z] > 0);
  }

  // ---- Sương mù chiến tranh: lerp alpha, vẽ lớp phủ lên bản đồ ----
  // Gọi sau khi đã vẽ xong terrain + lính
  private drawFog(ctx: CanvasRenderingContext2D, w: World, viewer: number, wx0: number, wy0: number, wx1: number, wy1: number, dt: number) {
    if (viewer < 0) return; // Spectator: không có sương mù
    const s = viewer as 0 | 1;
    const vc = w.visCount[s];
    const ex = w.explored[s];
    const fa = this.fogAlpha;
    const img = this.fogImg;
    const d = img.data;

    // Tile range cần cập nhật (chỉ vùng nhìn thấy + buffer 2 ô)
    const tx0 = Math.max(0, Math.floor(wx0 / T) - 2);
    const ty0 = Math.max(0, Math.floor(wy0 / T) - 2);
    const tx1 = Math.min(MW, Math.ceil(wx1 / T) + 2);
    const ty1 = Math.min(MH, Math.ceil(wy1 / T) + 2);

    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
      const t = ty * MW + tx;
      // Target alpha: đang thấy=0 (trong suốt), đã khám phá=0.55, chưa khám phá=1.0
      const target = vc[t] > 0 ? 0 : ex[t] ? 0.55 : 1.0;
      // Lerp mượt alpha để viền sương mù không giật khi cập nhật 3Hz
      fa[t] += (target - fa[t]) * Math.min(1, dt * 5);
      const a = (fa[t] * 255) | 0;
      const pi = t * 4;
      d[pi] = 0; d[pi+1] = 0; d[pi+2] = 0; d[pi+3] = a;
    }

    this.fogCtx.putImageData(this.fogImg, 0, 0);
    // Phóng to fog canvas lên bản đồ với imageSmoothingEnabled=true để viền mờ mềm
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(this.fogCanvas, 0, 0, WORLD_W, WORLD_H);
    ctx.restore();
  }

  private drawUnitDots(ctx: CanvasRenderingContext2D, w: World, opt: ViewOptions, presence: Int32Array | null, wx0: number, wy0: number, wx1: number, wy1: number, ts: number) {
    const r = Math.min(3, Math.max(1.1, ts * 0.1)) / (ts / T); // screen-space half size
    for (let s = 0; s < 2; s++) {
      ctx.fillStyle = COLOR_HEX[opt.colors[s]];
      ctx.beginPath();
      for (let i = 0; i < w.n; i++) {
        if (!w.alive[i] || w.side[i] !== s) continue;
        const x = w.x[i], y = w.y[i];
        if (x < wx0 || x > wx1 || y < wy0 || y > wy1) continue;
        if (!this.unitVisible(w, i, opt, presence)) continue;
        ctx.rect(x - r, y - r * 2, r * 2, r * 2);
      }
      ctx.fill();
    }
    ctx.fillStyle = "#fff6c8";
    ctx.beginPath();
    for (let i = 0; i < w.n; i++) {
      if (!w.sel[i] || !w.alive[i]) continue;
      const x = w.x[i], y = w.y[i];
      if (x < wx0 || x > wx1 || y < wy0 || y > wy1) continue;
      ctx.rect(x - r * 0.6, y - r * 1.6, r * 1.2, r * 1.2);
    }
    ctx.fill();
  }

  private drawBuildingSprite(ctx: CanvasRenderingContext2D, b: Building, color: TeamColor, time: number, fire: boolean) {
    const img = this.a.get(buildingPath(color, b.kind));
    if (!img) return;
    const bx = (b.tx + b.fw / 2) * T, by = (b.ty + b.fh) * T;
    if (b.hp <= 0) {
      const f = this.a.get(P.fire[2]);
      if (f && fire) ctx.drawImage(f, (Math.floor(time * 10) % 12) * 64, 0, 64, 64, bx - 32, by - 64, 64, 64);
      return;
    }
    ctx.drawImage(img, bx - img.width / 2, by - img.height + BUILD_MARGIN[b.kind]);
    if (fire && b.hp < b.maxHp * 0.6) {
      const n = b.hp < b.maxHp * 0.3 ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const fi = this.a.get(P.fire[k % 3]);
        if (!fi) continue;
        const frames = fi.width / 64;
        const f = Math.floor(time * 10 + k * 3) % frames;
        ctx.drawImage(fi, f * 64, 0, 64, 64, bx - 60 + k * 44, by - img.height * 0.55 - 64 + (k % 2) * 30, 64, 64);
      }
    }
    if (b.hp < b.maxHp) {
      const wd = img.width * 0.6;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(bx - wd / 2, by - img.height + 20, wd, 8);
      ctx.fillStyle = b.hp / b.maxHp > 0.4 ? "#7bd35a" : "#e0524a";
      ctx.fillRect(bx - wd / 2 + 1, by - img.height + 21, (wd - 2) * (b.hp / b.maxHp), 6);
    }
  }

  private drawBuildings(ctx: CanvasRenderingContext2D, w: World, opt: ViewOptions, time: number, tx0: number, ty0: number, tx1: number, ty1: number, fire: boolean) {
    for (const b of this.m.buildings) {
      if (b.tx + b.fw < tx0 - 3 || b.tx > tx1 + 3 || b.ty + b.fh < ty0 || b.ty - 6 > ty1) continue;
      this.drawBuildingSprite(ctx, b, opt.colors[b.side], time, fire);
    }
  }

  // Depth-sorted pass: trees, buildings, sheep and unit sprites.
  private drawSorted(ctx: CanvasRenderingContext2D, w: World, opt: ViewOptions, presence: Int32Array | null, time: number, tx0: number, ty0: number, tx1: number, ty1: number, wx0: number, wy0: number, wx1: number, wy1: number) {
    const m = this.m, a = this.a;
    // key = y * 8 + kind, payload index packed in a parallel array
    const items: number[] = [];
    const ys: number[] = [];
    const push = (kind: number, idx: number, y: number) => { items.push(kind * 1e6 + idx); ys.push(y); };
    this.forBuckets(tx0, ty0, tx1, ty1, 2, 4, (b) => { for (const t of m.treeBuckets[b]) push(0, t, m.treeY[t]); });
    m.buildings.forEach((b, k) => {
      if (b.tx + b.fw < tx0 - 3 || b.tx > tx1 + 3 || b.ty + b.fh < ty0 || b.ty - 6 > ty1) return;
      push(1, k, (b.ty + b.fh) * T);
    });
    for (let i = 0; i < w.shN; i++) {
      const x = w.shX[i], y = w.shY[i];
      if (x > wx0 - 64 && x < wx1 + 64 && y > wy0 && y < wy1 + 64) push(2, i, y);
    }
    const margin = 120;
    for (let i = 0; i < w.n; i++) {
      if (!w.alive[i]) continue;
      const x = w.x[i], y = w.y[i];
      if (x < wx0 - margin || x > wx1 + margin || y < wy0 - 20 || y > wy1 + 200) continue;
      if (!this.unitVisible(w, i, opt, presence)) continue;
      push(3, i, y);
    }
    const n = items.length;
    const order = Array.from({ length: n }, (_, k) => k);
    order.sort((p, q) => ys[p] - ys[q]);

    // forest zones opened for the viewer → canopy fades
    const anyPresence = w.presence;
    const reveal = (z: number) => {
      if (z === 0) return false;
      if (presence) return presence[z] > 0;
      return anyPresence[0][z] > 0 || anyPresence[1][z] > 0;
    };
    const sheepIdle = a.get(P.sheepIdle), sheepMove = a.get(P.sheepMove), sheepGrass = a.get(P.sheepGrass);
    for (const k of order) {
      const it = items[k];
      const kind = Math.floor(it / 1e6), idx = it % 1e6;
      if (kind === 0) {
        const z = m.treeZone[idx];
        const f = Math.floor(time * 6 + m.treePh[idx] * 8) % 8;
        if (reveal(z)) {
          ctx.globalAlpha = FOREST_REVEAL_ALPHA;
          this.drawTree(ctx, idx, f);
          ctx.globalAlpha = 1;
        } else this.drawTree(ctx, idx, f);
      } else if (kind === 1) {
        const b = m.buildings[idx];
        this.drawBuildingSprite(ctx, b, opt.colors[b.side], time, true);
      } else if (kind === 2) {
        const st = w.shS[idx];
        const img = st === 1 ? sheepMove : st === 2 ? sheepGrass : sheepIdle;
        if (!img) continue;
        const frames = img.width / 128;
        const f = Math.floor(time * 8 + idx) % frames;
        const src = w.shF[idx] < 0 ? a.flipped(st === 1 ? P.sheepMove : st === 2 ? P.sheepGrass : P.sheepIdle)! : img;
        const ff = w.shF[idx] < 0 ? frames - 1 - f : f;
        ctx.drawImage(src, ff * 128, 0, 128, 128, w.shX[idx] - 64 * 0.8, w.shY[idx] - 82 * 0.8, 128 * 0.8, 128 * 0.8);
      } else this.drawUnit(ctx, w, idx, opt, time);
    }
  }

  private drawUnit(ctx: CanvasRenderingContext2D, w: World, i: number, opt: ViewOptions, time: number) {
    const color = opt.colors[w.side[i]];
    const ad = ANIMS[w.anim[i]];
    const path = unitPath(color, ad.file);
    const flip = w.face[i] < 0;
    const img = flip ? this.a.flipped(path) : this.a.get(path);
    if (!img) return;
    const el = (time - w.animT[i]) * ad.fps;
    let f = ad.loop ? Math.floor(el) % ad.frames : Math.min(ad.frames - 1, Math.floor(el));
    if (f < 0) f = (f % ad.frames + ad.frames) % ad.frames;
    if (flip) f = ad.frames - 1 - f;
    const sz = ad.size;
    const s = UNIT_SCALE;
    const ax = sz === 320 ? 160 : 96, ay = sz === 320 ? 195 : 132;
    const x = w.x[i], y = w.y[i];
    if (w.sel[i]) {
      ctx.strokeStyle = "rgba(255,246,200,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y - 2, 16, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.drawImage(img, f * sz, 0, sz, sz, x - ax * s, y - ay * s, sz * s, sz * s);
    const max = [120, 70, 160, 60, 50][w.type[i]];
    if (w.hp[i] < max && w.type[i] !== PAWN) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x - 14, y - 58, 28, 5);
      ctx.fillStyle = COLOR_HEX[color];
      ctx.fillRect(x - 13, y - 57, 26 * Math.max(0, w.hp[i] / max), 3);
    }
  }

  private drawArrows(ctx: CanvasRenderingContext2D, w: World, opt: ViewOptions, wx0: number, wy0: number, wx1: number, wy1: number) {
    for (let k = 0; k < w.arN; k++) {
      const t = w.arT[k] / w.arDur[k];
      const x = w.arX0[k] + (w.arX1[k] - w.arX0[k]) * t;
      const dist = Math.hypot(w.arX1[k] - w.arX0[k], w.arY1[k] - w.arY0[k]);
      const arc = Math.sin(Math.PI * t) * dist * 0.18;
      const y = w.arY0[k] + (w.arY1[k] - w.arY0[k]) * t - arc;
      if (x < wx0 || x > wx1 || y < wy0 || y > wy1) continue;
      const img = this.a.get(unitPath(opt.colors[w.arSide[k]], "Archer/Arrow.png"));
      if (!img) continue;
      const vx = w.arX1[k] - w.arX0[k];
      const vy = w.arY1[k] - w.arY0[k] - Math.cos(Math.PI * t) * dist * 0.18 * Math.PI;
      const ang = Math.atan2(vy, vx);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.drawImage(img, -32 * 0.7, -32 * 0.7, 64 * 0.7, 64 * 0.7);
      ctx.restore();
    }
  }

  private drawFx(ctx: CanvasRenderingContext2D, w: World, wx0: number, wy0: number, wx1: number, wy1: number) {
    const a = this.a;
    for (const f of w.fx) {
      if (f.x < wx0 - 100 || f.x > wx1 + 100 || f.y < wy0 - 100 || f.y > wy1 + 100) continue;
      const el = w.time - f.t0;
      if (f.k === FX_DUST) {
        const img = a.get(P.dust[f.v]);
        if (!img) continue;
        const n = img.width / 64, fr = Math.floor(el * 14);
        if (fr < n) ctx.drawImage(img, fr * 64, 0, 64, 64, f.x - 32, f.y - 44, 64, 64);
      } else if (f.k === FX_EXPLOSION) {
        const img = a.get(P.explosion[f.v]);
        if (!img) continue;
        const n = img.width / 192, fr = Math.floor(el * 12);
        if (fr < n) ctx.drawImage(img, fr * 192, 0, 192, 192, f.x - 96, f.y - 150, 192, 192);
      } else if (f.k === FX_SPLASH) {
        const img = a.get(P.splash);
        if (!img) continue;
        const fr = Math.floor(el * 14);
        if (fr < 9) ctx.drawImage(img, fr * 192, 0, 192, 192, f.x - 96 * 0.6, f.y - 100 * 0.6, 192 * 0.6, 192 * 0.6);
      } else if (f.k === FX_HEAL) {
        const d = ANIMS[AN.M_HEAL_FX];
        const fr = Math.floor(el * d.fps);
        const img = a.get(unitPath("Blue", d.file));
        if (img && fr < d.frames) ctx.drawImage(img, fr * 192, 0, 192, 192, f.x - 96 * 0.6, f.y - 130 * 0.6, 192 * 0.6, 192 * 0.6);
      }
    }
  }

  private drawClouds(ctx: CanvasRenderingContext2D, time: number, wx0: number, wy0: number, wx1: number, wy1: number, ts: number) {
    const alpha = ts < 14 ? 0.55 : ts < 30 ? 0.35 : 0.18;
    const scale = 6;
    const cw = 576 * scale, chh = 256 * scale;
    const spanX = WORLD_W + cw * 2;
    ctx.globalAlpha = alpha;
    for (let k = 0; k < 36; k++) {
      const img = this.a.get(P.clouds[k % 8]);
      if (!img) continue;
      const bx = hash2(k, 1, 77) * spanX;
      const by = hash2(k, 2, 77) * (WORLD_H + chh) - chh;
      const x = ((bx + time * 60) % spanX) - cw;
      if (x > wx1 || x + cw < wx0 || by > wy1 || by + chh < wy0) continue;
      ctx.drawImage(img, x, by, cw, chh);
    }
    ctx.globalAlpha = 1;
  }

  // Nav overlay: blocked red, ford yellow, ramp green, bridge blue, forest zone outline.
  private drawNav(ctx: CanvasRenderingContext2D, tx0: number, ty0: number, tx1: number, ty1: number) {
    const m = this.m;
    const step = Math.max(1, Math.floor((tx1 - tx0) / 160));
    for (let y = ty0; y < ty1; y += step) for (let x = tx0; x < tx1; x += step) {
      const i = y * MW + x;
      const g = m.ground[i];
      let c: string | null = null;
      if (g === WATER || m.cliff[i] || m.block[i]) c = "rgba(230,40,40,0.38)";
      else if (g === FORD) c = "rgba(250,210,60,0.45)";
      else if (g === 3) c = "rgba(60,140,255,0.4)";
      else if (m.ramp[i]) c = "rgba(60,230,90,0.6)";
      else if (m.forest[i]) c = "rgba(20,70,20,0.28)";
      else if (m.level[i]) c = `rgba(255,255,255,${0.08 * m.level[i]})`;
      if (c) { ctx.fillStyle = c; ctx.fillRect(x * T, y * T, T * step, T * step); }
    }
  }
}

export const LOD_NEAR = 30;
