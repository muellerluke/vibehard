import type { ScriptInput, V8FunctionCoverage } from "./types.js";

/** Playwright `Coverage` entry shape (V8-specific coverage format). */
export interface JsCoverageEntry {
  url: string;
  scriptId?: string;
  source?: string;
  functions: V8FunctionCoverage[];
}

/** Structural subset of Playwright's `page.coverage` (Chromium only). */
export interface CoverageLike {
  startJSCoverage: (options?: {
    resetOnNavigation?: boolean;
  }) => Promise<void>;
  stopJSCoverage: () => Promise<JsCoverageEntry[]>;
}

/** Structural subset of a Playwright `Page` used by the observer. */
export interface PageLike {
  coverage?: CoverageLike | null;
  goto: (
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" },
  ) => Promise<unknown>;
}

export interface CollectBrowserOptions {
  /**
   * Resolve on-disk facts for a script URL the coverage entry cannot carry
   * (generated file path for sibling `.map` lookup, or an explicit map).
   */
  resolveScript?: (
    url: string,
  ) => { sourcePath?: string | null; sourceMap?: unknown; source?: string } | null;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

/** Adapt raw browser coverage entries to client-origin script inputs. */
export function browserEntriesToInputs(
  entries: readonly JsCoverageEntry[],
  options: CollectBrowserOptions = {},
): ScriptInput[] {
  return entries.map((entry) => {
    const resolved = options.resolveScript?.(entry.url) ?? null;
    return {
      url: entry.url,
      origin: "client" as const,
      functions: entry.functions,
      source: resolved?.source ?? entry.source ?? null,
      sourcePath: resolved?.sourcePath ?? null,
      sourceMap: resolved?.sourceMap ?? null,
    };
  });
}

/**
 * Start JS coverage, load `url`, and return the executed scripts.
 * Throws on browsers without a coverage API (Chromium-only per platform).
 */
export async function collectBrowserScripts(
  page: PageLike,
  url: string,
  options: CollectBrowserOptions = {},
): Promise<ScriptInput[]> {
  const coverage = page.coverage;
  if (coverage === undefined || coverage === null) {
    throw new Error(
      "vibehard observer: page has no coverage API (Chromium required for JS coverage)",
    );
  }
  await coverage.startJSCoverage({ resetOnNavigation: false });
  let entries: JsCoverageEntry[];
  try {
    await page.goto(url, { waitUntil: options.waitUntil ?? "load" });
  } finally {
    entries = await coverage.stopJSCoverage();
  }
  return browserEntriesToInputs(entries, options);
}
