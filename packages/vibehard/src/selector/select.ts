import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import { indexProject, INDEXER_VERSION } from "../indexer/index.js";
import { filterSymbols, loadConfig, type ResolvedConfig } from "../verifier/config.js";
import { getFrameworkDriver } from "../verifier/driver.js";
import {
  frameworkVersion,
  hashSymbolSources,
  readLockfile,
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

function toRef(test: ListedTest): DiscoveredTestRef {
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
  for (const [testId, entry] of Object.entries(input.lock.tests)) {
    if (!input.discoveredIds.has(testId)) continue;
    for (const id of Object.keys(entry.touched)) {
      const expected = entry.symbolHashes[id];
      if (expected === undefined || input.baseHashes[id] !== expected) allBase = false;
      if (expected === undefined || input.headHashes[id] !== expected) allHead = false;
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
 * Compute the exact test selection for the working tree against a base
 * revision. Never guesses: anything that cannot be mapped to symbols (or
 * to a trusted lockfile) is reported as an unsafe reason instead.
 */
export async function selectTests(options: SelectOptions): Promise<SelectionResult> {
  const rootDir = path.resolve(options.rootDir);
  const resolved = await loadConfig(rootDir, options.configPath);
  const diagnostics: string[] = [];
  const unsafeReasons: string[] = [];

  const gitRoot = await resolveGitRoot(rootDir);
  const base = await resolveBase(gitRoot, {
    ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
    ...(resolved.baseBranch !== undefined ? { baseBranch: resolved.baseBranch } : {}),
  });

  const changedFiles: ChangedFile[] = await listChangedFiles(gitRoot, base.sha);
  const patches = parseUnifiedDiff(await diffPatch(gitRoot, base.sha), gitRoot.prefix);
  const patchByFile = new Map<string, FilePatch>();
  for (const patch of patches) {
    const key = patch.newFile ?? patch.oldFile;
    if (key !== null) patchByFile.set(key, patch);
  }

  const driver = getFrameworkDriver(resolved.config.framework);
  const discovered = await driver.listTests(rootDir, resolved);
  const discoveredIds = new Set(discovered.map((t) => t.testId));
  const specFiles = new Set(discovered.map((t) => t.relFile));

  const headIndex = await indexProject(rootDir);
  const headSymbols = filterSymbols(headIndex.symbols, resolved);
  const headHashes = hashOrEmpty(rootDir, headSymbols);

  let baseSymbols: SymbolRecord[] = [];
  let baseHashes: Record<string, string> = {};
  let baseRoot: string | null = null;
  let worktree: Awaited<ReturnType<typeof createBaseWorktree>> | null = null;
  try {
    worktree = await createBaseWorktree(gitRoot, base.sha);
    if (baseProjectExists(worktree)) {
      baseRoot = worktree.projectRoot;
      const baseIndex = await indexProject(baseRoot);
      baseSymbols = filterSymbols(baseIndex.symbols, resolved);
      baseHashes = hashOrEmpty(baseRoot, baseSymbols);
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

  try {
    for (const change of changedFiles) {
      const kind = classifyChangedFile(change.file, {
        ignore: resolved.ignore,
        include: resolved.include,
        testDirPosix: resolved.testDirPosix,
        specFiles,
        lockfileRel,
        assetFiles,
      });
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
          unsafeReasons.push(`unsafe: unmapped change: ${change.file} (test support file)`);
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
    if (worktree !== null) await worktree.cleanup();
  }

  let lock: VibehardLockfile | null = null;
  let lockError: string | null = null;
  try {
    lock = existsSync(resolved.lockfilePath) ? readLockfile(resolved.lockfilePath) : null;
  } catch (error) {
    lockError = error instanceof Error ? error.message : String(error);
  }
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
    }),
  );

  const selected: SelectedTest[] = [];
  for (const test of discovered) {
    const reasons: SelectionReason[] = [];
    const entry = lock?.tests[test.testId];
    if (changedSpecFiles.has(test.relFile)) {
      reasons.push({ type: "test-file-changed", file: test.relFile });
    }
    if (entry?.alwaysRun !== undefined) {
      reasons.push({ type: "always-run", reason: entry.alwaysRun });
    }
    if (entry === undefined) {
      reasons.push({ type: "unrecorded" });
    } else {
      for (const id of Object.keys(entry.touched).sort()) {
        if (changedSymbols.has(id as SymbolId)) {
          const via = entry.touched[id as SymbolId] ?? "direct";
          reasons.push({ type: "changed-symbol", symbol: id, via });
        }
      }
    }
    if (reasons.length > 0) selected.push({ ...toRef(test), reasons });
  }

  return {
    base,
    changedFiles: changedFiles.map((c) => c.file),
    changedSymbols: [...changedSymbols].sort(),
    discovered: discovered.map(toRef),
    selected,
    unsafeReasons,
    unsafeReason: unsafeReasons[0] ?? null,
    diagnostics,
  };
}
