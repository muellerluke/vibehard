import type { SymbolId } from "../../index.js";

/** Stage 3: Playwright fixture/wrapper over `test`. */
export interface VibehardTestOptions {
  uses: SymbolId[];
  allowTransitive?: string[];
  skipVerify?: string;
}

export function defineUses(opts: VibehardTestOptions): VibehardTestOptions {
  return opts;
}
