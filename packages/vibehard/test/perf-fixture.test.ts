import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { selectTests, spawnCapture } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const GENERATOR = path.join(REPO_ROOT, "packages/vibehard/perf/generate-scale-fixture.mjs");
const T = 240_000;

const outDir = path.join(REPO_ROOT, `.vh-perf-test-${process.pid}`);
const manifestPath = `${outDir}.manifest.json`;

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
});

interface Manifest {
  kind: string;
  counts: {
    sourceFiles: number;
    symbols: number;
    specFiles: number;
    tests: number;
    edges: number;
    lockfileBytes: number;
  };
  touched: { min: number; max: number; mean: number };
  scenarios: Record<
    string,
    { file: string; symbolId: string | null; expectedTestIds: string[] } | null
  >;
}

async function generate(): Promise<Manifest> {
  const result = await spawnCapture(
    process.execPath,
    [
      GENERATOR,
      "--files", "12",
      "--symbols-per-file", "3",
      "--shared-files", "3",
      "--spec-files", "2",
      "--tests-per-spec", "3",
      "--touched-per-test", "20",
      "--seed", "7",
      "--out", outDir,
      "--manifest", manifestPath,
    ],
    { cwd: REPO_ROOT, timeoutMs: 120_000 },
  );
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function hashTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === ".build" || name === ".vh-perf-generated") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  const hash = createHash("sha256");
  for (const rel of files.sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function git(args: string[]): Promise<void> {
  const result = await spawnCapture("git", args, { cwd: outDir, timeoutMs: 60_000 });
  expect(result.exitCode, result.stderr).toBe(0);
}

function applyFunctionMutation(info: { file: string; symbolId: string | null }): void {
  if (info.symbolId === null) throw new Error("scenario has no symbol");
  const fnName = info.symbolId.slice(info.symbolId.indexOf("#") + 1).split(".").at(-1);
  const file = path.join(outDir, info.file);
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`export function ${fnName}(`);
  const semi = text.indexOf(";", text.indexOf("return ", start));
  writeFileSync(file, `${text.slice(0, semi)} + 0${text.slice(semi)}`);
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  rmSync(outDir, { recursive: true, force: true });
  rmSync(manifestPath, { force: true });
}, T);

describe("Phase 0 perf fixture generator", () => {
  it("generates a deterministic, trusted selection fixture", async () => {
    const first = await generate();
    expect(first.kind).toBe("selection");
    expect(first.counts).toMatchObject({ sourceFiles: 12, specFiles: 2, tests: 6 });
    expect(first.counts.symbols).toBeGreaterThan(100);
    expect(first.counts.edges).toBe(120);
    expect(first.touched).toEqual({ min: 20, max: 20, mean: 20 });
    expect(existsSync(path.join(outDir, "vibehard.lock.json"))).toBe(true);
    const firstHash = hashTree(outDir);
    const firstManifestText = readFileSync(manifestPath, "utf8");

    const second = await generate();
    expect(second.counts).toEqual(first.counts);
    expect(hashTree(outDir)).toBe(firstHash);
    expect(readFileSync(manifestPath, "utf8")).toBe(firstManifestText);

    const clean = await selectTests({ rootDir: outDir, timing: false });
    expect(clean.unsafeReasons).toEqual([]);
    expect(clean.selected).toEqual([]);
    expect(clean.discovered).toHaveLength(6);
  }, T);

  it("leaf, shared, spec, and support scenarios select their expected tests", async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

    for (const scenario of ["leaf", "shared"] as const) {
      const info = manifest.scenarios[scenario];
      expect(info).not.toBeNull();
      if (info === null || info === undefined) continue;
      applyFunctionMutation(info);
      try {
        const selection = await selectTests({ rootDir: outDir, timing: false });
        expect(selection.unsafeReasons).toEqual([]);
        expect(selection.changedSymbols).toContain(info.symbolId);
        expect(selection.selected.map((t) => t.testId).sort()).toEqual(
          [...info.expectedTestIds].sort(),
        );
      } finally {
        await git(["checkout", "--", info.file]);
      }
    }

    const support = manifest.scenarios["support"];
    expect(support).not.toBeNull();
    if (support !== null && support !== undefined) {
      const file = path.join(outDir, support.file);
      writeFileSync(file, `${readFileSync(file, "utf8")}// perf support mutation\n`);
      try {
        const selection = await selectTests({ rootDir: outDir, timing: false });
        expect(selection.unsafeReasons).toEqual([]);
        expect(selection.selected.map((t) => t.testId).sort()).toEqual(
          [...support.expectedTestIds].sort(),
        );
        expect(selection.selected[0]?.reasons).toContainEqual({
          type: "test-support-changed",
          file: support.file,
        });
      } finally {
        await git(["checkout", "--", support.file]);
      }
    }

    const spec = manifest.scenarios["spec"];
    expect(spec).not.toBeNull();
    if (spec !== null && spec !== undefined) {
      const file = path.join(outDir, spec.file);
      writeFileSync(file, `${readFileSync(file, "utf8")}// perf spec mutation\n`);
      try {
        const selection = await selectTests({ rootDir: outDir, timing: false });
        expect(selection.unsafeReasons).toEqual([]);
        expect(selection.selected.map((t) => t.testId).sort()).toEqual(
          [...spec.expectedTestIds].sort(),
        );
      } finally {
        await git(["checkout", "--", spec.file]);
      }
    }
  }, T);
});
