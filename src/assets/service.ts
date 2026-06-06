import { join } from "node:path";
import type { EagleItem, AssetLink, Recipe } from "../types.js";
import type { RunRecipeResult } from "../processing/pipeline.js";

// Narrow interfaces so the service depends on behavior, not concrete classes.
export interface EagleLike {
  ensureFolder(name: string): Promise<string>;
  addFromPath(path: string, opts: { name?: string; folderId?: string; tags?: string[]; annotation?: string }): Promise<string>;
  addFromURL(url: string, opts: { name?: string; folderId?: string; tags?: string[]; annotation?: string }): Promise<string>;
  itemInfo(id: string): Promise<EagleItem>;
  itemList(params: Record<string, unknown>): Promise<EagleItem[]>;
  updateItem(id: string, patch: { tags?: string[]; annotation?: string }): Promise<void>;
}
export interface RecipesLike { getByType(type: string): Promise<Recipe | undefined>; }
export type RunRecipeFn = (input: { inputPath: string; outputPath: string; recipe: Recipe; realesrganBin: string }) => Promise<RunRecipeResult>;
export type BacklinkFn = (input: { token: string; baseId: string; tableId: string; designId?: string; eagleItemId: string; eagleUrl: string }) => Promise<void>;

export interface AssetsDeps {
  eagle: EagleLike;
  recipes: RecipesLike;
  runRecipe: RunRecipeFn;
  backlink: BacklinkFn;
}

export interface AssetsConfig {
  dataDir: string;
  airtable: { token: string; baseId: string; designsTableId: string };
  realesrganBin: string;
}

export interface IngestOptions {
  brand: string;
  name?: string;
  airtableDesignId?: string;
  tags?: string[];
  source?: AssetLink["source"];
}

function parseLink(annotation: string): AssetLink {
  try { return JSON.parse(annotation || "{}") as AssetLink; } catch { return {}; }
}

export class AssetsService {
  constructor(private deps: AssetsDeps, private cfg: AssetsConfig) {}

  private originalPath(itemId: string): string {
    return join(this.cfg.dataDir, "originals", itemId);
  }

  private async writeLink(itemId: string, link: AssetLink, tags?: string[]): Promise<void> {
    await this.deps.eagle.updateItem(itemId, { annotation: JSON.stringify(link), tags });
  }

  async ingestFromPath(path: string, opts: IngestOptions): Promise<EagleItem> {
    const folderId = await this.deps.eagle.ensureFolder(opts.brand);
    const link: AssetLink = {
      airtableDesignId: opts.airtableDesignId,
      brand: opts.brand,
      source: opts.source ?? "api",
      processed: {},
    };
    // addFromPath persists annotation + tags + folder in one call (verified against
    // Eagle 4). A separate update right after races with thumbnail generation (500), so
    // we rely on the add call to store the link.
    const id = await this.deps.eagle.addFromPath(path, {
      name: opts.name, folderId, tags: opts.tags, annotation: JSON.stringify(link),
    });
    await this.deps.backlink({
      token: this.cfg.airtable.token, baseId: this.cfg.airtable.baseId, tableId: this.cfg.airtable.designsTableId,
      designId: opts.airtableDesignId, eagleItemId: id, eagleUrl: `eagle://item/${id}`,
    });
    return this.deps.eagle.itemInfo(id);
  }

  async ingestFromURL(url: string, opts: IngestOptions): Promise<EagleItem> {
    const folderId = await this.deps.eagle.ensureFolder(opts.brand);
    const link: AssetLink = { airtableDesignId: opts.airtableDesignId, brand: opts.brand, source: opts.source ?? "api", processed: {} };
    const id = await this.deps.eagle.addFromURL(url, { name: opts.name, folderId, tags: opts.tags, annotation: JSON.stringify(link) });
    await this.deps.backlink({
      token: this.cfg.airtable.token, baseId: this.cfg.airtable.baseId, tableId: this.cfg.airtable.designsTableId,
      designId: opts.airtableDesignId, eagleItemId: id, eagleUrl: `eagle://item/${id}`,
    });
    return this.deps.eagle.itemInfo(id);
  }

  /** Persist raw bytes, ingest into Eagle, and stash the original for later processing. */
  async ingestFromPathBytes(bytes: Uint8Array, filename: string, opts: IngestOptions): Promise<EagleItem> {
    const { mkdir, writeFile, copyFile } = await import("node:fs/promises");
    const ext = (filename.split(".").pop() || "png").toLowerCase();
    const uploadsDir = join(this.cfg.dataDir, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const tmpPath = join(uploadsDir, filename);
    await writeFile(tmpPath, bytes);

    const item = await this.ingestFromPath(tmpPath, opts);

    const originalsDir = join(this.cfg.dataDir, "originals");
    await mkdir(originalsDir, { recursive: true });
    await copyFile(tmpPath, join(originalsDir, `${item.id}.${ext}`));
    return item;
  }

  async detail(id: string): Promise<{ item: EagleItem; link: AssetLink }> {
    const item = await this.deps.eagle.itemInfo(id);
    return { item, link: parseLink(item.annotation) };
  }

  async search(params: { q?: string; brand?: string; tag?: string; limit?: number; offset?: number }): Promise<EagleItem[]> {
    return this.deps.eagle.itemList({
      keyword: params.q, tags: params.tag, limit: params.limit ?? 50, offset: params.offset ?? 0,
    });
  }

  async setTags(id: string, add: string[], remove: string[]): Promise<EagleItem> {
    const item = await this.deps.eagle.itemInfo(id);
    const set = new Set(item.tags);
    for (const t of remove) set.delete(t);
    for (const t of add) set.add(t);
    await this.deps.eagle.updateItem(id, { tags: [...set] });
    return this.deps.eagle.itemInfo(id);
  }

  /** Run one or more product-type recipes against an item's original file. */
  async process(id: string, types: string[]): Promise<{ processed: Record<string, string>; results: RunRecipeResult[] }> {
    const { item, link } = await this.detail(id);
    const inputPath = this.originalPath(id) + "." + (item.ext || "png");
    const processed: Record<string, string> = { ...(link.processed ?? {}) };
    const results: RunRecipeResult[] = [];
    for (const type of types) {
      const recipe = await this.deps.recipes.getByType(type);
      if (!recipe) throw new Error(`Unknown product type: ${type}`);
      const outputPath = join(this.cfg.dataDir, "processed", id, `${type}.${recipe.format}`);
      const result = await this.deps.runRecipe({ inputPath, outputPath, recipe, realesrganBin: this.cfg.realesrganBin });
      processed[type] = join("processed", id, `${type}.${recipe.format}`);
      results.push(result);
    }
    const updatedLink: AssetLink = { ...link, processed };
    await this.writeLink(id, updatedLink);
    return { processed, results };
  }
}
