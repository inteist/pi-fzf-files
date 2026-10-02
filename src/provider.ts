import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import type { FileIndex, FileSearchResult } from "./file-index.js";
import { extractAtFzfPrefix } from "./prefix.js";

const MAX_SUGGESTIONS = 20;

export interface FzfFileAutocompleteProvider extends AutocompleteProvider {
  /** Observe edits before Pi's debounce can discard intermediate query states. */
  observeEditor(lines: string[], cursorLine: number, cursorCol: number): boolean;
  reset(): void;
  dispose(): void;
  readonly completionVersion: number;
}

export function createFzfFileAutocompleteProvider(
  current: AutocompleteProvider,
  fileIndex: FileIndex,
  onAtInvocation?: () => void | Promise<void>,
): FzfFileAutocompleteProvider {
  let atQuery: { cursorLine: number; beforeAt: string; query: string } | undefined;
  let completed: { cursorLine: number; beforeAt: string; prefix: string } | undefined;
  let refreshNeeded = true;
  let refreshPromise: Promise<boolean> | undefined;
  let invocation = 0;
  let completionVersion = 0;
  const lifetime = new AbortController();

  const reset = () => {
    atQuery = undefined;
    completed = undefined;
    refreshNeeded = true;
    refreshPromise = undefined;
    invocation += 1;
  };

  const observeEditor = (lines: string[], cursorLine: number, cursorCol: number): boolean => {
    const textBeforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const prefix = extractAtFzfPrefix(textBeforeCursor);
    if (prefix === null) {
      if (atQuery || completed) reset();
      return false;
    }

    const query = stripAtQueryPrefix(prefix);
    const beforeAt = textBeforeCursor.slice(0, -prefix.length);
    // Spaces are valid fzf operators, so parsing alone cannot distinguish an
    // active multi-term query from prose following an accepted file reference.
    if (completed?.cursorLine === cursorLine && completed.beforeAt === beforeAt &&
      prefix.startsWith(completed.prefix)) return false;
    completed = undefined;
    if (!atQuery || atQuery.cursorLine !== cursorLine || atQuery.beforeAt !== beforeAt ||
      (query === "" && atQuery.query !== "")) {
      refreshNeeded = true;
      invocation += 1;
    }
    atQuery = { cursorLine, beforeAt, query };
    return true;
  };

  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
    observeEditor,
    reset,
    get completionVersion() { return completionVersion; },
    dispose() {
      lifetime.abort();
      reset();
    },

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      if (options.signal.aborted || lifetime.signal.aborted) return null;

      const prefix = extractAtFzfPrefix((lines[cursorLine] ?? "").slice(0, cursorCol));
      if (options.force) completed = undefined;
      const inAtQuery = observeEditor(lines, cursorLine, cursorCol);
      if (prefix === null) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!inAtQuery) return null;
      const query = stripAtQueryPrefix(prefix);
      const requestInvocation = invocation;
      if (refreshNeeded || (options.force && !refreshPromise)) {
        refreshNeeded = false;
        // Normalize sync throws and rejected promises. A failed refresh must not
        // poison Pi's serialized request queue or permanently latch this query.
        const pending: Promise<boolean> = Promise.resolve()
          .then(() => { if (!lifetime.signal.aborted) return onAtInvocation?.(); })
          .then(() => true, () => {
            if (refreshPromise === pending) {
              refreshPromise = undefined;
              refreshNeeded = true;
            }
            return false;
          });
        refreshPromise = pending;
      }

      // Pi consumes each result once, so search only after the shared index swap.
      // The editor adapter schedules a replacement request when text changes,
      // even if no popup exists yet (e.g. while entering a multi-term query).
      const refresh = refreshPromise;
      if (refresh) {
        const ready = await waitForRefresh(refresh, AbortSignal.any([options.signal, lifetime.signal]));
        if (ready === undefined) return null;
        if (refreshPromise === refresh) {
          refreshPromise = undefined;
          refreshNeeded ||= !ready;
        }
      }
      if (options.signal.aborted || lifetime.signal.aborted || invocation !== requestInvocation) return null;

      // On failure, use the last good snapshot and retry on the next request.
      const matches = fileIndex.search(query, { limit: MAX_SUGGESTIONS, signal: options.signal });
      if (options.signal.aborted) return null;
      if (matches.length === 0) {
        // Never delegate @ misses to Pi's default file finder.
        return null;
      }

      return { prefix, items: matches.map(toAutocompleteItem) };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const result = current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      completionVersion += 1;
      reset();
      if (prefix.startsWith("@") && !item.label.endsWith("/")) {
        const text = (result.lines[result.cursorLine] ?? "").slice(0, result.cursorCol);
        const completedPrefix = extractAtFzfPrefix(text);
        if (completedPrefix !== null) {
          completed = { cursorLine: result.cursorLine, beforeAt: text.slice(0, -completedPrefix.length), prefix: completedPrefix };
        }
      }
      return result;
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (extractAtFzfPrefix((lines[cursorLine] ?? "").slice(0, cursorCol)) !== null) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

// Cancellation belongs to the request, not the shared filesystem walk.
// undefined = cancelled; false = failed (use the cached snapshot).
function waitForRefresh(refresh: Promise<boolean>, signal: AbortSignal): Promise<boolean | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const finish = (ready: boolean | undefined) => {
      signal.removeEventListener("abort", onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    void refresh.then(finish);
  });
}

export function stripAtQueryPrefix(prefix: string): string {
  if (prefix.startsWith('@"')) return prefix.slice(2);
  return prefix.startsWith("@") ? prefix.slice(1) : prefix;
}

function toAutocompleteItem(match: FileSearchResult): AutocompleteItem {
  const descriptionParts = [match.description];
  if (match.frecency > 0) descriptionParts.push(`freq ${match.frecency.toFixed(2)}`);
  return {
    value: match.value,
    label: match.label,
    description: descriptionParts.join(" · "),
  };
}
