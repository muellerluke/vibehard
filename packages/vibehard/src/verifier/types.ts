import type { SymbolId } from "../index.js";
import type { UnmappableScript } from "../observer/index.js";
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
}

export interface ProjectVerifyResult {
  ok: boolean;
  mode: "verify" | "record";
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
}

export interface VerifyProjectOptions {
  rootDir: string;
  configPath?: string;
  /** Substring filters matched against test file or title; OR-ed. */
  filter?: string[];
  ci?: boolean;
}

/** Usage/config errors: the CLI maps these to exit code 3. */
export class VibehardUsageError extends Error {
  readonly exitCode = 3 as const;
  constructor(message: string) {
    super(message);
    this.name = "VibehardUsageError";
  }
}
