import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifyChangedFile,
  computeChangedSymbolsForFile,
  explainProject,
  lockfileTrustReasons,
  parseUnifiedDiff,
  readLockfile,
  selectTests,
  spawnCapture,
  testProject,
  verifyProject,
  type SelectionResult,
  type SymbolRecord,
  type TestProjectResult,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const T = 240_000;

const POST = "src/app/api/coupons/route.ts#POST";
const PAGE = "src/app/checkout/page.tsx#CheckoutPage";
const ADD_ITEM = "src/lib/cart.ts#Cart.addItem";
const FORMAT = "src/lib/format.ts#formatPrice";
const CHECKOUT_ID = "e2e/checkout.spec.ts::checkout page shows the cart total";
const COUPON_ID = "e2e/checkout.spec.ts::coupon api accepts a code";

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

function edit(dir: string, rel: string, fn: (text: string) => string): void {
  const file = path.join(dir, rel);
  writeFileSync(file, fn(readFileSync(file, "utf8")));
}

/** Copy tiny-app and commit it as the base revision of its own git repo. */
async function makeGitCopy(options: {
  mutateBeforeCommit?: (dir: string) => void;
  harness?: boolean;
} = {}): Promise<string> {
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
  writeFileSync(path.join(dir, "public/robots.txt"), "User-agent: *\n");
  writeFileSync(path.join(dir, ".gitignore"), ".build/\ntest-results/\nnode_modules/\n");
  options.mutateBeforeCommit?.(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Selector Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  if (options.harness === true) await buildHarness(dir);
  return dir;
}

async function dryRun(dir: string): Promise<{ exitCode: number; result: TestProjectResult }> {
  const r = await runCli(["test", "--dry-run", "--json"], { cwd: dir });
  const result = JSON.parse(r.stdout || "{}") as TestProjectResult;
  return { exitCode: r.exitCode, result };
}

function selectedIds(selection: SelectionResult | null): string[] {
  return (selection?.selected ?? []).map((t) => t.testId);
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
}, T);

// --- unit: diff parsing, classification, changed symbols, trust ----------

function record(file: string, name: string, startLine: number, endLine: number): SymbolRecord {
  return {
    id: `${file}#${name}`,
    file,
    qualifiedName: name,
    kind: "function",
    startOffset: 0,
    endOffset: 0,
    startLine,
    endLine,
  };
}

