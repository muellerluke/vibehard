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
  selectTests,
  spawnCapture,
  verifyProject,
  type SelectionResult,
  type TestProjectResult,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const EXAMPLE = path.join(REPO_ROOT, "examples/next-fullstack");
const NEXT_BIN = path.join(REPO_ROOT, "node_modules/next/dist/bin/next");
const T = 420_000;

const HOME = "e2e/app.spec.ts::home page prices, counts, and saves a note";
const PRICE = "e2e/app.spec.ts::price api applies a discount";
const LEGACY = "e2e/app.spec.ts::legacy pages route renders per request";
const HELLO = "e2e/app.spec.ts::pages api greets by name";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

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

/**
 * Copy the example inside the repo (workspace module resolution) and
 * commit it as the base revision of its own git repo.
 */
async function makeGitCopy(): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, {
    recursive: true,
    filter: (src) =>
      !src.includes("node_modules") &&
      !src.includes(`${path.sep}.next`) &&
      !src.includes("test-results") &&
      !src.endsWith("next-env.d.ts"),
  });
  writeFileSync(
    path.join(dir, ".gitignore"),
    ".next/\ntest-results/\nnode_modules/\nnext-env.d.ts\n",
  );
  // The copy sits directly under the repo root, so Turbopack would take
  // the copy itself as its filesystem root and refuse the hoisted
  // (root) node_modules. Point its root at the repo root instead.
  writeFileSync(
    path.join(dir, "next.config.mjs"),
    `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  productionBrowserSourceMaps: true,\n  turbopack: { root: ${JSON.stringify(REPO_ROOT)} },\n};\n\nexport default nextConfig;\n`,
  );
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "Stage 5 Test"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-m", "base"]);
  return dir;
}

