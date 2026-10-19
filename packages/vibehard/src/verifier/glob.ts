/**
 * Minimal glob matcher for Stage 3 config/declaration patterns.
 * Supports `**` (any run including `/`), `*` (any run except `/`),
 * and `?` (one char except `/`). No brace expansion or character classes.
 * Patterns match against a POSIX file path or a full symbol ID
 * (`<file>#<qualified-name>`); a pattern without `#` is matched against
 * both the full ID and its file part by `matchSymbolPattern`.
 */

const cache = new Map<string, RegExp>();

export function matchGlob(pattern: string, value: string): boolean {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = new RegExp(`^${globToRegexSource(pattern)}$`);
    cache.set(pattern, re);
  }
  return re.test(value);
}

/** True when `symbolId` matches `pattern` as a whole or by its file part. */
export function matchSymbolPattern(pattern: string, symbolId: string): boolean {
  if (matchGlob(pattern, symbolId)) return true;
  const hash = symbolId.indexOf("#");
  if (hash > 0 && matchGlob(pattern, symbolId.slice(0, hash))) return true;
  return false;
}

export function matchesAnySymbolPattern(
  patterns: readonly string[],
  symbolId: string,
): boolean {
  return patterns.some((p) => matchSymbolPattern(p, symbolId));
}

/** True when a POSIX relative file path matches any pattern. */
export function matchesAnyFilePattern(
  patterns: readonly string[],
  file: string,
): boolean {
  return patterns.some((p) => matchGlob(p, file));
}

function globToRegexSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` (optionally bracketed by slashes) crosses directories.
        let j = i + 2;
        if (pattern[j] === "/") j += 1;
        out += ".*";
        i = j - 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegexChar(ch);
    }
  }
  return out;
}

function escapeRegexChar(ch: string): string {
  return /[.*+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}
