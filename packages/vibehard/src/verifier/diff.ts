import type { SymbolId } from "../index.js";
import { matchesAnySymbolPattern } from "./glob.js";

export interface DiffInput {
  /** Declared set as written (may contain duplicates); null = undeclared. */
  declared: readonly SymbolId[] | null;
  observed: readonly SymbolId[];
  knownSymbolIds: ReadonlySet<SymbolId>;
  ignore?: readonly string[];
  allowTransitive?: readonly string[];
}

export interface DiffResult {
  /** Declared set after dedupe + ignore removal (null stays null). */
  declared: SymbolId[] | null;
  /** Observed set after ignore removal. */
  observed: SymbolId[];
  missing: SymbolId[];
  extra: SymbolId[];
  allowed: SymbolId[];
  unknown: SymbolId[];
  diagnostics: string[];
}

/**
 * Exactness diff (manifest invariant): after removing `ignore`-matched
 * symbols from both sides, declared must equal observed. Observed symbols
 * matched by `allowTransitive` are permitted and reported, never silent.
 * Declared IDs with no indexed symbol count as missing and as unknown.
 */
export function diffDeclaredObserved(input: DiffInput): DiffResult {
  const ignore = input.ignore ?? [];
  const allow = input.allowTransitive ?? [];
  const diagnostics: string[] = [];

  const observedAll = [...new Set(input.observed)].sort();
  const observed = observedAll.filter((id) => !matchesAnySymbolPattern(ignore, id));
  const ignoredObserved = observedAll.length - observed.length;
  if (ignoredObserved > 0) {
    diagnostics.push(`ignored ${ignoredObserved} observed symbol(s) by config ignore`);
  }

  if (input.declared === null) {
    return { declared: null, observed, missing: [], extra: [], allowed: [], unknown: [], diagnostics };
  }

  const unique = [...new Set(input.declared)];
  if (unique.length !== input.declared.length) {
    diagnostics.push(`declaration contains ${input.declared.length - unique.length} duplicate entr${input.declared.length - unique.length === 1 ? "y" : "ies"}`);
  }
  const declared = unique.filter((id) => !matchesAnySymbolPattern(ignore, id)).sort();
  const unknown = declared.filter((id) => !input.knownSymbolIds.has(id));
  if (unknown.length > 0) {
    diagnostics.push(`${unknown.length} declared symbol(s) not in the index (renamed or typo)`);
  }

  const observedSet = new Set(observed);
  const declaredSet = new Set(declared);
  const missing = declared.filter((id) => !observedSet.has(id));
  const undeclaredObserved = observed.filter((id) => !declaredSet.has(id));
  const allowed = undeclaredObserved.filter((id) => matchesAnySymbolPattern(allow, id));
  const allowedSet = new Set(allowed);
  const extra = undeclaredObserved.filter((id) => !allowedSet.has(id));

  return { declared, observed, missing, extra, allowed, unknown, diagnostics };
}
