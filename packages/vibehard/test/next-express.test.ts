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
  verifyProject,
  type SelectionResult,
  type TestProjectResult,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const EXAMPLE = path.join(REPO_ROOT, "examples/next-express");
const NEXT_BIN = path.join(REPO_ROOT, "node_modules/next/dist/bin/next");
const T = 420_000;

const PRODUCT = "e2e/app.spec.ts::product page shows the api price";
const ORDER = "e2e/app.spec.ts::order api prices an order";

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

async function makeGitCopy(): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(EXAMPLE, dir, {
    recursive: true,
    filter: (src) =>
      !src.includes("node_modules") &&
      !src.includes(`${path.sep}.next`) &&
      !src.includes(`${path.sep}.build`) &&
      !src.includes("test-results") &&
      !src.endsWith("next-env.d.ts"),
  });
  writeFileSync(
    path.join(dir, ".gitignore"),
    ".next/\n.build/\ntest-results/\nnode_modules/\nnext-env.d.ts\n",
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

async function buildExample(cwd: string): Promise<void> {
  const api = await spawnCapture(process.execPath, ["build-api.mjs"], {
    cwd,
    timeoutMs: 180_000,
  });
  expect(api.exitCode, api.stderr).toBe(0);
  const next = await spawnCapture(process.execPath, [NEXT_BIN, "build"], {
    cwd,
    timeoutMs: 300_000,
  });
  expect(next.exitCode, next.stdout.slice(-2000) + next.stderr.slice(-2000)).toBe(0);
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

describe("AT-20: next-express cross-process selection", () => {
  const cases: { name: string; symbol: string; expected: string[]; mutate: (dir: string) => void }[] = [
    {
      name: "Express handler used by the page (getProduct route)",
      symbol: "api/src/routes.ts#getProduct",
      expected: [PRODUCT],
      mutate: (dir) =>
        edit(dir, "api/src/routes.ts", (t) =>
          t.replace('typeof req.query["sku"] === "string" ? req.query["sku"] : "pen"',
            'typeof req.query["sku"] === "string" ? req.query["sku"] : "pen".toString()'),
        ),
    },
    {
      name: "shared API catalog symbol (findProduct)",
      symbol: "api/src/catalog.ts#findProduct",
      expected: [ORDER, PRODUCT],
      mutate: (dir) =>
        edit(dir, "api/src/catalog.ts", (t) =>
          t.replace("p.sku === sku", "p.sku === sku.trim()"),
        ),
    },
    {
      name: "API-only symbol (createOrder)",
      symbol: "api/src/routes.ts#createOrder",
      expected: [ORDER],
      mutate: (dir) =>
        edit(dir, "api/src/routes.ts", (t) =>
          t.replace("body.quantity ?? 1", "body.quantity ?? 1 + 0"),
        ),
    },
    {
      name: "frontend-only page (ProductPage) does not select the API-only test",
      symbol: "src/app/page.tsx#ProductPage",
      expected: [PRODUCT],
      mutate: (dir) =>
        edit(dir, "src/app/page.tsx", (t) =>
          t.replace('getProduct(sku ?? "pen")', 'getProduct(sku ?? "pen".toString())'),
        ),
    },
    {
      name: "frontend-only lib (formatPrice) does not select the API-only test",
      symbol: "src/lib/pricing.ts#formatPrice",
      expected: [PRODUCT],
      mutate: (dir) =>
        edit(dir, "src/lib/pricing.ts", (t) =>
          t.replace("(absolute / 100)", "(absolute / 100 + 0)"),
        ),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: selects exactly ${JSON.stringify(c.expected)}`, async () => {
      const dir = await makeGitCopy();
      c.mutate(dir);
      const { exitCode, result } = await dryRun(dir);
      expect(exitCode, c.name).toBe(0);
      expect(result.selection?.changedSymbols, c.name).toEqual([c.symbol]);
      expect(selectedIds(result.selection), c.name).toEqual(c.expected);
      rmSync(dir, { recursive: true, force: true });
    }, T);
  }
});

describe("AT-21 (separate backend): production verify merges both processes", () => {
  it("verify is green with coverage merged from Next + Express processes", async () => {
    const dir = await makeGitCopy();
    await buildExample(dir);
    const result = await verifyProject({ rootDir: dir });
    expect(result.exitCode, JSON.stringify(result.results, null, 1)).toBe(0);
    for (const r of result.results) {
      expect(r.status, r.testId).toBe("pass");
      expect(r.observed, r.testId).toEqual(r.declared);
    }
    const product = result.results.find((r) => r.testId === PRODUCT);
    // The frontend test's observed set spans both processes.
    expect(product?.observed).toContain("api/src/routes.ts#getProduct");
    expect(product?.observed).toContain("src/app/page.tsx#ProductPage");
  }, T);
});
