import type { SymbolId } from "../index.js";
import type { UnmappableScript } from "../observer/index.js";

/** Declaration options written next to a test (manifest: Declaration API). */
export interface VibehardTestOptions {
  uses: SymbolId[];
  allowTransitive?: string[];
  skipVerify?: string;
}

/** Declaration as transported at runtime; `uses: null` means undeclared. */
export interface RuntimeDeclaration {
  uses: SymbolId[] | null;
  allowTransitive: string[];
  skipVerify: string | null;
}

export type TestVerifyStatus =
  | "pass"
  | "mismatch"
  | "test-failed"
  | "skipped-verify"
  | "unmappable"
  | "no-declaration"
  | "recorded"
  | "record-error"
  | "error";

export interface TestVerifyResult {
  testId: string;
  /** POSIX path of the test file relative to the project root. */
  file: string;
  title: string;
  titlePath: string[];
  status: TestVerifyStatus;
  /** Normalized declared set, or null when the test declares nothing. */
  declared: SymbolId[] | null;
  observed: SymbolId[];
  /** Declared but not observed (includes unknown symbol IDs). */
  missing: SymbolId[];
  /** Observed but not declared (excluding allowTransitive matches). */
  extra: SymbolId[];
  /** Observed, undeclared, but permitted by `allowTransitive`. */
  allowed: SymbolId[];
  /** Declared IDs with no matching indexed symbol. */
  unknown: SymbolId[];
  unmappable: UnmappableScript[];
  diagnostics: string[];
  skipVerify: string | null;
  /** Record mode: true when the test file was rewritten. */
  changed?: boolean;
}

export interface ProjectVerifyResult {
  ok: boolean;
  mode: "verify" | "record";
  ci: boolean;
  /** 0 pass, 1 test failure, 2 verification mismatch / drift. */
  exitCode: 0 | 1 | 2;
  rootDir: string;
  results: TestVerifyResult[];
  lockfile: { path: string; written: boolean; drift: string[] };
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipVerifyCount: number;
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
