import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScriptInput } from "../observer/types.js";
import { indexProject, INDEXER_VERSION } from "../indexer/index.js";
import { mergeObservedSets, observeIstanbul, observeScripts, type IstanbulCoverage } from "../observer/index.js";
import { selectTests } from "../selector/select.js";
import { filterSymbols, loadConfig, resolveGeneratedPaths, type ResolvedConfig } from "./config.js";
import { getFrameworkDriver, type FrameworkDriver } from "./driver.js";
import {
  checkLockfile,
  emptyLockfile,
  hashesForTouched,
  hashSymbolSources,
  readLockfile,
  writeLockfile,
  type LockfileTestEntry,
  type VibehardLockfile,
} from "./lockfile.js";
import { readArtifacts, type ListedTest } from "./listed.js";
import { startServers } from "./servers.js";
import {
  discoveredSetHash,
  formatShardSpec,
  mergeShardArtifactList,
  readShardArtifact,
  shardSourceState,
  shardTests,
  validateShardSpec,
  writeShardArtifact,
} from "./shards.js";
import {
  PhaseTimer,
  formatPhaseTimings,
  timingEnabled,
  type PhaseTiming,
} from "../timing.js";
import { computeTouchedSet, diffTouchedSets, type TouchedSet } from "./touched.js";
import {
  VibehardUsageError,
  type MergeShardsOptions,
  type MergeShardsResult,
  type ProjectVerifyResult,
  type TestVerifyResult,
  type VerifyProjectOptions,
} from "./types.js";

/** Validate the `--jobs` lane count; shared by record and verify. */
export function resolveJobs(options: VerifyProjectOptions): number {
  const jobs = options.jobs ?? 1;
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new VibehardUsageError(
      `vibehard: --jobs must be a positive integer (got ${String(options.jobs)})`,
    );
  }
  return jobs;
}

export async function verifyProject(options: VerifyProjectOptions): Promise<ProjectVerifyResult> {
  return runProject("verify", options);
}

export async function recordProject(options: VerifyProjectOptions): Promise<ProjectVerifyResult> {
  if (options.incremental !== true) return runProject("record", options);
  // Incremental record: selection decides which tests could have
  // changed touched sets (changed symbols, unrecorded tests, changed
  // spec files, alwaysRun); only those are re-observed. Everything
  // else keeps its recorded entry, which stays valid by the same
  // argument selection itself uses. Any unsafe selection refuses the
  // run — a full record is the only sound fallback.
  if (options.shard !== undefined) {
    throw new VibehardUsageError("vibehard: --incremental cannot be combined with --shard");
  }
  if ((options.filter ?? []).length > 0) {
    throw new VibehardUsageError("vibehard: --incremental cannot be combined with test filters");
  }
  const selection = await selectTests({
    rootDir: options.rootDir,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
    ...(options.fastSelect !== undefined ? { fastSelect: options.fastSelect } : {}),
    ...(options.timing !== undefined ? { timing: options.timing } : {}),
  });
  if (selection.unsafeReasons.length > 0) {
    throw new VibehardUsageError(
      `vibehard: incremental record requires a safe selection (${selection.unsafeReasons[0]}); run a full \`vibehard record\``,
    );
  }
  return runProject(
    "record",
    { ...options, incremental: false },
    {
      testIds: selection.selected.map((t) => t.testId),
      pruneUndiscovered: true,
      incremental: true,
    },
  );
}

/**
 * Merge a complete set of `record --shard` artifacts into the
 * lockfile. No tests are observed: the artifacts must agree on
 * provenance, cover every shard exactly once, and union to the
 * discovered set they recorded against, and their provenance must
 * match this project's current config and framework.
 */
