import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  eachMapping,
  FlattenMap,
  originalPositionFor,
  TraceMap,
} from "@jridgewell/trace-mapping";

import type {
  ObservedRange,
  ObserveScriptsOptions,
  ScriptInput,
  UnmappableScript,
} from "./types.js";
import { executedFunctionRanges, scriptUrlToPath } from "./v8.js";

export interface RemapResult {
  ranges: ObservedRange[];
  unmappable: UnmappableScript | null;
  diagnostics: string[];
}

interface RawSourceMap {
  sourceRoot?: string;
  sources?: string[];
  sourcesContent?: (string | null)[];
  /** Sectioned (index) maps, e.g. Turbopack's `[turbopack]_runtime.js.map`. */
  sections?: unknown[];
}

/** Scripts that never count and never fail closed (manifest exclusions). */
export function isBuiltinExcludedScript(script: ScriptInput): boolean {
  const sourcePath = script.sourcePath ?? scriptUrlToPath(script.url);
  if (sourcePath !== null && sourcePath.split(path.sep).includes("node_modules")) {
    return true;
  }
  if (script.url === "") return true;
  return (
    script.url.startsWith("node:") ||
    script.url.startsWith("internal/") ||
    script.url.includes("/node_modules/")
  );
}

/** App scripts must remap; a missing map for one fails closed (AT-06). */
export function isAppScript(
  script: ScriptInput,
  options: ObserveScriptsOptions,
): boolean {
  if (options.isAppScript !== undefined) return options.isAppScript(script);
  const sourcePath = script.sourcePath ?? scriptUrlToPath(script.url);
  for (const known of options.appGeneratedPaths ?? []) {
    if (sourcePath !== null && samePath(known, sourcePath)) {
      return true;
    }
    if (script.url === known) return true;
    try {
      if (new URL(script.url).pathname === known) return true;
    } catch {
      // not a URL; pathname rule does not apply
    }
  }
  if (sourcePath !== null) {
    const rel = relativePosix(options.rootDir, sourcePath);
    if (rel !== null && !rel.split("/").includes("node_modules")) return true;
  }
  return script.url.startsWith("http://") || script.url.startsWith("https://");
}

/**
 * Remap one script's executed ranges to original-source ranges.
 * Bundler glue with no mapping segment is ignored with a diagnostic; an app
 * script with no source map (or no generated source) is unmappable.
 */
export function remapScript(
  script: ScriptInput,
  options: ObserveScriptsOptions,
): RemapResult {
  const diagnostics: string[] = [];
  const fail = (reason: string): RemapResult => ({
    ranges: [],
    unmappable: { url: script.url, origin: script.origin, reason },
    diagnostics,
  });

  const executed = executedFunctionRanges(script);
  if (executed.length === 0) return { ranges: [], unmappable: null, diagnostics };
  if (isBuiltinExcludedScript(script)) {
    diagnostics.push(`excluded script: ${script.url}`);
    return { ranges: [], unmappable: null, diagnostics };
  }
  const app = isAppScript(script, options);

  const sourcePath = script.sourcePath ?? scriptUrlToPath(script.url);
  const generated = script.source ?? readIfExists(sourcePath);
  if (generated === null) {
    if (!app) {
      diagnostics.push(`skipped script without source: ${script.url}`);
      return { ranges: [], unmappable: null, diagnostics };
    }
    return fail("generated source unavailable for executed app script");
  }
  const rawMap = resolveSourceMap(script, generated, sourcePath);
  if (rawMap === null) {
    if (!app) {
      diagnostics.push(`skipped script without source map: ${script.url}`);
      return { ranges: [], unmappable: null, diagnostics };
    }
    return fail("no source map for executed app script");
  }
  return remapRanges(script, options, generated, sourcePath, rawMap, executed, diagnostics);
}

