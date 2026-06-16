import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getMarkdownTheme
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@earendil-works/pi-tui";

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

  const rebuild = async (
    ctx: ExtensionContext,
    reason: "startup" | "at" | "manual"
  ): Promise<void> => {
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
          ctx.ui.notify(
            formatStats(stats),
            stats.truncated ? "warning" : "info"
          );
        }
      }
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, "fzf: indexing…");
    const promise = active.index.rebuild();
    active.rebuildPromise = promise;

    const isCurrentRebuild = () =>
      runtime === active && active.rebuildPromise === promise;

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
      ctx.ui.notify(
        `fzf-files: failed to index files: ${formatError(error)}`,
        "error"
      );
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

    ctx.ui.addAutocompleteProvider((current) =>
      createFzfFileAutocompleteProvider(current, index, () => {
        const active = runtime;
        if (!active || active.index !== index || active.cwd !== ctx.cwd) return;
        if (active.index.getStats().indexing) return;

        void rebuild(ctx, "at");
      })
    );
    void rebuild(ctx, "startup");
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };

    const active = runtime;
    if (!active || active.cwd !== ctx.cwd)
      return { action: "continue" as const };

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

  const handleCommand = async (
    args: string,
    ctx: ExtensionCommandContext
  ): Promise<void> => {
    const command = args.trim().toLowerCase() || "stats";
    if (isHelpCommand(command)) {
      await showHelp(ctx);
      return;
    }

    if (command === "syntax") {
      await showSyntax(ctx);
      return;
    }

    const active = runtime;
    if (!active) {
      ctx.ui.notify("fzf-files: not initialized", "warning");
      return;
    }

    if (command === "stats") {
      ctx.ui.notify(
        `${formatStats(active.index.getStats())}\nFrecency entries: ${active.frecency.size}\nStore: ${active.frecency.path}`,
        "info"
      );
      return;
    }

    if (command === "reindex") {
      await rebuild(ctx, "manual");
      return;
    }

    if (command === "clear-frecency" || command === "reset-frecency") {
      const ok = await ctx.ui.confirm(
        "Clear fzf file frecency?",
        `This removes ranking history for ${active.cwd}. The file index is kept.`
      );
      if (!ok) return;
      active.frecency.clear();
      await active.frecency.flush();
      ctx.ui.notify("fzf-files: frecency cleared", "info");
      return;
    }

    ctx.ui.notify(formatHelp(), "warning");
  };

  pi.registerCommand("fzf-files", {
    description:
      "Manage fzf-style @ file autocomplete. Usage: /fzf-files [help|syntax|stats|reindex|clear-frecency]",
    handler: handleCommand
  });
}

function formatStatusLine(stats: ReturnType<FileIndex["getStats"]>): string {
  if (stats.entries === 0 && stats.indexedAt === null) {
    return stats.indexing ? "fzf: indexing…" : "fzf: not indexed";
  }

  const truncated = stats.truncated ? ", truncated" : "";
  const indexing = stats.indexing ? " (indexing…)" : "";
  return `fzf: ${stats.entries} entries${truncated}${indexing}`;
}

function isHelpCommand(command: string): boolean {
  return (
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    command === "?"
  );
}

async function showSyntax(ctx: ExtensionContext): Promise<void> {
  await showMarkdown(ctx, "fzf-files syntax", formatSyntaxExamples());
}

async function showHelp(ctx: ExtensionContext): Promise<void> {
  await showMarkdown(ctx, "fzf-files help", formatHelp());
}

async function showMarkdown(
  ctx: ExtensionContext,
  title: string,
  markdown: string
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(markdown, "info");
    return;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    const container = new Container();
    const border = new DynamicBorder((s: string) => theme.fg("accent", s));
    const mdTheme = getMarkdownTheme();

    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    container.addChild(new Markdown(markdown, 1, 1, mdTheme));
    container.addChild(
      new Text(theme.fg("dim", "Press Enter, Esc, or q to close"), 1, 0)
    );
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (
          matchesKey(data, "enter") ||
          matchesKey(data, "escape") ||
          data === "q"
        ) {
          done(undefined);
        }
      }
    };
  });
}

function formatHelp(): string {
  return [
    "# fzf-files help",
    "",
    "## Commands",
    "",
    "| Command | Description |",
    "| --- | --- |",
    "| `/fzf-files help` | Show this help. |",
    "| `/fzf-files syntax` | Print only syntax examples. |",
    "| `/fzf-files stats` | Show index state, duration, entry counts, frecency count, and store path. |",
    "| `/fzf-files reindex` | Rebuild the file index without clearing current autocomplete results. |",
    "| `/fzf-files clear-frecency` | Clear ranking history while keeping the file index. |",
    "",
    "## Syntax examples",
    "",
    formatSyntaxExamples()
  ].join("\n");
}

function formatSyntaxExamples(): string {
  return [
    "| Token | Match type | Description |",
    "| --- | --- | --- |",
    "| `cmp` | fuzzy-match | Items that match `cmp`, such as `ComponentMap` or `createMessageParser`. |",
    "| `'useState` | exact-match (quoted) | Items that include `useState`, such as `useStateReducer`. |",
    "| `'auth'` | exact-boundary-match (quoted both ends) | Items that include `auth` at word boundaries, such as `auth-token` or `auth.service`. |",
    "| `^use` | prefix-exact-match | Items that start with `use`, such as `useUserSession`. |",
    "| `Controller$` | suffix-exact-match | Items that end with `Controller`, such as `UserController`. |",
    "| `!deprecated` | inverse-exact-match | Items that do not include `deprecated`. |",
    "| `!^legacy` | inverse-prefix-exact-match | Items that do not start with `legacy`. |",
    "| `!Spec$` | inverse-suffix-exact-match | Items that do not end with `Spec`. |",
    "| `sb controller` | multiple-terms (AND) | Items that match both `sb` AND `controller`, such as `SidebarController`. |",
    "| `sb \\| controller` | OR-match | Items that match either `sb` OR `controller`, such as `Sidebar` or `UserController`. |",
    "| `'controller auth \\| session` | exact AND OR-match | Items containing `controller` exactly, and matching either `auth` or `session` fuzzy, such as `AuthController.ts` or `session_controller.rb`. |",
    "| `'auth \\| 'session` | multiple exact (OR) | Items containing either `auth` exactly or `session` exactly, such as `auth.ts` or `session.py` (excluding `author.ts`). |",
    "| `'src 'test` | multiple exact (AND) | Items containing both `src` exactly and `test` exactly, such as `src/app.test.ts`. |"
  ].join("\n");
}

function formatStats(stats: ReturnType<FileIndex["getStats"]>): string {
  const indexed = stats.indexedAt
    ? new Date(stats.indexedAt).toLocaleString()
    : "not complete";
  const duration =
    stats.lastDurationMs === null ? "n/a" : `${stats.lastDurationMs}ms`;
  const truncated = stats.truncated ? " (truncated at limit)" : "";
  const state = stats.indexing ? "indexing" : "ready";
  return `fzf-files: ${state}\nRoot: ${stats.root}\nEntries: ${stats.entries} (${stats.files} files, ${stats.directories} dirs)${truncated}\nIndexed: ${indexed}\nDuration: ${duration}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
