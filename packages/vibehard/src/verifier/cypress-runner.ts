import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { ResolvedConfig } from "./config.js";
import { discoverStaticTests } from "./discovery.js";
import type { FrameworkDriver } from "./driver.js";
import { frameworkVersion } from "./lockfile.js";
import type { ListedTest, RunnableTestRef } from "./listed.js";
import { spawnCapture, type SpawnCaptureResult } from "./servers.js";
import { VibehardUsageError } from "./types.js";

/** Env var (Cypress.env) carrying base64url JSON: titlePaths to run. */
export const ENV_ONLY_TITLES = "VIBEHARD_ONLY";

export function encodeOnlyTitles(titlePaths: readonly (readonly string[])[]): string {
  return Buffer.from(JSON.stringify(titlePaths), "utf8").toString("base64url");
}

/** Resolve the project's Cypress CLI entry script. */
export function resolveCypressCli(rootDir: string): string {
  const req = createRequire(path.join(path.resolve(rootDir), "package.json"));
  try {
    const pkgPath = req.resolve("cypress/package.json");
    const bin = path.join(path.dirname(pkgPath), "bin", "cypress");
    if (existsSync(bin)) return bin;
  } catch {
    // fall through to .bin
  }
  const bin = path.join(path.resolve(rootDir), "node_modules", ".bin", "cypress");
  if (existsSync(bin)) return bin;
  throw new VibehardUsageError(
    `vibehard: cannot find Cypress in ${rootDir} (install cypress in the project)`,
  );
}

async function listCypressTests(
  rootDir: string,
  resolved: ResolvedConfig,
): Promise<ListedTest[]> {
  return discoverStaticTests(rootDir, resolved, {
    defaults: ["cypress/e2e", "e2e"],
    isSpec: (rel) => /\.cy\.[^.]+$/.test(rel),
    frameworkLabel: "cypress",
    discovery: {
      specifier: "vibehard/cypress",
      imports: [],
      globals: { test: ["it", "test"], describe: ["describe", "context"] },
      requireImport: false,
    },
  });
}

async function runCypress(input: {
  rootDir: string;
  resolved: ResolvedConfig;
  specs: readonly string[];
  onlyTitles: readonly (readonly string[])[] | null;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<SpawnCaptureResult> {
  const cli = resolveCypressCli(input.rootDir);
  const args = [cli, "run", "--spec", input.specs.join(",")];
  const cfg = input.resolved.config.cypress;
  if (cfg?.config !== undefined) args.push("--config-file", cfg.config);
  if (cfg?.browser !== undefined) args.push("--browser", cfg.browser);
  const env: Record<string, string> = { ...input.env };
  if (input.onlyTitles !== null) {
    args.push("--env", `${ENV_ONLY_TITLES}=${encodeOnlyTitles(input.onlyTitles)}`);
  }
  return spawnCapture(process.execPath, args, {
    cwd: input.rootDir,
    env,
    timeoutMs: input.timeoutMs,
  });
}

/** Cypress framework driver (instrumented-coverage path). */
export const cypressDriver: FrameworkDriver = {
  name: "cypress",
  missingArtifactHint:
    "is 'vibehard/cypress' registered in the support file and registerVibehardTasks wired in cypress.config?",
  version: (rootDir) => frameworkVersion(rootDir, "cypress"),
  listTests: listCypressTests,
  runSingleTest: ({ rootDir, resolved, test, env }) =>
    runCypress({
      rootDir,
      resolved,
      specs: [test.relFile],
      onlyTitles: [test.titlePath],
      env,
      timeoutMs: 600_000,
    }),
  runMany: async ({ rootDir, resolved, tests, env }) => {
    if (tests === null) {
      const all = await listCypressTests(rootDir, resolved);
      const specs = [...new Set(all.map((t) => t.relFile))].sort();
      return runCypress({ rootDir, resolved, specs, onlyTitles: null, env, timeoutMs: 1_800_000 });
    }
    const refs = tests as readonly RunnableTestRef[];
    const specs = [...new Set(refs.map((t) => t.file))].sort();
    return runCypress({
      rootDir,
      resolved,
      specs,
      onlyTitles: refs.map((t) => t.titlePath),
      env,
      timeoutMs: 1_800_000,
    });
  },
};
