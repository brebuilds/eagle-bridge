# Eagle Bridge — Design Spec

**Date:** 2026-06-06
**Status:** Approved direction, pending spec review
**Owner:** Bre

## 1. Goal

Make Eagle (running on `veggie.local`) usable as **shared POD asset storage across the
tailnet**. Any device — Macs, iOS, the `brebot` VPS, n8n — can push designs in, pull/browse
them out, tag/organize them for print-on-demand, and trigger automations. Each design links
back to its Airtable **Design** record, and the system produces per-product-type print files
(upscale + resize) on demand.

This is the **foundation** for autonomous multi-product listing — not the listing engine
itself. Autonomous listing is a downstream *consumer* that reuses the existing n8n workflows
and `pod-listing-pipeline` skill.

## 2. Context (as-built environment)

- **Eagle 4.0.0** on `veggie.local` (Tailscale `100.84.254.120`), HTTP API at
  `http://localhost:41595`, current library **"Eaglebary"**. API binds to localhost only —
  this is the core problem the bridge solves.
  - Read endpoints (`/api/folder/list`, `/api/application/info`) work without a token.
  - Write endpoints may require the Eagle **application token** (Preferences → Developer).
    The bridge must hold this token; retrieving/setting it is a setup step.
- **veggie** hardware: Apple **M2 / arm64** → Real-ESRGAN ncnn-vulkan runs Metal-accelerated.
- **Stacks** — a Next.js dashboard on `h64` (`100.113.39.78:3010`), public via
  `https://stacks.brebot.com`. Becomes the human interface (no separate web-UI server built).
- **Brands:** TFH, Coastly, OIB.Guide, Funky Legs, Design & Chill.
- **Airtable** base `appNUnSm9ZMCmASpG`: Designs `tblLz44lYKbaU9Nge`,
  Product Type `tblBr361feqXDpdZA`.

## 3. Architecture

```
┌─ veggie.local (Eagle host, M2) ──────────────────┐      ┌─ h64 ──────────────────┐
│  Eagle 4.0.0  ◄──localhost:41595──►  Bridge API  │      │  Stacks (Next.js)      │
│  library "Eaglebary"                 + Image     │◄─────┤  + Eagle pages         │
│                                      Processing  │ tailnet  (upload / browse /   │
│  in-Eagle plugin (Phase 2) ──────────┘           │ HTTPS     download / link)    │
└──────────┬───────────────────────────────────────┘      └────────────────────────┘
           │ Tailscale Serve (tailnet-only HTTPS, Bearer-token auth)
           ▼
   n8n / brebot VPS / iOS  ──── push · pull · tag · trigger
           │
           ▼  bidirectional link
   Airtable: Design records  ⇄  Eagle item IDs
```

**Trust boundary:** the bridge is **tailnet-only** (never public). Stacks is public, so its
browser pages call the bridge **server-side only** (Next.js API routes / server actions on
`h64`, which is on the tailnet, hold the bridge token). The browser never sees the token; the
bridge is never internet-exposed.

## 4. Components

Each component is independently testable with a single responsibility.

### 4.1 Bridge API service (`veggie`)
- Lightweight Node 24 + TypeScript HTTP service (**Hono** recommended for tiny TS-first
  footprint; Express acceptable). Wraps the Eagle localhost API and adds POD endpoints.
- Auth: `Authorization: Bearer <BRIDGE_TOKEN>` on every route except `/api/health`.
- Persistence: launchd **KeepAlive LaunchAgent** `com.bre.eagle-bridge` (mirrors the existing
  `com.bre.imessage-claude` pattern — manage the job, not the PID).
- Exposure: Tailscale Serve maps the port to tailnet HTTPS.
- **Port: 3110** (within the 3100–3999 standard; distinct host so no collision).

### 4.2 Image Processing module (`veggie`)
- `sharp` (libvips) for deterministic ops: resize, fit, pad/canvas, bleed, sRGB conversion,
  format/output.
- **Real-ESRGAN ncnn-vulkan** (Apple Silicon build) for AI upscaling.
- Recipe-driven: one generic engine that reads a product-type recipe and runs the pipeline.

### 4.3 Product-type recipe loader (`veggie`)
- Source of truth: Airtable **Product Type** table (`tblBr361feqXDpdZA`).
- Cached to local JSON on disk (`~/eagle-bridge/cache/recipes.json`) with TTL + a manual
  `POST /api/product-types/refresh`. If Airtable is unreachable, serve the cache and warn.

### 4.4 Airtable link layer (`veggie`)
- On ingest, write a structured **annotation JSON** onto the Eagle item and back-link the
  Eagle item ID/URL into the Airtable Design record.

### 4.5 Stacks interface pages (`h64`, Phase 1 minimal)
- **Upload page:** drag-drop → server-side `POST /api/assets` (brand picker + optional Design
  link).
- **Browse/search page:** grid with thumbnails → search/filter by brand/tag/folder, download
  original, request a processed print file, open linked Airtable record.

### 4.6 In-Eagle plugin (`veggie`, Phase 2)
- HTML/JS plugin inside Eagle: bulk-tag selected items with brand/status, write/refresh the
  Airtable Design link, and "send to processing".

## 5. Data model & conventions

- **Folders = brands.** Top-level Eagle folder per brand (TFH, Coastly, OIB.Guide, Funky Legs,
  Design & Chill).
- **Tags = operational state.** `status` (`new` · `ready` · `listed` · `archived`) and `type`
  (e.g. `tee`, `sticker`, `leggings`). Tags are for filtering/workflow, *not* a copy of
  Airtable records.
