import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  BRIDGE_PORT: "3110",
  BRIDGE_TOKEN: "secret",
  EAGLE_API: "http://localhost:41595",
  EAGLE_TOKEN: "",
  AIRTABLE_TOKEN: "pat",
  AIRTABLE_BASE_ID: "appX",
  AIRTABLE_RECIPES_TABLE: "tblP",
  AIRTABLE_DESIGNS_TABLE: "tblD",
  DATA_DIR: "/tmp/eb",
  RECIPE_TTL_MS: "3600000",
  REALESRGAN_BIN: "/tmp/bin/realesrgan",
};

describe("loadConfig", () => {
  it("parses a complete env", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3110);
    expect(c.bridgeToken).toBe("secret");
    expect(c.airtableBaseId).toBe("appX");
    expect(c.recipeTtlMs).toBe(3600000);
  });

  it("throws when a required var is missing", () => {
    const { BRIDGE_TOKEN, ...missing } = base;
    expect(() => loadConfig(missing)).toThrow(/BRIDGE_TOKEN/);
  });
});
