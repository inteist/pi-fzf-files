import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { FileIndex } from "./file-index.js";
import { FrecencyStore } from "./frecency.js";
import { candidateReferencePaths } from "./path-utils.js";
import { extractAtReferences } from "./prefix.js";
import { createFzfFileAutocompleteProvider } from "./provider.js";

const STATUS_KEY = "fzf-files";

type Runtime = {
  cwd: string;
  frecency: FrecencyStore;
  index: FileIndex;
  rebuildPromise: Promise<void> | undefined;
};

export default function fzfFilesExtension(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;

  const rebuild = async (ctx: ExtensionContext, reason: "lazy" | "manual"): Promise<void> => {
    const active = runtime;
    if (!active) return;

    const existing = active.rebuildPromise;
    if (existing) {
      if (reason === "manual") {
        ctx.ui.notify("fzf-files: reindex already running", "info");
        try {
          await existing;
        } catch {
          return;
        }
        if (runtime === active) {
          const stats = active.index.getStats();
          ctx.ui.notify(formatStats(stats), stats.truncated ? "warning" : "info");
        }
      }
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, "fzf: indexing…");
    const promise = active.index.rebuild();
    active.rebuildPromise = promise;

    const isCurrentRebuild = () => runtime === active && active.rebuildPromise === promise;

    try {
      await promise;
      if (!isCurrentRebuild()) return;

      const stats = active.index.getStats();
      ctx.ui.setStatus(STATUS_KEY, formatStatusLine(stats));
      if (reason === "manual") {
        ctx.ui.notify(formatStats(stats), stats.truncated ? "warning" : "info");
      }
    } catch (error) {
      if (!isCurrentRebuild()) return;

      ctx.ui.setStatus(STATUS_KEY, "fzf: index failed");
      ctx.ui.notify(`fzf-files: failed to index files: ${formatError(error)}`, "error");
    } finally {
      if (active.rebuildPromise === promise) {
        active.rebuildPromise = undefined;
      }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const previous = runtime;
    runtime = undefined;
    previous?.index.abort();
    await previous?.frecency.flush();

    const frecency = new FrecencyStore(ctx.cwd);
    await frecency.load();
    const index = new FileIndex(ctx.cwd, frecency);
    runtime = { cwd: ctx.cwd, frecency, index, rebuildPromise: undefined };

    ctx.ui.setStatus(STATUS_KEY, "fzf: lazy (type @)");
    ctx.ui.addAutocompleteProvider((current) =>
      createFzfFileAutocompleteProvider(current, index, () => {
        const active = runtime;
        if (!active || active.index !== index || active.cwd !== ctx.cwd) return;

        const stats = active.index.getStats();
        if (stats.indexedAt !== null || stats.indexing) return;

        void rebuild(ctx, "lazy");
      }),
    );
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    const active = runtime;
    if (!active || active.cwd !== ctx.cwd) return { action: "continue" as const };

    let recorded = 0;
    for (const rawReference of extractAtReferences(event.text)) {
      for (const candidate of candidateReferencePaths(ctx.cwd, rawReference)) {
        if (!active.index.hasPath(candidate)) continue;
        active.frecency.record(candidate);
        recorded += 1;
        break;
      }
    }

    if (recorded > 0) {
      ctx.ui.setStatus(STATUS_KEY, formatStatusLine(active.index.getStats()));
    }

    return { action: "continue" as const };
  });

  pi.on("session_shutdown", async () => {
    const active = runtime;
    runtime = undefined;
    active?.index.abort();
    await active?.frecency.flush();
  });

  pi.registerCommand("fzf-files", {
    description: "Manage fzf-style @ file autocomplete. Usage: /fzf-files [help|stats|reindex|clear-frecency]",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "stats";
      if (isHelpCommand(command)) {
        ctx.ui.notify(formatHelp(), "info");
        return;
      }

      const active = runtime;
      if (!active) {
        ctx.ui.notify("fzf-files: not initialized", "warning");
        return;
      }

      if (command === "stats") {
        ctx.ui.notify(`${formatStats(active.index.getStats())}\nFrecency entries: ${active.frecency.size}\nStore: ${active.frecency.path}`, "info");
        return;
      }

      if (command === "reindex") {
        await rebuild(ctx, "manual");
        return;
      }

      if (command === "clear-frecency" || command === "reset-frecency") {
        const ok = await ctx.ui.confirm(
          "Clear fzf file frecency?",
          `This removes ranking history for ${active.cwd}. The file index is kept.`,
        );
        if (!ok) return;
        active.frecency.clear();
        await active.frecency.flush();
        ctx.ui.notify("fzf-files: frecency cleared", "info");
        return;
      }

      ctx.ui.notify(formatHelp(), "warning");
    },
  });
}

function formatStatusLine(stats: ReturnType<FileIndex["getStats"]>): string {
  if (stats.entries === 0 && stats.indexedAt === null) {
    return stats.indexing ? "fzf: indexing…" : "fzf: lazy (type @)";
  }

  const truncated = stats.truncated ? ", truncated" : "";
  const indexing = stats.indexing ? " (indexing…)" : "";
  return `fzf: ${stats.entries} entries${truncated}${indexing}`;
}

function isHelpCommand(command: string): boolean {
  return command === "help" || command === "--help" || command === "-h" || command === "?";
}

function formatHelp(): string {
  return [
    "# fzf-files help",
    "",
    "| Usage | Example | Notes |",
    "| --- | --- | --- |",
    "| Start lazy indexing | `@` | First use builds the in-memory index in the background. |",
    "| Fuzzy file search | `@cmp ts` | Space-separated fzf terms are ANDed. |",
    "| Exact substring | `@'README` | Leading `'` switches a term to exact substring matching. |",
    "| Prefix/suffix anchors | `@^src .test.ts$` | Use `^` and `$` to anchor individual terms. |",
    "| Alternatives | <code>@readme &#124; package</code> | Standalone <code>&#124;</code> creates OR alternatives. |",
    "| Paths with spaces | `@\"docs/my file.md\"` | Completed paths are quoted automatically when needed. |",
    "| Show index stats | `/fzf-files stats` | Includes index state, duration, and frecency store path. |",
    "| Manual reindex | `/fzf-files reindex` | Rebuilds without clearing current autocomplete results. |",
    "| Clear ranking history | `/fzf-files clear-frecency` | Removes frecency data but keeps the file index. |",
  ].join("\n");
}

function formatStats(stats: ReturnType<FileIndex["getStats"]>): string {
  const indexed = stats.indexedAt ? new Date(stats.indexedAt).toLocaleString() : "not complete";
  const duration = stats.lastDurationMs === null ? "n/a" : `${stats.lastDurationMs}ms`;
  const truncated = stats.truncated ? " (truncated at limit)" : "";
  const state = stats.indexing ? "indexing" : "ready";
  return `fzf-files: ${state}\nRoot: ${stats.root}\nEntries: ${stats.entries} (${stats.files} files, ${stats.directories} dirs)${truncated}\nIndexed: ${indexed}\nDuration: ${duration}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
