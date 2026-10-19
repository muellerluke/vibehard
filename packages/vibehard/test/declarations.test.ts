import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkLockfile,
  diffDeclaredObserved,
  emptyLockfile,
  extractDeclarations,
  hashSymbolSources,
  matchGlob,
  matchSymbolPattern,
  readLockfile,
  rewriteDeclaration,
  serializeLockfile,
  writeLockfile,
  CodemodError,
  type SymbolRecord,
} from "../src/index.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-decl-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("glob matcher", () => {
  it("supports **, *, ?", () => {
    expect(matchGlob("src/lib/**", "src/lib/cart.ts")).toBe(true);
    expect(matchGlob("src/lib/**", "src/lib/a/b.ts")).toBe(true);
    expect(matchGlob("src/lib/*", "src/lib/a/b.ts")).toBe(false);
    expect(matchGlob("src/lib/*", "src/lib/cart.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
    expect(matchGlob("**", "anything/at/all")).toBe(true);
    expect(matchGlob("src/**/cart.ts", "src/cart.ts")).toBe(true);
  });

  it("matches symbol patterns by file part or full ID", () => {
    expect(matchSymbolPattern("src/lib/**", "src/lib/cart.ts#Cart.addItem")).toBe(true);
    expect(matchSymbolPattern("src/lib/cart.ts#Cart.*", "src/lib/cart.ts#Cart.addItem")).toBe(true);
    expect(matchSymbolPattern("src/other/**", "src/lib/cart.ts#Cart.addItem")).toBe(false);
  });
});

describe("diffDeclaredObserved", () => {
  const known = new Set(["a.ts#A", "a.ts#B", "b.ts#C", "c.ts#D"]);

  it("passes on equality, reports missing/extra", () => {
    const eq = diffDeclaredObserved({ declared: ["a.ts#A"], observed: ["a.ts#A"], knownSymbolIds: known });
    expect(eq.missing).toEqual([]);
    expect(eq.extra).toEqual([]);
    const diff = diffDeclaredObserved({
      declared: ["a.ts#A", "a.ts#B"],
      observed: ["a.ts#A", "b.ts#C"],
      knownSymbolIds: known,
    });
    expect(diff.missing).toEqual(["a.ts#B"]);
    expect(diff.extra).toEqual(["b.ts#C"]);
  });

  it("applies ignore to both sides and allowTransitive to extra", () => {
    const diff = diffDeclaredObserved({
      declared: ["a.ts#A", "c.ts#D"],
      observed: ["a.ts#A", "b.ts#C", "c.ts#D"],
      knownSymbolIds: known,
      ignore: ["c.ts#D"],
      allowTransitive: ["b.ts#C"],
    });
    expect(diff.declared).toEqual(["a.ts#A"]);
    expect(diff.observed).toEqual(["a.ts#A", "b.ts#C"]);
    expect(diff.allowed).toEqual(["b.ts#C"]);
    expect(diff.extra).toEqual([]);
    expect(diff.missing).toEqual([]);
  });

  it("marks unknown declared IDs as missing + unknown, dedupes", () => {
    const diff = diffDeclaredObserved({
      declared: ["a.ts#A", "a.ts#A", "x.ts#Nope"],
      observed: ["a.ts#A"],
      knownSymbolIds: known,
    });
    expect(diff.unknown).toEqual(["x.ts#Nope"]);
    expect(diff.missing).toEqual(["x.ts#Nope"]);
    expect(diff.diagnostics.some((d) => d.includes("duplicate"))).toBe(true);
  });

  it("keeps null declared as undeclared", () => {
    const diff = diffDeclaredObserved({ declared: null, observed: ["a.ts#A"], knownSymbolIds: known });
    expect(diff.declared).toBeNull();
    expect(diff.observed).toEqual(["a.ts#A"]);
  });
});

