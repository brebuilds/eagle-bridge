import { describe, it, expect, vi } from "vitest";
import { AssetsService } from "../src/assets/service.js";
import type { EagleItem, Recipe } from "../src/types.js";

const tee: Recipe = {
  type: "tee", label: "Tee", printPx: [1200, 1500], dpi: 300, fit: "contain",
  bg: "transparent", bleedPx: 0, format: "png", upscale: "never", maxUpscale: 4,
};

function fakeDeps() {
  const item: EagleItem = { id: "ITEM1", name: "art", ext: "png", tags: ["new"], folders: ["TFHID"], annotation: "{}" };
  return {
    eagle: {
      ensureFolder: vi.fn().mockResolvedValue("TFHID"),
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
    const res = await svc.ingestFromPath("/tmp/art.png", { brand: "TFH", name: "art", airtableDesignId: "rec1", tags: ["new"] });
    expect(d.eagle.ensureFolder).toHaveBeenCalledWith("TFH");
    // annotation JSON + tags are written via addFromPath in one call (no racy re-update)
    const [addPath, addOpts] = d.eagle.addFromPath.mock.calls[0];
    expect(addPath).toBe("/tmp/art.png");
    expect(addOpts.folderId).toBe("TFHID");
    expect(addOpts.tags).toEqual(["new"]);
    expect(JSON.parse(addOpts.annotation)).toMatchObject({ airtableDesignId: "rec1", brand: "TFH" });
    expect(d.eagle.updateItem).not.toHaveBeenCalled();
    expect(d.backlink).toHaveBeenCalledWith(expect.objectContaining({ designId: "rec1", eagleItemId: "ITEM1" }));
    expect(res.id).toBe("ITEM1");
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
