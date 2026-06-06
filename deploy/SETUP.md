# Eagle Bridge — One-Time Setup (veggie)

This document covers the external setup the bridge needs before it's fully live. The
TypeScript service itself is built and tested; these steps wire it to Eagle, Airtable,
Real-ESRGAN, and the tailnet.

## 1. Environment

Copy `.env.example` → `.env` and fill:
- `BRIDGE_TOKEN` — a long random string (e.g. `openssl rand -hex 32`). The shared secret
  every device/n8n uses as `Authorization: Bearer <token>`.
- `AIRTABLE_TOKEN` — a personal access token with read on the POD base
  (`appNUnSm9ZMCmASpG`) and write on the Designs table.
- `EAGLE_TOKEN` — only needed if write endpoints return 401 (see step 2).

## 2. Eagle application token

Eagle's read endpoints work token-free. If `POST /api/assets` returns 401 (write blocked),
get the token: **Eagle → Preferences → Developer → copy token** → set `EAGLE_TOKEN` in `.env`.

## 3. Airtable — Product Type table (`tblBr361feqXDpdZA`)

Add these fields (recipe definition the processing engine reads):

| Field | Type | Notes |
|---|---|---|
| `type` | Single line text | machine key, e.g. `tee` |
| `label` | Single line text | human label, e.g. `T-Shirt (DTG)` |
| `print_width` | Number (integer) | px |
| `print_height` | Number (integer) | px |
| `dpi` | Number | default 300 |
| `fit` | Single select | `contain`, `cover` |
| `bg` | Single line text | `transparent` or a hex like `#ffffff` |
| `bleed_px` | Number | default 0 |
| `format` | Single select | `png`, `jpeg` |
| `upscale` | Single select | `auto`, `always`, `never` |
| `max_upscale` | Number | default 4 |

Seed one row to validate end-to-end:
`type=tee, label=T-Shirt (DTG), print_width=4500, print_height=5400, dpi=300, fit=contain,
bg=transparent, bleed_px=0, format=png, upscale=auto, max_upscale=4`

## 4. Airtable — Designs table (`tblLz44lYKbaU9Nge`)

Add two single-line-text fields for the back-link:
- `EagleItemId`
- `EagleUrl`

## 5. Real-ESRGAN (image upscaling)

Run `scripts/install-realesrgan.sh` — downloads the macOS arm64 ncnn-vulkan build into
`./bin`, clears Gatekeeper quarantine, and prints the `REALESRGAN_BIN` path to set in `.env`.
Verify with `./bin/realesrgan-ncnn-vulkan -h`.

## 6. Run as a service (launchd, KeepAlive)

```bash
mkdir -p ~/eagle-bridge/data
cp deploy/com.bre.eagle-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.bre.eagle-bridge.plist
sleep 2 && curl -s localhost:3110/api/health
```
Expected: `{"ok":true,"eagle":true,"recipes":N}`.

Restart (manage the job, not the PID):
```bash
launchctl unload ~/Library/LaunchAgents/com.bre.eagle-bridge.plist
launchctl load   ~/Library/LaunchAgents/com.bre.eagle-bridge.plist
```

Note: the plist points at the nvm node binary
(`/Users/bre/.nvm/versions/node/v24.15.0/bin/node`). If node is upgraded, update that path.

## 7. Expose over Tailscale (tailnet-only HTTPS)

```bash
tailscale serve --bg --https=443 http://localhost:3110
```
Then from another tailnet device:
```bash
curl -s https://veggie.<your-tailnet>.ts.net/api/health
```
Use **Serve** (tailnet-only), NOT **Funnel** (public). Verify it is NOT reachable from the
public internet. Stacks (on h64) calls this URL server-side, holding `BRIDGE_TOKEN` in its
server env — the bridge is never exposed publicly and the browser never sees the token.
