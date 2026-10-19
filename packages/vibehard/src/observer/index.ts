export type {
  CoverageOrigin,
  ObservedRange,
  ObservedSetResult,
  ObserveScriptsOptions,
  ScriptInput,
  UnmappableScript,
  V8CoverageRange,
  V8FunctionCoverage,
  V8ScriptCoverage,
} from "./types.js";
export {
  executedFunctionRanges,
  nodeScriptsToInputs,
  parseNodeCoverageDir,
} from "./v8.js";
export type { NodeCoverageDirResult } from "./v8.js";
export { isAppScript, isBuiltinExcludedScript, remapScript } from "./remap.js";
export type { RemapResult } from "./remap.js";
export {
  mapRangesToSymbols,
  mergeObservedSets,
  observeScripts,
} from "./map.js";
export type { MapResult } from "./map.js";
export { runNodeWithCoverage, spawnWithCoverage } from "./node-child.js";
export type {
  CoverageChild,
  SpawnWithCoverageOptions,
} from "./node-child.js";
export {
  browserEntriesToInputs,
  collectBrowserScripts,
} from "./browser.js";
export type {
  CollectBrowserOptions,
  CoverageLike,
  JsCoverageEntry,
  PageLike,
} from "./browser.js";
