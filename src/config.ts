export interface Config {
  port: number;
  bridgeToken: string;
  eagleApi: string;
  eagleToken: string;
  airtableToken: string;
  airtableBaseId: string;
  recipesTableId: string;
  designsTableId: string;
  dataDir: string;
  recipeTtlMs: number;
  realesrganBin: string;
  ollamaUrl: string;
  ollamaVisionModel: string;
  autotagOnIngest: boolean;
  autotagConcurrency: number;
  autotagImagePx: number;
  autotagTimeoutMs: number;
  autotagMaxAttempts: number;
}

function req(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (v === undefined || v === "") throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: parseInt(env.BRIDGE_PORT ?? "3110", 10),
    bridgeToken: req(env, "BRIDGE_TOKEN"),
    eagleApi: env.EAGLE_API ?? "http://localhost:41595",
    eagleToken: env.EAGLE_TOKEN ?? "",
    airtableToken: req(env, "AIRTABLE_TOKEN"),
    airtableBaseId: req(env, "AIRTABLE_BASE_ID"),
    recipesTableId: req(env, "AIRTABLE_RECIPES_TABLE"),
    designsTableId: req(env, "AIRTABLE_DESIGNS_TABLE"),
    dataDir: req(env, "DATA_DIR"),
    recipeTtlMs: parseInt(env.RECIPE_TTL_MS ?? "3600000", 10),
    realesrganBin: req(env, "REALESRGAN_BIN"),
    ollamaUrl: env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaVisionModel: env.OLLAMA_VISION_MODEL ?? "llama3.2-vision:11b",
    autotagOnIngest: env.AUTOTAG_ON_INGEST === "true",
    autotagConcurrency: parseInt(env.AUTOTAG_CONCURRENCY ?? "1", 10),
    autotagImagePx: parseInt(env.AUTOTAG_IMAGE_PX ?? "640", 10),
    autotagTimeoutMs: parseInt(env.AUTOTAG_TIMEOUT_MS ?? "300000", 10),
    autotagMaxAttempts: parseInt(env.AUTOTAG_MAX_ATTEMPTS ?? "3", 10),
  };
}
