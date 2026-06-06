import { describe, it, expect, vi, beforeEach } from "vitest";
import { backlinkDesign } from "../src/airtable/designs.js";

beforeEach(() => vi.restoreAllMocks());

describe("backlinkDesign", () => {
  it("PATCHes the Design record with the Eagle item id + url", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "rec1" }), { status: 200 }));
    await backlinkDesign({
      token: "pat", baseId: "appX", tableId: "tblD",
      designId: "rec1", eagleItemId: "ITEM1", eagleUrl: "eagle://item/ITEM1",
    });
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toContain("/tblD/rec1");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      fields: { EagleItemId: "ITEM1", EagleUrl: "eagle://item/ITEM1" },
    });
  });

  it("does nothing when designId is absent", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await backlinkDesign({ token: "pat", baseId: "appX", tableId: "tblD", eagleItemId: "ITEM1", eagleUrl: "u" });
    expect(spy).not.toHaveBeenCalled();
  });
});