/** Production build of a copy (AT-21 shape: `next build` output). */
async function buildNext(cwd: string): Promise<void> {
  const r = await spawnCapture(process.execPath, [NEXT_BIN, "build"], {
    cwd,
    timeoutMs: 300_000,
  });
  expect(r.exitCode, r.stdout.slice(-2000) + r.stderr.slice(-2000)).toBe(0);
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

describe("AT-19: next-fullstack selection per symbol kind", () => {
  const cases: { name: string; symbol: string; expected: string[]; mutate: (dir: string) => void }[] = [
    {
      name: "server component (HomePage)",
      symbol: "src/app/page.tsx#HomePage",
      expected: [HOME],
      mutate: (dir) =>
        edit(dir, "src/app/page.tsx", (t) => t.replace("<h1>Checkout</h1>", "<h1>Checkout now</h1>")),
    },
    {
      name: "client component (Counter)",
      symbol: "src/app/counter/Counter.tsx#Counter",
      expected: [HOME],
      mutate: (dir) =>
        edit(dir, "src/app/counter/Counter.tsx", (t) =>
          t.replace("Add item ({formatPrice(count * 100)})", "Add one ({formatPrice(count * 100)})"),
        ),
    },
    {
      name: "route handler (GET)",
      symbol: "src/app/api/price/route.ts#GET",
      expected: [PRICE],
      mutate: (dir) =>
        edit(dir, "src/app/api/price/route.ts", (t) =>
          t.replace("{ cents: total, formatted:", "{ cents: total + 0, formatted:"),
        ),
    },
    {
      name: "server action (saveNote)",
      symbol: "src/app/actions.ts#saveNote",
      expected: [HOME],
      mutate: (dir) =>
        edit(dir, "src/app/actions.ts", (t) =>
          t.replace("normalized !== \"(empty)\"", "normalized !== \"(empty)\" && true"),
        ),
    },
    {
      name: "pages data function (getServerSideProps)",
      symbol: "src/pages/legacy.tsx#getServerSideProps",
      expected: [LEGACY],
      mutate: (dir) =>
        edit(dir, "src/pages/legacy.tsx", (t) =>
          t.replace('?? "500"', '?? "501"'),
        ),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: selects exactly its declaring tests`, async () => {
      const dir = await makeGitCopy();
      c.mutate(dir);
      const { exitCode, result } = await dryRun(dir);
      expect(exitCode, c.name).toBe(0);
      expect(result.selection?.changedSymbols, c.name).toEqual([c.symbol]);
      expect(selectedIds(result.selection), c.name).toEqual(c.expected);
      expect(result.selection?.selected[0]?.reasons, c.name).toContainEqual(
        expect.objectContaining({ type: "changed-symbol", symbol: c.symbol }),
      );
      rmSync(dir, { recursive: true, force: true });
    }, T);
  }
});

describe("AT-21: production build maps to the recorded symbol sets", () => {
  it("verify is green against `next build` + `next start` output", async () => {
    const dir = await makeGitCopy();
    await buildNext(dir);
    const result = await verifyProject({ rootDir: dir });
    expect(result.exitCode, JSON.stringify(result.results, null, 1)).toBe(0);
    expect(result.results.map((r) => r.testId).sort()).toEqual(
      [HOME, LEGACY, HELLO, PRICE].sort(),
    );
    for (const r of result.results) {
      expect(r.status, r.testId).toBe("pass");
      for (const id of r.observed) expect(r.touched?.[id], r.testId).toBeDefined();
      expect(r.unmappable, r.testId).toEqual([]);
    }
  }, T);
});

describe("AT-17 recall audit on examples/next-fullstack", () => {
  const mutations: { symbol: string; mutate: (dir: string) => void }[] = [
    {
      symbol: "src/lib/pricing.ts#formatPrice",
      mutate: (dir) =>
        edit(dir, "src/lib/pricing.ts", (t) => t.replace("`${sign}$", "`${sign}USD ")),
    },
    {
      symbol: "src/lib/pricing.ts#applyDiscount",
      mutate: (dir) =>
        edit(dir, "src/lib/pricing.ts", (t) =>
          t.replace("(1 - clamped / 100)", "(1 - clamped / 1000)"),
        ),
    },
    {
      symbol: "src/lib/notes.ts#normalizeNote",
      mutate: (dir) =>
        edit(dir, "src/lib/notes.ts", (t) => t.replace("toUpperCase()", "toLowerCase()")),
    },
    {
      // Not a throw: the root layout also wraps the prerendered
      // /_not-found page, so throwing breaks `next build` itself.
      // Dropping {children} builds fine and fails every page test.
      symbol: "src/app/layout.tsx#RootLayout",
      mutate: (dir) =>
        edit(dir, "src/app/layout.tsx", (t) => t.replace("{children}", "{null}")),
    },
    {
      symbol: "src/app/page.tsx#HomePage",
      mutate: (dir) =>
        edit(dir, "src/app/page.tsx", (t) =>
          t.replace('Number(cents ?? "4397")', 'Number(cents ?? "4397") + 1'),
        ),
    },
    {
      symbol: "src/app/counter/Counter.tsx#Counter",
      mutate: (dir) =>
        edit(dir, "src/app/counter/Counter.tsx", (t) =>
          t.replace("const next = count + 1;", "const next = count + 2;"),
        ),
    },
    {
      symbol: "src/app/actions.ts#saveNote",
      mutate: (dir) =>
        edit(dir, "src/app/actions.ts", (t) =>
          t.replace("note: normalized }", 'note: normalized + "!" }'),
        ),
    },
    {
      symbol: "src/app/api/price/route.ts#GET",
      mutate: (dir) =>
        edit(dir, "src/app/api/price/route.ts", (t) =>
          t.replace("{ cents: total, formatted:", "{ cents: total + 1, formatted:"),
        ),
    },
    {
      symbol: "src/pages/legacy.tsx#getServerSideProps",
      mutate: (dir) =>
        edit(dir, "src/pages/legacy.tsx", (t) =>
          t.replace('Number(context.query.cents ?? "500")', 'Number(context.query.cents ?? "500") + 1'),
        ),
    },
    {
      symbol: "src/pages/legacy.tsx#LegacyPage",
      mutate: (dir) =>
        edit(dir, "src/pages/legacy.tsx", (t) =>
          t.replace("{formatPrice(cents)}", "{formatPrice(cents + 1)}"),
        ),
    },
    {
      symbol: "src/pages/api/hello.ts#handler",
      mutate: (dir) =>
        edit(dir, "src/pages/api/hello.ts", (t) =>
          t.replace("normalizeNote(name)", 'normalizeNote(name + "x")'),
        ),
    },
  ];

  for (const mutation of mutations) {
    it(`selection is a superset of full-run impact for ${mutation.symbol}`, async () => {
      const dir = await makeGitCopy();
      mutation.mutate(dir);
      // Selection first, from the un-built diff alone.
      const selection = await selectTests({ rootDir: dir });
      expect(selection.unsafeReasons).toEqual([]);
      expect(selection.changedSymbols).toContain(mutation.symbol);
      // Ground truth: production build + full verify run.
      await buildNext(dir);
      const full = await verifyProject({ rootDir: dir });
      const affected = full.results
        .filter((r) => r.status !== "pass" && r.status !== "always-run")
        .map((r) => r.testId);
      expect(affected.length, "the mutation must actually affect a test").toBeGreaterThan(0);
      const selected = new Set(selectedIds(selection));
      for (const testId of affected) {
        expect(selected.has(testId), `${testId} affected but not selected`).toBe(true);
      }
    }, T);
  }
});
