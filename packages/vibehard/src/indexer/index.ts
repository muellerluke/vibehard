import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";

import type { SymbolKind, SymbolRecord } from "../index.js";

/** Bump when extraction rules change; part of every cache key. */
export const INDEXER_VERSION = 3;

const ROUTE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export interface IndexDiagnostic {
  /** POSIX path relative to the indexed root, or null for config-level errors. */
  file: string | null;
  message: string;
  code: number;
}

export interface IndexStats {
  filesTotal: number;
  /** Files whose AST was walked (cache misses). */
  filesParsed: number;
  cacheHits: number;
}

export interface IndexCacheEntry {
  contentHash: string;
  symbols: SymbolRecord[];
}

/** Serializable per-file cache, keyed by POSIX-relative file path. */
export interface IndexCache {
  version: 2;
  entries: Record<string, IndexCacheEntry>;
}

export interface IndexOptions {
  /** Defaults to the tsconfig.json found from the root, else built-in defaults. */
  tsconfigPath?: string;
  /**
   * Cache to read and update in place. A cache with a mismatched version is
   * ignored and a fresh one is returned in the result.
   */
  cache?: IndexCache | null;
}

export interface IndexResult {
  /** Absolute path of the indexed root. */
  rootDir: string;
  /** All symbol records, sorted by ID. */
  symbols: SymbolRecord[];
  /** Resolved app-file import edges per indexed file (possibly empty). */
  imports: Map<string, string[]>;
  /** Config/syntax problems. Indexing never throws on type errors. */
  diagnostics: IndexDiagnostic[];
  stats: IndexStats;
  /** The cache used (updated in place), or a fresh one; null if not requested. */
  cache: IndexCache | null;
}

export function createIndexCache(): IndexCache {
  return { version: 2, entries: {} };
}

/**
 * Index a project: build the symbol table and import graph for every
 * TS/TSX/JS/JSX file under `rootDir` that the project's tsconfig includes.
 * Throws only when `rootDir` does not exist.
 */
export async function indexProject(
  rootDir: string,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const root = path.resolve(rootDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`vibehard indexer: root directory not found: ${rootDir}`);
  }

  const tsApi = loadTypeScript(root);
  const { fileNames, compilerOptions, diagnostics: loadDiagnostics } =
    loadProgramInputs(tsApi, root, options.tsconfigPath);
  const program = tsApi.createProgram({
    rootNames: fileNames,
    options: compilerOptions,
  });

  const cache =
    options.cache === undefined || options.cache === null
      ? null
      : options.cache.version === 2
        ? options.cache
        : createIndexCache();

  const stats: IndexStats = { filesTotal: 0, filesParsed: 0, cacheHits: 0 };
  const allSymbols: SymbolRecord[] = [];
  const importEntries: Array<[string, string[]]> = [];
  const sourceFilesByRel = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    const rel = relativePosix(root, sourceFile.fileName);
    if (rel === null || !isIndexablePath(rel)) continue;
    sourceFilesByRel.set(rel, sourceFile);

    stats.filesTotal += 1;
    const hash = contentHash(sourceFile.text);
    const hit = cache?.entries[rel];
    let fileSymbols: SymbolRecord[];
    if (hit !== undefined && hit.contentHash === hash) {
      fileSymbols = hit.symbols;
      stats.cacheHits += 1;
    } else {
      fileSymbols = extractSymbols(tsApi, sourceFile, rel);
      stats.filesParsed += 1;
      if (cache !== null) {
        cache.entries[rel] = { contentHash: hash, symbols: fileSymbols };
      }
    }
    allSymbols.push(...fileSymbols);
    importEntries.push([
      rel,
      resolvedImportEdges(tsApi, sourceFile, compilerOptions, root),
    ]);
  }

  const deduped = dedupeAndSort(allSymbols);
  const assets = collectAssetSymbols(tsApi, sourceFilesByRel, root);
  for (const asset of assets) {
    if (!deduped.some((s) => s.id === asset.id)) deduped.push(asset);
  }
  deduped.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  computeReferences(tsApi, program, sourceFilesByRel, deduped, root);

  return {
    rootDir: root,
    symbols: deduped,
    imports: new Map(
      importEntries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    diagnostics: collectDiagnostics(tsApi, program, loadDiagnostics, root),
    stats,
    cache,
  };
}

/**
 * Return the smallest symbol in `file` that fully contains the range
 * `[startOffset, endOffset)`, or null when nothing contains it (anonymous
 * code is attributed to its enclosing named symbol; a range outside every
 * named symbol and a partially overlapping range both yield null).
 */
export function findEnclosingSymbol(
  symbols: readonly SymbolRecord[],
  file: string,
  startOffset: number,
  endOffset: number,
): SymbolRecord | null {
  if (startOffset > endOffset) return null;
  let best: SymbolRecord | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const symbol of symbols) {
    if (symbol.file !== file) continue;
    // The whole-file `module` symbol contains everything; it is a
    // fallback for callers that ask for it explicitly, never the
    // answer here (observer host detection depends on null-outside).
    if (symbol.kind === "module") continue;
    if (symbol.startOffset > startOffset || endOffset > symbol.endOffset) {
      continue;
    }
    const size = symbol.endOffset - symbol.startOffset;
    if (size < bestSize) {
      best = symbol;
      bestSize = size;
    }
  }
  return best;
}

/**
 * Parse-only per-file extraction: the same `extractSymbols` used by
 * `indexProject`, fed from `ts.createSourceFile` instead of a Program.
 * Selection uses this so its cost stays proportional to the files it
 * actually needs; `indexProject` remains the implementation of record
 * for building touched sets (it alone computes `references`).
 */
export interface ParsedFile {
  /** `extractSymbols` output for the file (pre-dedupe, no references). */
  symbols: SymbolRecord[];
  /** Project-relative POSIX paths of assets this file imports. */
  assetFiles: string[];
}

export interface ProjectParser {
  readonly typescriptVersion: string;
  /** Parse one file's text (never reads disk). */
  parseFile(relPosix: string, text: string): ParsedFile;
}

