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
  recordProject,
  spawnCapture,
  testProject,
  verifyProject,
  type ProjectVerifyResult,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const EXAMPLE = path.join(REPO_ROOT, "examples/plain-puppeteer");
const T = 420_000;

const HOME = "e2e/app.test.mjs::home page shows the cart total";
const ADD_ITEM = "src/lib/cart.ts#Cart.addItem";
const DISCOUNT = "src/lib/pricing.ts#applyDiscount";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function buildExample(cwd: string): Promise<void> {
  const r = await spawnCapture(process.execPath, ["build.mjs"], { cwd, timeoutMs: 120_000 });
  expect(r.exitCode, r.stderr).toBe(0);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 60_000 });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
}

function edit(dir: string, rel: string, fn: (text: string) => string): void {
  const file = path.join(dir, rel);
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  expect(after, `mutation must change ${rel}`).not.toBe(before);
  writeFileSync(file, after);
}

function copyFilter(src: string): boolean {
  return (
    !src.includes("node_modules") &&
    !src.includes(`${path.sep}.build`) &&
    !src.includes("test-results")
  );
}

async function makeCopy(mutate?: (dir: string) => void): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, { recursive: true, filter: copyFilter });
  const tsconfigPath = path.join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as { extends?: string };
  tsconfig.extends = path.join(REPO_ROOT, "tsconfig.base.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  mutate?.(dir);
  await buildExample(dir);
  return dir;
}

async function makeGitCopy(): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, { recursive: true, filter: copyFilter });
  const tsconfigPath = path.join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as { extends?: string };
  tsconfig.extends = path.join(REPO_ROOT, "tsconfig.base.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
  await buildExample(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Stage 6 Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  return dir;
}

function only(result: ProjectVerifyResult) {
  expect(result.results).toHaveLength(1);
  const r = result.results[0];
  if (r === undefined) throw new Error("missing result");
  return r;
}

/** Remove the options-object argument of one describeTest call. */
function stripDeclaration(text: string, title: string): string {
  const at = text.indexOf(`describeTest("${title}", {`);
  expect(at, `declared call for "${title}"`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("}, async", at);
  expect(end).toBeGreaterThan(at);
  return text.slice(0, at) + `describeTest("${title}", async` + text.slice(end + "}, async".length);
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildExample(EXAMPLE);
}, T);

describe("AT-22: Puppeteer adapter on examples/plain-puppeteer", () => {
  it("AT-07 equivalent: exact declarations pass verify (lockfile current)", async () => {
    const r = await runCli(["verify", "--json"], { cwd: EXAMPLE });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as ProjectVerifyResult & { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(parsed.lockfile.written).toBe(false);
  }, T);

  it("AT-08 equivalent: removing a used symbol fails as extra", async () => {
    const dir = await makeCopy((d) =>
      edit(d, "e2e/app.test.mjs", (text) =>
        text.replace(`    '${ADD_ITEM}',\n`, ""),
      ),
    );
    const result = await verifyProject({ rootDir: dir, filter: ["home page"] });
    const r = only(result);
    expect(result.exitCode).toBe(2);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual([ADD_ITEM]);
  }, T);

  it("AT-09 equivalent: adding an unused symbol fails as missing", async () => {
    const dir = await makeCopy((d) =>
      edit(d, "e2e/app.test.mjs", (text) =>
        text.replace(
          "    'src/page.ts#renderHome',",
          `    '${DISCOUNT}',\n    'src/page.ts#renderHome',`,
        ),
      ),
    );
    const result = await verifyProject({ rootDir: dir, filter: ["home page"] });
    const r = only(result);
    expect(result.exitCode).toBe(2);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual([DISCOUNT]);
  }, T);

  it("AT-10 equivalent: exercising a new app symbol fails as extra", async () => {
    const dir = await makeCopy((d) => {
      edit(d, "src/client.ts", (text) =>
        text
          .replace(
            'import { formatPrice } from "./lib/pricing.js";',
            'import { applyDiscount, formatPrice } from "./lib/pricing.js";',
          )
          .replace(
            "if (total !== null) total.textContent = formatPrice(cart.totalCents());",
            "if (total !== null) total.textContent = formatPrice(applyDiscount(cart.totalCents(), 0));",
          ),
      );
    });
    const result = await verifyProject({ rootDir: dir, filter: ["home page"] });
    const r = only(result);
    expect(result.exitCode).toBe(2);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual([DISCOUNT]);
  }, T);

  it("record writes a declaration for an undeclared test; twice is a no-op", async () => {
    const dir = await makeCopy((d) => {
      edit(d, "e2e/app.test.mjs", (text) =>
        stripDeclaration(text, "price api applies a discount"),
      );
      rmSync(path.join(d, "vibehard.lock.json"), { force: true });
    });
    const first = await recordProject({ rootDir: dir, filter: ["price api"] });
    expect(only(first).status).toBe("recorded");
    const afterFirst = readFileSync(path.join(dir, "e2e/app.test.mjs"), "utf8");
    expect(afterFirst).toContain("'src/api.ts#priceHandler'");
    const second = await recordProject({ rootDir: dir, filter: ["price api"] });
    expect(only(second).changed).not.toBe(true);
    expect(readFileSync(path.join(dir, "e2e/app.test.mjs"), "utf8")).toBe(afterFirst);
    const verify = await verifyProject({ rootDir: dir, filter: ["price api"] });
    expect(only(verify).status).toBe("pass");
  }, T);

  it("selection: a cart change selects and runs exactly the home test", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/cart.ts", (text) =>
      text.replace(
        "existing.quantity += item.quantity;",
        "existing.quantity += item.quantity + 0;",
      ),
    );
    await buildExample(dir);
    const dry = await testProject({ rootDir: dir, dryRun: true });
    expect(dry.exitCode, JSON.stringify(dry.selection?.unsafeReasons)).toBe(0);
    expect(dry.selection?.selected.map((t) => t.testId)).toEqual([HOME]);
    const run = await testProject({ rootDir: dir });
    expect(run.exitCode, run.output?.stdout ?? "").toBe(0);
    expect(run.ran?.mode).toBe("selected");
    expect(run.ran?.testIds).toEqual([HOME]);
    expect(run.ran?.frameworkExitCode).toBe(0);
  }, T);
});
