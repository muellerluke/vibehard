import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  explainProject,
  hashSymbolSources,
  indexProject,
  readLockfile,
  selectTests,
  spawnCapture,
  writeLockfile,
  type SelectionResult,
  type SymbolId,
  type TouchKind,
  type VibehardLockfile,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const T = 240_000;

const CHECKOUT_ID = "e2e/checkout.spec.ts::checkout page shows the cart total";
const ADD_ITEM = "src/lib/cart.ts#Cart.addItem";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await spawnCapture("git", args, { cwd, timeoutMs: 60_000 });
  expect(r.exitCode, `git ${args.join(" ")}: ${r.stderr}`).toBe(0);
  return r.stdout;
}

function edit(dir: string, rel: string, fn: (text: string) => string): void {
  const file = path.join(dir, rel);
  writeFileSync(file, fn(readFileSync(file, "utf8")));
}

function write(dir: string, rel: string, data: string | Buffer): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}

/** Copy tiny-app and commit it as the base revision of its own git repo. */
async function makeGitCopy(options: {
  mutateBeforeCommit?: (dir: string) => Promise<void> | void;
} = {}): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-fast-"));
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
  writeFileSync(path.join(dir, "public/robots.txt"), "User-agent: *\n");
  writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
  await options.mutateBeforeCommit?.(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Fast Select Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  return dir;
}

/**
 * Recompute every lockfile symbol hash from the current source using
 * the real indexer/hasher (simulates a record of the mutated tree),
 * optionally adding touched symbols first.
 */
async function refreshLockfile(
  dir: string,
  addTouched: Record<string, Record<SymbolId, TouchKind>> = {},
): Promise<void> {
  const lockPath = path.join(dir, "vibehard.lock.json");
  const lock = readLockfile(lockPath) as VibehardLockfile;
  for (const [testId, touched] of Object.entries(addTouched)) {
    const entry = lock.tests[testId];
    if (entry === undefined) throw new Error(`no lockfile entry for ${testId}`);
    Object.assign(entry.touched, touched);
  }
  const index = await indexProject(dir);
  const hashes = hashSymbolSources(dir, index.symbols);
  for (const entry of Object.values(lock.tests)) {
    for (const id of Object.keys(entry.touched)) {
      const hash = hashes[id];
      if (hash !== undefined) entry.symbolHashes[id] = hash;
    }
  }
  writeLockfile(lockPath, lock);
}

/** The AT-S02 comparable projection of a SelectionResult. */
function comparable(result: SelectionResult) {
  return {
    baseSha: result.base.sha,
    changedFiles: result.changedFiles,
    changedSymbols: result.changedSymbols,
    discovered: result.discovered.map((t) => t.testId),
    selected: result.selected,
    unsafeReasons: result.unsafeReasons,
    unsafeReason: result.unsafeReason,
  };
}

async function expectParity(dir: string): Promise<SelectionResult> {
  const full = await selectTests({ rootDir: dir, fastSelect: false, timing: true });
  const fast = await selectTests({ rootDir: dir, fastSelect: true, timing: true });
  expect(comparable(fast), "fast selection diverges from full selection").toEqual(
    comparable(full),
  );
  expect(
    fast.diagnostics.some((d) => d.startsWith("fast selection unavailable")),
    `fast path fell back unexpectedly: ${fast.diagnostics.join("; ")}`,
  ).toBe(false);
  return fast;
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
}, T);

