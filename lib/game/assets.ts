// Loads the Tiny Swords pack from /public/assets and exposes sprite sheets.
import { P, assetUrl } from "@game/shared";

export * from "@game/shared";

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
