import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Recipe } from "../types.js";

interface LoaderOpts {
  token: string;
  baseId: string;
  tableId: string;
  cacheDir: string;
  ttlMs: number;
}

interface AirtableRecord { id: string; fields: Record<string, unknown> }

export class RecipeLoader {
  private cache: Recipe[] | null = null;
  private fetchedAt = 0;

  constructor(private opts: LoaderOpts) {}

  private cacheFile(): string {
    return join(this.opts.cacheDir, "recipes.json");
  }

  private mapRecord(rec: AirtableRecord): Recipe {
    const f = rec.fields;
    const num = (k: string, d: number) => (typeof f[k] === "number" ? (f[k] as number) : d);
    const str = (k: string, d: string) => (typeof f[k] === "string" ? (f[k] as string) : d);
    return {
      type: str("type", ""),
      label: str("label", ""),
      printPx: [num("print_width", 0), num("print_height", 0)],
      dpi: num("dpi", 300),
      fit: (str("fit", "contain") as Recipe["fit"]),
      bg: str("bg", "transparent"),
      bleedPx: num("bleed_px", 0),
      format: (str("format", "png") as Recipe["format"]),
      upscale: (str("upscale", "auto") as Recipe["upscale"]),
      maxUpscale: num("max_upscale", 4),
    };
  }

  private async fetchFromAirtable(): Promise<Recipe[]> {
    const url = `https://api.airtable.com/v0/${this.opts.baseId}/${this.opts.tableId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}`);
    const body = (await res.json()) as { records: AirtableRecord[] };
    return body.records.map((r) => this.mapRecord(r)).filter((r) => r.type !== "");
  }

  private async readCacheFile(): Promise<Recipe[]> {
    const raw = await readFile(this.cacheFile(), "utf8");
    return JSON.parse(raw) as Recipe[];
  }

  private async writeCacheFile(recipes: Recipe[]): Promise<void> {
    await mkdir(this.opts.cacheDir, { recursive: true });
    await writeFile(this.cacheFile(), JSON.stringify(recipes, null, 2), "utf8");
  }

  /** Force a fetch from Airtable and update memory + disk cache. */
  async refresh(): Promise<Recipe[]> {
    const recipes = await this.fetchFromAirtable();
    this.cache = recipes;
    this.fetchedAt = Date.now();
    await this.writeCacheFile(recipes);
    return recipes;
  }

  /** Return recipes, refreshing if the TTL has elapsed; fall back to cache on failure. */
  async getAll(): Promise<Recipe[]> {
    const fresh = this.cache && Date.now() - this.fetchedAt < this.opts.ttlMs;
    if (fresh) return this.cache!;
    try {
      return await this.refresh();
    } catch {
      if (this.cache) return this.cache;
      return this.readCacheFile().catch(() => {
        throw new Error("Recipes unavailable: Airtable failed and no cache exists");
      });
    }
  }

  async getByType(type: string): Promise<Recipe | undefined> {
    return (await this.getAll()).find((r) => r.type === type);
  }
}
