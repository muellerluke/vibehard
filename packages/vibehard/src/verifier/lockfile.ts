import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import { INDEXER_VERSION } from "../indexer/index.js";
import type { TouchedSet } from "./touched.js";
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
  version: 2;
  framework: { name: string; version: string };
  configHash: string;
  /** Indexer/reference-graph version the touched sets were built with. */
  graphVersion: number;
  tests: Record<string, LockfileTestEntry>;
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
    version: 2,
    framework: { name: frameworkName, version: frameworkVersion },
    configHash,
    graphVersion: INDEXER_VERSION,
    tests: {},
  };
}

/** Stable serialization: sorted test keys, sorted arrays, trailing newline. */
export function serializeLockfile(lock: VibehardLockfile): string {
  const tests: Record<string, LockfileTestEntry> = {};
  for (const key of Object.keys(lock.tests).sort()) {
    const entry = lock.tests[key];
    if (entry === undefined) continue;
    const symbolHashes: Record<string, string> = {};
    for (const id of Object.keys(entry.symbolHashes).sort()) {
      symbolHashes[id] = entry.symbolHashes[id] ?? "";
    }
    const touched: LockfileTestEntry["touched"] = {};
    for (const id of Object.keys(entry.touched).sort()) {
      const kind = entry.touched[id as SymbolId];
      if (kind !== undefined) touched[id] = kind;
    }
    const normalized: LockfileTestEntry = {
      file: entry.file,
      titlePath: [...entry.titlePath],
      touched,
      symbolHashes,
    };
    if (entry.alwaysRun !== undefined) normalized.alwaysRun = entry.alwaysRun;
    tests[key] = normalized;
  }
  const ordered: VibehardLockfile = {
    version: 2,
    framework: lock.framework,
    configHash: lock.configHash,
    graphVersion: lock.graphVersion,
    tests,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
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
  const lock = value as Partial<VibehardLockfile> | null;
  if (lock === null || typeof lock !== "object" || typeof lock.tests !== "object" || lock.tests === null) {
    throw new VibehardUsageError(`vibehard: unsupported lockfile format in ${file} (expected version 2)`);
  }
  if (lock.version === (1 as unknown)) {
    throw new VibehardUsageError(
      `vibehard: lockfile ${file} is version 1 (declaration-based); delete it and re-run \`vibehard record\``,
    );
  }
  if (lock.version !== 2) {
    throw new VibehardUsageError(`vibehard: unsupported lockfile format in ${file} (expected version 2)`);
  }
  return lock as VibehardLockfile;
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
