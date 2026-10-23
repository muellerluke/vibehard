import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import { INDEXER_VERSION } from "../indexer/index.js";
import type { TouchKind, TouchedSet } from "./touched.js";
import { VibehardUsageError } from "./types.js";

export interface LockfileTestEntry {
  file: string;
  titlePath: string[];
  /** Every symbol this test touched at last record, by touch kind. */
  touched: TouchedSet;
  /** sha256 of each touched symbol's source, by symbol ID. */
  symbolHashes: Record<string, string>;
  alwaysRun?: string;
}

export interface VibehardLockfile {
  version: 3;
  framework: { name: string; version: string };
  configHash: string;
  /** Indexer/reference-graph version the touched sets were built with. */
  graphVersion: number;
  tests: Record<string, LockfileTestEntry>;
}

/**
 * Canonical touch-kind order in the v3 wire format. Readers accept
 * exactly these kind names; the writer emits groups in this order.
 */
const TOUCH_KIND_ORDER: readonly TouchKind[] = [
  "direct",
  "referenced",
  "module",
  "class",
  "asset",
];

/** One interned (symbol ID, hash) pair in the v3 wire format. */
interface LockfileSymbolV3 {
  id: string;
  /** sha256 hex of the symbol's source; absent when none was recorded. */
  h?: string;
}

/** Compare interned pairs by ID, then by hash (absent hash sorts first). */
function compareSymbolsV3(a: LockfileSymbolV3, b: LockfileSymbolV3): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  const ah = a.h ?? "";
  const bh = b.h ?? "";
  return ah === bh ? 0 : ah < bh ? -1 : 1;
}

/** Hash one symbol against its file's text (slice or hash slices). */
function hashRecordText(text: string, record: SymbolRecord): string {
  const hash = createHash("sha256");
  if (record.hashSlices !== undefined) {
    for (const slice of record.hashSlices) {
      hash.update(text.slice(slice.startOffset, slice.endOffset));
      hash.update("\0");
    }
  } else {
    hash.update(text.slice(record.startOffset, record.endOffset));
  }
  return hash.digest("hex");
}

/** Hash an asset symbol's raw bytes. */
export function hashAssetBytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Hash the current source of every given symbol (file read once).
 * Executable/value symbols hash their exact source slice; module
 * symbols hash their leftover-statement slices; asset symbols hash
 * the file's raw bytes.
 */
export function hashSymbolSources(
  rootDir: string,
  symbols: readonly SymbolRecord[],
): Record<string, string> {
  const byFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }
  const out: Record<string, string> = {};
  for (const [file, records] of byFile) {
    let text: string | null = null;
    for (const record of records) {
      if (record.kind === "asset") {
        out[record.id] = hashAssetBytes(readFileSync(path.resolve(rootDir, file)));
        continue;
      }
      if (text === null) text = readFileSync(path.resolve(rootDir, file), "utf8");
      out[record.id] = hashRecordText(text, record);
    }
  }
  return out;
}

/**
 * Hash non-asset symbols against in-memory file texts, exactly as
 * `hashSymbolSources` would against the same texts on disk. Symbols
 * whose file has no supplied text are omitted (callers treat a
 * missing hash as a mismatch). Asset symbols are skipped: hash them
 * with `hashAssetBytes` over the raw bytes.
 */
export function hashSymbolTexts(
  textsByFile: ReadonlyMap<string, string>,
  symbols: readonly SymbolRecord[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const record of symbols) {
    if (record.kind === "asset") continue;
    const text = textsByFile.get(record.file);
    if (text === undefined) continue;
    out[record.id] = hashRecordText(text, record);
  }
  return out;
}

/** Hashes for the symbols in a touched set. */
export function hashesForTouched(
  rootDir: string,
  symbols: readonly SymbolRecord[],
  touched: Readonly<Record<string, string>>,
): Record<string, string> {
  const ids = new Set(Object.keys(touched));
  return hashSymbolSources(
    rootDir,
    symbols.filter((s) => ids.has(s.id)),
  );
}

const FRAMEWORK_PACKAGES: Record<string, readonly string[]> = {
  playwright: ["@playwright/test/package.json", "playwright/package.json"],
  puppeteer: ["puppeteer/package.json", "puppeteer-core/package.json"],
  cypress: ["cypress/package.json"],
};

