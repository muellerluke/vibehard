import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordProject, spawnCapture, verifyProject } from "../src/index.js";
import { runCli } from "../src/cli/index.js";
import { freePort, releasePort } from "../src/verifier/servers.js";

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

/** Copy tiny-app inside the repo so workspace module resolution works. */
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

describe("Phase 3a lanes (--jobs)", () => {
  it("freePort never hands out the same unclaimed port twice", async () => {
    const first = await freePort();
    const second = await freePort();
    const rest = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const ports = [first, second, ...rest];
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) releasePort(port);
  });

  it("rejects invalid lane counts before any observation", async () => {
    await expect(recordProject({ rootDir: TINY_APP, jobs: 0 })).rejects.toThrow(
      "--jobs must be a positive integer",
    );
    await expect(verifyProject({ rootDir: TINY_APP, jobs: 1.5 })).rejects.toThrow(
      "--jobs must be a positive integer",
    );
    const bad = await runCli(["verify", "--jobs", "0"], { cwd: TINY_APP });
    expect(bad.exitCode).toBe(3);
    expect(bad.stderr).toContain("--jobs must be a positive integer");
    const onTest = await runCli(["test", "--jobs", "2"], { cwd: TINY_APP });
    expect(onTest.exitCode).toBe(3);
    expect(onTest.stderr).toContain("unknown option --jobs");
  });

  it(
    "AT-S06 (lanes): --jobs 4 records byte-identical lockfile and ordered results to --jobs 1",
    async () => {
      const serialDir = await makeCopy();
      const serial = await recordProject({ rootDir: serialDir, jobs: 1 });
      expect(serial.jobs).toBe(1);
      expect(serial.exitCode, JSON.stringify(serial.results, null, 2)).toBe(0);
      const serialBytes = readFileSync(path.join(serialDir, "vibehard.lock.json"), "utf8");

      const parallelDir = await makeCopy();
      const parallel = await recordProject({ rootDir: parallelDir, jobs: 4 });
      expect(parallel.jobs).toBe(4);
      expect(parallel.exitCode, JSON.stringify(parallel.results, null, 2)).toBe(0);
      const parallelBytes = readFileSync(path.join(parallelDir, "vibehard.lock.json"), "utf8");

      expect(parallelBytes).toBe(serialBytes);
      expect(parallel.results.map((r) => [r.testId, r.status])).toEqual(
        serial.results.map((r) => [r.testId, r.status]),
      );
      expect(parallel.results.map((r) => r.touched)).toEqual(serial.results.map((r) => r.touched));

      // Stress the lane cap above the test count twice; ports and
      // ordering must stay stable across repeated parallel verifies.
      for (let i = 0; i < 2; i += 1) {
        const verified = await verifyProject({ rootDir: parallelDir, jobs: 8 });
        expect(verified.exitCode, JSON.stringify(verified.results, null, 2)).toBe(0);
        expect(verified.results.map((r) => r.testId)).toEqual(serial.results.map((r) => r.testId));
        expect(verified.results.map((r) => r.status)).toEqual(["pass", "pass"]);
      }
    },
    T,
  );
});
