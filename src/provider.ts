import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";

import type { FileIndex, FileSearchResult } from "./file-index.js";
import { extractAtFzfPrefix } from "./prefix.js";

const MAX_SUGGESTIONS = 20;

export function createFzfFileAutocompleteProvider(
  current: AutocompleteProvider,
  fileIndex: FileIndex,
  onAtQuery?: () => void,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],

    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const prefix = extractAtFzfPrefix(textBeforeCursor);

      if (prefix === null) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      onAtQuery?.();

      if (options.signal.aborted) {
        return null;
      }

      const query = stripAtQueryPrefix(prefix);
      const matches = fileIndex.search(query, { limit: MAX_SUGGESTIONS, signal: options.signal });
      if (options.signal.aborted) {
        return null;
      }

      if (matches.length === 0) {
        // Intentionally do not delegate here: this extension replaces Pi's default @ finder.
        return null;
      }

      return {
        prefix,
        items: matches.map(toAutocompleteItem),
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export function stripAtQueryPrefix(prefix: string): string {
  if (prefix.startsWith('@"')) {
    return prefix.slice(2);
  }
  return prefix.startsWith("@") ? prefix.slice(1) : prefix;
}

function toAutocompleteItem(match: FileSearchResult): AutocompleteItem {
  const descriptionParts = [match.description];
  if (match.frecency > 0) {
    descriptionParts.push(`freq ${match.frecency.toFixed(2)}`);
  }

  return {
    value: match.value,
    label: match.label,
    description: descriptionParts.join(" · "),
  };
}
