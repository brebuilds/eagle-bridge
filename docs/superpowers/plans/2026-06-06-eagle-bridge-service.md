# Eagle Bridge Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tailnet-reachable HTTP service on `veggie` that wraps Eagle's localhost API and adds POD endpoints — push/pull/tag/search assets, per-product-type image processing (Real-ESRGAN + sharp), and Airtable Design-ID linking.

**Architecture:** A small Node 24 + TypeScript Hono service. It talks to Eagle over `http://localhost:41595`, loads per-product-type recipes from Airtable (cached to disk), runs an image-processing pipeline, and exposes Bearer-token-authed REST routes. Deployed as a launchd KeepAlive agent and exposed via Tailscale Serve (tailnet-only). This plan delivers the **bridge service only**; the Stacks UI and in-Eagle plugin are separate follow-up plans.

**Tech Stack:** Node 24, TypeScript, Hono, Vitest, sharp (libvips), Real-ESRGAN ncnn-vulkan (arm64/Metal), Airtable REST.

**Scope note:** This is Phase 1a from the spec (`docs/superpowers/specs/2026-06-06-eagle-bridge-design.md`). The Stacks interface pages (Phase 1b) and in-Eagle plugin (Phase 2) get their own plans after this ships.

---

## File Structure

```
eagle-bridge/
  package.json
  tsconfig.json
  vitest.config.ts
  .env.example
  src/
    config.ts              # env → typed Config
    types.ts               # shared domain types (EagleItem, Recipe, Asset, ...)
    eagle/client.ts        # thin Eagle localhost API client
    recipes/loader.ts      # Airtable recipe fetch + disk cache + fallback
    processing/upscale.ts  # Real-ESRGAN wrapper + sharp fallback + decision
    processing/pipeline.ts # runRecipe: upscale → fit → pad → bleed → sRGB → output
    airtable/designs.ts    # back-link Eagle item id ⇄ Airtable Design record
    assets/service.ts      # ingest / search / detail / tag / process orchestration
    middleware/auth.ts     # Bearer-token guard
    routes/health.ts       # GET /api/health
    routes/assets.ts       # asset routes
    routes/productTypes.ts # recipe routes
    server.ts              # Hono app wiring
    index.ts               # entrypoint
  scripts/install-realesrgan.sh
  deploy/com.bre.eagle-bridge.plist
  deploy/SETUP.md
  tests/
    config.test.ts
    eagle-client.test.ts
    recipes-loader.test.ts
    upscale.test.ts
    pipeline.test.ts
    auth.test.ts
    health.test.ts
    assets-service.test.ts
    routes.test.ts
    fixtures/   # generated sample images
```

Each `src/*` file has one responsibility. Routes are thin; logic lives in services. Files that change together (a domain + its test) sit in parallel paths.

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "eagle-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0",
    "sharp": "^0.33.5"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
  },
});
```

- [ ] **Step 4: Create `.env.example`**

```bash
# Bridge
BRIDGE_PORT=3110
BRIDGE_TOKEN=change-me-long-random

# Eagle (localhost API on veggie)
EAGLE_API=http://localhost:41595
EAGLE_TOKEN=                       # from Eagle → Preferences → Developer (may be blank)

# Airtable
AIRTABLE_TOKEN=pat...
AIRTABLE_BASE_ID=appNUnSm9ZMCmASpG
AIRTABLE_PRODUCT_TYPE_TABLE=tblBr361feqXDpdZA
AIRTABLE_DESIGNS_TABLE=tblLz44lYKbaU9Nge

# Storage
DATA_DIR=/Users/bre/eagle-bridge/data
RECIPE_TTL_MS=3600000

# Real-ESRGAN
REALESRGAN_BIN=/Users/bre/eagle-bridge/bin/realesrgan-ncnn-vulkan
```

- [ ] **Step 5: Install dependencies**

Run: `cd ~/eagle-bridge && npm install`
Expected: dependencies installed, `sharp` prebuilt arm64 binary fetched, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example package-lock.json
git commit -m "chore: scaffold eagle-bridge project"
```

---

## Task 1: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

```ts
// Eagle item as returned by the Eagle localhost API (subset we use).
export interface EagleItem {
  id: string;
  name: string;
  ext: string;
  tags: string[];
  folders: string[];
  annotation: string;
  url?: string;
  width?: number;
  height?: number;
  modificationTime?: number;
}

// Structured link we store in an item's annotation (JSON-encoded).
export interface AssetLink {
  airtableDesignId?: string;
  brand?: string;
  source?: "stacks-upload" | "watch-folder" | "n8n" | "api";
  processed?: Record<string, string>; // productType -> relative file path
}

// A per-product-type processing recipe (from Airtable Product Type table).
export interface Recipe {
  type: string;            // machine key, e.g. "tee"
  label: string;           // human label, e.g. "T-Shirt (DTG)"
  printPx: [number, number];
  dpi: number;
  fit: "contain" | "cover";
  bg: "transparent" | string; // "transparent" or a hex color
  bleedPx: number;
  format: "png" | "jpeg";
  upscale: "auto" | "always" | "never";
  maxUpscale: number;      // cap on upscale factor (e.g. 4)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared domain types"
```

---

## Task 2: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  BRIDGE_PORT: "3110",
  BRIDGE_TOKEN: "secret",
  EAGLE_API: "http://localhost:41595",
  EAGLE_TOKEN: "",
  AIRTABLE_TOKEN: "pat",
  AIRTABLE_BASE_ID: "appX",
  AIRTABLE_PRODUCT_TYPE_TABLE: "tblP",
  AIRTABLE_DESIGNS_TABLE: "tblD",
  DATA_DIR: "/tmp/eb",
  RECIPE_TTL_MS: "3600000",
  REALESRGAN_BIN: "/tmp/bin/realesrgan",
};

