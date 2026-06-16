import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
