import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { ResolvedConfig } from "./config.js";
import {
  ARGV_BUDGET_BYTES,
  DELEGATED_RUN_TIMEOUT_MS,
  OUTPUT_TAIL_BYTES,
  argvBytes,
  groupRunnableByFile,
  packChunks,
  type RunOutputMode,
} from "./delegation.js";
import { discoverStaticTests } from "./discovery.js";
import type { FrameworkDriver } from "./driver.js";
import { frameworkVersion } from "./lockfile.js";
import type { ListedTest, RunnableTestRef } from "./listed.js";
import { mergeSpawnResults, spawnDelegated, type SpawnCaptureResult } from "./servers.js";
import { VibehardUsageError } from "./types.js";

/** Env var (Cypress.env) carrying base64url JSON: titlePaths to run. */
export const ENV_ONLY_TITLES = "VIBEHARD_ONLY";

export function encodeOnlyTitles(titlePaths: readonly (readonly string[])[]): string {
  return Buffer.from(JSON.stringify(titlePaths), "utf8").toString("base64url");
}

/** Resolve the project's Cypress CLI entry script. */
export function resolveCypressCli(rootDir: string): string {
  const req = createRequire(path.join(path.resolve(rootDir), "package.json"));
  try {
    const pkgPath = req.resolve("cypress/package.json");
    const bin = path.join(path.dirname(pkgPath), "bin", "cypress");
    if (existsSync(bin)) return bin;
  } catch {
    // fall through to .bin
  }
  const bin = path.join(path.resolve(rootDir), "node_modules", ".bin", "cypress");
  if (existsSync(bin)) return bin;
  throw new VibehardUsageError(
    `vibehard: cannot find Cypress in ${rootDir} (install cypress in the project)`,
  );
}

async function listCypressTests(
  rootDir: string,
  resolved: ResolvedConfig,
): Promise<ListedTest[]> {
  return discoverStaticTests(rootDir, resolved, {
    defaults: ["cypress/e2e", "e2e"],
    isSpec: (rel) => /\.cy\.[^.]+$/.test(rel),
    frameworkLabel: "cypress",
    discovery: {
      specifier: "vibehard/cypress",
      imports: [],
      globals: { test: ["it", "test"], describe: ["describe", "context"] },
      requireImport: false,
    },
  });
}

/** One delegated Cypress invocation's worth of selected tests. */
export interface CypressChunk {
  tests: RunnableTestRef[];
  specs: string[];
  /** Title filter for this chunk, or null when every spec runs whole. */
  onlyTitles: string[][] | null;
}

function cypressChunkCost(
  tests: readonly RunnableTestRef[],
  onlyTitles: readonly (readonly string[])[] | null,
  fixedBytes: number,
): number {
  const specs = [...new Set(tests.map((t) => t.file))].sort();
  const args = ["--spec", specs.join(",")];
  if (onlyTitles !== null) args.push("--env", `${ENV_ONLY_TITLES}=${encodeOnlyTitles(onlyTitles)}`);
  return fixedBytes + argvBytes(args);
}

/**
 * Plan delegated Cypress invocations under an argv byte budget. The
 * `VIBEHARD_ONLY` filter matches title paths across every spec in the
 * invocation, so fully selected specs are chunked separately with no
 * title filter, and partial specs are packed test-by-test counting
 * both the `--spec` list and the encoded title payload. A spec's
 * tests may split across chunks; the spec simply runs again.
 */
export function planCypressChunks(
  tests: readonly RunnableTestRef[],
  discovered?: readonly RunnableTestRef[],
  budgetBytes: number = ARGV_BUDGET_BYTES,
  fixedBytes = 0,
): CypressChunk[] {
  const groups = groupRunnableByFile(tests, discovered);
  const chunks: CypressChunk[] = [];

  const fullGroups = groups.filter((g) => g.fullySelected);
  const fullUnits = fullGroups.map((g) => ({ tests: g.tests, spec: g.file }));
  for (const packed of packChunks(
    fullUnits,
    budgetBytes,
    (chunk) => cypressChunkCost(chunk.flatMap((u) => u.tests), null, fixedBytes),
    (u) => u.spec,
  )) {
    chunks.push({
      tests: packed.flatMap((u) => u.tests),
      specs: packed.map((u) => u.spec),
      onlyTitles: null,
    });
  }

  const partialTests = groups.filter((g) => !g.fullySelected).flatMap((g) => g.tests);
  for (const packed of packChunks(
    partialTests,
    budgetBytes,
    (chunk) => cypressChunkCost(chunk, chunk.map((t) => t.titlePath), fixedBytes),
    (t) => t.testId,
  )) {
    chunks.push({
      tests: [...packed],
      specs: [...new Set(packed.map((t) => t.file))].sort(),
      onlyTitles: packed.map((t) => [...t.titlePath]),
    });
  }
  return chunks;
}

