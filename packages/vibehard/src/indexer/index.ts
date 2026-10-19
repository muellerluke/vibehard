import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import ts from "typescript";

import type { SymbolKind, SymbolRecord } from "../index.js";

/** Bump when extraction rules change; part of every cache key. */
export const INDEXER_VERSION = 2;

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

function extractSymbols(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  rel: string,
): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  const stem = fileStem(rel);
  const isRouteFile = stem === "route";
  const isPageFile = stem === "page" || stem === "layout";
  let defaultExportName: string | null = null;

  for (const stmt of sourceFile.statements) {
    if (tsApi.isFunctionDeclaration(stmt)) {
      if (stmt.body === undefined) continue; // overload signature
      const isDefault = hasModifier(tsApi, stmt, tsApi.SyntaxKind.DefaultKeyword);
      if (stmt.name === undefined && !isDefault) continue;
      const name = stmt.name?.text ?? "default";
      let kind: SymbolKind = "function";
      if (isDefault && isPageFile) {
        kind = "page-export";
      } else if (
        isRouteFile &&
        hasModifier(tsApi, stmt, tsApi.SyntaxKind.ExportKeyword) &&
        ROUTE_METHODS.has(name)
      ) {
        kind = "route-export";
      }
      out.push(makeRecord(tsApi, sourceFile, rel, stmt, name, kind));
    } else if (tsApi.isClassDeclaration(stmt)) {
      const isDefault = hasModifier(tsApi, stmt, tsApi.SyntaxKind.DefaultKeyword);
      const className = stmt.name?.text ?? (isDefault ? "default" : null);
      if (className === null) continue;
      extractClassMembers(tsApi, sourceFile, rel, stmt, className, out);
    } else if (tsApi.isVariableStatement(stmt)) {
      const exported = hasModifier(tsApi, stmt, tsApi.SyntaxKind.ExportKeyword);
      for (const decl of stmt.declarationList.declarations) {
        if (!tsApi.isIdentifier(decl.name)) {
          continue;
        }
        const name = decl.name.text;
        if (decl.initializer === undefined) {
          out.push(makeRecord(tsApi, sourceFile, rel, decl, name, "value"));
          continue;
        }
        const init = unwrapExpression(tsApi, decl.initializer);
        if (tsApi.isArrowFunction(init) || tsApi.isFunctionExpression(init)) {
          let kind: SymbolKind = tsApi.isArrowFunction(init)
            ? "arrow-function"
            : "function";
          if (exported && isRouteFile && ROUTE_METHODS.has(name)) {
            kind = "route-export";
          }
          out.push(makeRecord(tsApi, sourceFile, rel, decl, name, kind));
        } else if (tsApi.isObjectLiteralExpression(init)) {
          out.push(makeRecord(tsApi, sourceFile, rel, decl, name, "value"));
          extractObjectMethods(tsApi, sourceFile, rel, init, name, out);
        } else if (tsApi.isClassExpression(init)) {
          extractClassMembers(tsApi, sourceFile, rel, init, name, out);
        } else {
          out.push(makeRecord(tsApi, sourceFile, rel, decl, name, "value"));
        }
      }
    } else if (tsApi.isExportAssignment(stmt)) {
      if (stmt.isExportEquals) continue;
      const expr = unwrapExpression(tsApi, stmt.expression);
      if (tsApi.isIdentifier(expr)) {
        // Already recorded at its declaration; remember for page fix-up.
        defaultExportName = expr.text;
      } else if (tsApi.isArrowFunction(expr) || tsApi.isFunctionExpression(expr)) {
        const name =
          (tsApi.isFunctionExpression(expr) ? expr.name?.text : undefined) ??
          "default";
        const kind: SymbolKind = isPageFile
          ? "page-export"
          : tsApi.isArrowFunction(expr)
            ? "arrow-function"
            : "function";
        out.push(makeRecord(tsApi, sourceFile, rel, stmt, name, kind));
      } else if (tsApi.isClassExpression(expr)) {
        extractClassMembers(
          tsApi,
          sourceFile,
          rel,
          expr,
          expr.name?.text ?? "default",
          out,
        );
      } else if (tsApi.isObjectLiteralExpression(expr)) {
        out.push(makeRecord(tsApi, sourceFile, rel, stmt, "default", "value"));
        extractObjectMethods(tsApi, sourceFile, rel, expr, "default", out);
      } else {
        out.push(makeRecord(tsApi, sourceFile, rel, stmt, "default", "value"));
      }
    } else if (tsApi.isEnumDeclaration(stmt)) {
      out.push(makeRecord(tsApi, sourceFile, rel, stmt, stmt.name.text, "value"));
    }
  }

  // `const Page = () => ...; export default Page;` in a page/layout file.
  if (isPageFile && defaultExportName !== null) {
    for (const record of out) {
      if (record.qualifiedName === defaultExportName) {
        record.kind = "page-export";
      }
    }
  }

  // One module symbol per file covering leftover top-level lines
  // (imports, expression statements, type-only declarations). Its range
  // spans the file so any line not in a smaller symbol still maps; its
  // hash covers only the leftover statement slices.
  const hashSlices: { startOffset: number; endOffset: number }[] = [];
  for (const stmt of sourceFile.statements) {
    if (
      tsApi.isFunctionDeclaration(stmt) ||
      tsApi.isClassDeclaration(stmt) ||
      tsApi.isVariableStatement(stmt) ||
      tsApi.isExportAssignment(stmt) ||
      tsApi.isEnumDeclaration(stmt)
    ) {
      continue;
    }
    hashSlices.push({ startOffset: stmt.getStart(sourceFile), endOffset: stmt.getEnd() });
  }
  const moduleRecord = makeRecord(tsApi, sourceFile, rel, sourceFile, "<module>", "module");
  moduleRecord.startOffset = 0;
  moduleRecord.endOffset = sourceFile.text.length;
  moduleRecord.startLine = 1;
  moduleRecord.endLine =
    sourceFile.getLineAndCharacterOfPosition(Math.max(0, sourceFile.text.length - 1)).line + 1;
  moduleRecord.hashSlices = hashSlices;
  out.push(moduleRecord);
  return out;
}

