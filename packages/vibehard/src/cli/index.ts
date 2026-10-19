#!/usr/bin/env node

import {
  VibehardUsageError,
  formatVerifyReport,
  recordProject,
  verifyProject,
} from "../verifier/index.js";

const VERSION = "0.0.0";

export const COMMANDS = ["init", "record", "verify", "test", "explain"] as const;
export type Command = (typeof COMMANDS)[number];

const STUB_STAGE: Partial<Record<Command, string>> = {
  init: "Stage 5",
  test: "Stage 4",
  explain: "Stage 4",
};

const HELP = `vibehard — exact e2e test selection

Usage: vibehard <command> [options]

Commands:
  init      Detect framework/app shape, write vibehard.config
  record    Run tests under observation, (re)write declarations
  verify    Run tests under observation, fail on missing/extra symbols
  test      Select and run only tests affected by the change
  explain   Show declared vs observed set for a test or symbol

Options:
  --help       Print this help
  --version    Print version
  --json       Machine-readable output (every command)
  --ci         verify: check the lockfile without writing; enforce skipVerify budget
  --config     Path to vibehard.config (record/verify)

record and verify accept optional filter arguments matched against
test file paths and titles.

Exit codes: 0 pass, 1 test failure (framework), 2 verification mismatch,
3 usage/config error or not implemented yet.
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
  let configPath: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json" || arg === "--ci") continue;
    if (arg === "--config") {
      configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
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

  if (cmd === "record" || cmd === "verify") {
    if (rest.some((a) => a.startsWith("-"))) {
      return fail(3, `vibehard ${cmd}: unknown option ${rest.find((a) => a.startsWith("-"))}`, cmd);
    }
    try {
      const run = cmd === "record" ? recordProject : verifyProject;
      const result = await run({
        rootDir: options.cwd ?? process.cwd(),
        ...(configPath !== undefined ? { configPath } : {}),
        ...(rest.length > 0 ? { filter: rest } : {}),
        ci: cmd === "verify" && ci,
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

  if ((COMMANDS as readonly string[]).includes(cmd)) {
    const stage = STUB_STAGE[cmd as Command] ?? "a later stage";
    return fail(3, `vibehard ${cmd}: not implemented yet (${stage})`, cmd);
  }
  return fail(3, `vibehard: unknown command '${cmd}'${json ? "" : `\n\n${HELP}`}`);
}

const isMain = process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.cjs");
if (isMain) {
  void (async () => {
    const r = await runCli(process.argv.slice(2));
    if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    process.exit(r.exitCode);
  })();
}