/** Create a parser bound to the target project's own TypeScript copy. */
export function createProjectParser(rootDir: string): ProjectParser {
  const tsApi = loadTypeScript(path.resolve(rootDir));
  return {
    typescriptVersion: tsApi.version,
    parseFile(relPosix: string, text: string): ParsedFile {
      const sourceFile = tsApi.createSourceFile(
        relPosix,
        text,
        tsApi.ScriptTarget.Latest,
        true,
        scriptKindForFile(tsApi, relPosix),
      );
      return {
        symbols: extractSymbols(tsApi, sourceFile, relPosix),
        assetFiles: assetFilesInFile(tsApi, sourceFile, relPosix),
      };
    },
  };
}

function scriptKindForFile(tsApi: typeof ts, relPosix: string): ts.ScriptKind {
  if (/\.tsx$/i.test(relPosix)) return tsApi.ScriptKind.TSX;
  if (/\.jsx$/i.test(relPosix)) return tsApi.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(relPosix)) return tsApi.ScriptKind.JS;
  return tsApi.ScriptKind.TS;
}

/**
 * The tsconfig-included file list (POSIX, project-relative, indexable
 * only), without constructing a Program. This is the set
 * `parseJsonConfigFileContent` reports; files a Program would pull in
 * transitively through imports are not listed.
 */
export function loadProjectFileList(rootDir: string, tsconfigPath?: string): string[] {
  const root = path.resolve(rootDir);
  const tsApi = loadTypeScript(root);
  const { fileNames } = loadProgramInputs(tsApi, root, tsconfigPath);
  const out = new Set<string>();
  for (const fileName of fileNames) {
    const rel = relativePosix(root, fileName);
    if (rel !== null && isIndexablePath(rel)) out.add(rel);
  }
  return [...out].sort();
}

/** True for files the indexer treats as app source (TS/JS, no `.d.ts`). */
export function isIndexableFile(relPosix: string): boolean {
  return isIndexablePath(relPosix);
}

/** Dedupe by symbol ID (earliest in source order wins), sorted by ID. */
export function dedupeSymbols(symbols: readonly SymbolRecord[]): SymbolRecord[] {
  return dedupeAndSort([...symbols]);
}

/** Build the `<file>` asset record for one asset path. */
export function makeAssetRecord(
  relPosix: string,
  byteLength: number,
  lineCount: number,
): SymbolRecord {
  return {
    id: `${relPosix}#<file>`,
    file: relPosix,
    qualifiedName: "<file>",
    kind: "asset",
    startOffset: 0,
    endOffset: byteLength,
    startLine: 1,
    endLine: Math.max(1, lineCount),
    references: [],
  };
}

/** Prefer the target project's own TypeScript copy; fall back to ours. */
function loadTypeScript(rootDir: string): typeof ts {
  try {
    const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
    return requireFromRoot("typescript") as typeof ts;
  } catch {
    return ts;
  }
}

interface ProgramInputs {
  fileNames: string[];
  compilerOptions: ts.CompilerOptions;
  diagnostics: ts.Diagnostic[];
}

function loadProgramInputs(
  tsApi: typeof ts,
  root: string,
  tsconfigPath?: string,
): ProgramInputs {
  const configPath =
    tsconfigPath !== undefined
      ? path.resolve(tsconfigPath)
      : tsApi.findConfigFile(root, tsApi.sys.fileExists, "tsconfig.json");

  if (configPath !== undefined && existsSync(configPath)) {
    const read = tsApi.readConfigFile(configPath, tsApi.sys.readFile);
    const diagnostics: ts.Diagnostic[] =
      read.error !== undefined ? [read.error] : [];
    const parsed = tsApi.parseJsonConfigFileContent(
      read.config ?? {},
      tsApi.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    return {
      fileNames: parsed.fileNames,
      compilerOptions: parsed.options,
      diagnostics: [...diagnostics, ...parsed.errors],
    };
  }

  // No tsconfig: defaults mirroring tsconfig.base.json, plus allowJs so
  // plain-JS projects index without any configuration.
  const parsed = tsApi.parseJsonConfigFileContent(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        jsx: "react-jsx",
        strict: true,
        allowJs: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        isolatedModules: true,
      },
      include: ["**/*"],
    },
    tsApi.sys,
    root,
  );
  return {
    fileNames: parsed.fileNames,
    compilerOptions: parsed.options,
    diagnostics: [...parsed.errors],
  };
}