- **Annotation = the join key (JSON):**
  ```json
  {
    "airtableDesignId": "recXXXXXXXXXXXXXX",
    "brand": "TFH",
    "source": "stacks-upload | watch-folder | n8n",
    "processed": { "tee": "processed/<id>/tee.png", "sticker": "..." }
  }
  ```
- **Source-of-truth rule:** Airtable owns *records* (designs, listings, variants, SKUs,
  pricing). Eagle owns *files* + the link + a couple of operational tags. **Never** store the
  full SKU or pricing in Eagle — the SKU is variant-level (`TFH-{CAT}-{DESIGN}-{PRODTYPE}-
  {COLOR}-{SIZE}`) and one design fans out into many SKUs. The link is at the **Design** level.

## 6. API surface (Phase 1)

All routes require `Authorization: Bearer <token>` except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + Eagle reachability + recipe-cache status |
| POST | `/api/assets` | Push asset (multipart file **or** `{url}`); body: `brand`, optional `airtableDesignId`, `tags`. Adds to brand folder, writes annotation, back-links Airtable |
| GET | `/api/assets` | Search/list: `?q=&brand=&tag=&folder=&limit=&offset=` |
| GET | `/api/assets/:id` | Item detail (metadata + annotation + processed map) |
| GET | `/api/assets/:id/file` | Download original |
| POST | `/api/assets/:id/process` | Body `{ types: ["tee","sticker"] }` → run recipes → returns processed file refs |
| GET | `/api/assets/:id/processed/:type` | Fetch a processed print file |
| POST | `/api/assets/:id/tags` | Add/remove tags |
| GET | `/api/product-types` | List cached recipes |
| POST | `/api/product-types/refresh` | Refresh recipe cache from Airtable |

## 7. Image processing pipeline

Per requested product type, the engine runs:

1. **Decide upscale.** Compare source px to recipe `print_px`. If the up-scale factor exceeds a
   threshold (and recipe `upscale` ≠ `never`), run Real-ESRGAN to the needed factor.
2. **Resize / fit** to `print_px` using `fit` (`contain` keeps whole art; `cover` fills).
3. **Pad to canvas** with `bg` (`transparent` for DTG/stickers, or a color).
4. **Add bleed** (`bleed_px`) if specified.
5. **Color profile** → convert to sRGB.
6. **Output** in `format` (default PNG for print) at the recipe `dpi` metadata.
7. **Store** under `~/eagle-bridge/processed/<itemId>/<type>.png`, record in the item's
   annotation `processed` map, and serve via the API. (Importing processed files back into
   Eagle as linked children is **Phase 2**.)

**Recipe schema (from Airtable Product Type):**
```json
{
  "type": "tee",
  "label": "T-Shirt (DTG)",
  "print_px": [4500, 5400],
  "dpi": 300,
  "fit": "contain",
  "bg": "transparent",
  "bleed_px": 0,
  "format": "png",
  "upscale": "auto",
  "max_upscale": 4
}
```

## 8. Error handling

- **Eagle not running / API down** → `503` with a clear message (health endpoint reflects it).
- **Missing/invalid token** → `401`.
- **Upscale failure** → fall back to `sharp` high-quality resampling; flag `upscaled:false` +
  reason in the response rather than failing the job.
- **Airtable unreachable** → serve cached recipes / skip back-link, return a warning field.
- **Unsupported format / oversized file** → `400` with the limit.

## 9. Security

- Tailscale Serve, **tailnet-only**. No public exposure of the bridge.
- Bridge `BRIDGE_TOKEN` stored in env on `veggie` (issuer) and in Stacks server env on `h64`
  (consumer). Never shipped to the browser.
- Eagle application token stored in `veggie` env, used only for Eagle write calls.

## 10. Deployment & persistence

- launchd LaunchAgent `com.bre.eagle-bridge` (KeepAlive) on `veggie`.
- `tailscale serve` config exposing port 3110 as tailnet HTTPS.
- Repo `brebuilds/eagle-bridge` (private), local `~/eagle-bridge/`.

## 11. Testing

- **Unit:** recipe loader (Airtable parse + cache fallback); pipeline math (resize/fit/pad/
  bleed) against sample images of known dimensions.
- **Integration:** live round-trip against Eagle on `veggie` — add → list → tag → read
  annotation — using a dedicated test folder; recipe refresh from Airtable.
- **Manual:** upload via the Stacks page → confirm item lands in Eagle in the right brand
  folder → process a `tee` recipe → download print file → verify exact px/dpi + transparency.

## 12. Tech stack

- Node 24 + TypeScript; **Hono** HTTP service (Express acceptable).
- `sharp` (libvips), **Real-ESRGAN ncnn-vulkan** (arm64/Metal), Airtable REST.
- Stacks pages: existing Next.js app on `h64`.

## 13. Phasing

**Phase 1 (this spec):** bridge API (push/pull/tag/search) · processing engine + Airtable
recipes · Airtable Design linking · minimal Stacks upload + browse pages · launchd + Tailscale
Serve.

**Phase 2:** in-Eagle plugin · richer Stacks UI · import processed files back into Eagle as
linked variants · wire the autonomous-listing trigger (new design → process all types →
n8n create-listing).

## 14. Assumptions & open items

- Eagle application **token** must be retrieved from Preferences → Developer and stored in
  `veggie` env before write endpoints work. (Reads already work token-free.)
- Real-ESRGAN ncnn-vulkan arm64 binary + model files installed on `veggie` during setup.
- Stacks codebase on `h64` is editable to add the Eagle pages (assumed yes; it's Bre's app).
- Airtable Product Type table will be given the recipe fields (print_px, dpi, fit, bg,
  bleed_px, format, upscale, max_upscale) if not already present.