describe("loadConfig", () => {
  it("parses a complete env", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3110);
    expect(c.bridgeToken).toBe("secret");
    expect(c.airtableBaseId).toBe("appX");
    expect(c.recipeTtlMs).toBe(3600000);
  });

  it("throws when a required var is missing", () => {
    const { BRIDGE_TOKEN, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/BRIDGE_TOKEN/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/config.ts
export interface Config {
  port: number;
  bridgeToken: string;
  eagleApi: string;
  eagleToken: string;
  airtableToken: string;
  airtableBaseId: string;
  productTypeTableId: string;
  designsTableId: string;
  dataDir: string;
  recipeTtlMs: number;
  realesrganBin: string;
}

function req(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: parseInt(env.BRIDGE_PORT ?? "3110", 10),
    bridgeToken: req(env, "BRIDGE_TOKEN"),
    eagleApi: env.EAGLE_API ?? "http://localhost:41595",
    eagleToken: env.EAGLE_TOKEN ?? "",
    airtableToken: req(env, "AIRTABLE_TOKEN"),
    airtableBaseId: req(env, "AIRTABLE_BASE_ID"),
    productTypeTableId: req(env, "AIRTABLE_PRODUCT_TYPE_TABLE"),
    designsTableId: req(env, "AIRTABLE_DESIGNS_TABLE"),
    dataDir: req(env, "DATA_DIR"),
    recipeTtlMs: parseInt(env.RECIPE_TTL_MS ?? "3600000", 10),
    realesrganBin: req(env, "REALESRGAN_BIN"),
  };
}
```

Note: `EAGLE_TOKEN` is intentionally optional (Eagle reads work token-free).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: typed config loader"
```

---

## Task 3: Eagle client

**Files:**
- Create: `src/eagle/client.ts`
- Test: `tests/eagle-client.test.ts`

The Eagle API quirk: `POST /api/item/addFromPath` returns `{status:"success"}` but **not** the new item id. The client resolves the id by listing the most-recent item in the target folder and matching the name. All requests send the token as `?token=` when set.

- [ ] **Step 1: Write the failing test (fetch mocked)**

```ts
// tests/eagle-client.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/eagle-client.test.ts`
Expected: FAIL — cannot find module `../src/eagle/client.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/eagle/client.ts
import type { EagleItem } from "../types.js";

interface AddOptions {
  name?: string;
  folderId?: string;
  tags?: string[];
  annotation?: string;
  website?: string;
}

interface EagleFolder { id: string; name: string; children?: EagleFolder[] }

export class EagleClient {
  constructor(private baseUrl: string, private token: string) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL(path, this.baseUrl);
    if (this.token) u.searchParams.set("token", this.token);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private async call<T>(path: string, init?: RequestInit, query?: Record<string, string | number | undefined>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path, query), init);
    } catch (e) {
      throw new Error(`Eagle unreachable at ${this.baseUrl}: ${(e as Error).message}`);
    }
    const body = await res.json().catch(() => ({ status: "error", message: "non-JSON response" }));
    if (!res.ok || body?.status !== "success") {
      throw new Error(`Eagle API error (${path}): ${body?.message ?? res.status}`);
    }
    return body.data as T;
  }

  async appInfo(): Promise<unknown> {
    return this.call("/api/application/info");
  }

  async folderList(): Promise<EagleFolder[]> {
    return this.call<EagleFolder[]>("/api/folder/list");
  }

  /** Find a top-level folder by name, creating it if absent. Returns folder id. */
  async ensureFolder(name: string): Promise<string> {
    const folders = await this.folderList();
    const found = folders.find((f) => f.name === name);
    if (found) return found.id;
    const created = await this.call<{ id: string }>("/api/folder/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderName: name }),
    });
    return created.id;
  }

  async itemList(params: { limit?: number; offset?: number; keyword?: string; tags?: string; folders?: string; ext?: string; orderBy?: string }): Promise<EagleItem[]> {
    return this.call<EagleItem[]>("/api/item/list", undefined, { ...params });
  }

  async itemInfo(id: string): Promise<EagleItem> {
    return this.call<EagleItem>("/api/item/info", undefined, { id });
  }

  async updateItem(id: string, patch: { tags?: string[]; annotation?: string; url?: string }): Promise<void> {
    await this.call("/api/item/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
  }

  async thumbnailPath(id: string): Promise<string> {
    return this.call<string>("/api/item/thumbnail", undefined, { id });
  }

  /**
   * Add an item from a local file path. Eagle does NOT return the new id,
   * so we resolve it by listing the newest item in the folder and matching name.
   */
  async addFromPath(path: string, opts: AddOptions): Promise<string> {
    await this.call("/api/item/addFromPath", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        name: opts.name,
        folderId: opts.folderId,
        tags: opts.tags,
        annotation: opts.annotation,
        website: opts.website,
      }),
    });
    const recent = await this.itemList({
      limit: 10,
      orderBy: "-CREATEDATE",
      folders: opts.folderId,
    });
    const match = recent.find((i) => opts.name && i.name === opts.name) ?? recent[0];
    if (!match) throw new Error("addFromPath: could not resolve new item id");
    return match.id;
  }

  async addFromURL(url: string, opts: AddOptions): Promise<string> {
    await this.call("/api/item/addFromURL", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        name: opts.name,
        folderId: opts.folderId,
        tags: opts.tags,
        annotation: opts.annotation,
        website: opts.website,
      }),
    });
    const recent = await this.itemList({ limit: 10, orderBy: "-CREATEDATE", folders: opts.folderId });
    const match = recent.find((i) => opts.name && i.name === opts.name) ?? recent[0];
    if (!match) throw new Error("addFromURL: could not resolve new item id");
    return match.id;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/eagle-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Live integration check (verify against real Eagle on veggie)**

Run: `node --input-type=module -e "import {EagleClient} from './src/eagle/client.ts'" 2>/dev/null; npx tsx -e "import {EagleClient} from './src/eagle/client.js'; const c=new EagleClient('http://localhost:41595',''); console.log((await c.folderList()).map(f=>f.name)); console.log((await c.itemList({limit:1})));"`
Expected: prints real folder names (incl. "Wall Art") and one item object. If the item shape differs from `EagleItem`, adjust `src/types.ts` and re-run unit tests. Confirm `addFromPath` id-resolution against a throwaway file in a `__bridge_test` folder, then delete that item in Eagle.

- [ ] **Step 6: Commit**

```bash
git add src/eagle/client.ts tests/eagle-client.test.ts src/types.ts
git commit -m "feat: Eagle localhost API client"
```

---

## Task 4: Recipe loader

**Files:**
- Create: `src/recipes/loader.ts`
- Test: `tests/recipes-loader.test.ts`

Recipes come from the Airtable Product Type table and are cached to `DATA_DIR/recipes.json`. On Airtable failure, the cache is served. Airtable field → Recipe mapping is centralized in `mapRecord`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/recipes-loader.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/recipes-loader.test.ts`
Expected: FAIL — cannot find module `../src/recipes/loader.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/recipes/loader.ts
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
```

Note: `Date.now()` is used at runtime here (this is application code, not a workflow script — the workflow-script restriction does not apply).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/recipes-loader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/recipes/loader.ts tests/recipes-loader.test.ts
git commit -m "feat: Airtable recipe loader with disk cache"
```

---

## Task 5: Upscale decision + Real-ESRGAN wrapper

**Files:**
- Create: `src/processing/upscale.ts`
- Test: `tests/upscale.test.ts`

`decideUpscaleFactor` is a pure function (unit-tested). `upscaleImage` shells out to Real-ESRGAN and is exercised in the pipeline integration step (Task 6), not unit-tested, since it needs the binary.

- [ ] **Step 1: Write the failing test**

```ts
// tests/upscale.test.ts
import { describe, it, expect } from "vitest";
import { decideUpscaleFactor } from "../src/processing/upscale.js";

describe("decideUpscaleFactor", () => {
  it("returns 1 when source already meets target (auto)", () => {
    expect(decideUpscaleFactor({ srcW: 4500, srcH: 5400, targetW: 4500, targetH: 5400, mode: "auto", max: 4 })).toBe(1);
  });

  it("rounds up to an integer factor capped at max (auto)", () => {
    // need ~3.0x on width; ESRGAN supports integer scales, capped at max
    expect(decideUpscaleFactor({ srcW: 1500, srcH: 1800, targetW: 4500, targetH: 5400, mode: "auto", max: 4 })).toBe(3);
  });

  it("caps at max even when more is needed (auto)", () => {
    expect(decideUpscaleFactor({ srcW: 500, srcH: 600, targetW: 4500, targetH: 5400, mode: "auto", max: 4 })).toBe(4);
  });

  it("returns 1 when mode is never", () => {
    expect(decideUpscaleFactor({ srcW: 500, srcH: 600, targetW: 4500, targetH: 5400, mode: "never", max: 4 })).toBe(1);
  });

  it("returns at least 2 when mode is always and source already large enough", () => {
    expect(decideUpscaleFactor({ srcW: 4500, srcH: 5400, targetW: 4500, targetH: 5400, mode: "always", max: 4 })).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/upscale.test.ts`
Expected: FAIL — cannot find module `../src/processing/upscale.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/processing/upscale.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface UpscaleDecision {
  srcW: number;
  srcH: number;
  targetW: number;
  targetH: number;
  mode: "auto" | "always" | "never";
  max: number;
}

/** Integer upscale factor (Real-ESRGAN supports integer scales). */
export function decideUpscaleFactor(d: UpscaleDecision): number {
  if (d.mode === "never") return 1;
  const needed = Math.max(d.targetW / d.srcW, d.targetH / d.srcH);
  if (d.mode === "always") {
    return Math.min(Math.max(2, Math.ceil(needed)), d.max);
  }
  if (needed <= 1) return 1;
  return Math.min(Math.ceil(needed), d.max);
}

/**
 * Upscale a PNG/JPG by an integer factor using Real-ESRGAN.
 * Returns the output path. Throws if the binary fails.
 */
export async function upscaleImage(bin: string, inputPath: string, outputPath: string, factor: number): Promise<string> {
  // realesrgan-ncnn-vulkan -i in -o out -s <factor> -n realesrgan-x4plus
  await run(bin, ["-i", inputPath, "-o", outputPath, "-s", String(factor), "-n", "realesrgan-x4plus"]);
  return outputPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/upscale.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/processing/upscale.ts tests/upscale.test.ts
git commit -m "feat: upscale decision logic + Real-ESRGAN wrapper"
```

---

## Task 6: Processing pipeline

**Files:**
- Create: `src/processing/pipeline.ts`
- Test: `tests/pipeline.test.ts`

The pipeline: upscale (if decided) → resize/fit → pad to canvas with bg → add bleed → sRGB → output. Real-ESRGAN is skipped in unit tests (factor forced to 1 by using a hi-res source ≥ target), so the deterministic sharp path is fully tested by asserting exact output dimensions.

- [ ] **Step 1: Write the failing test**

```ts
// tests/pipeline.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runRecipe } from "../src/processing/pipeline.js";
import type { Recipe } from "../src/types.js";

let dir: string;
let srcHiRes: string;

const tee: Recipe = {
  type: "tee", label: "Tee", printPx: [1200, 1500], dpi: 300, fit: "contain",
  bg: "transparent", bleedPx: 0, format: "png", upscale: "never", maxUpscale: 4,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eb-pipe-"));
  srcHiRes = join(dir, "src.png");
  // 2000x2000 already larger than target -> no upscale needed
  await sharp({ create: { width: 2000, height: 2000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
    .png().toFile(srcHiRes);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("runRecipe", () => {
  it("produces an image at exact print dimensions (contain + transparent pad)", async () => {
    const out = join(dir, "out-tee.png");
    const result = await runRecipe({
      inputPath: srcHiRes, outputPath: out, recipe: tee, realesrganBin: "/nonexistent",
    });
    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(1500);
    expect(meta.hasAlpha).toBe(true);
    expect(result.upscaled).toBe(false);
  });

  it("adds bleed to the canvas size", async () => {
    const out = join(dir, "out-bleed.png");
    const withBleed: Recipe = { ...tee, bleedPx: 50 };
    const result = await runRecipe({ inputPath: srcHiRes, outputPath: out, recipe: withBleed, realesrganBin: "/nonexistent" });
    const meta = await sharp(result.outputPath).metadata();
    expect(meta.width).toBe(1300);  // 1200 + 50*2
    expect(meta.height).toBe(1600); // 1500 + 50*2
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: FAIL — cannot find module `../src/processing/pipeline.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/processing/pipeline.ts
import sharp from "sharp";
import { dirname } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { Recipe } from "../types.js";
import { decideUpscaleFactor, upscaleImage } from "./upscale.js";

export interface RunRecipeInput {
  inputPath: string;
  outputPath: string;
  recipe: Recipe;
  realesrganBin: string;
}

export interface RunRecipeResult {
  outputPath: string;
  upscaled: boolean;
  upscaleFactor: number;
  warning?: string;
}

function bgColor(bg: string): sharp.Color {
  if (bg === "transparent") return { r: 0, g: 0, b: 0, alpha: 0 };
  return bg; // hex string accepted by sharp
}

export async function runRecipe(input: RunRecipeInput): Promise<RunRecipeResult> {
  const { recipe } = input;
  await mkdir(dirname(input.outputPath), { recursive: true });

  const [targetW, targetH] = recipe.printPx;
  const meta = await sharp(input.inputPath).metadata();
  const srcW = meta.width ?? 0;
  const srcH = meta.height ?? 0;

  // 1. Decide + perform upscale
  const factor = decideUpscaleFactor({
    srcW, srcH, targetW, targetH, mode: recipe.upscale, max: recipe.maxUpscale,
  });
  let working = input.inputPath;
  let upscaled = false;
  let warning: string | undefined;
  if (factor > 1) {
    const upPath = `${input.outputPath}.upscaled.png`;
    try {
      working = await upscaleImage(input.realesrganBin, input.inputPath, upPath, factor);
      upscaled = true;
    } catch (e) {
      warning = `Upscale failed, fell back to resampling: ${(e as Error).message}`;
      working = input.inputPath;
    }
  }

  // 2. Resize/fit to the inner print area
  const fitMode = recipe.fit === "cover" ? "cover" : "contain";
  const resizedBuf = await sharp(working)
    .resize(targetW, targetH, {
      fit: fitMode,
      background: bgColor(recipe.bg),
    })
    .toColourspace("srgb")
    .png()
    .toBuffer();

  // 3. Add bleed (extend canvas evenly) if requested
  let pipeline = sharp(resizedBuf);
  if (recipe.bleedPx > 0) {
    pipeline = pipeline.extend({
      top: recipe.bleedPx, bottom: recipe.bleedPx, left: recipe.bleedPx, right: recipe.bleedPx,
      background: bgColor(recipe.bg),
    });
  }

  // 4. Output in the requested format with dpi metadata
  if (recipe.format === "jpeg") {
    pipeline = pipeline.flatten({ background: recipe.bg === "transparent" ? "#ffffff" : recipe.bg }).jpeg({ quality: 95 });
  } else {
    pipeline = pipeline.png();
  }
  await pipeline.withMetadata({ density: recipe.dpi }).toFile(input.outputPath);

  // cleanup temp upscale file
  if (upscaled) await rm(`${input.outputPath}.upscaled.png`, { force: true });

  return { outputPath: input.outputPath, upscaled, upscaleFactor: factor, warning };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/processing/pipeline.ts tests/pipeline.test.ts
git commit -m "feat: recipe-driven image processing pipeline"
```

---

## Task 7: Airtable design back-link

**Files:**
- Create: `src/airtable/designs.ts`
- Test: covered in `tests/assets-service.test.ts` (mocked); a thin focused test here.
- Test: `tests/designs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/designs.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { backlinkDesign } from "../src/airtable/designs.js";

beforeEach(() => vi.restoreAllMocks());

describe("backlinkDesign", () => {
  it("PATCHes the Design record with the Eagle item id + url", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "rec1" }), { status: 200 }));
    await backlinkDesign({
      token: "pat", baseId: "appX", tableId: "tblD",
      designId: "rec1", eagleItemId: "ITEM1", eagleUrl: "eagle://item/ITEM1",
    });
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/tblD/rec1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      fields: { EagleItemId: "ITEM1", EagleUrl: "eagle://item/ITEM1" },
    });
  });

  it("does nothing when designId is absent", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await backlinkDesign({ token: "pat", baseId: "appX", tableId: "tblD", eagleItemId: "ITEM1", eagleUrl: "u" });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/designs.test.ts`
Expected: FAIL — cannot find module `../src/airtable/designs.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/airtable/designs.ts
export interface BacklinkInput {
  token: string;
  baseId: string;
  tableId: string;
  designId?: string;
  eagleItemId: string;
  eagleUrl: string;
}

/**
 * Write the Eagle item id + url back onto an Airtable Design record.
 * No-op when designId is missing. Assumes the Designs table has
 * single-line-text fields `EagleItemId` and `EagleUrl`.
 */
export async function backlinkDesign(input: BacklinkInput): Promise<void> {
  if (!input.designId) return;
  const url = `https://api.airtable.com/v0/${input.baseId}/${input.tableId}/${input.designId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { EagleItemId: input.eagleItemId, EagleUrl: input.eagleUrl } }),
  });
  if (!res.ok) throw new Error(`Airtable back-link failed: ${res.status}`);
}
```

Note: the Designs table needs `EagleItemId` and `EagleUrl` text fields — added as a setup step in Task 11/`deploy/SETUP.md`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/designs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/airtable/designs.ts tests/designs.test.ts
git commit -m "feat: Airtable Design back-link"
```

---

## Task 8: Assets service (orchestration)

**Files:**
- Create: `src/assets/service.ts`
- Test: `tests/assets-service.test.ts`

The service ties together the Eagle client, recipe loader, pipeline, and Airtable back-link. Dependencies are injected via the constructor so the test can pass fakes (no real Eagle/Airtable needed).

- [ ] **Step 1: Write the failing test**

```ts
// tests/assets-service.test.ts
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
    expect(d.eagle.addFromPath).toHaveBeenCalled();
    // annotation JSON written with the link
    const updateArg = d.eagle.updateItem.mock.calls[0][1];
    expect(JSON.parse(updateArg.annotation)).toMatchObject({ airtableDesignId: "rec1", brand: "TFH" });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/assets-service.test.ts`
Expected: FAIL — cannot find module `../src/assets/service.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/assets/service.ts
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
    const id = await this.deps.eagle.addFromPath(path, {
      name: opts.name, folderId, tags: opts.tags, annotation: JSON.stringify(link),
    });
    // Re-write the annotation to guarantee it is stored (addFromPath annotation support varies).
    await this.writeLink(id, link, opts.tags);
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
    await this.writeLink(id, link, opts.tags);
    await this.deps.backlink({
      token: this.cfg.airtable.token, baseId: this.cfg.airtable.baseId, tableId: this.cfg.airtable.designsTableId,
      designId: opts.airtableDesignId, eagleItemId: id, eagleUrl: `eagle://item/${id}`,
    });
    return this.deps.eagle.itemInfo(id);
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
```

Note: `process()` reads the original from `DATA_DIR/originals/<id>.<ext>`. Ingest must save a copy of the uploaded file there — added in the route layer (Task 10) where the multipart buffer is available, before calling `ingestFromPath`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/assets-service.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/assets/service.ts tests/assets-service.test.ts
git commit -m "feat: assets orchestration service"
```

---

## Task 9: Auth middleware + health route

**Files:**
- Create: `src/middleware/auth.ts`, `src/routes/health.ts`
- Test: `tests/auth.test.ts`, `tests/health.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/auth.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { bearerAuth } from "../src/middleware/auth.js";

function app() {
  const a = new Hono();
  a.use("/api/*", bearerAuth("secret"));
  a.get("/api/ping", (c) => c.json({ ok: true }));
  return a;
}

describe("bearerAuth", () => {
  it("rejects missing token with 401", async () => {
    const res = await app().request("/api/ping");
    expect(res.status).toBe(401);
  });
  it("rejects wrong token with 401", async () => {
    const res = await app().request("/api/ping", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
  it("allows correct token", async () => {
    const res = await app().request("/api/ping", { headers: { Authorization: "Bearer secret" } });
    expect(res.status).toBe(200);
  });
});
```

```ts
// tests/health.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { healthRoute } from "../src/routes/health.js";

describe("healthRoute", () => {
  it("reports eagle reachable", async () => {
    const app = new Hono();
    app.route("/", healthRoute({ checkEagle: vi.fn().mockResolvedValue(true), recipeCount: vi.fn().mockResolvedValue(5) }));
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, eagle: true, recipes: 5 });
  });

  it("returns 503 when eagle unreachable", async () => {
    const app = new Hono();
    app.route("/", healthRoute({ checkEagle: vi.fn().mockResolvedValue(false), recipeCount: vi.fn().mockResolvedValue(0) }));
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/auth.test.ts tests/health.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

```ts
// src/middleware/auth.ts
import type { MiddlewareHandler } from "hono";

export function bearerAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!provided || provided !== token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
```

```ts
// src/routes/health.ts
import { Hono } from "hono";

export interface HealthDeps {
  checkEagle: () => Promise<boolean>;
  recipeCount: () => Promise<number>;
}

export function healthRoute(deps: HealthDeps): Hono {
  const app = new Hono();
  app.get("/api/health", async (c) => {
    const eagle = await deps.checkEagle().catch(() => false);
    const recipes = await deps.recipeCount().catch(() => 0);
    return c.json({ ok: eagle, eagle, recipes }, eagle ? 200 : 503);
  });
  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/auth.test.ts tests/health.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/middleware/auth.ts src/routes/health.ts tests/auth.test.ts tests/health.test.ts
git commit -m "feat: bearer auth middleware + health route"
```

---

## Task 10: Asset + product-type routes

**Files:**
- Create: `src/routes/assets.ts`, `src/routes/productTypes.ts`
- Test: `tests/routes.test.ts`

Routes are thin adapters over `AssetsService` and `RecipeLoader`. Ingest saves the uploaded bytes to `DATA_DIR/originals/<tmp>` first, then ingests. Tests inject a fake service.

- [ ] **Step 1: Write the failing test**

```ts
// tests/routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { assetsRoutes } from "../src/routes/assets.js";
import { productTypesRoutes } from "../src/routes/productTypes.js";

function svcFake() {
  return {
    ingestFromURL: vi.fn().mockResolvedValue({ id: "ITEM1", name: "art", ext: "png", tags: [], folders: [], annotation: "{}" }),
    ingestFromPathBytes: vi.fn().mockResolvedValue({ id: "ITEM1", name: "art", ext: "png", tags: [], folders: [], annotation: "{}" }),
    detail: vi.fn().mockResolvedValue({ item: { id: "ITEM1" }, link: { brand: "TFH" } }),
    search: vi.fn().mockResolvedValue([{ id: "ITEM1" }]),
    setTags: vi.fn().mockResolvedValue({ id: "ITEM1", tags: ["ready"] }),
    process: vi.fn().mockResolvedValue({ processed: { tee: "processed/ITEM1/tee.png" }, results: [] }),
  };
}

describe("assetsRoutes", () => {
  it("POST /api/assets with a url ingests", async () => {
    const svc = svcFake();
    const app = new Hono().route("/", assetsRoutes(svc as any));
    const res = await app.request("/api/assets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://x/y.png", brand: "TFH", name: "art" }),
    });
    expect(res.status).toBe(201);
    expect(svc.ingestFromURL).toHaveBeenCalled();
  });

  it("GET /api/assets searches", async () => {
    const svc = svcFake();
    const app = new Hono().route("/", assetsRoutes(svc as any));
    const res = await app.request("/api/assets?brand=TFH");
    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalled();
  });

  it("POST /api/assets/:id/process runs recipes", async () => {
    const svc = svcFake();
    const app = new Hono().route("/", assetsRoutes(svc as any));
    const res = await app.request("/api/assets/ITEM1/process", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ types: ["tee"] }),
    });
    expect(res.status).toBe(200);
    expect(svc.process).toHaveBeenCalledWith("ITEM1", ["tee"]);
  });
});

describe("productTypesRoutes", () => {
  it("GET /api/product-types lists recipes", async () => {
    const loader = { getAll: vi.fn().mockResolvedValue([{ type: "tee" }]), refresh: vi.fn() };
    const app = new Hono().route("/", productTypesRoutes(loader as any));
    const res = await app.request("/api/product-types");
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });

  it("POST /api/product-types/refresh refreshes", async () => {
    const loader = { getAll: vi.fn(), refresh: vi.fn().mockResolvedValue([{ type: "tee" }]) };
    const app = new Hono().route("/", productTypesRoutes(loader as any));
    const res = await app.request("/api/product-types/refresh", { method: "POST" });
    expect(res.status).toBe(200);
    expect(loader.refresh).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routes.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementations**

```ts
// src/routes/assets.ts
import { Hono } from "hono";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AssetsService, IngestOptions } from "../assets/service.js";

// The route layer needs one extra capability over AssetsService: ingest raw bytes.
// We declare a structural type so tests can supply a fake.
export interface AssetsApi {
  ingestFromURL(url: string, opts: IngestOptions): ReturnType<AssetsService["ingestFromURL"]>;
  ingestFromPathBytes(bytes: Uint8Array, filename: string, opts: IngestOptions): Promise<Awaited<ReturnType<AssetsService["ingestFromPath"]>>>;
  detail(id: string): ReturnType<AssetsService["detail"]>;
  search(params: Parameters<AssetsService["search"]>[0]): ReturnType<AssetsService["search"]>;
  setTags(id: string, add: string[], remove: string[]): ReturnType<AssetsService["setTags"]>;
  process(id: string, types: string[]): ReturnType<AssetsService["process"]>;
}

export function assetsRoutes(svc: AssetsApi): Hono {
  const app = new Hono();

  app.post("/api/assets", async (c) => {
    const contentType = c.req.header("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      if (!body.url || !body.brand) return c.json({ error: "url and brand required" }, 400);
      const item = await svc.ingestFromURL(body.url, {
        brand: body.brand, name: body.name, airtableDesignId: body.airtableDesignId, tags: body.tags, source: body.source,
      });
      return c.json(item, 201);
    }
    // multipart upload
    const form = await c.req.parseBody();
    const file = form["file"];
    const brand = String(form["brand"] ?? "");
    if (!(file instanceof File) || !brand) return c.json({ error: "file and brand required" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const item = await svc.ingestFromPathBytes(bytes, file.name, {
      brand, name: String(form["name"] ?? file.name),
      airtableDesignId: form["airtableDesignId"] ? String(form["airtableDesignId"]) : undefined,
      tags: form["tags"] ? String(form["tags"]).split(",").map((s) => s.trim()) : undefined,
      source: "stacks-upload",
    });
    return c.json(item, 201);
  });

  app.get("/api/assets", async (c) => {
    const q = c.req.query();
    const items = await svc.search({
      q: q.q, brand: q.brand, tag: q.tag,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
      offset: q.offset ? parseInt(q.offset, 10) : undefined,
    });
    return c.json(items);
  });

  app.get("/api/assets/:id", async (c) => {
    return c.json(await svc.detail(c.req.param("id")));
  });

  app.post("/api/assets/:id/tags", async (c) => {
    const body = await c.req.json();
    const item = await svc.setTags(c.req.param("id"), body.add ?? [], body.remove ?? []);
    return c.json(item);
  });

  app.post("/api/assets/:id/process", async (c) => {
    const body = await c.req.json();
    if (!Array.isArray(body.types) || body.types.length === 0) return c.json({ error: "types[] required" }, 400);
    const result = await svc.process(c.req.param("id"), body.types);
    return c.json(result);
  });

  return app;
}

/** Helper used by index.ts to persist uploaded bytes before ingest. */
export async function saveOriginal(dataDir: string, filename: string, bytes: Uint8Array): Promise<string> {
  const dir = join(dataDir, "uploads");
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}
```

```ts
// src/routes/productTypes.ts
import { Hono } from "hono";
import type { RecipeLoader } from "../recipes/loader.js";

export function productTypesRoutes(loader: Pick<RecipeLoader, "getAll" | "refresh">): Hono {
  const app = new Hono();
  app.get("/api/product-types", async (c) => c.json(await loader.getAll()));
  app.post("/api/product-types/refresh", async (c) => c.json(await loader.refresh()));
  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/routes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/assets.ts src/routes/productTypes.ts tests/routes.test.ts
git commit -m "feat: asset + product-type routes"
```

---

## Task 11: Server wiring + entrypoint + ingestFromPathBytes

**Files:**
- Create: `src/server.ts`, `src/index.ts`
- Modify: `src/assets/service.ts` (add `ingestFromPathBytes`)

`ingestFromPathBytes` saves the original to `DATA_DIR/originals/<id>.<ext>` so `process()` can find it. Because the id is only known after Eagle ingest, the flow is: save to a temp path → ingest from that path → copy/rename original into `originals/<id>.<ext>`.

- [ ] **Step 1: Add `ingestFromPathBytes` to `AssetsService`**

Add this method inside the `AssetsService` class in `src/assets/service.ts`:

```ts
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
```

- [ ] **Step 2: Run existing service tests to confirm no regression**

Run: `npx vitest run tests/assets-service.test.ts`
Expected: PASS (still 4 tests; new method not yet covered by unit test — exercised in the live smoke test, Step 6).

- [ ] **Step 3: Write `src/server.ts`**

```ts
// src/server.ts
import { Hono } from "hono";
import type { Config } from "./config.js";
import { EagleClient } from "./eagle/client.js";
import { RecipeLoader } from "./recipes/loader.js";
import { runRecipe } from "./processing/pipeline.js";
import { backlinkDesign } from "./airtable/designs.js";
import { AssetsService } from "./assets/service.js";
import { bearerAuth } from "./middleware/auth.js";
import { healthRoute } from "./routes/health.js";
import { assetsRoutes } from "./routes/assets.js";
import { productTypesRoutes } from "./routes/productTypes.js";

export function buildApp(cfg: Config): Hono {
  const eagle = new EagleClient(cfg.eagleApi, cfg.eagleToken);
  const recipes = new RecipeLoader({
    token: cfg.airtableToken, baseId: cfg.airtableBaseId,
    tableId: cfg.productTypeTableId, cacheDir: cfg.dataDir, ttlMs: cfg.recipeTtlMs,
  });
  const service = new AssetsService(
    { eagle, recipes, runRecipe, backlink: backlinkDesign },
    {
      dataDir: cfg.dataDir,
      airtable: { token: cfg.airtableToken, baseId: cfg.airtableBaseId, designsTableId: cfg.designsTableId },
      realesrganBin: cfg.realesrganBin,
    },
  );

  const app = new Hono();

  // Health is public (no auth) so monitors can poll it.
  app.route("/", healthRoute({
    checkEagle: async () => { try { await eagle.appInfo(); return true; } catch { return false; } },
    recipeCount: async () => (await recipes.getAll().catch(() => [])).length,
  }));

  // Everything else requires the bearer token.
  app.use("/api/assets", bearerAuth(cfg.bridgeToken));
  app.use("/api/assets/*", bearerAuth(cfg.bridgeToken));
  app.use("/api/product-types", bearerAuth(cfg.bridgeToken));
  app.use("/api/product-types/*", bearerAuth(cfg.bridgeToken));

  app.route("/", assetsRoutes(service));
  app.route("/", productTypesRoutes(recipes));

  // Centralized error → JSON.
  app.onError((err, c) => {
    const msg = err.message ?? "internal error";
    const status = /unreachable/i.test(msg) ? 503 : /required|unknown product type/i.test(msg) ? 400 : 500;
    return c.json({ error: msg }, status);
  });

  return app;
}
```

- [ ] **Step 4: Write `src/index.ts`**

```ts
// src/index.ts
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const cfg = loadConfig();
const app = buildApp(cfg);

serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`eagle-bridge listening on http://0.0.0.0:${info.port}`);
});
```

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all tests across every task green.

- [ ] **Step 6: Live smoke test against real Eagle (on veggie)**

Create a real `.env` from `.env.example` (fill `BRIDGE_TOKEN`, `AIRTABLE_TOKEN`, and `EAGLE_TOKEN` from Eagle → Preferences → Developer if writes 401). Then:

Run: `cd ~/eagle-bridge && node --env-file=.env --import tsx src/index.ts &`
Then in another shell:
```bash
TOKEN=$(grep BRIDGE_TOKEN .env | cut -d= -f2)
curl -s localhost:3110/api/health | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" localhost:3110/api/product-types | python3 -m json.tool
# upload a test image into a __bridge_test brand folder
curl -s -H "Authorization: Bearer $TOKEN" -F "file=@/path/to/test.png" -F "brand=__bridge_test" localhost:3110/api/assets | python3 -m json.tool
```
Expected: health `ok:true, eagle:true`; product-types lists recipes (after Airtable fields exist — Task 12); upload returns an item with an id, and the item appears in Eagle's `__bridge_test` folder. Clean up the test item/folder in Eagle afterward.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/index.ts src/assets/service.ts
git commit -m "feat: wire Hono server, entrypoint, byte ingest"
```

---

## Task 12: Airtable schema + setup docs

**Files:**
- Create: `deploy/SETUP.md`

This task documents the one-time external setup (Airtable fields, Real-ESRGAN, Eagle token). No code.

- [ ] **Step 1: Add recipe fields to the Airtable Product Type table** (`tblBr361feqXDpdZA`)

Add fields (types in parens): `type` (single line text), `label` (single line text), `print_width` (number, integer), `print_height` (number, integer), `dpi` (number, default 300), `fit` (single select: contain, cover), `bg` (single line text, e.g. `transparent` or `#ffffff`), `bleed_px` (number, default 0), `format` (single select: png, jpeg), `upscale` (single select: auto, always, never), `max_upscale` (number, default 4).

Seed one row to validate end-to-end:
`type=tee, label=T-Shirt (DTG), print_width=4500, print_height=5400, dpi=300, fit=contain, bg=transparent, bleed_px=0, format=png, upscale=auto, max_upscale=4`

- [ ] **Step 2: Add back-link fields to the Designs table** (`tblLz44lYKbaU9Nge`)

Add `EagleItemId` (single line text) and `EagleUrl` (single line text).

- [ ] **Step 3: Write `deploy/SETUP.md`** capturing the above plus the Eagle token note:

```markdown
# Eagle Bridge — One-Time Setup (veggie)

1. **Eagle application token** (only needed if write endpoints return 401):
   Eagle → Preferences → Developer → copy token → put in `.env` as `EAGLE_TOKEN`.
2. **Airtable Product Type fields** — see plan Task 12 Step 1 (recipe fields + seed `tee` row).
3. **Airtable Designs fields** — `EagleItemId`, `EagleUrl` (single line text).
4. **Real-ESRGAN** — run `scripts/install-realesrgan.sh` (Task 13).
5. **Env** — copy `.env.example` → `.env`, fill `BRIDGE_TOKEN` (long random), Airtable token.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/SETUP.md
git commit -m "docs: external setup (Airtable fields, Eagle token)"
```

---

## Task 13: Real-ESRGAN install script

**Files:**
- Create: `scripts/install-realesrgan.sh`

- [ ] **Step 1: Write `scripts/install-realesrgan.sh`**

```bash
#!/usr/bin/env bash
# Install Real-ESRGAN ncnn-vulkan (macOS arm64) into ./bin
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin && cd bin
VER="v0.2.0"
ZIP="realesrgan-ncnn-vulkan-20220424-macos.zip"
URL="https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/download/${VER}/${ZIP}"
echo "Downloading $URL"
curl -L -o realesrgan.zip "$URL"
unzip -o realesrgan.zip
chmod +x realesrgan-ncnn-vulkan || true
# macOS Gatekeeper: clear quarantine so it runs headless
xattr -dr com.apple.quarantine . || true
echo "Installed. Test: ./realesrgan-ncnn-vulkan -h"
echo "Set REALESRGAN_BIN=$(pwd)/realesrgan-ncnn-vulkan in .env"
```

- [ ] **Step 2: Run it and verify the binary works**

Run: `chmod +x scripts/install-realesrgan.sh && ./scripts/install-realesrgan.sh && ./bin/realesrgan-ncnn-vulkan -h`
Expected: usage text prints (binary runs on M2 without Gatekeeper block). If the macOS build URL is stale, find the current macOS asset on the Real-ESRGAN-ncnn-vulkan releases page and update `VER`/`ZIP`.

- [ ] **Step 3: Live upscale check**

Run: `./bin/realesrgan-ncnn-vulkan -i tests/fixtures/small.png -o /tmp/up.png -s 4 -n realesrgan-x4plus && npx tsx -e "import sharp from 'sharp'; console.log(await sharp('/tmp/up.png').metadata());"`
(Create `tests/fixtures/small.png` as a 256×256 image first if absent: `npx tsx -e "import sharp from 'sharp'; await sharp({create:{width:256,height:256,channels:3,background:'#3366cc'}}).png().toFile('tests/fixtures/small.png');"`)
Expected: `/tmp/up.png` is ~1024×1024 — confirms Metal-accelerated upscale works end to end.

- [ ] **Step 4: Commit**

```bash
git add scripts/install-realesrgan.sh
git commit -m "chore: Real-ESRGAN install script (macOS arm64)"
```

---

## Task 14: Deploy — launchd + Tailscale Serve

**Files:**
- Create: `deploy/com.bre.eagle-bridge.plist`
- Modify: `deploy/SETUP.md` (append deploy steps)

- [ ] **Step 1: Write `deploy/com.bre.eagle-bridge.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bre.eagle-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd /Users/bre/eagle-bridge &amp;&amp; /usr/local/bin/node --env-file=.env --import tsx src/index.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/bre/eagle-bridge/data/bridge.out.log</string>
  <key>StandardErrorPath</key><string>/Users/bre/eagle-bridge/data/bridge.err.log</string>
  <key>WorkingDirectory</key><string>/Users/bre/eagle-bridge</string>
</dict>
</plist>
```

Note: confirm the node path with `which node` and update the `<string>` if it differs (nvm installs land under `~/.nvm/...`; if so, use that absolute path).

- [ ] **Step 2: Load the agent**

Run:
```bash
mkdir -p ~/eagle-bridge/data
cp deploy/com.bre.eagle-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.bre.eagle-bridge.plist
sleep 2 && curl -s localhost:3110/api/health
```
Expected: `{"ok":true,...}`. Manage the job (not the PID) per the imessage-bridge pattern: `launchctl unload/load` to restart.

- [ ] **Step 3: Expose over Tailscale Serve (tailnet-only HTTPS)**

Run: `tailscale serve --bg --https=443 http://localhost:3110`
Then from another tailnet device: `curl -s https://veggie.<tailnet>.ts.net/api/health`
Expected: health JSON reachable across the tailnet, **not** publicly (Serve, not Funnel). Verify it is NOT internet-reachable.

- [ ] **Step 4: Append deploy steps to `deploy/SETUP.md`** documenting Steps 1–3 exactly (launchd load, tailscale serve command, the tailnet health URL). Include the restart command `launchctl unload ... && launchctl load ...`.

- [ ] **Step 5: Commit**

```bash
git add deploy/com.bre.eagle-bridge.plist deploy/SETUP.md
git commit -m "chore: launchd agent + Tailscale Serve deploy"
```

---

## Task 15: README + push to GitHub

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** — overview, the architecture diagram from the spec, quickstart (`npm install`, copy `.env`, `npm test`, run), the API table from the spec §6, and a "talking to it from another device / n8n" curl example using the tailnet URL + Bearer token.

- [ ] **Step 2: Run the full suite once more**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 3: Create the private repo and push**

Run:
```bash
cd ~/eagle-bridge
gh repo create brebuilds/eagle-bridge --private --source=. --remote=origin --push
```
Expected: repo `brebuilds/eagle-bridge` created and pushed.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add README.md
git commit -m "docs: README"
git push
```

---

## Self-Review

**Spec coverage:**
- §4.1 Bridge API → Tasks 9, 10, 11 ✓
- §4.2 Image processing → Tasks 5, 6, 13 ✓
- §4.3 Recipe loader (Airtable + cache) → Task 4 ✓
- §4.4 Airtable link layer → Tasks 7, 8 ✓
- §5 Data model (folders/tags/annotation, Design-level link) → Task 8 (`AssetLink`, `ensureFolder`, annotation write) ✓
- §6 API surface (all 9 routes) → health (9), assets+process+tags+search+detail (10), product-types + refresh (10) ✓
- §7 Processing pipeline (upscale→fit→pad→bleed→sRGB→output) → Task 6 ✓
- §8 Error handling (Eagle 503, 401, upscale fallback, Airtable fallback, 400) → auth (9), `onError` (11), pipeline warning (6), loader fallback (4) ✓
- §9 Security (tailnet-only, token server-side) → Task 14 Step 3, auth (9) ✓
- §10 Deploy (launchd + Serve) → Task 14 ✓
- §11 Testing → unit tests every task + live smoke (11.6), live upscale (13.3) ✓
- §4.5 Stacks UI, §4.6 plugin → explicitly deferred to follow-up plans (scope note) ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; external-setup tasks (12, 14) give exact field types and commands.

**Type consistency:** `Recipe.printPx` `[number,number]` used consistently (loader maps `print_width`/`print_height` → `printPx`; pipeline/tests read `printPx`). `AssetLink` shape identical in types, service, tests. `runRecipe` signature matches `RunRecipeFn` in service and the real impl in pipeline. `ensureFolder`/`addFromPath`/`updateItem`/`itemInfo`/`itemList` signatures match between `EagleClient`, `EagleLike`, and fakes. Routes' `AssetsApi` methods match `AssetsService` method names.
