import type { SymbolId } from "../index.js";
import type { PhaseTiming } from "../timing.js";
import type { TouchKind, TouchedSet } from "../verifier/touched.js";

/** Why one test was selected (`--dry-run` selection reasons). */
export type SelectionReason =
  | { type: "changed-symbol"; symbol: SymbolId; via: TouchKind }
  | { type: "always-run"; reason: string }
  | { type: "unrecorded" }
  | { type: "test-file-changed"; file: string }
  | { type: "test-support-changed"; file: string };

export interface DiscoveredTestRef {
  testId: string;
  /** POSIX path of the test file relative to the project root. */
  file: string;
  line: number;
  title: string;
  titlePath: string[];
}

export interface SelectedTest extends DiscoveredTestRef {
  reasons: SelectionReason[];
}

export interface ResolvedBase {
  /** The ref as given or derived (e.g. "HEAD", "main", a sha). */
  ref: string;
  /** Full commit sha the working tree is compared against. */
  sha: string;
  description: string;
}

export interface SelectionResult {
  base: ResolvedBase;
  /** POSIX project-relative paths changed against the base. */
  changedFiles: string[];
  /** Symbol IDs whose source changed (edited, added, or deleted). */
  changedSymbols: SymbolId[];
  /** Every discovered test, selected or not. */
  discovered: DiscoveredTestRef[];
  selected: SelectedTest[];
  /** Non-empty means selection could not be proven safe: run everything. */
  unsafeReasons: string[];
  /** First unsafe reason, or null when selection is safe. */
  unsafeReason: string | null;
  diagnostics: string[];
  /** Phase timings; present only when timing was requested. */
  timing?: PhaseTiming[];
}

export interface SelectOptions {
  rootDir: string;
  configPath?: string;
  /** Explicit base ref; defaults to merge-base with `baseBranch`, else HEAD. */
  baseRef?: string;
  /** Collect phase timings into the result. Defaults to `VIBEHARD_PROFILE`. */
  timing?: boolean;
  /**
   * Use the diff-proportional fast selection path (parse-only, no
   * TypeScript Program, no base worktree). Defaults to
   * `VIBEHARD_FAST_SELECT`. Any fast-path failure falls back to the
   * full-index algorithm with a diagnostic.
   */
  fastSelect?: boolean;
}

export interface TestProjectOptions extends SelectOptions {
  /** Skip selection and run the full suite. */
  all?: boolean;
  /** Report the selection without running anything. */
  dryRun?: boolean;
  /**
   * Delegated-run output handling: `capture` (default, whole output in
   * the result), `stream` (echo live, retain a bounded tail), or
   * `tail` (retain only a bounded tail, no echo).
   */
  output?: "capture" | "stream" | "tail";
  /** Per-invocation argv byte budget for delegation (default 24 KiB). */
  argvBudgetBytes?: number;
}

export interface TestProjectResult {
  ok: boolean;
  /** 0 pass/none, 1 framework test failure, 3 unsafe under --dry-run. */
  exitCode: 0 | 1 | 3;
  dryRun: boolean;
  all: boolean;
  rootDir: string;
  /** Null only for a non-dry `--all` run (selection never computed). */
  selection: SelectionResult | null;
  ran: {
    mode: "selected" | "full" | "none";
    testIds: string[];
    /** Exit code of the delegated framework run, or null when none ran. */
    frameworkExitCode: number | null;
    /** @deprecated Alias of `frameworkExitCode` kept for JSON compatibility. */
    playwrightExitCode: number | null;
  } | null;
  /** Captured (or bounded-tail) framework output when a run happened. */
  output: {
    stdout: string;
    stderr: string;
    truncated?: boolean;
    streamed?: boolean;
    chunks?: number;
  } | null;
  diagnostics: string[];
  /** Phase timings; present only when timing was requested. */
  timing?: PhaseTiming[];
}

export interface ExplainSymbolStatus {
  id: SymbolId;
  /** fresh: lockfile hash matches current source; stale: differs. */
  status: "fresh" | "stale" | "missing" | "unknown";
}

export interface ExplainTestEntry {
  testId: string;
  file: string;
  titlePath: string[];
  inLockfile: boolean;
  /** Recorded touched set (symbol ID -> touch kind). */
  touched: TouchedSet;
  alwaysRun: string | null;
  symbols: ExplainSymbolStatus[];
  /** Symbol queries only: how this test touched the queried symbol. */
  via?: TouchKind;
}

export interface ExplainResult {
  query: string;
  kind: "symbol" | "test";
  rootDir: string;
  /** Symbol queries: the indexed record, or null when deleted/unknown. */
  symbol: {
    id: SymbolId;
    file: string;
    qualifiedName: string;
    kind: string;
    startLine: number;
    endLine: number;
  } | null;
  tests: ExplainTestEntry[];
  diagnostics: string[];
}

export interface ExplainOptions {
  rootDir: string;
  configPath?: string;
  query: string;
  /** Parse only the files the query needs. Defaults to `VIBEHARD_FAST_SELECT`. */
  fastSelect?: boolean;
}
