import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { foldersRoute } from "../src/routes/folders.js";

describe("foldersRoute", () => {
  it("returns the flattened tree", async () => {
    const app = new Hono();
    app.route("/", foldersRoute({
      folderList: vi.fn().mockResolvedValue([
        { id: "f1", name: "OIB Guide", children: [{ id: "f2", name: "Summer" }] },
      ]),
    }));
    const res = await app.request("/api/folders");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.folders).toHaveLength(2);
    expect(body.folders[1]).toMatchObject({ id: "f2", rootName: "OIB Guide" });
  });

  it("returns 503 when Eagle is unreachable", async () => {
    const app = new Hono();
    app.route("/", foldersRoute({
      folderList: vi.fn().mockRejectedValue(new Error("eagle unreachable")),
    }));
    const res = await app.request("/api/folders");
    expect(res.status).toBe(503);
  });
});
