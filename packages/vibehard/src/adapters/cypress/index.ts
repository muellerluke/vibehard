import type { SymbolId } from "../../index.js";
import type { RuntimeDeclaration } from "../../verifier/types.js";

/**
 * Browser-side Cypress support for vibehard. This module runs inside
 * the Cypress spec bundle: it must stay free of Node imports.
 *
 * Wire-up (what `vibehard init` prints):
 *   // cypress/support/e2e.js
 *   import { registerVibehardSupport } from 'vibehard/cypress';
 *   registerVibehardSupport();
 *   // cypress.config
 *   import { registerVibehardTasks } from 'vibehard/cypress/node';
 *   setupNodeEvents(on) { registerVibehardTasks(on); }
 *   // a spec
 *   import { uses } from 'vibehard/cypress';
 *   it('checkout applies a coupon', () => {
 *     uses(['src/lib/cart.ts#Cart.applyCoupon']);
 *     cy.visit('/');
 *   });
 */

export interface VibehardUsesOptions {
  allowTransitive?: string[];
  skipVerify?: string;
}

/** Task name the support hooks report through (handled in cypress/node). */
export const VIBEHARD_TASK = "vibehard:artifact";

/** Cypress env key carrying base64url JSON titlePaths to run (selection). */
export const VIBEHARD_ONLY_ENV = "VIBEHARD_ONLY";

interface MochaLike {
  title: string;
  titlePath: () => string[];
  state?: string;
}

interface CypressGlobal {
  env(key: string): unknown;
  currentTest?: { title: string; titlePath: string[] };
}

interface CyGlobal {
  window(options?: { log?: boolean }): {
    then(
      fn: (win: {
        __coverage__?: Record<string, unknown>;
        location?: { href?: string };
      }) => unknown,
    ): unknown;
  };
  task(name: string, arg: unknown, options?: { log?: boolean }): unknown;
}

interface CypressGlobals {
  Cypress?: CypressGlobal;
  cy?: CyGlobal;
  beforeEach?: (fn: (this: { currentTest?: MochaLike; skip(): void }) => unknown) => void;
  afterEach?: (fn: (this: { currentTest?: MochaLike }) => unknown) => void;
}

function globals(): CypressGlobals {
  return globalThis as unknown as CypressGlobals;
}

interface CurrentDecl {
  value: RuntimeDeclaration | null;
  registered: boolean;
}

/**
 * Support file and spec may load this module as separate bundle
 * instances; the declaration holder must live on `globalThis` (shared
 * by both in the spec window), or `uses()` writes and the afterEach
 * reader never see each other.
 */
const STATE_KEY = "__vibehardCypressState__";

function state(): CurrentDecl {
  const holder = globalThis as unknown as Record<string, CurrentDecl | undefined>;
  holder[STATE_KEY] ??= { value: null, registered: false };
  return holder[STATE_KEY];
}

/**
 * Declare the exact symbol set for the currently running test. Keyed
 * by the test's runtime context (the manifest's "current test title"
 * registration), so call it inside the test body — conventionally as
 * the first statement. Returns the symbols for composition
 * compatibility with shared groups.
 */
export function uses(symbols: SymbolId[], opts?: VibehardUsesOptions): SymbolId[] {
  if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== "string")) {
    throw new TypeError("vibehard: uses() expects an array of symbol ID strings");
  }
  state().value = {
    uses: [...symbols],
    allowTransitive: opts?.allowTransitive ?? [],
    skipVerify: opts?.skipVerify ?? null,
  };
  return symbols;
}

function decodeOnly(raw: unknown): string[][] | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json =
      typeof atob === "function"
        ? decodeURIComponent(
            Array.from(atob(b64), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
          )
        : "";
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (p): p is string[] => Array.isArray(p) && p.every((x) => typeof x === "string"),
    );
  } catch {
    return null;
  }
}

function zeroCoverage(cov: Record<string, unknown>): void {
  for (const fileCov of Object.values(cov)) {
    if (fileCov === null || typeof fileCov !== "object") continue;
    const fc = fileCov as Record<string, Record<string, number | number[]> | undefined>;
    for (const key of ["s", "f"] as const) {
      const counters = fc[key];
      if (counters === undefined) continue;
      for (const id of Object.keys(counters)) counters[id] = 0;
    }
    const branches = fc["b"];
    if (branches !== undefined) {
      for (const id of Object.keys(branches)) {
        const counts = branches[id];
        if (Array.isArray(counts)) branches[id] = counts.map(() => 0);
      }
    }
  }
}

/**
 * Register the global hooks that make verification work: per-test
 * selection filtering (`VIBEHARD_ONLY`), declaration reset, and capture
 * of `window.__coverage__` into a per-test artifact after each test.
 * Outside a Cypress run this is a no-op.
 */
export function registerVibehardSupport(): void {
  if (state().registered) return;
  const g = globals();
  if (g.Cypress === undefined || g.beforeEach === undefined || g.afterEach === undefined) return;
  state().registered = true;
  const Cypress = g.Cypress;

  g.beforeEach(function (this: { currentTest?: MochaLike; skip(): void }) {
    state().value = null;
    const only = decodeOnly(Cypress.env(VIBEHARD_ONLY_ENV));
    if (only !== null && only.length > 0) {
      const pathNow = this.currentTest?.titlePath() ?? Cypress.currentTest?.titlePath ?? [];
      const wanted = only.some(
        (p) => p.length === pathNow.length && p.every((seg, i) => seg === pathNow[i]),
      );
      if (!wanted) this.skip();
    }
  });

  g.afterEach(function (this: { currentTest?: MochaLike }) {
    const cy = globals().cy;
    if (cy === undefined) return;
    const titlePath = this.currentTest?.titlePath() ?? Cypress.currentTest?.titlePath ?? [];
    const title = titlePath[titlePath.length - 1] ?? this.currentTest?.title ?? "";
    const testState = this.currentTest?.state ?? "unknown";
    if (testState === "pending") return; // skipped by the selection filter
    const declared: RuntimeDeclaration = state().value ?? {
      uses: null,
      allowTransitive: [],
      skipVerify: null,
    };
    cy.window({ log: false }).then((win) => {
      const cov = win.__coverage__ ?? null;
      if (cov === null) {
        // No coverage object. Only a test that never visited an app
        // page (about:blank window, API-only) may legitimately have
        // none; a visited page without one is uninstrumented and the
        // verifier fails it closed as unmappable.
        const href = win.location?.href ?? "";
        const visited = href !== "" && !href.startsWith("about:");
        return cy.task(
          VIBEHARD_TASK,
          { title, titlePath, status: testState, declared, istanbul: visited ? null : {} },
          { log: false },
        );
      }
      if (cov !== null) {
        const snapshot = JSON.parse(JSON.stringify(cov)) as Record<string, unknown>;
        zeroCoverage(cov);
        return cy.task(
          VIBEHARD_TASK,
          { title, titlePath, status: testState, declared, istanbul: snapshot },
          { log: false },
        );
      }
      return cy.task(
        VIBEHARD_TASK,
        { title, titlePath, status: testState, declared, istanbul: null },
        { log: false },
      );
    });
  });
}
