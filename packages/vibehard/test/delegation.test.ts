import { describe, expect, it } from "vitest";

import type { RunnableTestRef } from "../src/verifier/listed.js";
import {
  ARGV_BUDGET_BYTES,
  argvBytes,
  groupRunnableByFile,
  packChunks,
} from "../src/verifier/delegation.js";
import { planPlaywrightChunks } from "../src/verifier/playwright-runner.js";
import { planCypressChunks } from "../src/verifier/cypress-runner.js";
import { planPuppeteerChunks, titlePattern } from "../src/verifier/puppeteer-runner.js";
import { mergeSpawnResults, spawnStreaming } from "../src/verifier/servers.js";
import { formatTestReport } from "../src/selector/run.js";
import type { TestProjectResult } from "../src/selector/types.js";

function ref(file: string, line: number, title: string): RunnableTestRef {
  return { testId: `${file}::${title}`, file, line, title, titlePath: [title] };
}

describe("Phase 4 delegation planner", () => {
  it("groups by file deterministically and detects fully selected files", () => {
    const a1 = ref("e2e/a.spec.ts", 10, "a1");
    const a2 = ref("e2e/a.spec.ts", 20, "a2");
    const b1 = ref("e2e/b.spec.ts", 10, "b1");
    const b2 = ref("e2e/b.spec.ts", 20, "b2");
    const groups = groupRunnableByFile([b1, a2, a1], [a1, a2, b1, b2]);
    expect(groups.map((g) => [g.file, g.fullySelected])).toEqual([
      ["e2e/a.spec.ts", true],
      ["e2e/b.spec.ts", false],
    ]);
    expect(groups[0]?.tests.map((t) => t.title)).toEqual(["a1", "a2"]);
    // No discovered set: never claim whole-file.
    expect(groupRunnableByFile([a1, a2])[0]?.fullySelected).toBe(false);
  });

  it("packs under the byte budget and fails closed on an indivisible unit", () => {
    const items = ["aaaa", "bbbb", "cccc"];
    const cost = (chunk: readonly string[]): number => argvBytes([...chunk]);
    expect(packChunks(items, argvBytes(["aaaa", "bbbb"]), cost)).toEqual([
      ["aaaa", "bbbb"],
      ["cccc"],
    ]);
    expect(() => packChunks(["x".repeat(64)], 16, cost)).toThrow(/argv budget/);
    expect(ARGV_BUDGET_BYTES).toBe(24 * 1024);
  });

  it("Playwright: whole file collapses, partial files split per test, every chunk within budget", () => {
    const discovered = [
      ref("e2e/a.spec.ts", 10, "a1"),
      ref("e2e/a.spec.ts", 20, "a2"),
      ...Array.from({ length: 20 }, (_, i) => ref("e2e/big.spec.ts", 10 + i, `t${i}`)),
    ];
    const selected = discovered.filter((t) => t.file === "e2e/a.spec.ts" || t.title !== "t19");
    const budget = 160;
    const chunks = planPlaywrightChunks(selected, discovered, budget, 0);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.positionals).toContain("e2e/a.spec.ts");
    for (const c of chunks) expect(argvBytes(c.positionals)).toBeLessThanOrEqual(budget);
    expect(chunks.flatMap((c) => c.tests.map((t) => t.testId)).sort()).toEqual(
      selected.map((t) => t.testId).sort(),
    );
  });

  it("Cypress: fully selected specs take no title filter; partial chunks carry exact titles", () => {
    const discovered = [
      ref("cypress/e2e/a.cy.ts", 1, "a1"),
      ref("cypress/e2e/a.cy.ts", 2, "a2"),
      ...Array.from({ length: 30 }, (_, i) =>
        ref("cypress/e2e/b.cy.ts", i + 1, `representative test title ${i}`),
      ),
    ];
    const selected = discovered.filter((t) => t.title !== "representative test title 29");
    const budget = 512;
    const chunks = planCypressChunks(selected, discovered, budget, 0);
    const full = chunks.filter((c) => c.onlyTitles === null);
    expect(full.flatMap((c) => c.specs)).toEqual(["cypress/e2e/a.cy.ts"]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.flatMap((c) => c.tests.map((t) => t.testId)).sort()).toEqual(
      selected.map((t) => t.testId).sort(),
    );
    for (const c of chunks) {
      if (c.onlyTitles !== null) {
        expect(c.onlyTitles.map((p) => p.join(" > ")).sort()).toEqual(
          c.tests.map((t) => t.titlePath.join(" > ")).sort(),
        );
      }
    }
  });

  it("Puppeteer: full file has no pattern; partial titles split with each title exactly once", () => {
    const discovered = [
      ref("e2e/a.test.ts", 1, "a1"),
      ...Array.from({ length: 24 }, (_, i) => ref("e2e/b.test.ts", i + 1, `case number ${i}`)),
    ];
    const selected = discovered.filter((t) => t.title !== "case number 23");
    const budget = 128;
    const chunks = planPuppeteerChunks(selected, discovered, budget, 0);
    expect(chunks.find((c) => c.file === "e2e/a.test.ts")?.pattern).toBeNull();
    const bChunks = chunks.filter((c) => c.file === "e2e/b.test.ts");
    expect(bChunks.length).toBeGreaterThan(1);
    for (const c of bChunks) {
      expect(c.pattern).toBe(titlePattern(c.tests.map((t) => t.title)));
      expect(Buffer.byteLength(c.pattern ?? "")).toBeLessThanOrEqual(budget);
    }
    expect(bChunks.flatMap((c) => c.tests.map((t) => t.title)).sort()).toEqual(
      selected.filter((t) => t.file === "e2e/b.test.ts").map((t) => t.title).sort(),
    );
  });
});

