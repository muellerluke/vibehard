import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import type { ResolvedConfig } from "./config.js";
import { makeTestId, type ListedTest } from "./listed.js";
import { VibehardUsageError } from "./types.js";

const SPEC_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (isDir(full)) walk(full, out);
    else if (SPEC_EXTS.has(path.extname(name))) out.push(full);
  }
}

/** Candidate spec files under the configured (or default) test directory. */
export function findSpecFiles(
  rootDir: string,
  resolved: ResolvedConfig,
  defaults: readonly string[],
  isSpec: (relPosix: string) => boolean,
): string[] {
  const roots: string[] = [];
  if (resolved.testDirPosix !== null) {
    roots.push(path.resolve(rootDir, resolved.testDirPosix));
  } else {
    for (const d of defaults) {
      const abs = path.resolve(rootDir, d);
      if (isDir(abs)) roots.push(abs);
    }
  }
  const files: string[] = [];
  for (const root of roots) walk(root, files);
  return files.filter((f) =>
    isSpec(path.relative(rootDir, f).split(path.sep).join("/")),
  );
}

function literalTitle(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : null;
}

interface Bindings {
  testNames: Set<string>;
  describeNames: Set<string>;
}

function collectBindings(
  sourceFile: ts.SourceFile,
  imports: readonly BindingImport[],
  globals: { test: readonly string[]; describe: readonly string[] },
): Bindings {
  const testNames = new Set<string>(globals.test);
  const describeNames = new Set<string>(globals.describe);
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const specifierText: string = stmt.moduleSpecifier.text;
    const match = imports.find((i) => i.specifier === specifierText);
    if (match === undefined) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      const imported = el.propertyName?.text ?? el.name.text;
      if (match.test.includes(imported)) testNames.add(el.name.text);
      if (match.describe.includes(imported)) describeNames.add(el.name.text);
    }
  }
  return { testNames, describeNames };
}

export interface BindingImport {
  /** Module specifier the helper is imported from. */
  specifier: string;
  test: readonly string[];
  describe: readonly string[];
}

export interface StaticDiscoveryOptions {
  /** Module specifier counted for `requireImport` file filtering. */
  specifier: string;
  imports: readonly BindingImport[];
  /** Callee names recognized without an import (runner globals). */
  globals: { test: readonly string[]; describe: readonly string[] };
  /** Only count files that import `specifier` at all. */
  requireImport: boolean;
}

/** Enumerate tests in one spec file by static AST walk (literal titles only). */
export function discoverInFile(
  rootDir: string,
  absFile: string,
  options: StaticDiscoveryOptions,
): ListedTest[] {
  const text = readFileSync(absFile, "utf8");
  if (options.requireImport && !text.includes(options.specifier)) return [];
  const relFile = path.relative(rootDir, absFile).split(path.sep).join("/");
  const kind = absFile.endsWith("x")
    ? ts.ScriptKind.TSX
    : absFile.endsWith(".ts") || absFile.endsWith(".mts") || absFile.endsWith(".cts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, kind);
  const { testNames, describeNames } = collectBindings(
    sourceFile,
    options.imports,
    options.globals,
  );
  const out: ListedTest[] = [];
  const calleeName = (call: ts.CallExpression): string | null => {
    const expr = call.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    // test.only / it.only / describe.only
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "only" &&
      ts.isIdentifier(expr.expression)
    ) {
      return expr.expression.text;
    }
    return null;
  };
  const visit = (node: ts.Node, describePath: string[]): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const title = literalTitle(node.arguments[0]);
      if (name !== null && title !== null && describeNames.has(name)) {
        const fn = node.arguments[1];
        if (fn !== undefined) visit(fn, [...describePath, title]);
        return;
      }
      if (name !== null && title !== null && testNames.has(name)) {
        const titlePath = [...describePath, title];
        out.push({
          file: absFile,
          relFile,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          title,
          titlePath,
          testId: makeTestId(relFile, titlePath),
        });
        return;
      }
    }
    node.forEachChild((child) => visit(child, describePath));
  };
  visit(sourceFile, []);
  return out;
}

/** Discover tests across spec files, rejecting duplicate test IDs. */
export async function discoverStaticTests(
  rootDir: string,
  resolved: ResolvedConfig,
  input: {
    defaults: readonly string[];
    isSpec: (relPosix: string) => boolean;
    discovery: StaticDiscoveryOptions;
    frameworkLabel: string;
  },
): Promise<ListedTest[]> {
  const files = findSpecFiles(rootDir, resolved, input.defaults, input.isSpec);
  const tests: ListedTest[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    tests.push(...discoverInFile(rootDir, file, input.discovery));
  }
  const seen = new Map<string, ListedTest>();
  for (const t of tests) {
    const prev = seen.get(t.testId);
    if (prev !== undefined) {
      throw new VibehardUsageError(
        `vibehard: duplicate test "${t.title}" in ${t.relFile} (lines ${prev.line} and ${t.line}); rename one so declarations stay unambiguous`,
      );
    }
    seen.set(t.testId, t);
  }
  return tests.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
}
