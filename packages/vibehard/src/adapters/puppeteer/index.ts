import type { SymbolId } from "../../index.js";

/** Stage 6: Puppeteer page-coverage wrapper. */
export interface VibehardPageOptions {
  uses: SymbolId[];
}

export function defineUses(opts: VibehardPageOptions): VibehardPageOptions {
  return opts;
}
