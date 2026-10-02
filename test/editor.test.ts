import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, mock, spyOn, test } from "bun:test";
import { CombinedAutocompleteProvider, Editor, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { attachFzfEditor } from "../src/editor-adapter.js";
import { FileIndex } from "../src/file-index.js";
import { createFzfFileAutocompleteProvider } from "../src/provider.js";

const identity = (text: string) => text;
const theme: EditorTheme = {
  borderColor: identity,
  selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Editor did not reach the expected state");
    await Bun.sleep(5);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withEditor(run: (fixture: {
  root: string;
  index: FileIndex;
  editor: Editor;
  refresh: ReturnType<typeof mock<() => Promise<void>>>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-fzf-editor-"));
  const index = new FileIndex(root, { score: () => 0 } as never);
  const refresh = mock(() => index.rebuild());
  const provider = createFzfFileAutocompleteProvider(new CombinedAutocompleteProvider([], root), index, refresh);
  const editor = new Editor({ requestRender() {} } as TUI, theme);
  const detach = attachFzfEditor(editor, () => provider)!;
  editor.setAutocompleteProvider(provider);
  try {
    await writeFile(join(root, "foo-bar.ts"), "");
    await index.rebuild();
    await run({ root, index, editor, refresh });
  } finally {
    provider.dispose();
    editor.setText(""); // cancel the editor's outstanding debounce/request
    detach();
    index.abort();
    await rm(root, { recursive: true, force: true });
  }
}

function type(editor: Editor, text: string) {
  for (const char of text) editor.handleInput(char);
}

test("a multi-term query typed during refresh opens the popup without another keystroke", async () => {
  await withEditor(async ({ index, editor, refresh }) => {
    const gate = deferred();
    refresh.mockImplementation(() => gate.promise.then(() => index.rebuild()));
    const search = spyOn(index, "search");
    try {
      type(editor, "@foo");
      await eventually(() => refresh.mock.calls.length === 1);
      expect(editor.isShowingAutocomplete()).toBe(false);
      type(editor, " bar");
      // Let Pi start and serialize the replacement request before releasing I/O.
      await Bun.sleep(40);
      gate.resolve();
      await eventually(() => editor.isShowingAutocomplete());
      expect(search.mock.calls.at(-1)?.[0]).toBe("foo bar");
      expect(editor.getText()).toBe("@foo bar"); // no synthetic Tab/auto-accept
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve();
      search.mockRestore();
    }
  });
});

test("an operator typed during refresh updates the pending request", async () => {
  await withEditor(async ({ index, editor, refresh }) => {
    const gate = deferred();
    refresh.mockImplementation(() => gate.promise.then(() => index.rebuild()));
    const search = spyOn(index, "search");
    try {
      type(editor, "@foo-bar.ts");
      await eventually(() => refresh.mock.calls.length === 1);
      type(editor, "$");
      await Bun.sleep(40);
      gate.resolve();
      await eventually(() => editor.isShowingAutocomplete());
      expect(search.mock.calls.at(-1)?.[0]).toBe("foo-bar.ts$");
    } finally {
      gate.resolve();
      search.mockRestore();
    }
  });
});

for (const prefix of ["@", '@"']) {
  test(`observes clearing to ${prefix} even when the debounce skips that request`, async () => {
    await withEditor(async ({ root, index, editor, refresh }) => {
      type(editor, `${prefix}foo`);
      await eventually(() => editor.isShowingAutocomplete());
      await writeFile(join(root, "new.ts"), "");
      // Synchronous key events: no intermediate provider request can run.
      for (let i = 0; i < 3; i++) editor.handleInput("\x7f");
      type(editor, "new");
      await eventually(() => index.hasPath("new.ts") && editor.isShowingAutocomplete());
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });
}

test("clearing the prompt then pasting at the same position starts a fresh invocation", async () => {
  await withEditor(async ({ root, index, editor, refresh }) => {
    type(editor, "@foo");
    await eventually(() => editor.isShowingAutocomplete());
    await writeFile(join(root, "new.ts"), "");
    editor.setText("");
    editor.handleInput("\x1b[200~@new\x1b[201~");
    await eventually(() => index.hasPath("new.ts") && editor.isShowingAutocomplete());
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(editor.getText()).toBe("@new");
  });
});

test("submission resets the invocation and accepting a completion does not reopen the menu", async () => {
  await withEditor(async ({ root, index, editor, refresh }) => {
    type(editor, "@foo");
    await eventually(() => editor.isShowingAutocomplete());
    editor.handleInput("\x1b");
    editor.handleInput("\r");
    expect(editor.getText()).toBe("");
    await writeFile(join(root, "new.ts"), "");
    type(editor, "@new");
    await eventually(() => index.hasPath("new.ts") && editor.isShowingAutocomplete());
    editor.handleInput("\t");
    await Bun.sleep(40);
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(editor.getText()).toContain("@new.ts");
    expect(refresh).toHaveBeenCalledTimes(2);
    type(editor, "explain this");
    await Bun.sleep(40);
    expect(editor.isShowingAutocomplete()).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(2);
    type(editor, " @foo");
    await eventually(() => editor.isShowingAutocomplete());
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

test("Escape dismisses a pending request without reopening it when refresh completes", async () => {
  await withEditor(async ({ index, editor, refresh }) => {
    const gate = deferred();
    refresh.mockImplementation(() => gate.promise.then(() => index.rebuild()));
    try {
      type(editor, "@foo");
      await eventually(() => refresh.mock.calls.length === 1);
      editor.handleInput("\x1b");
      gate.resolve();
      await Bun.sleep(50);
      expect(editor.isShowingAutocomplete()).toBe(false);
    } finally {
      gate.resolve();
    }
  });
});

test("Escape also cancels a request that has not passed the debounce yet", async () => {
  await withEditor(async ({ editor, refresh }) => {
    type(editor, "@foo");
    editor.handleInput("\x1b");
    await Bun.sleep(40);
    expect(refresh).not.toHaveBeenCalled();
    expect(editor.isShowingAutocomplete()).toBe(false);
  });
});

test("typing after a forced lookup does not rebuild on every character", async () => {
  await withEditor(async ({ root, index, editor, refresh }) => {
    type(editor, "@foo");
    await eventually(() => editor.isShowingAutocomplete());
    await writeFile(join(root, "foo-other.ts"), "");
    editor.handleInput("\x1b");
    editor.handleInput("\t");
    await eventually(() => index.hasPath("foo-other.ts") && editor.isShowingAutocomplete());
    expect(refresh).toHaveBeenCalledTimes(2);
    type(editor, "-b");
    await Bun.sleep(40);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(editor.isShowingAutocomplete()).toBe(true);
  });
});

test("adapter preserves existing editor behavior, restores methods, and skips unsupported editors", () => {
  const editor = new Editor({ requestRender() {} } as TUI, theme);
  const input = editor.handleInput;
  const setText = editor.setText;
  const detach = attachFzfEditor(editor, () => undefined)!;
  type(editor, "plain text");
  expect(editor.getText()).toBe("plain text");
  detach();
  expect(editor.handleInput).toBe(input);
  expect(editor.setText).toBe(setText);

  const unsupported: EditorComponent = { getText: () => "", setText() {}, handleInput() {}, render: () => [], invalidate() {} };
  expect(attachFzfEditor(unsupported, () => undefined)).toBeUndefined();
});
