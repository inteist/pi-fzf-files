export type FzfTermKind = "fuzzy" | "exact" | "boundary" | "prefix" | "suffix" | "equal";

export interface FzfTerm {
  raw: string;
  text: string;
  kind: FzfTermKind;
  inverse: boolean;
  lowerText: string;
  caseSensitive?: boolean;
}

export interface FzfQuery {
  raw: string;
  /** AND clauses; terms inside a clause are OR alternatives. */
  groups: FzfTerm[][];
}

export interface FzfMatch {
  matched: boolean;
  score: number;
}

const NO_MATCH: FzfMatch = { matched: false, score: Number.NEGATIVE_INFINITY };
const MATCH_ZERO: FzfMatch = { matched: true, score: 0 };

export function parseFzfQuery(input: string): FzfQuery {
  const tokens = tokenizeFzfQuery(input);
  const groups: FzfTerm[][] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    // In fzf, a standalone bar between terms joins the previous and next
    // terms with OR. A leading bar is a literal term, and a trailing bar is
    // ignored while the user is still typing the next alternative.
    if (token === "|" && groups.length > 0) {
      if (index === tokens.length - 1) {
        continue;
      }

      let nextIndex = index + 1;
      let term: FzfTerm | null = null;
      while (nextIndex < tokens.length && term === null) {
        term = parseFzfTerm(tokens[nextIndex]!);
        nextIndex += 1;
      }
      if (term) {
        groups[groups.length - 1]!.push(term);
      }
      index = nextIndex - 1;
      continue;
    }

    const term = parseFzfTerm(token);
    if (term) {
      groups.push([term]);
    }
  }

  return { raw: input, groups };
}

function tokenizeFzfQuery(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let escaped = false;

  const pushToken = () => {
    if (token.length > 0) {
      tokens.push(token);
      token = "";
    }
  };

  for (const char of input) {
    if (escaped) {
      if (/\s/u.test(char)) {
        token += char;
      } else {
        token += `\\${char}`;
      }
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }

    token += char;
  }

  if (escaped) {
    token += "\\";
  }
  pushToken();

  return tokens;
}

export function parseFzfTerm(rawToken: string): FzfTerm | null {
  let raw = rawToken;
  let inverse = false;

  if (raw.startsWith("!")) {
    inverse = true;
    raw = raw.slice(1);
  }

  if (raw.length === 0) {
    return null;
  }

  let kind: FzfTermKind;
  let text = raw;

  if (raw.startsWith("'")) {
    text = raw.slice(1);
    if (text.length === 0) {
      return null;
    }

    if (text.endsWith("'") && text.length > 1) {
      text = text.slice(0, -1);
      kind = "boundary";
    } else {
      kind = "exact";
    }
  } else if (raw.startsWith("^")) {
    text = raw.slice(1);
    if (text.endsWith("$")) {
      text = text.slice(0, -1);
      kind = "equal";
    } else {
      kind = "prefix";
    }

    if (text.length === 0) {
      return null;
    }
  } else if (raw.endsWith("$") && raw.length > 1) {
    text = raw.slice(0, -1);
    kind = "suffix";
  } else if (inverse) {
    // fzf treats !fire as an inverse exact match, not an inverse fuzzy match.
    kind = "exact";
  } else {
    kind = "fuzzy";
  }

  if (text.length === 0) {
    return null;
  }

  return {
    raw: rawToken,
    text,
    kind,
    inverse,
    lowerText: text.toLowerCase(),
    caseSensitive: hasUpperCase(text),
  };
}

export function matchFzfQuery(query: FzfQuery, target: string): FzfMatch {
  if (query.groups.length === 0) {
    return MATCH_ZERO;
  }

  const lowerTarget = target.toLowerCase();
  let score = 0;

  for (const group of query.groups) {
    const groupMatch = matchFzfGroup(group, target, lowerTarget);
    if (!groupMatch.matched) {
      return NO_MATCH;
    }
    score += groupMatch.score;
  }

  return { matched: true, score };
}

function matchFzfGroup(group: FzfTerm[], target: string, lowerTarget: string): FzfMatch {
  let best = NO_MATCH;

  for (const term of group) {
    const termMatch = matchFzfTerm(term, target, lowerTarget);
    const alternativeMatch = term.inverse
      ? termMatch.matched
        ? NO_MATCH
        : MATCH_ZERO
      : termMatch;

    if (alternativeMatch.matched && alternativeMatch.score > best.score) {
      best = alternativeMatch;
    }
  }

  return best;
}

