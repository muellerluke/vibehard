import type { SymbolId } from "../index.js";
import type { UnmappableScript } from "../observer/index.js";
import type { PhaseTiming } from "../timing.js";
import type { TouchedSet } from "./touched.js";

/** Options written next to a test. The only escape hatch is `alwaysRun`. */
export interface VibehardTestOptions {
  /** Reason this test always runs under `vibehard test` and is not recorded. */
  alwaysRun?: string;
}

/** Options as transported at runtime. */
export interface RuntimeOptions {
  alwaysRun: string | null;
}

export type TestVerifyStatus =
  | "pass"
  | "drift"
  | "test-failed"
  | "always-run"
  | "unmappable"
  | "recorded"
  | "unstable"
  | "error";

/** Per-test observation timings; present only when timing was requested. */
export interface TestTiming {
  observationCount: number;
  /** Subphase totals aggregated across this test's observations. */
  phases: PhaseTiming[];
  /** Raw per-observation phase lists, in observation order. */
  observations: PhaseTiming[][];
}

export interface TestVerifyResult {
  testId: string;
  /** POSIX path of the test file relative to the project root. */
  file: string;
  title: string;
  titlePath: string[];
  status: TestVerifyStatus;
  /** Directly observed symbol IDs (coverage seeds). */
  observed: SymbolId[];
  /** Full touched set computed from the observation, or null. */
  touched: TouchedSet | null;
  /** Verify mode: touched now but not in the lockfile. */
  added: SymbolId[];
  /** Verify mode: in the lockfile but not touched now. */
  removed: SymbolId[];
  /** Record mode: symbols whose presence differed between the two runs. */
  unstableSymbols: SymbolId[];
  unmappable: UnmappableScript[];
  diagnostics: string[];
  alwaysRun: string | null;
  /** Observation timings; present only when timing was requested. */
  timing?: TestTiming;
}

/** One shard of a sharded run: shard `index` of `total` (1-based). */
export interface ShardSpec {
  index: number;
  total: number;
}

export interface ProjectVerifyResult {
  ok: boolean;
  mode: "verify" | "record";
  /** Observation lanes that were allowed to run concurrently. */
  jobs: number;
  /** Shard this run covered, or null for an unsharded run. */
  shard: ShardSpec | null;
  /** Shard artifact written instead of the lockfile (record --shard). */
  shardArtifact: string | null;
  /** True when the run re-recorded only the change-selected subset. */
  incremental: boolean;
  ci: boolean;
  /** 0 pass, 1 test failure, 2 drift / instability / lockfile drift. */
  exitCode: 0 | 1 | 2;
  rootDir: string;
  results: TestVerifyResult[];
  lockfile: { path: string; written: boolean; drift: string[] };
  summary: {
    total: number;
    passed: number;
    failed: number;
    alwaysRunCount: number;
  };
  diagnostics: string[];
  /** Phase timings; present only when timing was requested. */
  timing?: PhaseTiming[];
}

/** Options for `mergeShardArtifacts` (`record --merge`). */
export interface MergeShardsOptions {
  rootDir: string;
  configPath?: string;
  /** Shard artifact paths (relative paths resolve against `rootDir`). */
  files: readonly string[];
}

export interface MergeShardsResult {
  ok: boolean;
  exitCode: 0;
  rootDir: string;
  /** Number of shard artifacts merged (`i` in `1..shards`). */
  shards: number;
  /** Number of test entries written into the lockfile. */
  tests: number;
  lockfile: { path: string; written: boolean };
  diagnostics: string[];
}

export interface VerifyProjectOptions {
  rootDir: string;
  configPath?: string;
  /** Substring filters matched against test file or title; OR-ed. */
  filter?: string[];
  ci?: boolean;
  /**
   * Observation lanes running concurrently (record/verify). Each lane
   * starts its own servers and framework processes, exactly like a
   * serial run, so results are unchanged; the app under test must
   * tolerate that many parallel instances. Defaults to 1.
   */
  jobs?: number;
  /**
   * Observe only this shard of the discovered tests (stable hash of
   * test ID). A record shard writes a shard artifact (`shardOut`)
   * instead of touching the lockfile; see `mergeShardArtifacts`.
   */
  shard?: ShardSpec;
  /** Path for the shard artifact a `record --shard` run writes. */
  shardOut?: string;
  /**
   * Record mode only: re-record only the tests selected by the
   * current change set (plus unrecorded and spec-changed tests).
   * Refuses when selection is unsafe; pair with periodic full
   * `verify` runs. Defaults to false.
   */
  incremental?: boolean;
  /** Base ref for `incremental` selection; defaults like `test`. */
  baseRef?: string;
  /** Use diff-proportional selection for `incremental`. */
  fastSelect?: boolean;
  /** Collect phase timings into the result. Defaults to `VIBEHARD_PROFILE`. */
  timing?: boolean;
}

/** Usage/config errors: the CLI maps these to exit code 3. */
export class VibehardUsageError extends Error {
  readonly exitCode = 3 as const;
  constructor(message: string) {
    super(message);
    this.name = "VibehardUsageError";
  }
}
