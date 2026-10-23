export { formatPhaseTimings } from "./timing.js";
export type { PhaseTiming } from "./timing.js";

/** Stable symbol ID: `<relative-file>#<qualified-name>`, e.g. `src/lib/cart.ts#Cart.addItem`. */
export type SymbolId = string;

export type SymbolKind =
  | "function"
  | "arrow-function"
  | "class"
  | "method"
  | "object-method"
  | "route-export"
  | "page-export"
  | "value"
  | "module"
  | "asset";

export interface SymbolRecord {
  id: SymbolId;
  file: string;
  qualifiedName: string;
  kind: SymbolKind;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  /** Symbol IDs this symbol statically references (resolved declarations). */
  references?: SymbolId[];
  /**
   * For `module` symbols: source slices of the leftover top-level
   * statements (imports, expression statements) whose text defines the
   * symbol's hash. When present, hashing uses these slices instead of
   * the full `[startOffset, endOffset)` range.
   */
  hashSlices?: { startOffset: number; endOffset: number }[];
}

export {
  createIndexCache,
  findEnclosingSymbol,
  INDEXER_VERSION,
  indexProject,
} from "./indexer/index.js";
export type {
  IndexCache,
  IndexDiagnostic,
  IndexOptions,
  IndexResult,
  IndexStats,
} from "./indexer/index.js";
export {
  browserEntriesToInputs,
  collectBrowserScripts,
  executedFunctionRanges,
  isAppScript,
  isBuiltinExcludedScript,
  mapRangesToSymbols,
  mergeObservedSets,
  nodeScriptsToInputs,
  observeIstanbul,
  observeScripts,
  parseNodeCoverageDir,
  remapScript,
  runNodeWithCoverage,
  spawnWithCoverage,
} from "./observer/index.js";
export type {
  CollectBrowserOptions,
  CoverageChild,
  CoverageLike,
  CoverageOrigin,
  IstanbulCoverage,
  JsCoverageEntry,
  MapResult,
  NodeCoverageDirResult,
  ObservedRange,
  ObservedSetResult,
  ObserveScriptsOptions,
  PageLike,
  RemapResult,
  ScriptInput,
  SpawnWithCoverageOptions,
  UnmappableScript,
  V8CoverageRange,
  V8FunctionCoverage,
  V8ScriptCoverage,
} from "./observer/index.js";
export {
  VibehardUsageError,
  checkLockfile,
  cypressDriver,
  computeTouchedSet,
  diffTouchedSets,
  discoverInFile,
  discoverStaticTests,
  emptyLockfile,
  encodeOnlyTitles,
  filterSymbols,
  findSpecFiles,
  frameworkVersion,
  getFrameworkDriver,
  hashConfig,
  hashesForTouched,
  hashSymbolSources,
  loadConfig,
  matchGlob,
  matchSymbolPattern,
  matchesAnyFilePattern,
  matchesAnySymbolPattern,
  parseLockfile,
  playwrightDriver,
  playwrightTestVersion,
  puppeteerDriver,
  readLockfile,
  formatVerifyReport,
  freePort,
  listTests,
  makeTestId,
  playwrightTailArgs,
  readArtifacts,
  discoveredSetHash,
  formatMergeReport,
  formatShardSpec,
  mergeShardArtifactList,
  mergeShardArtifacts,
  parseShardArtifact,
  parseShardSpec,
  readShardArtifact,
  recordProject,
  resolveJobs,
  serializeShardArtifact,
  shardOfTestId,
  shardSourceState,
  shardTests,
  validateShardSpec,
  writeShardArtifact,
  resolveCypressCli,
  resolveGeneratedPaths,
  resolvePlaywrightCli,
  runPlaywrightTests,
  runSingleTest,
  serializeLockfile,
  spawnCapture,
  stableStringify,
  ENV_ONLY_TITLES,
  startAppServer,
  startServers,
  toRunnableRef,
  verifyProject,
  writeLockfile,
} from "./verifier/index.js";
export type {
  AppServerSession,
  FrameworkDriver,
  FrameworkName,
  ListedTest,
  LockfileExpectation,
  LockfileTestEntry,
  MergeShardsOptions,
  MergeShardsResult,
  ProjectVerifyResult,
  ShardArtifact,
  ShardProvenance,
  ShardSourceState,
  ResolvedConfig,
  RunnableTestRef,
  RuntimeOptions,
  ServersSession,
  ShardSpec,
  SpawnCaptureResult,
  StaticDiscoveryOptions,
  TestTiming,
  TestVerifyResult,
  TouchKind,
  TouchedSet,
  TestVerifyStatus,
  VerifyProjectOptions,
  VibehardAppConfig,
  VibehardConfig,
  VibehardLockfile,
  VibehardServerConfig,
  VibehardTestOptions,
} from "./verifier/index.js";
export {
  baseProjectExists,
  classifyChangedFile,
  computeChangedSymbolsForFile,
  createBaseWorktree,
  diffPatch,
  explainProject,
  formatExplainReport,
  formatSelectionReport,
  formatTestReport,
  isAppSourceFile,
  isConfigFile,
  isDeclarationFile,
  listChangedFiles,
  lockfileTrustReasons,
  parseUnifiedDiff,
  resolveBase,
  resolveGitRoot,
  selectTests,
  testProject,
} from "./selector/index.js";
export type {
  BaseWorktree,
  ChangedFile,
  ChangedFileKind,
  ChangedFileStatus,
  ClassifyContext,
  DiffHunk,
  DiscoveredTestRef,
  ExplainOptions,
  ExplainResult,
  ExplainSymbolStatus,
  ExplainTestEntry,
  FileChangeInput,
  FileChangeResult,
  FilePatch,
  GitRoot,
  ResolvedBase,
  SelectedTest,
  SelectionReason,
  SelectionResult,
  SelectOptions,
  TestProjectOptions,
  TestProjectResult,
} from "./selector/index.js";
export { formatInitReport, initProject } from "./init/index.js";
export type {
  InitDetection,
  InitProjectOptions,
  InitProjectResult,
} from "./init/index.js";
