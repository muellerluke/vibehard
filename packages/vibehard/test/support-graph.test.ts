import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createModuleResolver } from "../src/indexer/index.js";
import type { ChangedFile } from "../src/selector/git.js";
import {
  resolveChangedSupportFiles,
  supportFilesBySpec,
} from "../src/selector/support-graph.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeProject(
  files: Record<string, string>,
  compilerOptions: Record<string, unknown> = {},
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-support-graph-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        allowJs: true,
        strict: true,
        ...compilerOptions,
      },
      include: ["e2e", "src"],
    }),
  );
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

function changed(file: string, status: ChangedFile["status"] = "M"): ChangedFile {
  return { file, status };
}

function mapped(dir: string, specs: string[], support: ChangedFile[]) {
  return resolveChangedSupportFiles({
    rootDir: dir,
    testDirPosix: "e2e",
    specFiles: specs,
    changedSupport: support,
  });
}

describe("createModuleResolver.scanImports", () => {
  it("collects every provable literal edge form", () => {
    const dir = makeProject({});
    const resolver = createModuleResolver(dir);
    const scan = resolver.scanImports(
      "e2e/a.spec.ts",
      [
        'import { x } from "./named.js";',
        'import "./side-effect.js";',
        'import type { T } from "./types.js";',
        'export { y } from "./reexport.js";',
        'export * from "./star.js";',
        'const lazy = () => import("./lazy.js");',
        "const tpl = () => import(`./tpl.js`);",
        'const cjs = require("./cjs.js");',
        'import legacy = require("./legacy.js");',
        'const resolved = require.resolve("./resolved.js");',
        "export { x, lazy, tpl, cjs, legacy, resolved };",
        "export type { T };",
        "",
      ].join("\n"),
    );
    expect(scan.specifiers).toEqual([
      "./cjs.js",
      "./lazy.js",
      "./legacy.js",
      "./named.js",
      "./reexport.js",
      "./resolved.js",
      "./side-effect.js",
      "./star.js",
      "./tpl.js",
      "./types.js",
    ]);
    expect(scan.unprovable).toEqual([]);
  });

  it("flags non-literal loading forms as unprovable", () => {
    const dir = makeProject({});
    const resolver = createModuleResolver(dir);
    const scan = resolver.scanImports(
      "e2e/a.spec.ts",
      [
        'declare const name: string;',
        "export const a = () => import(name);",
        "export const b = () => import(`./${name}.js`);",
        "export const c = () => require(name);",
        'import { createRequire } from "node:module";',
        "export const req = createRequire(import.meta.url);",
        "",
      ].join("\n"),
    );
    expect(scan.specifiers).toEqual(["node:module"]);
    expect(scan.unprovable).toHaveLength(4);
    expect(scan.unprovable.join(" ")).toContain("dynamic import");
    expect(scan.unprovable.join(" ")).toContain("require");
    expect(scan.unprovable.join(" ")).toContain("createRequire");
  });
});

describe("createModuleResolver.resolveSpecifier", () => {
  it("resolves project files, externals, and misses distinctly", () => {
    const dir = makeProject(
      {
        "e2e/helper.ts": "export const h = 1;\n",
        "e2e/dir/index.ts": "export const d = 1;\n",
        "node_modules/pkg/package.json": JSON.stringify({ name: "pkg", main: "index.js" }),
        "node_modules/pkg/index.js": "module.exports = {};\n",
      },
      { baseUrl: ".", paths: { "@test/*": ["e2e/*"] } },
    );
    const resolver = createModuleResolver(dir);
    const from = "e2e/a.spec.ts";
    expect(resolver.resolveSpecifier(from, "./helper")).toEqual({
      kind: "project",
      file: "e2e/helper.ts",
    });
    expect(resolver.resolveSpecifier(from, "./helper.js")).toEqual({
      kind: "project",
      file: "e2e/helper.ts",
    });
    expect(resolver.resolveSpecifier(from, "./dir")).toEqual({
      kind: "project",
      file: "e2e/dir/index.ts",
    });
    expect(resolver.resolveSpecifier(from, "@test/helper")).toEqual({
      kind: "project",
      file: "e2e/helper.ts",
    });
    expect(resolver.resolveSpecifier(from, "pkg")).toEqual({ kind: "external" });
    expect(resolver.resolveSpecifier(from, "./missing")).toEqual({ kind: "unresolved" });
    expect(resolver.resolveSpecifier(from, "not-installed-pkg")).toEqual({
      kind: "unresolved",
    });
  });
});

