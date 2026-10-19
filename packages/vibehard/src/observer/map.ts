import type { SymbolId, SymbolRecord } from "../index.js";
import { findEnclosingSymbol } from "../indexer/index.js";
import { remapScript } from "./remap.js";
import type {
  CoverageOrigin,
  ObservedRange,
  ObservedSetResult,
  ObserveScriptsOptions,
  ScriptInput,
} from "./types.js";

export interface MapResult {
  byOrigin: Record<CoverageOrigin, SymbolId[]>;
  merged: SymbolId[];
  /**
   * Executed ranges in a known app file outside every named symbol,
   * attributed to that file's `module` symbol instead of being dropped.
   */
  moduleFallbackRanges: number;
  /** Ranges dropped entirely (reversed range, or file with no symbols). */
  ignoredRanges: number;
}

/**
 * Map original-source ranges to symbols: exact containment first, then
 * containment of the range start (source-map segments can place a function
 * range a segment early). Anonymous callbacks attribute to their enclosing
 * named symbol through the same lookup. A range in a known app file that
 * no named symbol contains (computed methods, namespace bodies, top-level
 * anonymous handlers) attributes to the file's `module` symbol: failing
 * safe at file precision beats silently skipping affected tests. The
 * fallback lives here, not in `findEnclosingSymbol`, because remap host
 * detection depends on the finder's null-outside answer.
 */
export function mapRangesToSymbols(
  ranges: readonly ObservedRange[],
  symbols: readonly SymbolRecord[],
): MapResult {
  const moduleByFile = new Map<string, SymbolRecord>();
  for (const symbol of symbols) {
    if (symbol.kind === "module") moduleByFile.set(symbol.file, symbol);
  }
  const sets: Record<CoverageOrigin, Set<SymbolId>> = {
    client: new Set(),
    server: new Set(),
  };
  let ignoredRanges = 0;
  let moduleFallbackRanges = 0;
  for (const range of ranges) {
    if (range.endOffset < range.startOffset) {
      ignoredRanges += 1;
      continue;
    }
    const symbol =
      findEnclosingSymbol(symbols, range.file, range.startOffset, range.endOffset) ??
      findEnclosingSymbol(symbols, range.file, range.startOffset, range.startOffset + 1);
    if (symbol !== null) {
      sets[range.origin].add(symbol.id);
      continue;
    }
    const moduleSymbol = moduleByFile.get(range.file);
    if (moduleSymbol !== undefined) {
      sets[range.origin].add(moduleSymbol.id);
      moduleFallbackRanges += 1;
    } else {
      ignoredRanges += 1;
    }
  }
  const client = [...sets.client].sort();
  const server = [...sets.server].sort();
  return {
    byOrigin: { client, server },
    merged: [...new Set([...client, ...server])].sort(),
    moduleFallbackRanges,
    ignoredRanges,
  };
}

/** Full Stage 2 pipeline: remap every script, then map ranges to symbols. */
export function observeScripts(
  scripts: readonly ScriptInput[],
  options: ObserveScriptsOptions,
): ObservedSetResult {
  const ranges: ObservedRange[] = [];
  const unmappable: ObservedSetResult["unmappable"] = [];
  const diagnostics: string[] = [];
  for (const script of scripts) {
    const result = remapScript(script, options);
    ranges.push(...result.ranges);
    diagnostics.push(...result.diagnostics);
    if (result.unmappable !== null) unmappable.push(result.unmappable);
  }
  const mapped = mapRangesToSymbols(ranges, options.symbols);
  if (mapped.moduleFallbackRanges > 0) {
    diagnostics.push(
      `attributed ${mapped.moduleFallbackRanges} executed range(s) outside every named symbol to the file module symbol`,
    );
  }
  if (mapped.ignoredRanges > 0) {
    diagnostics.push(
      `ignored ${mapped.ignoredRanges} executed range(s) in files with no indexed symbols`,
    );
  }
  return {
    ok: unmappable.length === 0,
    client: mapped.byOrigin.client,
    server: mapped.byOrigin.server,
    merged: mapped.merged,
    ranges,
    unmappable,
    diagnostics: [...new Set(diagnostics)],
  };
}

/** Union two observed-set results (e.g. one per labeled server process). */
export function mergeObservedSets(
  a: ObservedSetResult,
  b: ObservedSetResult,
): ObservedSetResult {
  const merge = (x: SymbolId[], y: SymbolId[]): SymbolId[] =>
    [...new Set([...x, ...y])].sort();
  return {
    ok: a.ok && b.ok,
    client: merge(a.client, b.client),
    server: merge(a.server, b.server),
    merged: merge(a.merged, b.merged),
    ranges: [...a.ranges, ...b.ranges],
    unmappable: [...a.unmappable, ...b.unmappable],
    diagnostics: [...new Set([...a.diagnostics, ...b.diagnostics])],
  };
}
