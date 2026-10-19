import { describe, expect, it } from "vitest";
import { COMMANDS, runCli } from "../src/cli/index.js";

describe("AT-01: CLI stub", () => {
  it("--help exits 0 and lists every command", () => {
    const r = runCli(["--help"]);
    expect(r.exitCode).toBe(0);
    for (const c of COMMANDS) expect(r.stdout).toContain(c);
  });

  it("--version exits 0", () => {
    expect(runCli(["--version"]).exitCode).toBe(0);
  });

  it("known commands exit 3 (not implemented) in Stage 0", () => {
    for (const c of COMMANDS) {
      const r = runCli([c]);
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("not implemented");
    }
  });

  it("unknown command exits 3", () => {
    expect(runCli(["bogus"]).exitCode).toBe(3);
  });

  it("--json produces parseable output", () => {
    const r = runCli(["--version", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });
});
