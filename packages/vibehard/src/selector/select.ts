import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import { indexProject, INDEXER_VERSION } from "../indexer/index.js";
import { PhaseTimer, timingEnabled } from "../timing.js";
import { filterSymbols, loadConfig, type ResolvedConfig } from "../verifier/config.js";
import { getFrameworkDriver } from "../verifier/driver.js";
import {
  buildSymbolTestIndex,
  frameworkVersion,
  hashSymbolSources,
  readLockfile,
  type SymbolTestIndex,
  type VibehardLockfile,
} from "../verifier/lockfile.js";
import type { ListedTest } from "../verifier/listed.js";
import {
  classifyChangedFile,
  computeChangedSymbolsForFile,
  parseUnifiedDiff,
  type FilePatch,
} from "./changed.js";
import {
  baseProjectExists,
  createBaseWorktree,
  diffPatch,
  listChangedFiles,
  resolveBase,
  resolveGitRoot,
  type ChangedFile,
} from "./git.js";
import { fastSelectEnabled, selectTestsFast } from "./fast-select.js";
import { resolveChangedSupportFiles, supportFilesBySpec } from "./support-graph.js";
import type {
  DiscoveredTestRef,
  SelectedTest,
  SelectionReason,
  SelectionResult,
  SelectOptions,
} from "./types.js";

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function readTextOrNull(absFile: string): string | null {
  try {
    return readFileSync(absFile, "utf8");
  } catch {
    return null;
  }
}

function groupByFile(symbols: readonly SymbolRecord[]): Map<string, SymbolRecord[]> {
  const out = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    const list = out.get(s.file) ?? [];
    list.push(s);
    out.set(s.file, list);
  }
  return out;
}

function hashOrEmpty(rootDir: string, symbols: readonly SymbolRecord[]): Record<string, string> {
  if (symbols.length === 0) return {};
  return hashSymbolSources(rootDir, symbols);
}

export function toRef(test: ListedTest): DiscoveredTestRef {
  return {
    testId: test.testId,
    file: test.relFile,
    line: test.line,
    title: test.title,
    titlePath: test.titlePath,
  };
}

interface TrustInput {
  lock: VibehardLockfile | null;
  lockError: string | null;
  resolved: ResolvedConfig;
  rootDir: string;
  /** Framework identity to trust; defaults to the config's framework. */
  frameworkName?: string;
  frameworkVersion?: string;
  discoveredIds: ReadonlySet<string>;
  baseHashes: Readonly<Record<string, string>>;
  headHashes: Readonly<Record<string, string>>;
  /** Prebuilt inverted index over `lock`; built on demand when absent. */
  symbolIndex?: SymbolTestIndex;
}

/**
 * The lockfile is trusted only when every touched hash of every still-
 * discovered test matches the base source, or every hash matches the
 * current source (a change whose author already re-ran record). A mixed
 * state proves the mapping was never exact for either endpoint.
 */
export function lockfileTrustReasons(input: TrustInput): string[] {
  if (input.lockError !== null) {
    return [`unsafe: unreadable lockfile: ${input.lockError} (re-run \`vibehard record\`)`];
  }
  if (input.lock === null) {
    return ["unsafe: missing lockfile (run `vibehard record` or `vibehard verify`)"];
  }
  const reasons: string[] = [];
  if (input.lock.configHash !== input.resolved.configHash) {
    reasons.push("unsafe: stale lockfile: config hash differs from current config");
  }
  if (input.lock.graphVersion !== INDEXER_VERSION) {
    reasons.push(
      `unsafe: stale lockfile: graph version ${input.lock.graphVersion} differs from current ${INDEXER_VERSION} (re-run \`vibehard record\`)`,
    );
  }
  const expectedName = input.frameworkName ?? input.resolved.config?.framework ?? "playwright";
  const expectedVersion =
    input.frameworkVersion ?? frameworkVersion(input.rootDir, expectedName);
  if (
    input.lock.framework.name !== expectedName ||
    input.lock.framework.version !== expectedVersion
  ) {
    reasons.push(
      `unsafe: stale lockfile: framework ${input.lock.framework.name}@${input.lock.framework.version} differs from ${expectedName}@${expectedVersion}`,
    );
  }
  let allBase = true;
  let allHead = true;
  // The verdict is a universal quantifier over distinct (symbol,
  // expected hash) pairs among still-discovered tests — the same pair
  // recurs once per touching test, so check each pair once via the
  // inverted index. (Partial re-records can record one symbol under
  // different hashes in different entries; those conflicts are
  // checked per distinct expected hash.)
  const check = (id: string, expected: string | undefined): void => {
    if (expected === undefined || input.baseHashes[id] !== expected) allBase = false;
    if (expected === undefined || input.headHashes[id] !== expected) allHead = false;
  };
  const index = input.symbolIndex ?? buildSymbolTestIndex(input.lock);
  for (const [id, refs] of index) {
    // Almost every symbol carries one expected hash across all its
    // tests; only conflicting partial re-records allocate a set.
    let first: string | undefined;
    let seenFirst = false;
    let extra: Set<string | undefined> | undefined;
    for (const ref of refs) {
      if (!input.discoveredIds.has(ref.testId)) continue;
      const expected = input.lock.tests[ref.testId]?.symbolHashes[id];
      if (!seenFirst) {
        first = expected;
        seenFirst = true;
        check(id, expected);
      } else if (expected !== first) {
        extra ??= new Set<string | undefined>([first]);
        if (!extra.has(expected)) {
          extra.add(expected);
          check(id, expected);
        }
      }
    }
  }
  if (!allBase && !allHead) {
    reasons.push(
      "unsafe: stale lockfile: symbol hashes match neither the base nor the current source (re-run `vibehard verify`)",
    );
  }
  return reasons;
}

