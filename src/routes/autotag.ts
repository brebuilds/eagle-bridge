import { Hono } from "hono";

export interface QueueLike {
  enqueue(id: string): void;
  status(): { pending: number; current: string | null };
}

export function autotagRoutes(queue: QueueLike): Hono {
  const app = new Hono();
  app.post("/api/assets/:id/autotag", (c) => {
    queue.enqueue(c.req.param("id"));
    return c.json({ queued: true }, 202);
  });
  app.get("/api/autotag/status", (c) => c.json(queue.status()));
  return app;
}
