import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import {
  createProjectParser,
  indexProject,
  isIndexableFile,
  loadProjectFileList,
} from "../indexer/index.js";
import { filterSymbols, loadConfig, type ResolvedConfig } from "../verifier/config.js";
import {
  hashSymbolSources,
  readLockfile,
  type LockfileTestEntry,
  type VibehardLockfile,
} from "../verifier/lockfile.js";
import { getFrameworkDriver, type FrameworkDriver } from "../verifier/driver.js";
import type { ListedTest, RunnableTestRef } from "../verifier/listed.js";
import { startServers, type SpawnCaptureResult } from "../verifier/servers.js";
import { PhaseTimer, formatPhaseTimings, timingEnabled } from "../timing.js";
import { VibehardUsageError } from "../verifier/types.js";
import { fastSelectEnabled, fileOfSymbolId, loadHeadFiles } from "./fast-select.js";
import { resolveGitRoot } from "./git.js";
import { ParseCache, parseCacheEnabled } from "./parse-cache.js";
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

/** Run the framework around the config servers, without observation. */
async function runPlain(
  rootDir: string,
  resolved: ResolvedConfig,
  driver: FrameworkDriver,
  tests: readonly RunnableTestRef[] | null,
  timer: PhaseTimer = new PhaseTimer(false),
): Promise<SpawnCaptureResult> {
  const servers = await timer.run("servers.start", () => startServers(resolved));
  try {
    return await timer.run("framework.run", () =>
      driver.runMany({ rootDir, resolved, tests, env: servers.env }),
    );
  } finally {
    await timer.run("servers.stop", async () => {
      await servers.stop().catch(() => []);
    });
  }
}

function selectedRefs(tests: readonly SelectedTest[]): RunnableTestRef[] {
  return tests.map((t) => ({
    testId: t.testId,
    file: t.file,
    line: t.line,
    title: t.title,
    titlePath: t.titlePath,
  }));
}

