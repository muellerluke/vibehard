import ts from "typescript";

export class CodemodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodError";
  }
}

export interface ExtractOptions {
  /** Resolve a relative import specifier to file name + text (one hop). */
  readImport?: (specifier: string) => { fileName: string; text: string } | null;
  /**
   * Declaration shape to extract. Default: auto-detect from the file's
   * vibehard imports (Playwright `test`, Puppeteer `describeTest`, or a
   * Cypress `uses` binding — in that order).
   */
  framework?: "playwright" | "puppeteer" | "cypress";
}

export interface ExtractedSpread {
  /** Verbatim spread expression text (without the leading `...`). */
  text: string;
  /** Statically evaluated symbols, or null when not evaluable. */
  symbols: string[] | null;
}

export type ExtractedUses =
  | { kind: "none" } // test(title, fn) — no options object
  | { kind: "missing" } // options object without a uses property
  | { kind: "non-literal"; text: string }
  | {
      kind: "array";
      literals: string[];
      spreads: ExtractedSpread[];
      /** True when a non-string, non-spread element is present. */
      hasNonLiteralElement: boolean;
      start: number;
      end: number;
    };

export interface ExtractedDeclaration {
  title: string;
  uses: ExtractedUses;
  /** Literal strings, [] when absent, null when present but non-literal. */
  allowTransitive: string[] | null;
  skipVerify: string | null;
  /** Offset just after the title argument. */
  titleEnd: number;
  /** Offset just after the options object's `{`, or null. */
  optionsOpenEnd: number | null;
  optionsPropertyCount: number;
  /** Start offset of the call expression. */
  callStart: number;
  /** Start offset of the `uses` property (or Cypress `uses()` call), or null. */
  usesPropertyStart: number | null;
  /** Cypress declarations only: where a `uses()` call can be inserted. */
  cypress?: {
    /** Offset just after the test callback's opening `{`. */
    bodyOpenEnd: number;
    /** Local name bound to `uses` from 'vibehard/cypress', or null. */
    usesName: string | null;
  };
}

interface FileModel {
  sourceFile: ts.SourceFile;
  testName: string | null;
  /** Local names bound to Puppeteer's `describeTest`/`test`. */
  puppeteerTestNames: Set<string>;
  /** Local name bound to Cypress's `uses`, or null. */
  cypressUsesName: string | null;
  constArrays: Map<string, ts.ArrayLiteralExpression>;
  imports: Map<string, { specifier: string; importedName: string }>;
}

function buildModel(text: string, fileName: string): FileModel {
  const kind = fileName.endsWith("x")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".ts") || fileName.endsWith(".mts") || fileName.endsWith(".cts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JSX;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  let testName: string | null = null;
  const puppeteerTestNames = new Set<string>();
  let cypressUsesName: string | null = null;
  const constArrays = new Map<string, ts.ArrayLiteralExpression>();
  const imports = new Map<string, { specifier: string; importedName: string }>();
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const bindings = stmt.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const importedName = el.propertyName?.text ?? el.name.text;
          imports.set(el.name.text, { specifier, importedName });
          if (specifier === "vibehard/playwright" && importedName === "test") {
            testName = el.name.text;
          }
          if (
            specifier === "vibehard/puppeteer" &&
            (importedName === "describeTest" || importedName === "test")
          ) {
            puppeteerTestNames.add(el.name.text);
          }
          if (specifier === "vibehard/cypress" && importedName === "uses") {
            cypressUsesName = el.name.text;
          }
        }
      }
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer !== undefined &&
          ts.isArrayLiteralExpression(decl.initializer)
        ) {
          constArrays.set(decl.name.text, decl.initializer);
        }
      }
    }
  }
  return { sourceFile, testName, puppeteerTestNames, cypressUsesName, constArrays, imports };
}

function evalArrayLiteral(
  arr: ts.ArrayLiteralExpression,
  model: FileModel,
  options: ExtractOptions,
  depth: number,
  allowImports: boolean,
): string[] | null {
  if (depth > 8) return null;
  const out: string[] = [];
  for (const el of arr.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
      out.push(el.text);
    } else if (ts.isSpreadElement(el)) {
      const inner = evalSpread(el.expression, model, options, depth + 1, allowImports);
      if (inner === null) return null;
      out.push(...inner);
    } else {
      return null;
    }
  }
  return out;
}

