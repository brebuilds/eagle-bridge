# Eagle Bridge

Tailnet-reachable HTTP service that turns the Eagle app on `veggie` into shared
print-on-demand asset storage. Push designs in, pull/browse them out, tag them, run
per-product-type image processing (upscale + resize), and link each design to its Airtable
record — from any device on the tailnet or from n8n.

This repo is the **bridge service** (Phase 1a). The Stacks UI pages and the in-Eagle plugin
are separate follow-ups. See `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Architecture

```
┌─ veggie.local (Eagle host, M2) ──────────────────┐      ┌─ h64 ──────────────────┐
│  Eagle 4.0.0  ◄──localhost:41595──►  Bridge API  │      │  Stacks (Next.js)      │
│  library "Eaglebary"                 + Image     │◄─────┤  + Eagle pages         │
│                                      Processing  │ tailnet  (upload / browse /   │
│  in-Eagle plugin (later) ────────────┘           │ HTTPS     download / link)    │
└──────────┬───────────────────────────────────────┘      └────────────────────────┘
           │ Tailscale Serve (tailnet-only HTTPS, Bearer-token auth)
           ▼
   n8n / brebot VPS / iOS  ──── push · pull · tag · trigger
           │
           ▼  bidirectional link
   Airtable: Design records  ⇄  Eagle item IDs
```

The bridge wraps Eagle's localhost API, loads per-product-type recipes from the Airtable
Product Type table (cached to disk), runs a `sharp` + Real-ESRGAN processing pipeline, and
back-links each ingested design to its Airtable Design record.

## Quickstart

```bash
npm install
cp .env.example .env   # fill BRIDGE_TOKEN, AIRTABLE_TOKEN (EAGLE_TOKEN if writes 401)
npm test               # 30 tests, all mocked — no live services needed
npm start              # starts on :3110
```

Full external wiring (Airtable fields, Real-ESRGAN, launchd, Tailscale) is in
[`deploy/SETUP.md`](deploy/SETUP.md).

## API

All routes require `Authorization: Bearer <BRIDGE_TOKEN>` except `/api/health`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + Eagle reachability + recipe-cache count |
| POST | `/api/assets` | Push asset (multipart `file` **or** JSON `{url}`); `brand`, optional `airtableDesignId`, `tags` |
| GET | `/api/assets` | Search/list: `?q=&brand=&tag=&limit=&offset=` |
| GET | `/api/assets/:id` | Item detail (metadata + link) |
| POST | `/api/assets/:id/tags` | Add/remove tags: `{add:[],remove:[]}` |
| POST | `/api/assets/:id/process` | Run recipes: `{types:["tee","sticker"]}` |
| GET | `/api/product-types` | List cached recipes |
| POST | `/api/product-types/refresh` | Refresh recipe cache from Airtable |

## Talking to it from another device / n8n

```bash
BRIDGE=https://veggie.<your-tailnet>.ts.net
TOKEN=<BRIDGE_TOKEN>

# Push a design from a URL into the TFH brand folder, linked to an Airtable Design
curl -s -X POST "$BRIDGE/api/assets" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/art.png","brand":"TFH","name":"stealie","airtableDesignId":"recXXXX"}'

# Generate the print-ready tee + sticker files for that item
curl -s -X POST "$BRIDGE/api/assets/<ITEM_ID>/process" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"types":["tee","sticker"]}'
```

## Conventions

- **Folders = brands** (TFH, Coastly, OIB.Guide, Funky Legs, Design & Chill).
- **Tags = workflow state** (`new`/`ready`/`listed`/`archived`) + type.
- **Annotation = the join key** — JSON with `airtableDesignId`, `brand`, `source`, and the
  `processed` map. Airtable owns records (SKUs, pricing); Eagle owns files + the link. The
  link is at the **Design** level, never the variant SKU.
