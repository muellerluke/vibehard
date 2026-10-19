import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";

// `node:test` has no bare-specifier form, and the bundler strips the
// `node:` prefix from static imports, so load it through createRequire.
const nodeRequire = createRequire(import.meta.url);
const { describe: nodeDescribe, test: nodeTest } =
  nodeRequire("node:test") as typeof import("node:test");
import { fileURLToPath } from "node:url";

import type { SymbolId } from "../../index.js";
import type { ScriptInput, V8FunctionCoverage } from "../../observer/types.js";
import type { RuntimeDeclaration, VibehardTestOptions } from "../../verifier/types.js";
import {
  ENV_ARTIFACT_DIR,
  artifactFileName,
  type VibehardArtifact,
} from "../playwright/artifact.js";
import { embedCoverageEntry } from "../shared-coverage.js";

export type { VibehardTestOptions } from "../../verifier/types.js";
export { ENV_ARTIFACT_DIR, ENV_BASE_URL, ENV_RESOLVE_MAP } from "../playwright/artifact.js";

/** Declaration options for a Puppeteer test or page (manifest: Declaration API). */
export interface VibehardPageOptions {
  uses: SymbolId[];
  allowTransitive?: string[];
  skipVerify?: string;
}

/** Kept from Stage 0: identity helper for building shared declaration groups. */
export function defineUses(opts: VibehardPageOptions): VibehardPageOptions {
  return opts;
}

/** Minimal structural shape of a Puppeteer CDP session. */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach?(): Promise<void>;
}

/** Minimal structural shape of a Puppeteer page. */
export interface PageLike {
  createCDPSession(): Promise<CdpSessionLike>;
  close(): Promise<void>;
}

interface RawEntry {
  url: string;
  functions: V8FunctionCoverage[];
}

interface Collector {
  declared: RuntimeDeclaration;
  sessions: Map<PageLike, CdpSessionLike>;
  /** Last precise-coverage snapshot per page (taken again on close). */
  snapshots: Map<PageLike, RawEntry[]>;
  scripts: ScriptInput[];
  stopped: boolean;
}

const patchedClosers = new WeakSet<object>();

const storage = new AsyncLocalStorage<Collector>();
const describeStack: string[] = [];

function vibehardEnabled(): boolean {
  const dir = process.env[ENV_ARTIFACT_DIR];
  return typeof dir === "string" && dir !== "";
}

function callerLocation(): { file: string; line: number } {
  const selfPath = (() => {
    try {
      return fileURLToPath(import.meta.url);
    } catch {
      return "";
    }
  })();
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n")) {
    const match = /\(([^()]+):(\d+):(\d+)\)\s*$/.exec(line) ?? /at\s+(.+):(\d+):(\d+)\s*$/.exec(line);
    if (match === null) continue;
    let file = match[1] ?? "";
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    if (file === selfPath || file.startsWith("node:")) continue;
    if (file.includes(`${path.sep}vibehard${path.sep}dist${path.sep}`)) continue;
    if (file.includes(`${path.sep}adapters${path.sep}puppeteer${path.sep}`)) continue;
    return { file, line: Number(match[2] ?? "0") };
  }
  return { file: "unknown", line: 0 };
}

function validateOptions(opts: VibehardPageOptions): RuntimeDeclaration {
  if (!Array.isArray(opts.uses) || opts.uses.some((u) => typeof u !== "string")) {
    throw new TypeError("vibehard: test options `uses` must be an array of symbol ID strings");
  }
  if (
    opts.allowTransitive !== undefined &&
    (!Array.isArray(opts.allowTransitive) ||
      opts.allowTransitive.some((u) => typeof u !== "string"))
  ) {
    throw new TypeError("vibehard: test options `allowTransitive` must be an array of strings");
  }
  if (opts.skipVerify !== undefined && typeof opts.skipVerify !== "string") {
    throw new TypeError("vibehard: test options `skipVerify` must be a reason string");
  }
  return {
    uses: [...opts.uses],
    allowTransitive: opts.allowTransitive ?? [],
    skipVerify: opts.skipVerify ?? null,
  };
}

async function startCoverage(collector: Collector, page: PageLike): Promise<void> {
  if (collector.sessions.has(page) || collector.stopped) return;
  const session = await page.createCDPSession();
  await session.send("Profiler.enable");
  await session.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  collector.sessions.set(page, session);
}

async function snapshotPage(collector: Collector, page: PageLike): Promise<void> {
  const session = collector.sessions.get(page);
  if (session === undefined) return;
  try {
    const result = (await session.send("Profiler.takePreciseCoverage")) as {
      result?: { url?: string; functions?: V8FunctionCoverage[] }[];
    };
    const entries: RawEntry[] = [];
    for (const entry of result.result ?? []) {
      if (typeof entry.url !== "string" || !Array.isArray(entry.functions)) continue;
      // Puppeteer's own injected helpers are runtime internals.
      if (entry.url.startsWith("pptr:")) continue;
      entries.push({ url: entry.url, functions: entry.functions });
    }
    collector.snapshots.set(page, entries);
  } catch {
    // Session already gone; any earlier snapshot stands.
  }
}

async function stopPage(collector: Collector, page: PageLike): Promise<void> {
  const session = collector.sessions.get(page);
  if (session === undefined) return;
  collector.sessions.delete(page);
  await snapshotPage(collector, page);
  await session.send("Profiler.stopPreciseCoverage").catch(() => undefined);
  await session.detach?.().catch(() => undefined);
  for (const entry of collector.snapshots.get(page) ?? []) {
    collector.scripts.push(await embedCoverageEntry(entry));
  }
  collector.snapshots.delete(page);
}

