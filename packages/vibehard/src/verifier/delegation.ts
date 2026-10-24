import type { RunnableTestRef } from "./listed.js";
import { VibehardUsageError } from "./types.js";

/**
 * Byte budget for one delegated framework invocation's variable
 * arguments. The tightest platform ceiling is the Windows
 * `CreateProcessW` limit of 32,767 characters for the whole command
 * line (executable, fixed args, and terminator included); 24 KiB
 * leaves headroom for the fixed prefix on every platform. This is a
 * code constant, deliberately not a config field: config feeds
 * `configHash`, and a delegation detail must not invalidate lockfiles.
 */
export const ARGV_BUDGET_BYTES = 24 * 1024;

/** Timeout for one delegated chunk invocation (per chunk, not per run). */
export const DELEGATED_RUN_TIMEOUT_MS = 1_800_000;

/** Bytes a spawning mode retains per stream when bounding output. */
export const OUTPUT_TAIL_BYTES = 64 * 1024;

/** How a plain delegated run's output is handled (observation always captures). */
export type RunOutputMode = "capture" | "stream" | "tail";

/** Conservative argv cost: UTF-8 bytes plus one separator byte per arg. */
export function argvBytes(args: readonly string[]): number {
  let total = 0;
  for (const a of args) total += Buffer.byteLength(a, "utf8") + 1;
  return total;
}

export interface RunnableFileGroup {
  file: string;
  tests: RunnableTestRef[];
  /** True only when `discovered` proves every test in the file is selected. */
  fullySelected: boolean;
}

function byFileLineId(a: RunnableTestRef, b: RunnableTestRef): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0;
}

/**
 * Selected tests grouped by file, files and tests in deterministic
 * order. A group is `fullySelected` only when the discovered set is
 * known and every discovered test in that file is among the selected
 * ones; without a discovered set nothing is ever claimed whole-file.
 */
export function groupRunnableByFile(
  tests: readonly RunnableTestRef[],
  discovered?: readonly RunnableTestRef[],
): RunnableFileGroup[] {
  const selectedIds = new Set(tests.map((t) => t.testId));
  const discoveredByFile = new Map<string, string[]>();
  if (discovered !== undefined) {
    for (const d of discovered) {
      const list = discoveredByFile.get(d.file) ?? [];
      list.push(d.testId);
      discoveredByFile.set(d.file, list);
    }
  }
  const byFile = new Map<string, RunnableTestRef[]>();
  for (const t of tests) {
    const list = byFile.get(t.file) ?? [];
    list.push(t);
    byFile.set(t.file, list);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, fileTests]) => {
      const all = discoveredByFile.get(file);
      return {
        file,
        tests: [...fileTests].sort(byFileLineId),
        fullySelected:
          all !== undefined && all.length > 0 && all.every((id) => selectedIds.has(id)),
      };
    });
}

/**
 * Greedily pack units into chunks whose `costOf(chunk)` stays within
 * `budgetBytes`, preserving order. A single unit that exceeds the
 * budget on its own is a usage error: truncating an argument would
 * delegate a different test set than the one proven, so delegation
 * fails closed instead.
 */
export function packChunks<T>(
  units: readonly T[],
  budgetBytes: number,
  costOf: (chunk: readonly T[]) => number,
  labelOf?: (unit: T) => string,
): T[][] {
  if (!Number.isInteger(budgetBytes) || budgetBytes < 1) {
    throw new VibehardUsageError(`vibehard: argv budget must be a positive integer (got ${budgetBytes})`);
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  for (const unit of units) {
    if (costOf([unit]) > budgetBytes) {
      const label = labelOf?.(unit);
      throw new VibehardUsageError(
        `vibehard: a single delegated test exceeds the argv budget of ${budgetBytes} bytes${label !== undefined ? ` (${label})` : ""}; refusing to truncate its arguments`,
      );
    }
    if (current.length > 0 && costOf([...current, unit]) > budgetBytes) {
      chunks.push(current);
      current = [];
    }
    current.push(unit);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