function remapRanges(
  script: ScriptInput,
  options: ObserveScriptsOptions,
  generated: string,
  sourcePath: string | null,
  rawMap: RawSourceMap,
  executed: ReturnType<typeof executedFunctionRanges>,
  diagnostics: string[],
): RemapResult {
  // Sectioned index maps must be flattened first; the flattened tracer
  // exposes aligned `sources`/`sourcesContent`, used below in place of
  // the raw (possibly sections-only) map.
  const tracer: TraceMap =
    rawMap.sections !== undefined
      ? new FlattenMap(rawMap as never)
      : new TraceMap(rawMap as never);
  const flatMap: RawSourceMap = {
    ...(rawMap.sourceRoot !== undefined ? { sourceRoot: rawMap.sourceRoot } : {}),
    sources: (tracer as { sources?: string[] }).sources ?? rawMap.sources ?? [],
    sourcesContent:
      (tracer as { sourcesContent?: (string | null)[] }).sourcesContent ??
      rawMap.sourcesContent ??
      [],
  };
  const generatedLines = new LineTable(generated);
  const originals = new Map<string, LineTable | null>();
  const ranges: ObservedRange[] = [];
  let glue = 0;

  // Map producers (notably Node's source-map-cache) rewrite `sources`
  // through symlinked dirs, so an absolute source path may not resolve
  // back under the root. Fall back to matching indexed files by suffix.
  const knownFiles = [...new Set(options.symbols.map((s) => s.file))];
  const relForSource = (source: string): string | null => {
    const clean = cleanSourcePath(source);
    // Turbopack runtime internals (`turbopack:///[turbopack]/…`) are
    // framework code with no app source file: built-in exclusion.
    if (clean.startsWith("[turbopack]/")) return null;
    const abs = resolveOriginalPath(source, flatMap, sourcePath, options.rootDir);
    const rel = relativePosix(options.rootDir, abs);
    if (rel !== null && !rel.split("/").includes("node_modules")) return rel;
    for (const file of knownFiles) {
      if (clean === file || clean.endsWith(`/${file}`)) return file;
    }
    return null;
  };

  const originalTable = (source: string): LineTable | null | "excluded" => {
    const rel = relForSource(source);
    if (rel === null) return "excluded";
    let table = originals.get(rel);
    if (table === undefined) {
      const abs = resolveOriginalPath(source, flatMap, sourcePath, options.rootDir);
      const text =
        readIfExists(abs) ??
        readIfExists(path.join(options.rootDir, rel)) ??
        sourcesContentFor(flatMap, source);
      table = text === null ? null : new LineTable(text);
      originals.set(rel, table);
    }
    return table ?? null;
  };

  for (const range of executed) {
    const startNeedle = generatedLines.positionFor(range.startOffset);
    const start = originalPositionFor(tracer, startNeedle);
    if (start.source === null || start.line === null || start.column === null) {
      glue += 1;
      continue;
    }
    const table = originalTable(start.source);
    if (table === "excluded") continue;
    if (table === null) {
      return {
        ranges,
        unmappable: {
          url: script.url,
          origin: script.origin,
          reason: `original source unreadable: ${start.source}`,
        },
        diagnostics,
      };
    }
    const startOffset = table.offsetFor(start.line, start.column);
    const endNeedle = generatedLines.positionFor(Math.max(range.startOffset, range.endOffset - 1));
    const end = originalPositionFor(tracer, endNeedle);
    if (end.source !== start.source || end.line === null || end.column === null) {
      // Start and end map to different originals: this generated
      // function spans module boundaries (a bundler module factory), or
      // its start merely inherits the previous module's last segment.
      // Attributing it to the start segment's symbol would be a guess;
      // real symbols inside it are recovered by segment sampling below
      // and by their own V8 function entries.
      glue += 1;
      continue;
    }
    const endOffset = Math.max(startOffset + 1, table.offsetFor(end.line, end.column) + 1);
    const rel = relForSource(start.source);
    if (rel === null) continue;
    ranges.push({ file: rel, startOffset, endOffset, origin: script.origin });
  }
  if (glue > 0) {
    diagnostics.push(`ignored ${glue} unmapped generated range(s) in ${script.url}`);
  }

  // Bundlers (Turbopack especially) inline small callees into their
  // callers, so an executed function's outer range no longer starts in
  // the callee's file. Recover those symbols by sampling every mapping
  // segment that lies inside an executed block range: a generated offset
  // counts as executed when it is inside some executed function's outer
  // range and outside every count-0 block / unexecuted function range.
  // Sampling is restricted to indexed files — the only files with
  // symbols — which bounds the work on framework-heavy chunks.
  const knownFileSet = new Set(knownFiles);
  const appSources = (flatMap.sources ?? []).filter((source) => {
    const rel = relForSource(source);
    return rel !== null && knownFileSet.has(rel);
  });
  if (appSources.length > 0) {
    const isExecuted = makeExecutedPredicate(script);
    const seenPoints = new Set<string>();
    try {
      eachMapping(tracer, (mapping) => {
        if (
          mapping.source === null ||
          mapping.originalLine === null ||
          mapping.originalColumn === null
        ) {
          return;
        }
        const generatedOffset = generatedLines.offsetFor(
          mapping.generatedLine,
          mapping.generatedColumn,
        );
        if (!isExecuted(generatedOffset)) return;
        const rel = relForSource(mapping.source);
        if (rel === null || !knownFileSet.has(rel)) return;
        const table = originalTable(mapping.source);
        if (table === "excluded" || table === null) return;
        const startOffset = table.offsetFor(mapping.originalLine, mapping.originalColumn);
        const key = `${rel}:${startOffset}`;
        if (seenPoints.has(key)) return;
        seenPoints.add(key);
        ranges.push({ file: rel, startOffset, endOffset: startOffset + 1, origin: script.origin });
      });
    } catch {
      diagnostics.push(`segment sampling failed for ${script.url}; outer ranges only`);
    }
  }
  return { ranges, unmappable: null, diagnostics };
}