describe("AT-S02: fast/full selection parity over mutations", () => {
  it("no change", async () => {
    const dir = await makeGitCopy();
    const fast = await expectParity(dir);
    expect(fast.selected).toEqual([]);
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  it("leaf symbol edit", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) =>
      t.replace("(cents / CENTS_PER_DOLLAR)", "(cents / CENTS_PER_DOLLAR + 0)"),
    );
    const fast = await expectParity(dir);
    expect(fast.selected.map((t) => t.testId)).toEqual([CHECKOUT_ID]);
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  it("top-level constant edit", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) => t.replace("CENTS_PER_DOLLAR = 100", "CENTS_PER_DOLLAR = 50"));
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/format.ts#CENTS_PER_DOLLAR");
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  it("whitespace-only edit inside a symbol", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) => t.replace("return `$", "return  `$"));
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/format.ts#formatPrice");
  }, T);

  it("spec file edit", async () => {
    const dir = await makeGitCopy();
    appendFileSync(path.join(dir, "e2e/checkout.spec.ts"), "\n// touch\n");
    const fast = await expectParity(dir);
    expect(fast.selected).toHaveLength(2);
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  it("AT-S09 support helper edit (mapped and unprovable)", async () => {
    const EXTRA_ID = "e2e/extra.spec.ts::extra coupon flow";
    const COUPON_ID = "e2e/checkout.spec.ts::coupon api accepts a code";
    // Same shape as the AT-S09 gate in selector.test.ts: a second
    // spec with its own helper and a cloned recorded entry.
    const dir = await makeGitCopy({
      mutateBeforeCommit: (d) => {
        write(d, "e2e/helper-only.ts", "export const helperOnly = 1;\n");
        write(
          d,
          "e2e/extra.spec.ts",
          [
            "import { expect, test } from 'vibehard/playwright';",
            "import { helperOnly } from './helper-only';",
            "",
            "test('extra coupon flow', async ({ request }) => {",
            "  expect(helperOnly).toBe(1);",
            "  const response = await request.post('/api/coupons', { data: { code: 'SAVE10' } });",
            "  expect(response.status()).toBe(200);",
            "});",
            "",
          ].join("\n"),
        );
        const lockPath = path.join(d, "vibehard.lock.json");
        const lock = readLockfile(lockPath) as VibehardLockfile;
        const coupon = lock.tests[COUPON_ID] as VibehardLockfile["tests"][string];
        lock.tests[EXTRA_ID] = {
          file: "e2e/extra.spec.ts",
          titlePath: ["extra coupon flow"],
          touched: { ...coupon.touched },
          symbolHashes: { ...coupon.symbolHashes },
        };
        writeLockfile(lockPath, lock);
      },
    });

    edit(dir, "e2e/helper-only.ts", (t) => t.replace("= 1", "= 2"));
    const mappedFast = await expectParity(dir);
    expect(mappedFast.unsafeReasons).toEqual([]);
    expect(mappedFast.selected.map((t) => t.testId)).toEqual([EXTRA_ID]);
    expect(mappedFast.selected[0]?.reasons).toContainEqual({
      type: "test-support-changed",
      file: "e2e/helper-only.ts",
    });

    await git(dir, ["checkout", "--", "e2e/helper-only.ts"]);
    edit(dir, "e2e/helper-only.ts", (t) =>
      t.replace("= 1", "= 2") + "export const load = (name: string) => import(name);\n");
    const unprovableFast = await expectParity(dir);
    expect(unprovableFast.unsafeReasons.join(" ")).toContain(
      "e2e/helper-only.ts (test support file)",
    );
  }, T);

  it("config edit is unsafe", async () => {
    const dir = await makeGitCopy();
    edit(dir, "package.json", (t) => t.replace('"private": true', '"private": false'));
    const fast = await expectParity(dir);
    expect(fast.unsafeReasons.join(" ")).toContain("package.json (config file)");
  }, T);

  it("unmapped file edit is unsafe", async () => {
    const dir = await makeGitCopy();
    write(dir, "public/robots.txt", "User-agent: *\nDisallow: /\n");
    const fast = await expectParity(dir);
    expect(fast.unsafeReasons.join(" ")).toContain("public/robots.txt");
  }, T);

  it("app file outside the tsconfig include is unsafe (membership gate)", async () => {
    const dir = await makeGitCopy();
    edit(dir, "harness/server.ts", (t) => `${t}// touch\n`);
    const fast = await expectParity(dir);
    expect(fast.unsafeReasons.join(" ")).toContain("harness/server.ts");
  }, T);

  it("new unreferenced app file", async () => {
    const dir = await makeGitCopy();
    write(dir, "src/lib/fresh.ts", "export const fresh = 1;\n");
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/fresh.ts#fresh");
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  it("new app file plus importer edit", async () => {
    const dir = await makeGitCopy();
    write(dir, "src/lib/fresh.ts", "export const fresh = 1;\n");
    edit(dir, "src/lib/cart.ts", (t) =>
      `import { fresh } from "./fresh.js";\nvoid fresh;\n${t}`,
    );
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/fresh.ts#fresh");
  }, T);

  it("deleted app file", async () => {
    const dir = await makeGitCopy();
    rmSync(path.join(dir, "src/lib/format.ts"));
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/format.ts#formatPrice");
  }, T);

  it("renamed app file (delete + add)", async () => {
    const dir = await makeGitCopy();
    renameSync(path.join(dir, "src/lib/format.ts"), path.join(dir, "src/lib/money.ts"));
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/money.ts#formatPrice");
  }, T);

  it("missing lockfile is unsafe", async () => {
    const dir = await makeGitCopy();
    rmSync(path.join(dir, "vibehard.lock.json"));
    const fast = await expectParity(dir);
    expect(fast.unsafeReasons.join(" ")).toContain("missing lockfile");
  }, T);

  it("imported asset edit (asset of a touched importer)", async () => {
    const dir = await makeGitCopy({
      mutateBeforeCommit: async (d) => {
        write(d, "src/lib/rates.json", `${JSON.stringify({ rate: 1 })}\n`);
        edit(d, "src/lib/format.ts", (t) =>
          `import rates from "./rates.json" with { type: "json" };\nvoid rates;\n${t}`,
        );
        await refreshLockfile(d, {
          [CHECKOUT_ID]: { "src/lib/rates.json#<file>": "direct" },
        });
      },
    });
    write(dir, "src/lib/rates.json", `${JSON.stringify({ rate: 2 })}\n`);
    const fast = await expectParity(dir);
    expect(fast.changedSymbols).toContain("src/lib/rates.json#<file>");
    expect(fast.selected.map((t) => t.testId)).toEqual([CHECKOUT_ID]);
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  it("CRLF-smudged touched file (git --filters base reads)", async () => {
    const LF = "export const CENTS_PER_DOLLAR = 100;\n\nexport const formatPrice = (cents: number): string => {\n  return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;\n};\n";
    const dir = await makeGitCopy({
      mutateBeforeCommit: async (d) => {
        write(d, ".gitattributes", "src/lib/format.ts text eol=crlf\n");
        write(d, "src/lib/format.ts", LF.replaceAll("\n", "\r\n"));
        await refreshLockfile(d);
      },
    });
    // Working tree must hold the CRLF form, as a checkout would leave it.
    expect(readFileSync(path.join(dir, "src/lib/format.ts"), "utf8")).toContain("\r\n");
    edit(dir, "src/lib/format.ts", (t) => t.replace("CENTS_PER_DOLLAR = 100", "CENTS_PER_DOLLAR = 50"));
    const fast = await expectParity(dir);
    expect(fast.unsafeReasons).toEqual([]);
    expect(fast.selected.map((t) => t.testId)).toEqual([CHECKOUT_ID]);
  }, T);

  it("touched symbol in a git-ignored, never-tracked file", async () => {
    const dir = await makeGitCopy({
      mutateBeforeCommit: async (d) => {
        write(d, "src/lib/gen.ts", "export const GEN = 1;\n");
        appendFileSync(path.join(d, ".gitignore"), "src/lib/gen.ts\n");
        await refreshLockfile(d, {
          [CHECKOUT_ID]: { "src/lib/gen.ts#GEN": "direct" },
        });
      },
    });
    expect(existsSync(path.join(dir, "src/lib/gen.ts"))).toBe(true);
    edit(dir, "src/lib/format.ts", (t) =>
      t.replace("(cents / CENTS_PER_DOLLAR)", "(cents / CENTS_PER_DOLLAR + 0)"),
    );
    const fast = await expectParity(dir);
    // Unprovable at the base in both paths: stale-lockfile unsafe.
    expect(fast.unsafeReasons.length).toBeGreaterThan(0);
  }, T);
});

describe("AT-S03: fast path does no whole-repo work", () => {
  it("emits no index/worktree phases and creates no worktree", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) =>
      t.replace("(cents / CENTS_PER_DOLLAR)", "(cents / CENTS_PER_DOLLAR + 0)"),
    );
    const before = await git(dir, ["worktree", "list", "--porcelain"]);
    const fast = await selectTests({ rootDir: dir, fastSelect: true, timing: true });
    const after = await git(dir, ["worktree", "list", "--porcelain"]);
    expect(after).toBe(before);
    const phases = (fast.timing ?? []).map((p) => p.name);
    for (const banned of ["index.head", "index.base", "git.baseWorktree.create", "git.baseWorktree.cleanup"]) {
      expect(phases, `unexpected full-index phase ${banned}`).not.toContain(banned);
    }
    expect(phases).toContain("fast.parse.head");
    expect(phases).toContain("fast.baseTexts");
    expect(fast.unsafeReasons).toEqual([]);
  }, T);

  // Four selections in one test: allow two timeout windows.
  it("warm cache, corrupted cache, and disabled cache agree", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) =>
      t.replace("(cents / CENTS_PER_DOLLAR)", "(cents / CENTS_PER_DOLLAR + 0)"),
    );
    const cold = await selectTests({ rootDir: dir, fastSelect: true, timing: true });
    const warm = await selectTests({ rootDir: dir, fastSelect: true, timing: true });
    expect(comparable(warm)).toEqual(comparable(cold));
    const headPhase = warm.timing?.find((p) => p.name === "fast.parse.head");
    expect(headPhase?.details?.cacheHits ?? 0).toBeGreaterThan(0);

    const cacheDir = path.join(dir, ".git", "vibehard-cache", "v1");
    const entries = readdirSync(cacheDir).filter((n) => n.endsWith(".json"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) writeFileSync(path.join(cacheDir, entry), "corrupt{");
    const afterCorruption = await selectTests({ rootDir: dir, fastSelect: true, timing: true });
    expect(comparable(afterCorruption)).toEqual(comparable(cold));

    process.env.VIBEHARD_NO_CACHE = "1";
    try {
      const noCache = await selectTests({ rootDir: dir, fastSelect: true, timing: true });
      expect(comparable(noCache)).toEqual(comparable(cold));
    } finally {
      delete process.env.VIBEHARD_NO_CACHE;
    }
  }, 480_000);

  it("falls back to full indexing when the fast path cannot run", async () => {
    const weird = "src/lib/we\nird.ts";
    const dir = await makeGitCopy({
      mutateBeforeCommit: (d) => {
        write(d, weird, "export const weird = 1;\n");
      },
    });
    write(dir, weird, "export const weird = 2;\n");
    const full = await selectTests({ rootDir: dir, fastSelect: false });
    const fast = await selectTests({ rootDir: dir, fastSelect: true });
    expect(comparable(fast)).toEqual(comparable(full));
    expect(
      fast.diagnostics.some((d) => d.startsWith("fast selection unavailable")),
      `expected a fallback diagnostic, got: ${fast.diagnostics.join("; ")}`,
    ).toBe(true);
  }, T);
});

