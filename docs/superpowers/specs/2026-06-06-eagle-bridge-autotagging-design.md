# Eagle Bridge — Auto-Tagging Design Spec

**Date:** 2026-06-06
**Status:** Approved direction, pending spec review
**Owner:** Bre
**Builds on:** `2026-06-06-eagle-bridge-design.md` (the bridge is live on `veggie`)

## 1. Goal

Automatically tag designs as they're ingested into Eagle, using a **local vision model** so
there's no API cost and art never leaves the tailnet. Tags serve four purposes: findability in
Eagle, Etsy/listing SEO fuel, operational routing (brand fit), and (later) backlog organization.

## 2. Engine & placement

- **Vision model runs on h64** (`100.113.39.78`), via its existing Ollama (already exposed on
  the tailnet at `:11434`, model `llama3.2-vision:11b` pulled). The bridge (on `veggie`) POSTs
  images there over the tailnet.
- Model name is **config**, not hardcoded — `llama3.2-vision:11b` is the default "quality lane";
  a small model (e.g. `moondream`) can be set for the future bulk "fast lane".
- **Measured latency:** ~170s/image for the 11B on h64 (CPU). This makes **async mandatory** —
  tagging never blocks an upload.

## 3. Triggers (Phase 1)

- **On ingest** — when `AUTOTAG_ON_INGEST=true`, ingest enqueues a tag job after the asset lands.
- **On demand** — `POST /api/assets/:id/autotag` enqueues (or re-runs) tagging for one item.
- `GET /api/autotag/status` — queue depth + currently-processing id.

(Bulk backfill of the existing library and pushing SEO into Airtable are **Phase 2**.)

## 4. Pipeline per job

```
item id
  → load original file (DATA_DIR/originals/<id>.<ext>; fallback to Eagle thumbnail path)
  → sharp downscale to AUTOTAG_IMAGE_PX (default 640) JPEG, base64
  → POST h64 Ollama /api/generate (vision model, tuned prompt, temperature 0.2)
  → normalize (extract JSON from prose, map facets, dedupe)
  → extract colors from the original via sharp (deterministic hex)
  → merge into Eagle item: free tags → item tags; structured → annotation.autotags
```

## 5. Normalization layer (the core; pure + unit-tested)

`src/autotag/normalize.ts`

