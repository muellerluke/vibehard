import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { INDEXER_VERSION } from "../indexer/index.js";
import type { LockfileTestEntry } from "./lockfile.js";
import { spawnCapture } from "./servers.js";
import { VibehardUsageError, type ShardSpec, type TestVerifyStatus } from "./types.js";

/**
 * Sharded recording (Scaling Phase 3b). A `record --shard i/n` run
 * observes one deterministic slice of the discovered tests and writes
 * a shard artifact instead of touching the lockfile. `record --merge`
 * validates a complete set of artifacts and writes the lockfile once.
 * Shard assignment is a stable hash of the test ID, so shards are
 * disjoint and complete regardless of discovery order.
 */

export interface ShardSourceState {
  /** HEAD commit of the checkout the shard ran in, or null outside git. */
  head: string | null;
  /** Whether the checkout had uncommitted changes. */
  dirty: boolean;
}

export interface ShardProvenance {
  configHash: string;
  framework: { name: string; version: string };
  graphVersion: number;
  source: ShardSourceState;
  /** The full discovered test set every shard must agree on. */
  discovered: { count: number; hash: string };
}

export interface ShardArtifact {
  kind: "vibehard-shard";
  version: 1;
  shard: ShardSpec;
  provenance: ShardProvenance;
  /** Recorded entries by test ID (the lockfile's in-memory shape). */
  tests: Record<string, LockfileTestEntry>;
  /** Outcome per observed test; merge refuses non-success statuses. */
  results: { testId: string; status: TestVerifyStatus }[];
}

export function validateShardSpec(shard: ShardSpec): void {
  if (
    !Number.isInteger(shard.total) ||
    shard.total < 1 ||
    !Number.isInteger(shard.index) ||
    shard.index < 1 ||
    shard.index > shard.total
  ) {
    throw new VibehardUsageError(
      `vibehard: --shard must be <index>/<total> with 1 <= index <= total (got ${shard.index}/${shard.total})`,
    );
  }
}

/** Parse a `--shard <i>/<n>` argument (1-based, like Playwright). */
export function parseShardSpec(text: string): ShardSpec {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text.trim());
  if (match === null) {
    throw new VibehardUsageError(`vibehard: --shard must be <index>/<total> (got "${text}")`);
  }
  const shard: ShardSpec = { index: Number(match[1]), total: Number(match[2]) };
  validateShardSpec(shard);
  return shard;
}

export function formatShardSpec(shard: ShardSpec): string {
  return `${shard.index}/${shard.total}`;
}

/** The 1-based shard a test belongs to: stable SHA-256 of its ID. */
export function shardOfTestId(testId: string, total: number): number {
  const digest = createHash("sha256").update(testId).digest();
  return (digest.readUInt32BE(0) % total) + 1;
}

/** The discovered tests assigned to this shard, in input order. */
export function shardTests<T extends { testId: string }>(
  tests: readonly T[],
  shard: ShardSpec,
): T[] {
  validateShardSpec(shard);
  return tests.filter((t) => shardOfTestId(t.testId, shard.total) === shard.index);
}

/** Order-independent fingerprint of a discovered test ID set. */
export function discoveredSetHash(testIds: readonly string[]): string {
  return createHash("sha256").update([...testIds].sort().join("\n")).digest("hex");
}

