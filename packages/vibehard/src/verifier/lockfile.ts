import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { SymbolId, SymbolRecord } from "../index.js";
import { VibehardUsageError } from "./types.js";

export interface LockfileTestEntry {
  file: string;
  titlePath: string[];
  declared: SymbolId[];
  /** sha256 of each declared symbol's exact source slice, by symbol ID. */
  symbolHashes: Record<string, string>;
  allowTransitive: string[];
  allowedObserved: SymbolId[];
  skipVerify?: string;
}

export interface VibehardLockfile {
  version: 1;
  framework: { name: string; version: string };
  configHash: string;
  tests: Record<string, LockfileTestEntry>;
}

/** Hash the current source slice of every given symbol (file read once). */
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
    const text = readFileSync(path.resolve(rootDir, file), "utf8");
    for (const record of records) {
      out[record.id] = createHash("sha256")
        .update(text.slice(record.startOffset, record.endOffset))
        .digest("hex");
    }
  }
  return out;
}

/** Installed `@playwright/test` version for the project, or "unknown". */
export function playwrightTestVersion(rootDir: string): string {
  try {
    const req = createRequire(path.join(path.resolve(rootDir), "package.json"));
    const pkg = req("@playwright/test/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function emptyLockfile(configHash: string, frameworkVersion: string): VibehardLockfile {
  return {
    version: 1,
    framework: { name: "playwright", version: frameworkVersion },
    configHash,
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
    const normalized: LockfileTestEntry = {
      file: entry.file,
      titlePath: [...entry.titlePath],
      declared: [...entry.declared].sort(),
      symbolHashes,
      allowTransitive: [...entry.allowTransitive].sort(),
      allowedObserved: [...entry.allowedObserved].sort(),
    };
    if (entry.skipVerify !== undefined) normalized.skipVerify = entry.skipVerify;
    tests[key] = normalized;
  }
  const ordered: VibehardLockfile = {
    version: 1,
    framework: lock.framework,
    configHash: lock.configHash,
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
  if (lock === null || typeof lock !== "object" || lock.version !== 1 || typeof lock.tests !== "object" || lock.tests === null) {
    throw new VibehardUsageError(`vibehard: unsupported lockfile format in ${file} (expected version 1)`);
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
  declared: SymbolId[] | null;
  symbolHashes: Record<string, string>;
}

/**
 * Compare a lockfile against the current run's declarations and source
 * hashes. Returns human-readable drift entries (empty = in agreement).
 */
export function checkLockfile(
  lock: VibehardLockfile | null,
  input: {
    configHash: string;
    frameworkVersion: string;
    expectations: readonly LockfileExpectation[];
    /** When true, lockfile tests absent from expectations are drift. */
    fullRun: boolean;
    discoveredTestIds?: ReadonlySet<string>;
  },
): string[] {
  if (lock === null) return ["lockfile missing (run `vibehard record` or `vibehard verify`)"];
  const drift: string[] = [];
  if (lock.configHash !== input.configHash) drift.push("lockfile config hash differs from current config");
  if (lock.framework.name !== "playwright" || lock.framework.version !== input.frameworkVersion) {
    drift.push(`lockfile framework ${lock.framework.name}@${lock.framework.version} differs from playwright@${input.frameworkVersion}`);
  }
  for (const exp of input.expectations) {
    const entry = lock.tests[exp.testId];
    if (entry === undefined) {
      drift.push(`${exp.testId}: missing from lockfile`);
      continue;
    }
    const declaredNow = [...(exp.declared ?? [])].sort();
    if (JSON.stringify([...entry.declared].sort()) !== JSON.stringify(declaredNow)) {
      drift.push(`${exp.testId}: declared set in code differs from lockfile`);
    }
    for (const id of declaredNow) {
      const expected = exp.symbolHashes[id];
      if (expected === undefined) continue; // unknown symbol; diff reports it
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