export async function mergeShardArtifacts(
  options: MergeShardsOptions,
): Promise<MergeShardsResult> {
  const rootDir = path.resolve(options.rootDir);
  if (options.files.length === 0) {
    throw new VibehardUsageError("vibehard: record --merge requires at least one shard artifact file");
  }
  const resolved = await loadConfig(rootDir, options.configPath);
  const driver = getFrameworkDriver(resolved.config.framework);
  const frameworkVersion = driver.version(rootDir);
  const inputs = options.files.map((file) => {
    const resolvedFile = path.resolve(rootDir, file);
    return { file: resolvedFile, artifact: readShardArtifact(resolvedFile) };
  });
  const merged = mergeShardArtifactList(inputs);
  if (merged.provenance.configHash !== resolved.configHash) {
    throw new VibehardUsageError(
      "vibehard: cannot merge shard artifacts: provenance config hash differs from the current config",
    );
  }
  if (
    merged.provenance.framework.name !== driver.name ||
    merged.provenance.framework.version !== frameworkVersion
  ) {
    throw new VibehardUsageError(
      `vibehard: cannot merge shard artifacts: provenance framework ${merged.provenance.framework.name}@${merged.provenance.framework.version} differs from ${driver.name}@${frameworkVersion}`,
    );
  }
  const written = mergeAndWriteLockfile(resolved, driver, frameworkVersion, merged.entries, {
    fullRun: true,
    discoveredTestIds: new Set(merged.entries.keys()),
    freshOnUnreadable: true,
  });
  return {
    ok: true,
    exitCode: 0,
    rootDir,
    shards: merged.total,
    tests: merged.entries.size,
    lockfile: { path: resolved.lockfilePath, written },
    diagnostics: [],
  };
}

/** Human-readable report for `record --merge`. */
export function formatMergeReport(result: MergeShardsResult): string {
  return `record --merge: ${result.tests} test(s) from ${result.shards} shard(s); lockfile ${result.lockfile.written ? "updated" : "unchanged"} (${result.lockfile.path})\n`;
}

function sameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

interface RunProjectInternal {
  /** Observe exactly these test IDs (incremental record subset). */
  testIds?: readonly string[];
  /** Prune lockfile entries discovery no longer finds, subset or not. */
  pruneUndiscovered?: boolean;
  incremental?: boolean;
}