async function gitText(rootDir: string, args: string[]): Promise<string | null> {
  try {
    const result = await spawnCapture("git", args, { cwd: rootDir, timeoutMs: 30_000 });
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Source-state marker for shard provenance: the checkout's HEAD plus
 * a dirty flag. Shards are meant to run as a CI matrix over one
 * commit, where this pins them to the same tree; per-symbol hashes in
 * the entries (and the `test`-time trust check) catch anything a
 * dirty tree lets through. Outside git there is nothing to pin to,
 * reported honestly as `{ head: null, dirty: true }`.
 */
export async function shardSourceState(rootDir: string): Promise<ShardSourceState> {
  const head = await gitText(rootDir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head === null) return { head: null, dirty: true };
  const status = await gitText(rootDir, ["status", "--porcelain"]);
  return { head: head.trim(), dirty: status === null || status.trim() !== "" };
}

export function serializeShardArtifact(artifact: ShardArtifact): string {
  const tests: Record<string, LockfileTestEntry> = {};
  for (const testId of Object.keys(artifact.tests).sort()) {
    const entry = artifact.tests[testId];
    if (entry !== undefined) tests[testId] = entry;
  }
  return `${JSON.stringify({ ...artifact, tests }, null, 2)}\n`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidShard(file: string, detail: string): never {
  throw new VibehardUsageError(`vibehard: invalid shard artifact ${file}: ${detail}`);
}

export function parseShardArtifact(text: string, file: string): ShardArtifact {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new VibehardUsageError(
      `vibehard: invalid JSON in shard artifact ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecordValue(value)) invalidShard(file, "expected a JSON object");
  if (value["kind"] !== "vibehard-shard") invalidShard(file, `missing kind "vibehard-shard"`);
  if (value["version"] !== 1) {
    invalidShard(file, `unsupported version ${String(value["version"])} (expected 1)`);
  }
  const shardRaw = value["shard"];
  if (!isRecordValue(shardRaw)) invalidShard(file, `"shard" must be an object`);
  const shard: ShardSpec = {
    index: shardRaw["index"] as number,
    total: shardRaw["total"] as number,
  };
  try {
    validateShardSpec(shard);
  } catch {
    invalidShard(file, `bad shard ${String(shardRaw["index"])}/${String(shardRaw["total"])}`);
  }
  const provenance = value["provenance"];
  if (!isRecordValue(provenance)) invalidShard(file, `"provenance" must be an object`);
  const framework = provenance["framework"];
  const source = provenance["source"];
  const discovered = provenance["discovered"];
  if (
    typeof provenance["configHash"] !== "string" ||
    !isRecordValue(framework) ||
    typeof framework["name"] !== "string" ||
    typeof framework["version"] !== "string" ||
    !Number.isInteger(provenance["graphVersion"]) ||
    !isRecordValue(source) ||
    !(source["head"] === null || typeof source["head"] === "string") ||
    typeof source["dirty"] !== "boolean" ||
    !isRecordValue(discovered) ||
    !Number.isInteger(discovered["count"]) ||
    typeof discovered["hash"] !== "string"
  ) {
    invalidShard(file, `"provenance" is malformed`);
  }
  const rawTests = value["tests"];
  if (!isRecordValue(rawTests)) invalidShard(file, `"tests" must be an object`);
  const tests: Record<string, LockfileTestEntry> = {};
  for (const [testId, rawEntry] of Object.entries(rawTests)) {
    if (!isRecordValue(rawEntry)) invalidShard(file, `test ${testId} must be an object`);
    if (
      typeof rawEntry["file"] !== "string" ||
      !Array.isArray(rawEntry["titlePath"]) ||
      !isRecordValue(rawEntry["touched"]) ||
      !isRecordValue(rawEntry["symbolHashes"])
    ) {
      invalidShard(file, `test ${testId} entry is malformed`);
    }
    tests[testId] = rawEntry as unknown as LockfileTestEntry;
  }
  const rawResults = value["results"];
  if (!Array.isArray(rawResults)) invalidShard(file, `"results" must be an array`);
  const results: ShardArtifact["results"] = [];
  for (const raw of rawResults) {
    if (
      !isRecordValue(raw) ||
      typeof raw["testId"] !== "string" ||
      typeof raw["status"] !== "string"
    ) {
      invalidShard(file, `"results" entries must carry string testId and status`);
    }
    results.push({
      testId: raw["testId"],
      status: raw["status"] as TestVerifyStatus,
    });
  }
  return {
    kind: "vibehard-shard",
    version: 1,
    shard,
    provenance: provenance as unknown as ShardProvenance,
    tests,
    results,
  };
}

export function readShardArtifact(file: string): ShardArtifact {
  if (!existsSync(file)) {
    throw new VibehardUsageError(`vibehard: shard artifact not found: ${file}`);
  }
  return parseShardArtifact(readFileSync(file, "utf8"), file);
}

/** Write atomically; returns false when the bytes are unchanged. */
export function writeShardArtifact(file: string, artifact: ShardArtifact): boolean {
  const text = serializeShardArtifact(artifact);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
  return true;
}

/**
 * Validate a set of shard artifacts as one complete record and return
 * the merged entries. Pure: no config, discovery, or lockfile access,
 * so every refusal is unit-testable without a browser.
 */
export function mergeShardArtifactList(
  inputs: readonly { file: string; artifact: ShardArtifact }[],
): { provenance: ShardProvenance; total: number; entries: Map<string, LockfileTestEntry> } {
  const refuse = (detail: string): never => {
    throw new VibehardUsageError(`vibehard: cannot merge shard artifacts: ${detail}`);
  };
  if (inputs.length === 0) refuse("no shard artifacts given");
  const first = inputs[0] as { file: string; artifact: ShardArtifact };
  const total = first.artifact.shard.total;
  const provenance = first.artifact.provenance;
  const byIndex = new Map<number, { file: string; artifact: ShardArtifact }>();
  for (const input of inputs) {
    const { shard, provenance: prov } = input.artifact;
    if (shard.total !== total) {
      refuse(`${input.file} is shard ${formatShardSpec(shard)} but ${first.file} uses total ${total}`);
    }
    if (byIndex.has(shard.index)) refuse(`duplicate shard ${formatShardSpec(shard)} (${input.file})`);
    byIndex.set(shard.index, input);
    if (
      prov.configHash !== provenance.configHash ||
      prov.framework.name !== provenance.framework.name ||
      prov.framework.version !== provenance.framework.version ||
      prov.graphVersion !== provenance.graphVersion ||
      prov.source.head !== provenance.source.head ||
      prov.source.dirty !== provenance.source.dirty ||
      prov.discovered.count !== provenance.discovered.count ||
      prov.discovered.hash !== provenance.discovered.hash
    ) {
      refuse(`${input.file} provenance differs from ${first.file} (config, framework, graph, source, or discovered set)`);
    }
    if (prov.graphVersion !== INDEXER_VERSION) {
      refuse(`${input.file} graph version ${prov.graphVersion} differs from current ${INDEXER_VERSION} (re-run \`vibehard record\`)`);
    }
  }
  for (let index = 1; index <= total; index += 1) {
    if (!byIndex.has(index)) refuse(`missing shard ${index}/${total}`);
  }

  const entries = new Map<string, LockfileTestEntry>();
  for (let index = 1; index <= total; index += 1) {
    const { file, artifact } = byIndex.get(index) as { file: string; artifact: ShardArtifact };
    const resultIds = new Set<string>();
    for (const result of artifact.results) {
      if (result.status !== "recorded" && result.status !== "always-run") {
        refuse(`${file}: test ${result.testId} has status "${result.status}" (only recorded/always-run shards can merge)`);
      }
      if (resultIds.has(result.testId)) refuse(`${file}: duplicate result for ${result.testId}`);
      resultIds.add(result.testId);
      if (shardOfTestId(result.testId, total) !== index) {
        refuse(`${file}: test ${result.testId} does not belong to shard ${index}/${total}`);
      }
    }
    for (const testId of Object.keys(artifact.tests)) {
      if (!resultIds.has(testId)) refuse(`${file}: entry for ${testId} has no matching result`);
    }
    for (const testId of resultIds) {
      if (!Object.hasOwn(artifact.tests, testId)) {
        refuse(`${file}: result for ${testId} has no recorded entry`);
      }
      if (entries.has(testId)) refuse(`test ${testId} appears in more than one shard`);
      entries.set(testId, artifact.tests[testId] as LockfileTestEntry);
    }
  }
  if (entries.size !== provenance.discovered.count) {
    refuse(
      `merged ${entries.size} test(s) but the shards recorded against ${provenance.discovered.count} discovered test(s)`,
    );
  }
  if (discoveredSetHash([...entries.keys()]) !== provenance.discovered.hash) {
    refuse("merged test set does not match the discovered set the shards recorded against");
  }
  return { provenance, total, entries };
}
