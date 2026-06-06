# Eagle Bridge Auto-Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically tag designs ingested into Eagle using a local vision model (Ollama `llama3.2-vision:11b` on h64), turning messy model output into a hybrid tag vocabulary (controlled brand/style + free seo/subject + sharp colors) stored as Eagle tags + annotation, all async so uploads never block.

**Architecture:** A disk-backed FIFO queue (concurrency 1) runs tag jobs in the background. Each job downscales the image (`sharp`), POSTs it to h64's Ollama, runs it through a pure normalization layer, extracts colors deterministically, and merges results into the Eagle item. Ingest enqueues a job when `AUTOTAG_ON_INGEST=true`; a manual endpoint and a status endpoint round it out.

**Tech Stack:** Node 24, TypeScript, Hono, Vitest, sharp, Ollama HTTP API.

**Context for a fresh session:** This extends the **live** eagle-bridge service in `/Users/bre/eagle-bridge` (Phase 1 already shipped: config, EagleClient, RecipeLoader, processing pipeline, AssetsService, routes, server, launchd on veggie:3110, Tailscale Serve). Read the spec first: `docs/superpowers/specs/2026-06-06-eagle-bridge-autotagging-design.md`. Project conventions: ESM + `moduleResolution: "Bundler"`, source imports use `.js` extensions that Vitest resolves to `.ts`. Tests live in `tests/`. Work on a branch (`feat/autotagging`), NOT `main`. h64 Ollama is at `http://100.113.39.78:11434` with `llama3.2-vision:11b` pulled and reachable from veggie over the tailnet.

---

## File Structure

```
src/vision/ollama.ts       # OllamaVision.tag(imagePath) -> raw model string
src/autotag/palette.ts     # extractColors(imagePath) -> hex[]
src/autotag/brands.ts      # BRAND_KEYWORDS data + inferBrands()
src/autotag/styles.ts      # STYLE_SYNONYMS data + normalizeStyles()
src/autotag/normalize.ts   # parseModelOutput() + normalizeTags() -> AutoTags
src/autotag/tagger.ts      # tagItem(id): orchestrate vision + palette + normalize + Eagle merge
src/autotag/queue.ts       # AutotagQueue: disk-backed FIFO worker
src/routes/autotag.ts      # POST /api/assets/:id/autotag, GET /api/autotag/status
```
Modified: `src/types.ts` (AutoTags + AssetLink fields), `src/config.ts` (autotag env),
`src/assets/service.ts` (enqueue on ingest), `src/server.ts` + `src/index.ts` (wire queue/routes/worker),
`.env.example` (new vars).

---

## Task 1: AutoTags types + config

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Add types to `src/types.ts`** (append after the existing `AssetLink` interface; also add the two optional fields to `AssetLink`)

Add to the `AssetLink` interface (insert these two lines before its closing `}`):
```ts
  autotags?: AutoTags;
  autotagError?: string; // last failure reason; cleared on success
```

Append this new interface at the end of the file:
```ts
// Result of auto-tagging one design image.
export interface AutoTags {
  subject: string[];
  style: string[]; // controlled
  colors: string[]; // hex, from sharp
  seo: string[]; // free
  brandFit: string[]; // controlled
  model: string;
  taggedAt: string; // ISO
}
```

- [ ] **Step 2: Extend the config test** — add to the `base` object in `tests/config.test.ts` (alongside the existing keys):
```ts
  OLLAMA_URL: "http://100.113.39.78:11434",
  OLLAMA_VISION_MODEL: "llama3.2-vision:11b",
  AUTOTAG_ON_INGEST: "true",
  AUTOTAG_CONCURRENCY: "1",
  AUTOTAG_IMAGE_PX: "640",
  AUTOTAG_TIMEOUT_MS: "300000",
  AUTOTAG_MAX_ATTEMPTS: "3",
```
And add a new test inside the `describe("loadConfig", ...)` block:
```ts
  it("parses autotag config with sensible defaults", () => {
    const c = loadConfig(base);
    expect(c.ollamaUrl).toBe("http://100.113.39.78:11434");
    expect(c.ollamaVisionModel).toBe("llama3.2-vision:11b");
    expect(c.autotagOnIngest).toBe(true);
    expect(c.autotagConcurrency).toBe(1);
    expect(c.autotagImagePx).toBe(640);
    const { AUTOTAG_ON_INGEST, ...noFlag } = base;
    expect(loadConfig(noFlag).autotagOnIngest).toBe(false); // default off when unset
  });
```

