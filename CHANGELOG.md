# Changelog

## [Unreleased]

### Fixed

- `@` autocomplete now waits for its background refresh, including an already-running startup rebuild, before returning results so newly indexed files appear without another keystroke.
- Clearing a query back to `@` or `@"`, starting another `@` token, or completing a reference resets the refresh cycle instead of leaving the provider latched to an old invocation.
- Cancelled autocomplete requests release promptly without cancelling the shared index rebuild.
- Multi-term queries and operators entered during a pending refresh now retrigger completion before a popup exists.
- Editor-side observation catches query/prompt resets hidden by debouncing; explicit Tab completion can force a fresh lookup.
- Failed refreshes fall back to the cached index and allow retry; retired session providers release pending requests and ignore late results.
- The editor adapter preserves existing custom-editor factories, respects Escape and accepted completions, and restores its hooks on shutdown.

### Tests

- Added real-editor regression coverage for debounce, pending refreshes, prompt replacement, cancellation, and completion behavior, plus refresh-failure and session-lifecycle tests.

## [0.2.0] - 2026-06-25

### Added

- **Symlink Following Support**: Implemented symlink following (`--follow` equivalent).
  - Uses recursive tracking to prevent symlink cycles.
  - Skips dangling/unreadable symlinks.
  - Resolves normal files and child directories synchronously for high performance.
  - Added comprehensive test coverage in [search.test.ts](./test/search.test.ts).
- **Frecency Storage Resilience**: Added lock-file mechanism to prevent concurrent/distinct Pi sessions from clobbering each other's frecency scores.
- **Frecency Merge Logic**: On session flush, read and merge existing frecency on-disk instead of overwriting it to avoid resets between sessions.

### Fixed

- Fixed the execution command in `.nash.toml`.
- Resolved a bug where frecency could be reset between sessions.

### Changed & Optimized

- Removed unnecessary synchronization when storing frecency scores (insignificant performance cost).
- Optimized directory walking so `stat()` is only run for symlinks.

---

## [0.1.0] - 2026-06-24

### Added

- **Initial Release**: Zero-dependency, pure-TypeScript implementation of fzf-style fuzzy finder for Pi's `@` file syntax.
- **Atomic Indexing**: Rebuilding the index now writes to temporary entries and atomically swaps them upon success, keeping the finder responsive.
- **Lazy Index Initialization**: First use of `@` autocompletion triggers the background index build rather than running on startup.
- **Support for Advanced Search Operators**:
  - Implemented fzf-style OR semantics (`foo | bar`).
  - Supported multiple terms (AND search, e.g. `'match1 'match2`).
  - Added smart-case sensitivity.
  - Escaped space support and no-ops for empty quote/anchor terms.
- **Startup Reindexing**: Optional session start/restart triggers an async reindex.
- **Improved UI and Help Sections**:
  - Better help formatting using `ctx.ui.custom`.
  - Added more usage examples to README and help menus.
- **Developer Tools & Docs**:
  - Added architecture design document (`.docs/architecture.html`).
  - Added Local Task runner integration for Nash Terminal (`nashterm.com`).
  - Automated tests via Bun (`test/` suite).
