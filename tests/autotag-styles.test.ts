import { describe, it, expect } from "vitest";
import { normalizeStyles } from "../src/autotag/styles.js";

describe("normalizeStyles", () => {
  it("maps synonyms to controlled styles", () => {
    expect(normalizeStyles(["Retro", "90s", "trippy"])).toEqual(expect.arrayContaining(["retro", "psychedelic"]));
  });
  it("drops unknown style words", () => {
    expect(normalizeStyles(["asdf", "whatever"])).toEqual([]);
  });
  it("dedupes", () => {
    expect(normalizeStyles(["vintage", "retro"])).toEqual(["retro"]);
  });
});