- [ ] **Step 3: Run the test, expect FAIL**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `c.ollamaUrl` undefined.

- [ ] **Step 4: Extend `src/config.ts`** — add these fields to the `Config` interface:
```ts
  ollamaUrl: string;
  ollamaVisionModel: string;
  autotagOnIngest: boolean;
  autotagConcurrency: number;
  autotagImagePx: number;
  autotagTimeoutMs: number;
  autotagMaxAttempts: number;
```
And add these to the returned object in `loadConfig` (before the closing `};`):
```ts
    ollamaUrl: env.OLLAMA_URL ?? "http://100.113.39.78:11434",
    ollamaVisionModel: env.OLLAMA_VISION_MODEL ?? "llama3.2-vision:11b",
    autotagOnIngest: env.AUTOTAG_ON_INGEST === "true",
    autotagConcurrency: parseInt(env.AUTOTAG_CONCURRENCY ?? "1", 10),
    autotagImagePx: parseInt(env.AUTOTAG_IMAGE_PX ?? "640", 10),
    autotagTimeoutMs: parseInt(env.AUTOTAG_TIMEOUT_MS ?? "300000", 10),
    autotagMaxAttempts: parseInt(env.AUTOTAG_MAX_ATTEMPTS ?? "3", 10),
```

- [ ] **Step 5: Run the test, expect PASS**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/config.ts tests/config.test.ts
git commit -m "feat(autotag): AutoTags type + autotag config"
```

---

## Task 2: Brand inference (data + function)

**Files:**
- Create: `src/autotag/brands.ts`
- Test: `tests/autotag-brands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/autotag-brands.test.ts
import { describe, it, expect } from "vitest";
import { inferBrands } from "../src/autotag/brands.js";

