import type { SymbolId, SymbolRecord } from "../index.js";

/** How a symbol entered a test's touched set. */
export type TouchKind = "direct" | "referenced" | "module" | "class" | "asset";

/** A test's touched set: symbol ID -> how it was touched. */
export type TouchedSet = Record<SymbolId, TouchKind>;

function kindFor(record: SymbolRecord, fallback: TouchKind): TouchKind {
  if (record.kind === "asset") return "asset";
  if (record.kind === "module") return "module";
  return fallback;
}

/**
 * Compute the full touched set for one test: directly observed symbols,
 * the module symbol of every file containing an observed symbol, the
 * class symbol of every class containing a touched symbol (so header
 * edits — extends, decorators — select tests that only ran members),
 * and the static-reference closure of those seeds. The closure only
 * ever adds value/module/asset symbols, transitively; executables
 * enter solely by being observed running.
 */
export function computeTouchedSet(
  observed: readonly SymbolId[],
  symbols: readonly SymbolRecord[],
): TouchedSet {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const moduleByFile = new Map<string, SymbolRecord>();
  for (const s of symbols) if (s.kind === "module") moduleByFile.set(s.file, s);
  const classesByFile = new Map<string, SymbolRecord[]>();
  for (const s of symbols) {
    if (s.kind !== "class") continue;
    const list = classesByFile.get(s.file) ?? [];
    list.push(s);
    classesByFile.set(s.file, list);
  }

  const touched = new Map<SymbolId, TouchKind>();
  const expandable: SymbolRecord[] = [];
  const add = (record: SymbolRecord, kind: TouchKind, expand: boolean): void => {
    const existing = touched.get(record.id);
    if (existing === undefined) {
      touched.set(record.id, kind);
      if (expand) expandable.push(record);
    } else if (existing !== "direct" && kind === "direct") {
      touched.set(record.id, "direct");
    }
  };

  /** Add every class symbol whose range strictly contains `record`. */
  const addContainingClasses = (record: SymbolRecord): void => {
    for (const cls of classesByFile.get(record.file) ?? []) {
      if (cls.id === record.id) continue;
      if (cls.startOffset <= record.startOffset && record.endOffset <= cls.endOffset) {
        add(cls, "class", true);
      }
    }
  };

  for (const id of observed) {
    const record = byId.get(id);
    if (record === undefined) continue;
    add(record, kindFor(record, "direct"), true);
    const mod = moduleByFile.get(record.file);
    if (mod !== undefined && mod.id !== record.id) add(mod, "module", true);
    addContainingClasses(record);
  }

  const EXECUTABLE: ReadonlySet<string> = new Set([
    "function",
    "arrow-function",
    "class",
    "method",
    "object-method",
    "route-export",
    "page-export",
  ]);
  while (expandable.length > 0) {
    const current = expandable.pop();
    if (current === undefined) break;
    for (const refId of current.references ?? []) {
      const target = byId.get(refId);
      if (target === undefined || touched.has(target.id)) continue;
      // An executable reached only by reference either ran (and is
      // already a direct seed) or did not run (and its behavior
      // cannot affect this test). Merely being *named* — e.g. a route
      // handler passed to `app.get(...)` at module scope — is not
      // execution. The closure therefore only adds value, module,
      // and asset symbols.
      if (EXECUTABLE.has(target.kind)) continue;
      const expand =
        target.kind === "value" ||
        target.kind === "module" ||
        target.kind === "asset" ||
        current.kind === "value" ||
        current.kind === "module" ||
        current.kind === "asset";
      add(target, kindFor(target, "referenced"), expand);
      const mod = moduleByFile.get(target.file);
      if (mod !== undefined && !touched.has(mod.id)) add(mod, "module", true);
      addContainingClasses(target);
    }
  }

  const out: TouchedSet = {};
  for (const id of [...touched.keys()].sort()) {
    const kind = touched.get(id);
    if (kind !== undefined) out[id] = kind;
  }
  return out;
}

/** Set difference between two touched sets, ignoring touch kinds. */
export function diffTouchedSets(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): { added: SymbolId[]; removed: SymbolId[] } {
  const expectedKeys = new Set(Object.keys(expected));
  const actualKeys = new Set(Object.keys(actual));
  return {
    added: [...actualKeys].filter((id) => !expectedKeys.has(id)).sort(),
    removed: [...expectedKeys].filter((id) => !actualKeys.has(id)).sort(),
  };
}
