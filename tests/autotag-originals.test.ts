import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOriginalPath } from "../src/autotag/originals.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eb-orig-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("resolveOriginalPath", () => {
  it("finds the actual file regardless of the guessed extension", async () => {
    const originals = join(dir, "originals");
    mkdirSync(originals, { recursive: true });
    writeFileSync(join(originals, "I1.jpeg"), "x");
    // fallback ext is png, but the real file is .jpeg
    const p = await resolveOriginalPath(originals, "I1", "png");
    expect(p).toBe(join(originals, "I1.jpeg"));
  });
  it("falls back to id.fallbackExt when no file exists", async () => {
    const originals = join(dir, "originals");
    mkdirSync(originals, { recursive: true });
    const p = await resolveOriginalPath(originals, "I9", "png");
    expect(p).toBe(join(originals, "I9.png"));
  });
  it("does not match a different id that shares a prefix", async () => {
    const originals = join(dir, "originals");
    mkdirSync(originals, { recursive: true });
    writeFileSync(join(originals, "I10.png"), "x"); // must NOT match id "I1"
    const p = await resolveOriginalPath(originals, "I1", "jpg");
    expect(p).toBe(join(originals, "I1.jpg")); // fallback, since no exact "I1.<ext>"
  });
});
