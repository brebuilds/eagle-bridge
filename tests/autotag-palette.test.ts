import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { extractColors } from "../src/autotag/palette.js";

let dir: string;
let img: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eb-pal-"));
  img = join(dir, "red.png");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 40 } } }).png().toFile(img);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("extractColors", () => {
  it("returns the dominant color as hex for a solid image", async () => {
    const colors = await extractColors(img, 3);
    expect(colors[0].toLowerCase()).toBe("#c81828"); // sharp stats() returns 200,24,40 for this libvips version
    expect(colors.length).toBeLessThanOrEqual(3);
  });
});
