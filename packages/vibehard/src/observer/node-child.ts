import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { nodeScriptsToInputs, parseNodeCoverageDir } from "./v8.js";
import type { ScriptInput } from "./types.js";

export interface SpawnWithCoverageOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Defaults to a fresh temp directory. Passed as `NODE_V8_COVERAGE`. */
  coverageDir?: string;
  /** Run `command` through a shell (shell-string app commands). */
  shell?: boolean;
  /**
   * Start a new process group so `stop()` can signal the whole group.
   * Needed with `shell` so SIGTERM reaches the Node child and its
   * `NODE_V8_COVERAGE` output flushes.
   */
  detached?: boolean;
}

export interface CoverageChild {
  process: ChildProcess;
  coverageDir: string;
  /** Everything the child wrote to stdout/stderr so far (for readiness logs). */
  output: () => string;
  /**
   * Terminate the child and collect its coverage. The child must exit
   * through Node's normal exit path for `NODE_V8_COVERAGE` to flush; a
   * server should handle `SIGTERM` by closing and calling `process.exit`.
   */
  stop: (options?: { timeoutMs?: number }) => Promise<ScriptInput[]>;
}

/** Spawn a Node child under built-in V8 coverage output. */
export function spawnWithCoverage(
  options: SpawnWithCoverageOptions,
): CoverageChild {
  const coverageDir =
    options.coverageDir ?? mkdtempSync(path.join(tmpdir(), "vibehard-cov-"));
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, NODE_V8_COVERAGE: coverageDir },
    stdio: ["ignore", "pipe", "pipe"],
    shell: options.shell ?? false,
    detached: options.detached ?? false,
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  return {
    process: child,
    coverageDir,
    output: () => output,
    stop: async ({ timeoutMs = 10_000 } = {}) => {
      if (child.exitCode === null && child.signalCode === null) {
        signalChild(child, options.detached ?? false, "SIGTERM");
        const killer = setTimeout(
          () => signalChild(child, options.detached ?? false, "SIGKILL"),
          timeoutMs,
        );
        try {
          await exited;
        } finally {
          clearTimeout(killer);
        }
      } else {
        await exited;
      }
      return nodeScriptsToInputs(parseNodeCoverageDir(coverageDir));
    },
  };
}

function signalChild(child: ChildProcess, detached: boolean, signal: NodeJS.Signals): void {
  if (detached && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone; fall through to the direct signal.
    }
  }
  child.kill(signal);
}

/**
 * Run a short-lived Node command to completion under coverage and return
 * its scripts. Rejects when the command exits non-zero.
 */
export async function runNodeWithCoverage(
  options: SpawnWithCoverageOptions,
): Promise<ScriptInput[]> {
  const child = spawnWithCoverage(options);
  const code = await new Promise<number | null>((resolve) => {
    child.process.once("exit", (exitCode) => resolve(exitCode));
  });
  const scripts = await child.stop();
  if (code !== 0) {
    throw new Error(
      `vibehard observer: covered command exited ${code ?? "by signal"}: ${options.command} ${(options.args ?? []).join(" ")}\n${child.output()}`,
    );
  }
  return scripts;
}