/**
 * Offset-executed predicate from raw V8 block coverage: inside an
 * executed function's outer range, outside all count-0 ranges. The
 * synthetic whole-script function proves import, not execution, and is
 * dropped the same way as in `executedFunctionRanges`.
 */
function makeExecutedPredicate(script: ScriptInput): (offset: number) => boolean {
  let scriptRange: { startOffset: number; endOffset: number } | null = null;
  for (const fn of script.functions) {
    const range = fn.ranges[0];
    if (range === undefined || fn.functionName !== "" || range.startOffset !== 0) continue;
    if (scriptRange === null || range.endOffset > scriptRange.endOffset) scriptRange = range;
  }
  const positives: { startOffset: number; endOffset: number }[] = [];
  const zeros: { startOffset: number; endOffset: number }[] = [];
  for (const fn of script.functions) {
    const outer = fn.ranges[0];
    if (outer === undefined || outer === scriptRange) continue;
    if (outer.count > 0) {
      positives.push(outer);
      for (const block of fn.ranges.slice(1)) {
        if (block.count === 0) zeros.push(block);
      }
    } else {
      zeros.push(outer);
    }
  }
  const inAny = (
    list: readonly { startOffset: number; endOffset: number }[],
    offset: number,
  ): boolean => list.some((r) => offset >= r.startOffset && offset < r.endOffset);
  return (offset) => inAny(positives, offset) && !inAny(zeros, offset);
}