function evalSpread(
  expr: ts.Expression,
  model: FileModel,
  options: ExtractOptions,
  depth: number,
  allowImports: boolean,
): string[] | null {
  if (depth > 8 || !ts.isIdentifier(expr)) return null;
  const local = model.constArrays.get(expr.text);
  if (local !== undefined) return evalArrayLiteral(local, model, options, depth, allowImports);
  if (!allowImports) return null;
  const imp = model.imports.get(expr.text);
  if (imp === undefined || !imp.specifier.startsWith(".") || options.readImport === undefined) {
    return null;
  }
  const resolved = options.readImport(imp.specifier);
  if (resolved === null) return null;
  const remote = buildModel(resolved.text, resolved.fileName);
  const remoteArr = remote.constArrays.get(imp.importedName);
  if (remoteArr === undefined) return null;
  return evalArrayLiteral(remoteArr, remote, options, depth, false);
}

function literalString(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function propertyNamed(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) &&
      prop.name.text === name
    ) {
      return prop;
    }
  }
  return undefined;
}

function extractUses(
  call: ts.CallExpression,
  model: FileModel,
  options: ExtractOptions,
): Pick<ExtractedDeclaration, "uses" | "allowTransitive" | "skipVerify" | "optionsOpenEnd" | "optionsPropertyCount" | "usesPropertyStart"> {
  const second = call.arguments[1];
  const hasOptions = second !== undefined && ts.isObjectLiteralExpression(second);
  if (!hasOptions) {
    return {
      uses: { kind: "none" },
      allowTransitive: [],
      skipVerify: null,
      optionsOpenEnd: null,
      optionsPropertyCount: 0,
      usesPropertyStart: null,
    };
  }
  const obj = second;
  const base = {
    optionsOpenEnd: obj.getStart(model.sourceFile) + 1,
    optionsPropertyCount: obj.properties.length,
  };
  const skipProp = propertyNamed(obj, "skipVerify");
  const skipVerify = skipProp === undefined ? null : literalString(skipProp.initializer);
  const allowProp = propertyNamed(obj, "allowTransitive");
  let allowTransitive: string[] | null = [];
  if (allowProp !== undefined) {
    allowTransitive =
      ts.isArrayLiteralExpression(allowProp.initializer)
        ? evalArrayLiteral(allowProp.initializer, model, options, 0, false)
        : null;
  }
  const usesProp = propertyNamed(obj, "uses");
  if (usesProp === undefined) {
    return { ...base, uses: { kind: "missing" }, allowTransitive, skipVerify, usesPropertyStart: null };
  }
  const usesPropertyStart = usesProp.getStart(model.sourceFile);
  const init = usesProp.initializer;
  if (!ts.isArrayLiteralExpression(init)) {
    return {
      ...base,
      uses: { kind: "non-literal", text: init.getText(model.sourceFile) },
      allowTransitive,
      skipVerify,
      usesPropertyStart,
    };
  }
  return {
    ...base,
    uses: extractUsesArray(init, model, options),
    allowTransitive,
    skipVerify,
    usesPropertyStart,
  };
}

function extractUsesArray(
  init: ts.ArrayLiteralExpression,
  model: FileModel,
  options: ExtractOptions,
): ExtractedUses {
  const literals: string[] = [];
  const spreads: ExtractedSpread[] = [];
  let hasNonLiteralElement = false;
  for (const el of init.elements) {
    const lit = literalString(el);
    if (lit !== null) {
      literals.push(lit);
    } else if (ts.isSpreadElement(el)) {
      spreads.push({
        text: el.expression.getText(model.sourceFile),
        symbols: evalSpread(el.expression, model, options, 0, true),
      });
    } else {
      hasNonLiteralElement = true;
    }
  }
  return {
    kind: "array",
    literals,
    spreads,
    hasNonLiteralElement,
    start: init.getStart(model.sourceFile),
    end: init.end,
  };
}

function calleeBaseName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "only" &&
    ts.isIdentifier(callee.expression)
  ) {
    return callee.expression.text;
  }
  return null;
}

