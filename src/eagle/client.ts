import type { EagleItem } from "../types.js";

interface AddOptions {
  name?: string;
  folderId?: string;
  tags?: string[];
  annotation?: string;
  website?: string;
}

export interface EagleFolder { id: string; name: string; children?: EagleFolder[] }

export class EagleClient {
  constructor(private baseUrl: string, private token: string) {}

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const u = new URL(path, this.baseUrl);
    if (this.token) u.searchParams.set("token", this.token);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  // Eagle briefly returns 5xx for a freshly-added item while it indexes/generates a
  // thumbnail, so transient 5xx and network blips are retried with a short backoff.
  private static RETRIES = 4;
  private static BACKOFF_MS = 200;

  private async call<T>(path: string, init?: RequestInit, query?: Record<string, string | number | undefined>): Promise<T> {
    let lastErr = "";
    for (let attempt = 0; attempt <= EagleClient.RETRIES; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, EagleClient.BACKOFF_MS * attempt));
      let res: Response;
      try {
        res = await fetch(this.url(path, query), init);
      } catch (e) {
        lastErr = `Eagle unreachable at ${this.baseUrl}: ${(e as Error).message}`;
        continue; // network blip — retry
      }
      if (res.status >= 500) {
        lastErr = `Eagle API error (${path}): ${res.status}`;
        continue; // transient server error (e.g. read-after-write race) — retry
      }
      const body = await res.json().catch(() => ({ status: "error", message: "non-JSON response" }));
      if (!res.ok || body?.status !== "success") {
        // 4xx / logical error — not retriable, fail fast
        throw new Error(`Eagle API error (${path}): ${body?.message ?? res.status}`);
      }
      return body.data as T;
    }
    throw new Error(lastErr || `Eagle API error (${path}): exhausted retries`);
  }

  async appInfo(): Promise<unknown> {
    return this.call("/api/application/info");
  }

  async folderList(): Promise<EagleFolder[]> {
    return this.call<EagleFolder[]>("/api/folder/list");
  }

  /** Find a top-level folder by name, creating it if absent. Returns folder id. */
  async ensureFolder(name: string): Promise<string> {
    const folders = await this.folderList();
    const found = folders.find((f) => f.name === name);
    if (found) return found.id;
    const created = await this.call<{ id: string }>("/api/folder/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderName: name }),
    });
    return created.id;
  }

  async itemList(params: { limit?: number; offset?: number; keyword?: string; tags?: string; folders?: string; ext?: string; orderBy?: string }): Promise<EagleItem[]> {
    return this.call<EagleItem[]>("/api/item/list", undefined, { ...params });
  }

  async itemInfo(id: string): Promise<EagleItem> {
    return this.call<EagleItem>("/api/item/info", undefined, { id });
  }

  async updateItem(id: string, patch: { tags?: string[]; annotation?: string; url?: string }): Promise<void> {
    await this.call("/api/item/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
  }

  async thumbnailPath(id: string): Promise<string> {
    return this.call<string>("/api/item/thumbnail", undefined, { id });
  }

  /**
   * Add an item from a local file path. Eagle returns the new item id in `data`.
   */
  async addFromPath(path: string, opts: AddOptions): Promise<string> {
    const id = await this.call<string>("/api/item/addFromPath", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        name: opts.name,
        folderId: opts.folderId,
        tags: opts.tags,
        annotation: opts.annotation,
        website: opts.website,
      }),
    });
    if (!id) throw new Error("addFromPath: Eagle did not return an item id");
    return id;
  }

  /**
   * Add an item from a URL. Eagle returns the new item id in `data`.
   */
  async addFromURL(url: string, opts: AddOptions): Promise<string> {
    const id = await this.call<string>("/api/item/addFromURL", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        name: opts.name,
        folderId: opts.folderId,
        tags: opts.tags,
        annotation: opts.annotation,
        website: opts.website,
      }),
    });
    if (!id) throw new Error("addFromURL: Eagle did not return an item id");
    return id;
  }
}