/**
 * Intersect changed symbols with recorded touched sets via the
 * inverted index. Shared by the full-index and fast selection paths
 * so both produce identical selections: tests stay in discovery
 * order, and each test's reasons are ordered test-file-changed,
 * test-support-changed, always-run, then unrecorded or changed
 * symbols sorted by ID.
 */
export function intersectSelection(input: {
  discovered: readonly ListedTest[];
  lock: VibehardLockfile | null;
  symbolIndex: SymbolTestIndex;
  changedSymbols: ReadonlySet<SymbolId>;
  changedSpecFiles: ReadonlySet<string>;
  /** Spec file -> changed support files it transitively imports. */
  changedSupportBySpec?: ReadonlyMap<string, readonly string[]>;
}): SelectedTest[] {
  const changedReasons = new Map<string, SelectionReason[]>();
  for (const id of [...input.changedSymbols].sort()) {
    for (const ref of input.symbolIndex.get(id) ?? []) {
      const list = changedReasons.get(ref.testId) ?? [];
      list.push({ type: "changed-symbol", symbol: id, via: ref.via });
      changedReasons.set(ref.testId, list);
    }
  }
  const selected: SelectedTest[] = [];
  for (const test of input.discovered) {
    const reasons: SelectionReason[] = [];
    const entry = input.lock?.tests[test.testId];
    if (input.changedSpecFiles.has(test.relFile)) {
      reasons.push({ type: "test-file-changed", file: test.relFile });
    }
    for (const file of input.changedSupportBySpec?.get(test.relFile) ?? []) {
      reasons.push({ type: "test-support-changed", file });
    }
    if (entry?.alwaysRun !== undefined) {
      reasons.push({ type: "always-run", reason: entry.alwaysRun });
    }
    if (entry === undefined) {
      reasons.push({ type: "unrecorded" });
    } else {
      reasons.push(...(changedReasons.get(test.testId) ?? []));
    }
    if (reasons.length > 0) selected.push({ ...toRef(test), reasons });
  }
  return selected;
}

/**
 * Resolve changed test-support files into selection inputs, shared by
 * both selection paths so the mapping (and its diagnostics) cannot
 * diverge. Files absent from `mappedFiles` keep the unsafe full run.
 */
export function resolveChangedSupportSelection(input: {
  rootDir: string;
  testDirPosix: string | null;
  specFiles: ReadonlySet<string>;
  changedSupport: readonly ChangedFile[];
  timer: PhaseTimer;
  diagnostics: string[];
}): { mappedFiles: ReadonlySet<string>; bySpec: Map<string, string[]> } {
  if (input.changedSupport.length === 0) {
    return { mappedFiles: new Set(), bySpec: new Map() };
  }
  const result = input.timer.runSync(
    "support.graph",
    () =>
      resolveChangedSupportFiles({
        rootDir: input.rootDir,
        testDirPosix: input.testDirPosix,
        specFiles: [...input.specFiles],
        changedSupport: input.changedSupport,
      }),
    (r) => ({
      files: r.stats.filesParsed,
      edges: r.stats.edges,
      specs: r.stats.specsMapped,
    }),
  );
  for (const problem of result.problems) {
    input.diagnostics.push(`test-support mapping unavailable: ${problem}`);
  }
  return {
    mappedFiles: new Set(result.mapped.keys()),
    bySpec: supportFilesBySpec(result.mapped),
  };
}

