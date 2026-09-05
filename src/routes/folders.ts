import { Hono } from "hono";
import type { EagleFolder } from "../eagle/client.js";
import { flattenFolders } from "../folders/flatten.js";

export interface FoldersDeps {
  folderList: () => Promise<EagleFolder[]>;
}

export function foldersRoute(deps: FoldersDeps): Hono {
  const app = new Hono();
  app.get("/api/folders", async (c) => {
    try {
      const tree = await deps.folderList();
      return c.json({ folders: flattenFolders(tree) });
    } catch {
      return c.json({ error: "eagle unreachable" }, 503);
    }
  });
  return app;
}
