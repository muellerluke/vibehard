import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ScriptInput } from "../observer/types.js";
import { indexProject } from "../indexer/index.js";
import { observeScripts } from "../observer/index.js";
import { filterSymbols, loadConfig, resolveGeneratedPaths, type ResolvedConfig } from "./config.js";
import { CodemodError, rewriteDeclaration, type ExtractOptions } from "./declarations.js";
import { diffDeclaredObserved } from "./diff.js";
import {
  checkLockfile,
  emptyLockfile,
  hashSymbolSources,
  playwrightTestVersion,
  readLockfile,
  writeLockfile,
  type LockfileTestEntry,
  type VibehardLockfile,
} from "./lockfile.js";
import {
  freePort,
  listTests,
  readArtifacts,
  resolvePlaywrightCli,
  runSingleTest,
  startAppServer,
  type ListedTest,
} from "./playwright-runner.js";
import {
  VibehardUsageError,
  type ProjectVerifyResult,
  type TestVerifyResult,
  type VerifyProjectOptions,
} from "./types.js";

export async function verifyProject(options: VerifyProjectOptions): Promise<ProjectVerifyResult> {
  return runProject("verify", options);
}

export async function recordProject(options: VerifyProjectOptions): Promise<ProjectVerifyResult> {
  return runProject("record", options);
}

function sameFile(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function makeReadImport(testFileAbs: string): ExtractOptions["readImport"] {
  return (specifier) => {
    const dir = path.dirname(testFileAbs);
    const base = path.resolve(dir, specifier);
    const candidates = [
      base,
      base.replace(/\.m?js$/, ".ts"),
      base.replace(/\.m?js$/, ".tsx"),
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
      path.join(base, "index.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { fileName: path.basename(candidate), text: readFileSync(candidate, "utf8") };
      }
    }
    return null;
  };
}

async function runProject(
  mode: "verify" | "record",
  options: VerifyProjectOptions,
): Promise<ProjectVerifyResult> {
  const rootDir = path.resolve(options.rootDir);
  const resolved: ResolvedConfig = await loadConfig(rootDir, options.configPath);
  const ci = mode === "verify" && (options.ci ?? false);

  const index = await indexProject(rootDir);
  const symbols = filterSymbols(index.symbols, resolved);
  const knownIds = new Set(symbols.map((s) => s.id));
  const allHashes = hashSymbolSources(rootDir, symbols);
  const frameworkVersion = playwrightTestVersion(rootDir);

  const cliPath = resolvePlaywrightCli(rootDir);
  const discovered = await listTests(rootDir, resolved, cliPath);
  const filters = options.filter ?? [];
  const selected = discovered.filter(
    (t) =>
      filters.length === 0 ||
      filters.some((f) => t.relFile.includes(f) || t.title.includes(f) || t.testId.includes(f)),
  );
  if (selected.length === 0) {
    throw new VibehardUsageError(
      filters.length === 0
        ? "vibehard: no Playwright tests discovered"
        : `vibehard: no tests match filter: ${filters.join(", ")}`,
    );
  }

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
  try {
    for (const test of selected) {
      const result = await runOneTest({
        mode,
        rootDir,
        resolved,
        cliPath,
        test,
        symbols,
        knownIds,
        generated,
        resolveMapFile,
        resolveRules,
      });
      results.push(result.result);
      if (result.entry !== null) entries.set(test.testId, result.entry);
    }
  } finally {
    rmSync(runTemp, { recursive: true, force: true });
  }

  const diagnostics: string[] = [];
  const skipVerifyCount = results.filter((r) => r.skipVerify !== null).length;
  let drift: string[] = [];
  let written = false;

  const hasTestFailure = results.some((r) => r.status === "test-failed");
  const hasMismatch = results.some((r) =>
    ["mismatch", "unmappable", "no-declaration", "record-error", "error"].includes(r.status),
  );

  if (mode === "verify" && ci) {
    drift = checkLockfile(readLockfile(resolved.lockfilePath), {
      configHash: resolved.configHash,
      frameworkVersion,
      expectations: results.map((r) => ({
        testId: r.testId,
        declared: r.declared,
        symbolHashes: allHashes,
      })),
      fullRun: filters.length === 0,
      discoveredTestIds: new Set(discovered.map((t) => t.testId)),
    });
    const budget = resolved.skipVerifyBudget ?? 0;
    if (skipVerifyCount > budget) {
      diagnostics.push(
        `skipVerify count ${skipVerifyCount} exceeds budget ${budget} under --ci`,
      );
    }
  } else if (mode === "verify" && !hasTestFailure && !hasMismatch) {
    written = mergeAndWriteLockfile(resolved, frameworkVersion, entries, {
      fullRun: filters.length === 0,
      discoveredTestIds: new Set(discovered.map((t) => t.testId)),
    });
  } else if (mode === "record" && entries.size > 0) {
    written = mergeAndWriteLockfile(resolved, frameworkVersion, entries, {
      fullRun: filters.length === 0,
      discoveredTestIds: new Set(discovered.map((t) => t.testId)),
    });
  }

  const exitCode: 0 | 1 | 2 = hasTestFailure
    ? 1
    : hasMismatch || drift.length > 0 || diagnostics.length > 0
      ? 2
      : 0;
  const passed = results.filter((r) => r.status === "pass" || r.status === "recorded").length;

  return {
    ok: exitCode === 0,
    mode,
    ci,
    exitCode,
    rootDir,
    results,
    lockfile: { path: resolved.lockfilePath, written, drift },
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed - skipVerifyCount,
      skipVerifyCount,
    },
    diagnostics,
  };
}