export async function testProject(options: TestProjectOptions): Promise<TestProjectResult> {
  const timer = new PhaseTimer(timingEnabled(options.timing));
  const finish = (result: TestProjectResult): TestProjectResult => {
    if (timer.enabled) result.timing = timer.snapshot();
    return result;
  };
  const rootDir = path.resolve(options.rootDir);
  const resolved = await timer.run("config.load", () => loadConfig(rootDir, options.configPath));
  const dryRun = options.dryRun ?? false;
  const all = options.all ?? false;
  const diagnostics: string[] = [];
  const driver = getFrameworkDriver(resolved.config.framework);

  if (all) {
    if (dryRun) {
      const discovered = await timer.run("tests.discovery", () => driver.listTests(rootDir, resolved), (tests) => ({ tests: tests.length }));
      diagnostics.push("--all: selection skipped; the full suite would run");
      return finish({
        ok: true,
        exitCode: 0,
        dryRun,
        all,
        rootDir,
        selection: null,
        ran: { mode: "full", testIds: discovered.map((t) => t.testId), frameworkExitCode: null, playwrightExitCode: null },
        output: null,
        diagnostics,
      });
    }
    const discovered = await timer.run("tests.discovery", () => driver.listTests(rootDir, resolved), (tests) => ({ tests: tests.length }));
    const run = await runPlain(rootDir, resolved, driver, null, timer);
    return finish({
      ok: run.exitCode === 0,
      exitCode: run.exitCode === 0 ? 0 : 1,
      dryRun,
      all,
      rootDir,
      selection: null,
      ran: { mode: "full", testIds: discovered.map((t) => t.testId), frameworkExitCode: run.exitCode, playwrightExitCode: run.exitCode },
      output: { stdout: run.stdout, stderr: run.stderr },
      diagnostics,
    });
  }

  const selection = await timer.run("selection", () =>
    selectTests({
      rootDir,
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
      ...(options.fastSelect !== undefined ? { fastSelect: options.fastSelect } : {}),
      timing: timer.enabled,
    }),
  );

  if (dryRun) {
    const unsafe = selection.unsafeReasons.length > 0;
    return finish({
      ok: !unsafe,
      exitCode: unsafe ? 3 : 0,
      dryRun,
      all,
      rootDir,
      selection,
      ran: null,
      output: null,
      diagnostics,
    });
  }

  if (selection.unsafeReasons.length > 0) {
    // Safety falls back to a full run, never to a partial run.
    const run = await runPlain(rootDir, resolved, driver, null, timer);
    return finish({
      ok: run.exitCode === 0,
      exitCode: run.exitCode === 0 ? 0 : 1,
      dryRun,
      all,
      rootDir,
      selection,
      ran: {
        mode: "full",
        testIds: selection.discovered.map((t) => t.testId),
        frameworkExitCode: run.exitCode,
        playwrightExitCode: run.exitCode,
      },
      output: { stdout: run.stdout, stderr: run.stderr },
      diagnostics,
    });
  }

  if (selection.selected.length === 0) {
    diagnostics.push("no tests selected; nothing to run");
    return finish({
      ok: true,
      exitCode: 0,
      dryRun,
      all,
      rootDir,
      selection,
      ran: { mode: "none", testIds: [], frameworkExitCode: null, playwrightExitCode: null },
      output: null,
      diagnostics,
    });
  }

  const refs = selectedRefs(selection.selected);
  const proveFilter = driver.proveFilter;
  const filterProblem =
    proveFilter === undefined
      ? null
      : await timer.run("filter.prove", () => proveFilter({ rootDir, resolved, tests: refs }));
  if (filterProblem !== null) {
    diagnostics.push(`${filterProblem}; falling back to a full run`);
    const run = await runPlain(rootDir, resolved, driver, null, timer);
    return finish({
      ok: run.exitCode === 0,
      exitCode: run.exitCode === 0 ? 0 : 1,
      dryRun,
      all,
      rootDir,
      selection,
      ran: {
        mode: "full",
        testIds: selection.discovered.map((t) => t.testId),
        frameworkExitCode: run.exitCode,
        playwrightExitCode: run.exitCode,
      },
      output: { stdout: run.stdout, stderr: run.stderr },
      diagnostics,
    });
  }

  const run = await runPlain(rootDir, resolved, driver, refs, timer);
  return finish({
    ok: run.exitCode === 0,
    exitCode: run.exitCode === 0 ? 0 : 1,
    dryRun,
    all,
    rootDir,
    selection,
    ran: {
      mode: "selected",
      testIds: selection.selected.map((t) => t.testId),
      frameworkExitCode: run.exitCode,
      playwrightExitCode: run.exitCode,
    },
    output: { stdout: run.stdout, stderr: run.stderr },
    diagnostics,
  });
}

// --- explain -------------------------------------------------------------