async function runProject(
  mode: "verify" | "record",
  options: VerifyProjectOptions,
  internal: RunProjectInternal = {},
): Promise<ProjectVerifyResult> {
  if (mode === "verify" && options.incremental === true) {
    throw new VibehardUsageError("vibehard: --incremental is only valid for record");
  }
  const jobs = resolveJobs(options);
  const shard = options.shard ?? null;
  if (shard !== null) {
    validateShardSpec(shard);
    if ((options.filter ?? []).length > 0) {
      throw new VibehardUsageError("vibehard: --shard cannot be combined with test filters");
    }
  }
  if (options.shardOut !== undefined && (shard === null || mode !== "record")) {
    throw new VibehardUsageError("vibehard: --shard-out is only valid for record --shard");
  }
  const timer = new PhaseTimer(timingEnabled(options.timing));
  const rootDir = path.resolve(options.rootDir);
  const resolved: ResolvedConfig = await timer.run("config.load", () =>
    loadConfig(rootDir, options.configPath),
  );
  if (resolved.config.app?.external === true) {
    throw new VibehardUsageError(
      "vibehard: app.external cannot be verified or recorded (per-test server coverage needs Vibehard to start the app); remove external for verify/record — `vibehard test` accepts it",
    );
  }
  const ci = mode === "verify" && (options.ci ?? false);

  const index = await timer.run("index", () => indexProject(rootDir), (result) => ({
    files: result.stats.filesTotal,
    filesParsed: result.stats.filesParsed,
    symbols: result.symbols.length,
  }));
  const symbols = filterSymbols(index.symbols, resolved);
  const allHashes = timer.runSync("hash.allSymbols", () => hashSymbolSources(rootDir, symbols), {
    symbols: symbols.length,
  });
  const driver = getFrameworkDriver(resolved.config.framework);
  const frameworkVersion = driver.version(rootDir);

  const discovered = await timer.run(
    "tests.discovery",
    () => driver.listTests(rootDir, resolved),
    (tests) => ({ tests: tests.length }),
  );
  const filters = options.filter ?? [];
  let selected = discovered.filter(
    (t) =>
      filters.length === 0 ||
      filters.some((f) => t.relFile.includes(f) || t.title.includes(f) || t.testId.includes(f)),
  );
  if (selected.length === 0) {
    throw new VibehardUsageError(
      filters.length === 0
        ? `vibehard: no ${driver.name} tests discovered`
        : `vibehard: no tests match filter: ${filters.join(", ")}`,
    );
  }
  // A shard may legitimately be empty (more shards than tests, or an
  // unlucky hash split); it still writes its artifact so a merge can
  // prove the shard ran.
  if (shard !== null) selected = shardTests(selected, shard);
  if (internal.testIds !== undefined) {
    // Incremental subset: every selected ID must still be discovered,
    // or a test selection said could have drifted would be skipped.
    const wanted = new Set(internal.testIds);
    const found = new Set(selected.filter((t) => wanted.has(t.testId)).map((t) => t.testId));
    for (const testId of wanted) {
      if (!found.has(testId)) {
        throw new VibehardUsageError(
          `vibehard: incremental selection named ${testId}, which discovery no longer finds; run a full \`vibehard record\``,
        );
      }
    }
    selected = selected.filter((t) => wanted.has(t.testId));
  }

  // In verify mode the stored touched sets are the comparison target.
  // A missing lockfile is drift per test, not a usage error; an
  // unreadable (e.g. v1) lockfile fails closed from readLockfile.
  const existingLock: VibehardLockfile | null =
    mode === "verify"
      ? timer.runSync("lockfile.load", () => readLockfile(resolved.lockfilePath))
      : null;

  const generated = resolveGeneratedPaths(resolved);
  const runTemp = mkdtempSync(path.join(tmpdir(), "vibehard-run-"));
  const resolveMapFile = path.join(runTemp, "resolve-map.json");
  const resolveRules = (resolved.config.generatedScripts ?? []).map((r) => ({
    urlEndsWith: r.urlEndsWith,
    path: path.resolve(rootDir, r.path),
  }));
  writeFileSync(resolveMapFile, JSON.stringify(resolveRules));

  const results: TestVerifyResult[] = [];
  const entries = new Map<string, LockfileTestEntry>();
  const endObservations = timer.span("observation.total");
  try {
    // Lane pool: `jobs` workers pull tests from the selected list and
    // each runs the unchanged per-test observation (own servers, own
    // framework process, record-twice in record mode). Outcomes are
    // slotted by selected index and replayed in discovered order, so
    // results, reports, and lockfile bytes match a serial run. A test
    // failure never cancels sibling tests; a thrown usage error
    // (e.g. a server that cannot start) stops scheduling, settles
    // in-flight observations, and propagates like a serial run.
    const outcomes: ({ result: TestVerifyResult; entry: LockfileTestEntry | null } | undefined)[] =
      new Array(selected.length).fill(undefined);
    let nextIndex = 0;
    let fatal: unknown = null;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (fatal !== null) return;
        const index = nextIndex;
        nextIndex += 1;
        const test = selected[index];
        if (test === undefined) return;
        try {
          outcomes[index] = await runOneTest({
            mode,
            rootDir,
            resolved,
            driver,
            test,
            symbols,
            generated,
            resolveMapFile,
            resolveRules,
            existingEntry: existingLock?.tests[test.testId] ?? null,
            timer,
          });
        } catch (error) {
          if (fatal === null) fatal = error;
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(jobs, selected.length)) }, () => worker()),
    );
    for (const outcome of outcomes) {
      if (outcome === undefined) continue;
      results.push(outcome.result);
      if (outcome.entry !== null) entries.set(outcome.result.testId, outcome.entry);
    }
    if (fatal !== null) throw fatal;
  } finally {
    endObservations({ tests: results.length });
    rmSync(runTemp, { recursive: true, force: true });
  }

  const diagnostics: string[] = [];
  const alwaysRunCount = results.filter((r) => r.alwaysRun !== null).length;
  let drift: string[] = [];
  let written = false;

  const hasTestFailure = results.some((r) => r.status === "test-failed");
  const hasFailure = results.some((r) =>
    ["drift", "unstable", "unmappable", "error"].includes(r.status),
  );

  // A filtered or sharded run observed a subset: it may merge its
  // entries but must never prune lockfile entries it did not observe.
  // Incremental record is the exception: discovery ran in full, so
  // entries discovery no longer finds are deleted tests and prune.
  const observedAllDiscovered = filters.length === 0 && shard === null;
  const pruneUndiscovered = internal.pruneUndiscovered ?? observedAllDiscovered;
  let shardArtifactPath: string | null = null;
  const endLockfilePhase = timer.span("lockfile.checkOrWrite");
  if (mode === "record" && shard !== null) {
    // A record shard never touches the lockfile. The artifact carries
    // entries plus per-test statuses (failed shards still write one;
    // the merge refuses them) and the provenance merges validate.
    shardArtifactPath = path.resolve(
      rootDir,
      options.shardOut ?? `vibehard-shard-${shard.index}-of-${shard.total}.json`,
    );
    const source = await shardSourceState(rootDir);
    writeShardArtifact(shardArtifactPath, {
      kind: "vibehard-shard",
      version: 1,
      shard,
      provenance: {
        configHash: resolved.configHash,
        framework: { name: driver.name, version: frameworkVersion },
        graphVersion: INDEXER_VERSION,
        source,
        discovered: {
          count: discovered.length,
          hash: discoveredSetHash(discovered.map((t) => t.testId)),
        },
      },
      tests: Object.fromEntries(entries),
      results: results.map((r) => ({ testId: r.testId, status: r.status })),
    });
  } else if (mode === "verify" && ci) {
    drift = checkLockfile(existingLock, {
      configHash: resolved.configHash,
      frameworkVersion,
      frameworkName: driver.name,
      expectations: results.map((r) => ({
        testId: r.testId,
        touched: r.touched,
        symbolHashes: allHashes,
      })),
      fullRun: observedAllDiscovered,
      discoveredTestIds: new Set(discovered.map((t) => t.testId)),
    });
    const budget = resolved.alwaysRunBudget ?? 0;
    if (alwaysRunCount > budget) {
      diagnostics.push(
        `alwaysRun count ${alwaysRunCount} exceeds budget ${budget} under --ci`,
      );
    }
  } else if (mode === "verify" && !hasTestFailure && !hasFailure) {
    written = mergeAndWriteLockfile(resolved, driver, frameworkVersion, entries, {
      fullRun: pruneUndiscovered,
      discoveredTestIds: new Set(discovered.map((t) => t.testId)),
      freshOnUnreadable: false,
    });
  } else if (mode === "record" && (entries.size > 0 || internal.pruneUndiscovered === true)) {
    written = mergeAndWriteLockfile(resolved, driver, frameworkVersion, entries, {
      fullRun: pruneUndiscovered,
      discoveredTestIds: new Set(discovered.map((t) => t.testId)),
      freshOnUnreadable: true,
    });
  }
  endLockfilePhase();

  const exitCode: 0 | 1 | 2 = hasTestFailure
    ? 1
    : hasFailure || drift.length > 0 || diagnostics.length > 0
      ? 2
      : 0;
  const passed = results.filter((r) => r.status === "pass" || r.status === "recorded").length;

  return {
    ok: exitCode === 0,
    mode,
    jobs,
    shard,
    shardArtifact: shardArtifactPath,
    incremental: internal.incremental ?? false,
    ci,
    exitCode,
    rootDir,
    results,
    lockfile: { path: resolved.lockfilePath, written, drift },
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed - alwaysRunCount,
      alwaysRunCount,
    },
    diagnostics,
    ...(timer.enabled ? { timing: timer.snapshot() } : {}),
  };
}

