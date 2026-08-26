import { describe, it, expect, vi } from "vitest";
import { Tagger } from "../src/autotag/tagger.js";
import type { EagleItem } from "../src/types.js";

function deps() {
  const item: EagleItem = { id: "I1", name: "art", ext: "png", tags: ["existing"], folders: [], annotation: JSON.stringify({ brand: "ORB" }) };
  return {
    eagle: {
      itemInfo: vi.fn().mockResolvedValue(item),
      updateItem: vi.fn().mockResolvedValue(undefined),
    },
    vision: { tag: vi.fn().mockResolvedValue('{"subject":["skull"],"style":["psychedelic"],"seo_keywords":["moon skull","skull"]}') },
    extractColors: vi.fn().mockResolvedValue(["#112233"]),
    originalPathFor: vi.fn().mockResolvedValue("/data/originals/I1.png"),
    now: () => "2026-06-06T00:00:00Z",
  };
}

describe("Tagger.tagItem", () => {
  it("merges free tags into Eagle tags and writes autotags to annotation", async () => {
    const d = deps();
    const t = new Tagger(d as any, "llama3.2-vision:11b");
    await t.tagItem("I1");
    const [id, patch] = d.eagle.updateItem.mock.calls[0];
    expect(id).toBe("I1");
    // existing tag preserved + free tags merged (seo + subject + style), colors NOT in tags
    expect(patch.tags).toEqual(expect.arrayContaining(["existing", "skull", "moon skull", "psychedelic"]));
    expect(patch.tags).not.toContain("#112233");
    const ann = JSON.parse(patch.annotation);
    expect(ann.brand).toBe("ORB"); // existing annotation preserved
    expect(ann.autotags.colors).toEqual(["#112233"]);
    expect(ann.autotags.brandFit).toContain("ORB");
    expect(ann.autotagError).toBeUndefined();
  });

  it("records autotagError and does not throw when vision fails", async () => {
    const d = deps();
    d.vision.tag = vi.fn().mockRejectedValue(new Error("Ollama error: 500"));
    const t = new Tagger(d as any, "m");
    await expect(t.tagItem("I1")).resolves.toBeUndefined();
    const [, patch] = d.eagle.updateItem.mock.calls[0];
    const ann = JSON.parse(patch.annotation);
    expect(ann.autotagError).toMatch(/Ollama error/);
  });
});