describe("Phase 4 streaming output", () => {
  it("retains only a bounded tail and reports truncation", async () => {
    const script = "process.stdout.write('x'.repeat(5000)+'END');process.stderr.write('err')";
    const r = await spawnStreaming(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      tailBytes: 64,
      echo: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(64);
    expect(r.stdout.endsWith("END")).toBe(true);
    expect(r.stderr).toBe("err");
  });

  it("echoes live to the sink while retaining the tail", async () => {
    const seen: string[] = [];
    const sink = { write: (c: Buffer | string): boolean => (seen.push(String(c)), true) };
    const r = await spawnStreaming(process.execPath, ["-e", "process.stdout.write('hello')"], {
      cwd: process.cwd(),
      tailBytes: 64,
      stdout: sink,
    });
    expect(seen.join("")).toBe("hello");
    expect(r.stdout).toBe("hello");
    expect(r.streamed).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("formatTestReport does not duplicate streamed output and marks truncation", () => {
    const base: TestProjectResult = {
      ok: true,
      exitCode: 0,
      dryRun: false,
      all: false,
      rootDir: "/x",
      selection: null,
      ran: { mode: "full", testIds: ["t"], frameworkExitCode: 0, playwrightExitCode: 0 },
      diagnostics: [],
      output: { stdout: "FRAMEWORK-OUT", stderr: "", streamed: true, truncated: true },
    };
    const streamed = formatTestReport(base);
    expect(streamed).not.toContain("FRAMEWORK-OUT");
    expect(streamed).toContain("truncated to the last 64 KiB");
    const captured = formatTestReport({
      ...base,
      output: { stdout: "FRAMEWORK-OUT", stderr: "" },
    });
    expect(captured).toContain("FRAMEWORK-OUT");
    expect(captured).not.toContain("truncated to the last");
  });

  it("merges chunk results: first failure wins, tails stay bounded", () => {
    const merged = mergeSpawnResults(
      [
        { exitCode: 0, stdout: "a".repeat(100), stderr: "" },
        { exitCode: 7, stdout: "b".repeat(100), stderr: "e2" },
        { exitCode: 3, stdout: "c", stderr: "" },
      ],
      50,
    );
    expect(merged.exitCode).toBe(7);
    expect(merged.chunks).toBe(3);
    expect(merged.truncated).toBe(true);
    expect(Buffer.byteLength(merged.stdout)).toBeLessThanOrEqual(50);
    expect(merged.stdout.endsWith("c")).toBe(true);
  });
});
