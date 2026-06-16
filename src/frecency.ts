import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface FrecencyEntry {
  count: number;
  firstAccessed: number;
  lastAccessed: number;
}

interface FrecencyFile {
  version: 1;
  cwd: string;
  entries: Record<string, FrecencyEntry>;
}

const VERSION = 1;
const SAVE_DEBOUNCE_MS = 750;
const DEFAULT_MAX_ENTRIES = 20_000;
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1_000;

export class FrecencyStore {
  private readonly entries = new Map<string, FrecencyEntry>();
  private readonly filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private savePromise: Promise<void> = Promise.resolve();

  constructor(private readonly cwd: string) {
    this.filePath = getFrecencyFilePath(cwd);
  }

  get path(): string {
    return this.filePath;
  }

  get size(): number {
    return this.entries.size;
  }

  async load(): Promise<void> {
    this.entries.clear();
    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<FrecencyFile>;
      if (parsed.version !== VERSION || parsed.cwd !== this.cwd || !parsed.entries) {
        return;
      }

      for (const [path, entry] of Object.entries(parsed.entries)) {
        if (!isValidEntry(entry)) continue;
        this.entries.set(path, entry);
      }
    } catch {
      // Missing or malformed frecency files are treated as an empty store.
    }
  }

  record(path: string, now = Date.now()): void {
    const existing = this.entries.get(path);
    if (existing) {
      existing.count += 1;
      existing.lastAccessed = now;
    } else {
      this.entries.set(path, { count: 1, firstAccessed: now, lastAccessed: now });
    }
    this.dirty = true;
    this.scheduleSave();
  }

  score(path: string, now = Date.now()): number {
    const entry = this.entries.get(path);
    if (!entry) return 0;

    const age = Math.max(0, now - entry.lastAccessed);
    const recency = Math.pow(0.5, age / HALF_LIFE_MS);
    return Math.log2(entry.count + 1) * recency;
  }

  clear(): void {
    this.entries.clear();
    this.dirty = true;
    this.scheduleSave();
  }

  scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) {
      await this.savePromise;
      return;
    }

    this.dirty = false;
    this.prune(DEFAULT_MAX_ENTRIES);
    this.savePromise = this.savePromise.then(() => this.writeFile());
    await this.savePromise;
  }

  private prune(maxEntries: number): void {
    if (this.entries.size <= maxEntries) return;

    const keep = [...this.entries.entries()]
      .sort((left, right) => {
        const leftEntry = left[1];
        const rightEntry = right[1];
        if (leftEntry.lastAccessed !== rightEntry.lastAccessed) {
          return rightEntry.lastAccessed - leftEntry.lastAccessed;
        }
        return rightEntry.count - leftEntry.count;
      })
      .slice(0, maxEntries);

    this.entries.clear();
    for (const [path, entry] of keep) {
      this.entries.set(path, entry);
    }
  }

  private async writeFile(): Promise<void> {
    const file: FrecencyFile = {
      version: VERSION,
      cwd: this.cwd,
      entries: Object.fromEntries(this.entries),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}

function isValidEntry(value: unknown): value is FrecencyEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FrecencyEntry>;
  return (
    typeof entry.count === "number" &&
    Number.isFinite(entry.count) &&
    entry.count > 0 &&
    typeof entry.firstAccessed === "number" &&
    Number.isFinite(entry.firstAccessed) &&
    typeof entry.lastAccessed === "number" &&
    Number.isFinite(entry.lastAccessed)
  );
}

function getFrecencyFilePath(cwd: string): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return join(agentDir, "fzf-files", "frecency-v1", `${digest}.json`);
}
