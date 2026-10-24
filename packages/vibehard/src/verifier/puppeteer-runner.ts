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
import { mergeSpawnResults, spawnCapture, spawnDelegated, type SpawnCaptureResult } from "./servers.js";

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Anchored `node --test` name pattern matching exactly the given titles. */
export function titlePattern(titles: readonly string[]): string {
  return `^(${titles.map(escapeRegExp).join("|")})$`;
}

const TS_SPEC = /\.(?:ts|mts|cts|tsx)$/;

export function nodeTestArgs(
  resolved: ResolvedConfig,
  files: readonly string[],
  pattern: string | null,
): string[] {
  const args: string[] = [];
  for (const extra of resolved.config.puppeteer?.nodeArgs ?? []) args.push(extra);
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  if (
    nodeMajor >= 22 &&
    files.some((f) => TS_SPEC.test(f)) &&
    !args.includes("--experimental-strip-types")
  ) {
    args.push("--experimental-strip-types");
  }
  args.push("--test");
  if (pattern !== null) args.push(`--test-name-pattern=${pattern}`);
  args.push(...files);
  return args;
}

async function listPuppeteerTests(
  rootDir: string,
  resolved: ResolvedConfig,
): Promise<ListedTest[]> {
  const tests = await discoverStaticTests(rootDir, resolved, {
    defaults: ["e2e", "tests", "test"],
    isSpec: (rel) => /\.(?:test|spec)\.[^.]+$/.test(rel),
    frameworkLabel: "puppeteer",
    discovery: {
      specifier: "vibehard/puppeteer",
      imports: [
        { specifier: "vibehard/puppeteer", test: ["describeTest", "test"], describe: ["describe"] },
        { specifier: "node:test", test: ["test", "it"], describe: ["describe"] },
      ],
      globals: { test: [], describe: [] },
      requireImport: false,
    },
  });
  // `node --test --test-name-pattern` selects by leaf title, so two
  // tests sharing a leaf title in one file could not be run (and thus
  // observed) one at a time.
  const byFileTitle = new Map<string, ListedTest>();
  for (const t of tests) {
    const key = `${t.relFile}::${t.title}`;
    const prev = byFileTitle.get(key);
    if (prev !== undefined) {
      throw new Error(
        `vibehard: duplicate test title "${t.title}" in ${t.relFile} (lines ${prev.line} and ${t.line}); Puppeteer tests are selected by title within a file, so leaf titles must be unique per file`,
      );
    }
    byFileTitle.set(key, t);
  }
  return tests;
}

/** One delegated `node --test` invocation: one file, optional title pattern. */
export interface PuppeteerChunk {
  file: string;
  tests: RunnableTestRef[];
  pattern: string | null;
}

/**
 * Plan delegated Puppeteer invocations under an argv byte budget.
 * Each invocation covers one file (as before); a fully selected file
 * needs no pattern, and a partial file's titles are split across as
 * many invocations as the pattern budget requires.
 */
export function planPuppeteerChunks(
  tests: readonly RunnableTestRef[],
  discovered?: readonly RunnableTestRef[],
  budgetBytes: number = ARGV_BUDGET_BYTES,
  fixedBytes = 0,
): PuppeteerChunk[] {
  const chunks: PuppeteerChunk[] = [];
  for (const group of groupRunnableByFile(tests, discovered)) {
    if (group.fullySelected) {
      chunks.push({ file: group.file, tests: group.tests, pattern: null });
      continue;
    }
    for (const packed of packChunks(
      group.tests,
      budgetBytes,
      (chunk) =>
        fixedBytes +
        argvBytes([`--test-name-pattern=${titlePattern(chunk.map((t) => t.title))}`]),
      (t) => t.testId,
    )) {
      chunks.push({
        file: group.file,
        tests: [...packed],
        pattern: titlePattern(packed.map((t) => t.title)),
      });
    }
  }
  return chunks;
}

async function runNodeTestChunks(input: {
  rootDir: string;
  resolved: ResolvedConfig;
  chunks: readonly { file: string; pattern: string | null }[];
  env: Record<string, string>;
  timeoutMs: number;
  output?: RunOutputMode;
}): Promise<SpawnCaptureResult> {
  const results: SpawnCaptureResult[] = [];
  for (const chunk of input.chunks) {
    const abs = path.resolve(input.rootDir, chunk.file);
    const args = nodeTestArgs(input.resolved, [abs], chunk.pattern);
    results.push(
      await spawnDelegated(process.execPath, args, {
        cwd: input.rootDir,
        env: input.env,
        timeoutMs: input.timeoutMs,
        output: input.output ?? "capture",
        tailBytes: OUTPUT_TAIL_BYTES,
      }),
    );
  }
  return mergeSpawnResults(
    results,
    input.output === "capture" || input.output === undefined ? undefined : OUTPUT_TAIL_BYTES,
  );
}

async function runNodeTestFiles(input: {
  rootDir: string;
  resolved: ResolvedConfig;
  groups: ReadonlyMap<string, readonly string[] | null>;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<SpawnCaptureResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  for (const [relFile, titles] of input.groups) {
    const abs = path.resolve(input.rootDir, relFile);
    const args = nodeTestArgs(
      input.resolved,
      [abs],
      titles === null ? null : titlePattern(titles),
    );
    const run = await spawnCapture(process.execPath, args, {
      cwd: input.rootDir,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });
    stdout += run.stdout;
    stderr += run.stderr;
    if (run.exitCode !== 0 && exitCode === 0) exitCode = run.exitCode;
  }
  return { exitCode, stdout, stderr };
}

/** Puppeteer (Node built-in test runner host) framework driver. */
export const puppeteerDriver: FrameworkDriver = {
  name: "puppeteer",
  missingArtifactHint:
    "is this spec using `describeTest` from 'vibehard/puppeteer'?",
  version: (rootDir) => frameworkVersion(rootDir, "puppeteer"),
  listTests: listPuppeteerTests,
  runSingleTest: ({ rootDir, resolved, test, env }) =>
    runNodeTestFiles({
      rootDir,
      resolved,
      groups: new Map([[test.relFile, [test.title]]]),
      env,
      timeoutMs: 300_000,
    }),
  runMany: async ({ rootDir, resolved, tests, env, discovered, argvBudgetBytes, output }) => {
    if (tests === null) {
      const all = await listPuppeteerTests(rootDir, resolved);
      const files = [...new Set(all.map((t) => t.relFile))].sort();
      return runNodeTestChunks({
        rootDir,
        resolved,
        chunks: files.map((file) => ({ file, pattern: null })),
        env,
        timeoutMs: DELEGATED_RUN_TIMEOUT_MS,
        ...(output !== undefined ? { output } : {}),
      });
    }
    // Conservative fixed cost: interpreter + the longest per-file
    // fixed arg list (node args + `--test` + absolute file path).
    const fixed = Math.max(
      argvBytes([process.execPath]),
      ...[...new Set(tests.map((t) => t.file))].map((file) =>
        argvBytes([
          process.execPath,
          ...nodeTestArgs(resolved, [path.resolve(rootDir, file)], null),
        ]),
      ),
    );
    return runNodeTestChunks({
      rootDir,
      resolved,
      chunks: planPuppeteerChunks(tests, discovered, argvBudgetBytes ?? ARGV_BUDGET_BYTES, fixed),
      env,
      timeoutMs: DELEGATED_RUN_TIMEOUT_MS,
      ...(output !== undefined ? { output } : {}),
    });
  },
};
