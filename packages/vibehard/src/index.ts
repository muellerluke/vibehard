/** Stable symbol ID: `<relative-file>#<qualified-name>`, e.g. `src/lib/cart.ts#Cart.addItem`. */
export type SymbolId = string;

export type SymbolKind =
  | "function"
  | "arrow-function"
  | "class"
  | "method"
  | "object-method"
  | "route-export"
  | "page-export";

export interface SymbolRecord {
  id: SymbolId;
  file: string;
  qualifiedName: string;
  kind: SymbolKind;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export {
  createIndexCache,
  findEnclosingSymbol,
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
  CodemodError,
  VibehardUsageError,
  checkLockfile,
  cypressDriver,
  diffDeclaredObserved,
  discoverInFile,
  discoverStaticTests,
  emptyLockfile,
  encodeOnlyTitles,
  extractDeclarations,
  filterSymbols,
  findSpecFiles,
  formatUsesArray,
  frameworkVersion,
  getFrameworkDriver,
  hashConfig,
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
  recordProject,
  resolveCypressCli,
  resolveGeneratedPaths,
  resolvePlaywrightCli,
  rewriteDeclaration,
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
  DiffInput,
  DiffResult,
  ExtractOptions,
  ExtractedDeclaration,
  ExtractedSpread,
  ExtractedUses,
  FrameworkDriver,
  FrameworkName,
  ListedTest,
  LockfileExpectation,
  LockfileTestEntry,
  ProjectVerifyResult,
  ResolvedConfig,
  RewriteResult,
  RunnableTestRef,
  RuntimeDeclaration,
  ServersSession,
  SpawnCaptureResult,
  StaticDiscoveryOptions,
  TestVerifyResult,
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
