import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INDEXER_VERSION,
  discoveredSetHash,
  mergeShardArtifactList,
  mergeShardArtifacts,
  parseShardSpec,
  recordProject,
  shardOfTestId,
  shardTests,
  spawnCapture,
  verifyProject,
  type LockfileTestEntry,
  type ShardArtifact,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const T = 240_000;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function buildHarness(cwd: string): Promise<void> {
  const r = await spawnCapture(process.execPath, ["build-harness.mjs"], {
    cwd,
    timeoutMs: 120_000,
  });
  expect(r.exitCode, r.stderr).toBe(0);
}

async function makeCopy(): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(TINY_APP, dir, {
    recursive: true,
    filter: (src) =>
      !src.includes("node_modules") &&
      !src.includes(`${path.sep}.build`) &&
      !src.includes("test-results"),
  });
  const tsconfigPath = path.join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as { extends?: string };
  tsconfig.extends = path.join(REPO_ROOT, "tsconfig.base.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  rmSync(path.join(dir, "vibehard.lock.json"), { force: true });
  await buildHarness(dir);
  return dir;
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildHarness(TINY_APP);
}, T);

function fakeEntry(testId: string): LockfileTestEntry {
  return {
    file: "e2e/x.spec.ts",
    titlePath: [testId],
    touched: { "src/a.ts#fn": "direct" },
    symbolHashes: { "src/a.ts#fn": "a".repeat(64) },
  };
}

/** Test IDs `t0..t(n-1)` under one spec, bucketed by their real shard. */
function syntheticIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `e2e/x.spec.ts::t${i}`);
}

function fakeArtifact(index: number, total: number, allIds: string[]): ShardArtifact {
  const mine = allIds.filter((id) => shardOfTestId(id, total) === index);
  return {
    kind: "vibehard-shard",
    version: 1,
    shard: { index, total },
    provenance: {
      configHash: "cfg",
      framework: { name: "playwright", version: "1.0.0" },
      graphVersion: INDEXER_VERSION,
      source: { head: "abc123", dirty: false },
      discovered: { count: allIds.length, hash: discoveredSetHash(allIds) },
    },
    tests: Object.fromEntries(mine.map((id) => [id, fakeEntry(id)])),
    results: mine.map((testId) => ({ testId, status: "recorded" as const })),
  };
}

describe("Phase 3b shard assignment and merge validation", () => {
  it("parses and rejects shard specs", () => {
    expect(parseShardSpec("1/3")).toEqual({ index: 1, total: 3 });
    expect(parseShardSpec(" 2 / 2 ")).toEqual({ index: 2, total: 2 });
    for (const bad of ["", "0/3", "4/3", "1/0", "a/b", "1", "-1/3"]) {
      expect(() => parseShardSpec(bad)).toThrow("--shard");
    }
  });

  it("partitions a synthetic suite disjointly and completely", () => {
    const ids = syntheticIds(60);
    const tests = ids.map((testId) => ({ testId }));
    const buckets = [1, 2, 3, 4].map((index) =>
      shardTests(tests, { index, total: 4 }).map((t) => t.testId),
    );
    expect(buckets.flat().sort()).toEqual([...ids].sort());
    expect(new Set(buckets.flat()).size).toBe(ids.length);
    for (const bucket of buckets) expect(bucket.length).toBeGreaterThan(0);
    // Assignment is per-ID, so input order cannot move a test.
    const reversed = shardTests([...tests].reverse(), { index: 2, total: 4 })
      .map((t) => t.testId)
      .sort();
    expect(reversed).toEqual([...(buckets[1] as string[])].sort());
  });

  it("merges a complete artifact set and refuses broken ones", () => {
    const ids = syntheticIds(30);
    const total = 3;
    const artifacts = [1, 2, 3].map((i) => ({
      file: `shard-${i}.json`,
      artifact: fakeArtifact(i, total, ids),
    }));
    const merged = mergeShardArtifactList(artifacts);
    expect(merged.entries.size).toBe(ids.length);

    // Missing shard.
    expect(() => mergeShardArtifactList(artifacts.slice(0, 2))).toThrow(/missing shard 3\/3/);
    // Duplicate shard.
    expect(() =>
      mergeShardArtifactList([...artifacts, artifacts[0] as (typeof artifacts)[number]]),
    ).toThrow(/duplicate shard/);
    // Provenance mismatch.
    const tampered = structuredClone(artifacts);
    (tampered[1] as (typeof artifacts)[number]).artifact.provenance.configHash = "other";
    expect(() => mergeShardArtifactList(tampered)).toThrow(/provenance differs/);
    // Dirty-vs-clean source mismatch.
    const dirty = structuredClone(artifacts);
    (dirty[0] as (typeof artifacts)[number]).artifact.provenance.source.dirty = true;
    expect(() => mergeShardArtifactList(dirty)).toThrow(/provenance differs/);
    // Failed status cannot merge.
    const failed = structuredClone(artifacts);
    const failedArtifact = (failed[0] as (typeof artifacts)[number]).artifact;
    if (failedArtifact.results[0] !== undefined) failedArtifact.results[0].status = "unstable";
    expect(() => mergeShardArtifactList(failed)).toThrow(/only recorded\/always-run/);
  });

  it("CLI rejects shard/merge misuse without observing", async () => {
    const badShard = await runCli(["record", "--shard", "9/2"], { cwd: TINY_APP });
    expect(badShard.exitCode).toBe(3);
    const onTest = await runCli(["test", "--shard", "1/2"], { cwd: TINY_APP });
    expect(onTest.exitCode).toBe(3);
    expect(onTest.stderr).toContain("unknown option --shard");
    const mergeOnVerify = await runCli(["verify", "--merge", "x.json"], { cwd: TINY_APP });
    expect(mergeOnVerify.exitCode).toBe(3);
    const noFiles = await runCli(["record", "--merge"], { cwd: TINY_APP });
    expect(noFiles.exitCode).toBe(3);
    expect(noFiles.stderr).toContain("--merge requires");
    const missing = await runCli(["record", "--merge", "nope.json"], { cwd: TINY_APP });
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toContain("not found");
    const outOnVerify = await runCli(["verify", "--shard", "1/2", "--shard-out", "x.json"], {
      cwd: TINY_APP,
    });
    expect(outOnVerify.exitCode).toBe(3);
    // Filters combined with a shard are refused by the runner.
    await expect(
      recordProject({ rootDir: TINY_APP, shard: { index: 1, total: 2 }, filter: ["x"] }),
    ).rejects.toThrow("--shard cannot be combined");
  });
});

