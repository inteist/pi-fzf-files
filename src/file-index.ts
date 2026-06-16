import { opendir } from "node:fs/promises";
import { join } from "node:path";

import type { FrecencyStore } from "./frecency.js";
import { matchFzfQuery, parseFzfQuery } from "./fzf.js";
import {
  basenameDisplay,
  depthOfDisplayPath,
  joinDisplayPath,
  quoteAtPath,
} from "./path-utils.js";
import { TopK } from "./top-k.js";

export interface IndexedPath {
  path: string;
  matchPath: string;
  lowerMatchPath: string;
  name: string;
  isDirectory: boolean;
  depth: number;
}

export interface FileIndexOptions {
  maxEntries?: number;
  maxDepth?: number;
  excludeDirs?: ReadonlySet<string>;
}

export interface FileIndexStats {
  root: string;
  entries: number;
  files: number;
  directories: number;
  indexing: boolean;
  truncated: boolean;
  indexedAt: number | null;
  lastDurationMs: number | null;
}

export interface FileSearchResult {
  path: string;
  value: string;
  label: string;
  description: string;
  isDirectory: boolean;
  score: number;
  frecency: number;
}

interface RankedEntry {
  entry: IndexedPath;
  score: number;
  frecency: number;
}

interface FileIndexBuildState {
  entries: IndexedPath[];
  paths: Set<string>;
  truncated: boolean;
}

const DEFAULT_MAX_ENTRIES = 120_000;
const DEFAULT_MAX_DEPTH = 30;
const DEFAULT_EXCLUDE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".jj",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
]);

export class FileIndex {
  private entries: IndexedPath[] = [];
  private paths = new Set<string>();
  private indexing = false;
  private truncated = false;
  private indexedAt: number | null = null;
  private lastDurationMs: number | null = null;
  private abortController: AbortController | undefined;
  private rebuildPromise: Promise<void> | undefined;

  constructor(
    private readonly root: string,
    private readonly frecency: FrecencyStore,
    private readonly options: FileIndexOptions = {},
  ) {}

  getStats(): FileIndexStats {
    let files = 0;
    let directories = 0;
    for (const entry of this.entries) {
      if (entry.isDirectory) directories += 1;
      else files += 1;
    }

    return {
      root: this.root,
      entries: this.entries.length,
      files,
      directories,
      indexing: this.indexing,
      truncated: this.truncated,
      indexedAt: this.indexedAt,
      lastDurationMs: this.lastDurationMs,
    };
  }

  hasPath(path: string): boolean {
    return this.paths.has(path);
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.indexing = false;
  }

  rebuild(): Promise<void> {
    if (this.rebuildPromise) {
      return this.rebuildPromise;
    }

    let promise: Promise<void>;
    promise = this.performRebuild().finally(() => {
      if (this.rebuildPromise === promise) {
        this.rebuildPromise = undefined;
      }
    });
    this.rebuildPromise = promise;
    return promise;
  }

  private async performRebuild(): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    this.indexing = true;
    const startedAt = Date.now();
    const state: FileIndexBuildState = {
      entries: [],
      paths: new Set<string>(),
      truncated: false,
    };

    try {
      await this.walkDirectory(this.root, "", 0, controller.signal, state);
      if (!controller.signal.aborted) {
        const indexedAt = Date.now();
        this.entries = state.entries;
        this.paths = state.paths;
        this.truncated = state.truncated;
        this.indexedAt = indexedAt;
        this.lastDurationMs = indexedAt - startedAt;
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
      this.indexing = false;
    }
  }

  search(
    queryText: string,
    options: { limit: number; signal: AbortSignal },
  ): FileSearchResult[] {
    if (options.signal.aborted) return [];

    const query = parseFzfQuery(queryText.trim());
    const now = Date.now();
    const top = new TopK<RankedEntry>(
      options.limit,
      (left, right) => compareRanked(left, right) > 0,
    );
    const snapshot = this.entries;

    for (let index = 0; index < snapshot.length; index += 1) {
      if ((index & 1023) === 0 && options.signal.aborted) {
        return [];
      }

      const entry = snapshot[index]!;
      const match = matchFzfQuery(query, entry.matchPath);
      if (!match.matched) continue;

      const frecency = this.frecency.score(entry.path, now);
      const directoryBonus = entry.isDirectory && query.raw.length > 0 ? 6 : 0;
      top.push({ entry, score: match.score + directoryBonus, frecency });
    }

    if (options.signal.aborted) return [];

    return top.valuesBestFirst().map(({ entry, score, frecency }) => {
      const completionPath = entry.isDirectory ? `${entry.path}/` : entry.path;
      return {
        path: entry.path,
        value: quoteAtPath(completionPath),
        label: entry.name + (entry.isDirectory ? "/" : ""),
        description: entry.path,
        isDirectory: entry.isDirectory,
        score,
        frecency,
      };
    });
  }

  private async walkDirectory(
    absDir: string,
    relDir: string,
    depth: number,
    signal: AbortSignal,
    state: FileIndexBuildState,
  ): Promise<void> {
    if (signal.aborted || state.truncated) return;
    if (depth > (this.options.maxDepth ?? DEFAULT_MAX_DEPTH)) return;

    let dir;
    try {
      dir = await opendir(absDir);
    } catch {
      return;
    }

    for await (const dirent of dir) {
      if (signal.aborted || state.truncated) return;
      const name = dirent.name;
      if (name === "." || name === "..") continue;

      const isDirectory = dirent.isDirectory();
      if (isDirectory && this.shouldSkipDirectory(name)) continue;
      if (!isDirectory && !dirent.isFile()) continue;

      const relPath = joinDisplayPath(relDir, name);
      this.addEntry(state, relPath, isDirectory);
      if (
        state.entries.length >= (this.options.maxEntries ?? DEFAULT_MAX_ENTRIES)
      ) {
        state.truncated = true;
        return;
      }

      if (isDirectory) {
        await this.walkDirectory(
          join(absDir, name),
          relPath,
          depth + 1,
          signal,
          state,
        );
      }
    }
  }

  private addEntry(
    state: FileIndexBuildState,
    path: string,
    isDirectory: boolean,
  ): void {
    const matchPath = isDirectory ? `${path}/` : path;
    const entry: IndexedPath = {
      path,
      matchPath,
      lowerMatchPath: matchPath.toLowerCase(),
      name: basenameDisplay(path),
      isDirectory,
      depth: depthOfDisplayPath(path),
    };
    state.entries.push(entry);
    state.paths.add(path);
  }

  private shouldSkipDirectory(name: string): boolean {
    const excludes = this.options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
    return excludes.has(name);
  }
}

function compareRanked(left: RankedEntry, right: RankedEntry): number {
  if (left.score !== right.score) return left.score - right.score;
  if (left.frecency !== right.frecency) return left.frecency - right.frecency;
  if (left.entry.isDirectory !== right.entry.isDirectory)
    return left.entry.isDirectory ? 1 : -1;
  if (left.entry.depth !== right.entry.depth)
    return right.entry.depth - left.entry.depth;
  if (left.entry.path.length !== right.entry.path.length)
    return right.entry.path.length - left.entry.path.length;
  return -left.entry.path.localeCompare(right.entry.path);
}
