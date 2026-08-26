# Eagle Bridge

A local HTTP service that turns the [Eagle](https://eagle.cool) app into a shared,
network-reachable print-on-demand (POD) asset store: push designs in, search/browse them,
tag them, run per-product-type print-ready image processing (upscale + resize + bleed +
color/DPI normalization), run vision-based auto-tagging, and back-link each design to an
Airtable record.

## Why this exists

Eagle is a great local design-asset manager, but its API is `localhost`-only and has no
opinion about *print-ready* output or *product-type* recipes. This service sits in front of
it and adds the parts a POD pipeline actually needs:

- **One HTTP surface, reachable from other machines/services** — Eagle's API never leaves
  `localhost`; the bridge is the thing other devices, n8n workflows, or agents actually talk
  to (typically over a private network / VPN, never the public internet).
- **Print-ready processing, not just "resize"** — a product type (tee, sticker, mug, ...) is
  a *recipe*: target pixel dimensions, fit mode, background, bleed, output format, DPI, and
  an upscale policy. Get any one of those wrong and the print comes out wrong, not just
  differently-sized.
- **Vision auto-tagging** — a local vision model looks at each new design and proposes
  subject/style/SEO tags and dominant colors, queued asynchronously so ingestion never blocks
  on a model call.
- **A join key to Airtable** — Eagle owns the files, Airtable owns the business record (SKUs,
  pricing, listing status). The bridge writes a small JSON annotation onto each Eagle item
  (`airtableDesignId`, `brand`, `source`, `processed` outputs) so the two stay linked without
  either system needing to duplicate the other's data.

## Architecture

```
                     ┌────────────────────────────────────────────┐
                     │              eagle-bridge (Hono)            │
                     │                                              │
 Eagle (local,   ◄───┤  EagleClient  ─┐                             │
 localhost API)      │                ├─► AssetsService ─► routes   │◄── other devices /
                     │  RecipeLoader ─┘        │                    │    n8n / agents
 Airtable        ◄───┤  (cached recipes)       ├─► runRecipe        │    (Bearer token,
 (recipes +      │   │                         │   (sharp +         │    e.g. over a
  designs)       └───┤  backlinkDesign         │    Real-ESRGAN)    │    private network)
                     │                         │                    │
 Ollama (local   ◄───┤  OllamaVision ─► Tagger ─► AutotagQueue       │
 vision model)       │                    (disk-backed FIFO)        │
                     └────────────────────────────────────────────┘
```

Everything above is wired together with plain dependency injection in `src/server.ts`
(`buildApp(cfg)`) — no framework magic, no service locator. `EagleClient`, `RecipeLoader`,
`OllamaVision`, and the queue are all constructed once and passed into the things that use
them (`AssetsService`, `Tagger`), which depend only on small structural interfaces
(`AssetsApi`, `TaggerDeps`, `QueueLike`, ...) rather than the concrete classes. That's what
makes the test suite possible without a running Eagle, Airtable, Ollama, or Real-ESRGAN —
every test supplies a fake that satisfies the interface.

### The print-prep pipeline (`src/processing/pipeline.ts` + `upscale.ts`)

For each product type, `runRecipe` does, in order:

1. **Decide whether to upscale, and by how much** (`decideUpscaleFactor`). Real-ESRGAN only
   supports **integer** scale factors (2x, 3x, 4x...), so the target isn't "make it exactly
   `targetW × targetH`" — it's "pick the smallest integer factor that covers the shortfall,
   capped at the recipe's `max_upscale`." A tee print at 4500×5400 from a 1200px source needs
   ≥3.75x; the pipeline rounds up to 4x and lets the resize step in the next stage do the
   exact fit, rather than asking Real-ESRGAN for a non-integer scale it can't produce.
2. **Upscale, then verify the output is real** (`upscaleImage`). Real-ESRGAN can exit 0 while
   having written a missing or corrupt file (bad/missing model weights is a common cause) — a
   clean exit code is not proof of success. The pipeline reads the upscaled file's metadata
   back with `sharp` before trusting it; if that fails, it logs a warning and **falls back to
   resampling the original** rather than shipping a broken print file.
3. **Resize/fit into the print area**, forced through `sRGB`. Product photos and AI-generated
   art routinely carry a wide-gamut or CMYK-tagged profile; printers expect sRGB, and skipping
   the conversion is a classic way to ship colors that look nothing like the proof.
4. **Extend the canvas for bleed**, if the recipe calls for it. Bleed is print margin that
   gets trimmed off after cutting — a sticker recipe with `bleed_px` set to 0 will print with
   a visible white sliver at the cut edge on any real-world cutter tolerance.
5. **Write the output with DPI metadata baked in** (`withMetadata({ density: recipe.dpi })`).
   Getting DPI wrong doesn't change how the file looks on screen; it changes how large the
   print shop's RIP software renders it, which is a "why did my design print at business-card
   size" bug that's invisible until physical product shows up wrong.

### Vision auto-tagging (`src/vision/ollama.ts` + `src/autotag/*`)

`OllamaVision.tag()` downsamples the image, sends it to a local Ollama vision model with a
prompt asking for strict JSON (`subject`, `style`, `colors`, `text_in_image`,
`seo_keywords`), and returns the raw response. `parseModelOutput` in `autotag/normalize.ts`
extracts the first balanced `{...}` from that response rather than trusting the model to
emit *only* JSON (it usually doesn't), and `normalizeTags` turns the parsed output into a
fixed vocabulary: a controlled `style` list (`autotag/styles.ts`), free-text `seo`/`subject`
tags, injected `colors` (extracted independently via `sharp`, not by the model — see
`autotag/palette.ts`), and `brandFit` — an inferred list of which configured brand(s) the
design matches, from `autotag/brands.ts`'s keyword map. Auto-tagging never throws: a failed
vision call is recorded as `autotagError` on the item's annotation instead of failing the
ingest that triggered it.

### The queue (`src/autotag/queue.ts`)

`AutotagQueue` is a disk-backed FIFO with a single worker — deliberately not an in-memory
array. Auto-tagging can be queued on ingest (`AUTOTAG_ON_INGEST=true`) or on demand
(`POST /api/assets/:id/autotag`), and a vision-model call is slow enough that the process
needs to survive a restart mid-queue without losing work: pending IDs are persisted to
`autotag-queue.json` on every enqueue/dequeue, and an item that fails `AUTOTAG_MAX_ATTEMPTS`
times is dead-lettered to `autotag-failed.json` rather than retried forever.

### Design-for-testability

Every side-effecting dependency (`EagleClient`, the Airtable client, `runRecipe`,
`OllamaVision`, the filesystem for originals) is injected behind a small interface, not
imported directly by the code that uses it. That's the whole reason the test suite doesn't
need Eagle, Airtable, Ollama, or Real-ESRGAN installed to run — see `AssetsApi` in
`src/routes/assets.ts`, `TaggerDeps` in `src/autotag/tagger.ts`, and `QueueLike`/`EagleTagLike`
for the shape of what gets faked.

## Run it

```bash
npm install
cp .env.example .env   # fill BRIDGE_TOKEN, AIRTABLE_TOKEN (EAGLE_TOKEN if writes 401)
npm test
npm start               # starts on :3110
```

Full external wiring (Airtable fields, Real-ESRGAN install, launchd service, exposing it
over Tailscale) is in [`deploy/SETUP.md`](deploy/SETUP.md).

## Tests

**63 tests across 19 files, all passing, all mocked** — no live Eagle, Airtable, Ollama, or
Real-ESRGAN required:

```bash
npm test
```

Coverage spans the upscale-factor math, the pipeline's fallback-on-corrupt-upscale path, tag
normalization, the auto-tag queue's persistence/dead-letter/retry behavior, the brand-keyword
inference, config loading (including required-var errors), bearer auth, and every route.

## API

All routes require `Authorization: Bearer <BRIDGE_TOKEN>` except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + Eagle reachability + recipe-cache count |
| POST | `/api/assets` | Push asset (multipart `file` **or** JSON `{url}`); `brand`, optional `airtableDesignId`, `tags` |
| GET | `/api/assets` | Search/list: `?q=&brand=&tag=&limit=&offset=` |
| GET | `/api/assets/:id` | Item detail (metadata + link) |
| POST | `/api/assets/:id/tags` | Add/remove tags: `{"add":[...],"remove":[...]}` |
| POST | `/api/assets/:id/process` | Run recipes: `{"types":["tee","sticker"]}` |
| POST | `/api/assets/:id/autotag` | Enqueue vision auto-tagging (async, 202) |
| GET | `/api/autotag/status` | Queue status: `{pending, current}` |
| GET | `/api/product-types` | List cached recipes |
| POST | `/api/product-types/refresh` | Refresh recipe cache from Airtable |

## Conventions

- **Folders = brands.** Top-level Eagle folder per configured brand — see
  `src/autotag/brands.ts` for the keyword-to-brand inference map (edit freely; it's data).
- **Tags = workflow state** (`new`/`ready`/`listed`/`archived`) + auto-tag vocabulary.
- **Annotation = the join key** — a JSON blob on each Eagle item with `airtableDesignId`,
  `brand`, `source`, and the `processed` output map. Airtable owns the business record
  (SKUs, pricing); Eagle owns files + this link. The link is at the **Design** level, never
  the per-variant SKU.

## Known limitations

- **No plugin/UI layer.** This is the HTTP service only. A browsing/upload UI and an
  in-Eagle plugin were scoped as follow-ups and aren't part of this repo.
- **Real-ESRGAN is a separate binary you install and point at.** It isn't vendored or
  auto-downloaded by `npm install` — see `scripts/install-realesrgan.sh` and
  `deploy/SETUP.md`. If the binary or its models are missing/broken, the pipeline falls back
  to plain resampling rather than failing the whole request (see the pipeline section
  above) — which means a silently-degraded upscale is possible if you never check the
  `warning` field on the process response.
- **Auto-tagging is best-effort, not authoritative.** Vision-model output is unpredictable
  free text; `parseModelOutput`/`normalizeTags` defensively extract what they can, but a
  model that returns garbage yields empty or partial tags rather than an error you'd notice.
- **The brand-keyword map is a flat substring match**, not a classifier — see
  `src/autotag/brands.ts`. It's intentionally simple (it's editable data, not a model), which
  means it can both over- and under-match on ambiguous terms.
- **The queue is single-worker and best-effort ordered**, not a real job system — no
  priority, no per-item cancellation, and `AUTOTAG_CONCURRENCY` beyond 1 isn't actually wired
  up to parallel workers yet.
- **A real integration bug shipped between this service and its MCP client** (a sibling
  repo — see below): the client was POSTing `{"tags":[...]}` to `/api/assets/:id/tags` while
  this route only ever read `body.add`/`body.remove`. The request returned `200` and did
  nothing. It's fixed now (client sends `add`/`remove`, and this repo's route now has direct
  test coverage it previously lacked) but it's a fair example of what a real thin-client
  integration gap looks like — full writeup in
  [eagle-mcp's README](https://github.com/brebuilds/eagle-mcp#a-real-integration-bug-this-repo-found).

## Related

[`eagle-mcp`](https://github.com/brebuilds/eagle-mcp) is a thin Python/FastMCP client that
exposes this API as native tools for Claude and other agents.