describe("Phase 3b sharded record (tiny-app)", () => {
  it(
    "AT-S06 (shards): a 3-shard record merges to the byte-identical lockfile of the serial record",
    async () => {
      const serialDir = await makeCopy();
      const serial = await recordProject({ rootDir: serialDir });
      expect(serial.exitCode, JSON.stringify(serial.results, null, 2)).toBe(0);
      const serialBytes = readFileSync(path.join(serialDir, "vibehard.lock.json"), "utf8");

      const shardedDir = await makeCopy();
      const artifactDir = mkdtempSync(path.join(tmpdir(), "vibehard-shards-"));
      tempDirs.push(artifactDir);
      const files: string[] = [];
      for (const index of [1, 2, 3]) {
        const file = path.join(artifactDir, `shard-${index}.json`);
        const result = await recordProject({
          rootDir: shardedDir,
          shard: { index, total: 3 },
          shardOut: file,
          jobs: 2,
        });
        expect(result.exitCode, JSON.stringify(result.results, null, 2)).toBe(0);
        expect(result.shard).toEqual({ index, total: 3 });
        expect(result.shardArtifact).toBe(file);
        expect(result.lockfile.written).toBe(false);
        expect(existsSync(path.join(shardedDir, "vibehard.lock.json"))).toBe(false);
        files.push(file);
      }

      const merged = await mergeShardArtifacts({ rootDir: shardedDir, files });
      expect(merged.exitCode).toBe(0);
      expect(merged.shards).toBe(3);
      expect(merged.tests).toBe(serial.results.length);
      expect(merged.lockfile.written).toBe(true);
      const mergedBytes = readFileSync(path.join(shardedDir, "vibehard.lock.json"), "utf8");
      expect(mergedBytes).toBe(serialBytes);

      // A tampered artifact set is refused and the lockfile is untouched.
      const tamperDir = mkdtempSync(path.join(tmpdir(), "vibehard-shards-"));
      tempDirs.push(tamperDir);
      const tamperedFiles = files.map((file, i) => {
        const target = path.join(tamperDir, `s${i}.json`);
        const parsed = JSON.parse(readFileSync(file, "utf8")) as ShardArtifact;
        if (i === 0) parsed.provenance.configHash = "tampered";
        writeFileSync(target, JSON.stringify(parsed));
        return target;
      });
      await expect(
        mergeShardArtifacts({ rootDir: shardedDir, files: tamperedFiles }),
      ).rejects.toThrow(/provenance|config hash/);
      expect(readFileSync(path.join(shardedDir, "vibehard.lock.json"), "utf8")).toBe(serialBytes);

      // Verify can also run a single shard against the merged lockfile.
      const verified = await verifyProject({
        rootDir: shardedDir,
        shard: { index: 1, total: 3 },
        ci: true,
      });
      expect(verified.shard).toEqual({ index: 1, total: 3 });
      expect(verified.exitCode, JSON.stringify(verified.results, null, 2)).toBe(0);
      for (const r of verified.results) {
        expect(shardOfTestId(r.testId, 3)).toBe(1);
      }
    },
    T,
  );
});