describe("fast explain parity", () => {
  it("symbol and test queries match the full index", async () => {
    const dir = await makeGitCopy();
    for (const query of [ADD_ITEM, "checkout page"]) {
      const full = await explainProject({ rootDir: dir, query, fastSelect: false });
      const fast = await explainProject({ rootDir: dir, query, fastSelect: true });
      expect(fast, `explain diverges for ${query}`).toEqual(full);
    }
  }, T);

  it("unknown queries fail identically", async () => {
    const dir = await makeGitCopy();
    for (const query of ["src/lib/cart.ts#Nope", "zzzz-no-match"]) {
      const fullError = await explainProject({ rootDir: dir, query, fastSelect: false }).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      const fastError = await explainProject({ rootDir: dir, query, fastSelect: true }).then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      expect(fullError).not.toBeNull();
      expect(fastError).toBe(fullError);
    }
  }, T);
});

describe("CLI --fast-select", () => {
  it("test --dry-run matches without the flag; record rejects it", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) =>
      t.replace("(cents / CENTS_PER_DOLLAR)", "(cents / CENTS_PER_DOLLAR + 0)"),
    );
    const plain = await runCli(["test", "--dry-run", "--json"], { cwd: dir });
    const fast = await runCli(["test", "--dry-run", "--json", "--fast-select"], { cwd: dir });
    expect(fast.exitCode).toBe(plain.exitCode);
    const plainSelection = (
      JSON.parse(plain.stdout) as { selection: SelectionResult | null }
    ).selection;
    const fastSelection = (
      JSON.parse(fast.stdout) as { selection: SelectionResult | null }
    ).selection;
    expect(plainSelection).not.toBeNull();
    expect(fastSelection).not.toBeNull();
    expect(comparable(fastSelection as SelectionResult)).toEqual(
      comparable(plainSelection as SelectionResult),
    );

    const rejected = await runCli(["record", "--fast-select"], { cwd: dir });
    expect(rejected.exitCode).toBe(3);
    expect(rejected.stderr).toContain("--fast-select");
  }, T);
});
