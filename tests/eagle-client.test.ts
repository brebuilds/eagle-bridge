import { describe, it, expect, vi, beforeEach } from "vitest";
import { EagleClient } from "../src/eagle/client.js";

function jsonResponse(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify(data), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
}

describe("EagleClient", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("lists items and maps fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse({ status: "success", data: [
        { id: "ITEM1", name: "art", ext: "png", tags: ["new"], folders: ["F1"], annotation: "{}" },
      ] }));
    const c = new EagleClient("http://localhost:41595", "");
    const items = await c.itemList({ limit: 1 });
    expect(items[0].id).toBe("ITEM1");
    expect(items[0].tags).toEqual(["new"]);
  });

  it("ensureFolder returns existing folder id without creating", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (String(url).includes("/api/folder/list")) {
        return jsonResponse({ status: "success", data: [{ id: "ORBID", name: "ORB", children: [] }] });
      }
      throw new Error("should not create");
    });
    const c = new EagleClient("http://localhost:41595", "");
    expect(await c.ensureFolder("ORB")).toBe("ORBID");
  });

  it("throws a clear error when Eagle returns non-success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse({ status: "error", message: "method not allowed" }));
    const c = new EagleClient("http://localhost:41595", "");
    await expect(c.itemList({})).rejects.toThrow(/Eagle API error/);
  });

  it("retries a transient 5xx then succeeds", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      n++;
      if (n === 1) return Promise.resolve(new Response("err", { status: 500 }));
      return jsonResponse({ status: "success", data: { id: "ITEM9", name: "a", ext: "png", tags: [], folders: [], annotation: "{}" } });
    });
    const c = new EagleClient("http://localhost:41595", "");
    const item = await c.itemInfo("ITEM9");
    expect(item.id).toBe("ITEM9");
    expect(n).toBe(2); // first 500, retried once
  });

  it("does NOT retry a 4xx/logical error (fails fast)", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      n++;
      return jsonResponse({ status: "error", message: "bad" });
    });
    const c = new EagleClient("http://localhost:41595", "");
    await expect(c.itemInfo("X")).rejects.toThrow(/Eagle API error/);
    expect(n).toBe(1);
  });

  it("addFromPath returns the id Eagle puts in `data` (no list fallback)", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      calls.push(String(url));
      return jsonResponse({ status: "success", data: "MQ2S95C9DDXSN" });
    });
    const c = new EagleClient("http://localhost:41595", "");
    const id = await c.addFromPath("/tmp/x.png", { name: "x", folderId: "F1" });
    expect(id).toBe("MQ2S95C9DDXSN");
    // must NOT fall back to /api/item/list to resolve the id
    expect(calls.some((u) => u.includes("/api/item/list"))).toBe(false);
    expect(calls.some((u) => u.includes("/api/item/addFromPath"))).toBe(true);
  });
});
