const TOKEN_START_CHARS = new Set([" ", "\t", "\n", "\r", "(", "[", "{", "=", ":", ","]);

export function extractAtFzfPrefix(textBeforeCursor: string): string | null {
  const start = findLastAtTokenStart(textBeforeCursor);
  if (start < 0) return null;
  return textBeforeCursor.slice(start);
}

function findLastAtTokenStart(value: string): number {
  let inDoubleQuote = false;
  let escaped = false;
  let last = -1;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "@" && !inDoubleQuote && isTokenStart(value, index)) {
      last = index;
    }
  }

  return last;
}

function isTokenStart(value: string, index: number): boolean {
  if (index === 0) return true;
  return TOKEN_START_CHARS.has(value[index - 1]!);
}

export function extractAtReferences(text: string): string[] {
  const references: string[] = [];
  let index = 0;

  while (index < text.length) {
    const at = text.indexOf("@", index);
    if (at < 0) break;
    if (!isTokenStart(text, at)) {
      index = at + 1;
      continue;
    }

    const next = text[at + 1];
    if (next === '"') {
      const parsed = readDoubleQuotedReference(text, at + 2);
      if (parsed) {
        references.push(parsed.value);
        index = parsed.end;
        continue;
      }
    }

    const parsed = readUnquotedReference(text, at + 1);
    if (parsed) {
      references.push(parsed.value);
      index = parsed.end;
      continue;
    }

    index = at + 1;
  }

  return references;
}

function readDoubleQuotedReference(text: string, start: number): { value: string; end: number } | null {
  let value = "";
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      return value ? { value, end: index + 1 } : null;
    }
    value += char;
  }

  return value ? { value, end: text.length } : null;
}

function readUnquotedReference(text: string, start: number): { value: string; end: number } | null {
  let end = start;
  while (end < text.length && !/\s/u.test(text[end]!)) {
    end += 1;
  }

  const value = text.slice(start, end);
  return value ? { value, end } : null;
}
