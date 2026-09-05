import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import sharp from "sharp";
import { thumbnailRoute } from "../src/routes/thumbnail.js";

async function png(width: number, height: number, alpha: boolean): Promise<Buffer> {
  return sharp({
    create: {
      width, height, channels: alpha ? 4 : 3,
      background: alpha ? { r: 1, g: 2, b: 3, alpha: 0.5 } : { r: 1, g: 2, b: 3 },
    },
  }).png().toBuffer();
}

describe("thumbnailRoute", () => {
  it("returns jpeg bytes and reports no alpha", async () => {
    const app = new Hono();
    app.route("/", thumbnailRoute({
      thumbnailPath: vi.fn().mockResolvedValue("/fake/a.png"),
      readFile: vi.fn().mockResolvedValue(await png(100, 100, false)),
    }));
    const res = await app.request("/api/assets/abc/thumbnail");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Has-Alpha")).toBe("false");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("reports alpha when the source has an alpha channel", async () => {
    const app = new Hono();
    app.route("/", thumbnailRoute({
      thumbnailPath: vi.fn().mockResolvedValue("/fake/a.png"),
      readFile: vi.fn().mockResolvedValue(await png(100, 100, true)),
    }));
    const res = await app.request("/api/assets/abc/thumbnail");
    expect(res.headers.get("X-Has-Alpha")).toBe("true");
  });

  it("downscales an oversized source to at most 1024px", async () => {
    const app = new Hono();
    app.route("/", thumbnailRoute({
      thumbnailPath: vi.fn().mockResolvedValue("/fake/big.png"),
      readFile: vi.fn().mockResolvedValue(await png(4000, 2000, false)),
    }));
    const res = await app.request("/api/assets/abc/thumbnail");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1024);
  });

  it("returns 404 when the item has no thumbnail", async () => {
    const app = new Hono();
    app.route("/", thumbnailRoute({
      thumbnailPath: vi.fn().mockRejectedValue(new Error("not found")),
      readFile: vi.fn(),
    }));
    const res = await app.request("/api/assets/missing/thumbnail");
    expect(res.status).toBe(404);
  });
});
