import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
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

// Tracks file-reference frequency and recency for a single resolved cwd.
// The store is optimistic in memory and periodically reconciles with disk so
// multiple Pi sessions can share one frecency file on a best-effort basis.
export class FrecencyStore {
  private readonly entries = new Map<string, FrecencyEntry>();

  // Snapshot of the last persisted state this instance observed. Normal flushes
  // write only the delta since this baseline to reduce cross-session overwrites.
  private baselineEntries = new Map<string, FrecencyEntry>();

  private readonly cwd: string;
  private readonly filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  // Set by clear() to make the next flush replace disk contents instead of
  // merging with them; otherwise deleted entries would be resurrected from disk.
  private replaceOnFlush = false;

  // Serializes writes from this process and lets callers await an in-flight save.
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

  // Load the persisted store and make it the baseline for future delta merges.
  // Loading is intentionally forgiving: missing, malformed, or mismatched files
  // are treated as an empty frecency history by readEntriesFromDisk().
  async load(): Promise<void> {
    replaceEntries(this.entries, await this.readEntriesFromDisk());
    this.baselineEntries = cloneEntries(this.entries);
    this.dirty = false;
    this.replaceOnFlush = false;
  }

  // Record a selected path immediately in memory, then debounce persistence so
  // rapid inputs do not rewrite the JSON file for every reference.
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

  // Combine frequency with exponential time decay. log2 dampens very frequent
  // paths while the half-life lets recent references rise above stale ones.
  score(path: string, now = Date.now()): number {
    const entry = this.entries.get(path);
    if (!entry) return 0;

    const age = Math.max(0, now - entry.lastAccessed);
    const recency = Math.pow(0.5, age / HALF_LIFE_MS);
    return Math.log2(entry.count + 1) * recency;
  }

  // Clear is a replacement operation, not a merge. The next flush must overwrite
  // the file with an empty set or older disk entries would be merged back in.
  clear(): void {
    this.entries.clear();
    this.baselineEntries.clear();
    this.dirty = true;
    this.replaceOnFlush = true;
    this.scheduleSave();
  }

