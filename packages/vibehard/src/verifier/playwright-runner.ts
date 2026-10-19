import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import path from "node:path";

import { parseArtifact, type VibehardArtifact } from "../adapters/playwright/artifact.js";
import { spawnWithCoverage, type CoverageChild } from "../observer/node-child.js";
import type { ScriptInput } from "../observer/types.js";
import type { ResolvedConfig } from "./config.js";
import { VibehardUsageError } from "./types.js";

export interface ListedTest {
  /** Absolute test file path. */
  file: string;
  /** POSIX path relative to the project root. */
  relFile: string;
  line: number;
  title: string;
  /** Describe titles plus the test title. */
  titlePath: string[];
  testId: string;
}

export function makeTestId(relFile: string, titlePath: readonly string[]): string {
  return `${relFile}::${titlePath.join(" > ")}`;
}

/** Resolve the project's Playwright CLI entry (`@playwright/test` first). */
export function resolvePlaywrightCli(rootDir: string): string {
  const req = createRequire(path.join(path.resolve(rootDir), "package.json"));
  for (const pkg of ["@playwright/test/package.json", "playwright/package.json"]) {
    try {
      const pkgPath = req.resolve(pkg);
      const cli = path.join(path.dirname(pkgPath), "cli.js");
      if (existsSync(cli)) return cli;
    } catch {
      // try the next candidate
    }
  }
  const bin = path.join(path.resolve(rootDir), "node_modules", ".bin", "playwright");
  if (existsSync(bin)) return bin;
  throw new VibehardUsageError(
    `vibehard: cannot find Playwright in ${rootDir} (install @playwright/test in the project)`,
  );
}

export interface SpawnCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function spawnCapture(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): Promise<SpawnCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    const timeoutMs = options.timeoutMs ?? 120_000;
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(killer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

interface JsonSpec {
  title: string;
  file: string;
  line: number;
  tests?: { projectName?: string }[];
}
interface JsonSuite {
  title: string;
  file?: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

function collectSpecs(
  suite: JsonSuite,
  describeTitles: string[],
  out: { spec: JsonSpec; titlePath: string[] }[],
  projects: Set<string>,
): void {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      if (typeof t.projectName === "string" && t.projectName !== "") projects.add(t.projectName);
    }
    out.push({ spec, titlePath: [...describeTitles, spec.title] });
  }
  for (const child of suite.suites ?? []) {
    const titles =
      child.title === "" ? describeTitles : [...describeTitles, child.title];
    collectSpecs(child, titles, out, projects);
  }
}

/** Enumerate tests with `playwright test --list --reporter=json`. */
export async function listTests(
  rootDir: string,
  resolved: ResolvedConfig,
  cliPath: string,
): Promise<ListedTest[]> {
  const args = [cliPath, "test", "--list", "--reporter=json"];
  if (resolved.config.playwright?.config !== undefined) {
    args.push("--config", resolved.config.playwright.config);
  }
  if (resolved.config.playwright?.project !== undefined) {
    args.push("--project", resolved.config.playwright.project);
  }
  const result = await spawnCapture(process.execPath, args, { cwd: rootDir, timeoutMs: 120_000 });
  const jsonAt = result.stdout.indexOf("{");
  if (result.exitCode !== 0 || jsonAt < 0) {
    throw new VibehardUsageError(
      `vibehard: playwright test --list failed (exit ${result.exitCode})\n${result.stderr || result.stdout}`,
    );
  }
  let report: {
    suites?: JsonSuite[];
    errors?: unknown[];
    config?: { rootDir?: string; projects?: { testDir?: string }[] };
  };
  try {
    report = JSON.parse(result.stdout.slice(jsonAt)) as typeof report;
  } catch {
    throw new VibehardUsageError("vibehard: could not parse playwright --list JSON output");
  }
  // Spec `file` values are relative to the report's config rootDir (the
  // testDir), not to the project root. Try each plausible base in order.
  const fileBases = [
    report.config?.rootDir,
    ...(report.config?.projects ?? []).map((p) => p.testDir),
    resolved.testDirPosix !== null ? path.resolve(rootDir, resolved.testDirPosix) : undefined,
    rootDir,
  ].filter((b): b is string => typeof b === "string" && b !== "");
  if (Array.isArray(report.errors) && report.errors.length > 0) {
    throw new VibehardUsageError(
      `vibehard: playwright reported errors while listing tests: ${JSON.stringify(report.errors).slice(0, 500)}`,
    );
  }
  const raw: { spec: JsonSpec; titlePath: string[] }[] = [];
  const projects = new Set<string>();
  for (const suite of report.suites ?? []) collectSpecs(suite, [], raw, projects);
  if (projects.size > 1 && resolved.config.playwright?.project === undefined) {
    throw new VibehardUsageError(
      `vibehard: multiple Playwright projects found (${[...projects].sort().join(", ")}); set playwright.project in vibehard.config to the Chromium project to verify`,
    );
  }
  const tests: ListedTest[] = raw.map(({ spec, titlePath }) => {
    let abs = path.isAbsolute(spec.file) ? spec.file : path.resolve(rootDir, spec.file);
    if (!path.isAbsolute(spec.file)) {
      for (const basePath of fileBases) {
        const candidate = path.resolve(basePath, spec.file);
        if (existsSync(candidate)) {
          abs = candidate;
          break;
        }
      }
    }
    const relFile = path.relative(rootDir, abs).split(path.sep).join("/");
    // Suite chains include the file name as a pseudo-title; drop segments
    // equal to the file so titlePath is describes + test title.
    const cleanPath = titlePath.filter(
      (segment, index) =>
        !(index < titlePath.length - 1 && (segment === relFile || segment === path.basename(abs))),
    );
    return {
      file: abs,
      relFile,
      line: spec.line,
      title: spec.title,
      titlePath: cleanPath,
      testId: makeTestId(relFile, cleanPath),
    };
  });
  const seen = new Map<string, ListedTest>();
  for (const t of tests) {
    const prev = seen.get(t.testId);
    if (prev !== undefined) {
      throw new VibehardUsageError(
        `vibehard: duplicate test "${t.title}" in ${t.relFile} (lines ${prev.line} and ${t.line}); rename one so declarations stay unambiguous`,
      );
    }
    seen.set(t.testId, t);
  }
  return tests.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
}

