import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function joinDisplayPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export function basenameDisplay(path: string): string {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export function depthOfDisplayPath(path: string): number {
  if (!path) return 0;
  return path.split("/").length - 1;
}

export function quoteAtPath(path: string): string {
  const normalized = toDisplayPath(path);
  if (!/[\s"]/u.test(normalized)) {
    return `@${normalized}`;
  }

  const escaped = normalized.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `@"${escaped}"`;
}

export function normalizeReferencePath(cwd: string, rawPath: string): string | null {
  let value = rawPath.trim();
  if (!value) return null;

  if (value.startsWith("@")) {
    value = value.slice(1);
  }

  value = unquoteReference(value);
  if (!value) return null;

  if (value.endsWith("/")) {
    value = value.slice(0, -1);
  }

  let absolute: string;
  if (value === "~" || value.startsWith("~/")) {
    absolute = resolve(homedir(), value === "~" ? "" : value.slice(2));
  } else if (isAbsolute(value)) {
    absolute = resolve(value);
  } else {
    absolute = resolve(cwd, value);
  }

  const relativePath = relative(resolve(cwd), absolute);
  if (relativePath === "") return null;
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return null;
  }

  return toDisplayPath(relativePath.split(sep).join("/"));
}

function unquoteReference(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return unescapeDoubleQuoted(value.slice(1, -1));
  }
  return value;
}

function unescapeDoubleQuoted(value: string): string {
  let result = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    result += char;
  }
  if (escaped) result += "\\";
  return result;
}

export function candidateReferencePaths(cwd: string, rawPath: string): string[] {
  const candidates = new Set<string>();
  const normalized = normalizeReferencePath(cwd, rawPath);
  if (normalized) candidates.add(normalized);

  let trimmed = rawPath;
  while (/[),.;:!?\]]$/u.test(trimmed)) {
    trimmed = trimmed.slice(0, -1);
    const candidate = normalizeReferencePath(cwd, trimmed);
    if (candidate) candidates.add(candidate);
  }

  return [...candidates];
}
