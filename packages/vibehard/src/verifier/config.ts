import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SymbolRecord } from "../index.js";
import { matchesAnyFilePattern } from "./glob.js";
import { VibehardUsageError } from "./types.js";

export interface VibehardAppConfig {
  command: string;
  args?: string[];
  url: string;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * The framework config starts the app itself (e.g. Playwright
   * `webServer`); Vibehard starts nothing for it. Per-test server
   * coverage cannot be attributed to an external app, so `external` is
   * accepted by `vibehard test` only — verify/record reject it.
   */
  external?: boolean;
  readyTimeoutMs?: number;
}

/** One extra labeled Node process (separate-backend app shape). */
export interface VibehardServerConfig extends VibehardAppConfig {
  /**
   * Label used in `{port:<name>}` substitutions, per-server
   * `VIBEHARD_<NAME>_URL` env, and diagnostics. `app` is reserved for
   * the `app` entry itself.
   */
  name: string;
}

export interface VibehardConfig {
  framework: "playwright" | "puppeteer" | "cypress";
  app?: VibehardAppConfig;
  /** Extra labeled servers started (in order) before `app`. */
  servers?: VibehardServerConfig[];
  include?: string[];
  ignore?: string[];
  testDir?: string;
  lockfile?: string;
  /** Branch whose merge-base with HEAD is the default `vibehard test` base. */
  baseBranch?: string;
  /** Behavior when selection cannot be proven safe; only "full" in v1. */
  fallback?: "full";
  playwright?: { config?: string; project?: string };
  puppeteer?: {
    /** Extra args passed to `node` before `--test` (e.g. a TS loader). */
    nodeArgs?: string[];
  };
  cypress?: {
    /** Cypress config file, relative to the project root. */
    config?: string;
    /** Browser for `cypress run` (default: Cypress's default). */
    browser?: string;
  };
  skipVerifyBudget?: number;
  /** Map browser script URLs to generated files on disk (sibling `.map`). */
  generatedScripts?: { urlEndsWith: string; path: string }[];
  /** Extra generated files/URL pathnames that count as app scripts. */
  appGeneratedPaths?: string[];
}

export interface ResolvedConfig {
  rootDir: string;
  configPath: string | null;
  config: VibehardConfig;
  baseBranch: string | undefined;
  lockfilePath: string;
  /** POSIX-relative test directory prefix, or null. */
  testDirPosix: string | null;
  include: string[];
  ignore: string[];
  skipVerifyBudget: number | undefined;
  configHash: string;
}

const CONFIG_NAMES = ["vibehard.config.json", "vibehard.config.mjs", "vibehard.config.js"];