export function readArtifacts(dir: string): VibehardArtifact[] {
  const out: VibehardArtifact[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const parsed = parseArtifact(readFileSync(path.join(dir, name), "utf8"));
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface AppServerSession {
  baseUrl: string;
  child: CoverageChild;
  stop: () => Promise<ScriptInput[]>;
}

function substitutePort(value: string, port: number): string {
  return value.split("{port}").join(String(port));
}

/**
 * Start the config `app` under V8 coverage. Readiness is a bare TCP
 * connect: an HTTP request would execute app symbols before the test
 * window and NODE_V8_COVERAGE counts are cumulative per process.
 */
export async function startAppServer(
  resolved: ResolvedConfig,
  port: number,
): Promise<AppServerSession | null> {
  const app = resolved.config.app;
  if (app === undefined) return null;
  const baseUrl = substitutePort(app.url, port).replace(/\/$/, "");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(app.env ?? {})) {
    env[key] = substitutePort(value, port);
  }
  const cwd = path.resolve(resolved.rootDir, app.cwd ?? ".");
  const child =
    app.args !== undefined
      ? spawnWithCoverage({
          command: app.command,
          args: app.args.map((a) => substitutePort(a, port)),
          cwd,
          env,
        })
      : spawnWithCoverage({ command: app.command, cwd, env, shell: true, detached: true });

  const url = new URL(baseUrl);
  const host = url.hostname;
  const tcpPort = Number(url.port !== "" ? url.port : url.protocol === "https:" ? 443 : 80);
  const deadline = Date.now() + (app.readyTimeoutMs ?? 30_000);
  for (;;) {
    if (child.process.exitCode !== null) {
      throw new VibehardUsageError(
        `vibehard: app server exited early (code ${child.process.exitCode})\n${child.output()}`,
      );
    }
    const connected = await tryConnect(host, tcpPort);
    if (connected) break;
    if (Date.now() > deadline) {
      await child.stop().catch(() => []);
      throw new VibehardUsageError(
        `vibehard: app server did not listen on ${host}:${tcpPort} in time\n${child.output()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { baseUrl, child, stop: () => child.stop() };
}

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Run exactly one test (by file:line) and return its framework result. */
export async function runSingleTest(input: {
  rootDir: string;
  cliPath: string;
  resolved: ResolvedConfig;
  test: ListedTest;
  env: Record<string, string>;
}): Promise<SpawnCaptureResult> {
  const args = [
    input.cliPath,
    "test",
    `${input.test.relFile}:${input.test.line}`,
    "--workers=1",
    "--retries=0",
    "--reporter=line",
  ];
  if (input.resolved.config.playwright?.config !== undefined) {
    args.push("--config", input.resolved.config.playwright.config);
  }
  if (input.resolved.config.playwright?.project !== undefined) {
    args.push("--project", input.resolved.config.playwright.project);
  }
  return spawnCapture(process.execPath, args, {
    cwd: input.rootDir,
    env: input.env,
    timeoutMs: 180_000,
  });
}
