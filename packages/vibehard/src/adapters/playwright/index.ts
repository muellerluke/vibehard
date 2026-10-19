import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { test as base, expect } from "@playwright/test";
import type { BrowserContext, Page, PlaywrightTestArgs, TestInfo } from "@playwright/test";

import type { ScriptInput } from "../../observer/types.js";
import { embedCoverageEntry } from "../shared-coverage.js";
import type { VibehardTestOptions } from "../../verifier/types.js";
import {
  ENV_ARTIFACT_DIR,
  VIBEHARD_ANNOTATION_TYPE,
  artifactFileName,
  decodeDeclaration,
  encodeDeclaration,
  type VibehardArtifact,
} from "./artifact.js";

export { expect };
export type { VibehardArtifact };
export type { VibehardTestOptions } from "../../verifier/types.js";
export {
  ENV_ARTIFACT_DIR,
  ENV_BASE_URL,
  ENV_RESOLVE_MAP,
  VIBEHARD_ANNOTATION_TYPE,
  artifactFileName,
  decodeDeclaration,
  encodeDeclaration,
  parseArtifact,
} from "./artifact.js";

/** Kept from Stage 0: identity helper for building shared declaration groups. */
export function defineUses(opts: VibehardTestOptions): VibehardTestOptions {
  return opts;
}

type TestBody = (args: PlaywrightTestArgs, testInfo: TestInfo) => Promise<void> | void;

interface VibehardCallable {
  (title: string, fn: TestBody): void;
  (title: string, opts: VibehardTestOptions, fn: TestBody): void;
}

type BaseTest = typeof base;

/** The vibehard Playwright `test`: base test plus declaration-aware calls. */
export type VibehardTest = VibehardCallable &
  Pick<
    BaseTest,
    | "describe"
    | "use"
    | "beforeAll"
    | "afterAll"
    | "beforeEach"
    | "afterEach"
    | "step"
    | "skip"
    | "fixme"
    | "fail"
    | "slow"
    | "setTimeout"
    | "info"
    | "extend"
  > & { only: VibehardCallable };

interface Collector {
  active: Set<Page>;
  scripts: ScriptInput[];
  stopped: boolean;
}

function vibehardEnabled(): boolean {
  const dir = process.env[ENV_ARTIFACT_DIR];
  return typeof dir === "string" && dir !== "";
}

async function startOnPage(collector: Collector, page: Page): Promise<void> {
  if (collector.active.has(page) || collector.stopped) return;
  if (page.coverage === null) {
    throw new Error(
      "vibehard: page has no coverage API (Chromium required for JS coverage; verification is Chromium-only in v1)",
    );
  }
  collector.active.add(page);
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
}

async function stopAll(collector: Collector): Promise<void> {
  if (collector.stopped) return;
  collector.stopped = true;
  for (const page of collector.active) {
    try {
      if (page.coverage === null) continue;
      const entries = await page.coverage.stopJSCoverage();
      for (const entry of entries) collector.scripts.push(await embedCoverageEntry(entry));
    } catch {
      // Page/context already closed; entries for it are lost and the
      // observed set will be short — verification reports the diff.
    }
  }
  collector.active.clear();
}

const extended = base.extend<{ _vhCollector: Collector; _vhFinish: void }>({
  _vhCollector: async ({}, use) => {
    const collector: Collector = { active: new Set(), scripts: [], stopped: false };
    await use(collector);
  },
  context: async ({ context, _vhCollector }, use) => {
    if (!vibehardEnabled()) {
      await use(context);
      return;
    }
    const onPage = (page: Page): void => {
      void startOnPage(_vhCollector, page).catch(() => undefined);
    };
    (context as BrowserContext).on("page", onPage);
    for (const page of (context as BrowserContext).pages()) onPage(page);
    await use(context);
    await stopAll(_vhCollector);
  },
  _vhFinish: [
    async ({ _vhCollector }, use, testInfo) => {
      await use();
      if (!vibehardEnabled()) return;
      await stopAll(_vhCollector);
      const dir = process.env[ENV_ARTIFACT_DIR] ?? "";
      mkdirSync(dir, { recursive: true });
      const artifact: VibehardArtifact = {
        version: 1,
        file: testInfo.file,
        line: testInfo.line,
        title: testInfo.title,
        titlePath: [...testInfo.titlePath],
        status: testInfo.status ?? "unknown",
        declared: decodeDeclaration(testInfo.annotations),
        clientScripts: _vhCollector.scripts,
        errors: testInfo.errors.map((e) => e.message ?? String(e)).filter((s) => s !== ""),
      };
      writeFileSync(
        path.join(dir, artifactFileName(artifact.file, artifact.line, artifact.title)),
        `${JSON.stringify(artifact)}\n`,
      );
    },
    { auto: true },
  ],
});

function validateOptions(opts: VibehardTestOptions): VibehardTestOptions {
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
  return opts;
}

type BaseCallable = (
  title: string,
  details: { annotation: { type: string; description: string } },
  fn: TestBody,
) => void;

/**
 * Playwright derives a test's location from the direct caller of its
 * internal location-wrapped `test()` (stack frame 1 at capture time).
 * Delegating naively would attribute every vibehard test to this file.
 * Shifting `captureStackTrace` to start below Playwright's own frame
 * makes frame 1 the spec file that called the vibehard wrapper. The
 * delegation must stay in this function: any helper frame in between
 * becomes the attributed location instead.
 */
function wrapCallable(callable: BaseCallable): VibehardCallable {
  const wrapped = (
    title: string,
    optsOrFn: VibehardTestOptions | TestBody,
    maybeFn?: TestBody,
  ): void => {
    let opts: VibehardTestOptions | null;
    let fn: TestBody;
    if (typeof optsOrFn === "function") {
      opts = null;
      fn = optsOrFn;
    } else {
      if (maybeFn === undefined) {
        throw new TypeError(`vibehard: test "${title}" is missing its test function`);
      }
      opts = validateOptions(optsOrFn);
      fn = maybeFn;
    }
    const original = Error.captureStackTrace;
    Error.captureStackTrace = (target: object): void => {
      original.call(Error, target, callable as unknown as (...args: never[]) => unknown);
    };
    try {
      callable(
        title,
        { annotation: { type: VIBEHARD_ANNOTATION_TYPE, description: encodeDeclaration(opts) } },
        fn,
      );
    } finally {
      Error.captureStackTrace = original;
    }
  };
  return wrapped as VibehardCallable;
}

const wrappedTest = Object.assign(
  wrapCallable(extended as unknown as BaseCallable),
  extended,
  { only: wrapCallable(extended.only as unknown as BaseCallable) },
);

export const test = wrappedTest as unknown as VibehardTest;