async function runCypress(input: {
  rootDir: string;
  resolved: ResolvedConfig;
  specs: readonly string[];
  onlyTitles: readonly (readonly string[])[] | null;
  env: Record<string, string>;
  timeoutMs: number;
  output?: RunOutputMode;
}): Promise<SpawnCaptureResult> {
  const cli = resolveCypressCli(input.rootDir);
  const args = [cli, "run", "--spec", input.specs.join(",")];
  const cfg = input.resolved.config.cypress;
  if (cfg?.config !== undefined) args.push("--config-file", cfg.config);
  if (cfg?.browser !== undefined) args.push("--browser", cfg.browser);
  const env: Record<string, string> = { ...input.env };
  if (input.onlyTitles !== null) {
    args.push("--env", `${ENV_ONLY_TITLES}=${encodeOnlyTitles(input.onlyTitles)}`);
  }
  return spawnDelegated(process.execPath, args, {
    cwd: input.rootDir,
    env,
    timeoutMs: input.timeoutMs,
    output: input.output ?? "capture",
    tailBytes: OUTPUT_TAIL_BYTES,
  });
}

/** Cypress framework driver (instrumented-coverage path). */
export const cypressDriver: FrameworkDriver = {
  name: "cypress",
  missingArtifactHint:
    "is 'vibehard/cypress' registered in the support file and registerVibehardTasks wired in cypress.config?",
  version: (rootDir) => frameworkVersion(rootDir, "cypress"),
  listTests: listCypressTests,
  runSingleTest: ({ rootDir, resolved, test, env }) =>
    runCypress({
      rootDir,
      resolved,
      specs: [test.relFile],
      onlyTitles: [test.titlePath],
      env,
      timeoutMs: 600_000,
    }),
  runMany: async ({ rootDir, resolved, tests, env, discovered, argvBudgetBytes, output }) => {
    if (tests === null) {
      const all = await listCypressTests(rootDir, resolved);
      const specs = [...new Set(all.map((t) => t.relFile))].sort();
      // A full run still delegates in chunks when its spec list alone
      // would exceed the budget: chunk over the specs, no title filter.
      const chunks = packChunks(
        specs,
        argvBudgetBytes ?? ARGV_BUDGET_BYTES,
        (chunk) =>
          argvBytes([process.execPath, "run"]) +
          cypressChunkCost(
            chunk.map((file) => ({ file }) as RunnableTestRef),
            null,
            0,
          ),
        (s) => s,
      );
      const results: SpawnCaptureResult[] = [];
      for (const chunk of chunks) {
        results.push(
          await runCypress({
            rootDir,
            resolved,
            specs: chunk,
            onlyTitles: null,
            env,
            timeoutMs: DELEGATED_RUN_TIMEOUT_MS,
            ...(output !== undefined ? { output } : {}),
          }),
        );
      }
      return mergeSpawnResults(
        results,
        output === "capture" || output === undefined ? undefined : OUTPUT_TAIL_BYTES,
      );
    }
    const cli = resolveCypressCli(rootDir);
    const cfg = resolved.config.cypress;
    const fixed = argvBytes([
      process.execPath,
      cli,
      "run",
      ...(cfg?.config !== undefined ? ["--config-file", cfg.config] : []),
      ...(cfg?.browser !== undefined ? ["--browser", cfg.browser] : []),
    ]);
    const chunks = planCypressChunks(
      tests,
      discovered,
      argvBudgetBytes ?? ARGV_BUDGET_BYTES,
      fixed,
    );
    const results: SpawnCaptureResult[] = [];
    for (const chunk of chunks) {
      results.push(
        await runCypress({
          rootDir,
          resolved,
          specs: chunk.specs,
          onlyTitles: chunk.onlyTitles,
          env,
          timeoutMs: DELEGATED_RUN_TIMEOUT_MS,
          ...(output !== undefined ? { output } : {}),
        }),
      );
    }
    return mergeSpawnResults(
      results,
      output === "capture" || output === undefined ? undefined : OUTPUT_TAIL_BYTES,
    );
  },
};
