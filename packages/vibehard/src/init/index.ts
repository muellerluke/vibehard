import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { VibehardConfig } from "../verifier/config.js";
import { VibehardUsageError } from "../verifier/types.js";

export interface InitProjectOptions {
  rootDir: string;
  /** Output config path (relative to rootDir or absolute). */
  outputPath?: string;
}

export interface InitDetection {
  framework: "playwright" | "puppeteer" | "cypress";
  /** "next" when the `next` dependency is present, else "generic". */
  appShape: "next" | "generic";
  next: { appRouter: boolean; pagesRouter: boolean } | null;
  /** Separate Express backend detected (dependency present). */
  express: boolean;
  testDir: string;
}

export interface InitProjectResult {
  rootDir: string;
  alreadyWired: boolean;
  /** Absolute path of the config found (alreadyWired) or written. */
  configPath: string;
  written: boolean;
  detection: InitDetection | null;
  /** The config written, or null when already wired. */
  config: VibehardConfig | null;
  /** Manual wiring steps the user still has to apply. */
  instructions: string[];
}

const CONFIG_NAMES = ["vibehard.config.json", "vibehard.config.mjs", "vibehard.config.js"];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(root: string): PackageJson {
  const file = path.join(root, "package.json");
  if (!existsSync(file)) {
    throw new VibehardUsageError(
      `vibehard init: no package.json in ${root} (run init at the project root)`,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
  } catch (error) {
    throw new VibehardUsageError(
      `vibehard init: invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isDir(root: string, rel: string): boolean {
  try {
    return statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

function detectTestDir(root: string, framework: InitDetection["framework"]): string {
  if (framework === "playwright") {
    for (const name of ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"]) {
      const file = path.join(root, name);
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const match = /testDir:\s*["']([^"']+)["']/.exec(text);
      if (match?.[1] !== undefined) {
        return match[1].replace(/^\.\//, "").replace(/\/$/, "");
      }
    }
  }
  const candidates =
    framework === "cypress" ? ["cypress/e2e", "e2e", "tests"] : ["e2e", "tests", "test"];
  for (const candidate of candidates) {
    if (isDir(root, candidate)) return candidate;
  }
  return framework === "cypress" ? "cypress/e2e" : "e2e";
}

const FRAMEWORK_LABEL: Record<InitDetection["framework"], string> = {
  playwright: "Playwright",
  puppeteer: "Puppeteer",
  cypress: "Cypress",
};

function detect(root: string, pkg: PackageJson): InitDetection {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (name: string): boolean => deps[name] !== undefined;
  const framework: InitDetection["framework"] | null =
    has("@playwright/test") || has("playwright")
      ? "playwright"
      : has("puppeteer") || has("puppeteer-core")
        ? "puppeteer"
        : has("cypress")
          ? "cypress"
          : null;
  if (framework === null) {
    throw new VibehardUsageError(
      "vibehard init: no e2e framework found in package.json (install @playwright/test, puppeteer, or cypress first)",
    );
  }
  const isNext = has("next");
  return {
    framework,
    appShape: isNext ? "next" : "generic",
    next: isNext
      ? {
          appRouter: isDir(root, "src/app") || isDir(root, "app"),
          pagesRouter: isDir(root, "src/pages") || isDir(root, "pages"),
        }
      : null,
    express: has("express"),
    testDir: detectTestDir(root, framework),
  };
}

function buildConfig(detection: InitDetection): VibehardConfig {
  const config: VibehardConfig = {
    framework: detection.framework,
    testDir: detection.testDir,
    ...(detection.framework === "playwright"
      ? { playwright: { project: "chromium" } }
      : {}),
  };
  if (detection.appShape === "next") {
    config.app = {
      command: "node",
      args: ["node_modules/next/dist/bin/next", "start", "-p", "{port}", "-H", "127.0.0.1"],
      url: "http://127.0.0.1:{port}",
      readyTimeoutMs: 60_000,
    };
    config.ignore = ["next-env.d.ts"];
  } else {
    config.app = {
      command: "TODO: your app start command (it must listen on the port in app.url)",
      url: "http://127.0.0.1:{port}",
    };
  }
  if (detection.express) {
    config.servers = [
      {
        name: "api",
        command: "node",
        args: ["TODO: path to your built API server (built with source maps)"],
        url: "http://127.0.0.1:{port}",
        env: { PORT: "{port}" },
      },
    ];
    if (config.app !== undefined) {
      config.app.env = {
        ...(config.app.env ?? {}),
        API_URL: "http://127.0.0.1:{port:api}",
      };
    }
  }
  return config;
}

function buildInstructions(detection: InitDetection, configRel: string): string[] {
  const steps: string[] = [`Wrote ${configRel}. Review it, then finish the wiring:`];
  if (detection.framework === "playwright") {
    steps.push(
      "1. In your specs, import { test, expect } from 'vibehard/playwright' instead of '@playwright/test'. Existing test bodies stay unchanged; plain `playwright test` runs are unaffected.",
      "2. In playwright.config, set use.baseURL to process.env['VIBEHARD_BASE_URL'] ?? '<your usual dev url>' so vibehard can point tests at the server it starts.",
    );
  } else if (detection.framework === "puppeteer") {
    steps.push(
      "1. In your specs (Node's built-in test runner is the host), register tests with describeTest from 'vibehard/puppeteer' and open pages with withVibehardPage(browser) so coverage starts before navigation. Existing test bodies stay unchanged; plain `node --test` runs are unaffected.",
      "2. Read the app origin from process.env['VIBEHARD_BASE_URL'] ?? '<your usual dev url>' so vibehard can point tests at the server it starts. Test leaf titles must be unique per file (single tests are selected by title).",
    );
  } else {
    steps.push(
      "1. In cypress/support/e2e, import { registerVibehardSupport } from 'vibehard/cypress' and call it. In cypress.config setupNodeEvents, call registerVibehardTasks(on) from 'vibehard/cypress/node'. Specs need no vibehard code: `vibehard record` maps what each test touches. Plain `cypress run` is unaffected.",
      "2. Set e2e.baseUrl to process.env['VIBEHARD_BASE_URL'] ?? '<your usual dev url>' in cypress.config so vibehard can point tests at the server it starts.",
      "3. Instrument the app build with Istanbul (e.g. babel-plugin-istanbul or nyc) so window.__coverage__ exists in the browser — Cypress has no V8 range API, and a visited page without it fails verification closed. For Next.js, copy the examples/next-cypress setup (.babelrc env + `next build --webpack` + forced server source maps).",
    );
  }
  if (detection.appShape === "next") {
    steps.push(
      "- In next.config, set productionBrowserSourceMaps: true. Vibehard verifies against the production build (next build, then the app command runs next start); without browser source maps it fails closed. Dev-server (next dev) output is not verifiable.",
      "- Routes must render per request to be observed: prerendered (static) routes execute at build time, not during tests. Add export const dynamic = 'force-dynamic' (App Router) or getServerSideProps (Pages Router) to routes under test.",
      "- If this project is an npm-workspaces member with hoisted dependencies, node_modules/next may live at the workspace root: point app.args at the real next bin (or a small resolver script), keeping `node` as the direct parent so coverage flushes on shutdown. An existing instrumentation.ts register() is left untouched; Vibehard does not need it.",
      "- Build once (next build), then run `vibehard record` to map each test's touched symbols into vibehard.lock.json, and commit the lockfile.",
    );
  } else {
    steps.push(
      "- Replace the TODO app.command in the config with your production app start (built with source maps end to end; unmapped executed code fails verification closed). Use {port} where the assigned port belongs.",
      "- Build your app, then run `vibehard record` to map each test's touched symbols into vibehard.lock.json, and commit the lockfile.",
    );
  }
  if (detection.express) {
    steps.push(
      "Separate backend: replace the TODO in servers[api].args with your built API server path (bundle/compile it with source maps, e.g. esbuild --sourcemap). Vibehard starts it before the app, substitutes {port:api} (already wired as API_URL), and merges its server coverage into each test's observed set. Make sure the API exits through Node's normal exit path on SIGTERM (server.close + process.exit) so coverage flushes.",
    );
  }
  steps.push(
    detection.framework === "playwright"
      ? "If Playwright's own webServer already starts your app, set app.external: true and a literal app.url: `vibehard test` selection works with it, but verify/record still need Vibehard to start the app (per-test coverage windows)."
      : "If your own test setup already starts the app, set app.external: true and a literal app.url: `vibehard test` selection works with it, but verify/record still need Vibehard to start the app (per-test coverage windows).",
  );
  return steps;
}

/**
 * Detect framework + app shape and write `vibehard.config.json`.
 * Never overwrites an existing config: an already-wired project is
 * reported and left byte-identical.
 */
export function initProject(options: InitProjectOptions): InitProjectResult {
  const root = path.resolve(options.rootDir);
  const outputPath =
    options.outputPath !== undefined
      ? path.resolve(root, options.outputPath)
      : path.join(root, "vibehard.config.json");

  const existing =
    options.outputPath !== undefined
      ? existsSync(outputPath)
        ? outputPath
        : null
      : (CONFIG_NAMES.map((n) => path.join(root, n)).find((p) => existsSync(p)) ?? null);
  if (existing !== null) {
    return {
      rootDir: root,
      alreadyWired: true,
      configPath: existing,
      written: false,
      detection: null,
      config: null,
      instructions: [
        `Already wired: ${path.relative(root, existing)} exists and was left unchanged. Next: build your app, then run \`vibehard record\` or \`vibehard verify\`.`,
      ],
    };
  }

  const pkg = readPackageJson(root);
  const detection = detect(root, pkg);
  const config = buildConfig(detection);
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    rootDir: root,
    alreadyWired: false,
    configPath: outputPath,
    written: true,
    detection,
    config,
    instructions: buildInstructions(detection, path.relative(root, outputPath)),
  };
}

/** Human-readable report for the CLI (no --json). */
export function formatInitReport(result: InitProjectResult): string {
  const lines: string[] = [];
  if (result.alreadyWired) {
    lines.push(`vibehard init: already wired (${result.configPath})`);
  } else if (result.detection !== null) {
    const d = result.detection;
    const shape =
      d.appShape === "next"
        ? `Next.js (${[
            d.next?.appRouter ? "App Router" : null,
            d.next?.pagesRouter ? "Pages Router" : null,
          ]
            .filter((s) => s !== null)
            .join(" + ") || "no app/pages dir found"})`
        : "generic app";
    lines.push(
      `vibehard init: detected ${FRAMEWORK_LABEL[d.framework]} + ${shape}${d.express ? " + Express backend" : ""}; testDir "${d.testDir}"`,
    );
    lines.push(`wrote ${result.configPath}`);
  }
  lines.push(...result.instructions);
  return `${lines.join("\n")}\n`;
}
