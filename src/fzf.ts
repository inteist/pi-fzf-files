export type FzfTermKind = "fuzzy" | "exact" | "boundary" | "prefix" | "suffix" | "equal";

export interface FzfTerm {
  raw: string;
  text: string;
  kind: FzfTermKind;
  inverse: boolean;
  lowerText: string;
}

export interface FzfQuery {
  raw: string;
  groups: FzfTerm[][];
}

export interface FzfMatch {
  matched: boolean;
  score: number;
}

const NO_MATCH: FzfMatch = { matched: false, score: Number.NEGATIVE_INFINITY };
const MATCH_ZERO: FzfMatch = { matched: true, score: 0 };

export function parseFzfQuery(input: string): FzfQuery {
  const groups: FzfTerm[][] = [[]];
  let token = "";
  let escaped = false;

  const pushToken = () => {
    if (token.length === 0) return;
    const term = parseFzfTerm(token);
    if (term) {
      groups[groups.length - 1]!.push(term);
    }
    token = "";
  };

  for (const char of input) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "|") {
      pushToken();
      if (groups[groups.length - 1]!.length > 0) {
        groups.push([]);
      }
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

  return {
    raw: input,
    groups: groups.filter((group) => group.length > 0),
  };
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

  if (raw.startsWith("'") && raw.length > 1) {
    text = raw.slice(1);
    if (text.endsWith("'") && text.length > 1) {
      text = text.slice(0, -1);
      kind = "boundary";
    } else {
      kind = "exact";
    }
  } else if (raw.startsWith("^") && raw.length > 1) {
    text = raw.slice(1);
    if (text.endsWith("$") && text.length > 1) {
      text = text.slice(0, -1);
      kind = "equal";
    } else {
      kind = "prefix";
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
  };
}

export function matchFzfQuery(query: FzfQuery, target: string): FzfMatch {
  if (query.groups.length === 0) {
    return MATCH_ZERO;
  }

  const lowerTarget = target.toLowerCase();
  let best = NO_MATCH;

  for (const group of query.groups) {
    const groupMatch = matchFzfGroup(group, target, lowerTarget);
    if (groupMatch.matched && groupMatch.score > best.score) {
      best = groupMatch;
    }
  }

  return best;
}

function matchFzfGroup(group: FzfTerm[], target: string, lowerTarget: string): FzfMatch {
  let score = 0;

  for (const term of group) {
    const termMatch = matchFzfTerm(term, target, lowerTarget);
    if (term.inverse) {
      if (termMatch.matched) {
        return NO_MATCH;
      }
      continue;
    }

    if (!termMatch.matched) {
      return NO_MATCH;
    }
    score += termMatch.score;
  }

  return { matched: true, score };
}

export function matchFzfTerm(term: FzfTerm, target: string, lowerTarget = target.toLowerCase()): FzfMatch {
  switch (term.kind) {
    case "fuzzy":
      return fuzzyMatchScore(lowerTarget, term.lowerText);
    case "exact":
      return exactMatchScore(lowerTarget, term.lowerText);
    case "boundary":
      return boundaryMatchScore(lowerTarget, term.lowerText);
    case "prefix":
      return lowerTarget.startsWith(term.lowerText)
        ? { matched: true, score: 900 + term.text.length * 8 }
        : NO_MATCH;
    case "suffix":
      return lowerTarget.endsWith(term.lowerText)
        ? { matched: true, score: 850 + term.text.length * 8 }
        : NO_MATCH;
    case "equal":
      return lowerTarget === term.lowerText
        ? { matched: true, score: 1_100 + term.text.length * 10 }
        : NO_MATCH;
  }
}

function exactMatchScore(lowerTarget: string, lowerNeedle: string): FzfMatch {
  const index = lowerTarget.indexOf(lowerNeedle);
  if (index < 0) {
    return NO_MATCH;
  }

  const boundaryBonus = isBoundaryStart(lowerTarget, index) ? 35 : 0;
  const basenameBonus = index > lowerTarget.lastIndexOf("/") ? 25 : 0;
  return {
    matched: true,
    score: 700 + lowerNeedle.length * 8 + boundaryBonus + basenameBonus - Math.min(index, 80),
  };
}

function boundaryMatchScore(lowerTarget: string, lowerNeedle: string): FzfMatch {
  let index = lowerTarget.indexOf(lowerNeedle);
  while (index >= 0) {
    const end = index + lowerNeedle.length;
    if (isBoundaryStart(lowerTarget, index) && isBoundaryEnd(lowerTarget, end)) {
      return {
        matched: true,
        score: 800 + lowerNeedle.length * 9 - Math.min(index, 80),
      };
    }
    index = lowerTarget.indexOf(lowerNeedle, index + 1);
  }
  return NO_MATCH;
}

export function fuzzyMatchScore(lowerTarget: string, lowerQuery: string): FzfMatch {
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
    if (isBoundaryStart(lowerTarget, position)) {
      boundary += 1;
    }
    if (position === lowerTarget.lastIndexOf("/") + 1) {
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
      return forward;
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
