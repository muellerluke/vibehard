import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import {
  createProjectParser,
  dedupeSymbols,
  isIndexableFile,
  loadProjectFileList,
  makeAssetRecord,
  type ParsedFile,
  type ProjectParser,
} from "../indexer/index.js";
import { PhaseTimer, timingEnabled } from "../timing.js";
import { filterSymbols, loadConfig, type ResolvedConfig } from "../verifier/config.js";
import { getFrameworkDriver } from "../verifier/driver.js";
import {
  hashAssetBytes,
  hashSymbolTexts,
  readLockfile,
  type VibehardLockfile,
} from "../verifier/lockfile.js";
import type { ListedTest } from "../verifier/listed.js";
import {
  classifyChangedFile,
  computeChangedSymbolsForFile,
  parseUnifiedDiff,
  type ClassifyContext,
  type FilePatch,
} from "./changed.js";
import {
  baseTrackedFiles,
  diffPatch,
  listChangedFiles,
  readBaseFiles,
  resolveBase,
  resolveGitRoot,
} from "./git.js";
import { ParseCache, parseCacheEnabled, parseCacheKey } from "./parse-cache.js";
import { lockfileTrustReasons } from "./select.js";
import type {
  DiscoveredTestRef,
  SelectedTest,
  SelectionReason,
  SelectionResult,
  SelectOptions,
} from "./types.js";

/** Whether fast selection is on: explicit option wins over the env. */
export function fastSelectEnabled(
  explicit: boolean | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (explicit !== undefined) return explicit;
  const raw = env["VIBEHARD_FAST_SELECT"];
  return raw === "1" || raw === "true";
}

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

function toRef(test: ListedTest): DiscoveredTestRef {
  return {
    testId: test.testId,
    file: test.relFile,
    line: test.line,
    title: test.title,
    titlePath: test.titlePath,
  };
}

/**
 * File part of a symbol ID (`<file>#<qualified-name>`). Qualified
 * names may contain `#` (private members), so the first `#` is the
 * separator; a file whose name contains `#` resolves wrong here and
 * degrades to missing hashes, i.e. an unsafe (safe-direction) result.
 */
export function fileOfSymbolId(id: string): string {
  const at = id.indexOf("#");
  return at === -1 ? id : id.slice(0, at);
}

interface ParsedWithHashes {
  parsed: ParsedFile;
  /** Source hashes of the file's deduped symbols against `text`. */
  hashes: Record<string, string>;
}

function parseWithCache(
  parser: ProjectParser,
  cache: ParseCache,
  relPosix: string,
  text: string,
): ParsedWithHashes {
  const key = parseCacheKey(relPosix, text, parser.typescriptVersion);
  const hit = cache.get(key, relPosix);
  if (hit !== null && hit.hashes !== undefined) return { parsed: hit, hashes: hit.hashes };
  const parsed = hit ?? parser.parseFile(relPosix, text);
  const hashes = hashSymbolTexts(
    new Map([[relPosix, text]]),
    dedupeSymbols(parsed.symbols),
  );
  cache.set(key, parsed, hashes);
  return { parsed, hashes };
}

/** Hashes for `symbols`, served from `cached` where possible. */
function pickHashes(
  out: Record<string, string>,
  symbols: readonly SymbolRecord[],
  cached: Readonly<Record<string, string>>,
  missing: SymbolRecord[],
): void {
  for (const symbol of symbols) {
    const hash = cached[symbol.id];
    if (hash !== undefined) out[symbol.id] = hash;
    else missing.push(symbol);
  }
}

export interface LoadedHeadFiles {
  /** Deduped, config-filtered source symbols by file (assets merged in). */
  symbolsByFile: Map<string, SymbolRecord[]>;
  /** Texts of source files that exist at head. */
  texts: Map<string, string>;
  /** Hashes of every loaded symbol, assets included. */
  hashes: Record<string, string>;
  /** Asset files imported by the loaded source files. */
  discoveredAssets: Set<string>;
  filesRead: number;
  symbolCount: number;
}

/**
 * Parse and hash exactly `sourceFiles` at head (plus asset records
 * for `assetFilesWanted` and whatever assets the parses discover),
 * applying the same dedupe and `filterSymbols` rules as the
 * full-index path. Shared by fast selection and fast `explain`.
 */
