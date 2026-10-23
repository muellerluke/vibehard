#!/usr/bin/env node

import { realpathSync } from "node:fs";

import { formatInitReport, initProject } from "../init/index.js";
import {
  explainProject,
  formatExplainReport,
  formatTestReport,
  testProject,
} from "../selector/index.js";
import { timingEnabled } from "../timing.js";
import {
  VibehardUsageError,
  formatVerifyReport,
  recordProject,
  verifyProject,
} from "../verifier/index.js";

import { version as VERSION } from "../../package.json";

export const COMMANDS = ["init", "record", "verify", "test", "explain"] as const;
export type Command = (typeof COMMANDS)[number];

const STUB_STAGE: Partial<Record<Command, string>> = {};

const HELP = `vibehard — exact e2e test selection

Usage: vibehard <command> [options]

Commands:
  init      Detect framework/app shape, write vibehard.config
  record    Run tests under observation, (re)write touched sets in the lockfile
  verify    Run tests under observation, fail on touched-set drift
  test      Select and run only tests affected by the change
  explain   Show the recorded touched set for a test or symbol

Options:
  --help       Print this help
  --version    Print version
  --json       Machine-readable output (every command)
  --ci         verify: check the lockfile without writing; enforce alwaysRun budget
  --config     Path to vibehard.config (record/verify/test/explain;
               for init, the output path to write)
  --base <ref> test: compare the working tree against this ref (default:
               merge-base with the configured baseBranch, else HEAD)
  --all        test: skip selection and run the full suite
  --dry-run    test: print the selected tests and reasons without running
  --timing     record/verify/test: report phase timings
               (or set VIBEHARD_PROFILE=1)
  --fast-select test/explain: diff-proportional selection without a
               full index (or set VIBEHARD_FAST_SELECT=1); falls back
               to full indexing on any inconsistency
  --jobs <n>   record/verify: observe up to <n> tests concurrently
               (default 1; the app must tolerate <n> instances)

record and verify accept optional filter arguments matched against
test file paths and titles. explain takes one test filter or symbol ID
(<file>#<qualified-name>) argument.

Exit codes: 0 pass, 1 test failure (framework), 2 verification drift,
3 usage/config error, not implemented yet, or unsafe selection under
--dry-run. Without --dry-run an unsafe selection runs the full suite.
`;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  argv: string[],
  options: { cwd?: string } = {},
): Promise<CliResult> {
  const json = argv.includes("--json");
  const ci = argv.includes("--ci");
  const all = argv.includes("--all");
  const dryRun = argv.includes("--dry-run");
  const timingFlag = argv.includes("--timing");
  const timing = timingFlag || timingEnabled(undefined);
  const fastSelectFlag = argv.includes("--fast-select");
  const jobsFlag = argv.includes("--jobs") || argv.some((a) => a.startsWith("--jobs="));
  let configPath: string | undefined;
  let baseRef: string | undefined;
  let jobsRaw: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (
      arg === "--json" ||
      arg === "--ci" ||
      arg === "--all" ||
      arg === "--dry-run" ||
      arg === "--timing" ||
      arg === "--fast-select"
    ) {
      continue;
    }
    if (arg === "--config" || arg === "--base" || arg === "--jobs") {
      const value = argv[i + 1];
      if (arg === "--config") configPath = value;
      else if (arg === "--base") baseRef = value;
      else jobsRaw = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      continue;
    }
    if (arg.startsWith("--base=")) {
      baseRef = arg.slice("--base=".length);
      continue;
    }
    if (arg.startsWith("--jobs=")) {
      jobsRaw = arg.slice("--jobs=".length);
      continue;
    }
    args.push(arg);
  }
  const [cmd, ...rest] = args;

  const ok = (text: string): CliResult =>
    json
      ? { exitCode: 0, stdout: JSON.stringify({ ok: true, version: VERSION, help: text }), stderr: "" }
      : { exitCode: 0, stdout: text, stderr: "" };
  const fail = (exitCode: number, message: string, command?: string): CliResult =>
    json
      ? {
          exitCode,
          stdout: "",
          stderr: JSON.stringify({
            ok: false,
            error: message,
            ...(command !== undefined ? { command } : {}),
          }),
        }
      : { exitCode, stdout: "", stderr: `${message}\n` };

  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") return ok(HELP);
  if (cmd === "--version" || cmd === "-v") {
    return json
      ? { exitCode: 0, stdout: JSON.stringify({ ok: true, version: VERSION }), stderr: "" }
      : { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }

  if (cmd === "init") {
    if (jobsFlag) {
      return fail(3, "vibehard init: unknown option --jobs", cmd);
    }
    if (timingFlag) {
      return fail(3, "vibehard init: unknown option --timing", cmd);
    }
    if (fastSelectFlag) {
      return fail(3, "vibehard init: unknown option --fast-select", cmd);
    }
    if (rest.some((a) => a.startsWith("-"))) {
      return fail(3, `vibehard init: unknown option ${rest.find((a) => a.startsWith("-"))}`, cmd);
    }
    if (rest.length > 0) {
      return fail(3, `vibehard init: unexpected argument ${rest[0]}`, cmd);
    }
    try {
      const result = initProject({
        rootDir: options.cwd ?? process.cwd(),
        ...(configPath !== undefined ? { outputPath: configPath } : {}),
      });
      return {
        exitCode: 0,
        stdout: json ? JSON.stringify({ ...result, command: cmd }) : formatInitReport(result),
        stderr: "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof VibehardUsageError ? error.exitCode : 3;
      return fail(code, message.startsWith("vibehard:") ? message : `vibehard init: ${message}`, cmd);
    }
  }

  if (cmd === "record" || cmd === "verify") {
    if (fastSelectFlag) {
      return fail(3, `vibehard ${cmd}: unknown option --fast-select`, cmd);
    }
    let jobs: number | undefined;
    if (jobsFlag) {
      jobs = Number(jobsRaw);
      if (jobsRaw === undefined || jobsRaw === "" || !Number.isInteger(jobs) || jobs < 1) {
        return fail(3, `vibehard ${cmd}: --jobs must be a positive integer (got ${jobsRaw ?? ""})`, cmd);
      }
    }
    if (rest.some((a) => a.startsWith("-"))) {
      return fail(3, `vibehard ${cmd}: unknown option ${rest.find((a) => a.startsWith("-"))}`, cmd);
    }
    try {
      const run = cmd === "record" ? recordProject : verifyProject;
      const result = await run({
        rootDir: options.cwd ?? process.cwd(),
        ...(configPath !== undefined ? { configPath } : {}),
        ...(rest.length > 0 ? { filter: rest } : {}),
        ...(jobs !== undefined ? { jobs } : {}),
        ci: cmd === "verify" && ci,
        timing,
      });
      return {
        exitCode: result.exitCode,
        stdout: json
          ? JSON.stringify({ ...result, command: cmd })
          : formatVerifyReport(result),
        stderr: "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof VibehardUsageError ? error.exitCode : 3;
      return fail(code, message.startsWith("vibehard:") ? message : `vibehard ${cmd}: ${message}`, cmd);
    }
  }

  if (cmd === "test") {
    if (jobsFlag) {
      return fail(3, "vibehard test: unknown option --jobs", cmd);
    }
    if (rest.some((a) => a.startsWith("-"))) {
      return fail(3, `vibehard test: unknown option ${rest.find((a) => a.startsWith("-"))}`, cmd);
    }
    if (rest.length > 0) {
      return fail(3, `vibehard test: unexpected argument ${rest[0]}`, cmd);
    }
    if ((argv.includes("--base") || argv.some((a) => a.startsWith("--base="))) && (baseRef === undefined || baseRef === "")) {
      return fail(3, "vibehard test: --base requires a ref", cmd);
    }
    try {
      const result = await testProject({
        rootDir: options.cwd ?? process.cwd(),
        ...(configPath !== undefined ? { configPath } : {}),
        ...(baseRef !== undefined ? { baseRef } : {}),
        ...(fastSelectFlag ? { fastSelect: true } : {}),
        all,
        dryRun,
        timing,
      });
      return {
        exitCode: result.exitCode,
        stdout: json
          ? JSON.stringify({ ...result, command: cmd })
          : formatTestReport(result),
        stderr: "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof VibehardUsageError ? error.exitCode : 3;
      return fail(code, message.startsWith("vibehard:") ? message : `vibehard test: ${message}`, cmd);
    }
  }

  if (cmd === "explain") {
    if (jobsFlag) {
      return fail(3, "vibehard explain: unknown option --jobs", cmd);
    }
    if (timingFlag) {
      return fail(3, "vibehard explain: unknown option --timing", cmd);
    }
    if (rest.some((a) => a.startsWith("-"))) {
      return fail(3, `vibehard explain: unknown option ${rest.find((a) => a.startsWith("-"))}`, cmd);
    }
    if (rest.length !== 1) {
      return fail(3, "vibehard explain: exactly one test filter or symbol ID argument is required", cmd);
    }
    try {
      const result = await explainProject({
        rootDir: options.cwd ?? process.cwd(),
        ...(configPath !== undefined ? { configPath } : {}),
        ...(fastSelectFlag ? { fastSelect: true } : {}),
        query: rest[0] ?? "",
      });
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify({ ...result, command: cmd })
          : formatExplainReport(result),
        stderr: "",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof VibehardUsageError ? error.exitCode : 3;
      return fail(code, message.startsWith("vibehard:") ? message : `vibehard explain: ${message}`, cmd);
    }
  }

  if ((COMMANDS as readonly string[]).includes(cmd)) {
    const stage = STUB_STAGE[cmd as Command] ?? "a later stage";
    return fail(3, `vibehard ${cmd}: not implemented yet (${stage})`, cmd);
  }
  return fail(3, `vibehard: unknown command '${cmd}'${json ? "" : `\n\n${HELP}`}`);
}

// The installed `vibehard` bin is a symlink (node_modules/.bin/vibehard),
// so argv[1] is the symlink path, not cli.js: resolve it before checking.
const isMain = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const candidates = [entry];
  try {
    candidates.push(realpathSync(entry));
  } catch {
    // entry missing: fall through with the literal path only
  }
  return candidates.some((p) => p.endsWith("cli.js") || p.endsWith("cli.cjs"));
})();
if (isMain) {
  void (async () => {
    const r = await runCli(process.argv.slice(2));
    // Exit only after writes flush: process.exit immediately after an
    // async pipe write truncates large output (e.g. --json results).
    const writeAll = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
      text === ""
        ? Promise.resolve()
        : new Promise((resolve) => {
            stream.write(text.endsWith("\n") ? text : `${text}\n`, () => resolve());
          });
    await writeAll(process.stdout, r.stdout);
    await writeAll(process.stderr, r.stderr);
    process.exit(r.exitCode);
  })();
}
