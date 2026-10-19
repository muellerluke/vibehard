import type { ResolvedConfig, VibehardConfig } from "./config.js";
import { cypressDriver } from "./cypress-runner.js";
import type { ListedTest, RunnableTestRef } from "./listed.js";
import { playwrightDriver } from "./playwright-runner.js";
import { puppeteerDriver } from "./puppeteer-runner.js";
import type { SpawnCaptureResult } from "./servers.js";

export type FrameworkName = VibehardConfig["framework"];

/**
 * Everything framework-specific the verifier/selector need: test
 * discovery, one-test observation runs, plain (selected/full) runs, and
 * the installed framework version recorded in the lockfile. Server
 * startup, coverage mapping, diffing, and selection math stay shared.
 */
export interface FrameworkDriver {
  name: FrameworkName;
  /** Diagnostic suffix when a run wrote no vibehard artifact. */
  missingArtifactHint: string;
  version(rootDir: string): string;
  listTests(rootDir: string, resolved: ResolvedConfig): Promise<ListedTest[]>;
  runSingleTest(input: {
    rootDir: string;
    resolved: ResolvedConfig;
    test: ListedTest;
    env: Record<string, string>;
  }): Promise<SpawnCaptureResult>;
  /** Plain run without observation; `tests: null` means the full suite. */
  runMany(input: {
    rootDir: string;
    resolved: ResolvedConfig;
    tests: readonly RunnableTestRef[] | null;
    env: Record<string, string>;
  }): Promise<SpawnCaptureResult>;
  /**
   * Prove the delegation filter resolves to exactly the selected tests.
   * Returns a problem description, or null when proven. Frameworks whose
   * runMany filter is exact by construction omit this.
   */
  proveFilter?(input: {
    rootDir: string;
    resolved: ResolvedConfig;
    tests: readonly RunnableTestRef[];
  }): Promise<string | null>;
}

export function getFrameworkDriver(framework: FrameworkName): FrameworkDriver {
  switch (framework) {
    case "playwright":
      return playwrightDriver;
    case "puppeteer":
      return puppeteerDriver;
    case "cypress":
      return cypressDriver;
  }
}