describe("lockfile", () => {
  const record = (id: string, file: string, start: number, end: number): SymbolRecord => ({
    id,
    file,
    qualifiedName: id.split("#")[1] ?? "",
    kind: "function",
    startOffset: start,
    endOffset: end,
    startLine: 1,
    endLine: 1,
  });

  it("hashes change on whitespace edit inside a symbol", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "a.ts");
    writeFileSync(file, "export function A() { return 1; }\n");
    const before = hashSymbolSources(dir, [record("a.ts#A", "a.ts", 0, 33)]);
    writeFileSync(file, "export function A() {  return 1; }\n");
    const after = hashSymbolSources(dir, [record("a.ts#A", "a.ts", 0, 34)]);
    expect(before["a.ts#A"]).not.toBe(after["a.ts#A"]);
  });

  it("serializes stably, writes atomically once, detects tamper + drift", () => {
    const dir = makeTempDir();
    const lockPath = path.join(dir, "vibehard.lock.json");
    const lock = emptyLockfile("cfg", "1.59.0");
    lock.tests["e2e/a.spec.ts::works"] = {
      file: "e2e/a.spec.ts",
      titlePath: ["works"],
      declared: ["a.ts#A"],
      symbolHashes: { "a.ts#A": "abc" },
      allowTransitive: [],
      allowedObserved: [],
    };
    expect(writeLockfile(lockPath, lock)).toBe(true);
    expect(writeLockfile(lockPath, lock)).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe(serializeLockfile(lock));

    const ok = checkLockfile(readLockfile(lockPath), {
      configHash: "cfg",
      frameworkVersion: "1.59.0",
      expectations: [{ testId: "e2e/a.spec.ts::works", declared: ["a.ts#A"], symbolHashes: { "a.ts#A": "abc" } }],
      fullRun: true,
      discoveredTestIds: new Set(["e2e/a.spec.ts::works"]),
    });
    expect(ok).toEqual([]);

    const tampered = readLockfile(lockPath);
    if (tampered !== null && tampered.tests["e2e/a.spec.ts::works"] !== undefined) {
      tampered.tests["e2e/a.spec.ts::works"].symbolHashes["a.ts#A"] = "zzz";
    }
    const drift = checkLockfile(tampered, {
      configHash: "cfg",
      frameworkVersion: "1.59.0",
      expectations: [{ testId: "e2e/a.spec.ts::works", declared: ["a.ts#A"], symbolHashes: { "a.ts#A": "abc" } }],
      fullRun: false,
    });
    expect(drift.some((d) => d.includes("source hash mismatch"))).toBe(true);
    expect(checkLockfile(null, { configHash: "cfg", frameworkVersion: "1.59.0", expectations: [], fullRun: false }))
      .toEqual(["lockfile missing (run `vibehard record` or `vibehard verify`)"]);
  });
});

describe("declaration extractor + codemod", () => {
  const header = `import { test, expect } from 'vibehard/playwright';\n\n`;

  it("inserts an options object for an undeclared test", () => {
    const src = `${header}test('shows total', async ({ page }) => {\n  await page.goto('/');\n});\n`;
    const r = rewriteDeclaration(src, "a.spec.ts", "shows total", ["src/a.ts#A", "src/b.ts#B"]);
    expect(r.changed).toBe(true);
    expect(r.text).toContain(
      "test('shows total', {\n  uses: [\n    'src/a.ts#A',\n    'src/b.ts#B',\n  ],\n}, async ({ page }) => {",
    );
    expect(r.finalDeclared).toEqual(["src/a.ts#A", "src/b.ts#B"]);
    const again = rewriteDeclaration(r.text, "a.spec.ts", "shows total", ["src/b.ts#B", "src/a.ts#A"]);
    expect(again.changed).toBe(false);
    expect(again.text).toBe(r.text);
  });

  it("replaces literals in an existing single-line array", () => {
    const src = `${header}test('t', { uses: ['src/old.ts#Old'] }, async () => {});\n`;
    const r = rewriteDeclaration(src, "a.spec.ts", "t", ["src/a.ts#A"]);
    expect(r.text).toContain("uses: ['src/a.ts#A']");
    expect(r.text).not.toContain("Old");
  });

  it("preserves same-file spreads and rewrites only literals", () => {
    const src = `${header}const shell = ['src/shell.ts#Shell'];\ntest('t', {\n  uses: [...shell, 'src/old.ts#Old'],\n}, async () => {});\n`;
    const r = rewriteDeclaration(src, "a.spec.ts", "t", ["src/a.ts#A", "src/shell.ts#Shell"]);
    expect(r.spreadSymbols).toEqual(["src/shell.ts#Shell"]);
    expect(r.finalDeclared).toEqual(["src/a.ts#A", "src/shell.ts#Shell"]);
    expect(r.text).toContain("...shell");
    expect(r.text).toContain("'src/a.ts#A'");
    expect(r.text).not.toContain("'src/old.ts#Old'");
    // The shell symbol appears only in the group definition, not as a literal in uses.
    expect(r.text.split("'src/shell.ts#Shell'")).toHaveLength(2);
  });

  it("evaluates imported shared groups one hop", () => {
    const src = `import { test } from 'vibehard/playwright';\nimport { shared } from './uses.js';\ntest('t', { uses: [...shared] }, async () => {});\n`;
    const decls = extractDeclarations(src, "a.spec.ts", {
      readImport: (spec) =>
        spec === "./uses.js"
          ? { fileName: "uses.ts", text: "export const shared = ['src/x.ts#X'];\n" }
          : null,
    });
    expect(decls[0]?.uses.kind).toBe("array");
    if (decls[0]?.uses.kind === "array") {
      expect(decls[0].uses.spreads[0]?.symbols).toEqual(["src/x.ts#X"]);
    }
  });

  it("refuses non-literal uses and unknown spreads", () => {
    const nonLiteral = `${header}const dyn = ['src/a.ts#A'];\ntest('t', { uses: dyn }, async () => {});\n`;
    expect(() => rewriteDeclaration(nonLiteral, "a.spec.ts", "t", [])).toThrow(CodemodError);
    const badSpread = `${header}test('t', { uses: [...compute()] }, async () => {});\n`;
    expect(() => rewriteDeclaration(badSpread, "a.spec.ts", "t", [])).toThrow(/cannot statically evaluate/);
    expect(() => rewriteDeclaration(header, "a.spec.ts", "nope", [])).toThrow(/not found/);
  });

  it("preserves CRLF line endings", () => {
    const src = `${header}test('t', async () => {});\r\n`.replace(/\n/g, "\r\n");
    const r = rewriteDeclaration(src, "a.spec.ts", "t", ["src/a.ts#A"]);
    expect(r.text).toContain("uses: [\r\n");
    expect(r.text.endsWith("\r\n")).toBe(true);
  });
});

