import type { SymbolId, SymbolRecord } from "../index.js";
import { matchesAnyFilePattern } from "../verifier/glob.js";

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export interface FilePatch {
  /** Project-relative POSIX path at the base side, or null for additions. */
  oldFile: string | null;
  /** Project-relative POSIX path at the working-tree side, or null for deletions. */
  newFile: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

function unquotePath(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripPrefix(file: string, prefix: string): string | null {
  if (prefix === "") return file;
  const head = `${prefix}/`;
  return file.startsWith(head) ? file.slice(head.length) : null;
}

function patchSidePath(line: string, prefix: string): string | null {
  const raw = unquotePath(line.slice(4));
  if (raw === "/dev/null") return null;
  const withoutSide = raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
  return stripPrefix(withoutSide, prefix);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a `git diff --unified=0` patch into per-file hunks. */
export function parseUnifiedDiff(patch: string, gitPrefix: string): FilePatch[] {
  const out: FilePatch[] = [];
  let current: FilePatch | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { oldFile: null, newFile: null, binary: false, hunks: [] };
      out.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("--- ")) {
      current.oldFile = patchSidePath(line, gitPrefix);
    } else if (line.startsWith("+++ ")) {
      current.newFile = patchSidePath(line, gitPrefix);
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.binary = true;
    } else {
      const match = HUNK_RE.exec(line);
      if (match !== null) {
        current.hunks.push({
          oldStart: Number(match[1]),
          oldCount: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] === undefined ? 1 : Number(match[4]),
        });
      }
    }
  }
  return out;
}

/** Mirrors the indexer's indexable-path rule (TS/TSX/JS/JSX, no `.d.ts`). */
export function isAppSourceFile(file: string): boolean {
  if (/\.d\.[cm]?ts$/.test(file)) return false;
  return /\.[cm]?[tj]sx?$/.test(file);
}

export function isDeclarationFile(file: string): boolean {
  return /\.d\.[cm]?ts$/.test(file);
}

const CONFIG_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
]);

export function isConfigFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (CONFIG_BASENAMES.has(base)) return true;
  if (/^vibehard\.config\.[^.]+$/.test(base)) return true;
  if (/^playwright\.config\.[^.]+$/.test(base)) return true;
  if (/^cypress\.config\.[^.]+$/.test(base)) return true;
  if (/^tsconfig(\..+)?\.json$/.test(base)) return true;
  return false;
}

export type ChangedFileKind =
  | "ignored"
  | "lockfile"
  | "config"
  | "spec"
  | "test-support"
  | "app"
  | "asset"
  | "unmapped";

export interface ClassifyContext {
  ignore: readonly string[];
  include: readonly string[];
  /** POSIX test directory prefix, or null. */
  testDirPosix: string | null;
  /** Discovered spec files (POSIX project-relative). */
  specFiles: ReadonlySet<string>;
  /** POSIX project-relative lockfile path. */
  lockfileRel: string;
  /** Files with an indexed asset symbol at base or head. */
  assetFiles?: ReadonlySet<string>;
}

/**
 * Decide how one changed file participates in selection. The order is the
 * safety contract: nothing unclassified is ever waved through.
 */
export function classifyChangedFile(file: string, ctx: ClassifyContext): ChangedFileKind {
  if (file.split("/").includes("node_modules")) return "ignored";
  if (matchesAnyFilePattern(ctx.ignore, file)) return "ignored";
  if (file === ctx.lockfileRel) return "lockfile";
  if (isConfigFile(file)) return "config";
  if (ctx.specFiles.has(file)) return "spec";
  if (
    ctx.testDirPosix !== null &&
    (file === ctx.testDirPosix || file.startsWith(`${ctx.testDirPosix}/`))
  ) {
    return "test-support";
  }
  if (isDeclarationFile(file)) return "unmapped";
  if (ctx.assetFiles?.has(file)) return "asset";
  if (isAppSourceFile(file)) {
    if (ctx.include.length > 0 && !matchesAnyFilePattern(ctx.include, file)) {
      return "unmapped";
    }
    return "app";
  }
  return "unmapped";
}

