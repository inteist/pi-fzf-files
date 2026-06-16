import { describe, expect, test } from "bun:test";

import { fuzzyMatchScore, matchFzfQuery, parseFzfQuery } from "../src/fzf.js";
import { extractAtFzfPrefix, extractAtReferences } from "../src/prefix.js";

function matches(query: string, target: string): boolean {
  return matchFzfQuery(parseFzfQuery(query), target).matched;
}

describe("fzf extended syntax", () => {
  test("fuzzy subsequence", () => {
    expect(matches("sbtrkt", "src/sound/sbtrkt-remix.ts")).toBe(true);
    expect(matches("sbtrkt", "src/sound/subject.ts")).toBe(false);
  });

  test("exact substring with leading quote", () => {
    expect(matches("'wild", "src/the-wild-file.ts")).toBe(true);
    expect(matches("'wild", "src/the-wlid-file.ts")).toBe(false);
  });

  test("exact boundary with quotes at both ends", () => {
    expect(matches("'wild'", "src/the-wild-file.ts")).toBe(true);
    expect(matches("'wild'", "src/wildfire.ts")).toBe(false);
  });

  test("boundary matching respects camelCase transitions", () => {
    expect(matches("'bar'", "src/fooBar.ts")).toBe(true);
    expect(matches("'foo'", "src/fooBar.ts")).toBe(true);
    expect(matches("'bar'", "src/foobar.ts")).toBe(false);
  });

  test("prefix, suffix, and exact whole path", () => {
    expect(matches("^music", "music/track.mp3")).toBe(true);
    expect(matches("^music", "src/music/track.mp3")).toBe(false);
    expect(matches(".mp3$", "music/track.mp3")).toBe(true);
    expect(matches("^music/track.mp3$", "music/track.mp3")).toBe(true);
  });

  test("inverse exact, prefix, and suffix", () => {
    expect(matches("!fire", "src/water.ts")).toBe(true);
    expect(matches("!fire", "src/fire.ts")).toBe(false);
    expect(matches("!^music", "src/music.ts")).toBe(true);
    expect(matches("!^music", "music/track.mp3")).toBe(false);
    expect(matches("!.mp3$", "music/track.wav")).toBe(true);
    expect(matches("!.mp3$", "music/track.mp3")).toBe(false);
  });

  test("AND and OR", () => {
    expect(matches("src test", "src/app.test.ts")).toBe(true);
    expect(matches("src test", "src/app.ts")).toBe(false);
    expect(matches("readme | package", "package.json")).toBe(true);
    expect(matches("readme | package", "src/index.ts")).toBe(false);
  });

  test("escaped spaces and pipes stay inside a token", () => {
    expect(matches("'my\\ file", "docs/my file.md")).toBe(true);
    expect(matches("'foo\\|bar", "docs/foo|bar.md")).toBe(true);
  });

  test("fuzzy scoring rewards path separator boundaries beyond the basename", () => {
    const afterSlash = fuzzyMatchScore("src/foo/bar.ts", "sf");
    const afterDash = fuzzyMatchScore("src-foo/bar.ts", "sf");

    expect(afterSlash.matched).toBe(true);
    expect(afterDash.matched).toBe(true);
    expect(afterSlash.score).toBeGreaterThan(afterDash.score);
  });
});

describe("@ prefix parsing", () => {
  test("captures fzf query with spaces and OR", () => {
    expect(extractAtFzfPrefix("open @^src test$ | 'README")).toBe("@^src test$ | 'README");
  });

  test("ignores email-like at signs", () => {
    expect(extractAtFzfPrefix("email a@b.com")).toBe(null);
  });

  test("extracts submitted references", () => {
    expect(extractAtReferences('read @src/index.ts and @"docs/my file.md"')).toEqual([
      "src/index.ts",
      "docs/my file.md",
    ]);
  });
});
