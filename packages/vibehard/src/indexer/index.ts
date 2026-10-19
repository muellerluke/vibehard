import type { SymbolRecord } from "../index.js";

/** Stage 1: TypeScript Compiler API indexer. */
export interface IndexResult {
  symbols: SymbolRecord[];
  imports: Map<string, string[]>;
}

export function indexProject(_rootDir: string): Promise<IndexResult> {
  return Promise.reject(new Error("indexer: not implemented (Stage 1)"));
}