function resolveSourceMap(
  script: ScriptInput,
  generated: string,
  sourcePath: string | null,
): RawSourceMap | null {
  const explicit = parseMap(script.sourceMap);
  if (explicit !== null) return explicit;
  const inlineAt = generated.lastIndexOf("sourceMappingURL=");
  const inline = /sourceMappingURL=data:application\/json[^,]*,([^\s]+)/.exec(
    generated.slice(Math.max(0, inlineAt)),
  );
  if (inline?.[1] !== undefined) {
    try {
      const payload = inline[1];
      const text = generated.includes("base64,")
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      return parseMap(text);
    } catch {
      return null;
    }
  }
  if (sourcePath !== null) {
    const tail = generated.slice(Math.max(0, generated.lastIndexOf("sourceMappingURL=")));
    const ref = /sourceMappingURL=([^\s]+)/.exec(tail)?.[1];
    // Turbopack percent-encodes brackets in the ref (`%5Bturbopack%5D…`).
    let decodedRef = ref;
    if (ref !== undefined) {
      try {
        decodedRef = decodeURIComponent(ref);
      } catch {
        decodedRef = ref;
      }
    }
    const candidates = [
      ...(decodedRef !== undefined && !decodedRef.startsWith("data:")
        ? [path.resolve(path.dirname(sourcePath), decodedRef)]
        : []),
      `${sourcePath}.map`,
    ];
    for (const candidate of candidates) {
      const parsed = parseMap(readIfExists(candidate));
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function parseMap(value: unknown): RawSourceMap | null {
  if (typeof value === "string") {
    try {
      return parseMap(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (
    typeof value === "object" &&
    value !== null &&
    ("mappings" in value || "sections" in value)
  ) {
    return value as RawSourceMap;
  }
  return null;
}

/** Path equality tolerant of symlinked dirs (e.g. macOS `/private/var`). */
function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(path.resolve(a)) === realpathSync(path.resolve(b));
  } catch {
    return false;
  }
}

/** Strip scheme and query decoration from a source-map `sources` entry. */
function stripSourceScheme(source: string): string {
  return (
    source
      .replace(/^file:\/\//, "")
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split(/[?#]/)[0] ?? source
  );
}

/** POSIX-normalized source path without scheme or query decoration. */
function cleanSourcePath(source: string): string {
  const clean = stripSourceScheme(source)
    .split(path.sep)
    .join("/")
    .replace(/^\//, "");
  // Turbopack names project files `turbopack:///[project]/<root-relative>`.
  return clean.startsWith("[project]/") ? clean.slice("[project]/".length) : clean;
}

function resolveOriginalPath(
  source: string,
  rawMap: RawSourceMap,
  sourcePath: string | null,
  rootDir: string,
): string {
  const clean = stripSourceScheme(source);
  if (clean.startsWith("/[project]/")) {
    return path.resolve(rootDir, clean.slice("/[project]/".length));
  }
  if (path.isAbsolute(clean)) return path.normalize(clean);
  const base = sourcePath !== null ? path.dirname(sourcePath) : rootDir;
  const fromGenerated = path.resolve(base, rawMap.sourceRoot ?? "", clean);
  if (existsSync(fromGenerated)) return fromGenerated;
  const fromRoot = path.resolve(rootDir, clean);
  return existsSync(fromRoot) ? fromRoot : fromGenerated;
}

function sourcesContentFor(rawMap: RawSourceMap, source: string): string | null {
  const index = rawMap.sources?.indexOf(source) ?? -1;
  if (index < 0) return null;
  return rawMap.sourcesContent?.[index] ?? null;
}

function readIfExists(file: string | null): string | null {
  if (file === null) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** POSIX path of `absFile` relative to `root`, or null when outside it. */
export function relativePosix(root: string, absFile: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(absFile));
  if (rel === "" || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join("/");
  return posix.startsWith("../") ? null : posix;
}

class LineTable {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === "\n") this.starts.push(i + 1);
    }
  }
  /** 1-based line, 0-based column for a character offset. */
  positionFor(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((this.starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (this.starts[lo] ?? 0) };
  }
  offsetFor(line: number, column: number): number {
    return (this.starts[line - 1] ?? this.starts[this.starts.length - 1] ?? 0) + column;
  }
}
