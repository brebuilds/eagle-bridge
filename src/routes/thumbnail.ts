import { Hono } from "hono";
import { readFile as fsReadFile } from "node:fs/promises";
import sharp from "sharp";

/** Airtable's attachment cap is 5 MB; 1024px jpeg lands far under it. */
const MAX_EDGE_PX = 1024;
const JPEG_QUALITY = 82;

export interface ThumbnailDeps {
  thumbnailPath: (id: string) => Promise<string>;
  readFile?: (path: string) => Promise<Buffer>;
}

export function thumbnailRoute(deps: ThumbnailDeps): Hono {
  const app = new Hono();
  const read = deps.readFile ?? ((p: string) => fsReadFile(p));

  app.get("/api/assets/:id/thumbnail", async (c) => {
    let bytes: Buffer;
    try {
      bytes = await read(await deps.thumbnailPath(c.req.param("id")));
    } catch {
      return c.json({ error: "thumbnail not found" }, 404);
    }

    // Eagle hands back the ORIGINAL path when an image needs no thumbnail,
    // and originals in this library run up to 258 MB. Always re-encode.
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
