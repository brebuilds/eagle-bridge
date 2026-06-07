import type { EagleItem, AssetLink } from "../types.js";
import { parseModelOutput, normalizeTags } from "./normalize.js";

export interface EagleTagLike {
  itemInfo(id: string): Promise<EagleItem>;
  updateItem(id: string, patch: { tags?: string[]; annotation?: string }): Promise<void>;
}
export interface VisionLike { tag(imagePath: string): Promise<string>; }

export interface TaggerDeps {
  eagle: EagleTagLike;
  vision: VisionLike;
  extractColors: (imagePath: string, max?: number) => Promise<string[]>;
  originalPathFor: (item: EagleItem) => Promise<string>;
  now: () => string;
}

function parseLink(annotation: string): AssetLink {
  try { return JSON.parse(annotation || "{}") as AssetLink; } catch { return {}; }
}

export class Tagger {
  constructor(private deps: TaggerDeps, private model: string) {}

  /** Tag one item. Never throws — failures are recorded as autotagError on the item. */
  async tagItem(id: string): Promise<void> {
    const item = await this.deps.eagle.itemInfo(id);
    const link = parseLink(item.annotation);
    const imagePath = await this.deps.originalPathFor(item);
    try {
      const raw = await this.deps.vision.tag(imagePath);
      const colors = await this.deps.extractColors(imagePath, 4).catch(() => [] as string[]);
      const autotags = normalizeTags(parseModelOutput(raw), { colors, model: this.model, now: this.deps.now() });
      const tags = [...new Set([...item.tags, ...autotags.seo, ...autotags.subject, ...autotags.style])];
      const updatedLink: AssetLink = { ...link, autotags, autotagError: undefined };
      await this.deps.eagle.updateItem(id, { tags, annotation: JSON.stringify(updatedLink) });
    } catch (e) {
      const updatedLink: AssetLink = { ...link, autotagError: (e as Error).message };
      await this.deps.eagle.updateItem(id, { annotation: JSON.stringify(updatedLink) });
    }
  }
}