/** Installed framework version for the project, or "unknown". */
export function frameworkVersion(rootDir: string, framework: string): string {
  const candidates = FRAMEWORK_PACKAGES[framework] ?? [`${framework}/package.json`];
  try {
    const req = createRequire(path.join(path.resolve(rootDir), "package.json"));
    for (const candidate of candidates) {
      try {
        const pkg = req(candidate) as { version?: string };
        if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
      } catch {
        // try the next candidate
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
}

/** Installed `@playwright/test` version for the project, or "unknown". */
export function playwrightTestVersion(rootDir: string): string {
  return frameworkVersion(rootDir, "playwright");
}

export function emptyLockfile(
  configHash: string,
  frameworkVersion: string,
  frameworkName = "playwright",
): VibehardLockfile {
  return {
    version: 3,
    framework: { name: frameworkName, version: frameworkVersion },
    configHash,
    graphVersion: INDEXER_VERSION,
    tests: {},
  };
}

/**
 * Stable v3 serialization. Each distinct (symbol ID, hash) pair is
 * interned once in a sorted `symbols` table; tests reference it by
 * sorted integer indexes grouped by touch kind. Layout is one symbol
 * and one test per line under a pretty-printed header, so the file is
 * a pure function of its content and diffs stay localized. Hashes
 * recorded for symbols a test did not touch have no consumer and are
 * not written; a touched symbol with no recorded hash (or an empty
 * one) is interned without `h`, which the trust check treats as a
 * mismatch, exactly like a missing v2 hash.
 */
export function serializeLockfile(lock: VibehardLockfile): string {
  const pairIndex = new Map<string, number>();
  const symbols: LockfileSymbolV3[] = [];
  const intern = (id: string, hash: string | undefined): number => {
    const h = hash === undefined || hash === "" ? undefined : hash;
    const key = JSON.stringify([id, h ?? null]);
    const existing = pairIndex.get(key);
    if (existing !== undefined) return existing;
    symbols.push(h === undefined ? { id } : { id, h });
    const index = symbols.length - 1;
    pairIndex.set(key, index);
    return index;
  };

  // First pass: validate kinds and collect indexes per test/kind with
  // provisional pair positions, then sort the table and remap.
  const testIds = Object.keys(lock.tests).sort();
  const provisional = new Map<string, Map<TouchKind, number[]>>();
  for (const testId of testIds) {
    const entry = lock.tests[testId];
    if (entry === undefined) continue;
    const byKind = new Map<TouchKind, number[]>();
    for (const id of Object.keys(entry.touched)) {
      const kind = entry.touched[id as SymbolId];
      if (kind === undefined) continue;
      if (!TOUCH_KIND_ORDER.includes(kind)) {
        throw new VibehardUsageError(
          `vibehard: unknown touch kind "${kind}" for ${id} in test ${testId}`,
        );
      }
      const list = byKind.get(kind) ?? [];
      list.push(intern(id, entry.symbolHashes[id]));
      byKind.set(kind, list);
    }
    provisional.set(testId, byKind);
  }
  const order = symbols.map((_, i) => i).sort((x, y) => {
    const a = symbols[x] as LockfileSymbolV3;
    const b = symbols[y] as LockfileSymbolV3;
    return compareSymbolsV3(a, b);
  });
  const remap = new Array<number>(symbols.length);
  order.forEach((oldIndex, newIndex) => {
    remap[oldIndex] = newIndex;
  });
  const sortedSymbols = order.map((i) => symbols[i] as LockfileSymbolV3);

  const lines: string[] = ["{"];
  lines.push(`  "version": 3,`);
  lines.push(
    `  "framework": ${JSON.stringify({ name: lock.framework.name, version: lock.framework.version })},`,
  );
  lines.push(`  "configHash": ${JSON.stringify(lock.configHash)},`);
  lines.push(`  "graphVersion": ${JSON.stringify(lock.graphVersion)},`);
  if (sortedSymbols.length === 0) {
    lines.push(`  "symbols": [],`);
  } else {
    lines.push(`  "symbols": [`);
    sortedSymbols.forEach((pair, i) => {
      lines.push(`    ${JSON.stringify(pair)}${i === sortedSymbols.length - 1 ? "" : ","}`);
    });
    lines.push(`  ],`);
  }
  const wireTests = testIds.filter((testId) => lock.tests[testId] !== undefined);
  if (wireTests.length === 0) {
    lines.push(`  "tests": {}`);
  } else {
    lines.push(`  "tests": {`);
    wireTests.forEach((testId, i) => {
      const entry = lock.tests[testId] as LockfileTestEntry;
      const byKind = provisional.get(testId) ?? new Map<TouchKind, number[]>();
      const touched: Record<string, number[]> = {};
      for (const kind of TOUCH_KIND_ORDER) {
        const list = byKind.get(kind);
        if (list === undefined || list.length === 0) continue;
        touched[kind] = list.map((old) => remap[old] as number).sort((a, b) => a - b);
      }
      const wire: Record<string, unknown> = {
        file: entry.file,
        titlePath: [...entry.titlePath],
        touched,
      };
      if (entry.alwaysRun !== undefined) wire["alwaysRun"] = entry.alwaysRun;
      lines.push(
        `    ${JSON.stringify(testId)}: ${JSON.stringify(wire)}${i === wireTests.length - 1 ? "" : ","}`,
      );
    });
    lines.push(`  }`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidLockfile(file: string, detail: string): never {
  throw new VibehardUsageError(`vibehard: invalid lockfile ${file}: ${detail}`);
}

/**
 * Normalize a v2 document into the in-memory shape. The recorded data
 * is identical in v3, so this is lossless for machine-written files:
 * hashes for symbols a test did not touch (which no consumer reads)
 * are the only dropped bytes.
 */
function parseLockfileV2(value: Record<string, unknown>, file: string): VibehardLockfile {
  const raw = value as Partial<Omit<VibehardLockfile, "version">> & { version?: unknown };
  if (!isRecordValue(raw.tests)) {
    throw new VibehardUsageError(
      `vibehard: unsupported lockfile format in ${file} (expected version 2 or 3)`,
    );
  }
  const tests: Record<string, LockfileTestEntry> = {};
  for (const [testId, rawEntry] of Object.entries(raw.tests)) {
    const entry = rawEntry as LockfileTestEntry;
    const touched: TouchedSet = { ...(entry.touched ?? {}) };
    const symbolHashes: Record<string, string> = {};
    for (const id of Object.keys(touched)) {
      const hash = entry.symbolHashes?.[id];
      if (hash !== undefined) symbolHashes[id] = hash;
    }
    const normalized: LockfileTestEntry = {
      file: entry.file,
      titlePath: [...(entry.titlePath ?? [])],
      touched,
      symbolHashes,
    };
    if (entry.alwaysRun !== undefined) normalized.alwaysRun = entry.alwaysRun;
    tests[testId] = normalized;
  }
  const framework = raw.framework as { name: string; version: string };
  return {
    version: 3,
    framework: { name: framework.name, version: framework.version },
    configHash: raw.configHash as string,
    graphVersion: raw.graphVersion as number,
    tests,
  };
}

/**
 * Parse and strictly validate a v3 document, then normalize it into
 * the in-memory shape. Integer indexes could silently select the
 * wrong tests if corrupt, so anything the writer would not emit —
 * out-of-range or unsorted indexes, duplicates, unknown kinds,
 * malformed hashes, unexpected keys — is a hard error.
 */
function parseLockfileV3(value: Record<string, unknown>, file: string): VibehardLockfile {
  const topKeys = new Set(["version", "framework", "configHash", "graphVersion", "symbols", "tests"]);
  for (const key of Object.keys(value)) {
    if (!topKeys.has(key)) invalidLockfile(file, `unknown field "${key}"`);
  }
  const framework = value["framework"];
  if (
    !isRecordValue(framework) ||
    typeof framework["name"] !== "string" ||
    typeof framework["version"] !== "string"
  ) {
    invalidLockfile(file, `"framework" must be an object with string "name" and "version"`);
  }
  if (typeof value["configHash"] !== "string") invalidLockfile(file, `"configHash" must be a string`);
  if (!Number.isInteger(value["graphVersion"])) invalidLockfile(file, `"graphVersion" must be an integer`);

  const rawSymbols = value["symbols"];
  if (!Array.isArray(rawSymbols)) invalidLockfile(file, `"symbols" must be an array`);
  const symbols: LockfileSymbolV3[] = [];
  rawSymbols.forEach((rawPair, i) => {
    if (!isRecordValue(rawPair)) invalidLockfile(file, `symbols[${i}] must be an object`);
    for (const key of Object.keys(rawPair)) {
      if (key !== "id" && key !== "h") invalidLockfile(file, `symbols[${i}] has unknown field "${key}"`);
    }
    const id = rawPair["id"];
    if (typeof id !== "string" || id === "") invalidLockfile(file, `symbols[${i}].id must be a non-empty string`);
    const pair: LockfileSymbolV3 = { id };
    const h = rawPair["h"];
    if (h !== undefined) {
      if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) {
        invalidLockfile(file, `symbols[${i}].h must be a 64-character lowercase hex sha256`);
      }
      pair.h = h;
    }
    const prev = symbols[symbols.length - 1];
    if (prev !== undefined && compareSymbolsV3(prev, pair) >= 0) {
      invalidLockfile(file, `symbols must be sorted by (id, hash) with no duplicate pairs`);
    }
    symbols.push(pair);
  });

  const rawTests = value["tests"];
  if (!isRecordValue(rawTests)) invalidLockfile(file, `"tests" must be an object`);
  const entryKeys = new Set(["file", "titlePath", "touched", "alwaysRun"]);
  const tests: Record<string, LockfileTestEntry> = {};
  for (const [testId, rawEntry] of Object.entries(rawTests)) {
    if (!isRecordValue(rawEntry)) invalidLockfile(file, `tests[${JSON.stringify(testId)}] must be an object`);
    for (const key of Object.keys(rawEntry)) {
      if (!entryKeys.has(key)) invalidLockfile(file, `test ${testId} has unknown field "${key}"`);
    }
    if (typeof rawEntry["file"] !== "string") invalidLockfile(file, `test ${testId}: "file" must be a string`);
    const titlePath = rawEntry["titlePath"];
    if (!Array.isArray(titlePath) || titlePath.some((t) => typeof t !== "string")) {
      invalidLockfile(file, `test ${testId}: "titlePath" must be an array of strings`);
    }
    if (rawEntry["alwaysRun"] !== undefined && typeof rawEntry["alwaysRun"] !== "string") {
      invalidLockfile(file, `test ${testId}: "alwaysRun" must be a string`);
    }
    const rawTouched = rawEntry["touched"];
    if (!isRecordValue(rawTouched)) invalidLockfile(file, `test ${testId}: "touched" must be an object`);
    const touched: TouchedSet = {};
    const symbolHashes: Record<string, string> = {};
    for (const [kind, rawIndexes] of Object.entries(rawTouched)) {
      if (!TOUCH_KIND_ORDER.includes(kind as TouchKind)) {
        invalidLockfile(file, `test ${testId}: unknown touch kind "${kind}"`);
      }
      if (!Array.isArray(rawIndexes)) {
        invalidLockfile(file, `test ${testId}: touched.${kind} must be an array of symbol indexes`);
      }
      let prevIndex = -1;
      for (const rawIndex of rawIndexes) {
        if (!Number.isInteger(rawIndex) || (rawIndex as number) < 0 || (rawIndex as number) >= symbols.length) {
          invalidLockfile(file, `test ${testId}: symbol index ${String(rawIndex)} out of range`);
        }
        const index = rawIndex as number;
        if (index <= prevIndex) {
          invalidLockfile(file, `test ${testId}: touched.${kind} indexes must be strictly increasing`);
        }
        prevIndex = index;
        const pair = symbols[index] as LockfileSymbolV3;
        // One check covers a repeated index in another kind group and
        // the same symbol reached through two different pairs.
        if (Object.hasOwn(touched, pair.id)) {
          invalidLockfile(file, `test ${testId}: symbol ${pair.id} referenced more than once`);
        }
        touched[pair.id] = kind as TouchKind;
        if (pair.h !== undefined) symbolHashes[pair.id] = pair.h;
      }
    }
    const normalized: LockfileTestEntry = {
      file: rawEntry["file"],
      titlePath: [...titlePath],
      touched,
      symbolHashes,
    };
    if (rawEntry["alwaysRun"] !== undefined) normalized.alwaysRun = rawEntry["alwaysRun"];
    tests[testId] = normalized;
  }

  return {
    version: 3,
    framework: {
      name: (framework as Record<string, unknown>)["name"] as string,
      version: (framework as Record<string, unknown>)["version"] as string,
    },
    configHash: value["configHash"],
    graphVersion: value["graphVersion"] as number,
    tests,
  };
}

export function parseLockfile(text: string, file: string): VibehardLockfile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new VibehardUsageError(
      `vibehard: invalid JSON in lockfile ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecordValue(value)) {
    throw new VibehardUsageError(
      `vibehard: unsupported lockfile format in ${file} (expected version 2 or 3)`,
    );
  }
  const version = value["version"];
  if (version === 1) {
    throw new VibehardUsageError(
      `vibehard: lockfile ${file} is version 1 (declaration-based); delete it and re-run \`vibehard record\``,
    );
  }
  if (typeof version === "number" && version > 3) {
    throw new VibehardUsageError(
      `vibehard: lockfile ${file} is version ${version}, newer than the supported version 3; upgrade vibehard`,
    );
  }
  if (version === 2) return parseLockfileV2(value, file);
  if (version === 3) return parseLockfileV3(value, file);
  throw new VibehardUsageError(
    `vibehard: unsupported lockfile format in ${file} (expected version 2 or 3)`,
  );
}

export function readLockfile(lockfilePath: string): VibehardLockfile | null {
  if (!existsSync(lockfilePath)) return null;
  return parseLockfile(readFileSync(lockfilePath, "utf8"), lockfilePath);
}

/** Write atomically; returns false when the bytes are unchanged. */
export function writeLockfile(lockfilePath: string, lock: VibehardLockfile): boolean {
  const text = serializeLockfile(lock);
  if (existsSync(lockfilePath) && readFileSync(lockfilePath, "utf8") === text) return false;
  mkdirSync(path.dirname(lockfilePath), { recursive: true });
  const tmp = `${lockfilePath}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, lockfilePath);
  return true;
}

/** One test's reference to a symbol in the inverted index. */
export interface SymbolTestRef {
  testId: string;
  via: TouchKind;
}

/** Inverted lockfile index: symbol ID → tests that touched it. */
export type SymbolTestIndex = Map<SymbolId, SymbolTestRef[]>;

/**
 * Build the inverted index over every lockfile entry. Derived and
 * disposable: selection, the trust check, and `explain` build it once
 * per call so their cost tracks changed symbols and selected tests
 * rather than rescanning every touched edge per query.
 */
export function buildSymbolTestIndex(lock: VibehardLockfile | null): SymbolTestIndex {
  const index: SymbolTestIndex = new Map();
  if (lock === null) return index;
  for (const [testId, entry] of Object.entries(lock.tests)) {
    for (const [id, kind] of Object.entries(entry.touched)) {
      const list = index.get(id) ?? [];
      list.push({ testId, via: kind ?? "direct" });
      index.set(id, list);
    }
  }
  return index;
}

export interface LockfileExpectation {
  testId: string;
  /** Touched set from the current run, or null when it could not be computed. */
  touched: Readonly<Record<string, string>> | null;
  symbolHashes: Record<string, string>;
}

/**
 * Compare a lockfile against the current run's touched sets and source
 * hashes. Returns human-readable drift entries (empty = in agreement).
 */
export function checkLockfile(
  lock: VibehardLockfile | null,
  input: {
    configHash: string;
    frameworkVersion: string;
    /** Expected framework name; defaults to "playwright" for compatibility. */
    frameworkName?: string;
    expectations: readonly LockfileExpectation[];
    /** When true, lockfile tests absent from expectations are drift. */
    fullRun: boolean;
    discoveredTestIds?: ReadonlySet<string>;
  },
): string[] {
  if (lock === null) return ["lockfile missing (run `vibehard record` or `vibehard verify`)"];
  const drift: string[] = [];
  if (lock.configHash !== input.configHash) drift.push("lockfile config hash differs from current config");
  const expectedName = input.frameworkName ?? "playwright";
  if (lock.framework.name !== expectedName || lock.framework.version !== input.frameworkVersion) {
    drift.push(`lockfile framework ${lock.framework.name}@${lock.framework.version} differs from ${expectedName}@${input.frameworkVersion}`);
  }
  if (lock.graphVersion !== INDEXER_VERSION) {
    drift.push(
      `lockfile graph version ${lock.graphVersion} differs from current ${INDEXER_VERSION} (re-run \`vibehard record\`)`,
    );
  }
  for (const exp of input.expectations) {
    const entry = lock.tests[exp.testId];
    if (entry === undefined) {
      drift.push(`${exp.testId}: missing from lockfile`);
      continue;
    }
    const touchedNow = [...Object.keys(exp.touched ?? {})].sort();
    if (exp.touched !== null && JSON.stringify(Object.keys(entry.touched).sort()) !== JSON.stringify(touchedNow)) {
      drift.push(`${exp.testId}: touched set differs from lockfile`);
    }
    for (const id of touchedNow) {
      const expected = exp.symbolHashes[id];
      if (expected === undefined) continue;
      if (entry.symbolHashes[id] !== expected) {
        drift.push(`${exp.testId}: source hash mismatch for ${id} (edited since last verify)`);
      }
    }
  }
  if (input.fullRun && input.discoveredTestIds !== undefined) {
    for (const testId of Object.keys(lock.tests)) {
      if (!input.discoveredTestIds.has(testId)) {
        drift.push(`${testId}: in lockfile but no longer discovered`);
      }
    }
  }
  return drift;
}
