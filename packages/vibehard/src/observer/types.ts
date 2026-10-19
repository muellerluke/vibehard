import type { SymbolId, SymbolRecord } from "../index.js";

/** Which side executed a script: the browser (`client`) or Node (`server`). */
export type CoverageOrigin = "client" | "server";

/** One V8 coverage range: `[startOffset, endOffset)` executed `count` times. */
export interface V8CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

/** V8 function coverage; `ranges[0]` spans the whole function. */
export interface V8FunctionCoverage {
  functionName: string;
  isBlockCoverage?: boolean;
  ranges: V8CoverageRange[];
}

/** V8 `ScriptCoverage` (Node `NODE_V8_COVERAGE` files and CDP share this shape). */
export interface V8ScriptCoverage {
  scriptId?: string;
  url: string;
  functions: V8FunctionCoverage[];
}

/** One generated script plus everything known to remap its coverage. */
export interface ScriptInput {
  /** URL as reported by V8 (`http://…`, `file://…`, `node:…`, …). */
  url: string;
  origin: CoverageOrigin;
  functions: V8FunctionCoverage[];
  /** Generated source text, when known (browser entries may carry it). */
  source?: string | null;
  /** Absolute path of the generated file on disk, when known. */
  sourcePath?: string | null;
  /** Explicit parsed source map (object) or its JSON text, when known. */
  sourceMap?: unknown;
}

/** An executed range already remapped to original source coordinates. */
export interface ObservedRange {
  /** POSIX path relative to the app root, matching `SymbolRecord.file`. */
  file: string;
  startOffset: number;
  endOffset: number;
  origin: CoverageOrigin;
}

/** An app script whose executed ranges could not be remapped. Fail-closed. */
export interface UnmappableScript {
  url: string;
  origin: CoverageOrigin;
  reason: string;
}

export interface ObservedSetResult {
  /** False when any app script is unmappable; never treat as a pass. */
  ok: boolean;
  client: SymbolId[];
  server: SymbolId[];
  merged: SymbolId[];
  ranges: ObservedRange[];
  unmappable: UnmappableScript[];
  /** Non-fatal notes (ignored top-level/glue ranges, excluded scripts). */
  diagnostics: string[];
}

export interface ObserveScriptsOptions {
  /** Absolute app root; symbol files and observed files are relative to it. */
  rootDir: string;
  symbols: readonly SymbolRecord[];
  /**
   * Absolute generated-file paths (or URL pathnames such as `/client.js`)
   * known to be app build outputs. A missing source map for one of these —
   * or for a generated file under `rootDir` outside `node_modules`, or for
   * any `http(s)` script — is unmappable (fail closed), unlike runtime
   * internals which are built-in exclusions.
   */
  appGeneratedPaths?: readonly string[];
  /** Override the app-script classification entirely. */
  isAppScript?: (script: ScriptInput) => boolean;
}
