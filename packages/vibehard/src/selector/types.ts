import type { SymbolId } from "../index.js";

/** Why one test was selected (manifest: `--dry-run` selection reasons). */
export type SelectionReason =
  | { type: "changed-symbol"; symbol: SymbolId }
  | { type: "skip-verify"; reason: string }
  | { type: "unverified" }
  | { type: "test-file-changed"; file: string };

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
}

export interface SelectOptions {
  rootDir: string;
  configPath?: string;
  /** Explicit base ref; defaults to merge-base with `baseBranch`, else HEAD. */
  baseRef?: string;
}

export interface TestProjectOptions extends SelectOptions {
  /** Skip selection and run the full suite. */
  all?: boolean;
  /** Report the selection without running anything. */
  dryRun?: boolean;
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
    playwrightExitCode: number | null;
  } | null;
  /** Captured framework output when a run happened. */
  output: { stdout: string; stderr: string } | null;
  diagnostics: string[];
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
  declared: SymbolId[];
  allowedObserved: SymbolId[];
  /** Declared ∪ allowedObserved: the set observed at last verify. */
  lastObserved: SymbolId[];
  skipVerify: string | null;
  symbols: ExplainSymbolStatus[];
  /** Symbol queries only: how this test relates to the queried symbol. */
  via?: "declared" | "allowed";
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
}
