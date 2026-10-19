import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { ResolvedConfig } from "./config.js";
import type { FrameworkDriver } from "./driver.js";
import { frameworkVersion } from "./lockfile.js";
import { makeTestId, type ListedTest } from "./listed.js";
import { spawnCapture, type SpawnCaptureResult } from "./servers.js";
import { VibehardUsageError } from "./types.js";

export { freePort, spawnCapture, startAppServer, startServers } from "./servers.js";
export type { AppServerSession, ServersSession, SpawnCaptureResult } from "./servers.js";
export { makeTestId, readArtifacts } from "./listed.js";
export type { ListedTest } from "./listed.js";

/** Resolve the project's Playwright CLI entry (`@playwright/test` first). */
export function resolvePlaywrightCli(rootDir: string): string {
  const req = createRequire(path.join(path.resolve(rootDir), "package.json"));
  for (const pkg of ["@playwright/test/package.json", "playwright/package.json"]) {
    try {
      const pkgPath = req.resolve(pkg);
      const cli = path.join(path.dirname(pkgPath), "cli.js");
      if (existsSync(cli)) return cli;
    } catch {
      // try the next candidate
    }
  }
  const bin = path.join(path.resolve(rootDir), "node_modules", ".bin", "playwright");
  if (existsSync(bin)) return bin;
  throw new VibehardUsageError(
    `vibehard: cannot find Playwright in ${rootDir} (install @playwright/test in the project)`,
  );
}

interface JsonSpec {
  title: string;
  file: string;
  line: number;
  tests?: { projectName?: string }[];
}
interface JsonSuite {
  title: string;
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

function collectSpecs(
  suite: JsonSuite,
  describeTitles: string[],
  out: { spec: JsonSpec; titlePath: string[] }[],
  projects: Set<string>,
): void {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (typeof t.projectName === "string" && t.projectName !== "") projects.add(t.projectName);
    }
    out.push({ spec, titlePath: [...describeTitles, spec.title] });
  }
  for (const child of suite.suites ?? []) {
    const titles =
      child.title === "" ? describeTitles : [...describeTitles, child.title];
    collectSpecs(child, titles, out, projects);
  }
}

/** Shared `--config`/`--project` tail for every Playwright invocation. */
export function playwrightTailArgs(resolved: ResolvedConfig): string[] {
  const args: string[] = [];
  if (resolved.config.playwright?.config !== undefined) {
    args.push("--config", resolved.config.playwright.config);
  }
  if (resolved.config.playwright?.project !== undefined) {
    args.push("--project", resolved.config.playwright.project);
  }
  return args;
}

/** Enumerate tests with `playwright test --list --reporter=json`. */
export async function listTests(
  rootDir: string,
  resolved: ResolvedConfig,
  cliPath: string,
  positionals: readonly string[] = [],
): Promise<ListedTest[]> {
  const args = [
    cliPath,
    "test",
    ...positionals,
    "--list",
    "--reporter=json",
    ...playwrightTailArgs(resolved),
  ];
  const result = await spawnCapture(process.execPath, args, { cwd: rootDir, timeoutMs: 120_000 });
  const jsonAt = result.stdout.indexOf("{");
  if (result.exitCode !== 0 || jsonAt < 0) {
    throw new VibehardUsageError(
      `vibehard: playwright test --list failed (exit ${result.exitCode})\n${result.stderr || result.stdout}`,
    );
  }
  let report: {
    suites?: JsonSuite[];
    errors?: unknown[];
    config?: { rootDir?: string; projects?: { testDir?: string }[] };
  };
  try {
    report = JSON.parse(result.stdout.slice(jsonAt)) as typeof report;
  } catch {
    throw new VibehardUsageError("vibehard: could not parse playwright --list JSON output");
  }
  // Spec `file` values are relative to the report's config rootDir (the
  // testDir), not to the project root. Try each plausible base in order.
  const fileBases = [
    report.config?.rootDir,
    ...(report.config?.projects ?? []).map((p) => p.testDir),
    resolved.testDirPosix !== null ? path.resolve(rootDir, resolved.testDirPosix) : undefined,
    rootDir,
  ].filter((b): b is string => typeof b === "string" && b !== "");
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new VibehardUsageError(
      `vibehard: playwright reported errors while listing tests: ${JSON.stringify(report.errors).slice(0, 500)}`,
    );
  }
  const raw: { spec: JsonSpec; titlePath: string[] }[] = [];
  const projects = new Set<string>();
  for (const suite of report.suites ?? []) collectSpecs(suite, [], raw, projects);
  if (projects.size > 1 && resolved.config.playwright?.project === undefined) {
    throw new VibehardUsageError(
      `vibehard: multiple Playwright projects found (${[...projects].sort().join(", ")}); set playwright.project in vibehard.config to the Chromium project to verify`,
    );
  }
  const tests: ListedTest[] = raw.map(({ spec, titlePath }) => {
    let abs = path.isAbsolute(spec.file) ? spec.file : path.resolve(rootDir, spec.file);
    if (!path.isAbsolute(spec.file)) {
      for (const basePath of fileBases) {
        const candidate = path.resolve(basePath, spec.file);
        if (existsSync(candidate)) {
          abs = candidate;
          break;
        }
      }
    }
    const relFile = path.relative(rootDir, abs).split(path.sep).join("/");
    // Suite chains include the file name as a pseudo-title; drop segments
    // equal to the file so titlePath is describes + test title.
    const cleanPath = titlePath.filter(
      (segment, index) =>
        !(index < titlePath.length - 1 && (segment === relFile || segment === path.basename(abs))),
    );
    return {
      file: abs,
      relFile,
      line: spec.line,
      title: spec.title,
      titlePath: cleanPath,
      testId: makeTestId(relFile, cleanPath),
    };
  });
  const seen = new Map<string, ListedTest>();
  for (const t of tests) {
    const prev = seen.get(t.testId);
    if (prev !== undefined) {
      throw new VibehardUsageError(
        `vibehard: duplicate test "${t.title}" in ${t.relFile} (lines ${prev.line} and ${t.line}); rename one so test IDs stay unambiguous`,
      );
    }
    seen.set(t.testId, t);
  }
  return tests.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
}