describe("selector units", () => {
  it("parseUnifiedDiff handles modify, add, delete, and binary entries", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2 +2,2 @@ export const x",
      "-old",
      "+new",
      "+more",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,3 @@",
      "diff --git a/src/c.ts b/src/c.ts",
      "deleted file mode 100644",
      "--- a/src/c.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const files = parseUnifiedDiff(patch, "");
    expect(files).toHaveLength(4);
    expect(files[0]).toMatchObject({ oldFile: "src/a.ts", newFile: "src/a.ts", binary: false });
    expect(files[0]?.hunks).toEqual([{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }]);
    expect(files[1]).toMatchObject({ oldFile: null, newFile: "src/b.ts" });
    expect(files[2]).toMatchObject({ oldFile: "src/c.ts", newFile: null });
    expect(files[3]?.binary).toBe(true);
    // Git-root prefix is stripped for subdirectory projects.
    const sub = parseUnifiedDiff("--- a/app/src/a.ts\n+++ b/app/src/a.ts\n@@ -1 +1 @@\n", "app");
    expect(sub[0]?.newFile).toBeUndefined();
    const withDiff = parseUnifiedDiff(
      "diff --git a/app/src/a.ts b/app/src/a.ts\n--- a/app/src/a.ts\n+++ b/app/src/a.ts\n@@ -1 +1 @@\n",
      "app",
    );
    expect(withDiff[0]?.newFile).toBe("src/a.ts");
  });

  it("classifyChangedFile applies the safety order", () => {
    const ctx = {
      ignore: ["docs/**"],
      include: [] as string[],
      testDirPosix: "e2e",
      specFiles: new Set(["e2e/a.spec.ts"]),
      lockfileRel: "vibehard.lock.json",
    };
    expect(classifyChangedFile("docs/guide.md", ctx)).toBe("ignored");
    expect(classifyChangedFile("node_modules/x/index.js", ctx)).toBe("ignored");
    expect(classifyChangedFile("vibehard.lock.json", ctx)).toBe("lockfile");
    expect(classifyChangedFile("package.json", ctx)).toBe("config");
    expect(classifyChangedFile("playwright.config.ts", ctx)).toBe("config");
    expect(classifyChangedFile("e2e/a.spec.ts", ctx)).toBe("spec");
    expect(classifyChangedFile("e2e/uses.ts", ctx)).toBe("test-support");
    expect(classifyChangedFile("src/lib/a.ts", ctx)).toBe("app");
    expect(classifyChangedFile("src/lib/a.d.ts", ctx)).toBe("unmapped");
    expect(classifyChangedFile("public/logo.png", ctx)).toBe("unmapped");
    expect(classifyChangedFile("src/lib/a.ts", { ...ctx, include: ["lib/**"] })).toBe("unmapped");
  });

  it("computeChangedSymbolsForFile maps hunks, hashes, adds, and deletes", () => {
    const file = "src/a.ts";
    const baseText = "import x;\nfunction f() {\n  return 1;\n}\nfunction g() {\n  return 2;\n}\n";
    const syms = [record(file, "f", 2, 4), record(file, "g", 5, 7)];
    const hashes = { [`${file}#f`]: "h1", [`${file}#g`]: "h2" };
    const base = {
      baseSymbols: syms,
      headSymbols: syms,
      baseHashes: hashes,
      headHashes: hashes,
      binary: false,
      baseText,
      headText: baseText,
    } as const;
    // Touching a line inside f selects f only.
    expect(
      computeChangedSymbolsForFile({
        ...base,
        status: "M",
        hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }],
      }),
    ).toEqual({ changedSymbols: [`${file}#f`], unmappedLines: false });
    // A changed import line is outside every symbol.
    expect(
      computeChangedSymbolsForFile({
        ...base,
        status: "M",
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
      }).unmappedLines,
    ).toBe(true);
    // A blank-line insertion between symbols selects nothing.
    expect(
      computeChangedSymbolsForFile({
        ...base,
        status: "M",
        hunks: [{ oldStart: 4, oldCount: 0, newStart: 5, newCount: 1 }],
        headText: baseText.replace("}\nfunction g", "}\n\nfunction g"),
        headSymbols: [record(file, "f", 2, 4), record(file, "g", 6, 8)],
      }),
    ).toEqual({ changedSymbols: [], unmappedLines: false });
    // Hash change alone (whitespace inside g) selects g.
    expect(
      computeChangedSymbolsForFile({
        ...base,
        status: "M",
        hunks: [],
        headHashes: { ...hashes, [`${file}#g`]: "h2b" },
      }).changedSymbols,
    ).toEqual([`${file}#g`]);
    // Deleting the file changes every base symbol; adding reports head symbols.
    expect(computeChangedSymbolsForFile({ ...base, status: "D", hunks: [] }).changedSymbols)
      .toEqual([`${file}#f`, `${file}#g`]);
    expect(computeChangedSymbolsForFile({ ...base, status: "A", hunks: [] }).changedSymbols)
      .toEqual([`${file}#f`, `${file}#g`]);
    expect(computeChangedSymbolsForFile({ ...base, status: "M", hunks: [], binary: true }))
      .toEqual({ changedSymbols: [], unmappedLines: true });
  });

  it("lockfile trust accepts base- or head-matching hashes, rejects mixed", () => {
    const entry = {
      file: "e2e/a.spec.ts",
      titlePath: ["t"],
      declared: ["src/a.ts#f", "src/a.ts#g"],
      symbolHashes: { "src/a.ts#f": "hf", "src/a.ts#g": "hg" },
      allowTransitive: [],
      allowedObserved: [],
    };
    const lock = {
      version: 1 as const,
      framework: { name: "playwright", version: "1.59.0" },
      configHash: "cfg",
      tests: { "e2e/a.spec.ts::t": entry },
    };
    const resolved = { configHash: "cfg" } as Parameters<typeof lockfileTrustReasons>[0]["resolved"];
    const rootDir = TINY_APP;
    const discoveredIds = new Set(["e2e/a.spec.ts::t"]);
    const hashes = { "src/a.ts#f": "hf", "src/a.ts#g": "hg" };
    const trust = (baseHashes: Record<string, string>, headHashes: Record<string, string>) =>
      lockfileTrustReasons({ lock, lockError: null, resolved, rootDir, discoveredIds, baseHashes, headHashes });
    expect(trust(hashes, { "src/a.ts#f": "hf2", "src/a.ts#g": "hg" })).toEqual([]);
    expect(trust({ "src/a.ts#f": "x", "src/a.ts#g": "hg" }, hashes)).toEqual([]);
    expect(trust({ "src/a.ts#f": "hf", "src/a.ts#g": "x" }, { "src/a.ts#f": "y", "src/a.ts#g": "hg" })
      .join(" ")).toContain("stale lockfile");
    expect(
      lockfileTrustReasons({ lock: null, lockError: null, resolved, rootDir, discoveredIds, baseHashes: {}, headHashes: {} })
        .join(" "),
    ).toContain("missing lockfile");
  });
});