/**
 * Users own the browser lifecycle, and `browser.close()` in a finally
 * block would otherwise destroy the CDP session before coverage is
 * harvested. Wrap page/browser close to snapshot coverage first
 * (precise coverage is cumulative, so the last snapshot is complete).
 */
function patchClose(target: object, snapshot: () => Promise<void>): void {
  if (patchedClosers.has(target)) return;
  const holder = target as { close?: (...args: never[]) => Promise<void> };
  const original = holder.close;
  if (typeof original !== "function") return;
  patchedClosers.add(target);
  holder.close = async (...args: never[]): Promise<void> => {
    await snapshot().catch(() => undefined);
    await original.apply(target, args);
  };
}

async function stopAll(collector: Collector): Promise<void> {
  if (collector.stopped) return;
  collector.stopped = true;
  for (const page of [...collector.sessions.keys()]) await stopPage(collector, page);
}

export type VibehardTestBody = (t: TestContext) => Promise<void> | void;

/**
 * Register a Node test-runner test with a vibehard declaration. Outside
 * a vibehard run (plain `node --test`) this is exactly `node:test`'s
 * `test`; under `vibehard verify`/`record` it also collects browser
 * coverage from pages opened via `withVibehardPage` and writes the
 * per-test artifact the verifier consumes.
 */
export function describeTest(title: string, fn: VibehardTestBody): void;
export function describeTest(
  title: string,
  opts: VibehardPageOptions,
  fn: VibehardTestBody,
): void;
export function describeTest(
  title: string,
  optsOrFn: VibehardPageOptions | VibehardTestBody,
  maybeFn?: VibehardTestBody,
): void {
  let declared: RuntimeDeclaration = { uses: null, allowTransitive: [], skipVerify: null };
  let fn: VibehardTestBody;
  if (typeof optsOrFn === "function") {
    fn = optsOrFn;
  } else {
    if (maybeFn === undefined) {
      throw new TypeError(`vibehard: test "${title}" is missing its test function`);
    }
    declared = validateOptions(optsOrFn);
    fn = maybeFn;
  }
  const location = callerLocation();
  const titlePath = [...describeStack, title];
  void nodeTest(title, async (t) => {
    if (!vibehardEnabled()) {
      await fn(t);
      return;
    }
    const collector: Collector = {
      declared: { ...declared, allowTransitive: [...declared.allowTransitive] },
      sessions: new Map(),
      snapshots: new Map(),
      scripts: [],
      stopped: false,
    };
    let status = "passed";
    const errors: string[] = [];
    let failure: unknown = null;
    try {
      await storage.run(collector, async () => {
        await fn(t);
      });
    } catch (error) {
      status = "failed";
      failure = error;
      errors.push(error instanceof Error ? error.message : String(error));
    }
    await stopAll(collector);
    const dir = process.env[ENV_ARTIFACT_DIR] ?? "";
    mkdirSync(dir, { recursive: true });
    const artifact: VibehardArtifact = {
      version: 1,
      file: location.file,
      line: location.line,
      title,
      titlePath,
      status,
      declared: collector.declared,
      clientScripts: collector.scripts,
      errors,
    };
    writeFileSync(
      path.join(dir, artifactFileName(artifact.file, artifact.line, artifact.title)),
      `${JSON.stringify(artifact)}\n`,
    );
    if (failure !== null) throw failure;
  });
}

/** Alias matching the host runner's vocabulary. */
export const test = describeTest;

/** `describe` that also tracks nesting for artifact title paths. */
export function describe(name: string, fn: () => Promise<void> | void): void {
  void nodeDescribe(name, () => {
    describeStack.push(name);
    try {
      return fn();
    } finally {
      describeStack.pop();
    }
  });
}

/**
 * Open a page with JS coverage running (CDP precise coverage — the V8
 * function-range shape the observer consumes). Must be called inside a
 * `describeTest` body while vibehard is observing; outside a vibehard
 * run it is a plain `browser.newPage()`. When `opts` carries the
 * declaration and `describeTest` did not, it becomes the test's
 * declared set; conflicting declarations are an error.
 */
export async function withVibehardPage<P>(
  browser: { newPage(): Promise<P> },
  opts?: VibehardPageOptions,
): Promise<P> {
  const page = await browser.newPage();
  if (!vibehardEnabled()) return page;
  const collector = storage.getStore();
  if (collector === undefined) {
    throw new Error(
      "vibehard: withVibehardPage must be called inside a describeTest() body so coverage can be attributed to a test",
    );
  }
  if (opts !== undefined) {
    const fromPage = validateOptions(opts);
    if (collector.declared.uses === null) {
      collector.declared = fromPage;
    } else if (JSON.stringify(collector.declared.uses) !== JSON.stringify(fromPage.uses)) {
      throw new Error(
        "vibehard: withVibehardPage `uses` conflicts with the describeTest declaration; declare the set in one place",
      );
    }
  }
  const pageLike = page as unknown as PageLike;
  await startCoverage(collector, pageLike);
  patchClose(page as unknown as object, () => snapshotPage(collector, pageLike));
  patchClose(browser as unknown as object, async () => {
    for (const p of [...collector.sessions.keys()]) await snapshotPage(collector, p);
  });
  return page;
}

/** Stop collecting coverage from a page early and close it. */
export async function closeVibehardPage(page: PageLike): Promise<void> {
  const collector = storage.getStore();
  if (collector !== undefined) await stopPage(collector, page);
  await page.close();
}

export type { VibehardTestOptions as PuppeteerTestOptions };
