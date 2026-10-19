import path from "node:path";

import type { ResolvedConfig } from "./config.js";
import { discoverStaticTests } from "./discovery.js";
import type { FrameworkDriver } from "./driver.js";
import { frameworkVersion } from "./lockfile.js";
import type { ListedTest, RunnableTestRef } from "./listed.js";
import { spawnCapture, type SpawnCaptureResult } from "./servers.js";

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
  runMany: async ({ rootDir, resolved, tests, env }) => {
    if (tests === null) {
      const all = await listPuppeteerTests(rootDir, resolved);
      const groups = new Map<string, readonly string[] | null>();
      for (const t of all) groups.set(t.relFile, null);
      return runNodeTestFiles({ rootDir, resolved, groups, env, timeoutMs: 1_800_000 });
    }
    const groups = new Map<string, string[]>();
    for (const t of tests as readonly RunnableTestRef[]) {
      const list = groups.get(t.file) ?? [];
      list.push(t.title);
      groups.set(t.file, list);
    }
    return runNodeTestFiles({ rootDir, resolved, groups, env, timeoutMs: 1_800_000 });
  },
};
