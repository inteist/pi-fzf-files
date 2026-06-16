import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { FrecencyStore } from "../src/frecency.js";

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1_000;

describe("FrecencyStore", () => {
  test("scores decay over time using the supplied clock", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-fzf-frecency-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      const store = new FrecencyStore("/tmp/pi-fzf-project");
      const now = 1_700_000_000_000;

      store.record("src/app.ts", now);
      await store.flush();

      expect(store.score("src/app.ts", now)).toBeCloseTo(1, 10);
      expect(store.score("src/app.ts", now + HALF_LIFE_MS)).toBeCloseTo(0.5, 10);
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
