import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutotagQueue } from "../src/autotag/queue.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eb-q-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("AutotagQueue", () => {
  it("processes enqueued ids via the worker and persists state", async () => {
    const processed: string[] = [];
    const q = new AutotagQueue(dir, async (id) => { processed.push(id); }, 3);
    q.start();
    q.enqueue("A"); q.enqueue("B");
    await flush();
    expect(processed).toEqual(["A", "B"]);
    expect(q.status().pending).toBe(0);
  });

  it("dedupes ids already pending", async () => {
    const q = new AutotagQueue(dir, async () => { await new Promise((r) => setTimeout(r, 50)); }, 3);
    q.enqueue("A"); q.enqueue("A");
    expect(q.status().pending).toBe(1);
  });

  it("resumes pending ids from disk on construction", async () => {
    const f = join(dir, "autotag-queue.json");
    writeFileSync(f, JSON.stringify(["X", "Y"]));
    const processed: string[] = [];
    const q = new AutotagQueue(dir, async (id) => { processed.push(id); }, 3);
    q.start();
    await flush();
    expect(processed).toEqual(["X", "Y"]);
  });

  it("dead-letters an id after max attempts without crashing the loop", async () => {
    const q = new AutotagQueue(dir, async () => { throw new Error("boom"); }, 2);
    q.start();
    q.enqueue("Z");
    await new Promise((r) => setTimeout(r, 100));
    const dead = JSON.parse(readFileSync(join(dir, "autotag-failed.json"), "utf8"));
    expect(dead).toContain("Z");
    expect(q.status().pending).toBe(0);
  });
});
