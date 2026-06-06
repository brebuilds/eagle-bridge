import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { bearerAuth } from "../src/middleware/auth.js";

function app() {
  const a = new Hono();
  a.use("/api/*", bearerAuth("secret"));
  a.get("/api/ping", (c) => c.json({ ok: true }));
  return a;
}

describe("bearerAuth", () => {
  it("rejects missing token with 401", async () => {
    const res = await app().request("/api/ping");
    expect(res.status).toBe(401);
  });
  it("rejects wrong token with 401", async () => {
    const res = await app().request("/api/ping", { headers: { Authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });
  it("allows correct token", async () => {
    const res = await app().request("/api/ping", { headers: { Authorization: "Bearer secret" } });
    expect(res.status).toBe(200);
  });
});