describe("Cypress declaration shape (Stage 6)", () => {
  const SPEC = [
    'import { uses } from "vibehard/cypress";',
    'import { appShell } from "./uses.js";',
    "",
    'it("declared one", () => {',
    "  uses([...appShell, 'src/lib/a.ts#A']);",
    "  cy.visit('/');",
    "});",
    "",
    'it("undeclared one", () => {',
    "  cy.visit('/');",
    "});",
    "",
  ].join("\n");
  const readImport = () => ({
    fileName: "uses.js",
    text: "export const appShell = ['src/app/layout.tsx#RootLayout'];",
  });

  it("extracts it() + uses() declarations", () => {
    const decls = extractDeclarations(SPEC, "cypress/e2e/app.cy.js", {
      framework: "cypress",
      readImport,
    });
    expect(decls.map((d) => d.title)).toEqual(["declared one", "undeclared one"]);
    expect(decls[0]?.uses.kind).toBe("array");
    expect(decls[0]?.cypress?.usesName).toBe("uses");
    expect(decls[1]?.uses.kind).toBe("none");
  });

  it("record inserts uses() as the first statement of an undeclared test", () => {
    const out = rewriteDeclaration(SPEC, "cypress/e2e/app.cy.js", "undeclared one", [
      "src/lib/b.ts#B",
    ], { framework: "cypress", readImport });
    expect(out.changed).toBe(true);
    expect(out.text).toContain('it("undeclared one", () => {\n  uses([');
    expect(out.text).toContain("'src/lib/b.ts#B'");
    expect(out.finalDeclared).toEqual(["src/lib/b.ts#B"]);
  });

  it("record rewrites literals inside uses(), preserving spreads", () => {
    const out = rewriteDeclaration(
      SPEC,
      "cypress/e2e/app.cy.js",
      "declared one",
      ["src/app/layout.tsx#RootLayout", "src/lib/c.ts#C"],
      { framework: "cypress", readImport },
    );
    expect(out.text).toContain("...appShell");
    expect(out.text).toContain("'src/lib/c.ts#C'");
    expect(out.text).not.toContain("'src/lib/a.ts#A'");
  });

  it("record adds the uses import when the spec lacks it", () => {
    const bare = 'it("bare", () => {\n  cy.visit("/");\n});\n';
    const out = rewriteDeclaration(bare, "cypress/e2e/app.cy.js", "bare", ["src/lib/b.ts#B"], {
      framework: "cypress",
    });
    expect(out.text.startsWith("import { uses } from 'vibehard/cypress';")).toBe(true);
    expect(out.text).toContain("uses([");
  });
});
