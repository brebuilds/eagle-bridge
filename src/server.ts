import { Hono } from "hono";
import type { Config } from "./config.js";
import { EagleClient } from "./eagle/client.js";
import { RecipeLoader } from "./recipes/loader.js";
import { runRecipe } from "./processing/pipeline.js";
import { backlinkDesign } from "./airtable/designs.js";
import { AssetsService } from "./assets/service.js";
import { bearerAuth } from "./middleware/auth.js";
import { healthRoute } from "./routes/health.js";
import { assetsRoutes } from "./routes/assets.js";
import { productTypesRoutes } from "./routes/productTypes.js";

export function buildApp(cfg: Config): Hono {
  const eagle = new EagleClient(cfg.eagleApi, cfg.eagleToken);
  const recipes = new RecipeLoader({
    token: cfg.airtableToken, baseId: cfg.airtableBaseId,
    tableId: cfg.productTypeTableId, cacheDir: cfg.dataDir, ttlMs: cfg.recipeTtlMs,
  });
  const service = new AssetsService(
    { eagle, recipes, runRecipe, backlink: backlinkDesign },
    {
      dataDir: cfg.dataDir,
      airtable: { token: cfg.airtableToken, baseId: cfg.airtableBaseId, designsTableId: cfg.designsTableId },
      realesrganBin: cfg.realesrganBin,
    },
  );

  const app = new Hono();

  // Health is public (no auth) so monitors can poll it.
  app.route("/", healthRoute({
    checkEagle: async () => { try { await eagle.appInfo(); return true; } catch { return false; } },
    recipeCount: async () => (await recipes.getAll().catch(() => [])).length,
  }));

  // Everything else requires the bearer token.
  app.use("/api/assets", bearerAuth(cfg.bridgeToken));
  app.use("/api/assets/*", bearerAuth(cfg.bridgeToken));
  app.use("/api/product-types", bearerAuth(cfg.bridgeToken));
  app.use("/api/product-types/*", bearerAuth(cfg.bridgeToken));

  app.route("/", assetsRoutes(service));
  app.route("/", productTypesRoutes(recipes));

  // Centralized error → JSON.
  app.onError((err, c) => {
    const msg = err.message ?? "internal error";
    const status = /unreachable/i.test(msg) ? 503 : /required|unknown product type/i.test(msg) ? 400 : 500;
    return c.json({ error: msg }, status);
  });

  return app;
}
