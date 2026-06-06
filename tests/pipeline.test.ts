import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runRecipe } from "../src/processing/pipeline.js";
import type { Recipe } from "../src/types.js";

let dir: string;
let srcHiRes: string;

const tee: Recipe = {
  type: "tee", label: "Tee", printPx: [1200, 1500], dpi: 300, fit: "contain",
  bg: "transparent", bleedPx: 0, format: "png", upscale: "never", maxUpscale: 4,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eb-pipe-"));
  srcHiRes = join(dir, "src.png");
  // 2000x2000 already larger than target -> no upscale needed
  await sharp({ create: { width: 2000, height: 2000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
    .png().toFile(srcHiRes);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runRecipe", () => {
  it("produces an image at exact print dimensions (contain + transparent pad)", async () => {
    const out = join(dir, "out-tee.png");
    const result = await runRecipe({
      inputPath: srcHiRes, outputPath: out, recipe: tee, realesrganBin: "/nonexistent",
    });
    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(1500);
    expect(meta.hasAlpha).toBe(true);
    expect(result.upscaled).toBe(false);
  });

  it("adds bleed to the canvas size", async () => {
    const out = join(dir, "out-bleed.png");
    const withBleed: Recipe = { ...tee, bleedPx: 50 };
    const result = await runRecipe({ inputPath: srcHiRes, outputPath: out, recipe: withBleed, realesrganBin: "/nonexistent" });
    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1300);  // 1200 + 50*2
    expect(meta.height).toBe(1600); // 1500 + 50*2
  });
});
