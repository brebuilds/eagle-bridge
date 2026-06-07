import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Resolve the on-disk original for an Eagle item id, regardless of the extension
 * Eagle reports vs. the extension the file was actually saved with. Looks for a file
 * named exactly `${id}.<something>` in `originalsDir`; falls back to `${id}.${fallbackExt}`.
 */
export async function resolveOriginalPath(originalsDir: string, id: string, fallbackExt: string): Promise<string> {
  try {
    const entries = await readdir(originalsDir);
    const prefix = `${id}.`;
    const match = entries.find((e) => e.startsWith(prefix) && !e.slice(prefix.length).includes("."));
    if (match) return join(originalsDir, match);
  } catch {
    // dir missing or unreadable -> fall through to fallback
  }
  return join(originalsDir, `${id}.${fallbackExt}`);
}