function mergeAndWriteLockfile(
  resolved: ResolvedConfig,
  driver: FrameworkDriver,
  frameworkVersion: string,
  entries: ReadonlyMap<string, LockfileTestEntry>,
  scope: {
    fullRun: boolean;
    discoveredTestIds: ReadonlySet<string>;
    /** Record mode: start fresh when the old lockfile is unreadable (v1). */
    freshOnUnreadable: boolean;
  },
): boolean {
  let lock: VibehardLockfile | null = null;
  try {
    lock = readLockfile(resolved.lockfilePath);
  } catch (error) {
    if (!scope.freshOnUnreadable) throw error;
  }
  lock ??= emptyLockfile(resolved.configHash, frameworkVersion, driver.name);
  lock.framework = { name: driver.name, version: frameworkVersion };
  lock.configHash = resolved.configHash;
  lock.graphVersion = INDEXER_VERSION;
  if (scope.fullRun) {
    for (const testId of Object.keys(lock.tests)) {
      if (!scope.discoveredTestIds.has(testId)) delete lock.tests[testId];
    }
  }
  for (const [testId, entry] of entries) lock.tests[testId] = entry;
  return writeLockfile(resolved.lockfilePath, lock);
}

interface RunOneInput {
  mode: "verify" | "record";
  rootDir: string;
  resolved: ResolvedConfig;
  driver: FrameworkDriver;
  test: ListedTest;
  symbols: ReturnType<typeof filterSymbols>;
  generated: string[];
  resolveMapFile: string;
  resolveRules: { urlEndsWith: string; path: string }[];
  existingEntry: LockfileTestEntry | null;
  timer: PhaseTimer;
}

