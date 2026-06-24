import { createHash } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

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
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;

export class FrecencyStore {
  private readonly entries = new Map<string, FrecencyEntry>();
  private baselineEntries = new Map<string, FrecencyEntry>();
  private readonly cwd: string;
  private readonly filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private replaceOnFlush = false;
  private savePromise: Promise<void> = Promise.resolve();

  constructor(cwd: string) {
    this.cwd = resolve(cwd);
    this.filePath = getFrecencyFilePath(this.cwd);
  }

  get path(): string {
    return this.filePath;
  }

  get size(): number {
    return this.entries.size;
  }

  async load(): Promise<void> {
    replaceEntries(this.entries, await this.readEntriesFromDisk());
    this.baselineEntries = cloneEntries(this.entries);
    this.dirty = false;
    this.replaceOnFlush = false;
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
    this.baselineEntries.clear();
    this.dirty = true;
    this.replaceOnFlush = true;
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
    const replaceOnFlush = this.replaceOnFlush;
    this.replaceOnFlush = false;
    this.savePromise = this.savePromise.catch(() => undefined).then(async () => {
      try {
        await this.withFileLock(async () => {
          const entriesToWrite = replaceOnFlush
            ? cloneEntries(this.entries)
            : await this.mergeWithDisk();
          pruneEntries(entriesToWrite, DEFAULT_MAX_ENTRIES);
          await this.writeEntries(entriesToWrite);
          this.baselineEntries = cloneEntries(entriesToWrite);

          if (!this.dirty && !this.replaceOnFlush) {
            replaceEntries(this.entries, entriesToWrite);
          }
        });
      } catch (error) {
        this.dirty = true;
        throw error;
      }
    });
    await this.savePromise;
  }

  private async mergeWithDisk(): Promise<Map<string, FrecencyEntry>> {
    const merged = await this.readEntriesFromDisk();

    for (const [path, entry] of this.entries) {
      const baseline = this.baselineEntries.get(path);
      const countDelta = baseline
        ? Math.max(0, entry.count - baseline.count)
        : entry.count;
      if (countDelta <= 0) continue;

      const existing = merged.get(path);
      const firstAccessed = baseline ? entry.lastAccessed : entry.firstAccessed;
      if (existing) {
        existing.count += countDelta;
        existing.firstAccessed = Math.min(
          existing.firstAccessed,
          firstAccessed,
        );
        existing.lastAccessed = Math.max(existing.lastAccessed, entry.lastAccessed);
      } else {
        merged.set(path, {
          count: countDelta,
          firstAccessed,
          lastAccessed: entry.lastAccessed,
        });
      }
    }

    return merged;
  }

  private async readEntriesFromDisk(): Promise<Map<string, FrecencyEntry>> {
    const entries = new Map<string, FrecencyEntry>();

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<FrecencyFile>;
      const parsedCwd = typeof parsed.cwd === "string" ? resolve(parsed.cwd) : undefined;
      if (parsed.version !== VERSION || parsedCwd !== this.cwd || !parsed.entries) {
        return entries;
      }

      for (const [path, entry] of Object.entries(parsed.entries)) {
        if (!isValidEntry(entry)) continue;
        entries.set(path, cloneEntry(entry));
      }
    } catch {
      // Missing or malformed frecency files are treated as an empty store.
    }

    return entries;
  }

  private async withFileLock(run: () => Promise<void>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;

    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(`${process.pid}\n`, "utf8");
          await run();
        } finally {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
        }
        return;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (!isFileExistsError(error)) throw error;
        if ((await isStaleLock(lockPath)) && (await tryUnlink(lockPath))) {
          continue;
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async writeEntries(entries: Map<string, FrecencyEntry>): Promise<void> {
    const file: FrecencyFile = {
      version: VERSION,
      cwd: this.cwd,
      entries: Object.fromEntries(entries),
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

function pruneEntries(entries: Map<string, FrecencyEntry>, maxEntries: number): void {
  if (entries.size <= maxEntries) return;

  const keep = [...entries.entries()]
    .sort((left, right) => {
      const leftEntry = left[1];
      const rightEntry = right[1];
      if (leftEntry.lastAccessed !== rightEntry.lastAccessed) {
        return rightEntry.lastAccessed - leftEntry.lastAccessed;
      }
      return rightEntry.count - leftEntry.count;
    })
    .slice(0, maxEntries);

  entries.clear();
  for (const [path, entry] of keep) {
    entries.set(path, entry);
  }
}

function replaceEntries(
  target: Map<string, FrecencyEntry>,
  source: Map<string, FrecencyEntry>,
): void {
  target.clear();
  for (const [path, entry] of source) {
    target.set(path, cloneEntry(entry));
  }
}

function cloneEntries(
  entries: Map<string, FrecencyEntry>,
): Map<string, FrecencyEntry> {
  const clone = new Map<string, FrecencyEntry>();
  replaceEntries(clone, entries);
  return clone;
}

function cloneEntry(entry: FrecencyEntry): FrecencyEntry {
  return {
    count: entry.count,
    firstAccessed: entry.firstAccessed,
    lastAccessed: entry.lastAccessed,
  };
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return Date.now() - stats.mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function tryUnlink(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function getFrecencyFilePath(cwd: string): string {
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return join(getAgentDir(), "fzf-files", "frecency-v1", `${digest}.json`);
}
