import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  recordProject,
  spawnCapture,
  verifyProject,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const T = 240_000;

const CHECKOUT_ID = "e2e/checkout.spec.ts::checkout page shows the cart total";
const COUPON_ID = "e2e/checkout.spec.ts::coupon api accepts a code";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 60_000 });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

async function buildHarness(cwd: string): Promise<void> {
  const r = await spawnCapture(process.execPath, ["build-harness.mjs"], {
    cwd,
    timeoutMs: 120_000,
  });
  expect(r.exitCode, r.stderr).toBe(0);
}

function edit(dir: string, rel: string, fn: (text: string) => string): void {
  const file = path.join(dir, rel);
  writeFileSync(file, fn(readFileSync(file, "utf8")));
}

/** Copy tiny-app, commit it as its own git base, and build its harness. */
async function makeGitCopy(): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-inc-"));
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
  writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Incremental Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  await buildHarness(dir);
  return dir;
}

function lockBytes(dir: string): string {
  return readFileSync(path.join(dir, "vibehard.lock.json"), "utf8");
}

/**
 * The AT-S07 equivalence: from the same pre-mutation lockfile,
 * incremental record and full record must reach the same bytes.
 * Returns the incremental result for subset assertions.
 */
async function expectIncrementalEqualsFull(dir: string) {
  const snapshot = lockBytes(dir);
  const incremental = await recordProject({ rootDir: dir, incremental: true, jobs: 2 });
  expect(incremental.incremental).toBe(true);
  expect(incremental.exitCode, JSON.stringify(incremental.results, null, 2)).toBe(0);
  const incrementalBytes = lockBytes(dir);

  writeFileSync(path.join(dir, "vibehard.lock.json"), snapshot);
  const full = await recordProject({ rootDir: dir });
  expect(full.incremental).toBe(false);
  expect(full.exitCode, JSON.stringify(full.results, null, 2)).toBe(0);
  expect(incrementalBytes).toBe(lockBytes(dir));
  return incremental;
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildHarness(TINY_APP);
}, T);

describe("Phase 3c incremental record (AT-S07)", () => {
  it(
    "leaf edit: re-observes only the affected test, agrees with full record and verify --ci",
    async () => {
      const dir = await makeGitCopy();
      edit(dir, "src/lib/format.ts", (t) =>
        t.replace("(cents / CENTS_PER_DOLLAR)", "(cents / CENTS_PER_DOLLAR + 0)"),
      );
      await buildHarness(dir);
      const incremental = await expectIncrementalEqualsFull(dir);
      expect(incremental.results.map((r) => r.testId)).toEqual([CHECKOUT_ID]);

      const verified = await verifyProject({ rootDir: dir, ci: true });
      expect(verified.exitCode, verified.lockfile.drift.join("\n")).toBe(0);
    },
    T,
  );

  it(
    "no change: observes nothing and leaves the lockfile untouched",
    async () => {
      const dir = await makeGitCopy();
      const before = lockBytes(dir);
      const incremental = await expectIncrementalEqualsFull(dir);
      expect(incremental.results).toEqual([]);
      expect(incremental.summary.total).toBe(0);
      expect(lockBytes(dir)).toBe(before);
    },
    T,
  );

  it(
    "new test in a changed spec is recorded; a deleted test is pruned",
    async () => {
      const addedDir = await makeGitCopy();
      appendFileSync(
        path.join(addedDir, "e2e/checkout.spec.ts"),
        "\ntest('coupon api accepts another code', async ({ request }) => {\n" +
          "  const response = await request.post('/api/coupons', { data: { code: 'SAVE20' } });\n" +
          "  expect(response.status()).toBe(200);\n});\n",
      );
      const added = await expectIncrementalEqualsFull(addedDir);
      expect(added.results.map((r) => r.testId)).toContain(
        "e2e/checkout.spec.ts::coupon api accepts another code",
      );

      const deletedDir = await makeGitCopy();
      edit(deletedDir, "e2e/checkout.spec.ts", (t) =>
        t.slice(0, t.indexOf("test('coupon api")),
      );
      const deleted = await expectIncrementalEqualsFull(deletedDir);
      expect(deleted.results.map((r) => r.testId)).toEqual([CHECKOUT_ID]);
      expect(lockBytes(deletedDir)).not.toContain(COUPON_ID);
    },
    T,
  );

  it("refuses when selection is unsafe or the lockfile is missing", async () => {
    const configDir = await makeGitCopy();
    edit(configDir, "package.json", (t) => t.replace('"private": true', '"private": false'));
    await expect(recordProject({ rootDir: configDir, incremental: true })).rejects.toThrow(
      /incremental record requires a safe selection/,
    );

    const missingDir = await makeGitCopy();
    rmSync(path.join(missingDir, "vibehard.lock.json"));
    await expect(recordProject({ rootDir: missingDir, incremental: true })).rejects.toThrow(
      /missing lockfile/,
    );
  }, T);

  it("refuses invalid combinations; CLI gates the flags", async () => {
    await expect(verifyProject({ rootDir: TINY_APP, incremental: true })).rejects.toThrow(
      "--incremental is only valid for record",
    );
    await expect(
      recordProject({
        rootDir: TINY_APP,
        incremental: true,
        shard: { index: 1, total: 2 },
      }),
    ).rejects.toThrow("--incremental cannot be combined with --shard");
    await expect(
      recordProject({ rootDir: TINY_APP, incremental: true, filter: ["checkout"] }),
    ).rejects.toThrow("--incremental cannot be combined with test filters");

    const onVerify = await runCli(["verify", "--incremental"], { cwd: TINY_APP });
    expect(onVerify.exitCode).toBe(3);
    const onTest = await runCli(["test", "--incremental"], { cwd: TINY_APP });
    expect(onTest.exitCode).toBe(3);
    const baseAlone = await runCli(["record", "--base", "HEAD"], { cwd: TINY_APP });
    expect(baseAlone.exitCode).toBe(3);
    expect(baseAlone.stderr).toContain("--base is only valid for record --incremental");
    const fastAlone = await runCli(["record", "--fast-select"], { cwd: TINY_APP });
    expect(fastAlone.exitCode).toBe(3);
  }, T);
});