/** Run exactly one test (by file:line) and return its framework result. */
export async function runSingleTest(input: {
  rootDir: string;
  cliPath: string;
  resolved: ResolvedConfig;
  test: ListedTest;
  env: Record<string, string>;
}): Promise<SpawnCaptureResult> {
  const args = [
    input.cliPath,
    "test",
    `${input.test.relFile}:${input.test.line}`,
    "--workers=1",
    "--retries=0",
    "--reporter=line",
  ];
  args.push(...playwrightTailArgs(input.resolved));
  return spawnCapture(process.execPath, args, {
    cwd: input.rootDir,
    env: input.env,
    timeoutMs: 180_000,
  });
}

/**
 * Run Playwright plainly (no observation) for the given positionals:
 * an empty list runs the full suite, `file:line` entries run exactly
 * those tests. The project's own reporters and parallelism apply.
 */
export async function runPlaywrightTests(input: {
  rootDir: string;
  cliPath: string;
  resolved: ResolvedConfig;
  positionals: readonly string[];
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<SpawnCaptureResult> {
  const args = [
    input.cliPath,
    "test",
    ...input.positionals,
    ...playwrightTailArgs(input.resolved),
  ];
  return spawnCapture(process.execPath, args, {
    cwd: input.rootDir,
    env: input.env,
    timeoutMs: input.timeoutMs ?? 1_800_000,
  });
}

/** Playwright implementation of the framework driver interface. */
export const playwrightDriver: FrameworkDriver = {
  name: "playwright",
  missingArtifactHint:
    "is this spec importing `test` from 'vibehard/playwright'?",
  version: (rootDir) => frameworkVersion(rootDir, "playwright"),
  listTests: (rootDir, resolved) =>
    listTests(rootDir, resolved, resolvePlaywrightCli(rootDir)),
  runSingleTest: ({ rootDir, resolved, test, env }) =>
    runSingleTest({ rootDir, cliPath: resolvePlaywrightCli(rootDir), resolved, test, env }),
  runMany: ({ rootDir, resolved, tests, env }) =>
    runPlaywrightTests({
      rootDir,
      cliPath: resolvePlaywrightCli(rootDir),
      resolved,
      positionals: tests === null ? [] : tests.map((t) => `${t.file}:${t.line}`),
      env,
    }),
  proveFilter: async ({ rootDir, resolved, tests }) => {
    const listed = await listTests(
      rootDir,
      resolved,
      resolvePlaywrightCli(rootDir),
      tests.map((t) => `${t.file}:${t.line}`),
    );
    const listedIds = listed.map((t) => t.testId).sort();
    const selectedIds = tests.map((t) => t.testId).sort();
    return JSON.stringify(listedIds) === JSON.stringify(selectedIds)
      ? null
      : `playwright --list resolved [${listedIds.join(", ")}] for selected [${selectedIds.join(", ")}]`;
  },
};
