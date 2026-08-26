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
  OLLAMA_URL: "http://ollama-host.example:11434",
  OLLAMA_VISION_MODEL: "llama3.2-vision:11b",
  AUTOTAG_ON_INGEST: "true",
  AUTOTAG_CONCURRENCY: "1",
  AUTOTAG_IMAGE_PX: "640",
  AUTOTAG_TIMEOUT_MS: "300000",
  AUTOTAG_MAX_ATTEMPTS: "3",
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

  it("parses autotag config with sensible defaults", () => {
    const c = loadConfig(base);
    expect(c.ollamaUrl).toBe("http://ollama-host.example:11434");
    expect(c.ollamaVisionModel).toBe("llama3.2-vision:11b");
    expect(c.autotagOnIngest).toBe(true);
    expect(c.autotagConcurrency).toBe(1);
    expect(c.autotagImagePx).toBe(640);
    const { AUTOTAG_ON_INGEST, ...noFlag } = base;
    expect(loadConfig(noFlag).autotagOnIngest).toBe(false); // default off when unset
  });

  it("defaults OLLAMA_URL to localhost when unset", () => {
    const { OLLAMA_URL, ...noOllamaUrl } = base;
    expect(loadConfig(noOllamaUrl).ollamaUrl).toBe("http://localhost:11434");
  });
});
