import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Handler = (id: string) => Promise<void>;

/** Disk-backed FIFO with a single worker. Survives restarts; dead-letters after maxAttempts. */
export class AutotagQueue {
  private pending: string[] = [];
  private attempts = new Map<string, number>();
  private running = false;
  private current: string | null = null;

  constructor(private dir: string, private handler: Handler, private maxAttempts = 3) {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(this.file())) {
      try { this.pending = JSON.parse(readFileSync(this.file(), "utf8")); } catch { this.pending = []; }
    }
  }

  private file(): string { return join(this.dir, "autotag-queue.json"); }
  private deadFile(): string { return join(this.dir, "autotag-failed.json"); }
  private persist(): void { writeFileSync(this.file(), JSON.stringify(this.pending)); }

  private deadLetter(id: string): void {
    let dead: string[] = [];
    if (existsSync(this.deadFile())) { try { dead = JSON.parse(readFileSync(this.deadFile(), "utf8")); } catch { dead = []; } }
    dead.push(id);
    writeFileSync(this.deadFile(), JSON.stringify(dead));
  }

  enqueue(id: string): void {
    if (this.pending.includes(id) || this.current === id) return;
    this.pending.push(id);
    this.persist();
    if (this.running) void this.drain();
  }

  start(): void { this.running = true; void this.drain(); }
  stop(): void { this.running = false; }

  status(): { pending: number; current: string | null } {
    return { pending: this.pending.length, current: this.current };
  }

  private draining = false;
  private async drain(): Promise<void> {
    if (this.draining || !this.running) return;
    this.draining = true;
    try {
      while (this.running && this.pending.length > 0) {
        const id = this.pending.shift()!;
        this.persist();
        this.current = id;
        try {
          await this.handler(id);
          this.attempts.delete(id);
        } catch {
          const n = (this.attempts.get(id) ?? 0) + 1;
          if (n >= this.maxAttempts) { this.attempts.delete(id); this.deadLetter(id); }
          else { this.attempts.set(id, n); this.pending.push(id); this.persist(); }
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
