import {
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
  spawnCapture,
  testProject,
  verifyProject,
  type ProjectVerifyResult,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const PUPPETEER_CONFIG = "vibehard.config.puppeteer.json";
const T = 420_000;

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

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 60_000 });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
}

function setsByTitle(result: ProjectVerifyResult): Map<string, { touched: unknown; observed: unknown }> {
  return new Map(
    result.results.map((r) => [r.title, { touched: r.touched, observed: r.observed }]),
  );
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildHarness(TINY_APP);
}, T);

describe("AT-24: adapter conformance on fixtures/tiny-app", () => {
  it("the same touched sets verify identically under Playwright and Puppeteer", async () => {
    const playwright = await verifyProject({ rootDir: TINY_APP });
    const puppeteer = await verifyProject({ rootDir: TINY_APP, configPath: PUPPETEER_CONFIG });
    expect(playwright.exitCode, JSON.stringify(playwright.results, null, 2)).toBe(0);
    expect(puppeteer.exitCode, JSON.stringify(puppeteer.results, null, 2)).toBe(0);
    const pw = setsByTitle(playwright);
    const pp = setsByTitle(puppeteer);
    expect([...pp.keys()].sort()).toEqual([...pw.keys()].sort());
    for (const [title, sets] of pw) {
      expect(pp.get(title)?.touched, title).toEqual(sets.touched);
      expect(pp.get(title)?.observed, title).toEqual(sets.observed);
    }
  }, T);

  it("a one-symbol mutation selects the same tests under both adapters", async () => {
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
    writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
    await buildHarness(dir);
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "test@example.invalid"]);
    await git(dir, ["config", "user.name", "Stage 6 Test"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "base"]);

    const formatPath = path.join(dir, "src/lib/format.ts");
    const before = readFileSync(formatPath, "utf8");
    // Body edit inside formatPrice (same output): its hash changes, so
    // selection must include its touching tests under both adapters.
    const mutated = before.replace(
      "return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;",
      "const dollars = (cents / CENTS_PER_DOLLAR).toFixed(2);\n  return `$${dollars}`;",
    );
    expect(mutated).not.toBe(before);
    writeFileSync(formatPath, mutated);
    await buildHarness(dir);

    const pw = await testProject({ rootDir: dir, dryRun: true });
    const pp = await testProject({ rootDir: dir, dryRun: true, configPath: PUPPETEER_CONFIG });
    expect(pw.exitCode, JSON.stringify(pw.selection?.unsafeReasons)).toBe(0);
    expect(pp.exitCode, JSON.stringify(pp.selection?.unsafeReasons)).toBe(0);
    const pwTitles = (pw.selection?.selected ?? []).map((t) => t.title).sort();
    const ppTitles = (pp.selection?.selected ?? []).map((t) => t.title).sort();
    expect(pwTitles).toEqual(["checkout page shows the cart total"]);
    expect(ppTitles).toEqual(pwTitles);
  }, T);
});