// --- integration: selection against a real git repo -----------------------

describe("Stage 4 selection on fixtures/tiny-app", () => {
  it("AT-13: changing one symbol's body selects exactly its declaring tests", async () => {
    const cases: { name: string; mutate: (dir: string) => void; symbol: string; expected: string[] }[] = [
      {
        name: "Cart.addItem",
        symbol: ADD_ITEM,
        expected: [CHECKOUT_ID],
        mutate: (dir) => edit(dir, "src/lib/cart.ts", (t) =>
          t.replace("existing.quantity += item.quantity;", "existing.quantity += item.quantity + 0;")),
      },
      {
        name: "formatPrice",
        symbol: FORMAT,
        expected: [CHECKOUT_ID],
        mutate: (dir) => edit(dir, "src/lib/format.ts", (t) =>
          t.replace("(cents / 100)", "(cents / 100 + 0)")),
      },
      {
        name: "CheckoutPage",
        symbol: PAGE,
        expected: [CHECKOUT_ID],
        mutate: (dir) => edit(dir, "src/app/checkout/page.tsx", (t) =>
          t.replace("<h1>Checkout</h1>", "<h1>Checkout now</h1>")),
      },
      {
        name: "POST",
        symbol: POST,
        expected: [COUPON_ID],
        mutate: (dir) => edit(dir, "src/app/api/coupons/route.ts", (t) =>
          t.replace("{ ok: true, code: body.code }", "{ ok: true, code: body.code, via: \"api\" }")),
      },
    ];
    for (const c of cases) {
      const dir = await makeGitCopy();
      c.mutate(dir);
      const { exitCode, result } = await dryRun(dir);
      expect(exitCode, c.name).toBe(0);
      expect(result.selection?.changedSymbols, c.name).toEqual([c.symbol]);
      expect(selectedIds(result.selection), c.name).toEqual(c.expected);
      const reasons = result.selection?.selected[0]?.reasons ?? [];
      expect(reasons, c.name).toContainEqual({ type: "changed-symbol", symbol: c.symbol });
      rmSync(dir, { recursive: true, force: true });
    }
  }, T);

  it("AT-14: a whitespace-only change inside a symbol still selects its tests", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) => t.replace("return `$", "return  `$"));
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(0);
    expect(result.selection?.changedSymbols).toEqual([FORMAT]);
    expect(selectedIds(result.selection)).toEqual([CHECKOUT_ID]);
  }, T);

  it("AT-15: a non-code change is unsafe under --dry-run (exit 3)", async () => {
    const dir = await makeGitCopy();
    writeFileSync(path.join(dir, "public/robots.txt"), "User-agent: *\nDisallow: /\n");
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(3);
    expect(result.selection?.unsafeReason).toContain("unsafe: unmapped change");
    expect(result.selection?.unsafeReason).toContain("public/robots.txt");
  }, T);

  it("AT-15 (untracked): an untracked non-code file is also unsafe", async () => {
    const dir = await makeGitCopy();
    writeFileSync(path.join(dir, "notes.txt"), "remember to water the tests\n");
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(3);
    expect(result.selection?.unsafeReason).toContain("unsafe: unmapped change");
    expect(result.selection?.changedFiles).toContain("notes.txt");
  }, T);

  it("AT-16: no changes selects zero tests and runs nothing", async () => {
    const dir = await makeGitCopy();
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(0);
    expect(selectedIds(result.selection)).toEqual([]);
    expect(result.selection?.changedFiles).toEqual([]);
    const ran = await testProject({ rootDir: dir });
    expect(ran.exitCode).toBe(0);
    expect(ran.ran?.mode).toBe("none");
    expect(ran.output).toBeNull();
  }, T);

  it("AT-18: deleting a declared symbol's file selects its tests", async () => {
    const dir = await makeGitCopy();
    rmSync(path.join(dir, "src/lib/format.ts"));
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(0);
    expect(result.selection?.changedSymbols).toContain(FORMAT);
    expect(selectedIds(result.selection)).toEqual([CHECKOUT_ID]);
  }, T);

  it("changing a spec file selects its tests; a support file is unsafe", async () => {
    const dir = await makeGitCopy();
    edit(dir, "e2e/checkout.spec.ts", (t) => `// touched\n${t}`);
    const touched = await selectTests({ rootDir: dir });
    expect(touched.unsafeReasons).toEqual([]);
    expect(selectedIds(touched).sort()).toEqual([CHECKOUT_ID, COUPON_ID].sort());
    expect(touched.selected[0]?.reasons).toContainEqual({
      type: "test-file-changed",
      file: "e2e/checkout.spec.ts",
    });

    const dir2 = await makeGitCopy();
    edit(dir2, "e2e/uses.ts", (t) => `${t}\n// touched\n`);
    const support = await selectTests({ rootDir: dir2 });
    expect(support.unsafeReason).toContain("unsafe: unmapped change");
    expect(support.unsafeReason).toContain("e2e/uses.ts");
  }, T);

  it("a tampered lockfile hash makes selection unsafe (stale)", async () => {
    const dir = await makeGitCopy();
    const lockPath = path.join(dir, "vibehard.lock.json");
    const lock = readLockfile(lockPath);
    if (lock === null) throw new Error("fixture lockfile missing");
    const entry = Object.values(lock.tests).find((e) => e.declared.includes(POST));
    if (entry === undefined) throw new Error("coupon entry missing");
    entry.symbolHashes[POST] = "0".repeat(64);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    edit(dir, "src/app/api/coupons/route.ts", (t) =>
      t.replace("{ ok: true, code: body.code }", "{ ok: true, code: body.code, via: \"api\" }"));
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(3);
    expect(result.selection?.unsafeReasons.join(" ")).toContain("stale lockfile");
  }, T);

  it("skipVerify tests always run, even with no changes", async () => {
    const dir = await makeGitCopy({
      mutateBeforeCommit: (d) => {
        const lockPath = path.join(d, "vibehard.lock.json");
        const lock = readLockfile(lockPath);
        if (lock === null) throw new Error("fixture lockfile missing");
        const entry = lock.tests[COUPON_ID];
        if (entry === undefined) throw new Error("coupon entry missing");
        entry.skipVerify = "flaky upstream";
        writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      },
    });
    const { exitCode, result } = await dryRun(dir);
    expect(exitCode).toBe(0);
    expect(selectedIds(result.selection)).toEqual([COUPON_ID]);
    expect(result.selection?.selected[0]?.reasons).toContainEqual({
      type: "skip-verify",
      reason: "flaky upstream",
    });
  }, T);

  it("an explicit --base selects across a committed change", async () => {
    const dir = await makeGitCopy();
    const baseR = await spawnCapture("git", ["rev-parse", "HEAD"], { cwd: dir });
    const baseSha = baseR.stdout.trim();
    edit(dir, "src/app/api/coupons/route.ts", (t) =>
      t.replace("{ ok: true, code: body.code }", "{ ok: true, code: body.code, via: \"api\" }"));
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-m", "change POST"]);
    const selection = await selectTests({ rootDir: dir, baseRef: baseSha });
    expect(selection.unsafeReasons).toEqual([]);
    expect(selection.changedSymbols).toEqual([POST]);
    expect(selectedIds(selection)).toEqual([COUPON_ID]);
  }, T);
});

