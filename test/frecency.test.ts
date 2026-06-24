import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { FrecencyStore } from "../src/frecency.js";

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1_000;

describe("FrecencyStore", () => {
  test("scores decay over time using the supplied clock", async () => {
    await withAgentDir(async () => {
      const store = new FrecencyStore("/tmp/pi-fzf-project");
      const now = 1_700_000_000_000;

      store.record("src/app.ts", now);
      await store.flush();

      expect(store.score("src/app.ts", now)).toBeCloseTo(1, 10);
      expect(store.score("src/app.ts", now + HALF_LIFE_MS)).toBeCloseTo(0.5, 10);
    });
  });

  test("loads persisted frecency for the same cwd", async () => {
    await withAgentDir(async () => {
      const project = "/tmp/pi-fzf-project";
      const now = 1_700_000_000_000;
      const first = new FrecencyStore(project);
      first.record("src/app.ts", now);
      await first.flush();

      const second = new FrecencyStore(project);
      await second.load();

      expect(second.size).toBe(1);
      expect(second.score("src/app.ts", now)).toBeCloseTo(1, 10);
    });
  });

  test("merges frecency writes from distinct sessions for the same cwd", async () => {
    await withAgentDir(async () => {
      const project = "/tmp/pi-fzf-project";
      const now = 1_700_000_000_000;
      const first = new FrecencyStore(project);
      const second = new FrecencyStore(project);
      await first.load();
      await second.load();

      first.record("src/app.ts", now);
      await first.flush();
      second.record("src/app.ts", now + 1);
      second.record("src/other.ts", now + 2);
      await second.flush();

      const reloaded = new FrecencyStore(project);
      await reloaded.load();
      const persisted = JSON.parse(await readFile(reloaded.path, "utf8")) as {
        entries: Record<string, { count: number }>;
      };

      expect(reloaded.size).toBe(2);
      expect(persisted.entries["src/app.ts"]?.count).toBe(2);
      expect(persisted.entries["src/other.ts"]?.count).toBe(1);
    });
  });
});

async function withAgentDir(run: () => Promise<void>): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-fzf-frecency-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await run();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await rm(agentDir, { recursive: true, force: true });
  }
}
