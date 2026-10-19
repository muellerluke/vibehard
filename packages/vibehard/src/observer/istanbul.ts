import { readFileSync } from "node:fs";
import path from "node:path";

import type { SymbolRecord } from "../index.js";
import { mapRangesToSymbols } from "./map.js";
import type { ObservedRange, ObservedSetResult } from "./types.js";

interface IstanbulLoc {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

interface IstanbulFileCoverage {
  path?: string;
  statementMap?: Record<string, IstanbulLoc>;
  fnMap?: Record<string, { loc?: IstanbulLoc; decl?: IstanbulLoc }>;
  branchMap?: Record<string, { loc?: IstanbulLoc; locations?: IstanbulLoc[] }>;
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
}

/** Istanbul `window.__coverage__` shape: file path → per-file coverage. */
export type IstanbulCoverage = Record<string, IstanbulFileCoverage>;

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function toOffset(starts: readonly number[], text: string, pos: { line: number; column: number }): number {
  const lineIdx = Math.max(0, Math.min(pos.line - 1, starts.length - 1));
  return Math.min((starts[lineIdx] ?? 0) + Math.max(0, pos.column), text.length);
}

/**
 * Convert an Istanbul coverage object (Cypress path) into an observed
 * set. Istanbul locations are already in original-source coordinates,
 * so no source-map remap is needed: executed (`count > 0`) statement,
 * function, and branch locations become ranges in the original files
 * and map to symbols by the same containment rule as V8 ranges.
 * Files under `node_modules` or outside the root are built-in
 * exclusions; a file inside the root that cannot be read is
 * unmappable (fail closed).
 */
export function observeIstanbul(
  coverage: IstanbulCoverage | null | undefined,
  options: { rootDir: string; symbols: readonly SymbolRecord[] },
): ObservedSetResult {
  const diagnostics: string[] = [];
  const unmappable: ObservedSetResult["unmappable"] = [];
  const ranges: ObservedRange[] = [];
  if (coverage === null || coverage === undefined) {
    unmappable.push({
      url: "window.__coverage__",
      origin: "client",
      reason: "no Istanbul coverage object was captured for this test (is the app build instrumented?)",
    });
    return { ok: false, client: [], server: [], merged: [], ranges, unmappable, diagnostics };
  }
  // An empty object means the test never visited an app page (e.g. an
  // API-only `cy.request` test): no client execution is expected, the
  // same as an empty browser-coverage list on the V8 path.
  const root = path.resolve(options.rootDir);
  for (const [key, fileCov] of Object.entries(coverage)) {
    const rawPath = typeof fileCov.path === "string" && fileCov.path !== "" ? fileCov.path : key;
    const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel.startsWith("../") || rel === ".." || rel.includes("/node_modules/") || rel.startsWith("node_modules/")) {
      diagnostics.push(`excluded script: istanbul:${rawPath}`);
      continue;
    }
    let text: string;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      unmappable.push({
        url: `istanbul:${rawPath}`,
        origin: "client",
        reason: "instrumented file is not readable under the project root",
      });
      continue;
    }
    const starts = lineStarts(text);
    const push = (loc: IstanbulLoc | undefined): void => {
      if (loc === undefined) return;
      const startOffset = toOffset(starts, text, loc.start);
      const endOffset = Math.max(startOffset, toOffset(starts, text, loc.end));
      ranges.push({ file: rel, startOffset, endOffset, origin: "client" });
    };
    for (const [id, loc] of Object.entries(fileCov.statementMap ?? {})) {
      if ((fileCov.s?.[id] ?? 0) > 0) push(loc);
    }
    for (const [id, fn] of Object.entries(fileCov.fnMap ?? {})) {
      if ((fileCov.f?.[id] ?? 0) > 0) push(fn.loc ?? fn.decl);
    }
    for (const [id, branch] of Object.entries(fileCov.branchMap ?? {})) {
      const counts = fileCov.b?.[id] ?? [];
      (branch.locations ?? []).forEach((loc, i) => {
        if ((counts[i] ?? 0) > 0) push(loc);
      });
      if (branch.locations === undefined && counts.some((c) => c > 0)) push(branch.loc);
    }
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