- **Robust extraction** — the model wraps JSON in prose and ``` fences and is inconsistent.
  `parseModelOutput(raw)` finds the first balanced `{…}`, `JSON.parse`s it, and on failure
  salvages arrays via lenient regex. Never throws; returns a partial object.
- **Controlled facets:**
  - `brand_fit` — keyword map (`src/autotag/brands.ts`) from the brand skills: e.g.
    deadhead/grateful/phish/stealie/jam → `TFH`; beach/coastal/sun-washed → `Coastly`;
    ocean isle/OIB/brunswick → `OIB.Guide`; leggings/all-over → `Funky Legs`; else unmapped.
    Multiple matches allowed; none is fine.
  - `style` — map model style words to a fixed list via synonyms (`src/autotag/styles.ts`):
    retro/vintage/90s → `retro`; trippy/psychedelic → `psychedelic`; minimal/clean → `minimalist`;
    hand-drawn/sketch → `hand-drawn`; boho/bohemian → `boho`; etc. Unmapped style words are
    dropped from `style` but may survive as free tags.
  - `colors` — **from `sharp`, not the model** (`src/autotag/palette.ts`): dominant + a few
    representative hex values. Deterministic.
- **Free tags:** `seo_keywords` and `subject` kept as-is, lowercased, trimmed, deduped.
- Output: `AutoTags` (see §6).

## 6. Data model

Extend `AssetLink` (in `src/types.ts`):
```ts
export interface AutoTags {
  subject: string[];
  style: string[];        // controlled
  colors: string[];       // hex, from sharp
  seo: string[];          // free
  brandFit: string[];     // controlled
  model: string;          // e.g. "llama3.2-vision:11b"
  taggedAt: string;       // ISO
}
// AssetLink gains:
//   autotags?: AutoTags;
//   autotagError?: string;   // last failure reason (cleared on success)
```

**Eagle storage:** merge the free/searchable tags into the item's existing tags (a `Set`, never
clobber): `seo` + `subject` + `style`. **Colors stay in the annotation only** (raw hex makes ugly
Eagle tags). The full structured `AutoTags` goes into the annotation under `autotags`. Presence of
`autotags` (or `taggedAt`) is the "already tagged" marker Phase-2 backfill will skip on.

## 7. Async queue

`src/autotag/queue.ts` — disk-backed FIFO at `DATA_DIR/autotag-queue.json`.
- `enqueue(id)` appends (dedupe if already pending) and persists.
- A single worker loop (`AUTOTAG_CONCURRENCY=1`, since Ollama serializes) pops, runs the tagger,
  persists, continues. Survives launchd restarts (re-reads the file on boot).
- Failures: increment an attempts counter; after N attempts (default 3) drop to a
  `autotag-failed.json` dead-letter list and record `autotagError` on the item. Never crash the loop.

## 8. Components / files

```
src/vision/ollama.ts      # OllamaVision.tag(imagePath) -> raw string (sharp downscale + POST + timeout)
src/autotag/palette.ts    # extractColors(imagePath) -> hex[]
src/autotag/brands.ts     # keyword -> brand map (data)
src/autotag/styles.ts     # style synonym -> controlled style (data)
src/autotag/normalize.ts  # parseModelOutput + normalizeTags -> AutoTags
src/autotag/tagger.ts     # tagItem(id): orchestrates vision + palette + normalize + Eagle merge
src/autotag/queue.ts      # disk-backed FIFO worker
src/routes/autotag.ts     # POST /api/assets/:id/autotag, GET /api/autotag/status
```
Wiring: `AssetsService.ingest*` calls `queue.enqueue(id)` when `AUTOTAG_ON_INGEST`; `server.ts`
constructs the queue/tagger and mounts the routes; the worker starts in `index.ts`.

## 9. Config additions (`.env`)

```
OLLAMA_URL=http://100.113.39.78:11434
OLLAMA_VISION_MODEL=llama3.2-vision:11b
AUTOTAG_ON_INGEST=true
AUTOTAG_CONCURRENCY=1
AUTOTAG_IMAGE_PX=640
AUTOTAG_TIMEOUT_MS=300000
AUTOTAG_MAX_ATTEMPTS=3
```

## 10. Error handling

- Ollama unreachable / timeout → job fails, retried up to `AUTOTAG_MAX_ATTEMPTS`, then dead-letter +
  `autotagError` on the item. **Ingest is never affected.**
- Malformed model output → best-effort salvage; store whatever parsed + leave `autotagError` if empty.
- Missing original file → fall back to Eagle thumbnail path (URL-decode it — Eagle returns
  `%20`-encoded paths); if still missing, fail the job with a clear reason.

## 11. Testing

- **normalize** (pure): prose+fence-wrapped JSON extraction; malformed/partial salvage; brand
  keyword mapping; style synonym mapping; dedupe/lowercase; empty input.
- **palette** (real sharp): known-color generated image → expected dominant hex.
- **queue**: enqueue/dedupe/persist; resume from disk; failure → attempts → dead-letter; concurrency 1.
- **ollama client**: mocked `fetch` — builds the right request, applies timeout, returns response.
- **tagger**: injected fakes (vision, palette, eagle) — verifies merge into tags + annotation, and
  that errors set `autotagError` without throwing.
- **Integration (manual):** real h64 call on a real design; confirm tags land on the Eagle item.

## 12. Phasing

**Phase 1 (this spec):** async tag-on-ingest + `/api/assets/:id/autotag` + `/api/autotag/status` +
normalization (brand_fit, style, colors, seo, subject) + Eagle tags/annotation storage + disk queue.

**Phase 2 (later):** `/api/autotag/backfill` over the existing library (with a fast model lane) ·
push `seo` into the Airtable Design record · `product_fit` suggestions · optional re-tag-on-demand UI in Stacks.

## 13. Assumptions

- h64 Ollama stays reachable at `OLLAMA_URL` with the configured model pulled.
- New ingests are low-volume, so ~3 min async per image is acceptable; bulk is Phase 2 with a fast model.
- Brand/style maps start small (seeded from the brand skills) and are edited as data over time.
