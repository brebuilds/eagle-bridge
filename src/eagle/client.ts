import type { EagleItem } from "../types.js";

interface AddOptions {
  name?: string;
  folderId?: string;
  tags?: string[];
  annotation?: string;
  website?: string;
}

interface EagleFolder { id: string; name: string; children?: EagleFolder[] }

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

  private async call<T>(path: string, init?: RequestInit, query?: Record<string, string | number | undefined>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path, query), init);
    } catch (e) {
      throw new Error(`Eagle unreachable at ${this.baseUrl}: ${(e as Error).message}`);
    }
    const body = await res.json().catch(() => ({ status: "error", message: "non-JSON response" }));
    if (!res.ok || body?.status !== "success") {
      throw new Error(`Eagle API error (${path}): ${body?.message ?? res.status}`);
    }
    return body.data as T;
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
   * Add an item from a local file path. Eagle does NOT return the new id,
   * so we resolve it by listing the newest item in the folder and matching name.
   */
  async addFromPath(path: string, opts: AddOptions): Promise<string> {
    await this.call("/api/item/addFromPath", {
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
    const recent = await this.itemList({
      limit: 10,
      orderBy: "-CREATEDATE",
      folders: opts.folderId,
    });
    const match = recent.find((i) => opts.name && i.name === opts.name) ?? recent[0];
    if (!match) throw new Error("addFromPath: could not resolve new item id");
    return match.id;
  }

  async addFromURL(url: string, opts: AddOptions): Promise<string> {
    await this.call("/api/item/addFromURL", {
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
    const recent = await this.itemList({ limit: 10, orderBy: "-CREATEDATE", folders: opts.folderId });
    const match = recent.find((i) => opts.name && i.name === opts.name) ?? recent[0];
    if (!match) throw new Error("addFromURL: could not resolve new item id");
    return match.id;
  }
}
