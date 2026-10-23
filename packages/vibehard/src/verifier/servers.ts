import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import path from "node:path";

import { spawnWithCoverage, type CoverageChild } from "../observer/node-child.js";
import type { ScriptInput } from "../observer/types.js";
import type { ResolvedConfig } from "./config.js";
import { VibehardUsageError } from "./types.js";

export interface SpawnCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnCaptureOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Written to the child's stdin, which is then closed. */
  input?: string | Buffer;
}

export function spawnCapture(
  command: string,
  args: string[],
  options: SpawnCaptureOptions,
): Promise<SpawnCaptureResult> {
  return spawnCaptureRaw(command, args, options).then(({ exitCode, stdout, stderr }) => ({
    exitCode,
    stdout: stdout.toString("utf8"),
    stderr,
  }));
}

export interface SpawnCaptureBufferResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

/** Like `spawnCapture`, but stdout stays binary (never decoded). */
export function spawnCaptureBuffer(
  command: string,
  args: string[],
  options: SpawnCaptureOptions,
): Promise<SpawnCaptureBufferResult> {
  return spawnCaptureRaw(command, args, options);
}

function spawnCaptureRaw(
  command: string,
  args: string[],
  options: SpawnCaptureOptions,
): Promise<SpawnCaptureBufferResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdoutChunks.push(c);
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
      resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdoutChunks), stderr });
    });
    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });
}

/**
 * Ports handed out by `freePort` that no listener has claimed yet.
 * Probing closes the socket before the real server binds, so without
 * this registry two concurrent lanes could be handed the same port.
 * `startServers` releases its ports once its servers are listening
 * (the OS then keeps them unavailable); other callers may release
 * explicitly with `releasePort` once their own listener is up.
 */
const reservedPorts = new Set<number>();

function probePort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const found = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(found === 0 ? null : found));
    });
  });
}

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // The first probe asks the OS for any ephemeral port. If it offers
    // one another lane has reserved, probe an explicit random port
    // instead of asking again (the OS may offer the same port twice).
    const candidate =
      attempt === 0 ? await probePort(0) : await probePort(20_000 + Math.floor(Math.random() * 40_000));
    if (candidate === null || reservedPorts.has(candidate)) continue;
    reservedPorts.add(candidate);
    return candidate;
  }
  throw new VibehardUsageError("vibehard: could not find a free TCP port");
}

/** Release a `freePort` reservation (its listener is up, or abandoned). */
export function releasePort(port: number): void {
  reservedPorts.delete(port);
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
/**
 * Server starts are serialized process-wide: between a port probe and
 * the child actually listening there is a window where the port looks
 * free, and parallel record lanes must not allocate inside another
 * lane's window. Test execution itself is not serialized — the lock
 * ends as soon as every server in the session accepts connections.
 */
let startChain: Promise<unknown> = Promise.resolve();

function withStartLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = startChain.then(fn, fn);
  startChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function startServers(
  resolved: ResolvedConfig,
  fixedPorts: Readonly<Record<string, number>> = {},
): Promise<ServersSession> {
  return withStartLock(() => startServersLocked(resolved, fixedPorts));
}

async function startServersLocked(
  resolved: ResolvedConfig,
  fixedPorts: Readonly<Record<string, number>>,
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
      for (const port of Object.values(ports)) releasePort(port);
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
    for (const port of Object.values(ports)) releasePort(port);
    throw error;
  }
  // Every server is listening now, so the OS keeps these ports busy
  // and the `freePort` reservations can go.
  for (const port of Object.values(ports)) releasePort(port);
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
