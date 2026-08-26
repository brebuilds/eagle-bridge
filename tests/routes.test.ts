import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { assetsRoutes } from "../src/routes/assets.js";
import { productTypesRoutes } from "../src/routes/productTypes.js";

function svcFake() {
  return {
    ingestFromURL: vi.fn().mockResolvedValue({ id: "ITEM1", name: "art", ext: "png", tags: [], folders: [], annotation: "{}" }),
    ingestFromPathBytes: vi.fn().mockResolvedValue({ id: "ITEM1", name: "art", ext: "png", tags: [], folders: [], annotation: "{}" }),
    detail: vi.fn().mockResolvedValue({ item: { id: "ITEM1" }, link: { brand: "ORB" } }),
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
      body: JSON.stringify({ url: "http://x/y.png", brand: "ORB", name: "art" }),
    });
    expect(res.status).toBe(201);
    expect(svc.ingestFromURL).toHaveBeenCalled();
  });

  it("GET /api/assets searches", async () => {
    const svc = svcFake();
    const app = new Hono().route("/", assetsRoutes(svc as any));
    const res = await app.request("/api/assets?brand=ORB");
    expect(res.status).toBe(200);
    expect(svc.search).toHaveBeenCalled();
  });

  it("POST /api/assets/:id/tags reads add/remove from the body", async () => {
    const svc = svcFake();
    const app = new Hono().route("/", assetsRoutes(svc as any));
    const res = await app.request("/api/assets/ITEM1/tags", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add: ["ready"], remove: ["new"] }),
    });
    expect(res.status).toBe(200);
    expect(svc.setTags).toHaveBeenCalledWith("ITEM1", ["ready"], ["new"]);
  });

  it("POST /api/assets/:id/tags ignores a bare 'tags' key (not part of the contract)", async () => {
    // Regression guard for a real integration bug: a client that POSTs {"tags":[...]}
    // instead of {"add":[...],"remove":[...]} gets a 200 and silently does nothing,
    // because the route only ever reads body.add / body.remove. If a client-side fix
    // changes what key gets sent, this test documents why — see eagle-mcp's
    // eagle_tag_asset test for the client side of this same contract.
    const svc = svcFake();
    const app = new Hono().route("/", assetsRoutes(svc as any));
    const res = await app.request("/api/assets/ITEM1/tags", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["ready"] }),
    });
    expect(res.status).toBe(200);
    expect(svc.setTags).toHaveBeenCalledWith("ITEM1", [], []);
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