function symbolStatuses(
  entry: LockfileTestEntry | undefined,
  headHashes: Readonly<Record<string, string>>,
  knownIds: ReadonlySet<SymbolId>,
): ExplainSymbolStatus[] {
  if (entry === undefined) return [];
  return Object.keys(entry.touched).sort().map((id) => {
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
  via?: ExplainTestEntry["via"],
): ExplainTestEntry {
  const touched: ExplainTestEntry["touched"] = {};
  if (entry !== undefined) {
    for (const id of Object.keys(entry.touched).sort()) {
      const kind = entry.touched[id as SymbolId];
      if (kind !== undefined) touched[id] = kind;
    }
  }
  const out: ExplainTestEntry = {
    testId,
    file,
    titlePath,
    inLockfile: entry !== undefined,
    touched,
    alwaysRun: entry?.alwaysRun ?? null,
    symbols: symbolStatuses(entry, headHashes, knownIds),
  };
  if (via !== undefined) out.via = via;
  return out;
}

export async function explainProject(options: ExplainOptions): Promise<ExplainResult> {
  if (fastSelectEnabled(options.fastSelect)) {
    try {
      const fast = await explainProjectFast(options);
      if (fast !== null) return fast;
    } catch {
      // fall through to the full-index implementation
    }
  }
  return explainProjectFull(options);
}

/**
 * Parse-only `explain`: loads only the queried symbol's file and the
 * touched files of the tests the answer reports on. Returns null
 * when the fast path cannot prove the same answer the full index
 * would give (symbol file outside the known membership, or a symbol
 * found by neither parse nor lockfile), letting the caller fall back.
 */
async function explainProjectFast(options: ExplainOptions): Promise<ExplainResult | null> {
  const rootDir = path.resolve(options.rootDir);
  const resolved = await loadConfig(rootDir, options.configPath);
  const diagnostics: string[] = [];

  let lock: VibehardLockfile | null = null;
  try {
    lock = readLockfile(resolved.lockfilePath);
  } catch (error) {
    diagnostics.push(
      `lockfile unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (lock === null) {
    diagnostics.push("no lockfile found; touched sets are unknown (run `vibehard record`)");
  }

  const parser = createProjectParser(rootDir);
  let cache = new ParseCache(null);
  try {
    const gitRoot = await resolveGitRoot(rootDir);
    cache = await ParseCache.open(gitRoot, { enabled: parseCacheEnabled() });
  } catch {
    // explain works outside a git repo; the cache is optional
  }

  const loadFor = async (entries: readonly LockfileTestEntry[], extraFile?: string) => {
    const sourceFiles = new Set<string>();
    const assetFiles = new Set<string>();
    const addTouched = (entry: LockfileTestEntry): void => {
      for (const id of Object.keys(entry.touched)) {
        const file = fileOfSymbolId(id);
        if (id.endsWith("#<file>")) assetFiles.add(file);
        else if (isIndexableFile(file)) sourceFiles.add(file);
      }
    };
    for (const entry of entries) addTouched(entry);
    if (extraFile !== undefined) {
      if (isIndexableFile(extraFile)) sourceFiles.add(extraFile);
      else assetFiles.add(extraFile);
    }
    return loadHeadFiles({
      rootDir,
      resolved,
      sourceFiles: [...sourceFiles],
      assetFilesWanted: [...assetFiles],
      parser,
      cache,
    });
  };

  const query = options.query;
  if (query.includes("#")) {
    const file = fileOfSymbolId(query);
    const membership = new Set(loadProjectFileList(rootDir));
    for (const entry of Object.values(lock?.tests ?? {})) {
      for (const id of Object.keys(entry.touched)) membership.add(fileOfSymbolId(id));
    }
    if (!membership.has(file)) return null;

    const touching: [string, LockfileTestEntry][] = [];
    for (const [testId, entry] of Object.entries(lock?.tests ?? {})) {
      if (entry.touched[query as SymbolId] !== undefined) touching.push([testId, entry]);
    }
    const loaded = await loadFor(touching.map(([, e]) => e), file);
    const loadedSymbols: SymbolRecord[] = [];
    for (const symbols of loaded.symbolsByFile.values()) loadedSymbols.push(...symbols);
    const knownIds = new Set(loadedSymbols.map((s) => s.id));
    const record = loadedSymbols.find((s) => s.id === query);
    if (record === undefined && touching.length === 0) return null;
    const tests = touching
      .map(([testId, entry]) =>
        explainEntry(
          testId,
          entry.file,
          entry.titlePath,
          entry,
          loaded.hashes,
          knownIds,
          entry.touched[query as SymbolId],
        ),
      )
      .sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
    if (record === undefined) {
      diagnostics.push(`${query} is recorded but no longer in the index (renamed or deleted)`);
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

  let discovered: ListedTest[] = [];
  try {
    discovered = await getFrameworkDriver(resolved.config.framework).listTests(rootDir, resolved);
  } catch (error) {
    diagnostics.push(
      `could not list tests (${error instanceof Error ? error.message : String(error)}); matching the lockfile only`,
    );
  }
  const matches = (testId: string, file: string, titlePath: readonly string[]): boolean =>
    testId.includes(query) || file.includes(query) || titlePath.some((t) => t.includes(query));

  const matchedEntries: LockfileTestEntry[] = [];
  for (const test of discovered) {
    const entry = lock?.tests[test.testId];
    if (entry !== undefined && matches(test.testId, test.relFile, test.titlePath)) {
      matchedEntries.push(entry);
    }
  }
  for (const [testId, entry] of Object.entries(lock?.tests ?? {})) {
    if (matches(testId, entry.file, entry.titlePath) && !matchedEntries.includes(entry)) {
      matchedEntries.push(entry);
    }
  }
  const loaded = await loadFor(matchedEntries);
  const knownIds = new Set<SymbolId>();
  for (const symbols of loaded.symbolsByFile.values()) {
    for (const s of symbols) knownIds.add(s.id);
  }

  const byId = new Map<string, ExplainTestEntry>();
  for (const test of discovered) {
    if (!matches(test.testId, test.relFile, test.titlePath)) continue;
    byId.set(
      test.testId,
      explainEntry(test.testId, test.relFile, test.titlePath, lock?.tests[test.testId], loaded.hashes, knownIds),
    );
  }
  for (const [testId, entry] of Object.entries(lock?.tests ?? {})) {
    if (byId.has(testId) || !matches(testId, entry.file, entry.titlePath)) continue;
    byId.set(testId, explainEntry(testId, entry.file, entry.titlePath, entry, loaded.hashes, knownIds));
  }
  const tests = [...byId.values()].sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
  if (tests.length === 0) {
    throw new VibehardUsageError(`vibehard explain: no symbol or test matches "${query}"`);
  }
  return { query, kind: "test", rootDir, symbol: null, tests, diagnostics };
}

async function explainProjectFull(options: ExplainOptions): Promise<ExplainResult> {
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
    diagnostics.push("no lockfile found; touched sets are unknown (run `vibehard record`)");
  }

  const query = options.query;
  if (query.includes("#")) {
    const record = symbols.find((s) => s.id === query);
    const tests: ExplainTestEntry[] = [];
    for (const [testId, entry] of Object.entries(lock?.tests ?? {})) {
      const via = entry.touched[query as SymbolId];
      if (via !== undefined) {
        tests.push(explainEntry(testId, entry.file, entry.titlePath, entry, headHashes, knownIds, via));
      }
    }
    tests.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
    if (record === undefined && tests.length === 0) {
      throw new VibehardUsageError(`vibehard explain: no symbol or test matches "${query}"`);
    }
    if (record === undefined) {
      diagnostics.push(`${query} is recorded but no longer in the index (renamed or deleted)`);
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
    discovered = await getFrameworkDriver(resolved.config.framework).listTests(rootDir, resolved);
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
      return `changed symbol ${reason.symbol} (touched: ${reason.via})`;
    case "always-run":
      return `alwaysRun (${reason.reason})`;
    case "unrecorded":
      return "not in lockfile (unrecorded)";
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
        `${result.ran.mode} run: ${result.ran.testIds.length} test(s), framework exit ${result.ran.frameworkExitCode ?? result.ran.playwrightExitCode ?? "?"}`,
      );
    }
  }
  for (const d of result.diagnostics) lines.push(d);
  const selectionTiming = formatPhaseTimings("timing (selection)", result.selection?.timing);
  if (selectionTiming !== "") lines.push(selectionTiming.trimEnd());
  const timing = formatPhaseTimings("timing", result.timing);
  if (timing !== "") lines.push(timing.trimEnd());
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
    if (result.tests.length === 0) lines.push("  touched by: (no tests)");
    for (const test of result.tests) {
      lines.push(`  touched by: ${test.testId}${test.via !== undefined ? ` (${test.via})` : ""}`);
    }
  } else {
    for (const test of result.tests) {
      lines.push(`test ${test.testId}`);
      if (!test.inLockfile) lines.push("  not in lockfile (unrecorded)");
      if (test.alwaysRun !== null) lines.push(`  alwaysRun: ${test.alwaysRun}`);
      for (const s of test.symbols) {
        lines.push(`  ${s.status}: ${s.id} (${test.touched[s.id] ?? "direct"})`);
      }
      lines.push(`  touched ${Object.keys(test.touched).length} symbol(s)`);
    }
  }
  for (const d of result.diagnostics) lines.push(d);
  return `${lines.join("\n")}\n`;
}
