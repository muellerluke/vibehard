import { readFileSync } from "node:fs";
import path from "node:path";

import { createModuleResolver, type ModuleResolver } from "../indexer/index.js";
import { isAppSourceFile } from "./changed.js";
import type { ChangedFile } from "./git.js";

export interface SupportGraphStats {
  filesParsed: number;
  edges: number;
  specsMapped: number;
}

export interface SupportGraphResult {
  /**
   * Provably mapped changed support files: support file -> sorted spec
   * files that transitively import it. A changed support file absent
   * here is unmapped; the caller keeps today's unsafe full run for it.
   */
  mapped: Map<string, string[]>;
  /** Human-readable proof failures (diagnostics; never unsafe strings). */
  problems: string[];
  stats: SupportGraphStats;
}

const NO_WORK: SupportGraphStats = { filesParsed: 0, edges: 0, specsMapped: 0 };

function isLocalSpecifier(specifier: string): boolean {
  return (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("#")
  );
}

function inTestDir(file: string, testDirPosix: string): boolean {
  return file === testDirPosix || file.startsWith(`${testDirPosix}/`);
}

/**
 * Map changed test-support files to the specs that import them, or
 * prove nothing. The graph is built lazily (only when an eligible
 * support change exists), parse-only from current (head) source:
 * removing an import edge requires editing the importing file, which
 * is then itself a changed spec, support, or app file handled by its
 * own path, so head edges are the ones that decide selection.
 *
 * Eligibility is deliberately narrow. Only source files changed by
 * edit/addition map: a deleted helper's old importers are invisible
 * in head source, and non-source fixture files are commonly read via
 * `fs`, which no import graph can disprove. Traversal is bounded to
 * discovered specs plus files under the test directory; edges into
 * app code are leaves, so a helper reachable only through app code
 * has zero importers here and stays unmapped — as does any helper no
 * spec imports, which covers implicitly loaded setup/support files
 * without executing a framework config to find them. Any unprovable
 * loading form or unresolvable local specifier in a traversed file
 * voids the whole mapping.
 */
export interface SupportGraphInput {
  rootDir: string;
  testDirPosix: string | null;
  /** Discovered spec files (POSIX project-relative). */
  specFiles: readonly string[];
  /** Changed files already classified `test-support`. */
  changedSupport: readonly ChangedFile[];
  /** Resolver override (tests); defaults to the project's resolver. */
  resolver?: ModuleResolver;
}

export function resolveChangedSupportFiles(input: SupportGraphInput): SupportGraphResult {
  const { testDirPosix } = input;
  const eligible = input.changedSupport.filter(
    (c) =>
      (c.status === "M" || c.status === "A" || c.status === "?") && isAppSourceFile(c.file),
  );
  if (testDirPosix === null || eligible.length === 0 || input.specFiles.length === 0) {
    return { mapped: new Map(), problems: [], stats: { ...NO_WORK } };
  }
  try {
    return buildSupportGraph({ ...input, testDirPosix }, eligible);
  } catch (error) {
    // A graph failure must degrade to today's unsafe full run, never
    // to a thrown selection or a guessed mapping.
    return {
      mapped: new Map(),
      problems: [
        `support graph failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      stats: { ...NO_WORK },
    };
  }
}

/** Invert support file -> specs into spec file -> sorted support files. */
export function supportFilesBySpec(
  mapped: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const bySpec = new Map<string, string[]>();
  for (const [supportFile, specs] of mapped) {
    for (const spec of specs) {
      const list = bySpec.get(spec) ?? [];
      list.push(supportFile);
      bySpec.set(spec, list);
    }
  }
  for (const list of bySpec.values()) list.sort();
  return bySpec;
}

function buildSupportGraph(
  input: SupportGraphInput & { testDirPosix: string },
  eligible: ChangedFile[],
): SupportGraphResult {
  const testDirPosix = input.testDirPosix;
  const rootDir = path.resolve(input.rootDir);
  const resolver = input.resolver ?? createModuleResolver(rootDir);
  const specSet = new Set(input.specFiles);
  const problems: string[] = [];
  const adjacency = new Map<string, string[]>();
  let edges = 0;

  const queue = [...specSet].sort();
  const visited = new Set<string>(queue);
  for (let i = 0; i < queue.length; i += 1) {
    const file = queue[i] as string;
    let text: string;
    try {
      text = readFileSync(path.resolve(rootDir, file), "utf8");
    } catch {
      problems.push(`${file}: could not be read`);
      continue;
    }
    const scan = resolver.scanImports(file, text);
    for (const form of scan.unprovable) problems.push(`${file}: ${form}`);
    const targets = new Set<string>();
    for (const specifier of scan.specifiers) {
      const resolution = resolver.resolveSpecifier(file, specifier);
      if (resolution.kind === "project") {
        targets.add(resolution.file);
        if (
          (inTestDir(resolution.file, testDirPosix) || specSet.has(resolution.file)) &&
          !visited.has(resolution.file)
        ) {
          visited.add(resolution.file);
          queue.push(resolution.file);
        }
      } else if (resolution.kind === "unresolved" && isLocalSpecifier(specifier)) {
        problems.push(`${file}: unresolved import "${specifier}"`);
      }
    }
    const sorted = [...targets].sort();
    edges += sorted.length;
    adjacency.set(file, sorted);
  }
  const stats: SupportGraphStats = {
    filesParsed: adjacency.size,
    edges,
    specsMapped: 0,
  };
  if (problems.length > 0) {
    return { mapped: new Map(), problems: [...new Set(problems)].sort(), stats };
  }

  // Transitive project imports of each spec, through traversed files
  // only (leaves have no adjacency entry and end the walk).
  const closures = new Map<string, Set<string>>();
  for (const spec of specSet) {
    const seen = new Set<string>();
    const stack = [spec];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      for (const target of adjacency.get(current) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (adjacency.has(target)) stack.push(target);
      }
    }
    closures.set(spec, seen);
  }

  const mapped = new Map<string, string[]>();
  const specsMapped = new Set<string>();
  for (const change of eligible) {
    const importers = [...specSet]
      .filter((spec) => closures.get(spec)?.has(change.file) === true)
      .sort();
    if (importers.length === 0) continue;
    mapped.set(change.file, importers);
    for (const spec of importers) specsMapped.add(spec);
  }
  stats.specsMapped = specsMapped.size;
  return { mapped, problems: [], stats };
}
