import { describe, it, expect } from "vitest";
import { decideUpscaleFactor } from "../src/processing/upscale.js";

describe("decideUpscaleFactor", () => {
  it("returns 1 when source already meets target (auto)", () => {
    expect(decideUpscaleFactor({ srcW: 4500, srcH: 5400, targetW: 4500, targetH: 5400, mode: "auto", max: 4 })).toBe(1);
  });

  it("rounds up to an integer factor capped at max (auto)", () => {
    // need ~3.0x on width; ESRGAN supports integer scales, capped at max
    expect(decideUpscaleFactor({ srcW: 1500, srcH: 1800, targetW: 4500, targetH: 5400, mode: "auto", max: 4 })).toBe(3);
  });

  it("caps at max even when more is needed (auto)", () => {
    expect(decideUpscaleFactor({ srcW: 500, srcH: 600, targetW: 4500, targetH: 5400, mode: "auto", max: 4 })).toBe(4);
  });

  it("returns 1 when mode is never", () => {
    expect(decideUpscaleFactor({ srcW: 500, srcH: 600, targetW: 4500, targetH: 5400, mode: "never", max: 4 })).toBe(1);
  });

  it("returns at least 2 when mode is always and source already large enough", () => {
    expect(decideUpscaleFactor({ srcW: 4500, srcH: 5400, targetW: 4500, targetH: 5400, mode: "always", max: 4 })).toBe(2);
  });
});
