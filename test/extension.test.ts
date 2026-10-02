import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, mock, spyOn, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Editor, type AutocompleteProvider, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import fzfFilesExtension from "../src/extension.js";
import { FileIndex } from "../src/file-index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type Fixture = {
  ctx: ExtensionCommandContext;
  restart: () => Promise<void>;
  shutdown: () => Promise<void>;
  getProvider: () => AutocompleteProvider;
  getEditor: () => EditorComponent;
};

async function withExtension(run: (
  root: string,
  provider: AutocompleteProvider,
  reindex: () => Promise<void>,
  fixture: Fixture,
) => Promise<void>, initialFactory?: EditorFactory): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-fzf-extension-"));
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const base: AutocompleteProvider = {
    getSuggestions: async () => null,
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };
  let provider = base;
  const identity = (text: string) => text;
  const theme: EditorTheme = { borderColor: identity, selectList: {
    selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
  } };
  const tui = { requestRender() {} } as TUI;
  // No app-level shortcuts in this harness; Editor still uses real TUI bindings.
  const keybindings = { matches: () => false } as unknown as Parameters<EditorFactory>[2];
  let editorFactory = initialFactory;
  let editor: EditorComponent = initialFactory?.(tui, theme, keybindings) ?? new Editor(tui, theme);
  const ctx = {
    cwd: root,
    mode: "tui",
    ui: {
      setStatus: mock(() => {}),
      notify: mock(() => {}),
      addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
        provider = factory(provider);
        editor.setAutocompleteProvider?.(provider);
      },
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: EditorFactory | undefined) => {
        const text = editor.getText();
        editorFactory = factory;
        editor = factory?.(tui, theme, keybindings) ?? new Editor(tui, theme);
        editor.setText(text);
        editor.setAutocompleteProvider?.(provider);
      },
    },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, command: Command) => commands.set(name, command),
  } as unknown as ExtensionAPI;

  try {
    await writeFile(join(root, "old.ts"), "");
    fzfFilesExtension(pi);
    const restart = async () => {
      provider = base;
      await handlers.get("session_start")!({}, ctx);
    };
    const shutdown = async () => { await handlers.get("session_shutdown")?.({}, ctx); };
    await restart();
    await run(root, provider, () => commands.get("fzf-files")!.handler("reindex", ctx), {
      ctx, restart, shutdown, getProvider: () => provider, getEditor: () => editor,
    });
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await rm(root, { recursive: true, force: true });
  }
}

function suggest(provider: AutocompleteProvider, text: string) {
  return provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });
}

