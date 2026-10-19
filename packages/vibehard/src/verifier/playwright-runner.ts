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

/** Shared `--config`/`--project` tail for every Playwright invocation. */
export function playwrightTailArgs(resolved: ResolvedConfig): string[] {
  const args: string[] = [];
  if (resolved.config.playwright?.config !== undefined) {
    args.push("--config", resolved.config.playwright.config);
  }
  if (resolved.config.playwright?.project !== undefined) {
    args.push("--project", resolved.config.playwright.project);
  }
  return args;
}

/** Enumerate tests with `playwright test --list --reporter=json`. */
export async function listTests(
  rootDir: string,
  resolved: ResolvedConfig,
  cliPath: string,
  positionals: readonly string[] = [],
): Promise<ListedTest[]> {
  const args = [
    cliPath,
    "test",
    ...positionals,
    "--list",
    "--reporter=json",
    ...playwrightTailArgs(resolved),
  ];
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

/** All config servers (`servers` in order, then `app`) under coverage. */
export interface ServersSession {
  /** Substituted `app.url` (also for an `external` app), or null without app. */
  baseUrl: string | null;
  /** Substituted URL per server label: `app` plus each `servers[].name`. */
  urls: Record<string, string>;
  /** Test-run env: `VIBEHARD_BASE_URL` plus `VIBEHARD_<NAME>_URL` per server. */
  env: Record<string, string>;
  children: CoverageChild[];
  /** Stop every started server (reverse order) and merge their coverage. */
  stop: () => Promise<ScriptInput[]>;
}

interface ServerEntry {
  name: string;
  config: ResolvedConfig["config"]["app"];
}

function substitutePorts(
  value: string,
  ownName: string,
  ports: Readonly<Record<string, number>>,
): string {
  const named = value.replace(/\{port:([a-zA-Z][a-zA-Z0-9_-]*)\}/g, (_m, name: string) => {
    const port = ports[name];
    if (port === undefined) {
      throw new VibehardUsageError(
        `vibehard: {port:${name}} in server "${ownName}" config names an unknown server (known: ${Object.keys(ports).sort().join(", ") || "none"})`,
      );
    }
    return String(port);
  });
  const own = ports[ownName];
  return own === undefined ? named : named.split("{port}").join(String(own));
}

function serverEntries(resolved: ResolvedConfig): ServerEntry[] {
  const entries: ServerEntry[] = (resolved.config.servers ?? []).map((s) => ({
    name: s.name,
    config: s,
  }));
  const app = resolved.config.app;
  if (app !== undefined && app.external !== true) entries.push({ name: "app", config: app });
  return entries;
}

async function startEntry(
  resolved: ResolvedConfig,
  entry: ServerEntry,
  ports: Readonly<Record<string, number>>,
): Promise<{ url: string; child: CoverageChild }> {
  const cfg = entry.config;
  if (cfg === undefined) throw new VibehardUsageError(`vibehard: server "${entry.name}" has no config`);
  const baseUrl = substitutePorts(cfg.url, entry.name, ports).replace(/\/$/, "");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg.env ?? {})) {
    env[key] = substitutePorts(value, entry.name, ports);
  }
  const cwd = path.resolve(resolved.rootDir, cfg.cwd ?? ".");
  const child =
    cfg.args !== undefined
      ? spawnWithCoverage({
          command: substitutePorts(cfg.command, entry.name, ports),
          args: cfg.args.map((a) => substitutePorts(a, entry.name, ports)),
          cwd,
          env,
        })
      : spawnWithCoverage({ command: cfg.command, cwd, env, shell: true, detached: true });

  const url = new URL(baseUrl);
  const host = url.hostname;
  const tcpPort = Number(url.port !== "" ? url.port : url.protocol === "https:" ? 443 : 80);
  const deadline = Date.now() + (cfg.readyTimeoutMs ?? 30_000);
  for (;;) {
    if (child.process.exitCode !== null) {
      throw new VibehardUsageError(
        `vibehard: server "${entry.name}" exited early (code ${child.process.exitCode})\n${child.output()}`,
      );
    }
    const connected = await tryConnect(host, tcpPort);
    if (connected) break;
    if (Date.now() > deadline) {
      await child.stop().catch(() => []);
      throw new VibehardUsageError(
        `vibehard: server "${entry.name}" did not listen on ${host}:${tcpPort} in time\n${child.output()}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url: baseUrl, child };
}

/**
 * Start every config server under V8 coverage: `servers` in order, then
 * `app` (unless `external`). Each entry gets its own free port; `{port}`
 * in an entry's command/args/env/url is its own port and `{port:<name>}`
 * is another entry's. Readiness is a bare TCP connect: an HTTP request
 * would execute app symbols before the test window and
 * NODE_V8_COVERAGE counts are cumulative per process. Coverage from
 * every process (including workers a server itself spawns, which
 * inherit NODE_V8_COVERAGE) is merged on stop.
 */
export async function startServers(
  resolved: ResolvedConfig,
  fixedPorts: Readonly<Record<string, number>> = {},
): Promise<ServersSession> {
  const entries = serverEntries(resolved);
  const ports: Record<string, number> = {};
  for (const entry of entries) {
    ports[entry.name] = fixedPorts[entry.name] ?? (await freePort());
  }
  const urls: Record<string, string> = {};
  const app = resolved.config.app;
  if (app !== undefined && app.external === true) {
    if (app.url.includes("{port}")) {
      throw new VibehardUsageError(
        "vibehard: app.url contains {port} but app is external (Vibehard assigns no port to an external app); use a literal URL or {port:<server>}",
      );
    }
    urls["app"] = substitutePorts(app.url, "app", ports).replace(/\/$/, "");
  }
  const started: CoverageChild[] = [];
  const stopStarted = async (): Promise<ScriptInput[]> => {
    const scripts: ScriptInput[] = [];
    for (const child of [...started].reverse()) {
      scripts.push(...(await child.stop().catch(() => [])));
    }
    started.length = 0;
    return scripts;
  };
  try {
    for (const entry of entries) {
      const { url, child } = await startEntry(resolved, entry, ports);
      urls[entry.name] = url;
      started.push(child);
    }
  } catch (error) {
    await stopStarted().catch(() => []);
    throw error;
  }
  const baseUrl = urls["app"] ?? null;
  const env: Record<string, string> = {};
  if (baseUrl !== null) env["VIBEHARD_BASE_URL"] = baseUrl;
  for (const [name, url] of Object.entries(urls)) {
    env[`VIBEHARD_${name.toUpperCase().replace(/-/g, "_")}_URL`] = url;
  }
  return { baseUrl, urls, env, children: started, stop: stopStarted };
}

/**
 * Start the config `app` under V8 coverage on a caller-allocated port.
 * Kept for compatibility; `startServers` covers app + extra servers.
 */
export async function startAppServer(
  resolved: ResolvedConfig,
  port: number,
): Promise<AppServerSession | null> {
  if (resolved.config.app === undefined) return null;
  const session = await startServers(resolved, { app: port });
  const child = session.children[session.children.length - 1];
  if (session.baseUrl === null || child === undefined) {
    await session.stop().catch(() => []);
    return null;
  }
  return { baseUrl: session.baseUrl, child, stop: () => session.stop() };
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
  args.push(...playwrightTailArgs(input.resolved));
  return spawnCapture(process.execPath, args, {
    cwd: input.rootDir,
    env: input.env,
    timeoutMs: 180_000,
  });
}

/**
 * Run Playwright plainly (no observation) for the given positionals:
 * an empty list runs the full suite, `file:line` entries run exactly
 * those tests. The project's own reporters and parallelism apply.
 */
export async function runPlaywrightTests(input: {
  rootDir: string;
  cliPath: string;
  resolved: ResolvedConfig;
  positionals: readonly string[];
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<SpawnCaptureResult> {
  const args = [
    input.cliPath,
    "test",
    ...input.positionals,
    ...playwrightTailArgs(input.resolved),
  ];
  return spawnCapture(process.execPath, args, {
    cwd: input.rootDir,
    env: input.env,
    timeoutMs: input.timeoutMs ?? 1_800_000,
  });
}