export function matchFzfTerm(term: FzfTerm, target: string, lowerTarget = target.toLowerCase()): FzfMatch {
  const searchTarget = term.caseSensitive ? target : lowerTarget;
  const searchText = term.caseSensitive ? term.text : term.lowerText;

  switch (term.kind) {
    case "fuzzy":
      return fuzzyMatchScore(searchTarget, searchText, target);
    case "exact":
      return exactMatchScore(searchTarget, searchText, target);
    case "boundary":
      return boundaryMatchScore(searchTarget, searchText, target);
    case "prefix":
      return searchTarget.startsWith(searchText)
        ? { matched: true, score: 900 + term.text.length * 8 }
        : NO_MATCH;
    case "suffix":
      return searchTarget.endsWith(searchText)
        ? { matched: true, score: 850 + term.text.length * 8 }
        : NO_MATCH;
    case "equal":
      return searchTarget === searchText
        ? { matched: true, score: 1_100 + term.text.length * 10 }
        : NO_MATCH;
  }
}

function exactMatchScore(lowerTarget: string, lowerNeedle: string, target = lowerTarget): FzfMatch {
  const index = lowerTarget.indexOf(lowerNeedle);
  if (index < 0) {
    return NO_MATCH;
  }

  const boundaryBonus = isBoundaryStart(target, index) ? 35 : 0;
  const basenameBonus = index > lowerTarget.lastIndexOf("/") ? 25 : 0;
  return {
    matched: true,
    score: 700 + lowerNeedle.length * 8 + boundaryBonus + basenameBonus - Math.min(index, 80),
  };
}

function boundaryMatchScore(lowerTarget: string, lowerNeedle: string, target = lowerTarget): FzfMatch {
  let index = lowerTarget.indexOf(lowerNeedle);
  while (index >= 0) {
    const end = index + lowerNeedle.length;
    if (isBoundaryStart(target, index) && isBoundaryEnd(target, end)) {
      return {
        matched: true,
        score: 800 + lowerNeedle.length * 9 - Math.min(index, 80),
      };
    }
    index = lowerTarget.indexOf(lowerNeedle, index + 1);
  }
  return NO_MATCH;
}

export function fuzzyMatchScore(lowerTarget: string, lowerQuery: string, target = lowerTarget): FzfMatch {
  if (lowerQuery.length === 0) {
    return MATCH_ZERO;
  }

  const positions = findTightSubsequence(lowerTarget, lowerQuery);
  if (!positions) {
    return NO_MATCH;
  }

  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  const span = last - first + 1;
  let consecutive = 0;
  let boundary = 0;
  let separator = 0;

  for (let i = 0; i < positions.length; i += 1) {
    const position = positions[i]!;
    if (i > 0 && position === positions[i - 1]! + 1) {
      consecutive += 1;
    }
    if (isBoundaryStart(target, position)) {
      boundary += 1;
    }
    if (position > 0 && lowerTarget[position - 1] === "/") {
      separator += 1;
    }
  }

  const basenameStart = lowerTarget.lastIndexOf("/") + 1;
  const basenameBonus = first >= basenameStart ? 35 : 0;
  const prefixBonus = first === 0 || first === basenameStart ? 50 : 0;
  const contiguousBonus = span === lowerQuery.length ? 70 : 0;

  return {
    matched: true,
    score:
      100 +
      lowerQuery.length * 16 +
      consecutive * 18 +
      boundary * 12 +
      separator * 10 +
      basenameBonus +
      prefixBonus +
      contiguousBonus -
      Math.min(first * 2, 120) -
      Math.min((span - lowerQuery.length) * 4, 160),
  };
}

function findTightSubsequence(target: string, query: string): number[] | null {
  const forward: number[] = [];
  let targetIndex = 0;

  for (const queryChar of query) {
    const found = target.indexOf(queryChar, targetIndex);
    if (found < 0) {
      return null;
    }
    forward.push(found);
    targetIndex = found + 1;
  }

  const backward = new Array<number>(query.length);
  targetIndex = forward[forward.length - 1]!;

  for (let queryIndex = query.length - 1; queryIndex >= 0; queryIndex -= 1) {
    const queryChar = query[queryIndex]!;
    const found = target.lastIndexOf(queryChar, targetIndex);
    if (found < 0) {
      return null;
    }
    backward[queryIndex] = found;
    targetIndex = found - 1;
  }

  return backward;
}

function isBoundaryStart(value: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = value[index - 1]!;
  const current = value[index]!;
  if (!isAlphaNumeric(previous) && isAlphaNumeric(current)) return true;

  // Treat camelCase as a useful boundary when callers pass original casing.
  return isLower(previous) && isUpper(current);
}

function isBoundaryEnd(value: string, index: number): boolean {
  if (index >= value.length) return true;
  const previous = value[index - 1]!;
  const current = value[index]!;
  if (isAlphaNumeric(previous) && !isAlphaNumeric(current)) return true;

  // Treat fooBar as a boundary after "foo" when callers pass original casing.
  return isLower(previous) && isUpper(current);
}

function hasUpperCase(value: string): boolean {
  return value !== value.toLowerCase();
}

function isAlphaNumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLower(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 97 && code <= 122;
}

function isUpper(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90;
}
