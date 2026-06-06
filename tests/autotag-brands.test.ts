import { describe, it, expect } from "vitest";
import { inferBrands } from "../src/autotag/brands.js";

describe("inferBrands", () => {
  it("maps deadhead/jam terms to TFH", () => {
    expect(inferBrands(["grateful dead", "stealie", "jam band"])).toContain("TFH");
  });
  it("maps coastal terms to Coastly and OIB to OIB.Guide", () => {
    const b = inferBrands(["beach vibes", "coastal", "ocean isle beach"]);
    expect(b).toContain("Coastly");
    expect(b).toContain("OIB.Guide");
  });
  it("maps leggings/all-over to Funky Legs", () => {
    expect(inferBrands(["all-over print leggings"])).toContain("Funky Legs");
  });
  it("returns [] when nothing matches", () => {
    expect(inferBrands(["dollar general", "90s nostalgia"])).toEqual([]);
  });
  it("dedupes and is case-insensitive", () => {
    expect(inferBrands(["DEADHEAD", "deadhead"])).toEqual(["TFH"]);
  });
});