function linesOf(text: string | null): string[] {
  return text === null ? [] : text.split("\n");
}

function lineAt(lines: readonly string[], oneBased: number): string {
  return lines[oneBased - 1] ?? "";
}

/**
 * The smallest symbol containing `line`. The whole-file `module`
 * symbol is naturally the fallback (it is the largest), so any line
 * inside a function or value attributes to that smaller symbol.
 */
function smallestSymbolForLine(
  symbols: readonly SymbolRecord[],
  line: number,
): SymbolId | null {
  let best: SymbolRecord | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const s of symbols) {
    if (line < s.startLine || line > s.endLine) continue;
    const span = s.endOffset - s.startOffset;
    if (span < bestSpan) {
      best = s;
      bestSpan = span;
    }
  }
  return best?.id ?? null;
}

export interface FileChangeInput {
  status: "A" | "M" | "D" | "T" | "U" | "?";
  baseSymbols: readonly SymbolRecord[];
  headSymbols: readonly SymbolRecord[];
  baseHashes: Readonly<Record<string, string>>;
  headHashes: Readonly<Record<string, string>>;
  hunks: readonly DiffHunk[];
  binary: boolean;
  baseText: string | null;
  headText: string | null;
}

export interface FileChangeResult {
  changedSymbols: SymbolId[];
  /** Changed lines fall outside every symbol: selection cannot be proven safe. */
  unmappedLines: boolean;
}

/**
 * Changed symbols for one app-source file: base symbols intersecting the
 * diff hunks, plus symbols added or deleted in the file, plus symbols
 * whose source hash changed (which also makes whitespace edits inside a
 * symbol count, per AT-14).
 */
export function computeChangedSymbolsForFile(input: FileChangeInput): FileChangeResult {
  if (input.binary) return { changedSymbols: [], unmappedLines: true };

  if (input.status === "D") {
    const ids = input.baseSymbols.map((s) => s.id);
    const hasCode = linesOf(input.baseText).some((l) => l.trim() !== "");
    return { changedSymbols: ids, unmappedLines: ids.length === 0 && hasCode };
  }

  if (input.status === "A" || input.status === "?") {
    // A brand-new file cannot execute unless changed code imports it, and
    // that change is mapped in the importing file. Its symbols still join
    // the changed set so head-recorded touched sets can select on them.
    return { changedSymbols: input.headSymbols.map((s) => s.id), unmappedLines: false };
  }

  const changed = new Set<SymbolId>();
  const baseLines = linesOf(input.baseText);
  const headLines = linesOf(input.headText);
  let unmappedLines = false;

  for (const hunk of input.hunks) {
    // Attribute each real changed line to its smallest containing
    // symbol on the matching side (a pure insertion has no old lines;
    // a blank line added between symbols attributes to nothing).
    for (let line = hunk.oldStart; line < hunk.oldStart + hunk.oldCount; line += 1) {
      if (lineAt(baseLines, line).trim() === "") continue;
      const id = smallestSymbolForLine(input.baseSymbols, line);
      if (id === null) unmappedLines = true;
      else changed.add(id);
    }
    for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line += 1) {
      if (lineAt(headLines, line).trim() === "") continue;
      const id = smallestSymbolForLine(input.headSymbols, line);
      if (id === null) unmappedLines = true;
      else changed.add(id);
    }
  }

  const baseIds = new Set(input.baseSymbols.map((s) => s.id));
  const headIds = new Set(input.headSymbols.map((s) => s.id));
  for (const id of baseIds) if (!headIds.has(id)) changed.add(id);
  for (const id of headIds) if (!baseIds.has(id)) changed.add(id);
  for (const id of baseIds) {
    if (headIds.has(id) && input.baseHashes[id] !== input.headHashes[id]) changed.add(id);
  }

  return { changedSymbols: [...changed].sort(), unmappedLines };
}