export async function loadConfig(
  rootDir: string,
  configPath?: string,
): Promise<ResolvedConfig> {
  const root = path.resolve(rootDir);
  let found: string | null = null;
  if (configPath !== undefined) {
    found = path.resolve(root, configPath);
    if (!existsSync(found)) {
      throw new VibehardUsageError(`vibehard: config not found: ${configPath}`);
    }
  } else {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(root, name);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  const config: VibehardConfig =
    found === null ? { framework: "playwright" } : await readConfigFile(found);
  validateConfig(config, found);
  const lockfilePath = path.resolve(root, config.lockfile ?? "vibehard.lock.json");
  const testDirPosix =
    config.testDir === undefined
      ? null
      : config.testDir.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
  return {
    rootDir: root,
    configPath: found,
    config,
    baseBranch: config.baseBranch,
    lockfilePath,
    testDirPosix: testDirPosix === "" ? null : testDirPosix,
    include: config.include ?? [],
    ignore: config.ignore ?? [],
    skipVerifyBudget: config.skipVerifyBudget,
    configHash: hashConfig(config),
  };
}

async function readConfigFile(file: string): Promise<VibehardConfig> {
  if (file.endsWith(".json")) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as VibehardConfig;
    } catch (error) {
      throw new VibehardUsageError(
        `vibehard: invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: VibehardConfig };
  if (mod.default === undefined) {
    throw new VibehardUsageError(`vibehard: ${file} must default-export the config object`);
  }
  return mod.default;
}

function validateConfig(config: VibehardConfig, configPath: string | null): void {
  const where = configPath ?? "default config";
  if (config.baseBranch !== undefined && (typeof config.baseBranch !== "string" || config.baseBranch === "")) {
    throw new VibehardUsageError(`vibehard: baseBranch in ${where} must be a non-empty string`);
  }
  if (config.fallback !== undefined && config.fallback !== "full") {
    throw new VibehardUsageError(
      `vibehard: fallback "${String(config.fallback)}" in ${where} is not supported (only "full" in v1)`,
    );
  }
  if (
    config.framework !== "playwright" &&
    config.framework !== "puppeteer" &&
    config.framework !== "cypress"
  ) {
    throw new VibehardUsageError(
      `vibehard: framework "${String(config.framework)}" in ${where} is not supported (expected "playwright", "puppeteer", or "cypress")`,
    );
  }
  if (
    config.puppeteer?.nodeArgs !== undefined &&
    (!Array.isArray(config.puppeteer.nodeArgs) ||
      config.puppeteer.nodeArgs.some((a) => typeof a !== "string"))
  ) {
    throw new VibehardUsageError(`vibehard: puppeteer.nodeArgs in ${where} must be an array of strings`);
  }
  if (
    config.cypress?.config !== undefined &&
    (typeof config.cypress.config !== "string" || config.cypress.config === "")
  ) {
    throw new VibehardUsageError(`vibehard: cypress.config in ${where} must be a non-empty string`);
  }
  if (
    config.cypress?.browser !== undefined &&
    (typeof config.cypress.browser !== "string" || config.cypress.browser === "")
  ) {
    throw new VibehardUsageError(`vibehard: cypress.browser in ${where} must be a non-empty string`);
  }
  if (config.app !== undefined) validateServerFields(config.app, "app", where);
  if (config.servers !== undefined) {
    if (!Array.isArray(config.servers)) {
      throw new VibehardUsageError(`vibehard: servers in ${where} must be an array`);
    }
    const names = new Set<string>();
    for (const server of config.servers) {
      if (
        typeof server.name !== "string" ||
        !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(server.name)
      ) {
        throw new VibehardUsageError(
          `vibehard: servers[].name in ${where} must match /^[a-zA-Z][a-zA-Z0-9_-]*$/`,
        );
      }
      if (server.name === "app") {
        throw new VibehardUsageError(
          `vibehard: servers[].name "app" in ${where} is reserved for the app entry`,
        );
      }
      if (names.has(server.name)) {
        throw new VibehardUsageError(
          `vibehard: duplicate servers[].name "${server.name}" in ${where}`,
        );
      }
      names.add(server.name);
      if (server.external === true) {
        throw new VibehardUsageError(
          `vibehard: servers[name=${server.name}].external in ${where} is not supported; extra servers are always started by Vibehard`,
        );
      }
      validateServerFields(server, `servers[name=${server.name}]`, where);
    }
  }
}

function validateServerFields(
  server: VibehardAppConfig,
  label: string,
  where: string,
): void {
  if (typeof server.command !== "string" || server.command === "") {
    throw new VibehardUsageError(`vibehard: ${label}.command in ${where} must be a non-empty string`);
  }
  if (typeof server.url !== "string" || server.url === "") {
    throw new VibehardUsageError(`vibehard: ${label}.url in ${where} must be a non-empty string`);
  }
}

/** Deterministic hash of the normalized config (stable key order). */
export function hashConfig(config: VibehardConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** Apply include/ignore/testDir filtering to the indexed symbol table. */
export function filterSymbols(
  symbols: readonly SymbolRecord[],
  resolved: ResolvedConfig,
): SymbolRecord[] {
  return symbols.filter((s) => {
    if (resolved.include.length > 0 && !matchesAnyFilePattern(resolved.include, s.file)) {
      return false;
    }
    if (matchesAnyFilePattern(resolved.ignore, s.file)) return false;
    if (
      resolved.testDirPosix !== null &&
      (s.file === resolved.testDirPosix || s.file.startsWith(`${resolved.testDirPosix}/`))
    ) {
      return false;
    }
    return true;
  });
}

/** Resolve config-relative generated script paths to absolute paths. */
export function resolveGeneratedPaths(resolved: ResolvedConfig): string[] {
  const out: string[] = [];
  for (const entry of resolved.config.generatedScripts ?? []) {
    out.push(path.resolve(resolved.rootDir, entry.path));
  }
  for (const entry of resolved.config.appGeneratedPaths ?? []) {
    // Leading-slash entries are URL pathnames or absolute paths; both are
    // understood by the observer as-is.
    out.push(entry.startsWith("/") ? entry : path.resolve(resolved.rootDir, entry));
  }
  return out;
}
