import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { healthRoute } from "../src/routes/health.js";

describe("healthRoute", () => {
  it("reports eagle reachable", async () => {
    const app = new Hono();
    app.route("/", healthRoute({ checkEagle: vi.fn().mockResolvedValue(true), recipeCount: vi.fn().mockResolvedValue(5) }));
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, eagle: true, recipes: 5 });
  });

  it("returns 503 when eagle unreachable", async () => {
    const app = new Hono();
    app.route("/", healthRoute({ checkEagle: vi.fn().mockResolvedValue(false), recipeCount: vi.fn().mockResolvedValue(0) }));
    const res = await app.request("/api/health");
    expect(res.status).toBe(503);
  });
});
