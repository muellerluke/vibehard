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