describe("resolveChangedSupportFiles", () => {
  const SPECS = ["e2e/a.spec.ts", "e2e/b.spec.ts"];

  function twoSpecProject(extra: Record<string, string> = {}): string {
    return makeProject({
      "e2e/a.spec.ts":
        'import { onlyA } from "./only-a.js";\nimport { shared } from "./shared.js";\nimport "./barrel.js";\nexport { onlyA, shared };\n',
      "e2e/b.spec.ts": 'import { shared } from "./shared.js";\nexport { shared };\n',
      "e2e/only-a.ts": "export const onlyA = 1;\n",
      "e2e/shared.ts": 'import { deep } from "./deep.js";\nexport const shared = deep;\n',
      "e2e/deep.ts": "export const deep = 1;\n",
      "e2e/barrel.ts": 'export * from "./via-barrel.js";\n',
      "e2e/via-barrel.ts": "export const viaBarrel = 1;\n",
      "e2e/orphan.ts": "export const orphan = 1;\n",
      ...extra,
    });
  }

  it("maps a helper to exactly its transitive importing specs", () => {
    const dir = twoSpecProject();
    const result = mapped(dir, SPECS, [
      changed("e2e/only-a.ts"),
      changed("e2e/deep.ts"),
      changed("e2e/via-barrel.ts"),
    ]);
    expect(result.problems).toEqual([]);
    expect(result.mapped.get("e2e/only-a.ts")).toEqual(["e2e/a.spec.ts"]);
    expect(result.mapped.get("e2e/deep.ts")).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
    expect(result.mapped.get("e2e/via-barrel.ts")).toEqual(["e2e/a.spec.ts"]);
    expect(result.stats.filesParsed).toBeGreaterThan(0);
    expect(result.stats.edges).toBeGreaterThan(0);
    expect(result.stats.specsMapped).toBe(2);
  });

  it("handles cyclic helpers", () => {
    const dir = twoSpecProject({
      "e2e/a.spec.ts": 'import { x } from "./cycle-a.js";\nexport { x };\n',
      "e2e/cycle-a.ts": 'import { y } from "./cycle-b.js";\nexport const x = y;\n',
      "e2e/cycle-b.ts": 'import { x } from "./cycle-a.js";\nexport const y = x;\n',
    });
    const result = mapped(dir, SPECS, [changed("e2e/cycle-b.ts")]);
    expect(result.mapped.get("e2e/cycle-b.ts")).toEqual(["e2e/a.spec.ts"]);
  });

  it("does not map a helper no spec imports (implicit setup stays unsafe)", () => {
    const dir = twoSpecProject();
    const result = mapped(dir, SPECS, [changed("e2e/orphan.ts")]);
    expect(result.mapped.has("e2e/orphan.ts")).toBe(false);
  });

  it("does not map deletions or non-source support files", () => {
    const dir = twoSpecProject({ "e2e/data.json": '{"x":1}\n' });
    const result = mapped(dir, SPECS, [
      changed("e2e/only-a.ts", "D"),
      changed("e2e/data.json"),
    ]);
    expect(result.mapped.size).toBe(0);
    // Nothing eligible: the graph is never built.
    expect(result.stats.filesParsed).toBe(0);
  });

  it("fails closed when a traversed spec uses a non-literal import", () => {
    const dir = twoSpecProject({
      "e2e/b.spec.ts":
        'declare const name: string;\nexport const load = () => import(name);\n',
    });
    const result = mapped(dir, SPECS, [changed("e2e/only-a.ts")]);
    expect(result.mapped.size).toBe(0);
    expect(result.problems.join(" ")).toContain("e2e/b.spec.ts");
  });

  it("fails closed on an unresolved relative import in a helper", () => {
    const dir = twoSpecProject({
      "e2e/only-a.ts": 'import { gone } from "./gone.js";\nexport const onlyA = gone;\n',
    });
    const result = mapped(dir, SPECS, [changed("e2e/only-a.ts")]);
    expect(result.mapped.size).toBe(0);
    expect(result.problems.join(" ")).toContain("./gone.js");
  });

  it("stops traversal outside the test directory", () => {
    const dir = twoSpecProject({
      "e2e/a.spec.ts": 'import { u } from "../src/util.js";\nexport { u };\n',
      "src/util.ts": 'import { onlyA } from "../e2e/only-a.js";\nexport const u = onlyA;\n',
    });
    // Reachable only through app code: zero importers within the bound,
    // so the change stays unmapped rather than guessed.
    const result = mapped(dir, SPECS, [changed("e2e/only-a.ts")]);
    expect(result.mapped.has("e2e/only-a.ts")).toBe(false);
    expect(result.problems).toEqual([]);
  });

  it("treats app files imported by helpers as leaves", () => {
    const dir = twoSpecProject({
      "e2e/shared.ts": 'import { c } from "../src/constants.js";\nexport const shared = c;\n',
      "src/constants.ts": "export const c = 1;\n",
    });
    const result = mapped(dir, SPECS, [changed("e2e/shared.ts")]);
    expect(result.mapped.get("e2e/shared.ts")).toEqual(["e2e/a.spec.ts", "e2e/b.spec.ts"]);
  });

  it("degrades to unmapped when the resolver throws", () => {
    const dir = twoSpecProject();
    const result = resolveChangedSupportFiles({
      rootDir: dir,
      testDirPosix: "e2e",
      specFiles: SPECS,
      changedSupport: [changed("e2e/only-a.ts")],
      resolver: {
        typescriptVersion: "test",
        scanImports: () => {
          throw new Error("boom");
        },
        resolveSpecifier: () => ({ kind: "unresolved" }),
      },
    });
    expect(result.mapped.size).toBe(0);
    expect(result.problems).toEqual(["support graph failed: boom"]);
  });

  it("inverts the mapping per spec, sorted", () => {
    const bySpec = supportFilesBySpec(
      new Map([
        ["e2e/z-helper.ts", ["e2e/a.spec.ts"]],
        ["e2e/a-helper.ts", ["e2e/a.spec.ts", "e2e/b.spec.ts"]],
      ]),
    );
    expect(bySpec.get("e2e/a.spec.ts")).toEqual(["e2e/a-helper.ts", "e2e/z-helper.ts"]);
    expect(bySpec.get("e2e/b.spec.ts")).toEqual(["e2e/a-helper.ts"]);
  });

  it("does nothing without a test directory", () => {
    const dir = twoSpecProject();
    const result = resolveChangedSupportFiles({
      rootDir: dir,
      testDirPosix: null,
      specFiles: SPECS,
      changedSupport: [changed("e2e/only-a.ts")],
    });
    expect(result.mapped.size).toBe(0);
    expect(result.stats.filesParsed).toBe(0);
  });
});
