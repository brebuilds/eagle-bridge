import { describe, it, expect } from "vitest";
import { inferBrands } from "../src/autotag/brands.js";

describe("inferBrands", () => {
  it("maps jam-trail terms to ORB", () => {
    expect(inferBrands(["cosmic wanderer", "moon skull", "jam trail"])).toContain("ORB");
  });
  it("maps coastal terms to Tidewash and driftport to Driftport.Guide", () => {
    const b = inferBrands(["beach vibes", "coastal", "driftport beach"]);
    expect(b).toContain("Tidewash");
    expect(b).toContain("Driftport.Guide");
  });
  it("maps leggings/all-over to Wild Tights", () => {
    expect(inferBrands(["all-over print leggings"])).toContain("Wild Tights");
  });
  it("returns [] when nothing matches", () => {
    expect(inferBrands(["dollar general", "90s nostalgia"])).toEqual([]);
  });
  it("dedupes and is case-insensitive", () => {
    expect(inferBrands(["MOON SKULL", "moon skull"])).toEqual(["ORB"]);
  });
});