describe("inferBrands", () => {
  it("maps deadhead/jam terms to TFH", () => {
    expect(inferBrands(["grateful dead", "stealie", "jam band"])).toContain("TFH");
  });
  it("maps coastal terms to Coastly and OIB to OIB.Guide", () => {
    const b = inferBrands(["beach vibes", "coastal", "ocean isle beach"]);
    expect(b).toContain("Coastly");
    expect(b).toContain("OIB.Guide");
  });
  it("maps leggings/all-over to Funky Legs", () => {
    expect(inferBrands(["all-over print leggings"])).toContain("Funky Legs");
  });
  it("returns [] when nothing matches", () => {
    expect(inferBrands(["dollar general", "90s nostalgia"])).toEqual([]);
  });
  it("dedupes and is case-insensitive", () => {
    expect(inferBrands(["DEADHEAD", "deadhead"])).toEqual(["TFH"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run tests/autotag-brands.test.ts` → module not found.

- [ ] **Step 3: Implement `src/autotag/brands.ts`**

```ts
// Keyword -> brand map, seeded from the brand skills. Edit freely as data.
const BRAND_KEYWORDS: Record<string, string[]> = {
  TFH: ["deadhead", "grateful dead", "stealie", "phish", "jam band", "jamband", "lot", "psychedelic skull", "dancing bear"],
  Coastly: ["coastal", "beach", "sun-washed", "seaside", "nautical", "ocean", "shore"],
  "OIB.Guide": ["ocean isle beach", "oib", "brunswick county", "sunset beach", "holden beach"],
  "Funky Legs": ["leggings", "all-over print", "all over print", "patterned tights"],
  "Design & Chill": ["sarcasm", "snarky", "meme", "trainwreck"],
};

/** Infer which brands a set of free terms fits. Case-insensitive, deduped, possibly empty. */
export function inferBrands(terms: string[]): string[] {
  const hay = terms.map((t) => t.toLowerCase());
  const out = new Set<string>();
  for (const [brand, keywords] of Object.entries(BRAND_KEYWORDS)) {
    if (keywords.some((kw) => hay.some((t) => t.includes(kw)))) out.add(brand);
  }
  return [...out];
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run tests/autotag-brands.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/autotag/brands.ts tests/autotag-brands.test.ts
git commit -m "feat(autotag): brand inference from keywords"
```

---

## Task 3: Style normalization (data + function)

**Files:**
- Create: `src/autotag/styles.ts`
- Test: `tests/autotag-styles.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/autotag-styles.test.ts
import { describe, it, expect } from "vitest";
import { normalizeStyles } from "../src/autotag/styles.js";

describe("normalizeStyles", () => {
  it("maps synonyms to controlled styles", () => {
    expect(normalizeStyles(["Retro", "90s", "trippy"])).toEqual(expect.arrayContaining(["retro", "psychedelic"]));
  });
  it("drops unknown style words", () => {
    expect(normalizeStyles(["asdf", "whatever"])).toEqual([]);
  });
  it("dedupes", () => {
    expect(normalizeStyles(["vintage", "retro"])).toEqual(["retro"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/autotag/styles.ts`**

```ts
// Map of controlled style -> synonyms that should collapse into it.
const STYLE_SYNONYMS: Record<string, string[]> = {
  retro: ["retro", "vintage", "90s", "80s", "70s", "nostalgia", "nostalgic"],
  psychedelic: ["psychedelic", "trippy", "trip", "groovy", "tie dye", "tie-dye"],
  minimalist: ["minimalist", "minimal", "clean", "simple"],
  "hand-drawn": ["hand-drawn", "hand drawn", "sketch", "sketchy", "doodle"],
  boho: ["boho", "bohemian"],
  grunge: ["grunge", "distressed", "gritty"],
  kawaii: ["kawaii", "cute", "chibi"],
  typographic: ["typography", "typographic", "lettering", "text-based", "text based"],
};

/** Collapse free style words to the controlled vocabulary. Unknowns dropped. Deduped. */
export function normalizeStyles(words: string[]): string[] {
  const hay = words.map((w) => w.toLowerCase().trim());
  const out = new Set<string>();
  for (const [style, syns] of Object.entries(STYLE_SYNONYMS)) {
    if (syns.some((s) => hay.some((w) => w.includes(s)))) out.add(style);
  }
  return [...out];
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/autotag/styles.ts tests/autotag-styles.test.ts
git commit -m "feat(autotag): style normalization to controlled vocab"
```

---

## Task 4: Output parsing + tag normalization

**Files:**
- Create: `src/autotag/normalize.ts`
- Test: `tests/autotag-normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/autotag-normalize.test.ts
import { describe, it, expect } from "vitest";
import { parseModelOutput, normalizeTags } from "../src/autotag/normalize.js";

const messy = `Here is the JSON data for the print-on-demand design:

\`\`\`
{
  "subject": ["In My Dollar General Era"],
  "style": ["Retro"],
  "colors": ["Yellow"],
  "text_in_image": "",
  "seo_keywords": ["Dollar General", "Retro", "Nostalgia", "90s"]
}
\`\`\``;

describe("parseModelOutput", () => {
  it("extracts JSON wrapped in prose + code fences", () => {
    const p = parseModelOutput(messy);
    expect(p.subject).toEqual(["In My Dollar General Era"]);
    expect(p.seo_keywords).toContain("Nostalgia");
  });
  it("returns an empty-ish object on unparseable input", () => {
    const p = parseModelOutput("the model said no");
    expect(p.subject ?? []).toEqual([]);
  });
});

describe("normalizeTags", () => {
  it("builds AutoTags: controlled style/brand, free seo/subject, injected colors", () => {
    const parsed = parseModelOutput(messy);
    const t = normalizeTags(parsed, { colors: ["#f4c20d"], model: "llama3.2-vision:11b", now: "2026-06-06T00:00:00Z" });
    expect(t.style).toContain("retro");          // mapped
    expect(t.colors).toEqual(["#f4c20d"]);        // injected from sharp
    expect(t.seo).toEqual(expect.arrayContaining(["dollar general", "nostalgia"])); // free, lowercased
    expect(t.subject).toContain("in my dollar general era");
    expect(t.brandFit).toEqual([]);               // nothing matches a brand
    expect(t.model).toBe("llama3.2-vision:11b");
    expect(t.taggedAt).toBe("2026-06-06T00:00:00Z");
  });
  it("lowercases, trims, and dedupes free tags", () => {
    const t = normalizeTags({ seo_keywords: ["Retro", " retro ", "RETRO"] }, { colors: [], model: "m", now: "t" });
    expect(t.seo).toEqual(["retro"]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/autotag/normalize.ts`**

```ts
import type { AutoTags } from "../types.js";
import { inferBrands } from "./brands.js";
import { normalizeStyles } from "./styles.js";

export interface ParsedModel {
  subject?: string[];
  style?: string[];
  colors?: string[];
  text_in_image?: string;
  seo_keywords?: string[];
}

/** Extract the first balanced JSON object from messy model output. Never throws. */
export function parseModelOutput(raw: string): ParsedModel {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice) as ParsedModel;
    } catch {
      // fall through to salvage
    }
  }
  return {};
}

function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v === "string") {
      const s = v.toLowerCase().trim();
      if (s) out.add(s);
    }
  }
  return [...out];
}

export interface NormalizeCtx {
  colors: string[]; // hex from sharp
  model: string;
  now: string; // ISO timestamp (injected for testability)
}

/** Turn parsed model output into the hybrid AutoTags vocabulary. */
export function normalizeTags(parsed: ParsedModel, ctx: NormalizeCtx): AutoTags {
  const subject = clean(parsed.subject);
  const seo = clean(parsed.seo_keywords);
  const styleWords = [...(parsed.style ?? []), ...subject, ...seo];
  return {
    subject,
    style: normalizeStyles(styleWords),
    colors: ctx.colors,
    seo,
    brandFit: inferBrands([...subject, ...seo]),
    model: ctx.model,
    taggedAt: ctx.now,
  };
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/autotag/normalize.ts tests/autotag-normalize.test.ts
git commit -m "feat(autotag): model output parsing + tag normalization"
```

---

## Task 5: Color palette extraction (sharp)

**Files:**
- Create: `src/autotag/palette.ts`
- Test: `tests/autotag-palette.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/autotag-palette.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { extractColors } from "../src/autotag/palette.js";

let dir: string;
let img: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eb-pal-"));
  img = join(dir, "red.png");
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 40 } } }).png().toFile(img);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("extractColors", () => {
  it("returns the dominant color as hex for a solid image", async () => {
    const colors = await extractColors(img, 3);
    expect(colors[0].toLowerCase()).toBe("#c81e28"); // 200,30,40
    expect(colors.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/autotag/palette.ts`**

```ts
import sharp from "sharp";

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Extract up to `max` representative colors as hex. Uses sharp's dominant color plus
 * a small posterized histogram for variety. Deterministic.
 */
export async function extractColors(imagePath: string, max = 4): Promise<string[]> {
  const out = new Set<string>();
  // 1. sharp's built-in dominant color
  const { dominant } = await sharp(imagePath).stats();
  out.add(toHex(dominant.r, dominant.g, dominant.b));
  // 2. posterized sample for a couple more buckets
  const w = 16, h = 16;
  const { data, info } = await sharp(imagePath).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += info.channels) {
    const r = Math.round(data[i] / 64) * 64;
    const g = Math.round(data[i + 1] / 64) * 64;
    const b = Math.round(data[i + 2] / 64) * 64;
    const hex = toHex(r, g, b);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const [hex] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (out.size >= max) break;
    out.add(hex);
  }
  return [...out].slice(0, max);
}
```

- [ ] **Step 4: Run, expect PASS.** (If the dominant hex differs slightly due to sharp version, adjust the expected value in the test to the actual `extractColors` output for a solid 200,30,40 image — the point is deterministic dominant extraction.)

- [ ] **Step 5: Commit**

```bash
git add src/autotag/palette.ts tests/autotag-palette.test.ts
git commit -m "feat(autotag): deterministic color palette via sharp"
```

---

## Task 6: Ollama vision client

**Files:**
- Create: `src/vision/ollama.ts`
- Test: `tests/ollama-vision.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ollama-vision.test.ts
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { OllamaVision } from "../src/vision/ollama.js";

let dir: string, img: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "eb-ov-"));
  img = join(dir, "x.png");
  await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(img);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => vi.restoreAllMocks());

describe("OllamaVision.tag", () => {
  it("downscales, posts to /api/generate, returns the response string", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ response: '{"subject":["x"]}' }), { status: 200 })
    );
    const ov = new OllamaVision("http://h:11434", "llama3.2-vision:11b", 640, 300000);
    const out = await ov.tag(img);
    expect(out).toContain('"subject"');
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/api/generate");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("llama3.2-vision:11b");
    expect(Array.isArray(body.images)).toBe(true);
    expect(typeof body.images[0]).toBe("string"); // base64
    expect(body.stream).toBe(false);
  });

  it("throws a clear error on non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("err", { status: 500 }));
    const ov = new OllamaVision("http://h:11434", "m", 640, 300000);
    await expect(ov.tag(img)).rejects.toThrow(/Ollama/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/vision/ollama.ts`**

```ts
import sharp from "sharp";

export const TAG_PROMPT =
  'Tag this print-on-demand design for an Etsy seller. Reply ONLY with JSON: ' +
  '{"subject":[],"style":[],"colors":[],"text_in_image":"","seo_keywords":[]}. ' +
  "Be concise; 3-8 seo_keywords buyers would actually search.";

export class OllamaVision {
  constructor(
    private baseUrl: string,
    private model: string,
    private imagePx: number,
    private timeoutMs: number,
  ) {}

  /** Downscale the image and ask the vision model for tags. Returns the raw response string. */
  async tag(imagePath: string): Promise<string> {
    const buf = await sharp(imagePath).resize(this.imagePx, this.imagePx, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
    const b64 = buf.toString("base64");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: TAG_PROMPT, images: [b64], stream: false, options: { temperature: 0.2 } }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(`Ollama request failed: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
    const body = (await res.json()) as { response?: string };
    return body.response ?? "";
  }
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/vision/ollama.ts tests/ollama-vision.test.ts
git commit -m "feat(autotag): Ollama vision client"
```

---

## Task 7: Tagger orchestration

**Files:**
- Create: `src/autotag/tagger.ts`
- Test: `tests/autotag-tagger.test.ts`

The tagger ties vision + palette + normalize + Eagle merge. Dependencies injected (structural types) so it's fully unit-testable with fakes.

- [ ] **Step 1: Write the failing test**

```ts
// tests/autotag-tagger.test.ts
import { describe, it, expect, vi } from "vitest";
import { Tagger } from "../src/autotag/tagger.js";
import type { EagleItem } from "../src/types.js";

function deps() {
  const item: EagleItem = { id: "I1", name: "art", ext: "png", tags: ["existing"], folders: [], annotation: JSON.stringify({ brand: "TFH" }) };
  return {
    eagle: {
      itemInfo: vi.fn().mockResolvedValue(item),
      updateItem: vi.fn().mockResolvedValue(undefined),
    },
    vision: { tag: vi.fn().mockResolvedValue('{"subject":["skull"],"style":["psychedelic"],"seo_keywords":["grateful dead","skull"]}') },
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
    expect(patch.tags).toEqual(expect.arrayContaining(["existing", "skull", "grateful dead", "psychedelic"]));
    expect(patch.tags).not.toContain("#112233");
    const ann = JSON.parse(patch.annotation);
    expect(ann.brand).toBe("TFH"); // existing annotation preserved
    expect(ann.autotags.colors).toEqual(["#112233"]);
    expect(ann.autotags.brandFit).toContain("TFH");
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
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/autotag/tagger.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add src/autotag/tagger.ts tests/autotag-tagger.test.ts
git commit -m "feat(autotag): tagger orchestration with error capture"
```

---

## Task 8: Disk-backed queue

**Files:**
- Create: `src/autotag/queue.ts`
- Test: `tests/autotag-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/autotag-queue.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutotagQueue } from "../src/autotag/queue.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eb-q-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("AutotagQueue", () => {
  it("processes enqueued ids via the worker and persists state", async () => {
    const processed: string[] = [];
    const q = new AutotagQueue(dir, async (id) => { processed.push(id); }, 3);
    q.start();
    q.enqueue("A"); q.enqueue("B");
    await flush();
    expect(processed).toEqual(["A", "B"]);
    expect(q.status().pending).toBe(0);
  });

  it("dedupes ids already pending", async () => {
    const q = new AutotagQueue(dir, async () => { await new Promise((r) => setTimeout(r, 50)); }, 3);
    q.enqueue("A"); q.enqueue("A");
    expect(q.status().pending).toBe(1);
  });

  it("resumes pending ids from disk on construction", async () => {
    const f = join(dir, "autotag-queue.json");
    require("node:fs").writeFileSync(f, JSON.stringify(["X", "Y"]));
    const processed: string[] = [];
    const q = new AutotagQueue(dir, async (id) => { processed.push(id); }, 3);
    q.start();
    await flush();
    expect(processed).toEqual(["X", "Y"]);
  });

  it("dead-letters an id after max attempts without crashing the loop", async () => {
    const q = new AutotagQueue(dir, async () => { throw new Error("boom"); }, 2);
    q.start();
    q.enqueue("Z");
    await new Promise((r) => setTimeout(r, 60));
    const dead = JSON.parse(readFileSync(join(dir, "autotag-failed.json"), "utf8"));
    expect(dead).toContain("Z");
    expect(q.status().pending).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/autotag/queue.ts`**

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Handler = (id: string) => Promise<void>;

/** Disk-backed FIFO with a single worker. Survives restarts; dead-letters after maxAttempts. */
export class AutotagQueue {
  private pending: string[] = [];
  private attempts = new Map<string, number>();
  private running = false;
  private current: string | null = null;

  constructor(private dir: string, private handler: Handler, private maxAttempts = 3) {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.file())) {
      try { this.pending = JSON.parse(readFileSync(this.file(), "utf8")); } catch { this.pending = []; }
    }
  }

  private file(): string { return join(this.dir, "autotag-queue.json"); }
  private deadFile(): string { return join(this.dir, "autotag-failed.json"); }
  private persist(): void { writeFileSync(this.file(), JSON.stringify(this.pending)); }

  private deadLetter(id: string): void {
    let dead: string[] = [];
    if (existsSync(this.deadFile())) { try { dead = JSON.parse(readFileSync(this.deadFile(), "utf8")); } catch { dead = []; } }
    dead.push(id);
    writeFileSync(this.deadFile(), JSON.stringify(dead));
  }

  enqueue(id: string): void {
    if (this.pending.includes(id) || this.current === id) return;
    this.pending.push(id);
    this.persist();
    if (this.running) void this.drain();
  }

  start(): void { this.running = true; void this.drain(); }
  stop(): void { this.running = false; }

  status(): { pending: number; current: string | null } {
    return { pending: this.pending.length, current: this.current };
  }

  private draining = false;
  private async drain(): Promise<void> {
    if (this.draining || !this.running) return;
    this.draining = true;
    try {
      while (this.running && this.pending.length > 0) {
        const id = this.pending.shift()!;
        this.persist();
        this.current = id;
        try {
          await this.handler(id);
          this.attempts.delete(id);
        } catch {
          const n = (this.attempts.get(id) ?? 0) + 1;
          if (n >= this.maxAttempts) { this.attempts.delete(id); this.deadLetter(id); }
          else { this.attempts.set(id, n); this.pending.push(id); this.persist(); }
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
```

Note: `concurrency` is accepted by the constructor signature in tests as the 3rd arg = `maxAttempts`. The worker is intentionally single-flight (Ollama serializes), so there is no separate concurrency knob beyond 1.

- [ ] **Step 4: Run, expect PASS.** (If the dead-letter timing test is flaky, increase its wait to 100ms — the requeue+retry must cycle `maxAttempts` times.)

- [ ] **Step 5: Commit**

```bash
git add src/autotag/queue.ts tests/autotag-queue.test.ts
git commit -m "feat(autotag): disk-backed FIFO queue with dead-letter"
```

---

## Task 9: Routes + wiring + ingest enqueue

**Files:**
- Create: `src/routes/autotag.ts`
- Modify: `src/assets/service.ts` (enqueue hook)
- Modify: `src/server.ts` (construct queue/tagger, mount routes, expose enqueue)
- Modify: `src/index.ts` (start the worker)
- Modify: `.env.example`
- Test: `tests/autotag-routes.test.ts`

- [ ] **Step 1: Write the failing route test**

```ts
// tests/autotag-routes.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { autotagRoutes } from "../src/routes/autotag.js";

describe("autotagRoutes", () => {
  it("POST /api/assets/:id/autotag enqueues", async () => {
    const q = { enqueue: vi.fn(), status: vi.fn().mockReturnValue({ pending: 1, current: null }) };
    const app = new Hono().route("/", autotagRoutes(q as any));
    const res = await app.request("/api/assets/I1/autotag", { method: "POST" });
    expect(res.status).toBe(202);
    expect(q.enqueue).toHaveBeenCalledWith("I1");
  });
  it("GET /api/autotag/status returns queue status", async () => {
    const q = { enqueue: vi.fn(), status: vi.fn().mockReturnValue({ pending: 2, current: "X" }) };
    const app = new Hono().route("/", autotagRoutes(q as any));
    const res = await app.request("/api/autotag/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 2, current: "X" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement `src/routes/autotag.ts`**

```ts
import { Hono } from "hono";

export interface QueueLike {
  enqueue(id: string): void;
  status(): { pending: number; current: string | null };
}

export function autotagRoutes(queue: QueueLike): Hono {
  const app = new Hono();
  app.post("/api/assets/:id/autotag", (c) => {
    queue.enqueue(c.req.param("id"));
    return c.json({ queued: true }, 202);
  });
  app.get("/api/autotag/status", (c) => c.json(queue.status()));
  return app;
}
```

- [ ] **Step 4: Run the route test, expect PASS.** Then run the FULL suite to confirm no regression: `npx vitest run`.

- [ ] **Step 5: Add an enqueue hook to `AssetsService`** — in `src/assets/service.ts`:

Add an optional callback to `AssetsConfig` (extend the interface):
```ts
  onIngested?: (itemId: string) => void; // e.g. autotag enqueue
```
Then in BOTH `ingestFromPath` and `ingestFromURL`, immediately before `return this.deps.eagle.itemInfo(id);`, add:
```ts
    this.cfg.onIngested?.(id);
```

- [ ] **Step 6: Wire it in `src/server.ts`** — add imports near the top:
```ts
import { OllamaVision } from "./vision/ollama.js";
import { extractColors } from "./autotag/palette.js";
import { Tagger } from "./autotag/tagger.js";
import { AutotagQueue } from "./autotag/queue.js";
import { autotagRoutes } from "./routes/autotag.js";
import { join } from "node:path";
```
Inside `buildApp`, AFTER `service` is created and BEFORE `const app = new Hono();`, add:
```ts
  const vision = new OllamaVision(cfg.ollamaUrl, cfg.ollamaVisionModel, cfg.autotagImagePx, cfg.autotagTimeoutMs);
  const tagger = new Tagger(
    {
      eagle,
      vision,
      extractColors,
      originalPathFor: async (item) => join(cfg.dataDir, "originals", `${item.id}.${item.ext || "png"}`),
      now: () => new Date().toISOString(),
    },
    cfg.ollamaVisionModel,
  );
  const autotagQueue = new AutotagQueue(cfg.dataDir, (id) => tagger.tagItem(id), cfg.autotagMaxAttempts);
  if (cfg.autotagOnIngest) service.setOnIngested((id) => autotagQueue.enqueue(id));
```
Change `buildApp` to return the queue too so `index.ts` can start it. Update the signature/return:
```ts
export function buildApp(cfg: Config): { app: Hono; autotagQueue: AutotagQueue } {
```
Mount the routes alongside the others (these are authed like the rest — add the middleware lines):
```ts
  app.use("/api/autotag/*", bearerAuth(cfg.bridgeToken));
  app.route("/", autotagRoutes(autotagQueue));
```
(`/api/assets/:id/autotag` is already covered by the existing `/api/assets/*` bearerAuth.)
At the end of `buildApp`, change `return app;` to `return { app, autotagQueue };`.

Add a `setOnIngested` method to `AssetsService` (since `onIngested` may be set after construction):
in `src/assets/service.ts`, add inside the class:
```ts
  setOnIngested(cb: (itemId: string) => void): void { this.cfg.onIngested = cb; }
```

- [ ] **Step 7: Update `src/index.ts`** to destructure and start the worker:
```ts
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const cfg = loadConfig();
const { app, autotagQueue } = buildApp(cfg);
autotagQueue.start();

serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`eagle-bridge listening on http://0.0.0.0:${info.port}`);
});
```

- [ ] **Step 8: Update `.env.example`** — append:
```bash
# Auto-tagging (local vision via h64 Ollama)
OLLAMA_URL=http://100.113.39.78:11434
OLLAMA_VISION_MODEL=llama3.2-vision:11b
AUTOTAG_ON_INGEST=true
AUTOTAG_CONCURRENCY=1
AUTOTAG_IMAGE_PX=640
AUTOTAG_TIMEOUT_MS=300000
AUTOTAG_MAX_ATTEMPTS=3
```

- [ ] **Step 9: Type-check + full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run`
Expected: tsc clean; all tests green (existing + new). Fix any wiring type errors minimally (most likely the `buildApp` return-shape change rippling into any other importer — there are none besides `index.ts`).

- [ ] **Step 10: Commit**

```bash
git add src/routes/autotag.ts src/assets/service.ts src/server.ts src/index.ts .env.example tests/autotag-routes.test.ts
git commit -m "feat(autotag): routes, ingest enqueue, server/worker wiring"
```

---

## Task 10: Live validation against h64 (manual)

**Files:** none (operational verification on `veggie`).

- [ ] **Step 1: Add the autotag env to the live `.env`** on veggie (the running deploy uses `~/eagle-bridge/.env`). Append the block from Task 9 Step 8 (real values; `AUTOTAG_ON_INGEST=true`).

- [ ] **Step 2: Restart the launchd service**

Run:
```bash
launchctl unload ~/Library/LaunchAgents/com.bre.eagle-bridge.plist
launchctl load   ~/Library/LaunchAgents/com.bre.eagle-bridge.plist
sleep 3 && curl -s localhost:3110/api/health
```
Expected: `{"ok":true,...}`.

- [ ] **Step 3: Tag a real item end-to-end**

```bash
TOKEN=$(grep BRIDGE_TOKEN ~/eagle-bridge/.env | cut -d= -f2)
# pick any existing image item id from Eagle, then:
curl -s -X POST -H "Authorization: Bearer $TOKEN" localhost:3110/api/assets/<ITEM_ID>/autotag   # -> 202
curl -s -H "Authorization: Bearer $TOKEN" localhost:3110/api/autotag/status                      # watch pending go 1 -> 0
# wait ~3 min (11B vision), then:
curl -s -H "Authorization: Bearer $TOKEN" localhost:3110/api/assets/<ITEM_ID> | python3 -m json.tool
```
Expected: after processing, the item's `link.autotags` is populated (subject/style/colors/seo/brandFit) and the free tags appear in the item's Eagle tags. Confirm in the Eagle app too.

- [ ] **Step 4: Verify ingest auto-enqueues** — upload a test image to a `__bridge_test` folder via `POST /api/assets`; confirm `/api/autotag/status` shows it pending, wait, then confirm tags landed. Trash the test item afterward (`POST http://localhost:41595/api/item/moveToTrash {"itemIds":["<id>"]}`).

- [ ] **Step 5: Commit any tuning** (e.g. prompt tweaks, brand/style map additions discovered during the live run)

```bash
git add -A && git commit -m "chore(autotag): live-validation tuning"
```

---

## Task 11: Finish

- [ ] **Step 1:** Run the full suite once more: `npx vitest run` (all green) and `npx tsc -p tsconfig.json --noEmit` (clean).
- [ ] **Step 2:** Merge `feat/autotagging` → `main`, push: `git checkout main && git merge --ff-only feat/autotagging && git push origin main`.
- [ ] **Step 3:** Update the `eagle-bridge.md` memory: move auto-tagging from "follow-ups" to done; note the live URL behavior, the h64 model, and that backfill + Airtable-SEO remain Phase 2.

---

## Self-Review

**Spec coverage:**
- §2 engine/placement (h64 Ollama, configurable model) → Task 1 (config), Task 6 (client) ✓
- §3 triggers (on-ingest, on-demand, status) → Task 9 (enqueue hook + routes) ✓
- §4 pipeline → Task 7 (tagger orchestration) ✓
- §5 normalization (extraction, brand_fit, style, colors free) → Tasks 2,3,4,5 ✓
- §6 data model (AutoTags, AssetLink fields, Eagle tags = seo+subject+style, colors annotation-only) → Task 1 (types) + Task 7 (merge: colors not in tags, asserted) ✓
- §7 async queue (disk-backed, dedupe, resume, dead-letter) → Task 8 ✓
- §8 components/files → all tasks map to the listed files ✓
- §9 config additions → Task 1 + Task 9 Step 8 ✓
- §10 error handling (never blocks ingest, retries→dead-letter, salvage) → Task 7 (error capture), Task 8 (dead-letter), Task 4 (salvage) ✓
- §11 testing → unit tests each task + Task 10 manual integration ✓
- §12 phasing (backfill + Airtable-SEO are Phase 2) → out of scope, not built ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; the one judgment note (palette expected-hex, queue timing) gives explicit fallback instructions.

**Type consistency:** `AutoTags` fields identical across types.ts, normalize.ts, tagger.ts, tests. `normalizeTags(parsed, ctx)` signature matches caller in tagger. `OllamaVision` constructor `(baseUrl, model, imagePx, timeoutMs)` matches server wiring. `AutotagQueue(dir, handler, maxAttempts)` matches server wiring + tests. `QueueLike`/`VisionLike`/`EagleTagLike` structural types match the real classes' method names (`enqueue`/`status`, `tag`, `itemInfo`/`updateItem`). `buildApp` return-shape change (`{app, autotagQueue}`) is updated in `index.ts` (Task 9 Step 7) — the only importer.
