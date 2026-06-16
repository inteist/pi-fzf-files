# pi-fzf-files

Pure TypeScript replacement for Pi's default `@` file-reference autocomplete. It lazily builds an in-memory file index the first time you use `@` and searches it with fzf-style extended query syntax—no `fzf`, `fd`, sqlite package, or other runtime dependency required.

## Features

- Replaces `@...` file suggestions through `ctx.ui.addAutocompleteProvider()`.
- Does **not** delegate on `@` misses, so Pi's default `fd`-backed finder does not appear for file references.
- Lazily starts indexing on first `@` use instead of blocking session startup.
- Searches a cached in-memory index instead of walking the filesystem per keystroke.
- Rebuilds into a temporary index and atomically swaps it in, so background reindexing does not clear existing suggestions.
- Skips heavy directories such as `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `target`, and virtualenv/cache folders.
- Supports fzf extended syntax:

| Token | Match type |
| --- | --- |
| `sbtrkt` | fuzzy subsequence |
| `'wild` | exact substring |
| `'wild'` | exact substring at word boundaries |
| `^music` | prefix exact |
| `.mp3$` | suffix exact |
| `^music$` | exact whole path |
| `!fire` | inverse exact substring |
| `!^music` | inverse prefix exact |
| `!.mp3$` | inverse suffix exact |
| `foo bar` | AND |
| `'match1 'match2` | AND of multiple exact substrings |
| <code>foo &#124; bar</code> | OR between adjacent terms |
| <code>^core go$ &#124; rb$ &#124; py$</code> | `^core` AND (`go$` OR `rb$` OR `py$`) |
| <code>foo&#124;bar</code> | literal pipe inside a token |
| `Foo` | smart-case match (uppercase makes that term case-sensitive) |

Spaces can be escaped inside a token with `\`.

## Frecency

Submitted prompts are scanned for `@path` and `@"path with spaces"` references. Referenced files are recorded in a project-scoped JSON hashmap under:

```text
~/.pi/agent/fzf-files/frecency-v1/<cwd-hash>.json
```

Ranking uses match quality first. Frecency is a tie-breaker, so frequently/recently referenced files move up when the textual match is otherwise equal.

SQLite would only help once the index itself lives on disk or queries need cross-project aggregation. For this extension the hot path is an in-memory top-K scan over cached paths, while frecency lookups are O(1) map reads. The JSON store keeps runtime installs dependency-free and portable across Pi's supported Node runtimes.

## Install / try

From this repository:

```bash
pi -e ./pi-fzf-files
# or
pi install ./pi-fzf-files
```

If you also want Pi startup to avoid provisioning the built-in `fd` helper entirely, run Pi with `PI_OFFLINE=1` or add a Pi core setting when available. This extension itself never invokes `fd`.

## Commands

```text
/fzf-files help
/fzf-files stats
/fzf-files reindex
/fzf-files clear-frecency
```

`/fzf-files help` prints a Markdown table with the main `@` usage patterns and maintenance commands.

## Development

```bash
bun test
npm run typecheck
```