// --- integration: runner delegation and explain ---------------------------

describe("Stage 4 runner and explain", () => {
  it("runs exactly the selected test through Playwright", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/app/api/coupons/route.ts", (t) =>
      t.replace("{ ok: true, code: body.code }", "{ ok: true, code: body.code, via: \"api\" }"));
    await buildHarness(dir);
    const result = await testProject({ rootDir: dir });
    expect(result.exitCode, result.output?.stderr ?? "").toBe(0);
    expect(result.ran?.mode).toBe("selected");
    expect(result.ran?.testIds).toEqual([COUPON_ID]);
  }, T);

  it("an unsafe selection runs the full suite and reports why", async () => {
    const dir = await makeGitCopy();
    writeFileSync(path.join(dir, "public/robots.txt"), "User-agent: *\nDisallow: /\n");
    await buildHarness(dir);
    const result = await testProject({ rootDir: dir });
    expect(result.exitCode, result.output?.stderr ?? "").toBe(0);
    expect(result.selection?.unsafeReason).toContain("unsafe: unmapped change");
    expect(result.ran?.mode).toBe("full");
    expect(result.ran?.testIds.sort()).toEqual([CHECKOUT_ID, COUPON_ID].sort());
  }, T);

  it("--all skips selection and runs everything", async () => {
    const dir = await makeGitCopy();
    await buildHarness(dir);
    const result = await testProject({ rootDir: dir, all: true });
    expect(result.exitCode, result.output?.stderr ?? "").toBe(0);
    expect(result.selection).toBeNull();
    expect(result.ran?.mode).toBe("full");
    expect(result.ran?.testIds.sort()).toEqual([CHECKOUT_ID, COUPON_ID].sort());
  }, T);

  it("explain answers symbol and test queries from the lockfile", async () => {
    const bySymbol = await runCli(["explain", POST, "--json"], { cwd: TINY_APP });
    expect(bySymbol.exitCode, bySymbol.stderr).toBe(0);
    const symbolResult = JSON.parse(bySymbol.stdout) as {
      kind: string;
      symbol: { kind: string } | null;
      tests: { testId: string; via?: string }[];
    };
    expect(symbolResult.kind).toBe("symbol");
    expect(symbolResult.symbol?.kind).toBe("route-export");
    expect(symbolResult.tests.map((t) => t.testId)).toEqual([COUPON_ID]);
    expect(symbolResult.tests[0]?.via).toBe("declared");

    const byTest = await explainProject({ rootDir: TINY_APP, query: "checkout page" });
    expect(byTest.kind).toBe("test");
    expect(byTest.tests.map((t) => t.testId)).toEqual([CHECKOUT_ID]);
    expect(byTest.tests[0]?.declared).toEqual([PAGE, ADD_ITEM, FORMAT].sort());
    expect(byTest.tests[0]?.lastObserved).toEqual([PAGE, ADD_ITEM, FORMAT].sort());
    expect(byTest.tests[0]?.symbols.every((s) => s.status === "fresh")).toBe(true);

    const missing = await runCli(["explain", "src/nope.ts#Nope"], { cwd: TINY_APP });
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toContain("no symbol or test matches");
  }, T);

  it("explain reports an edited symbol as stale", async () => {
    const dir = await makeGitCopy();
    edit(dir, "src/lib/format.ts", (t) => t.replace("(cents / 100)", "(cents / 100 + 0)"));
    const result = await explainProject({ rootDir: dir, query: "checkout page" });
    const statuses = new Map(result.tests[0]?.symbols.map((s) => [s.id, s.status]));
    expect(statuses.get(FORMAT)).toBe("stale");
    expect(statuses.get(PAGE)).toBe("fresh");
  }, T);
});

