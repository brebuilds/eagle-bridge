import { Hono } from "hono";

export interface HealthDeps {
  checkEagle: () => Promise<boolean>;
  recipeCount: () => Promise<number>;
}

export function healthRoute(deps: HealthDeps): Hono {
  const app = new Hono();
  app.get("/api/health", async (c) => {
    const eagle = await deps.checkEagle().catch(() => false);
    const recipes = await deps.recipeCount().catch(() => 0);
    return c.json({ ok: eagle, eagle, recipes }, eagle ? 200 : 503);
  });
  return app;
}
