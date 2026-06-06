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
        return jsonResponse({ status: "success", data: [{ id: "TFHID", name: "TFH", children: [] }] });
      }
      throw new Error("should not create");
    });
    const c = new EagleClient("http://localhost:41595", "");
    expect(await c.ensureFolder("TFH")).toBe("TFHID");
  });

  it("throws a clear error when Eagle returns non-success", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      jsonResponse({ status: "error", message: "method not allowed" }));
    const c = new EagleClient("http://localhost:41595", "");
    await expect(c.itemList({})).rejects.toThrow(/Eagle API error/);
  });
});
