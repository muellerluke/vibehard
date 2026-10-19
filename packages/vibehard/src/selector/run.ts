import path from "node:path";

import type { SymbolId } from "../index.js";
import { indexProject } from "../indexer/index.js";
import { filterSymbols, loadConfig, type ResolvedConfig } from "../verifier/config.js";
import {
  hashSymbolSources,
  readLockfile,
  type LockfileTestEntry,
  type VibehardLockfile,
} from "../verifier/lockfile.js";
import {
  freePort,
  listTests,
  resolvePlaywrightCli,
  runPlaywrightTests,
  startAppServer,
  type ListedTest,
  type SpawnCaptureResult,
} from "../verifier/playwright-runner.js";
import { VibehardUsageError } from "../verifier/types.js";
import { selectTests } from "./select.js";
import type {
  ExplainOptions,
  ExplainResult,
  ExplainSymbolStatus,
  ExplainTestEntry,
  SelectedTest,
  SelectionResult,
  TestProjectOptions,
  TestProjectResult,
} from "./types.js";

/** Run Playwright around the config app server, without observation. */
async function runPlain(
  rootDir: string,
  resolved: ResolvedConfig,
  cliPath: string,
  positionals: readonly string[],
): Promise<SpawnCaptureResult> {
  const port = resolved.config.app !== undefined ? await freePort() : 0;
  const server = await startAppServer(resolved, port);
  try {
    return await runPlaywrightTests({
      rootDir,
      cliPath,
      resolved,
      positionals,
      env: server !== null ? { VIBEHARD_BASE_URL: server.baseUrl } : {},
    });
  } finally {
    if (server !== null) await server.stop().catch(() => []);
  }
}

function fileLines(tests: readonly SelectedTest[]): string[] {
  return tests.map((t) => `${t.file}:${t.line}`);
}

/** Prove the file:line filters resolve to exactly the selected tests. */
async function verifyFilter(
  rootDir: string,
  resolved: ResolvedConfig,
  cliPath: string,
  selected: readonly SelectedTest[],
): Promise<string | null> {
  const listed = await listTests(rootDir, resolved, cliPath, fileLines(selected));
  const listedIds = listed.map((t) => t.testId).sort();
  const selectedIds = selected.map((t) => t.testId).sort();
  return JSON.stringify(listedIds) === JSON.stringify(selectedIds)
    ? null
    : `playwright --list resolved [${listedIds.join(", ")}] for selected [${selectedIds.join(", ")}]`;
}

export async function testProject(options: TestProjectOptions): Promise<TestProjectResult> {
  const rootDir = path.resolve(options.rootDir);
  const resolved = await loadConfig(rootDir, options.configPath);
  const dryRun = options.dryRun ?? false;
  const all = options.all ?? false;
  const diagnostics: string[] = [];
  const cliPath = resolvePlaywrightCli(rootDir);

  if (all) {
    if (dryRun) {
      const discovered = await listTests(rootDir, resolved, cliPath);
      diagnostics.push("--all: selection skipped; the full suite would run");
      return {
        ok: true,
        exitCode: 0,
        dryRun,
        all,
        rootDir,
        selection: null,
        ran: { mode: "full", testIds: discovered.map((t) => t.testId), playwrightExitCode: null },
        output: null,
        diagnostics,
      };
    }
    const discovered = await listTests(rootDir, resolved, cliPath);
    const run = await runPlain(rootDir, resolved, cliPath, []);
    return {
      ok: run.exitCode === 0,
      exitCode: run.exitCode === 0 ? 0 : 1,
      dryRun,
      all,
      rootDir,
      selection: null,
      ran: { mode: "full", testIds: discovered.map((t) => t.testId), playwrightExitCode: run.exitCode },
      output: { stdout: run.stdout, stderr: run.stderr },
      diagnostics,
    };
  }

  const selection = await selectTests({
    rootDir,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
  });

  if (dryRun) {
    const unsafe = selection.unsafeReasons.length > 0;
    return {
      ok: !unsafe,
      exitCode: unsafe ? 3 : 0,
      dryRun,
      all,
      rootDir,
      selection,
      ran: null,
      output: null,
      diagnostics,
    };
  }

  if (selection.unsafeReasons.length > 0) {
    // Safety falls back to a full run, never to a partial run.
    const run = await runPlain(rootDir, resolved, cliPath, []);
    return {
      ok: run.exitCode === 0,
      exitCode: run.exitCode === 0 ? 0 : 1,
      dryRun,
      all,
      rootDir,
      selection,
      ran: {
        mode: "full",
        testIds: selection.discovered.map((t) => t.testId),
        playwrightExitCode: run.exitCode,
      },
      output: { stdout: run.stdout, stderr: run.stderr },
      diagnostics,
    };
  }

  if (selection.selected.length === 0) {
    diagnostics.push("no tests selected; nothing to run");
    return {
      ok: true,
      exitCode: 0,
      dryRun,
      all,
      rootDir,
      selection,
      ran: { mode: "none", testIds: [], playwrightExitCode: null },
      output: null,
      diagnostics,
    };
  }

  const filterProblem = await verifyFilter(rootDir, resolved, cliPath, selection.selected);
  if (filterProblem !== null) {
    diagnostics.push(`${filterProblem}; falling back to a full run`);
    const run = await runPlain(rootDir, resolved, cliPath, []);
    return {
      ok: run.exitCode === 0,
      exitCode: run.exitCode === 0 ? 0 : 1,
      dryRun,
      all,
      rootDir,
      selection,
      ran: {
        mode: "full",
        testIds: selection.discovered.map((t) => t.testId),
        playwrightExitCode: run.exitCode,
      },
      output: { stdout: run.stdout, stderr: run.stderr },
      diagnostics,
    };
  }

  const run = await runPlain(rootDir, resolved, cliPath, fileLines(selection.selected));
  return {
    ok: run.exitCode === 0,
    exitCode: run.exitCode === 0 ? 0 : 1,
    dryRun,
    all,
    rootDir,
    selection,
    ran: {
      mode: "selected",
      testIds: selection.selected.map((t) => t.testId),
      playwrightExitCode: run.exitCode,
    },
    output: { stdout: run.stdout, stderr: run.stderr },
    diagnostics,
  };
}