// --- integration: AT-17 recall audit (tiny-app half) ----------------------
// The examples/next-fullstack half lives in test/next-fullstack.test.ts.

describe("AT-17 recall audit on fixtures/tiny-app", () => {
  const mutations: { symbol: string; mutate: (dir: string) => void }[] = [
    {
      symbol: FORMAT,
      mutate: (dir) => edit(dir, "src/lib/format.ts", (t) =>
        t.replace("return `$", "return `USD ")),
    },
    {
      symbol: ADD_ITEM,
      mutate: (dir) => edit(dir, "src/lib/cart.ts", (t) =>
        t.replace("existing.quantity += item.quantity;", "existing.quantity += 1;")),
    },
    {
      symbol: POST,
      mutate: (dir) => edit(dir, "src/app/api/coupons/route.ts", (t) =>
        t.replace(
          'headers: { "content-type": "application/json" },',
          'status: 500, headers: { "content-type": "application/json" },',
        )),
    },
    {
      symbol: PAGE,
      mutate: (dir) => edit(dir, "src/app/checkout/page.tsx", (t) =>
        t.replace("return <main>", 'throw new Error("mutated page"); return <main>')),
    },
  ];

  for (const mutation of mutations) {
    it(`selection is a superset of full-run impact for ${mutation.symbol}`, async () => {
      const dir = await makeGitCopy();
      mutation.mutate(dir);
      // Selection first: it must be decided from the un-rebuilt diff alone.
      const selection = await selectTests({ rootDir: dir });
      expect(selection.unsafeReasons).toEqual([]);
      expect(selection.changedSymbols).toContain(mutation.symbol);
      // Ground truth: a full verify run. A test is affected when it fails
      // or its observed set no longer matches its declaration.
      await buildHarness(dir);
      const full = await verifyProject({ rootDir: dir });
      const affected = full.results
        .filter((r) => r.status !== "pass" && r.status !== "skipped-verify")
        .map((r) => r.testId);
      expect(affected.length, "the mutation must actually affect a test").toBeGreaterThan(0);
      const selected = new Set(selectedIds(selection));
      for (const testId of affected) {
        expect(selected.has(testId), `${testId} affected but not selected`).toBe(true);
      }
    }, T);
  }
});
