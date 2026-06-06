import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RecipeLoader } from "../src/recipes/loader.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eb-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const airtablePayload = {
  records: [{
    id: "rec1",
    fields: {
      type: "tee", label: "T-Shirt (DTG)", print_width: 4500, print_height: 5400,
      dpi: 300, fit: "contain", bg: "transparent", bleed_px: 0,
      format: "png", upscale: "auto", max_upscale: 4,
    },
  }],
};

function jsonResponse(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
}

describe("RecipeLoader", () => {
  it("fetches from Airtable, maps fields, and caches", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse(airtablePayload));
    const loader = new RecipeLoader({
      token: "pat", baseId: "appX", tableId: "tblP", cacheDir: dir, ttlMs: 1000,
    });
    const recipes = await loader.getAll();
    expect(recipes[0].printPx).toEqual([4500, 5400]);
    expect(recipes[0].fit).toBe("contain");
  });

  it("falls back to cache when Airtable fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => jsonResponse(airtablePayload));
    const loader = new RecipeLoader({ token: "pat", baseId: "appX", tableId: "tblP", cacheDir: dir, ttlMs: 0 });
    await loader.refresh(); // primes cache
    vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network down")));
    const recipes = await loader.getAll(); // ttl 0 forces refetch -> fails -> cache
    expect(recipes[0].type).toBe("tee");
  });

  it("getByType returns a single recipe or undefined", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => jsonResponse(airtablePayload));
    const loader = new RecipeLoader({ token: "pat", baseId: "appX", tableId: "tblP", cacheDir: dir, ttlMs: 1000 });
    expect((await loader.getByType("tee"))?.label).toBe("T-Shirt (DTG)");
    expect(await loader.getByType("nope")).toBeUndefined();
  });
});