  // Restart the debounce timer whenever new records arrive. Timer-triggered
  // flushes are fire-and-forget because explicit flush() calls await savePromise.
  scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  // Persist pending changes. Writes are serialized per instance and merged
  // against disk on a best-effort basis. Concurrent Pi sessions may race, but
  // frecency history is non-critical and occasional lost updates are acceptable.
  async flush(): Promise<void> {
    if (this.saveTimer) {
      // A manual flush supersedes the debounce timer and should persist now.
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (!this.dirty) {
      // No new local changes, but a caller may still need to wait for a queued save.
      await this.savePromise;
      return;
    }

    this.dirty = false;
    const replaceOnFlush = this.replaceOnFlush;
    this.replaceOnFlush = false;

    // Previous write failures leave dirty=true; ignore the rejected promise here
    // so the retry can run after the failed save has fully unwound.
    this.savePromise = this.savePromise.catch(() => undefined).then(async () => {
      try {
        // clear() must replace disk; regular records merge only local deltas into
        // the current disk state on a best-effort basis.
        const entriesToWrite = replaceOnFlush
          ? cloneEntries(this.entries)
          : await this.mergeWithDisk();

        // Prune after merging so the cap applies to the final persisted view.
        pruneEntries(entriesToWrite, DEFAULT_MAX_ENTRIES);
        await this.writeEntries(entriesToWrite);
        this.baselineEntries = cloneEntries(entriesToWrite);

        // If records arrived while this async write was in progress, keep those
        // in-memory changes rather than replacing them with the just-written file.
        if (!this.dirty && !this.replaceOnFlush) {
          replaceEntries(this.entries, entriesToWrite);
        }
      } catch (error) {
        // Preserve enough state for the next flush to retry the same operation.
        // This matters for replacement flushes, where retrying as a merge would
        // bring back entries that clear() intended to delete.
        this.dirty = true;
        this.replaceOnFlush ||= replaceOnFlush;
        throw error;
      }
    });
    await this.savePromise;
  }

  // Re-read the file and add only this instance's increments since load/flush.
  // This reduces accidental overwrites between sessions, but another process can
  // still win a concurrent last-write race.
  private async mergeWithDisk(): Promise<Map<string, FrecencyEntry>> {
    const merged = await this.readEntriesFromDisk();

    for (const [path, entry] of this.entries) {
      const baseline = this.baselineEntries.get(path);

      // The baseline gives us a per-path delta. Clamp at zero so stale in-memory
      // state cannot decrement counts that may have been increased on disk.
      const countDelta = baseline
        ? Math.max(0, entry.count - baseline.count)
        : entry.count;
      if (countDelta <= 0) continue;

      const existing = merged.get(path);
      const firstAccessed = baseline ? entry.lastAccessed : entry.firstAccessed;
      if (existing) {
        // Preserve the earliest known access and advance the latest access while
        // adding only the local count delta.
        existing.count += countDelta;
        existing.firstAccessed = Math.min(
          existing.firstAccessed,
          firstAccessed,
        );
        existing.lastAccessed = Math.max(existing.lastAccessed, entry.lastAccessed);
      } else {
        // The path is new relative to the disk snapshot, so persist the local
        // delta as a fresh entry in the merged map.
        merged.set(path, {
          count: countDelta,
          firstAccessed,
          lastAccessed: entry.lastAccessed,
        });
      }
    }

    return merged;
  }

  // Read and validate the persisted JSON. Invalid entries are skipped so one bad
  // record does not discard the whole file, while invalid files become empty maps.
  private async readEntriesFromDisk(): Promise<Map<string, FrecencyEntry>> {
    const entries = new Map<string, FrecencyEntry>();

    try {
      const content = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content) as Partial<FrecencyFile>;
      const parsedCwd = typeof parsed.cwd === "string" ? resolve(parsed.cwd) : undefined;
      if (parsed.version !== VERSION || parsedCwd !== this.cwd || !parsed.entries) {
        // The hash should already partition files by cwd, but the embedded cwd is
        // a cheap guard against stale files or future format changes.
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


  // Write through a temp file and rename into place, so readers either see the
  // previous complete JSON file or the next complete JSON file, never a partial.
  private async writeEntries(entries: Map<string, FrecencyEntry>): Promise<void> {
    const file: FrecencyFile = {
      version: VERSION,
      cwd: this.cwd,
      entries: Object.fromEntries(entries),
    };

    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }
}

// Validate untrusted JSON before it enters the in-memory store.
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

// Keep the frecency file bounded, preferring recently accessed paths and using
// count as a tie-breaker when multiple entries have the same last access time.
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

// Replace a map's contents with cloned entries so callers do not share mutable
// FrecencyEntry objects across disk snapshots, baselines, and live state.
function replaceEntries(
  target: Map<string, FrecencyEntry>,
  source: Map<string, FrecencyEntry>,
): void {
  target.clear();
  for (const [path, entry] of source) {
    target.set(path, cloneEntry(entry));
  }
}

// Clone a full entry map using replaceEntries to keep object-copying consistent.
function cloneEntries(
  entries: Map<string, FrecencyEntry>,
): Map<string, FrecencyEntry> {
  const clone = new Map<string, FrecencyEntry>();
  replaceEntries(clone, entries);
  return clone;
}

// Clone individual entries because recording and merging mutate entry objects.
function cloneEntry(entry: FrecencyEntry): FrecencyEntry {
  return {
    count: entry.count,
    firstAccessed: entry.firstAccessed,
    lastAccessed: entry.lastAccessed,
  };
}


// Hash the resolved cwd into a stable filename so project paths with slashes or
// other filesystem-sensitive characters are safe to store under the agent dir.
function getFrecencyFilePath(cwd: string): string {
  const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 24);
  return join(getAgentDir(), "fzf-files", "frecency-v1", `${digest}.json`);
}
