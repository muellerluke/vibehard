import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  argvBytes,
  loadConfig,
  playwrightDriver,
  playwrightTailArgs,
  resolvePlaywrightCli,
  spawnCapture,
  testProject,
  toRunnableRef,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const T = 420_000;

const CHECKOUT_ID = "e2e/checkout.spec.ts::checkout page shows the cart total";
const EXTRA1_ID = "e2e/extra.spec.ts::extra page shows the cart total";
const EXTRA2_ID = "e2e/extra.spec.ts::extra page shows the cart total again";
const EXTRAB1_ID = "e2e/extra-b.spec.ts::extra b page shows the cart total";
const EXTRAB2_ID = "e2e/extra-b.spec.ts::extra b page shows the cart total again";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 60_000 });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
}

async function buildHarness(cwd: string): Promise<void> {
  const r = await spawnCapture(process.execPath, ["build-harness.mjs"], {
    cwd,
    timeoutMs: 120_000,
  });
  expect(r.exitCode, r.stderr).toBe(0);
}

/** Copy tiny-app and commit it as the base revision of its own git repo. */
async function makeGitCopy(): Promise<string> {
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
  mkdirSync(path.join(dir, "public"), { recursive: true });
  writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Delegation Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  await buildHarness(dir);
  return dir;
}

/** Budget that fits exactly one positional per invocation on this machine. */
async function onePositionalBudget(rootDir: string, positionals: string[]): Promise<number> {
  const resolved = await loadConfig(rootDir);
  const cli = resolvePlaywrightCli(rootDir);
  const tail = playwrightTailArgs(resolved);
  const fixedRun = argvBytes([process.execPath, cli, "test", ...tail]);
  const fixedList = argvBytes([process.execPath, cli, "test", "--list", "--reporter=json", ...tail]);
  const longest = Math.max(...positionals.map((p) => argvBytes([p])));
  return Math.max(fixedRun, fixedList) + longest + 5;
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildHarness(TINY_APP);
}, T);

describe("AT-S08: chunked delegation", () => {
  it("Playwright discovery lists tests from the JSON report file", async () => {
    const resolved = await loadConfig(TINY_APP);
    const saved = process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"];
    process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = "/nonexistent/user-value.json";
    try {
      const tests = await playwrightDriver.listTests(TINY_APP, resolved);
      expect(tests.map((t) => t.testId).sort()).toEqual(
        [CHECKOUT_ID, "e2e/checkout.spec.ts::coupon api accepts a code"].sort(),
      );
    } finally {
      if (saved === undefined) delete process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"];
      else process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = saved;
    }
    expect(process.env["PLAYWRIGHT_JSON_OUTPUT_FILE"]).toBe(saved);
  }, T);

  it("a chunked selected run matches the unchunked run; a filter mismatch is reported", async () => {
    const dir = await makeGitCopy();
    // A new spec: its tests are unrecorded, hence always selected.
    writeFileSync(
      path.join(dir, "e2e/extra.spec.ts"),
      [
        "import { expect, test } from 'vibehard/playwright';",
        "",
        "test('extra page shows the cart total', async ({ page }) => {",
        "  await page.goto('/');",
        "  await expect(page.locator('#price')).toHaveText('$43.97');",
        "});",
        "",
        "test('extra page shows the cart total again', async ({ page }) => {",
        "  await page.goto('/');",
        "  await expect(page.locator('#price')).toHaveText('$43.97');",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(dir, "e2e/extra-b.spec.ts"),
      [
        "import { expect, test } from 'vibehard/playwright';",
        "",
        "test('extra b page shows the cart total', async ({ page }) => {",
        "  await page.goto('/');",
        "  await expect(page.locator('#price')).toHaveText('$43.97');",
        "});",
        "",
        "test('extra b page shows the cart total again', async ({ page }) => {",
        "  await page.goto('/');",
        "  await expect(page.locator('#price')).toHaveText('$43.97');",
        "});",
        "",
      ].join("\n"),
    );
    // A leaf edit selecting only the checkout-page test of the old spec.
    // (Function replacer: a string replacement would eat the `$`.)
    const formatPath = path.join(dir, "src/lib/format.ts");
    const before = readFileSync(formatPath, "utf8");
    const mutated = before.replace(
      "return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;",
      () => "const dollars = (cents / CENTS_PER_DOLLAR).toFixed(2);\n  return `$${dollars}`;",
    );
    expect(mutated).not.toBe(before);
    writeFileSync(formatPath, mutated);
    await buildHarness(dir);

    const expected = [CHECKOUT_ID, EXTRA1_ID, EXTRA2_ID, EXTRAB1_ID, EXTRAB2_ID].sort();
    const budget = await onePositionalBudget(dir, [
      "e2e/checkout.spec.ts:3",
      "e2e/extra.spec.ts",
      "e2e/extra-b.spec.ts",
    ]);
    const chunked = await testProject({ rootDir: dir, argvBudgetBytes: budget });
    expect(chunked.exitCode, (chunked.output?.stdout ?? "").slice(0, 3000)).toBe(0);
    // On a full-mode fallback the mode alone says nothing; carry the
    // selection's own reasons so a CI flake self-explains.
    expect(
      chunked.ran?.mode,
      JSON.stringify({
        unsafeReasons: chunked.selection?.unsafeReasons,
        diagnostics: [
          ...(chunked.selection?.diagnostics ?? []),
          ...chunked.diagnostics,
        ],
      }),
    ).toBe("selected");
    expect([...(chunked.ran?.testIds ?? [])].sort()).toEqual(expected);
    expect(chunked.output?.chunks ?? 0).toBeGreaterThanOrEqual(2);
    expect(chunked.diagnostics.join("\n")).toContain("argv-budget chunks");

    const unchunked = await testProject({ rootDir: dir });
    expect(unchunked.exitCode, unchunked.output?.stderr ?? "").toBe(0);
    expect(unchunked.ran?.mode).toBe(chunked.ran?.mode);
    expect([...(unchunked.ran?.testIds ?? [])].sort()).toEqual(expected);

    // A claimed ID the filter does not resolve to must surface as a
    // filter problem (which `testProject` turns into a full run).
    const resolved = await loadConfig(dir);
    const listed = await playwrightDriver.listTests(dir, resolved);
    const refs = listed.map(toRunnableRef);
    const prove = playwrightDriver.proveFilter;
    if (prove === undefined) throw new Error("playwright proveFilter missing");
    expect(await prove({ rootDir: dir, resolved, tests: refs, argvBudgetBytes: budget })).toBeNull();
    const last = refs[refs.length - 1] as (typeof refs)[number];
    const tampered = [...refs.slice(0, -1), { ...last, testId: `${last.testId} (bogus)` }];
    const problem = await prove({ rootDir: dir, resolved, tests: tampered, argvBudgetBytes: budget });
    expect(problem).toContain("playwright --list resolved");
  }, T);
});
