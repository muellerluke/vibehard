import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { COMMANDS, runCli } from "../src/cli/index.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("AT-01: CLI", () => {
  it("--help exits 0 and lists every command", async () => {
    const r = await runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    for (const c of COMMANDS) expect(r.stdout).toContain(c);
  });

  it("--version exits 0", async () => {
    expect((await runCli(["--version"])).exitCode).toBe(0);
  });

  it("unimplemented commands exit 3 with their stage", async () => {
    for (const c of ["init"] as const) {
      const r = await runCli([c]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("not implemented");
    }
  });

  it("record/verify are real commands (config error, not a stub)", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "vibehard-cli-"));
    tempDirs.push(empty);
    for (const c of ["record", "verify"] as const) {
      const r = await runCli([c, "--config", "missing.json"], { cwd: empty });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("config not found");
      expect(r.stderr).not.toContain("not implemented");
    }
  });

  it("test/explain are real commands (config error, not a stub)", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "vibehard-cli-"));
    tempDirs.push(empty);
    for (const argv of [
      ["test", "--dry-run", "--config", "missing.json"],
      ["explain", "anything", "--config", "missing.json"],
    ] as string[][]) {
      const r = await runCli(argv, { cwd: empty });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("config not found");
      expect(r.stderr).not.toContain("not implemented");
    }
  });

  it("test rejects unknown options and stray arguments", async () => {
    expect((await runCli(["test", "--wat"])).exitCode).toBe(3);
    expect((await runCli(["test", "--wat"])).stderr).toContain("unknown option");
    expect((await runCli(["test", "spec.ts"])).stderr).toContain("unexpected argument");
    expect((await runCli(["test", "--base"])).stderr).toContain("--base requires a ref");
  });

  it("explain requires exactly one argument", async () => {
    const none = await runCli(["explain"]);
    expect(none.exitCode).toBe(3);
    expect(none.stderr).toContain("exactly one");
    expect((await runCli(["explain", "a", "b"])).exitCode).toBe(3);
  });

  it("unknown command exits 3", async () => {
    expect((await runCli(["bogus"])).exitCode).toBe(3);
  });

  it("unknown option on verify exits 3", async () => {
    const r = await runCli(["verify", "--wat"]);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain("unknown option");
  });

  it("--json produces parseable output", async () => {
    const r = await runCli(["--version", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    const bad = await runCli(["bogus", "--json"]);
    expect(JSON.parse(bad.stderr).ok).toBe(false);
  });
});