// --- explain -------------------------------------------------------------

function symbolStatuses(
  entry: LockfileTestEntry | undefined,
  headHashes: Readonly<Record<string, string>>,
  knownIds: ReadonlySet<SymbolId>,
): ExplainSymbolStatus[] {
  if (entry === undefined) return [];
  return [...entry.declared].sort().map((id) => {
    if (!knownIds.has(id)) return { id, status: "missing" as const };
    const expected = entry.symbolHashes[id];
    if (expected === undefined) return { id, status: "unknown" as const };
    return { id, status: headHashes[id] === expected ? ("fresh" as const) : ("stale" as const) };
  });
}

function explainEntry(
  testId: string,
  file: string,
  titlePath: string[],
  entry: LockfileTestEntry | undefined,
  headHashes: Readonly<Record<string, string>>,
  knownIds: ReadonlySet<SymbolId>,
  via?: "declared" | "allowed",
): ExplainTestEntry {
  const declared = entry === undefined ? [] : [...entry.declared].sort();
  const allowedObserved = entry === undefined ? [] : [...entry.allowedObserved].sort();
  const out: ExplainTestEntry = {
    testId,
    file,
    titlePath,
    inLockfile: entry !== undefined,
    declared,
    allowedObserved,
    lastObserved: [...new Set([...declared, ...allowedObserved])].sort(),
    skipVerify: entry?.skipVerify ?? null,
    symbols: symbolStatuses(entry, headHashes, knownIds),
  };
  if (via !== undefined) out.via = via;
  return out;
}

