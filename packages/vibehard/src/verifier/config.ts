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
  /** Stage 3 cannot attribute per-test server coverage to external apps. */
  external?: boolean;
  readyTimeoutMs?: number;
}

export interface VibehardConfig {
  framework: "playwright" | "puppeteer" | "cypress";
  app?: VibehardAppConfig;
  include?: string[];
  ignore?: string[];
  testDir?: string;
  lockfile?: string;
  playwright?: { config?: string; project?: string };
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
  if (config.framework !== "playwright") {
    throw new VibehardUsageError(
      `vibehard: framework "${config.framework}" in ${where} is not supported until Stage 6 (Stage 3 is Playwright-only)`,
    );
  }
  if (config.app !== undefined) {
    if (typeof config.app.command !== "string" || config.app.command === "") {
      throw new VibehardUsageError(`vibehard: app.command in ${where} must be a non-empty string`);
    }
    if (typeof config.app.url !== "string" || config.app.url === "") {
      throw new VibehardUsageError(`vibehard: app.url in ${where} must be a non-empty string`);
    }
    if (config.app.external === true) {
      throw new VibehardUsageError(
        "vibehard: app.external cannot be verified in Stage 3 (per-test server coverage needs Vibehard to start the app); remove external or wait for Stage 5",
      );
    }
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
