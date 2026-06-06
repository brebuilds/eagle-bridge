import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const cfg = loadConfig();
const app = buildApp(cfg);

serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, (info) => {
  console.log(`eagle-bridge listening on http://0.0.0.0:${info.port}`);
});
