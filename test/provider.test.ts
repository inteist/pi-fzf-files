import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, mock, test } from "bun:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

import { FileIndex } from "../src/file-index.js";
import { createFzfFileAutocompleteProvider } from "../src/provider.js";

function createBaseProvider(): AutocompleteProvider {
  return {
    getSuggestions: mock(async () => null),
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  };
}

function suggest(provider: AutocompleteProvider, text: string, signal = new AbortController().signal) {
  return provider.getSuggestions([text], 0, text.length, { signal });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withIndex(run: (root: string, index: FileIndex) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-fzf-provider-"));
  const index = new FileIndex(root, { score: () => 0 } as never);
  try {
    await writeFile(join(root, "old.ts"), "");
    await index.rebuild();
    await run(root, index);
  } finally {
    index.abort();
    await rm(root, { recursive: true, force: true });
  }
}

describe("fzf file autocomplete provider", () => {
  test("returns newly indexed files without needing another keystroke", async () => {
    await withIndex(async (root, index) => {
      await writeFile(join(root, "new.ts"), "");
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);

      const suggestions = await suggest(provider, "@new");

      expect(suggestions?.items.map((item) => item.value)).toEqual(["@new.ts"]);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  test("shares an in-flight refresh across keystrokes and cancels obsolete requests promptly", async () => {
    await withIndex(async (root, index) => {
      await writeFile(join(root, "new.ts"), "");
      const gate = deferred();
      const refresh = mock(() => gate.promise.then(() => index.rebuild()));
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      const controller = new AbortController();

      try {
        const first = suggest(provider, "@n", controller.signal);
        controller.abort();
        // Cancellation must not wait for the shared filesystem walk to finish.
        expect(await first).toBeNull();

        let settled = false;
        const latest = suggest(provider, "@new").then((suggestions) => {
          settled = true;
          return suggestions;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(index.hasPath("old.ts")).toBe(true);
        expect(index.hasPath("new.ts")).toBe(false);

        gate.resolve();
        expect((await latest)?.items.map((item) => item.value)).toEqual(["@new.ts"]);
      } finally {
        gate.resolve();
        await gate.promise;
        await index.rebuild();
      }
    });
  });

  test("refreshes when the query is cleared back to @ without deleting it", async () => {
    await withIndex(async (root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      await suggest(provider, "@old");
      await writeFile(join(root, "new.ts"), "");

      const suggestions = await suggest(provider, "@");
      expect(suggestions?.items.map((item) => item.value)).toContain("@new.ts");
      expect(refresh).toHaveBeenCalledTimes(2);
      expect((await suggest(provider, "@new"))?.items.map((item) => item.value)).toEqual(["@new.ts"]);
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  test("refreshes when a quoted query is cleared back to its opening quote", async () => {
    await withIndex(async (root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      await suggest(provider, '@"old');
      await writeFile(join(root, "new.ts"), "");

      expect((await suggest(provider, '@"'))?.items.map((item) => item.value)).toContain("@new.ts");
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  test("does not rebuild for every character or repeated empty query", async () => {
    await withIndex(async (_root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      for (const text of ["@", "@", "@o", "@ol", "@old"]) {
        await suggest(provider, text);
      }
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  test("recognizes a new @ token even without an intervening non-file query", async () => {
    await withIndex(async (root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      await suggest(provider, "@old");
      await writeFile(join(root, "new.ts"), "");

      expect((await suggest(provider, "@old @new"))?.items.map((item) => item.value)).toEqual(["@new.ts"]);
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  test("resets the invocation after applying a completion", async () => {
    await withIndex(async (root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      const suggestions = (await suggest(provider, "@old"))!;
      provider.applyCompletion(["@old"], 0, 4, suggestions.items[0]!, suggestions.prefix);
      await writeFile(join(root, "new.ts"), "");

      expect((await suggest(provider, "@new"))?.items.map((item) => item.value)).toEqual(["@new.ts"]);
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  test("does not start or consume an invocation for an already cancelled request", async () => {
    await withIndex(async (_root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      const controller = new AbortController();
      controller.abort();

      expect(await suggest(provider, "@old", controller.signal)).toBeNull();
      expect(refresh).not.toHaveBeenCalled();
      await suggest(provider, "@old");
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  for (const failure of ["throw", "reject"] as const) {
    test(`uses the cached index after a refresh ${failure} and retries on the next request`, async () => {
      await withIndex(async (root, index) => {
        let attempts = 0;
        const refresh = mock(() => {
          if (++attempts > 1) return index.rebuild();
          const error = new Error("refresh failed");
          if (failure === "throw") throw error;
          return Promise.reject(error);
        });
        const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
        expect((await suggest(provider, "@old"))?.items[0]?.value).toBe("@old.ts");
        await writeFile(join(root, "new.ts"), "");
        expect((await suggest(provider, "@new"))?.items[0]?.value).toBe("@new.ts");
        expect(refresh).toHaveBeenCalledTimes(2);
      });
    });
  }

  test("a refresh rejected after cancellation is handled and can be retried", async () => {
    await withIndex(async (_root, index) => {
      let reject!: (error: Error) => void;
      const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
      const refresh = mock(() => pending);
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      const controller = new AbortController();
      const request = suggest(provider, "@old", controller.signal);
      await Promise.resolve();
      controller.abort();
      expect(await request).toBeNull();
      reject(new Error("late refresh failure"));
      await pending.catch(() => {});
      await Promise.resolve();
      refresh.mockImplementation(() => index.rebuild());
      expect((await suggest(provider, "@old"))?.items[0]?.value).toBe("@old.ts");
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  test("forced completion refreshes a stale invocation without delegating fzf queries", async () => {
    await withIndex(async (root, index) => {
      const base = createBaseProvider();
      base.shouldTriggerFileCompletion = () => false;
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(base, index, refresh);
      await suggest(provider, "@old");
      await writeFile(join(root, "new.ts"), "");
      expect(provider.shouldTriggerFileCompletion?.(["@new | old"], 0, 10)).toBe(true);
      const result = await provider.getSuggestions(["@new"], 0, 4, { signal: new AbortController().signal, force: true });
      expect(result?.items[0]?.value).toBe("@new.ts");
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(base.getSuggestions).not.toHaveBeenCalled();
    });
  });

  test("disposal releases pending requests without waiting for the shared rebuild", async () => {
    await withIndex(async (_root, index) => {
      const gate = deferred();
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, () => gate.promise);
      try {
        const pending = suggest(provider, "@old");
        provider.dispose();
        expect(await pending).toBeNull();
        expect(await suggest(provider, "@old")).toBeNull();
      } finally {
        gate.resolve();
      }
    });
  });

  test("delegating a non-file query resets the refresh cycle", async () => {
    await withIndex(async (_root, index) => {
      const refresh = mock(() => index.rebuild());
      const provider = createFzfFileAutocompleteProvider(createBaseProvider(), index, refresh);
      await suggest(provider, "@old");
      await suggest(provider, "/help");
      await suggest(provider, "@old");
      expect(refresh).toHaveBeenCalledTimes(2);
    });
  });

  test("delegates non-file queries but never delegates @ misses", async () => {
    await withIndex(async (_root, index) => {
      const base = createBaseProvider();
      const provider = createFzfFileAutocompleteProvider(base, index);

      expect(await suggest(provider, "@missing")).toBeNull();
      expect(base.getSuggestions).not.toHaveBeenCalled();
      await suggest(provider, "/help");
      expect(base.getSuggestions).toHaveBeenCalledTimes(1);
    });
  });
});
