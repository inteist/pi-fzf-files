![pi-fzf-files banner](./pi-fzf-files.png)

# pi-fzf-files - Pi extension

Pure TypeScript replacement for Pi's default `@` file-reference autocomplete. It builds an in-memory file index on session start/restart, refreshes it asynchronously when you use `@`, and searches it with fzf-style extended query syntax—no `fzf`, `fd`, sqlite package, or other runtime dependency required.

## Features

- Replaces `@...` file suggestions through `ctx.ui.addAutocompleteProvider()`.
- Does **not** delegate on `@` misses, so Pi's default `fd`-backed finder does not appear for file references.
- Starts indexing asynchronously on every session start/restart.
- Starts a background reindex when you enter an `@` file query, unless one is already running.
- Searches a cached in-memory index instead of walking the filesystem per keystroke.
- Rebuilds into a temporary index and atomically swaps it in, so background reindexing does not clear existing suggestions.
- Follows symlinked files and directories while avoiding recursive symlink cycles.
- Skips heavy directories such as `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `target`, and virtualenv/cache folders.
- Supports fzf extended syntax:

| Input                                        | Match type                              | Description                                                                                                                                   |
| -------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `cmp`                                        | fuzzy-match                             | Items that match `cmp`, such as `ComponentMap` or `createMessageParser`.                                                                      |
| `'useState`                                  | exact-match (quoted)                    | Items that include `useState`, such as `useStateReducer`.                                                                                     |
| `'auth'`                                     | exact-boundary-match (quoted both ends) | Items that include `auth` at word boundaries, such as `auth-token` or `auth.service`.                                                         |
| `^use`                                       | prefix-exact-match                      | Items that start with `use`, such as `useUserSession`.                                                                                        |
| `Controller$`                                | suffix-exact-match                      | Items that end with `Controller`, such as `UserController`.                                                                                   |
| `!deprecated`                                | inverse-exact-match                     | Items that do not include `deprecated`.                                                                                                       |
| `!^legacy`                                   | inverse-prefix-exact-match              | Items that do not start with `legacy`.                                                                                                        |
| `!Spec$`                                     | inverse-suffix-exact-match              | Items that do not end with `Spec`.                                                                                                            |
| `sb controller`                              | multiple-terms (AND)                    | Items that match both `sb` AND `controller`, such as `SidebarController`.                                                                     |
| <code>sb &#124; controller</code>            | OR-match                                | Items that match either `sb` OR `controller`, such as `Sidebar` or `UserController`.                                                          |
| <code>'controller auth &#124; session</code> | exact AND OR-match                      | Items containing `controller` exactly, and matching either `auth` or `session` fuzzy, such as `AuthController.ts` or `session_controller.rb`. |
| <code>'auth &#124; 'session</code>           | multiple exact (OR)                     | Items containing either `auth` exactly or `session` exactly, such as `auth.ts` or `session.py` (excluding `author.ts`).                       |
| `'src 'test`                                 | multiple exact (AND)                    | Items containing both `src` exactly and `test` exactly, such as `src/app.test.ts`.                                                            |
| <code>foo&#124;bar</code>                    | literal pipe                            | Matches a literal pipe inside a token, such as `docs/foo\|bar.md` (no spaces around `\|`).                                                    |
| `Foo`                                        | smart-case match                        | Uppercase characters make the term case-sensitive (e.g., `Foo` only matches items containing `Foo`, but `foo` matches both `foo` and `Foo`).  |

Spaces can be escaped inside a token with `\`.

## Frecency

Submitted prompts are scanned for `@path` and `@"path with spaces"` references. Referenced files are recorded in a project-scoped JSON hashmap under:

```text
~/.pi/agent/fzf-files/frecency-v1/<cwd-hash>.json
```

Ranking uses match quality first. Frecency is a tie-breaker, so frequently/recently referenced files move up when the textual match is otherwise equal.

SQLite would only help once the index itself lives on disk or queries need cross-project aggregation. For this extension the hot path is an in-memory top-K scan over cached paths, while frecency lookups are O(1) map reads. The JSON store keeps runtime installs dependency-free and portable across Pi's supported Node runtimes.

## Install

From npm:

```bash
pi install npm:pi-fzf-files
```

Try it without installing permanently:

```bash
pi -e npm:pi-fzf-files
```

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

`/fzf-files help` opens a formatted Markdown help view with separate command and syntax-example tables
`/fzf-files syntax` opens a syntax examples table

## Development

```bash
bun test
npm run typecheck
```
