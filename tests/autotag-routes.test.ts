import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { autotagRoutes } from "../src/routes/autotag.js";

describe("autotagRoutes", () => {
  it("POST /api/assets/:id/autotag enqueues", async () => {
    const q = { enqueue: vi.fn(), status: vi.fn().mockReturnValue({ pending: 1, current: null }) };
    const app = new Hono().route("/", autotagRoutes(q as any));
    const res = await app.request("/api/assets/I1/autotag", { method: "POST" });
    expect(res.status).toBe(202);
    expect(q.enqueue).toHaveBeenCalledWith("I1");
  });
  it("GET /api/autotag/status returns queue status", async () => {
    const q = { enqueue: vi.fn(), status: vi.fn().mockReturnValue({ pending: 2, current: "X" }) };
    const app = new Hono().route("/", autotagRoutes(q as any));
    const res = await app.request("/api/autotag/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: 2, current: "X" });
  });
});
