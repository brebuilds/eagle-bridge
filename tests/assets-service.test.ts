import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetsService } from "../src/assets/service.js";
import type { EagleItem, Recipe } from "../src/types.js";

const tee: Recipe = {
  type: "tee", label: "Tee", printPx: [1200, 1500], dpi: 300, fit: "contain",
  bg: "transparent", bleedPx: 0, format: "png", upscale: "never", maxUpscale: 4,
};

function fakeDeps() {
  const item: EagleItem = { id: "ITEM1", name: "art", ext: "png", tags: ["new"], folders: ["ORBID"], annotation: "{}" };
  return {
    eagle: {
      ensureFolder: vi.fn().mockResolvedValue("ORBID"),
      addFromPath: vi.fn().mockResolvedValue("ITEM1"),
      addFromURL: vi.fn().mockResolvedValue("ITEM1"),
      itemInfo: vi.fn().mockResolvedValue(item),
      itemList: vi.fn().mockResolvedValue([item]),
      updateItem: vi.fn().mockResolvedValue(undefined),
    },
    recipes: { getByType: vi.fn().mockResolvedValue(tee) },
    runRecipe: vi.fn().mockResolvedValue({ outputPath: "/data/processed/ITEM1/tee.png", upscaled: false, upscaleFactor: 1 }),
    backlink: vi.fn().mockResolvedValue(undefined),
  };
}

describe("AssetsService.ingestFromPath", () => {
  it("ensures the brand folder, adds the item, writes annotation, back-links Airtable", async () => {
    const d = fakeDeps();
    const svc = new AssetsService(d as any, { dataDir: "/data", airtable: { token: "p", baseId: "b", designsTableId: "t" }, realesrganBin: "x" });
    const res = await svc.ingestFromPath("/tmp/art.png", { brand: "ORB", name: "art", airtableDesignId: "rec1", tags: ["new"] });
    expect(d.eagle.ensureFolder).toHaveBeenCalledWith("ORB");
    // annotation JSON + tags are written via addFromPath in one call (no racy re-update)
    const [addPath, addOpts] = d.eagle.addFromPath.mock.calls[0];
    expect(addPath).toBe("/tmp/art.png");
    expect(addOpts.folderId).toBe("ORBID");
    expect(addOpts.tags).toEqual(["new"]);
    expect(JSON.parse(addOpts.annotation)).toMatchObject({ airtableDesignId: "rec1", brand: "ORB" });
    expect(d.eagle.updateItem).not.toHaveBeenCalled();
    expect(d.backlink).toHaveBeenCalledWith(expect.objectContaining({ designId: "rec1", eagleItemId: "ITEM1" }));
    expect(res.id).toBe("ITEM1");
  });
});

describe("onIngested hook", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "eb-svc-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("ingestFromPathBytes fires onIngested once with the item id after the original is on disk", async () => {
    const d = fakeDeps();
    const onIngested = vi.fn();
    const svc = new AssetsService(
      d as any,
      { dataDir: tmpDir, airtable: { token: "p", baseId: "b", designsTableId: "t" }, realesrganBin: "x", onIngested },
    );
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]); // minimal fake jpeg bytes
    await svc.ingestFromPathBytes(bytes, "art.jpeg", { brand: "ORB", name: "art" });
    expect(onIngested).toHaveBeenCalledOnce();
    expect(onIngested).toHaveBeenCalledWith("ITEM1");
    // Verify the original was written before the hook fired (file must exist now)
    const { access } = await import("node:fs/promises");
    await expect(access(join(tmpDir, "originals", "ITEM1.jpeg"))).resolves.toBeUndefined();
  });

  it("ingestFromURL does NOT fire onIngested", async () => {
    const d = fakeDeps();
    const onIngested = vi.fn();
    const svc = new AssetsService(
      d as any,
      { dataDir: "/data", airtable: { token: "p", baseId: "b", designsTableId: "t" }, realesrganBin: "x", onIngested },
    );
    await svc.ingestFromURL("https://example.com/art.png", { brand: "ORB", name: "art" });
    expect(onIngested).not.toHaveBeenCalled();
  });
});

describe("AssetsService.process", () => {
  it("runs the recipe and records the processed path in the annotation", async () => {
    const d = fakeDeps();
    const svc = new AssetsService(d as any, { dataDir: "/data", airtable: { token: "p", baseId: "b", designsTableId: "t" }, realesrganBin: "x" });
    const res = await svc.process("ITEM1", ["tee"]);
    expect(d.recipes.getByType).toHaveBeenCalledWith("tee");
    expect(d.runRecipe).toHaveBeenCalled();
    expect(res.processed.tee).toContain("tee.png");
    const updateArg = d.eagle.updateItem.mock.calls.at(-1)![1];
    expect(JSON.parse(updateArg.annotation).processed.tee).toContain("tee.png");
  });

  it("throws a clear error for an unknown product type", async () => {
    const d = fakeDeps();
    d.recipes.getByType = vi.fn().mockResolvedValue(undefined);
    const svc = new AssetsService(d as any, { dataDir: "/data", airtable: { token: "p", baseId: "b", designsTableId: "t" }, realesrganBin: "x" });
    await expect(svc.process("ITEM1", ["mug"])).rejects.toThrow(/unknown product type: mug/i);
  });
});
