import { Hono } from "hono";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import sharp from "sharp";

/** Airtable's attachment cap is 5 MB; 1024px jpeg lands far under it. */
const MAX_EDGE_PX = 1024;
const JPEG_QUALITY = 82;
/**
 * M9: Eagle hands back the ORIGINAL file path when an image needs no
 * thumbnail, and this library's largest original is 258 MB. Reading the
 * whole file into memory before handing it to sharp is a real memory spike
 * on a laptop, potentially 749 times in sequence during a sync run. Reject
 * anything over this cap before reading it at all.
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024; // 64 MB

export interface ThumbnailDeps {
  thumbnailPath: (id: string) => Promise<string>;
  readFile?: (path: string) => Promise<Buffer>;
  /** Injectable so tests can simulate an oversized source without a real 64MB file. */
  stat?: (path: string) => Promise<{ size: number }>;
}

export function thumbnailRoute(deps: ThumbnailDeps): Hono {
  const app = new Hono();
  const read = deps.readFile ?? ((p: string) => fsReadFile(p));
  const stat = deps.stat ?? ((p: string) => fsStat(p));

  app.get("/api/assets/:id/thumbnail", async (c) => {
    let path: string;
    try {
      path = await deps.thumbnailPath(c.req.param("id"));
    } catch {
      return c.json({ error: "thumbnail not found" }, 404);
    }

    // M9: stat before reading — reject an oversized source without ever
    // loading it into memory. A stat failure here (e.g. the file vanished
    // between thumbnailPath resolving and this call) maps to the same
    // "not found" 404 as a missing thumbnailPath, but is checked in its own
    // try/catch rather than folded into the block above.
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return c.json({ error: "thumbnail not found" }, 404);
    }
    if (size > MAX_SOURCE_BYTES) {
      return c.json(
        { error: `source file too large to thumbnail (${size} bytes, cap ${MAX_SOURCE_BYTES} bytes)` },
        413,
      );
    }

    let bytes: Buffer;
    try {
      bytes = await read(path);
    } catch {
      return c.json({ error: "thumbnail not found" }, 404);
    }

    // Eagle hands back the ORIGINAL path when an image needs no thumbnail,
    // and originals in this library run up to 258 MB. Always re-encode.
    // Sharp deliberately stays OUTSIDE any try/catch above — a sharp failure
    // must propagate as a 500, not be mistaken for the missing-thumbnail path.
    const image = sharp(bytes);
    const meta = await image.metadata();
    const hasAlpha = meta.hasAlpha === true;

    const out = await image
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    return c.body(new Uint8Array(out), 200, {
      "Content-Type": "image/jpeg",
      "X-Has-Alpha": String(hasAlpha),
    });
  });

  return app;
}
