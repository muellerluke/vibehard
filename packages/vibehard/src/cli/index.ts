#!/usr/bin/env node

const VERSION = "0.0.0";

export const COMMANDS = ["init", "record", "verify", "test", "explain"] as const;
export type Command = (typeof COMMANDS)[number];

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

Exit codes: 0 pass, 1 test failure (framework), 2 verification mismatch,
3 selection unsafe (--dry-run) / not implemented (Stage 0 stub).
`;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runCli(argv: string[]): CliResult {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const [cmd] = args;

  const ok = (text: string): CliResult =>
    json
      ? { exitCode: 0, stdout: JSON.stringify({ ok: true, version: VERSION, help: text }), stderr: "" }
      : { exitCode: 0, stdout: text, stderr: "" };

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") return ok(HELP);
  if (cmd === "--version" || cmd === "-v") {
    return json
      ? { exitCode: 0, stdout: JSON.stringify({ ok: true, version: VERSION }), stderr: "" }
      : { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" };
  }
  if ((COMMANDS as readonly string[]).includes(cmd)) {
    const msg = `vibehard ${cmd}: not implemented yet (Stage 0 skeleton)`;
    return json
      ? { exitCode: 3, stdout: "", stderr: JSON.stringify({ ok: false, error: msg, command: cmd }) }
      : { exitCode: 3, stdout: "", stderr: `${msg}\n` };
  }
  const msg = `vibehard: unknown command '${cmd}'`;
  return json
    ? { exitCode: 3, stdout: "", stderr: JSON.stringify({ ok: false, error: msg }) }
    : { exitCode: 3, stdout: "", stderr: `${msg}\n\n${HELP}` };
}

const isMain = process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.cjs");
if (isMain) {
  const r = runCli(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.exitCode);
}
