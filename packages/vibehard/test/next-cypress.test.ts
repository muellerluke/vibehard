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
const EXAMPLE = path.join(REPO_ROOT, "examples/next-cypress");
const NEXT_BIN = path.join(REPO_ROOT, "node_modules/next/dist/bin/next");
const T = 900_000;

const HOME = "cypress/e2e/app.cy.js::home page prices, counts, and saves a note";
const COUNTER = "src/app/counter/Counter.tsx#Counter";
const DISCOUNT = "src/lib/pricing.ts#applyDiscount";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Instrumented production build of a copy (the example's build shape). */
async function buildNext(cwd: string): Promise<void> {
  const r = await spawnCapture(process.execPath, [NEXT_BIN, "build", "--webpack"], {
    cwd,
    env: { BABEL_ENV: "cypress" },
    timeoutMs: 300_000,
  });
  expect(r.exitCode, r.stdout.slice(-2000) + r.stderr.slice(-2000)).toBe(0);
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
    !src.includes(`${path.sep}.next`) &&
    !src.includes("screenshots") &&
    !src.includes("videos") &&
    !src.endsWith("next-env.d.ts")
  );
}

async function makeCopy(mutate?: (dir: string) => void): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, { recursive: true, filter: copyFilter });
  mutate?.(dir);
  await buildNext(dir);
  return dir;
}

async function makeGitCopy(): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, { recursive: true, filter: copyFilter });
  writeFileSync(
    path.join(dir, ".gitignore"),
    ".next/\nnode_modules/\nnext-env.d.ts\ncypress/screenshots/\ncypress/videos/\n",
  );
  await buildNext(dir);
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

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildNext(EXAMPLE);
}, T);

describe("AT-23: Cypress adapter on examples/next-cypress", () => {
  it("AT-07 equivalent: recorded touched sets pass verify (lockfile current)", async () => {
    const r = await runCli(["verify", "--json"], { cwd: EXAMPLE });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as ProjectVerifyResult & { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(parsed.lockfile.written).toBe(false);
    const home = parsed.results.find((x) => x.title.includes("home page"));
    expect(home?.observed).toContain("src/app/page.tsx#HomePage");
    expect(home?.observed).toContain(COUNTER);
  }, T);

  it("a touched symbol missing from the lockfile fails verify as drift (added)", async () => {
    const dir = await makeCopy((d) => {
      const lockPath = path.join(d, "vibehard.lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        tests: Record<string, { touched: Record<string, string>; symbolHashes: Record<string, string> }>;
      };
      const entry = lock.tests[HOME];
      if (entry === undefined) throw new Error("home entry missing");
      delete entry.touched[COUNTER];
      delete entry.symbolHashes[COUNTER];
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}
`);
    });
    const result = await verifyProject({ rootDir: dir, filter: ["home page"] });
    const r = only(result);
    expect(result.exitCode).toBe(2);
    expect(r.status).toBe("drift");
    expect(r.added).toContain(COUNTER);
  }, T);

  it("a lockfile symbol no longer touched fails verify as drift (removed)", async () => {
    const dir = await makeCopy((d) => {
      const lockPath = path.join(d, "vibehard.lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        tests: Record<string, { touched: Record<string, string>; symbolHashes: Record<string, string> }>;
      };
      const entry = lock.tests[HOME];
      if (entry === undefined) throw new Error("home entry missing");
      entry.touched[DISCOUNT] = "direct";
      entry.symbolHashes[DISCOUNT] = "0".repeat(64);
      writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}
`);
    });
    const result = await verifyProject({ rootDir: dir, filter: ["home page"] });
    const r = only(result);
    expect(result.exitCode).toBe(2);
    expect(r.status).toBe("drift");
    expect(r.removed).toContain(DISCOUNT);
  }, T);

  it("AT-10 equivalent: exercising a new app symbol fails verify as drift", async () => {
    const dir = await makeCopy((d) =>
      edit(d, "src/app/page.tsx", (text) =>
        text
          .replace(
            'import { formatPrice } from "../lib/pricing";',
            'import { applyDiscount, formatPrice } from "../lib/pricing";',
          )
          .replace("{formatPrice(total)}", "{formatPrice(applyDiscount(total, 0))}"),
      ),
    );
    const result = await verifyProject({ rootDir: dir, filter: ["home page"] });
    const r = only(result);
    expect(result.exitCode).toBe(2);
    expect(r.status).toBe("drift");
    expect(r.added).toContain(DISCOUNT);
  }, T);

  it("record writes the lockfile without touching specs; twice is a no-op", async () => {
    const dir = await makeCopy((d) => {
      rmSync(path.join(d, "vibehard.lock.json"), { force: true });
    });
    const specBefore = readFileSync(path.join(dir, "cypress/e2e/app.cy.js"), "utf8");
    const first = await recordProject({ rootDir: dir, filter: ["home page"] });
    expect(only(first).status).toBe("recorded");
    expect(only(first).touched?.["src/app/page.tsx#HomePage"]).toBeDefined();
    expect(readFileSync(path.join(dir, "cypress/e2e/app.cy.js"), "utf8")).toBe(specBefore);
    const lockAfterFirst = readFileSync(path.join(dir, "vibehard.lock.json"), "utf8");
    const second = await recordProject({ rootDir: dir, filter: ["home page"] });
    expect(only(second).status).toBe("recorded");
    expect(readFileSync(path.join(dir, "vibehard.lock.json"), "utf8")).toBe(lockAfterFirst);
  }, T);

  it("selection: a Counter change selects and runs exactly the home test", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/app/counter/Counter.tsx", (text) =>
      text.replace("Add item ({formatPrice(count * 100)})", "Add one ({formatPrice(count * 100)})"),
    );
    await buildNext(dir);
    const dry = await testProject({ rootDir: dir, dryRun: true });
    expect(dry.exitCode, JSON.stringify(dry.selection?.unsafeReasons)).toBe(0);
    expect(dry.selection?.selected.map((t) => t.testId)).toEqual([HOME]);
    const run = await testProject({ rootDir: dir });
    expect(run.exitCode, (run.output?.stdout ?? "").slice(-1500)).toBe(0);
    expect(run.ran?.mode).toBe("selected");
    expect(run.ran?.testIds).toEqual([HOME]);
  }, T);
});