export async function explainProject(options: ExplainOptions): Promise<ExplainResult> {
  const rootDir = path.resolve(options.rootDir);
  const resolved = await loadConfig(rootDir, options.configPath);
  const diagnostics: string[] = [];

  const index = await indexProject(rootDir);
  const symbols = filterSymbols(index.symbols, resolved);
  const knownIds = new Set(symbols.map((s) => s.id));
  const headHashes = symbols.length === 0 ? {} : hashSymbolSources(rootDir, symbols);

  let lock: VibehardLockfile | null = null;
  try {
    lock = readLockfile(resolved.lockfilePath);
  } catch (error) {
    diagnostics.push(
      `lockfile unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (lock === null) {
    diagnostics.push("no lockfile found; declared sets are unknown (run `vibehard record`)");
  }

  const query = options.query;
  if (query.includes("#")) {
    const record = symbols.find((s) => s.id === query);
    const tests: ExplainTestEntry[] = [];
    for (const [testId, entry] of Object.entries(lock?.tests ?? {})) {
      if (entry.declared.includes(query)) {
        tests.push(explainEntry(testId, entry.file, entry.titlePath, entry, headHashes, knownIds, "declared"));
      } else if (entry.allowedObserved.includes(query)) {
        tests.push(explainEntry(testId, entry.file, entry.titlePath, entry, headHashes, knownIds, "allowed"));
      }
    }
    tests.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
    if (record === undefined && tests.length === 0) {
      throw new VibehardUsageError(`vibehard explain: no symbol or test matches "${query}"`);
    }
    if (record === undefined) {
      diagnostics.push(`${query} is declared but no longer in the index (renamed or deleted)`);
    }
    return {
      query,
      kind: "symbol",
      rootDir,
      symbol:
        record === undefined
          ? null
          : {
              id: record.id,
              file: record.file,
              qualifiedName: record.qualifiedName,
              kind: record.kind,
              startLine: record.startLine,
              endLine: record.endLine,
            },
      tests,
      diagnostics,
    };
  }

  // Test query: match discovered tests and lockfile entries alike, using
  // the same substring semantics as the verifier filter.
  let discovered: ListedTest[] = [];
  try {
    discovered = await listTests(rootDir, resolved, resolvePlaywrightCli(rootDir));
  } catch (error) {
    diagnostics.push(
      `could not list tests (${error instanceof Error ? error.message : String(error)}); matching the lockfile only`,
    );
  }
  const matches = (testId: string, file: string, titlePath: readonly string[]): boolean =>
    testId.includes(query) || file.includes(query) || titlePath.some((t) => t.includes(query));

  const byId = new Map<string, ExplainTestEntry>();
  for (const test of discovered) {
    if (!matches(test.testId, test.relFile, test.titlePath)) continue;
    byId.set(
      test.testId,
      explainEntry(test.testId, test.relFile, test.titlePath, lock?.tests[test.testId], headHashes, knownIds),
    );
  }
  for (const [testId, entry] of Object.entries(lock?.tests ?? {})) {
    if (byId.has(testId) || !matches(testId, entry.file, entry.titlePath)) continue;
    byId.set(testId, explainEntry(testId, entry.file, entry.titlePath, entry, headHashes, knownIds));
  }
  const tests = [...byId.values()].sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
  if (tests.length === 0) {
    throw new VibehardUsageError(`vibehard explain: no symbol or test matches "${query}"`);
  }
  return { query, kind: "test", rootDir, symbol: null, tests, diagnostics };
}

// --- human reports -------------------------------------------------------

function reasonText(reason: SelectedTest["reasons"][number]): string {
  switch (reason.type) {
    case "changed-symbol":
      return `changed symbol ${reason.symbol}`;
    case "skip-verify":
      return `skipVerify (${reason.reason})`;
    case "unverified":
      return "not in lockfile (unverified)";
    case "test-file-changed":
      return `test file changed (${reason.file})`;
  }
}

export function formatSelectionReport(selection: SelectionResult): string {
  const lines: string[] = [];
  lines.push(
    `base: ${selection.base.sha.slice(0, 12)} (${selection.base.description}); ` +
      `${selection.changedFiles.length} changed file(s), ${selection.changedSymbols.length} changed symbol(s)`,
  );
  for (const id of selection.changedSymbols) lines.push(`  changed: ${id}`);
  for (const test of selection.selected) {
    lines.push(`SELECT ${test.testId}`);
    for (const reason of test.reasons) lines.push(`  ${reasonText(reason)}`);
  }
  for (const reason of selection.unsafeReasons) lines.push(reason);
  for (const d of selection.diagnostics) lines.push(d);
  lines.push(
    `selected ${selection.selected.length} of ${selection.discovered.length} test(s)` +
      (selection.unsafeReasons.length > 0 ? "; selection unsafe, full run required" : ""),
  );
  return `${lines.join("\n")}\n`;
}

export function formatTestReport(result: TestProjectResult): string {
  const lines: string[] = [];
  if (result.selection !== null) {
    lines.push(formatSelectionReport(result.selection).trimEnd());
  }
  if (result.dryRun) {
    lines.push("dry run: nothing executed");
  } else if (result.ran !== null) {
    if (result.ran.mode === "none") {
      lines.push("no tests selected; nothing ran");
    } else {
      lines.push(
        `${result.ran.mode} run: ${result.ran.testIds.length} test(s), playwright exit ${result.ran.playwrightExitCode ?? "?"}`,
      );
    }
  }
  for (const d of result.diagnostics) lines.push(d);
  let out = `${lines.join("\n")}\n`;
  if (result.output !== null) {
    if (result.output.stdout !== "") out += result.output.stdout;
    if (result.output.stderr !== "") out += result.output.stderr;
  }
  return out;
}

export function formatExplainReport(result: ExplainResult): string {
  const lines: string[] = [];
  if (result.kind === "symbol") {
    if (result.symbol !== null) {
      lines.push(
        `symbol ${result.symbol.id} (${result.symbol.kind}, ${result.symbol.file}:${result.symbol.startLine}-${result.symbol.endLine})`,
      );
    } else {
      lines.push(`symbol ${result.query} (not in index)`);
    }
    if (result.tests.length === 0) lines.push("  declared by: (no tests)");
    for (const test of result.tests) {
      lines.push(`  declared by: ${test.testId}${test.via === "allowed" ? " (via allowTransitive)" : ""}`);
    }
  } else {
    for (const test of result.tests) {
      lines.push(`test ${test.testId}`);
      if (!test.inLockfile) lines.push("  not in lockfile (unverified)");
      if (test.skipVerify !== null) lines.push(`  skipVerify: ${test.skipVerify}`);
      for (const s of test.symbols) lines.push(`  ${s.status}: ${s.id}`);
      for (const id of test.allowedObserved) lines.push(`  allowed (allowTransitive): ${id}`);
      lines.push(
        `  declared ${test.declared.length}, last observed ${test.lastObserved.length}`,
      );
    }
  }
  for (const d of result.diagnostics) lines.push(d);
  return `${lines.join("\n")}\n`;
}
