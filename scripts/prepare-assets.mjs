// Copies the Tiny Swords pack from ./assets into ./public/assets and builds
// contiguous 9-slice / 3-slice images for the HUD into ./public/ui.
// The UI sheets ship with gaps between slices, which CSS border-image can't use.
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "assets");
const OUT_ASSETS = path.join(root, "public", "assets");
const OUT_UI = path.join(root, "public", "ui");
const UI = path.join(SRC, "UI Elements", "UI Elements");

const COLORS = ["Blue", "Red", "Yellow", "Purple", "Black"];

async function copyPack() {
  await rm(OUT_ASSETS, { recursive: true, force: true });
  await cp(SRC, OUT_ASSETS, {
    recursive: true,
    filter: (p) => !p.endsWith(".DS_Store") && !p.endsWith(".aseprite"),
  });
}

// Slice cells of a sheet: 448-wide sheets use cells 128|64|128 at x=0,192,320;
// 320-wide sheets use 64|64|64 at x=0,128,256.
function cells(size) {
  if (size === 448) return [[0, 128], [192, 64], [320, 128]];
  if (size === 320) return [[0, 64], [128, 64], [256, 64]];
  throw new Error("unexpected sheet size " + size);
}

async function nine(file, out, top = 0, rowsOverride) {
  const img = sharp(file);
  const { width } = await img.metadata();
  const cx = cells(width);
  const cy = rowsOverride ?? cells(width).map(([y, h]) => [y + top, h]);
  const W = cx.reduce((s, c) => s + c[1], 0);
  const H = cy.reduce((s, c) => s + c[1], 0);
  const parts = [];
  let oy = 0;
  for (const [y, h] of cy) {
    let ox = 0;
    for (const [x, w] of cx) {
      const input = await sharp(file).extract({ left: x, top: y, width: w, height: h }).toBuffer();
      parts.push({ input, left: ox, top: oy });
      ox += w;
    }
    oy += h;
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(parts)
    .png()
    .toFile(path.join(OUT_UI, out));
}

async function buildUi() {
  await rm(OUT_UI, { recursive: true, force: true });
  await mkdir(OUT_UI, { recursive: true });
  await nine(path.join(UI, "Banners/Banner.png"), "banner.png");
  await nine(path.join(UI, "Papers/RegularPaper.png"), "paper.png");
  await nine(path.join(UI, "Papers/SpecialPaper.png"), "paper-special.png");
  await nine(path.join(UI, "Wood Table/WoodTable.png"), "wood.png");
  for (const b of ["BigBlueButton_Regular", "BigBlueButton_Pressed", "BigRedButton_Regular", "BigRedButton_Pressed"]) {
    await nine(path.join(UI, `Buttons/${b}.png`), `${b}.png`);
  }
  // 3-slice strips (one row of cells)
  await nine(path.join(UI, "Bars/BigBar_Base.png"), "bigbar.png", 0, [[0, 64]]);
  await nine(path.join(UI, "Bars/SmallBar_Base.png"), "smallbar.png", 0, [[0, 64]]);
  for (let i = 0; i < COLORS.length; i++) {
    const c = COLORS[i].toLowerCase();
    await nine(path.join(UI, "Ribbons/BigRibbons.png"), `ribbon-${c}.png`, 0, [[i * 128, 128]]);
    await nine(path.join(UI, "Ribbons/SmallRibbons.png"), `ribbon-small-${c}.png`, 0, [[i * 128, 64]]);
    await nine(path.join(UI, "Swords/Swords.png"), `sword-${c}.png`, 0, [[i * 128, 128]]);
  }
}

const exists = await stat(SRC).then(() => true, () => false);
if (!exists) {
  console.error("assets/ folder not found");
  process.exit(1);
}
await copyPack();
await buildUi();
console.log("assets ready → public/assets, public/ui");