function mergeAndWriteLockfile(
  resolved: ResolvedConfig,
  frameworkVersion: string,
  entries: ReadonlyMap<string, LockfileTestEntry>,
  scope: { fullRun: boolean; discoveredTestIds: ReadonlySet<string> },
): boolean {
  const lock: VibehardLockfile =
    readLockfile(resolved.lockfilePath) ?? emptyLockfile(resolved.configHash, frameworkVersion);
  lock.framework = { name: "playwright", version: frameworkVersion };
  lock.configHash = resolved.configHash;
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
  cliPath: string;
  test: ListedTest;
  symbols: ReturnType<typeof filterSymbols>;
  knownIds: ReadonlySet<string>;
  generated: string[];
  resolveMapFile: string;
  resolveRules: { urlEndsWith: string; path: string }[];
}

async function runOneTest(
  input: RunOneInput,
): Promise<{ result: TestVerifyResult; entry: LockfileTestEntry | null }> {
  const { test, resolved, rootDir } = input;
  const artifactDir = mkdtempSync(path.join(tmpdir(), "vibehard-art-"));
  const base: TestVerifyResult = {
    testId: test.testId,
    file: test.relFile,
    title: test.title,
    titlePath: test.titlePath,
    status: "error",
    declared: null,
    observed: [],
    missing: [],
    extra: [],
    allowed: [],
    unknown: [],
    unmappable: [],
    diagnostics: [],
    skipVerify: null,
  };
  try {
    const port = resolved.config.app !== undefined ? await freePort() : 0;
    const server = await startAppServer(resolved, port);
    let run: Awaited<ReturnType<typeof runSingleTest>>;
    let serverScripts: ScriptInput[] = [];
    try {
      run = await runSingleTest({
        rootDir,
        cliPath: input.cliPath,
        resolved,
        test,
        env: {
          VIBEHARD_ARTIFACT_DIR: artifactDir,
          VIBEHARD_RESOLVE_MAP: input.resolveMapFile,
          ...(server !== null ? { VIBEHARD_BASE_URL: server.baseUrl } : {}),
        },
      });
    } finally {
      if (server !== null) serverScripts = await server.stop().catch(() => []);
    }

    const artifacts = readArtifacts(artifactDir);
    const artifact =
      artifacts.find((a) => sameFile(a.file, test.file) && a.line === test.line) ??
      artifacts.find((a) => sameFile(a.file, test.file) && a.title === test.title) ??
      (artifacts.length === 1 ? artifacts[0] : undefined);

    const testFailed =
      run.exitCode !== 0 ||
      (artifact !== undefined &&
        ["failed", "timedOut", "interrupted"].includes(artifact.status));

    if (artifact === undefined) {
      base.status = testFailed ? "test-failed" : "error";
      base.diagnostics.push(
        testFailed
          ? `playwright run failed (exit ${run.exitCode}) and no vibehard artifact was written`
          : "no vibehard artifact was written; is this spec importing `test` from 'vibehard/playwright'?",
      );
      const tail = (run.stderr || run.stdout).trim().slice(-800);
      if (tail !== "") base.diagnostics.push(tail);
      return { result: base, entry: null };
    }

    base.skipVerify = artifact.declared.skipVerify;
    const clientScripts = artifact.clientScripts.map((script) => {
      if (script.sourcePath !== null && script.sourcePath !== undefined && script.sourcePath !== "") {
        return script;
      }
      const rule = input.resolveRules.find((r) => script.url.endsWith(r.urlEndsWith));
      return rule === undefined ? script : { ...script, sourcePath: rule.path };
    });
    const observed = observeScripts([...clientScripts, ...serverScripts], {
      rootDir,
      symbols: input.symbols,
      appGeneratedPaths: input.generated,
    });
    base.observed = observed.merged;
    base.unmappable = observed.unmappable;
    base.diagnostics.push(
      ...observed.diagnostics.filter((d) => !d.startsWith("excluded script:")),
    );

    if (testFailed) {
      base.status = "test-failed";
      base.declared = artifact.declared.uses;
      if (artifact.errors.length > 0) base.diagnostics.push(...artifact.errors.slice(0, 2));
      return { result: base, entry: null };
    }
    if (artifact.status === "skipped") {
      base.status = "error";
      base.declared = artifact.declared.uses;
      base.diagnostics.push("test was skipped at runtime; its declaration cannot be verified");
      return { result: base, entry: null };
    }
    if (artifact.declared.skipVerify !== null) {
      base.status = "skipped-verify";
      base.declared = artifact.declared.uses;
      const hashes = hashesFor(input, artifact.declared.uses ?? []);
      return {
        result: base,
        entry: {
          file: test.relFile,
          titlePath: test.titlePath,
          declared: [...(artifact.declared.uses ?? [])].sort(),
          symbolHashes: hashes,
          allowTransitive: [...artifact.declared.allowTransitive].sort(),
          allowedObserved: [],
          skipVerify: artifact.declared.skipVerify,
        },
      };
    }
    if (!observed.ok) {
      base.status = "unmappable";
      base.declared = artifact.declared.uses;
      return { result: base, entry: null };
    }

    const allow = artifact.declared.allowTransitive;

    if (input.mode === "record") {
      const rec = diffDeclaredObserved({
        declared: [],
        observed: observed.merged,
        knownSymbolIds: input.knownIds,
        ignore: resolved.ignore,
        allowTransitive: allow,
      });
      const newUses = rec.extra;
      base.allowed = rec.allowed;
      base.diagnostics.push(...rec.diagnostics);
      try {
        const fileText = readFileSync(test.file, "utf8");
        const rewritten = rewriteDeclaration(fileText, test.relFile, test.title, newUses, {
          readImport: makeReadImport(test.file),
        });
        if (rewritten.changed) writeFileSync(test.file, rewritten.text);
        base.status = "recorded";
        base.changed = rewritten.changed;
        base.declared = rewritten.finalDeclared;
        const unobservedFromSpread = rewritten.finalDeclared.filter(
          (id) => !observed.merged.includes(id),
        );
        if (unobservedFromSpread.length > 0) {
          base.diagnostics.push(
            `shared group declares ${unobservedFromSpread.length} symbol(s) not observed (${unobservedFromSpread.join(", ")}); verify will report them missing`,
          );
        }
        return {
          result: base,
          entry: {
            file: test.relFile,
            titlePath: test.titlePath,
            declared: rewritten.finalDeclared,
            symbolHashes: hashesFor(input, rewritten.finalDeclared),
            allowTransitive: [...allow].sort(),
            allowedObserved: rec.allowed,
          },
        };
      } catch (error) {
        base.status = "record-error";
        base.declared = artifact.declared.uses;
        base.diagnostics.push(
          error instanceof CodemodError || error instanceof Error
            ? error.message
            : String(error),
        );
        return { result: base, entry: null };
      }
    }

    // verify mode
    if (artifact.declared.uses === null) {
      base.status = "no-declaration";
      base.diagnostics.push("test has no declaration; run `vibehard record` to generate one");
      return { result: base, entry: null };
    }
    const diff = diffDeclaredObserved({
      declared: artifact.declared.uses,
      observed: observed.merged,
      knownSymbolIds: input.knownIds,
      ignore: resolved.ignore,
      allowTransitive: allow,
    });
    base.declared = diff.declared;
    base.observed = diff.observed;
    base.missing = diff.missing;
    base.extra = diff.extra;
    base.allowed = diff.allowed;
    base.unknown = diff.unknown;
    base.diagnostics.push(...diff.diagnostics);
    base.status = diff.missing.length === 0 && diff.extra.length === 0 ? "pass" : "mismatch";
    const entry: LockfileTestEntry | null =
      base.status === "pass"
        ? {
            file: test.relFile,
            titlePath: test.titlePath,
            declared: diff.declared ?? [],
            symbolHashes: hashesFor(input, diff.declared ?? []),
            allowTransitive: [...allow].sort(),
            allowedObserved: diff.allowed,
          }
        : null;
    return { result: base, entry };
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function hashesFor(input: RunOneInput, declared: readonly string[]): Record<string, string> {
  const records = input.symbols.filter((s) => declared.includes(s.id));
  return hashSymbolSources(input.rootDir, records);
}

/** Human-readable report for the CLI (no --json). */
export function formatVerifyReport(result: ProjectVerifyResult): string {
  const lines: string[] = [];
  for (const r of result.results) {
    const tag =
      r.status === "pass" || r.status === "recorded"
        ? "PASS"
        : r.status === "skipped-verify"
          ? "SKIP-VERIFY"
          : "FAIL";
    lines.push(`${tag} ${r.testId}${r.status === "pass" ? "" : ` (${r.status})`}`);
    for (const id of r.missing) lines.push(`  missing (declared, not observed): ${id}`);
    for (const id of r.extra) lines.push(`  extra (observed, not declared): ${id}`);
    for (const id of r.allowed) lines.push(`  allowed (allowTransitive): ${id}`);
    for (const u of r.unmappable) lines.push(`  unmappable (${u.origin}): ${u.url} — ${u.reason}`);
    if (r.changed === true) lines.push(`  declaration rewritten in ${r.file}`);
    for (const d of r.diagnostics) lines.push(`  ${d}`);
  }
  for (const d of result.lockfile.drift) lines.push(`lockfile drift: ${d}`);
  for (const d of result.diagnostics) lines.push(d);
  lines.push(
    `${result.mode}: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.total} total; skipVerify: ${result.summary.skipVerifyCount} test(s); lockfile ${result.lockfile.written ? "updated" : "unchanged"} (${result.lockfile.path})`,
  );
  return `${lines.join("\n")}\n`;
}
