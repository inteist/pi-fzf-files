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

  const rebuild = async (ctx: ExtensionContext, reason: "startup" | "manual"): Promise<void> => {
    const active = runtime;
    if (!active) return;

    ctx.ui.setStatus(STATUS_KEY, "fzf: indexing…");
    const promise = active.index.rebuild();
    active.rebuildPromise = promise;

    const isCurrentRebuild = () => runtime === active && active.rebuildPromise === promise;

    try {
      await promise;
      if (!isCurrentRebuild()) return;

      const stats = active.index.getStats();
      const truncated = stats.truncated ? ", truncated" : "";
      ctx.ui.setStatus(STATUS_KEY, `fzf: ${stats.entries} files${truncated}`);
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

    ctx.ui.addAutocompleteProvider((current) => createFzfFileAutocompleteProvider(current, index));
    void rebuild(ctx, "startup");
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
      const stats = active.index.getStats();
      ctx.ui.setStatus(STATUS_KEY, `fzf: ${stats.entries} files`);
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
    description: "Manage fzf-style @ file autocomplete. Usage: /fzf-files [stats|reindex|clear-frecency]",
    handler: async (args, ctx) => {
      const active = runtime;
      if (!active) {
        ctx.ui.notify("fzf-files: not initialized", "warning");
        return;
      }

      const command = args.trim().toLowerCase() || "stats";
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

      ctx.ui.notify("Usage: /fzf-files [stats|reindex|clear-frecency]", "warning");
    },
  });
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