export function loadHeadFiles(options: {
  rootDir: string;
  resolved: ResolvedConfig;
  sourceFiles: readonly string[];
  assetFilesWanted: readonly string[];
  parser: ProjectParser;
  cache: ParseCache;
}): LoadedHeadFiles {
  const { rootDir, resolved, parser, cache } = options;
  const texts = new Map<string, string>();
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  const discoveredAssets = new Set<string>();
  const hashes: Record<string, string> = {};
  const unhashed: SymbolRecord[] = [];

  for (const file of [...new Set(options.sourceFiles)].sort()) {
    const text = readTextOrNull(path.resolve(rootDir, file));
    if (text === null) continue;
    texts.set(file, text);
    const { parsed, hashes: fileHashes } = parseWithCache(parser, cache, file, text);
    for (const asset of parsed.assetFiles) discoveredAssets.add(asset);
    const filtered = filterSymbols(dedupeSymbols(parsed.symbols), resolved);
    symbolsByFile.set(file, filtered);
    pickHashes(hashes, filtered, fileHashes, unhashed);
  }

  const wantedAssets = new Set([...options.assetFilesWanted, ...discoveredAssets]);
  for (const file of [...wantedAssets].sort()) {
    const abs = path.resolve(rootDir, file);
    let data: Buffer;
    try {
      if (!statSync(abs).isFile()) continue;
      data = readFileSync(abs);
    } catch {
      continue;
    }
    const record = makeAssetRecord(
      file,
      data.length,
      Math.max(1, data.toString("utf8").split("\n").length),
    );
    if (filterSymbols([record], resolved).length === 0) continue;
    symbolsByFile.set(file, [record]);
    hashes[record.id] = hashAssetBytes(data);
  }

  if (unhashed.length > 0) Object.assign(hashes, hashSymbolTexts(texts, unhashed));

  let symbolCount = 0;
  for (const symbols of symbolsByFile.values()) symbolCount += symbols.length;
  return {
    symbolsByFile,
    texts,
    hashes,
    discoveredAssets,
    filesRead: texts.size,
    symbolCount,
  };
}

interface ParsedBaseFiles {
  symbolsByFile: Map<string, SymbolRecord[]>;
  discoveredAssets: Set<string>;
  hashes: Record<string, string>;
}

function parseBaseFiles(options: {
  resolved: ResolvedConfig;
  texts: ReadonlyMap<string, string>;
  parser: ProjectParser;
  cache: ParseCache;
}): ParsedBaseFiles {
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  const discoveredAssets = new Set<string>();
  const hashes: Record<string, string> = {};
  const unhashed: SymbolRecord[] = [];
  for (const [file, text] of [...options.texts.entries()].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const { parsed, hashes: fileHashes } = parseWithCache(
      options.parser,
      options.cache,
      file,
      text,
    );
    for (const asset of parsed.assetFiles) discoveredAssets.add(asset);
    const filtered = filterSymbols(dedupeSymbols(parsed.symbols), options.resolved);
    symbolsByFile.set(file, filtered);
    pickHashes(hashes, filtered, fileHashes, unhashed);
  }
  if (unhashed.length > 0) Object.assign(hashes, hashSymbolTexts(options.texts, unhashed));
  return { symbolsByFile, discoveredAssets, hashes };
}

/**
 * Diff-proportional selection (SCALING.md Phase 1): same contract
 * and result shape as the full-index `selectTests`, computed from
 * parse-only extraction over touched ∪ changed files, base contents
 * via `git cat-file`, and the identity "a file the diff does not
 * list, tracked at the base, has the same symbol hashes at both
 * endpoints". Throws on any internal inconsistency; the dispatcher
 * in `select.ts` falls back to the full algorithm.
 */
