import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "bun:test";

import { FileIndex } from "../src/file-index.js";

class MemoryFrecency {
  private readonly scores = new Map<string, number>();

  set(path: string, score: number): void {
    this.scores.set(path, score);
  }

  score(path: string, _now?: number): number {
    return this.scores.get(path) ?? 0;
  }
}

describe("FileIndex", () => {
  test("deduplicates concurrent rebuild requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-fzf-files-"));
    try {
      await writeFile(join(root, "alpha.ts"), "");

      const index = new FileIndex(root, new MemoryFrecency() as never);
      const first = index.rebuild();
      const second = index.rebuild();

      expect(second).toBe(first);
      await first;
      expect(index.hasPath("alpha.ts")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the previous index visible until a rebuild is ready to swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-fzf-files-"));
    try {
      await writeFile(join(root, "old.ts"), "");

      const index = new FileIndex(root, new MemoryFrecency() as never);
      await index.rebuild();
      expect(index.hasPath("old.ts")).toBe(true);

      await unlink(join(root, "old.ts"));
      await writeFile(join(root, "new.ts"), "");

      const rebuild = index.rebuild();
      const controller = new AbortController();
      expect(index.search("old", { limit: 5, signal: controller.signal }).map((result) => result.path)).toEqual(["old.ts"]);

      await rebuild;
      expect(index.hasPath("old.ts")).toBe(false);
      expect(index.hasPath("new.ts")).toBe(true);
      expect(index.search("new", { limit: 5, signal: controller.signal }).map((result) => result.path)).toEqual(["new.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("searches with fzf syntax and uses frecency as a tie-breaker", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-fzf-files-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "alpha.ts"), "");
      await writeFile(join(root, "src", "alpine.ts"), "");
      await writeFile(join(root, "src", "beta.test.ts"), "");
      await mkdir(join(root, "node_modules"), { recursive: true });
      await writeFile(join(root, "node_modules", "alpha.ts"), "");

      const frecency = new MemoryFrecency();
      frecency.set("src/alpine.ts", 10);
      const index = new FileIndex(root, frecency as never);
      await index.rebuild();

      expect(index.hasPath("src/alpha.ts")).toBe(true);
      expect(index.hasPath("node_modules/alpha.ts")).toBe(false);

      const controller = new AbortController();
      const results = index.search("'al", { limit: 5, signal: controller.signal });
      expect(results.map((result) => result.path).slice(0, 2)).toEqual(["src/alpine.ts", "src/alpha.ts"]);

      const testResults = index.search(".test.ts$", { limit: 5, signal: controller.signal });
      expect(testResults.map((result) => result.path)).toEqual(["src/beta.test.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
