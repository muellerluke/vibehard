import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CoverageOrigin,
  ScriptInput,
  V8CoverageRange,
  V8ScriptCoverage,
} from "./types.js";

/**
 * Evidence that one function ran: its outermost range (`ranges[0]`) when it
 * was invoked at least once. Block sub-ranges only refine branches inside a
 * function, so they add no symbol-level information. The synthetic
 * whole-script function (anonymous, starting at 0, widest range) proves
 * import, not symbol execution, and is dropped.
 */
export function executedFunctionRanges(
  script: V8ScriptCoverage,
): V8CoverageRange[] {
  const outermost = script.functions
    .map((fn) => fn.ranges[0])
    .filter((r): r is V8CoverageRange => r !== undefined);
  let scriptRange: V8CoverageRange | null = null;
  for (const fn of script.functions) {
    const range = fn.ranges[0];
    if (range === undefined || fn.functionName !== "") continue;
    if (range.startOffset !== 0) continue;
    if (scriptRange === null || range.endOffset > scriptRange.endOffset) {
      scriptRange = range;
    }
  }
  return outermost.filter((r) => r !== scriptRange && r.count > 0);
}

export interface NodeCoverageDirResult {
  scripts: V8ScriptCoverage[];
  /** Source maps Node cached while running, keyed by script URL. */
  sourceMaps: Map<string, unknown>;
}

/** Parse every `coverage-*.json` file Node wrote into `dir`. */
export function parseNodeCoverageDir(dir: string): NodeCoverageDirResult {
  const scripts: V8ScriptCoverage[] = [];
  const sourceMaps = new Map<string, unknown>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { scripts, sourceMaps };
  }
  for (const name of entries.sort()) {
    if (!name.startsWith("coverage") || !name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue; // a process may still be writing; the caller stops it first
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record["result"])) {
      for (const entry of record["result"]) {
        if (isScriptCoverage(entry)) scripts.push(entry);
      }
    }
    const cache = record["source-map-cache"];
    if (typeof cache === "object" && cache !== null) {
      for (const [url, value] of Object.entries(cache)) {
        const data = (value as { data?: unknown } | null)?.data;
        if (data !== undefined && data !== null) sourceMaps.set(url, data);
      }
    }
  }
  return { scripts, sourceMaps };
}

function isScriptCoverage(value: unknown): value is V8ScriptCoverage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["url"] === "string" && Array.isArray(record["functions"]);
}

/** Turn parsed Node coverage into server-origin script inputs. */
export function nodeScriptsToInputs(
  coverage: NodeCoverageDirResult,
  origin: CoverageOrigin = "server",
): ScriptInput[] {
  return coverage.scripts.map((script) => ({
    url: script.url,
    origin,
    functions: script.functions,
    sourcePath: scriptUrlToPath(script.url),
    sourceMap: coverage.sourceMaps.get(script.url) ?? null,
  }));
}

/** Absolute filesystem path for `file://` script URLs, else null. */
export function scriptUrlToPath(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}
