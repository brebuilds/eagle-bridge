import { Hono } from "hono";
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
