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
const EXAMPLE = path.join(REPO_ROOT, "examples/two-frontends");
const T = 420_000;

const STORE = "e2e/app.spec.ts::store page shows the catalog total";
const ADMIN = "e2e/app.spec.ts::admin page shows the revenue summary";
const JOURNEY = "e2e/app.spec.ts::shopper journey crosses both frontends";

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

function copyExample(): string {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, { recursive: true, filter: copyFilter });
  const tsconfigPath = path.join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as { extends?: string };
  tsconfig.extends = path.join(REPO_ROOT, "tsconfig.base.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  return dir;
}

async function makeCopy(mutate?: (dir: string) => void): Promise<string> {
  const dir = copyExample();
  mutate?.(dir);
  await buildExample(dir);
  return dir;
}

async function makeGitCopy(): Promise<string> {
  const dir = copyExample();
  writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
  await buildExample(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Two Frontends Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  return dir;
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildExample(EXAMPLE);
}, T);

describe("two frontends in one project (examples/two-frontends)", () => {
  it("recorded touched sets pass verify (lockfile current)", async () => {
    const r = await runCli(["verify", "--json"], { cwd: EXAMPLE });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as ProjectVerifyResult & { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((x) => x.status)).toEqual(["pass", "pass", "pass"]);
    expect(parsed.lockfile.written).toBe(false);
  }, T);

  it("record: one test crossing both frontends touches both; single-frontend tests stay separate", async () => {
    const dir = await makeCopy((d) => {
      rmSync(path.join(d, "vibehard.lock.json"), { force: true });
    });
    const recorded = await recordProject({ rootDir: dir });
    expect(recorded.results.map((x) => x.status)).toEqual([
      "recorded",
      "recorded",
      "recorded",
    ]);
    const byId = new Map(recorded.results.map((x) => [x.testId, x]));
    const journey = byId.get(JOURNEY)?.touched ?? {};
    // Browser and server code from both frontends in one touched set.
    expect(journey["src/store/client.ts#bootStore"]).toBe("direct");
    expect(journey["src/store/server.ts#routeStoreRequest"]).toBe("direct");
    expect(journey["src/admin/client.ts#bootAdmin"]).toBe("direct");
    expect(journey["src/admin/server.ts#routeAdminRequest"]).toBe("direct");

    const store = byId.get(STORE)?.touched ?? {};
    expect(store["src/store/catalog.ts#storeTotalCents"]).toBe("direct");
    expect(store["src/admin/stats.ts#adminSummary"]).toBeUndefined();
    expect(store["src/admin/client.ts#bootAdmin"]).toBeUndefined();

    const admin = byId.get(ADMIN)?.touched ?? {};
    expect(admin["src/admin/stats.ts#adminSummary"]).toBe("direct");
    expect(admin["src/store/catalog.ts#storeTotalCents"]).toBeUndefined();
    expect(admin["src/store/client.ts#bootStore"]).toBeUndefined();

    // Recording again is a no-op.
    const lockAfterFirst = readFileSync(path.join(dir, "vibehard.lock.json"), "utf8");
    await recordProject({ rootDir: dir });
    expect(readFileSync(path.join(dir, "vibehard.lock.json"), "utf8")).toBe(lockAfterFirst);
    const verify = await verifyProject({ rootDir: dir });
    expect(verify.results.map((x) => x.status)).toEqual(["pass", "pass", "pass"]);
  }, T);

  const selectionCases: Array<{
    name: string;
    file: string;
    mutate: (text: string) => string;
    selected: string[];
  }> = [
    {
      name: "a store-only change selects the store and journey tests",
      file: "src/store/catalog.ts",
      mutate: (text) =>
        text.replace(
          "sum + product.priceCents",
          "sum + product.priceCents + 0",
        ),
      selected: [JOURNEY, STORE],
    },
    {
      name: "an admin-only change selects the admin and journey tests",
      file: "src/admin/stats.ts",
      mutate: (text) => text.replace("42_500", "42_500 + 0"),
      selected: [ADMIN, JOURNEY],
    },
    {
      name: "a shared change selects every test",
      file: "src/shared/pricing.ts",
      mutate: (text) => text.replace("cents / 100", "cents / 100 + 0"),
      selected: [ADMIN, JOURNEY, STORE],
    },
  ];

  for (const testCase of selectionCases) {
    it(`selection: ${testCase.name}`, async () => {
      const dir = await makeGitCopy();
      edit(dir, testCase.file, testCase.mutate);
      await buildExample(dir);
      const dry = await testProject({ rootDir: dir, dryRun: true });
      expect(dry.exitCode, JSON.stringify(dry.selection?.unsafeReasons)).toBe(0);
      expect(dry.selection?.selected.map((t) => t.testId).sort()).toEqual(
        [...testCase.selected].sort(),
      );
    }, T);
  }

  it("selection: a store change runs exactly the selected tests through Playwright", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/store/catalog.ts", (text) =>
      text.replace("sum + product.priceCents", "sum + product.priceCents + 0"),
    );
    await buildExample(dir);
    const run = await testProject({ rootDir: dir });
    expect(run.exitCode, run.output?.stdout ?? "").toBe(0);
    expect(run.ran?.mode).toBe("selected");
    expect([...(run.ran?.testIds ?? [])].sort()).toEqual([JOURNEY, STORE].sort());
    expect(run.ran?.frameworkExitCode).toBe(0);
  }, T);
});