/**
 * Compute the exact test selection for the working tree against a base
 * revision. Never guesses: anything that cannot be mapped to symbols (or
 * to a trusted lockfile) is reported as an unsafe reason instead.
 *
 * With `fastSelect` enabled, the diff-proportional path in
 * `fast-select.ts` runs first; any failure there falls back to the
 * full-index algorithm below, with a diagnostic recording the
 * fallback (a genuine usage error is re-raised by the full path).
 */
export async function selectTests(options: SelectOptions): Promise<SelectionResult> {
  if (fastSelectEnabled(options.fastSelect)) {
    try {
      return await selectTestsFast(options);
    } catch (error) {
      const result = await selectTestsFull(options);
      result.diagnostics.unshift(
        `fast selection unavailable (${error instanceof Error ? error.message : String(error)}); used full indexing`,
      );
      return result;
    }
  }
  return selectTestsFull(options);
}

async function selectTestsFull(options: SelectOptions): Promise<SelectionResult> {
  const timer = new PhaseTimer(timingEnabled(options.timing));
  const rootDir = path.resolve(options.rootDir);
  const resolved = await timer.run("config.load", () => loadConfig(rootDir, options.configPath));
  const diagnostics: string[] = [];
  const unsafeReasons: string[] = [];

  const { gitRoot, base } = await timer.run("git.base", async () => {
    const gitRoot = await resolveGitRoot(rootDir);
    const base = await resolveBase(gitRoot, {
      ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
      ...(resolved.baseBranch !== undefined ? { baseBranch: resolved.baseBranch } : {}),
    });
    return { gitRoot, base };
  });

  const changedFiles: ChangedFile[] = await timer.run(
    "git.changedFiles",
    () => listChangedFiles(gitRoot, base.sha),
    (files) => ({ files: files.length }),
  );
  const patchText = await timer.run("git.diffPatch", () => diffPatch(gitRoot, base.sha), (text) => ({
    bytes: Buffer.byteLength(text),
  }));
  const patches = timer.runSync("diff.parse", () => parseUnifiedDiff(patchText, gitRoot.prefix));
  const patchByFile = new Map<string, FilePatch>();
  for (const patch of patches) {
    const key = patch.newFile ?? patch.oldFile;
    if (key !== null) patchByFile.set(key, patch);
  }

  const driver = getFrameworkDriver(resolved.config.framework);
  const discovered = await timer.run(
    "tests.discovery",
    () => driver.listTests(rootDir, resolved),
    (tests) => ({ tests: tests.length }),
  );
  const discoveredIds = new Set(discovered.map((t) => t.testId));
  const specFiles = new Set(discovered.map((t) => t.relFile));

  const headIndex = await timer.run("index.head", () => indexProject(rootDir), (index) => ({
    files: index.stats.filesTotal,
    filesParsed: index.stats.filesParsed,
    symbols: index.symbols.length,
  }));
  const headSymbols = filterSymbols(headIndex.symbols, resolved);
  const headHashes = timer.runSync("hash.head", () => hashOrEmpty(rootDir, headSymbols), {
    symbols: headSymbols.length,
  });

  let baseSymbols: SymbolRecord[] = [];
  let baseHashes: Record<string, string> = {};
  let baseRoot: string | null = null;
  let worktree: Awaited<ReturnType<typeof createBaseWorktree>> | null = null;
  try {
    worktree = await timer.run("git.baseWorktree.create", () =>
      createBaseWorktree(gitRoot, base.sha),
    );
    if (baseProjectExists(worktree)) {
      baseRoot = worktree.projectRoot;
      const baseIndex = await timer.run("index.base", () => indexProject(baseRoot as string), (index) => ({
        files: index.stats.filesTotal,
        filesParsed: index.stats.filesParsed,
        symbols: index.symbols.length,
      }));
      baseSymbols = filterSymbols(baseIndex.symbols, resolved);
      baseHashes = timer.runSync("hash.base", () => hashOrEmpty(baseRoot as string, baseSymbols), {
        symbols: baseSymbols.length,
      });
    } else {
      diagnostics.push("project root does not exist at the base revision; every file is new");
    }
  } catch (error) {
    unsafeReasons.push(
      `unsafe: could not index base revision ${base.sha}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const changedSymbols = new Set<SymbolId>();
  const changedSpecFiles = new Set<string>();
  const lockfileRel = toPosix(path.relative(rootDir, resolved.lockfilePath));
  const baseByFile = groupByFile(baseSymbols);
  const headByFile = groupByFile(headSymbols);
  const assetFiles = new Set<string>();
  for (const s of [...baseSymbols, ...headSymbols]) {
    if (s.kind === "asset") assetFiles.add(s.file);
  }

  const classifyCtx = {
    ignore: resolved.ignore,
    include: resolved.include,
    testDirPosix: resolved.testDirPosix,
    specFiles,
    lockfileRel,
    assetFiles,
  };
  const supportSelection = resolveChangedSupportSelection({
    rootDir,
    testDirPosix: resolved.testDirPosix,
    specFiles,
    changedSupport: changedFiles.filter(
      (c) => classifyChangedFile(c.file, classifyCtx) === "test-support",
    ),
    timer,
    diagnostics,
  });

  const endChangedSymbols = timer.span("selection.changedSymbols");
  try {
    for (const change of changedFiles) {
      const kind = classifyChangedFile(change.file, classifyCtx);
      switch (kind) {
        case "ignored":
          break;
        case "lockfile":
          diagnostics.push(`lockfile changed (${change.file}); trusting it only if hashes prove out`);
          break;
        case "config":
          unsafeReasons.push(`unsafe: unmapped change: ${change.file} (config file)`);
          break;
        case "spec":
          changedSpecFiles.add(change.file);
          break;
        case "test-support":
          if (!supportSelection.mappedFiles.has(change.file)) {
            unsafeReasons.push(`unsafe: unmapped change: ${change.file} (test support file)`);
          }
          break;
        case "unmapped":
          unsafeReasons.push(`unsafe: unmapped change: ${change.file}`);
          break;
        case "app":
        case "asset": {
          const patch = patchByFile.get(change.file);
          const result = computeChangedSymbolsForFile({
            status: change.status,
            baseSymbols: baseByFile.get(change.file) ?? [],
            headSymbols: headByFile.get(change.file) ?? [],
            baseHashes,
            headHashes,
            hunks: patch?.hunks ?? [],
            binary: patch?.binary ?? false,
            baseText:
              baseRoot === null ? null : readTextOrNull(path.resolve(baseRoot, change.file)),
            headText: readTextOrNull(path.resolve(rootDir, change.file)),
          });
          for (const id of result.changedSymbols) changedSymbols.add(id);
          if (result.unmappedLines) {
            unsafeReasons.push(
              `unsafe: unmapped change: ${change.file} (changed lines outside any symbol)`,
            );
          }
          break;
        }
      }
    }
  } finally {
    endChangedSymbols({
      files: changedFiles.length,
      symbols: changedSymbols.size,
    });
    if (worktree !== null) {
      await timer.run("git.baseWorktree.cleanup", () => worktree.cleanup());
    }
  }

  let lock: VibehardLockfile | null = null;
  let lockError: string | null = null;
  const endLockLoad = timer.span("lockfile.load");
  let lockBytes = 0;
  try {
    if (existsSync(resolved.lockfilePath)) {
      if (timer.enabled) lockBytes = statSync(resolved.lockfilePath).size;
      lock = readLockfile(resolved.lockfilePath);
    }
  } catch (error) {
    lockError = error instanceof Error ? error.message : String(error);
  } finally {
    const entries = lock === null ? [] : Object.values(lock.tests);
    endLockLoad({
      bytes: lockBytes,
      tests: entries.length,
      edges: entries.reduce((sum, entry) => sum + Object.keys(entry.touched).length, 0),
    });
  }
  const symbolIndex = buildSymbolTestIndex(lock);
  timer.runSync("lockfile.trust", () => {
    unsafeReasons.push(
      ...lockfileTrustReasons({
        lock,
        lockError,
        resolved,
        rootDir,
        frameworkName: driver.name,
        frameworkVersion: driver.version(rootDir),
        discoveredIds,
        baseHashes,
        headHashes,
        symbolIndex,
      }),
    );
  });

  const endIntersect = timer.span("selection.intersect");
  const selected = intersectSelection({
    discovered,
    lock,
    symbolIndex,
    changedSymbols,
    changedSpecFiles,
    changedSupportBySpec: supportSelection.bySpec,
  });
  endIntersect({ tests: discovered.length, selected: selected.length });

  return {
    base,
    changedFiles: changedFiles.map((c) => c.file),
    changedSymbols: [...changedSymbols].sort(),
    discovered: discovered.map(toRef),
    selected,
    unsafeReasons,
    unsafeReason: unsafeReasons[0] ?? null,
    diagnostics,
    ...(timer.enabled ? { timing: timer.snapshot() } : {}),
  };
}
