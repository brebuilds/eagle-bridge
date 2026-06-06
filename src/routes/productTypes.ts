import { Hono } from "hono";
import type { RecipeLoader } from "../recipes/loader.js";

export function productTypesRoutes(loader: Pick<RecipeLoader, "getAll" | "refresh">): Hono {
  const app = new Hono();
  app.get("/api/product-types", async (c) => c.json(await loader.getAll()));
  app.post("/api/product-types/refresh", async (c) => c.json(await loader.refresh()));
  return app;
}