export async function selectTestsFast(options: SelectOptions): Promise<SelectionResult> {
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

  const changedFiles = await timer.run(
    "git.changedFiles",
    () => listChangedFiles(gitRoot, base.sha),
    (files) => ({ files: files.length }),
  );
  const changedSet = new Set(changedFiles.map((c) => c.file));
  const patchText = await timer.run("git.diffPatch", () => diffPatch(gitRoot, base.sha), (text) => ({
    bytes: Buffer.byteLength(text),
  }));
  const patches = timer.runSync("diff.parse", () => parseUnifiedDiff(patchText, gitRoot.prefix));
  const patchByFile = new Map<string, FilePatch>();
  for (const patch of patches) {
    const key = patch.newFile ?? patch.oldFile;
    if (key !== null) patchByFile.set(key, patch);
  }

  // Lockfile first: selection is meaningless without it, and the
  // touched union defines the head parse set.
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

  const driver = getFrameworkDriver(resolved.config.framework);
  const discovered = await timer.run(
    "tests.discovery",
    () => driver.listTests(rootDir, resolved),
    (tests) => ({ tests: tests.length }),
  );
  const discoveredIds = new Set(discovered.map((t) => t.testId));
  const specFiles = new Set(discovered.map((t) => t.relFile));
  const lockfileRel = toPosix(path.relative(rootDir, resolved.lockfilePath));

  // Touched union U over still-discovered tests, and its files F_u.
  const endUnion = timer.span("fast.touchedUnion");
  const touchedIds = new Set<SymbolId>();
  const lockfileAssets = new Set<string>();
  if (lock !== null) {
    for (const [testId, entry] of Object.entries(lock.tests)) {
      if (!discoveredIds.has(testId)) continue;
      for (const id of Object.keys(entry.touched)) {
        touchedIds.add(id);
        if (id.endsWith("#<file>")) lockfileAssets.add(fileOfSymbolId(id));
      }
    }
  }
  const touchedFiles = new Set([...touchedIds].map((id) => fileOfSymbolId(id)));
  endUnion({ symbols: touchedIds.size, files: touchedFiles.size });

  const classifyCtx: Omit<ClassifyContext, "assetFiles"> = {
    ignore: resolved.ignore,
    include: resolved.include,
    testDirPosix: resolved.testDirPosix,
    specFiles,
    lockfileRel,
  };
  const NO_ASSETS: ReadonlySet<string> = new Set();
  const candidateAppFiles = changedFiles
    .filter(
      (c) => classifyChangedFile(c.file, { ...classifyCtx, assetFiles: NO_ASSETS }) === "app",
    )
    .map((c) => c.file);

  // tsconfig membership without a Program; touched files are members
  // by construction (they were indexed at record time).
  const membership = timer.runSync("fast.membership", () => {
    const set = new Set(loadProjectFileList(rootDir));
    for (const file of touchedFiles) set.add(file);
    return set;
  }, (set) => ({ files: set.size }));

  const parser = createProjectParser(rootDir);
  const cache = await ParseCache.open(gitRoot, { enabled: parseCacheEnabled() });

  const headSourceFiles = new Set<string>();
  for (const file of touchedFiles) if (isIndexableFile(file)) headSourceFiles.add(file);
  for (const file of candidateAppFiles) {
    if (membership.has(file)) headSourceFiles.add(file);
  }
  const hitsBeforeHead = cache.hits;
  const missesBeforeHead = cache.misses;
  const head = timer.runSync(
    "fast.parse.head",
    () =>
      loadHeadFiles({
        rootDir,
        resolved,
        sourceFiles: [...headSourceFiles],
        assetFilesWanted: [...lockfileAssets],
        parser,
        cache,
      }),
    (loaded) => ({
      files: loaded.filesRead,
      symbols: loaded.symbolCount,
      cacheHits: cache.hits - hitsBeforeHead,
      cacheMisses: cache.misses - missesBeforeHead,
    }),
  );
  const headHashes = head.hashes;

  // Base contents for changed files only (app candidates, gated or
  // not — gated files still need base text for line attribution —
  // plus changed assets known so far).
  const assetFilesKnown = new Set([...lockfileAssets, ...head.discoveredAssets]);
  const fetchList = new Set<string>(candidateAppFiles);
  for (const file of changedSet) if (assetFilesKnown.has(file)) fetchList.add(file);
  const baseBytes = await timer.run(
    "fast.baseTexts",
    () => readBaseFiles(gitRoot, base.sha, [...fetchList].sort()),
    (map) => ({
      files: map.size,
      present: [...map.values()].filter((b) => b !== null).length,
    }),
  );
  const baseTexts = new Map<string, string>();
  for (const file of candidateAppFiles) {
    if (!membership.has(file)) continue;
    const bytes = baseBytes.get(file);
    if (bytes !== null && bytes !== undefined) baseTexts.set(file, bytes.toString("utf8"));
  }
  const hitsBeforeBase = cache.hits;
  const missesBeforeBase = cache.misses;
  const baseParsed = timer.runSync(
    "fast.parse.base",
    () => parseBaseFiles({ resolved, texts: baseTexts, parser, cache }),
    (parsed) => ({
      files: parsed.symbolsByFile.size,
      cacheHits: cache.hits - hitsBeforeBase,
      cacheMisses: cache.misses - missesBeforeBase,
    }),
  );

  // Assets first discovered in base parses whose own file changed
  // need one more (usually empty) fetch round.
  const extraFetch = [...baseParsed.discoveredAssets].filter(
    (f) => changedSet.has(f) && !baseBytes.has(f),
  );
  if (extraFetch.length > 0) {
    const extra = await readBaseFiles(gitRoot, base.sha, extraFetch.sort());
    for (const [file, bytes] of extra) baseBytes.set(file, bytes);
  }

  const assetFiles = new Set([
    ...assetFilesKnown,
    ...baseParsed.discoveredAssets,
  ]);

  // Base hashes: explicit for changed files, identity elsewhere.
  const baseHashes: Record<string, string> = { ...baseParsed.hashes };
  const baseByFile = new Map(baseParsed.symbolsByFile);
  for (const file of assetFiles) {
    const bytes = baseBytes.get(file);
    if (bytes === null || bytes === undefined) continue;
    const record = makeAssetRecord(
      file,
      bytes.length,
      Math.max(1, bytes.toString("utf8").split("\n").length),
    );
    if (filterSymbols([record], resolved).length === 0) continue;
    baseByFile.set(file, [record]);
    baseHashes[record.id] = hashAssetBytes(bytes);
  }
  const trackedAtBase = await timer.run(
    "fast.baseTracked",
    () => baseTrackedFiles(gitRoot, base.sha, [...touchedFiles].sort()),
    (set) => ({ files: touchedFiles.size, tracked: set.size }),
  );
  timer.runSync(
    "hash.base",
    () => {
      for (const id of touchedIds) {
        if (baseHashes[id] !== undefined) continue;
        const file = fileOfSymbolId(id);
        if (changedSet.has(file)) continue;
        if (!trackedAtBase.has(file)) continue;
        const headHash = headHashes[id];
        if (headHash !== undefined) baseHashes[id] = headHash;
      }
    },
    () => ({ symbols: Object.keys(baseHashes).length }),
  );
  if (
    touchedFiles.size > 0 &&
    trackedAtBase.size === 0 &&
    [...baseBytes.values()].every((b) => b === null)
  ) {
    diagnostics.push("project root does not exist at the base revision; every file is new");
  }

  const headByFile = head.symbolsByFile;
  const changedSymbols = new Set<SymbolId>();
  const changedSpecFiles = new Set<string>();
  const endChangedSymbols = timer.span("selection.changedSymbols");
  try {
    for (const change of changedFiles) {
      const kind = classifyChangedFile(change.file, { ...classifyCtx, assetFiles });
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
          const fetched = baseBytes.get(change.file);
          const result = computeChangedSymbolsForFile({
            status: change.status,
            baseSymbols: baseByFile.get(change.file) ?? [],
            headSymbols: headByFile.get(change.file) ?? [],
            baseHashes,
            headHashes,
            hunks: patch?.hunks ?? [],
            binary: patch?.binary ?? false,
            baseText:
              fetched === null || fetched === undefined ? null : fetched.toString("utf8"),
            headText: head.texts.get(change.file) ?? readTextOrNull(path.resolve(rootDir, change.file)),
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
    endChangedSymbols({ files: changedFiles.length, symbols: changedSymbols.size });
  }

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
      }),
    );
  });

  const endIntersect = timer.span("selection.intersect");
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