function extractCypressDeclarations(
  model: FileModel,
  options: ExtractOptions,
): ExtractedDeclaration[] {
  const out: ExtractedDeclaration[] = [];
  const usesName = model.cypressUsesName;
  const findUsesCall = (root: ts.Node): ts.CallExpression | null => {
    let found: ts.CallExpression | null = null;
    const scan = (node: ts.Node): void => {
      if (found !== null) return;
      if (
        ts.isCallExpression(node) &&
        usesName !== null &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === usesName
      ) {
        found = node;
        return;
      }
      node.forEachChild(scan);
    };
    scan(root);
    return found;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const base = calleeBaseName(node);
      const first = node.arguments[0];
      const title = first === undefined ? null : literalString(first);
      if ((base === "it" || base === "test") && title !== null && first !== undefined) {
        const callback = node.arguments[node.arguments.length - 1];
        if (
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          callback.body !== undefined &&
          ts.isBlock(callback.body)
        ) {
          const usesCall = findUsesCall(callback.body);
          let uses: ExtractedUses = { kind: "none" };
          let usesPropertyStart: number | null = null;
          if (usesCall !== null) {
            usesPropertyStart = usesCall.getStart(model.sourceFile);
            const arg = usesCall.arguments[0];
            uses =
              arg !== undefined && ts.isArrayLiteralExpression(arg)
                ? extractUsesArray(arg, model, options)
                : {
                    kind: "non-literal",
                    text: arg?.getText(model.sourceFile) ?? "(no argument)",
                  };
          }
          out.push({
            title,
            uses,
            allowTransitive: [],
            skipVerify: null,
            titleEnd: first.end,
            optionsOpenEnd: null,
            optionsPropertyCount: 0,
            callStart: node.getStart(model.sourceFile),
            usesPropertyStart,
            cypress: {
              bodyOpenEnd: callback.body.getStart(model.sourceFile) + 1,
              usesName,
            },
          });
          return;
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(model.sourceFile);
  return out;
}

/**
 * Extract every vibehard declaration with a literal title for the
 * requested (or auto-detected) framework shape: Playwright/Puppeteer
 * options-object calls, or Cypress `it(...)` + `uses([...])` calls.
 */
export function extractDeclarations(
  text: string,
  fileName: string,
  options: ExtractOptions = {},
): ExtractedDeclaration[] {
  const model = buildModel(text, fileName);
  const framework =
    options.framework ??
    (model.testName !== null
      ? "playwright"
      : model.puppeteerTestNames.size > 0
        ? "puppeteer"
        : model.cypressUsesName !== null
          ? "cypress"
          : null);
  if (framework === null) return [];
  if (framework === "cypress") return extractCypressDeclarations(model, options);
  const testNames =
    framework === "playwright"
      ? new Set(model.testName === null ? [] : [model.testName])
      : model.puppeteerTestNames;
  if (testNames.size === 0) return [];
  const out: ExtractedDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const base = calleeBaseName(node);
      const first = node.arguments[0];
      if (base !== null && testNames.has(base) && first !== undefined) {
        const title = literalString(first);
        if (title !== null) {
          out.push({
            title,
            titleEnd: first.end,
            callStart: node.getStart(model.sourceFile),
            ...extractUses(node, model, options),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(model.sourceFile);
  return out;
}

function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match?.[0] ?? "";
}

function quoteSymbol(id: string): string {
  return `'${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function formatUsesArray(
  literals: readonly string[],
  spreadTexts: readonly string[],
  opts: { multiline: boolean; baseIndent: string; eol: string },
): string {
  const elements = [
    ...spreadTexts.map((t) => `...${t}`),
    ...literals.map(quoteSymbol),
  ];
  if (elements.length === 0) return "[]";
  if (!opts.multiline) return `[${elements.join(", ")}]`;
  const elemIndent = `${opts.baseIndent}  `;
  return `[${opts.eol}${elements.map((e) => `${elemIndent}${e},`).join(opts.eol)}${opts.eol}${opts.baseIndent}]`;
}

export interface RewriteResult {
  text: string;
  changed: boolean;
  /** Symbols contributed by preserved spreads. */
  spreadSymbols: string[];
  /** Full declared set after the rewrite (literals + spreads). */
  finalDeclared: string[];
}

/**
 * Rewrite one test's declaration in place so its literal `uses` entries
 * equal `newUses` minus whatever preserved spreads already contribute.
 * Throws `CodemodError` (file untouched) when the declaration shape
 * cannot be rewritten safely.
 */
export function rewriteDeclaration(
  text: string,
  fileName: string,
  title: string,
  newUses: readonly string[],
  options: ExtractOptions = {},
): RewriteResult {
  const declarations = extractDeclarations(text, fileName, options);
  const matches = declarations.filter((d) => d.title === title);
  if (matches.length === 0) {
    throw new CodemodError(
      `test "${title}" not found in ${fileName} (record needs a literal title on a vibehard test call)`,
    );
  }
  if (matches.length > 1) {
    throw new CodemodError(`multiple tests titled "${title}" in ${fileName}; rename one so record can target it`);
  }
  const decl = matches[0] as ExtractedDeclaration;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const callIndent = lineIndentAt(text, decl.callStart);
  const sortedNew = [...new Set(newUses)].sort();

  if (decl.uses.kind === "non-literal") {
    throw new CodemodError(
      `test "${title}" in ${fileName}: uses is not an array literal (${decl.uses.text}); record left it untouched`,
    );
  }

  if (decl.cypress !== undefined) {
    const usesName = decl.cypress.usesName ?? "uses";
    const withImport = (body: string): string =>
      decl.cypress?.usesName === null || decl.cypress?.usesName === undefined
        ? `import { uses } from 'vibehard/cypress';${eol}${body}`
        : body;
    if (decl.uses.kind === "none" || decl.uses.kind === "missing") {
      const inner = `${callIndent}  `;
      const arr = formatUsesArray(sortedNew, [], { multiline: true, baseIndent: inner, eol });
      const insert = `${eol}${inner}${usesName}(${arr});`;
      const edited =
        text.slice(0, decl.cypress.bodyOpenEnd) + insert + text.slice(decl.cypress.bodyOpenEnd);
      const next = withImport(edited);
      return { text: next, changed: next !== text, spreadSymbols: [], finalDeclared: sortedNew };
    }
    const cyUses = decl.uses;
    if (cyUses.hasNonLiteralElement) {
      throw new CodemodError(
        `test "${title}" in ${fileName}: uses array contains a non-string element; record left it untouched`,
      );
    }
    const cySpreadSymbols: string[] = [];
    for (const spread of cyUses.spreads) {
      if (spread.symbols === null) {
        throw new CodemodError(
          `test "${title}" in ${fileName}: cannot statically evaluate spread ...${spread.text} in uses; record left it untouched`,
        );
      }
      cySpreadSymbols.push(...spread.symbols);
    }
    const cySpreadSet = new Set(cySpreadSymbols);
    const cyLiterals = sortedNew.filter((id) => !cySpreadSet.has(id));
    const cyExisting = text.slice(cyUses.start, cyUses.end);
    const cyBaseIndent =
      decl.usesPropertyStart !== null ? lineIndentAt(text, decl.usesPropertyStart) : callIndent;
    const cyArr = formatUsesArray(
      cyLiterals,
      cyUses.spreads.map((s) => s.text),
      { multiline: cyExisting.includes("\n"), baseIndent: cyBaseIndent, eol },
    );
    const next = withImport(text.slice(0, cyUses.start) + cyArr + text.slice(cyUses.end));
    return {
      text: next,
      changed: next !== text,
      spreadSymbols: [...cySpreadSet].sort(),
      finalDeclared: [...new Set([...cyLiterals, ...cySpreadSet])].sort(),
    };
  }

  if (decl.uses.kind === "none") {
    const arr = formatUsesArray(sortedNew, [], {
      multiline: true,
      baseIndent: `${callIndent}  `,
      eol,
    });
    const insert = `, {${eol}${callIndent}  uses: ${arr},${eol}${callIndent}}`;
    const next = text.slice(0, decl.titleEnd) + insert + text.slice(decl.titleEnd);
    return { text: next, changed: next !== text, spreadSymbols: [], finalDeclared: sortedNew };
  }

  if (decl.uses.kind === "missing") {
    const openEnd = decl.optionsOpenEnd ?? decl.titleEnd;
    const inner = `${callIndent}  `;
    const arr = formatUsesArray(sortedNew, [], { multiline: true, baseIndent: inner, eol });
    const insert =
      decl.optionsPropertyCount === 0
        ? `${eol}${inner}uses: ${arr},${eol}${callIndent}`
        : `${eol}${inner}uses: ${arr},`;
    const next = text.slice(0, openEnd) + insert + text.slice(openEnd);
    return { text: next, changed: next !== text, spreadSymbols: [], finalDeclared: sortedNew };
  }

  const uses = decl.uses;
  if (uses.hasNonLiteralElement) {
    throw new CodemodError(
      `test "${title}" in ${fileName}: uses array contains a non-string element; record left it untouched`,
    );
  }
  const spreadSymbols: string[] = [];
  for (const spread of uses.spreads) {
    if (spread.symbols === null) {
      throw new CodemodError(
        `test "${title}" in ${fileName}: cannot statically evaluate spread ...${spread.text} in uses; record left it untouched`,
      );
    }
    spreadSymbols.push(...spread.symbols);
  }
  const spreadSet = new Set(spreadSymbols);
  const desiredLiterals = sortedNew.filter((id) => !spreadSet.has(id));
  const existing = text.slice(uses.start, uses.end);
  const baseIndent =
    decl.usesPropertyStart !== null ? lineIndentAt(text, decl.usesPropertyStart) : callIndent;
  const arr = formatUsesArray(
    desiredLiterals,
    uses.spreads.map((s) => s.text),
    { multiline: existing.includes("\n"), baseIndent, eol },
  );
  const next = text.slice(0, uses.start) + arr + text.slice(uses.end);
  return {
    text: next,
    changed: next !== text,
    spreadSymbols: [...spreadSet].sort(),
    finalDeclared: [...new Set([...desiredLiterals, ...spreadSet])].sort(),
  };
}
