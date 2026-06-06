import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { OllamaVision } from "../src/vision/ollama.js";

let dir: string, img: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eb-ov-"));
  img = join(dir, "x.png");
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(img);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => vi.restoreAllMocks());

describe("OllamaVision.tag", () => {
  it("downscales, posts to /api/generate, returns the response string", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ response: '{"subject":["x"]}' }), { status: 200 })
    );
    const ov = new OllamaVision("http://h:11434", "llama3.2-vision:11b", 640, 300000);
    const out = await ov.tag(img);
    expect(out).toContain('"subject"');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/generate");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("llama3.2-vision:11b");
    expect(Array.isArray(body.images)).toBe(true);
    expect(typeof body.images[0]).toBe("string"); // base64
    expect(body.stream).toBe(false);
  });

  it("throws a clear error on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    const ov = new OllamaVision("http://h:11434", "m", 640, 300000);
    await expect(ov.tag(img)).rejects.toThrow(/Ollama/);
  });
});