function collectDiagnostics(
  tsApi: typeof ts,
  program: ts.Program,
  loadDiagnostics: readonly ts.Diagnostic[],
  root: string,
): IndexDiagnostic[] {
  const seen = new Set<string>();
  const out: IndexDiagnostic[] = [];
  const all: readonly ts.Diagnostic[] = [
    ...loadDiagnostics,
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getSyntacticDiagnostics(),
  ];
  for (const diagnostic of all) {
    if (
      diagnostic.file !== undefined &&
      relativePosix(root, diagnostic.file.fileName) === null
    ) {
      continue;
    }
    const converted: IndexDiagnostic = {
      file:
        diagnostic.file !== undefined
          ? relativePosix(root, diagnostic.file.fileName)
          : null,
      message: tsApi.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      code: diagnostic.code,
    };
    const key = `${converted.file ?? ""}|${converted.code}|${converted.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(converted);
  }
  return out;
}

interface ExtractCtx {
  tsApi: typeof ts;
  sourceFile: ts.SourceFile;
  rel: string;
  isRouteFile: boolean;
  isPageFile: boolean;
  out: SymbolRecord[];
  /** Identifier named by a top-level `export default <ident>;`. */
  defaultExportName: string | null;
}

function extractSymbols(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  rel: string,
): SymbolRecord[] {
  const stem = fileStem(rel);
  const ctx: ExtractCtx = {
    tsApi,
    sourceFile,
    rel,
    isRouteFile: stem === "route",
    isPageFile: stem === "page" || stem === "layout",
    out: [],
    defaultExportName: null,
  };
  walkStatements(ctx, sourceFile.statements, "", true);

  // `const Page = () => ...; export default Page;` in a page/layout file.
  if (ctx.isPageFile && ctx.defaultExportName !== null) {
    for (const record of ctx.out) {
      if (record.qualifiedName === ctx.defaultExportName) {
        record.kind = "page-export";
      }
    }
  }

  // One module symbol per file covering leftover top-level lines
  // (imports, expression statements, type-only declarations). Its range
  // spans the file so any line not in a smaller symbol still maps; its
  // hash covers only the leftover statement slices.
  const hashSlices: { startOffset: number; endOffset: number }[] = [];
  collectModuleHashSlices(ctx, sourceFile.statements, hashSlices);
  const moduleRecord = makeRecord(tsApi, sourceFile, rel, sourceFile, "<module>", "module");
  moduleRecord.startOffset = 0;
  moduleRecord.endOffset = sourceFile.text.length;
  moduleRecord.startLine = 1;
  moduleRecord.endLine =
    sourceFile.getLineAndCharacterOfPosition(Math.max(0, sourceFile.text.length - 1)).line + 1;
  moduleRecord.hashSlices = hashSlices;
  ctx.out.push(moduleRecord);
  return ctx.out;
}

function collectModuleHashSlices(
  ctx: ExtractCtx,
  statements: readonly ts.Statement[],
  slices: { startOffset: number; endOffset: number }[],
): void {
  const { tsApi, sourceFile } = ctx;
  for (const stmt of statements) {
    if (
      tsApi.isFunctionDeclaration(stmt) ||
      tsApi.isClassDeclaration(stmt) ||
      tsApi.isVariableStatement(stmt) ||
      tsApi.isExportAssignment(stmt) ||
      tsApi.isEnumDeclaration(stmt)
    ) {
      continue;
    }
    if (tsApi.isModuleDeclaration(stmt)) {
      // Namespace members carry their own symbols; only leftover
      // statements inside the namespace belong to the module hash.
      if (stmt.body !== undefined && tsApi.isModuleBlock(stmt.body)) {
        collectModuleHashSlices(ctx, stmt.body.statements, slices);
      } else if (stmt.body !== undefined && tsApi.isModuleDeclaration(stmt.body)) {
        collectModuleHashSlices(ctx, [stmt.body], slices);
      }
      continue;
    }
    slices.push({ startOffset: stmt.getStart(sourceFile), endOffset: stmt.getEnd() });
  }
}

/**
 * Walk one declaration scope (a source file or a namespace block),
 * emitting a symbol for every named declaration. Function bodies and
 * bare blocks are not scopes: locals fold into their enclosing
 * executable symbol.
 */
function walkStatements(
  ctx: ExtractCtx,
  statements: readonly ts.Statement[],
  prefix: string,
  topLevel: boolean,
): void {
  const { tsApi, sourceFile, rel } = ctx;
  for (const stmt of statements) {
    if (tsApi.isFunctionDeclaration(stmt)) {
      if (stmt.body === undefined) continue; // overload signature
      const isDefault = hasModifier(tsApi, stmt, tsApi.SyntaxKind.DefaultKeyword);
      if (stmt.name === undefined && !isDefault) continue;
      const name = stmt.name?.text ?? "default";
      let kind: SymbolKind = "function";
      if (topLevel && isDefault && ctx.isPageFile) {
        kind = "page-export";
      } else if (
        topLevel &&
        ctx.isRouteFile &&
        hasModifier(tsApi, stmt, tsApi.SyntaxKind.ExportKeyword) &&
        ROUTE_METHODS.has(name)
      ) {
        kind = "route-export";
      }
      ctx.out.push(makeRecord(tsApi, sourceFile, rel, stmt, `${prefix}${name}`, kind));
    } else if (tsApi.isClassDeclaration(stmt)) {
      const isDefault = hasModifier(tsApi, stmt, tsApi.SyntaxKind.DefaultKeyword);
      const className = stmt.name?.text ?? (isDefault ? "default" : null);
      if (className === null) continue;
      emitClass(ctx, stmt, `${prefix}${className}`);
    } else if (tsApi.isVariableStatement(stmt)) {
      const exported = hasModifier(tsApi, stmt, tsApi.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        emitVariableDeclaration(ctx, decl, prefix, topLevel, exported);
      }
    } else if (tsApi.isEnumDeclaration(stmt)) {
      ctx.out.push(
        makeRecord(tsApi, sourceFile, rel, stmt, `${prefix}${stmt.name.text}`, "value"),
      );
    } else if (tsApi.isModuleDeclaration(stmt)) {
      walkModuleDeclaration(ctx, stmt, prefix);
    } else if (tsApi.isExportAssignment(stmt)) {
      if (topLevel) emitExportAssignment(ctx, stmt);
    } else if (tsApi.isExpressionStatement(stmt)) {
      emitAssignment(ctx, stmt, prefix);
    }
  }
}

function walkModuleDeclaration(
  ctx: ExtractCtx,
  decl: ts.ModuleDeclaration,
  prefix: string,
): void {
  const { tsApi } = ctx;
  if (!tsApi.isIdentifier(decl.name)) return; // ambient `declare module "x"`
  if (decl.body === undefined) return;
  const childPrefix = `${prefix}${decl.name.text}.`;
  if (tsApi.isModuleBlock(decl.body)) {
    walkStatements(ctx, decl.body.statements, childPrefix, false);
  } else if (tsApi.isModuleDeclaration(decl.body)) {
    walkModuleDeclaration(ctx, decl.body, childPrefix);
  }
}

function emitExportAssignment(ctx: ExtractCtx, stmt: ts.ExportAssignment): void {
  const { tsApi } = ctx;
  if (stmt.isExportEquals) return;
  const expr = unwrapExpression(tsApi, stmt.expression);
  if (tsApi.isIdentifier(expr)) {
    // Already recorded at its declaration; remember for page fix-up.
    ctx.defaultExportName = expr.text;
    return;
  }
  const qualified =
    (tsApi.isFunctionExpression(expr) || tsApi.isClassExpression(expr)
      ? expr.name?.text
      : undefined) ?? "default";
  emitInitializer(ctx, qualified, stmt, expr, (isArrow) =>
    ctx.isPageFile ? "page-export" : isArrow ? "arrow-function" : "function",
  );
}

function emitVariableDeclaration(
  ctx: ExtractCtx,
  decl: ts.VariableDeclaration,
  prefix: string,
  topLevel: boolean,
  exported: boolean,
): void {
  const { tsApi, sourceFile, rel } = ctx;
  if (!tsApi.isIdentifier(decl.name)) {
    emitBindingPattern(ctx, decl.name, prefix);
    return;
  }
  const name = decl.name.text;
  if (decl.initializer === undefined) {
    ctx.out.push(makeRecord(tsApi, sourceFile, rel, decl, `${prefix}${name}`, "value"));
    return;
  }
  emitInitializer(ctx, `${prefix}${name}`, decl, decl.initializer, (isArrow) =>
    topLevel && exported && ctx.isRouteFile && ROUTE_METHODS.has(name)
      ? "route-export"
      : isArrow
        ? "arrow-function"
        : "function",
  );
}

/**
 * One `value` symbol per identifier bound by a destructuring pattern
 * (a function symbol when the element's default is a function). The
 * shared initializer belongs to no single binding; its execution
 * attributes to the enclosing scope through the module fallback.
 */
function emitBindingPattern(
  ctx: ExtractCtx,
  pattern: ts.BindingPattern,
  prefix: string,
): void {
  const { tsApi, sourceFile, rel } = ctx;
  for (const element of pattern.elements) {
    if (!tsApi.isBindingElement(element)) continue; // array hole
    if (tsApi.isIdentifier(element.name)) {
      let kind: SymbolKind = "value";
      if (element.initializer !== undefined) {
        const init = unwrapExpression(tsApi, element.initializer);
        if (tsApi.isArrowFunction(init)) kind = "arrow-function";
        else if (tsApi.isFunctionExpression(init)) kind = "function";
      }
      ctx.out.push(
        makeRecord(tsApi, sourceFile, rel, element, `${prefix}${element.name.text}`, kind),
      );
    } else {
      emitBindingPattern(ctx, element.name, prefix);
    }
  }
}

/**
 * Emit the symbol(s) for one named position with an initializer: a
 * variable binding, a class field, an object property, an assignment
 * target, or a default export. Functions take `fnKind`; classes emit
 * their class symbol and members; object literals (including ones
 * returned directly by an IIFE/factory callee) emit a `value` plus
 * per-member symbols; everything else is one `value`.
 */
function emitInitializer(
  ctx: ExtractCtx,
  qualified: string,
  node: ts.Node,
  initializer: ts.Expression,
  fnKind: (isArrow: boolean) => SymbolKind,
): void {
  const { tsApi, sourceFile, rel } = ctx;
  const init = unwrapExpression(tsApi, initializer);
  if (tsApi.isArrowFunction(init) || tsApi.isFunctionExpression(init)) {
    ctx.out.push(
      makeRecord(tsApi, sourceFile, rel, node, qualified, fnKind(tsApi.isArrowFunction(init))),
    );
    return;
  }
  if (tsApi.isClassExpression(init)) {
    emitClass(ctx, init, qualified);
    return;
  }
  if (tsApi.isObjectLiteralExpression(init)) {
    ctx.out.push(makeRecord(tsApi, sourceFile, rel, node, qualified, "value"));
    extractObjectMembers(ctx, init, qualified);
    return;
  }
  const factory = factoryObjectLiteral(tsApi, init);
  if (factory !== null) {
    ctx.out.push(makeRecord(tsApi, sourceFile, rel, node, qualified, "value"));
    extractObjectMembers(ctx, factory, qualified);
    return;
  }
  ctx.out.push(makeRecord(tsApi, sourceFile, rel, node, qualified, "value"));
}

/**
 * The object literal an IIFE/factory call directly returns, if any:
 * `(() => ({ ... }))()`, `(() => { return { ... }; })()`.
 */
function factoryObjectLiteral(
  tsApi: typeof ts,
  expr: ts.Expression,
): ts.ObjectLiteralExpression | null {
  let current = expr;
  if (tsApi.isAwaitExpression(current)) {
    current = unwrapExpression(tsApi, current.expression);
  }
  if (!tsApi.isCallExpression(current)) return null;
  const callee = unwrapExpression(tsApi, current.expression);
  if (!tsApi.isArrowFunction(callee) && !tsApi.isFunctionExpression(callee)) return null;
  if (tsApi.isBlock(callee.body)) {
    if (callee.body.statements.length !== 1) return null;
    const only = callee.body.statements[0];
    if (only === undefined || !tsApi.isReturnStatement(only) || only.expression === undefined) {
      return null;
    }
    const returned = unwrapExpression(tsApi, only.expression);
    return tsApi.isObjectLiteralExpression(returned) ? returned : null;
  }
  const returned = unwrapExpression(tsApi, callee.body);
  return tsApi.isObjectLiteralExpression(returned) ? returned : null;
}

/**
 * Emit a class symbol plus one symbol per named member. The class
 * symbol's range spans the whole class (containment), but its hash
 * slices cover only the header — decorators, name, type parameters,
 * heritage — and any static blocks, so member edits do not churn it.
 * Static blocks are nameless and fold into the class symbol.
 *
 * Member IDs are always disambiguated from the member alone, never
 * from its siblings: statics live under `.static.`, accessors take a
 * `:get`/`:set` suffix (combined as `Cart.static.#x:get`).
 */
function emitClass(
  ctx: ExtractCtx,
  cls: ts.ClassDeclaration | ts.ClassExpression,
  qualified: string,
): void {
  const { tsApi, sourceFile, rel } = ctx;
  const classRecord = makeRecord(tsApi, sourceFile, rel, cls, qualified, "class");
  const slices = [{ startOffset: classRecord.startOffset, endOffset: classHeaderEnd(ctx, cls) }];
  for (const member of cls.members) {
    if (tsApi.isClassStaticBlockDeclaration(member)) {
      slices.push({ startOffset: member.getStart(sourceFile), endOffset: member.getEnd() });
    }
  }
  classRecord.hashSlices = slices;
  ctx.out.push(classRecord);

  for (const member of cls.members) {
    const staticPrefix = hasModifier(tsApi, member, tsApi.SyntaxKind.StaticKeyword)
      ? "static."
      : "";
    if (tsApi.isConstructorDeclaration(member)) {
      if (member.body === undefined) continue;
      ctx.out.push(
        makeRecord(tsApi, sourceFile, rel, member, `${qualified}.constructor`, "method"),
      );
    } else if (
      tsApi.isMethodDeclaration(member) ||
      tsApi.isGetAccessorDeclaration(member) ||
      tsApi.isSetAccessorDeclaration(member)
    ) {
      if (member.body === undefined) continue; // abstract or overload signature
      const name = memberName(tsApi, member.name);
      if (name === null) continue;
      const suffix = tsApi.isGetAccessorDeclaration(member)
        ? ":get"
        : tsApi.isSetAccessorDeclaration(member)
          ? ":set"
          : "";
      ctx.out.push(
        makeRecord(
          tsApi,
          sourceFile,
          rel,
          member,
          `${qualified}.${staticPrefix}${name}${suffix}`,
          "method",
        ),
      );
    } else if (tsApi.isPropertyDeclaration(member)) {
      const name = memberName(tsApi, member.name);
      if (name === null) continue;
      const memberQualified = `${qualified}.${staticPrefix}${name}`;
      if (member.initializer === undefined) {
        ctx.out.push(makeRecord(tsApi, sourceFile, rel, member, memberQualified, "value"));
      } else {
        emitInitializer(ctx, memberQualified, member, member.initializer, () => "method");
      }
    }
    // Static blocks, index signatures, and semicolons name no member.
  }
}

/** End offset of the class header (through name/type params/heritage). */
function classHeaderEnd(
  ctx: ExtractCtx,
  cls: ts.ClassDeclaration | ts.ClassExpression,
): number {
  let end = cls.name?.getEnd() ?? 0;
  for (const param of cls.typeParameters ?? []) end = Math.max(end, param.getEnd());
  for (const clause of cls.heritageClauses ?? []) end = Math.max(end, clause.getEnd());
  if (end === 0) {
    const first = cls.members[0];
    end = first !== undefined ? first.getStart(ctx.sourceFile) : cls.getEnd();
  }
  return end;
}

function extractObjectMembers(
  ctx: ExtractCtx,
  obj: ts.ObjectLiteralExpression,
  prefix: string,
): void {
  const { tsApi, sourceFile, rel } = ctx;
  for (const prop of obj.properties) {
    if (
      tsApi.isMethodDeclaration(prop) ||
      tsApi.isGetAccessorDeclaration(prop) ||
      tsApi.isSetAccessorDeclaration(prop)
    ) {
      const name = memberName(tsApi, prop.name);
      if (name === null) continue;
      const suffix = tsApi.isGetAccessorDeclaration(prop)
        ? ":get"
        : tsApi.isSetAccessorDeclaration(prop)
          ? ":set"
          : "";
      ctx.out.push(
        makeRecord(tsApi, sourceFile, rel, prop, `${prefix}.${name}${suffix}`, "object-method"),
      );
    } else if (tsApi.isPropertyAssignment(prop)) {
      const name = memberName(tsApi, prop.name);
      if (name === null) continue;
      emitInitializer(ctx, `${prefix}.${name}`, prop, prop.initializer, () => "object-method");
    } else if (tsApi.isShorthandPropertyAssignment(prop)) {
      ctx.out.push(
        makeRecord(tsApi, sourceFile, rel, prop, `${prefix}.${prop.name.text}`, "value"),
      );
    }
    // Spread assignments name no new declaration.
  }
}

/**
 * A top-level (or namespace-level) `a.b.c = …` assignment names its
 * target: `exports.checkout = () => {}`, `module.exports = { … }`.
 * Plain identifier assignments are not declarations and are ignored.
 */
function emitAssignment(
  ctx: ExtractCtx,
  stmt: ts.ExpressionStatement,
  prefix: string,
): void {
  const { tsApi } = ctx;
  const expr = stmt.expression;
  if (
    !tsApi.isBinaryExpression(expr) ||
    expr.operatorToken.kind !== tsApi.SyntaxKind.EqualsToken
  ) {
    return;
  }
  const target = propertyChainName(tsApi, expr.left);
  if (target === null) return;
  emitInitializer(ctx, `${prefix}${target}`, expr, expr.right, (isArrow) =>
    isArrow ? "arrow-function" : "function",
  );
}

/** `module.exports.checkout` for a property-access chain, else null. */
function propertyChainName(tsApi: typeof ts, expr: ts.Expression): string | null {
  const parts: string[] = [];
  let current: ts.Expression = expr;
  while (tsApi.isPropertyAccessExpression(current)) {
    if (!tsApi.isIdentifier(current.name)) return null;
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (!tsApi.isIdentifier(current) || parts.length === 0) return null;
  parts.unshift(current.text);
  return parts.join(".");
}



function resolvedImportEdges(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  root: string,
): string[] {
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (tsApi.isImportDeclaration(node) || tsApi.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      tsApi.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    } else if (
      tsApi.isCallExpression(node) &&
      node.expression.kind === tsApi.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      tsApi.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    tsApi.forEachChild(node, visit);
  };
  visit(sourceFile);

  const edges = new Set<string>();
  for (const specifier of specifiers) {
    const resolved = tsApi.resolveModuleName(
      specifier,
      sourceFile.fileName,
      compilerOptions,
      tsApi.sys,
    ).resolvedModule;
    if (resolved === undefined || resolved.isExternalLibraryImport) continue;
    const rel = relativePosix(root, resolved.resolvedFileName);
    if (rel === null || !isIndexablePath(rel)) continue;
    edges.add(rel);
  }
  return [...edges].sort();
}

const ASSET_EXTENSIONS = new Set([
  ".json",
  ".css",
  ".scss",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
]);

function isAssetSpecifier(specifier: string): boolean {
  const clean = specifier.split(/[?#]/)[0] ?? specifier;
  const ext = path.posix.extname(clean).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

/** True when a project-relative path has an asset extension. */
export function hasAssetExtension(relPosix: string): boolean {
  return isAssetSpecifier(relPosix);
}

/**
 * Resolve an asset import specifier to a project-relative POSIX path
 * by path math alone (no filesystem access), or null when the
 * specifier is a bare package import or escapes the project root.
 * Mirrors `resolveAssetFile` without its on-disk existence check.
 */
export function resolveAssetSpecifier(fromFileRel: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    // Bare specifiers resolve into packages; only project-relative
    // asset imports become symbols (package changes stay full-run).
    if (!specifier.startsWith("@/")) return null;
  }
  const raw = specifier.split(/[?#]/)[0] ?? specifier;
  let joined: string;
  if (raw.startsWith("@/")) joined = `src/${raw.slice(2)}`;
  else if (raw.startsWith("/")) joined = raw.slice(1);
  else joined = path.posix.join(path.posix.dirname(fromFileRel), raw);
  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0 || segments.includes("node_modules")) return null;
  return segments.join("/");
}

/** `resolveAssetSpecifier` plus an on-disk existence check. */
function resolveAssetFile(
  root: string,
  fromFileRel: string,
  specifier: string,
): string | null {
  const rel = resolveAssetSpecifier(fromFileRel, specifier);
  if (rel === null) return null;
  const abs = path.resolve(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return rel;
}

/** Asset paths imported by one parsed file (sorted, deduplicated). */
function assetFilesInFile(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  rel: string,
): string[] {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    let specifier: string | null = null;
    if (
      (tsApi.isImportDeclaration(node) || tsApi.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      tsApi.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      tsApi.isCallExpression(node) &&
      node.expression.kind === tsApi.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      tsApi.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier !== null && isAssetSpecifier(specifier)) {
      const assetRel = resolveAssetSpecifier(rel, specifier);
      if (assetRel !== null) out.add(assetRel);
    }
    tsApi.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...out].sort();
}

function collectAssetSymbols(
  tsApi: typeof ts,
  sourceFilesByRel: ReadonlyMap<string, ts.SourceFile>,
  root: string,
): SymbolRecord[] {
  const byId = new Map<string, SymbolRecord>();
  for (const [rel, sourceFile] of sourceFilesByRel) {
    for (const assetRel of assetFilesInFile(tsApi, sourceFile, rel)) {
      const id = `${assetRel}#<file>`;
      if (byId.has(id)) continue;
      const abs = path.resolve(root, assetRel);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      let length = 0;
      let lines = 1;
      try {
        const data = readFileSync(abs);
        length = data.length;
        lines = Math.max(1, data.toString("utf8").split("\n").length);
      } catch {
        // existsSync was checked above
      }
      byId.set(id, makeAssetRecord(assetRel, length, lines));
    }
  }
  return [...byId.values()];
}

/** Smallest non-module symbol in `file` fully containing [start, end). */
function smallestContaining(
  symbolsByFile: ReadonlyMap<string, SymbolRecord[]>,
  file: string,
  start: number,
  end: number,
): SymbolRecord | null {
  let best: SymbolRecord | null = null;
  let bestSize = Number.POSITIVE_INFINITY;
  for (const symbol of symbolsByFile.get(file) ?? []) {
    if (symbol.kind === "module" || symbol.kind === "asset") continue;
    if (symbol.startOffset > start || end > symbol.endOffset) continue;
    const size = symbol.endOffset - symbol.startOffset;
    if (size < bestSize) {
      best = symbol;
      bestSize = size;
    }
  }
  return best;
}

/** The element of a binding pattern that binds `name`, searching nested patterns. */
function findBindingElement(
  tsApi: typeof ts,
  pattern: ts.BindingPattern,
  name: string,
): ts.BindingElement | null {
  for (const element of pattern.elements) {
    if (!tsApi.isBindingElement(element)) continue;
    if (tsApi.isIdentifier(element.name)) {
      if (element.name.text === name) return element;
    } else {
      const found = findBindingElement(tsApi, element.name, name);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Resolve every reference inside each symbol to the symbol that
 * declares it, via the TypeChecker: ordinary and private identifiers,
 * literal element accesses (`cart["total"]`), destructured binding
 * targets, and identifiers in decorators and heritage clauses (owned
 * by the class symbol). Module symbols only scan their
 * leftover-statement slices. Imported assets become edges from the
 * importing file's module symbol and from any symbol referencing an
 * imported binding whose declaration cannot be resolved to app code.
 */
function computeReferences(
  tsApi: typeof ts,
  program: ts.Program,
  sourceFilesByRel: ReadonlyMap<string, ts.SourceFile>,
  symbols: SymbolRecord[],
  root: string,
): void {
  let checker: ts.TypeChecker;
  try {
    checker = program.getTypeChecker();
  } catch {
    for (const s of symbols) s.references = s.references ?? [];
    return;
  }
  const symbolsByFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    const list = symbolsByFile.get(s.file) ?? [];
    list.push(s);
    symbolsByFile.set(s.file, list);
  }
  const moduleByFile = new Map<string, SymbolRecord>();
  for (const s of symbols) if (s.kind === "module") moduleByFile.set(s.file, s);

  const declarationSymbol = (
    decl: ts.Declaration,
    symbolName?: string,
  ): SymbolRecord | null => {
    const declFile = decl.getSourceFile();
    const rel = relativePosix(root, declFile.fileName);
    if (rel === null || !isIndexablePath(rel)) return null;
    // A checker declaration for one destructured binding may be the
    // whole shared VariableDeclaration; narrow it to the element that
    // binds this symbol so containment finds the per-binding symbol.
    let rangeNode: ts.Node = decl;
    if (
      tsApi.isVariableDeclaration(decl) &&
      !tsApi.isIdentifier(decl.name) &&
      symbolName !== undefined
    ) {
      rangeNode = findBindingElement(tsApi, decl.name, symbolName) ?? decl;
    }
    const start = rangeNode.getStart(declFile);
    const end = rangeNode.getEnd();
    return (
      smallestContaining(symbolsByFile, rel, start, end) ??
      smallestContaining(symbolsByFile, rel, start, start + 1) ??
      moduleByFile.get(rel) ??
      null
    );
  };

  /**
   * Map a checker symbol to its declaring symbol record, preferring a
   * real declaration over the module fallback (overload signatures
   * and type-only declarations have no symbol and would otherwise
   * shadow the implementation declaration that follows them).
   */
  const symbolToRecord = (sym: ts.Symbol): SymbolRecord | null => {
    let target = sym;
    try {
      if ((sym.flags & tsApi.SymbolFlags.Alias) !== 0) {
        target = checker.getAliasedSymbol(sym);
      }
    } catch {
      target = sym;
    }
    let fallback: SymbolRecord | null = null;
    for (const decl of target.declarations ?? []) {
      const found = declarationSymbol(decl, target.name);
      if (found === null) continue;
      if (found.kind !== "module") return found;
      fallback ??= found;
    }
    return fallback;
  };

  const resolveIdentifier = (
    id: ts.Identifier | ts.PrivateIdentifier,
    fromRel: string,
  ): SymbolRecord | null => {
    let sym: ts.Symbol | undefined;
    try {
      sym = checker.getSymbolAtLocation(id);
    } catch {
      return null;
    }
    if (sym === undefined) return null;
    const found = symbolToRecord(sym);
    if (found !== null && found.kind !== "module") return found;
    // Unresolved declaration (e.g. a JSON import binding): fall back to
    // the original symbol's declarations, then to an asset edge keyed
    // by the import specifier in the referring file.
    for (const decl of sym.declarations ?? []) {
      if (
        tsApi.isImportSpecifier(decl) ||
        tsApi.isImportClause(decl) ||
        tsApi.isNamespaceImport(decl)
      ) {
        let node: ts.Node = decl;
        while (!tsApi.isImportDeclaration(node)) {
          if (node.parent === undefined) break;
          node = node.parent;
        }
        if (tsApi.isImportDeclaration(node) && tsApi.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (isAssetSpecifier(specifier)) {
            const assetRel = resolveAssetFile(root, fromRel, specifier);
            if (assetRel !== null) {
              return symbols.find((s) => s.id === `${assetRel}#<file>`) ?? null;
            }
          }
        }
      }
    }
    return found;
  };

  /** Resolve `obj["prop"]` / `obj[0]` to the accessed property's symbol. */
  const resolveLiteralAccess = (node: ts.ElementAccessExpression): SymbolRecord | null => {
    const arg = node.argumentExpression;
    if (
      !tsApi.isStringLiteral(arg) &&
      !tsApi.isNumericLiteral(arg) &&
      !tsApi.isNoSubstitutionTemplateLiteral(arg)
    ) {
      return null;
    }
    try {
      const objectType = checker.getTypeAtLocation(node.expression);
      const prop = checker.getPropertyOfType(objectType, arg.text);
      return prop === undefined ? null : symbolToRecord(prop);
    } catch {
      return null;
    }
  };

  /**
   * Resolve one object-destructuring element to the property it reads:
   * `const { taxRate } = settings` links the `taxRate` binding to the
   * `settings.taxRate` declaration. Nested patterns resolve through
   * the ordinary identifier edges instead.
   */
  const resolveBindingElement = (element: ts.BindingElement): SymbolRecord | null => {
    const pattern = element.parent;
    if (!tsApi.isObjectBindingPattern(pattern)) return null;
    const propertyName = element.propertyName ?? element.name;
    if (
      !tsApi.isIdentifier(propertyName) &&
      !tsApi.isStringLiteral(propertyName) &&
      !tsApi.isNumericLiteral(propertyName)
    ) {
      return null;
    }
    const decl = pattern.parent;
    if (!tsApi.isVariableDeclaration(decl) || decl.initializer === undefined) return null;
    try {
      const sourceType = checker.getTypeAtLocation(decl.initializer);
      const prop = checker.getPropertyOfType(sourceType, propertyName.text);
      return prop === undefined ? null : symbolToRecord(prop);
    } catch {
      return null;
    }
  };

  for (const [rel, sourceFile] of sourceFilesByRel) {
    const fileSymbols = symbolsByFile.get(rel) ?? [];
    const refsBySymbol = new Map<string, Set<string>>();
    for (const s of fileSymbols) refsBySymbol.set(s.id, new Set(s.references ?? []));

    const attribute = (node: ts.Node): SymbolRecord | null => {
      const start = node.getStart(sourceFile);
      const owner = smallestContaining(symbolsByFile, rel, start, start + 1);
      if (owner !== null) return owner;
      return moduleByFile.get(rel) ?? null;
    };

    const addEdge = (node: ts.Node, target: SymbolRecord | null): void => {
      if (target === null) return;
      const owner = attribute(node);
      if (owner !== null && target.id !== owner.id) {
        refsBySymbol.get(owner.id)?.add(target.id);
      }
    };

    const visit = (node: ts.Node): void => {
      // Import/export binding names are not uses; usage identifiers
      // inside symbols carry the real edges. Descending here would
      // attribute every imported declaration to the module symbol.
      if (tsApi.isImportDeclaration(node) || tsApi.isExportDeclaration(node)) return;
      // Decorators are not reliably reached through forEachChild.
      if (tsApi.canHaveDecorators(node)) {
        for (const decorator of tsApi.getDecorators(node) ?? []) visit(decorator);
      }
      if (tsApi.isIdentifier(node) || tsApi.isPrivateIdentifier(node)) {
        // Declaration names and property names that bind are handled by
        // resolution returning the symbol itself; self-edges dropped.
        // Module owners only claim identifiers inside leftover slices;
        // identifiers inside a named symbol were owned above. A node
        // attributed to module is by construction outside every
        // smaller symbol, which matches the leftover definition.
        addEdge(node, resolveIdentifier(node, rel));
      } else if (tsApi.isElementAccessExpression(node)) {
        addEdge(node, resolveLiteralAccess(node));
      } else if (tsApi.isBindingElement(node)) {
        addEdge(node, resolveBindingElement(node));
      }
      tsApi.forEachChild(node, visit);
    };
    visit(sourceFile);

    // Side-effect and namespace asset imports may name no binding:
    // attribute them to the module symbol.
    const visitImports = (node: ts.Node): void => {
      if (
        tsApi.isImportDeclaration(node) &&
        tsApi.isStringLiteral(node.moduleSpecifier) &&
        isAssetSpecifier(node.moduleSpecifier.text)
      ) {
        const assetRel = resolveAssetFile(root, rel, node.moduleSpecifier.text);
        const mod = moduleByFile.get(rel);
        if (assetRel !== null && mod !== undefined) {
          refsBySymbol.get(mod.id)?.add(`${assetRel}#<file>`);
        }
      }
      tsApi.forEachChild(node, visitImports);
    };
    visitImports(sourceFile);

    for (const s of fileSymbols) {
      s.references = [...(refsBySymbol.get(s.id) ?? [])].sort();
    }
  }
  for (const s of symbols) {
    if (s.references === undefined) s.references = [];
  }
}

function makeRecord(
  _tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  rel: string,
  node: ts.Node,
  qualifiedName: string,
  kind: SymbolKind,
): SymbolRecord {
  const startOffset = node.getStart(sourceFile);
  const endOffset = node.getEnd();
  return {
    id: `${rel}#${qualifiedName}`,
    file: rel,
    qualifiedName,
    kind,
    startOffset,
    endOffset,
    startLine: sourceFile.getLineAndCharacterOfPosition(startOffset).line + 1,
    endLine:
      sourceFile.getLineAndCharacterOfPosition(
        Math.max(startOffset, endOffset - 1),
      ).line + 1,
  };
}

function hasModifier(
  tsApi: typeof ts,
  node: ts.Node,
  kind: ts.SyntaxKind,
): boolean {
  if (!tsApi.canHaveModifiers(node)) return false;
  return (tsApi.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

/**
 * Stable text for a member name, or null when the name is not
 * statically known. Computed names qualify only in statically known
 * forms (string/numeric/template literals, `Symbol.<name>`); anything
 * else stays unnamed and its execution attributes through the
 * enclosing symbol or the module fallback.
 */
function memberName(
  tsApi: typeof ts,
  name: ts.PropertyName | undefined,
): string | null {
  if (name === undefined) return null;
  if (
    tsApi.isIdentifier(name) ||
    tsApi.isStringLiteral(name) ||
    tsApi.isNumericLiteral(name) ||
    tsApi.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  if (tsApi.isComputedPropertyName(name)) {
    const expr = unwrapExpression(tsApi, name.expression);
    if (
      tsApi.isStringLiteral(expr) ||
      tsApi.isNumericLiteral(expr) ||
      tsApi.isNoSubstitutionTemplateLiteral(expr)
    ) {
      return expr.text;
    }
    if (
      tsApi.isPropertyAccessExpression(expr) &&
      tsApi.isIdentifier(expr.expression) &&
      expr.expression.text === "Symbol" &&
      tsApi.isIdentifier(expr.name)
    ) {
      return `Symbol.${expr.name.text}`;
    }
  }
  return null;
}

function unwrapExpression(
  tsApi: typeof ts,
  expr: ts.Expression,
): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      tsApi.isParenthesizedExpression(current) ||
      tsApi.isAsExpression(current) ||
      tsApi.isSatisfiesExpression(current) ||
      tsApi.isNonNullExpression(current) ||
      tsApi.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function dedupeAndSort(symbols: SymbolRecord[]): SymbolRecord[] {
  // Same ID twice in one file (e.g. static + instance method of one name):
  // keep the earliest in source order so IDs stay unique and deterministic.
  const byId = new Map<string, SymbolRecord>();
  for (const symbol of symbols) {
    const existing = byId.get(symbol.id);
    if (existing === undefined || symbol.startOffset < existing.startOffset) {
      byId.set(symbol.id, symbol);
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** POSIX path of `absFile` relative to `root`, or null when outside/not app code. */
function relativePosix(root: string, absFile: string): string | null {
  const rel = path.relative(root, absFile);
  if (rel === "" || path.isAbsolute(rel)) return null;
  const posix = rel.split(path.sep).join("/");
  const segments = posix.split("/");
  if (segments[0] === "..") return null;
  if (segments.includes("node_modules")) return null;
  return posix;
}

function isIndexablePath(relPosix: string): boolean {
  if (/\.d\.[cm]?ts$/.test(relPosix)) return false;
  // Build output is never app source, even when a tsconfig includes it
  // (Next adds `.next/types/**/*.ts` for route type generation).
  if (relPosix.split("/").includes(".next")) return false;
  return /\.[cm]?[tj]sx?$/.test(relPosix);
}

/** File name without directory or final extension: `src/app/page.tsx` → `page`. */
function fileStem(relPosix: string): string {
  const base = relPosix.slice(relPosix.lastIndexOf("/") + 1);
  const ext = path.posix.extname(base);
  return ext === "" ? base : base.slice(0, base.length - ext.length);
}

function contentHash(text: string): string {
  return createHash("sha256")
    .update(String(INDEXER_VERSION))
    .update("\0")
    .update(text)
    .digest("hex");
}