function extractClassMembers(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  rel: string,
  cls: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
  out: SymbolRecord[],
): void {
  for (const member of cls.members) {
    if (tsApi.isConstructorDeclaration(member)) {
      if (member.body === undefined) continue;
      out.push(
        makeRecord(
          tsApi,
          sourceFile,
          rel,
          member,
          `${className}.constructor`,
          "method",
        ),
      );
    } else if (
      tsApi.isMethodDeclaration(member) ||
      tsApi.isGetAccessorDeclaration(member) ||
      tsApi.isSetAccessorDeclaration(member)
    ) {
      if (member.body === undefined) continue; // abstract or overload signature
      const name = memberName(tsApi, member.name);
      if (name === null) continue;
      out.push(
        makeRecord(tsApi, sourceFile, rel, member, `${className}.${name}`, "method"),
      );
    } else if (tsApi.isPropertyDeclaration(member)) {
      const name = memberName(tsApi, member.name);
      if (name === null) continue;
      if (member.initializer === undefined) {
        out.push(
          makeRecord(tsApi, sourceFile, rel, member, `${className}.${name}`, "value"),
        );
        continue;
      }
      const init = unwrapExpression(tsApi, member.initializer);
      if (tsApi.isArrowFunction(init) || tsApi.isFunctionExpression(init)) {
        out.push(
          makeRecord(tsApi, sourceFile, rel, member, `${className}.${name}`, "method"),
        );
      } else {
        out.push(
          makeRecord(tsApi, sourceFile, rel, member, `${className}.${name}`, "value"),
        );
      }
    } else if (tsApi.isClassStaticBlockDeclaration(member)) {
      out.push(
        makeRecord(tsApi, sourceFile, rel, member, `${className}.<static>`, "value"),
      );
    }
  }
}