interface Observation {
  observed: string[];
  touched: TouchedSet;
  ok: boolean;
  unmappable: TestVerifyResult["unmappable"];
  diagnostics: string[];
  alwaysRun: string | null;
  testFailed: boolean;
  skipped: boolean;
  artifactMissing: string | null;
  errors: string[];
  timing: PhaseTiming[];
}

async function observeOnce(input: RunOneInput): Promise<Observation> {
  const { test, resolved, rootDir } = input;
  const obsTimer = new PhaseTimer(input.timer.enabled);
  const artifactDir = mkdtempSync(path.join(tmpdir(), "vibehard-art-"));
  try {
    const servers = await obsTimer.run("observation.serverStart", () =>
      startServers(resolved),
    );
    let run: Awaited<ReturnType<FrameworkDriver["runSingleTest"]>>;
    let serverScripts: ScriptInput[] = [];
    try {
      run = await obsTimer.run("observation.frameworkRun", () =>
        input.driver.runSingleTest({
          rootDir,
          resolved,
          test,
          env: {
            VIBEHARD_ARTIFACT_DIR: artifactDir,
            VIBEHARD_RESOLVE_MAP: input.resolveMapFile,
            ...servers.env,
          },
        }),
      );
    } finally {
      serverScripts = await obsTimer.run("observation.serverStop", async () =>
        servers.stop().catch(() => []),
      );
    }

    const endArtifactRead = obsTimer.span("observation.artifactRead");
    const artifacts = readArtifacts(artifactDir);
    const artifact =
      artifacts.find((a) => sameFile(a.file, test.file) && a.line === test.line) ??
      artifacts.find((a) => sameFile(a.file, test.file) && a.title === test.title) ??
      (artifacts.length === 1 ? artifacts[0] : undefined);
    endArtifactRead();

    const testFailed =
      run.exitCode !== 0 ||
      (artifact !== undefined &&
        ["failed", "timedOut", "interrupted"].includes(artifact.status));

    if (artifact === undefined) {
      const tail = (run.stderr || run.stdout).trim().slice(-800);
      return {
        observed: [],
        touched: {},
        ok: false,
        unmappable: [],
        diagnostics: [
          testFailed
            ? `${input.driver.name} run failed (exit ${run.exitCode}) and no vibehard artifact was written`
            : `no vibehard artifact was written; ${input.driver.missingArtifactHint}`,
          ...(tail !== "" ? [tail] : []),
        ],
        alwaysRun: null,
        testFailed,
        skipped: false,
        artifactMissing: "no artifact",
        errors: [],
        timing: obsTimer.snapshot(false),
      };
    }

    const clientScripts = artifact.clientScripts.map((script) => {
      if (script.sourcePath !== null && script.sourcePath !== undefined && script.sourcePath !== "") {
        return script;
      }
      const rule = input.resolveRules.find((r) => script.url.endsWith(r.urlEndsWith));
      return rule === undefined ? script : { ...script, sourcePath: rule.path };
    });
    const observed = obsTimer.runSync("observation.coverageMap", () => {
      let result = observeScripts([...clientScripts, ...serverScripts], {
        rootDir,
        symbols: input.symbols,
        appGeneratedPaths: input.generated,
      });
      if (artifact.istanbul !== undefined) {
        result = mergeObservedSets(
          result,
          observeIstanbul(artifact.istanbul as IstanbulCoverage | null, {
            rootDir,
            symbols: input.symbols,
          }),
        );
      } else if (input.driver.name === "cypress") {
        result = mergeObservedSets(
          result,
          observeIstanbul(null, { rootDir, symbols: input.symbols }),
        );
      }
      return result;
    });
    const touched = obsTimer.runSync("observation.touchedCompute", () =>
      computeTouchedSet(observed.merged, input.symbols),
    );

    return {
      observed: observed.merged,
      touched,
      ok: observed.ok,
      unmappable: observed.unmappable,
      diagnostics: observed.diagnostics.filter((d) => !d.startsWith("excluded script:")),
      alwaysRun: artifact.options.alwaysRun,
      testFailed,
      skipped: artifact.status === "skipped",
      artifactMissing: null,
      errors: artifact.errors,
      timing: obsTimer.snapshot(false),
    };
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function entryFor(
  input: RunOneInput,
  touched: TouchedSet,
  alwaysRun: string | null,
): LockfileTestEntry {
  const entry: LockfileTestEntry = {
    file: input.test.relFile,
    titlePath: input.test.titlePath,
    touched,
    symbolHashes: hashesForTouched(input.rootDir, input.symbols, touched),
  };
  if (alwaysRun !== null) entry.alwaysRun = alwaysRun;
  return entry;
}

async function runOneTest(
  input: RunOneInput,
): Promise<{ result: TestVerifyResult; entry: LockfileTestEntry | null }> {
  const { test } = input;
  const base: TestVerifyResult = {
    testId: test.testId,
    file: test.relFile,
    title: test.title,
    titlePath: test.titlePath,
    status: "error",
    observed: [],
    touched: null,
    added: [],
    removed: [],
    unstableSymbols: [],
    unmappable: [],
    diagnostics: [],
    alwaysRun: null,
  };

  const testTimer = new PhaseTimer(input.timer.enabled);
  const observations: PhaseTiming[][] = [];
  const noteObservation = (observation: Observation): void => {
    if (!input.timer.enabled) return;
    observations.push(observation.timing);
    testTimer.absorb(observation.timing);
    input.timer.absorb(observation.timing);
    base.timing = {
      observationCount: observations.length,
      phases: testTimer.snapshot(false),
      observations: [...observations],
    };
  };
  const makeEntry = (touched: TouchedSet, alwaysRun: string | null): LockfileTestEntry => {
    const hashTimer = new PhaseTimer(input.timer.enabled);
    const entry = hashTimer.runSync("observation.hashTouched", () =>
      entryFor(input, touched, alwaysRun),
    );
    if (input.timer.enabled) {
      const phases = hashTimer.snapshot(false);
      testTimer.absorb(phases);
      input.timer.absorb(phases);
      base.timing = {
        observationCount: observations.length,
        phases: testTimer.snapshot(false),
        observations: [...observations],
      };
    }
    return entry;
  };

  const first = await observeOnce(input);
  noteObservation(first);
  base.observed = first.observed;
  base.touched = first.touched;
  base.unmappable = first.unmappable;
  base.diagnostics.push(...first.diagnostics);
  base.alwaysRun = first.alwaysRun;

  if (first.artifactMissing !== null) {
    base.status = first.testFailed ? "test-failed" : "error";
    base.touched = null;
    return { result: base, entry: null };
  }
  if (first.testFailed) {
    base.status = "test-failed";
    base.touched = null;
    if (first.errors.length > 0) base.diagnostics.push(...first.errors.slice(0, 2));
    return { result: base, entry: null };
  }
  if (first.skipped) {
    base.status = "error";
    base.touched = null;
    base.diagnostics.push("test was skipped at runtime; its touched set cannot be recorded");
    return { result: base, entry: null };
  }
  if (first.alwaysRun !== null) {
    base.status = "always-run";
    base.touched = {};
    return { result: base, entry: makeEntry({}, first.alwaysRun) };
  }
  if (!first.ok) {
    base.status = "unmappable";
    base.touched = null;
    return { result: base, entry: null };
  }

  if (input.mode === "record") {
    // Record observes twice: a touched set that is not reproducible
    // is reported unstable and never written.
    const second = await observeOnce(input);
    noteObservation(second);
    if (second.testFailed || second.artifactMissing !== null) {
      base.status = second.testFailed ? "test-failed" : "error";
      base.touched = null;
      base.diagnostics.push(...second.diagnostics);
      return { result: base, entry: null };
    }
    if (!second.ok) {
      base.status = "unmappable";
      base.touched = null;
      base.unmappable = second.unmappable;
      return { result: base, entry: null };
    }
    const diff = diffTouchedSets(first.touched, second.touched);
    const unstable = [...diff.added, ...diff.removed].sort();
    if (unstable.length > 0) {
      base.status = "unstable";
      base.unstableSymbols = unstable;
      base.diagnostics.push(
        "touched set differed between two record runs; fix the nondeterminism or mark the test alwaysRun",
      );
      return { result: base, entry: null };
    }
    base.status = "recorded";
    return { result: base, entry: makeEntry(first.touched, null) };
  }

  // verify mode: drift is any difference from the stored touched set.
  if (input.existingEntry === null) {
    base.status = "drift";
    base.added = Object.keys(first.touched).sort();
    base.diagnostics.push("test is not in the lockfile; run `vibehard record`");
    return { result: base, entry: null };
  }
  const diff = diffTouchedSets(input.existingEntry.touched, first.touched);
  base.added = diff.added;
  base.removed = diff.removed;
  if (diff.added.length === 0 && diff.removed.length === 0) {
    base.status = "pass";
    return { result: base, entry: makeEntry(first.touched, null) };
  }
  base.status = "drift";
  return { result: base, entry: null };
}

/** Human-readable report for the CLI (no --json). */
export function formatVerifyReport(result: ProjectVerifyResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    const tag =
      r.status === "pass" || r.status === "recorded"
        ? "PASS"
        : r.status === "always-run"
          ? "ALWAYS-RUN"
          : "FAIL";
    lines.push(`${tag} ${r.testId}${r.status === "pass" ? "" : ` (${r.status})`}`);
    for (const id of r.added) lines.push(`  added (touched now, not recorded): ${id}`);
    for (const id of r.removed) lines.push(`  removed (recorded, not touched now): ${id}`);
    for (const id of r.unstableSymbols) lines.push(`  unstable: ${id}`);
    for (const u of r.unmappable) lines.push(`  unmappable (${u.origin}): ${u.url} — ${u.reason}`);
    if (r.touched !== null && (r.status === "pass" || r.status === "recorded")) {
      lines.push(`  touched: ${Object.keys(r.touched).length} symbol(s)`);
    }
    for (const d of r.diagnostics) lines.push(`  ${d}`);
  }
  for (const d of result.lockfile.drift) lines.push(`lockfile drift: ${d}`);
  if (result.incremental) {
    lines.push(
      "incremental record: only change-selected tests were re-observed (pair with periodic full `vibehard verify`)",
    );
  }
  if (result.shardArtifact !== null && result.shard !== null) {
    lines.push(
      `shard ${formatShardSpec(result.shard)}: wrote ${result.shardArtifact} (lockfile untouched; merge with \`vibehard record --merge\`)`,
    );
  }
  for (const d of result.diagnostics) lines.push(d);
  const timingText = formatPhaseTimings("timing", result.timing);
  if (timingText !== "") {
    lines.push(timingText.trimEnd());
    const slowest = result.results
      .flatMap((r) =>
        r.timing === undefined
          ? []
          : [
              {
                testId: r.testId,
                totalMs: r.timing.phases.reduce((sum, p) => sum + p.durationMs, 0),
              },
            ],
      )
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 10);
    if (slowest.length > 0) {
      lines.push("slowest tests (observation):");
      for (const entry of slowest) {
        lines.push(`  ${entry.testId}  ${entry.totalMs.toFixed(2)} ms`);
      }
    }
  }
  lines.push(
    `${result.mode}: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.total} total; alwaysRun: ${result.summary.alwaysRunCount} test(s); lockfile ${result.lockfile.written ? "updated" : "unchanged"} (${result.lockfile.path})`,
  );
  return `${lines.join("\n")}\n`;
}