describe("fzf-files extension indexing lifecycle", () => {
  test("@ waits for an already-running startup rebuild instead of returning an empty snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalRebuild = FileIndex.prototype.rebuild;
    let pendingBuild: Promise<void> | undefined;
    const rebuild = spyOn(FileIndex.prototype, "rebuild").mockImplementation(function (this: FileIndex) {
      pendingBuild = Promise.all([originalRebuild.call(this), gate]).then(() => {});
      return pendingBuild;
    });

    try {
      await withExtension(async (_root, provider) => {
        try {
          let settled = false;
          const suggestions = suggest(provider, "@old").then((result) => {
            settled = true;
            return result;
          });
          await Promise.resolve();
          await Promise.resolve();
          expect(settled).toBe(false);
          expect(rebuild).toHaveBeenCalledTimes(1);

          release();
          expect((await suggestions)?.items.map((item) => item.value)).toEqual(["@old.ts"]);
        } finally {
          release();
          await pendingBuild;
        }
      });
    } finally {
      release();
      rebuild.mockRestore();
    }
  });

  test("failed refreshes report once, retain cached results, and retry", async () => {
    await withExtension(async (root, provider, reindex, { ctx }) => {
      await reindex();
      const rebuild = spyOn(FileIndex.prototype, "rebuild").mockRejectedValueOnce(new Error("walk failed"));
      try {
        expect((await suggest(provider, "@old"))?.items[0]?.value).toBe("@old.ts");
        expect(ctx.ui.notify).toHaveBeenCalledWith("fzf-files: failed to index files: walk failed", "error");
        await writeFile(join(root, "new.ts"), "");
        expect((await suggest(provider, "@new"))?.items[0]?.value).toBe("@new.ts");
        expect(rebuild).toHaveBeenCalledTimes(2);
      } finally {
        rebuild.mockRestore();
      }
    });
  });

  test("a failed startup build releases joined requests and permits retry", async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, fail) => { reject = fail; });
    const rebuild = spyOn(FileIndex.prototype, "rebuild").mockImplementationOnce(() => gate);
    try {
      await withExtension(async (_root, provider, _reindex, { ctx }) => {
        const pending = suggest(provider, "@old");
        await Promise.resolve();
        expect(rebuild).toHaveBeenCalledTimes(1);
        reject(new Error("startup failed"));
        expect(await pending).toBeNull();
        expect((await suggest(provider, "@old"))?.items[0]?.value).toBe("@old.ts");
        expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
      });
    } finally {
      reject(new Error("cleanup"));
      rebuild.mockRestore();
    }
  });

  test("session replacement releases old requests and ignores old completion status", async () => {
    await withExtension(async (_root, provider, reindex, { ctx, restart, getProvider }) => {
      await reindex();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const original = FileIndex.prototype.rebuild;
      let pendingBuild: Promise<void> | undefined;
      const rebuild = spyOn(FileIndex.prototype, "rebuild").mockImplementationOnce(function (this: FileIndex) {
        pendingBuild = Promise.all([original.call(this), gate]).then(() => {});
        return pendingBuild;
      });
      try {
        const oldRequest = suggest(provider, "@old");
        await Promise.resolve();
        await restart();
        expect(await oldRequest).toBeNull();
        expect((await suggest(getProvider(), "@old"))?.items[0]?.value).toBe("@old.ts");
        const statuses = (ctx.ui.setStatus as ReturnType<typeof mock>).mock.calls.length;
        release();
        await pendingBuild;
        await Promise.resolve();
        expect(ctx.ui.setStatus).toHaveBeenCalledTimes(statuses);
        expect(await suggest(provider, "@old")).toBeNull();
      } finally {
        release();
        await pendingBuild;
        rebuild.mockRestore();
      }
    });
  });

  test("the editor factory is composed with and restored to an existing custom editor", async () => {
    const previous: EditorFactory = (tui, theme) => new Editor(tui, theme);
    await withExtension(async (_root, _provider, _reindex, { ctx, getEditor, shutdown }) => {
      expect(ctx.ui.getEditorComponent()).not.toBe(previous);
      getEditor().handleInput("x");
      expect(getEditor().getText()).toBe("x");
      await shutdown();
      expect(ctx.ui.getEditorComponent()).toBe(previous);
      expect(getEditor().getText()).toBe("x");
    }, previous);
  });

  test("unsupported editors are preserved and warn about explicit Tab fallback", async () => {
    const custom: EditorComponent = {
      getText: () => "", setText() {}, handleInput() {}, render: () => [], invalidate() {},
    };
    await withExtension(async (_root, _provider, _reindex, { ctx, getEditor }) => {
      expect(getEditor()).toBe(custom);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "fzf-files: this editor does not support automatic refresh; use Tab to refresh file suggestions", "warning",
      );
    }, () => custom);
  });

  test("the installed editor adapter retriggers multi-term queries during a shared rebuild", async () => {
    await withExtension(async (root, _provider, reindex, { getEditor }) => {
      await reindex();
      await writeFile(join(root, "old-new.ts"), "");
      let release!: () => void;
      let started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const start = new Promise<void>((resolve) => { started = resolve; });
      const original = FileIndex.prototype.rebuild;
      const rebuild = spyOn(FileIndex.prototype, "rebuild").mockImplementationOnce(function (this: FileIndex) {
        started();
        return Promise.all([original.call(this), gate]).then(() => {});
      });
      try {
        const editor = getEditor() as Editor;
        for (const char of "@old") editor.handleInput(char);
        await start;
        for (const char of " new") editor.handleInput(char);
        release();
        for (let i = 0; i < 200 && !editor.isShowingAutocomplete(); i++) await Bun.sleep(5);
        expect(editor.isShowingAutocomplete()).toBe(true);
        expect(editor.getText()).toBe("@old new");
        expect(rebuild).toHaveBeenCalledTimes(1);
      } finally {
        release();
        rebuild.mockRestore();
      }
    });
  });

  test("cleanup does not replace a newer editor factory installed by another extension", async () => {
    await withExtension(async (_root, _provider, _reindex, { ctx, shutdown }) => {
      const ours = ctx.ui.getEditorComponent()!;
      const newer: EditorFactory = (...args) => ours(...args);
      ctx.ui.setEditorComponent(newer);
      await shutdown();
      expect(ctx.ui.getEditorComponent()).toBe(newer);
    });
  });

  test("@ awaits the background rebuild started by the extension", async () => {
    await withExtension(async (root, provider, reindex) => {
      await reindex();
      await writeFile(join(root, "new.ts"), "");

      expect((await suggest(provider, "@new"))?.items.map((item) => item.value)).toEqual(["@new.ts"]);
    });
  });
});