function extractObjectMethods(
  tsApi: typeof ts,
  sourceFile: ts.SourceFile,
  rel: string,
  obj: ts.ObjectLiteralExpression,
  prefix: string,
  out: SymbolRecord[],
): void {
  for (const prop of obj.properties) {
    if (
      tsApi.isMethodDeclaration(prop) ||
      tsApi.isGetAccessorDeclaration(prop) ||
      tsApi.isSetAccessorDeclaration(prop)
    ) {
      const name = memberName(tsApi, prop.name);
      if (name === null) continue;
      out.push(
        makeRecord(
          tsApi,
          sourceFile,
          rel,
          prop,
          `${prefix}.${name}`,
          "object-method",
        ),
      );
    } else if (tsApi.isPropertyAssignment(prop)) {
      const name = memberName(tsApi, prop.name);
      if (name === null) continue;
      const init = unwrapExpression(tsApi, prop.initializer);
      if (tsApi.isArrowFunction(init) || tsApi.isFunctionExpression(init)) {
        out.push(
          makeRecord(
            tsApi,
            sourceFile,
            rel,
            prop,
            `${prefix}.${name}`,
            "object-method",
          ),
        );
      } else if (tsApi.isObjectLiteralExpression(init)) {
        extractObjectMethods(tsApi, sourceFile, rel, init, `${prefix}.${name}`, out);
      }
    }
    // Shorthand and spread assignments name no new declaration range.
  }
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

function resolveAssetFile(
  root: string,
  fromFileRel: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    // Bare specifiers resolve into packages; only project-relative
    // asset imports become symbols (package changes stay full-run).
    if (!specifier.startsWith("@/")) return null;
  }
  const raw = specifier.split(/[?#]/)[0] ?? specifier;
  const clean = raw.replace(/^@\//, "src/");
  const abs = clean.startsWith("/")
    ? path.resolve(root, `.${clean}`)
    : raw.startsWith("@/")
      ? path.resolve(root, clean)
      : path.resolve(root, path.posix.dirname(fromFileRel), clean);
  const rel = relativePosix(root, abs);
  if (rel === null || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return rel;
}

function collectAssetSymbols(
  tsApi: typeof ts,
  sourceFilesByRel: ReadonlyMap<string, ts.SourceFile>,
  root: string,
): SymbolRecord[] {
  const byId = new Map<string, SymbolRecord>();
  for (const [rel, sourceFile] of sourceFilesByRel) {
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
        const assetRel = resolveAssetFile(root, rel, specifier);
        if (assetRel !== null) {
          const id = `${assetRel}#<file>`;
          if (!byId.has(id)) {
            let length = 0;
            let lines = 1;
            try {
              const data = readFileSync(path.resolve(root, assetRel));
              length = data.length;
              lines = Math.max(1, data.toString("utf8").split("\n").length);
            } catch {
              // existsSync was checked in resolveAssetFile
            }
            byId.set(id, {
              id,
              file: assetRel,
              qualifiedName: "<file>",
              kind: "asset",
              startOffset: 0,
              endOffset: length,
              startLine: 1,
              endLine: lines,
              references: [],
            });
          }
        }
      }
      tsApi.forEachChild(node, visit);
    };
    visit(sourceFile);
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

/**
 * Resolve every identifier inside each symbol to the symbol that
 * declares it, via the TypeChecker. Module symbols only scan their
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

  const declarationSymbol = (decl: ts.Declaration): SymbolRecord | null => {
    const declFile = decl.getSourceFile();
    const rel = relativePosix(root, declFile.fileName);
    if (rel === null || !isIndexablePath(rel)) return null;
    const start = decl.getStart(declFile);
    const end = decl.getEnd();
    return (
      smallestContaining(symbolsByFile, rel, start, end) ??
      smallestContaining(symbolsByFile, rel, start, start + 1) ??
      moduleByFile.get(rel) ??
      null
    );
  };

  const resolveIdentifier = (id: ts.Identifier, fromRel: string): SymbolRecord | null => {
    let sym: ts.Symbol | undefined;
    try {
      sym = checker.getSymbolAtLocation(id);
    } catch {
      return null;
    }
    if (sym === undefined) return null;
    let target = sym;
    try {
      if ((sym.flags & tsApi.SymbolFlags.Alias) !== 0) {
        target = checker.getAliasedSymbol(sym);
      }
    } catch {
      target = sym;
    }
    for (const decl of target.declarations ?? []) {
      const found = declarationSymbol(decl);
      if (found !== null) return found;
    }
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
    return null;
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

    const visit = (node: ts.Node): void => {
      // Import/export binding names are not uses; usage identifiers
      // inside symbols carry the real edges. Descending here would
      // attribute every imported declaration to the module symbol.
      if (tsApi.isImportDeclaration(node) || tsApi.isExportDeclaration(node)) return;
      if (tsApi.isIdentifier(node)) {
        // Declaration names and property names that bind are handled by
        // resolution returning the symbol itself; self-edges dropped.
        const owner = attribute(node);
        if (owner !== null) {
          // Module owners only claim identifiers inside leftover slices;
          // identifiers inside a named symbol were owned above. A node
          // attributed to module is by construction outside every
          // smaller symbol, which matches the leftover definition.
          const target = resolveIdentifier(node, rel);
          if (target !== null && target.id !== owner.id) {
            refsBySymbol.get(owner.id)?.add(target.id);
          }
        }
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

function memberName(
  tsApi: typeof ts,
  name: ts.PropertyName | undefined,
): string | null {
  if (name === undefined) return null;
  if (
    tsApi.isIdentifier(name) ||
    tsApi.isStringLiteral(name) ||
    tsApi.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null; // computed names have no stable qualified name
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



