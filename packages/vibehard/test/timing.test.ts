import { describe, expect, it } from "vitest";

import {
  PhaseTimer,
  formatPhaseTimings,
  timingEnabled,
} from "../src/timing.js";

function fakeClock(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

describe("PhaseTimer", () => {
  it("records ordered phases with a total", async () => {
    const timer = new PhaseTimer(true, fakeClock([0, 0, 10, 10, 25, 40]));
    timer.runSync("config.load", () => undefined);
    await timer.run("index.head", async () => undefined, { files: 4 });
    const phases = timer.snapshot();
    expect(phases.map((p) => p.name)).toEqual(["config.load", "index.head", "total"]);
    expect(phases[0]?.durationMs).toBe(10);
    expect(phases[1]?.durationMs).toBe(15);
    expect(phases[1]?.details).toEqual({ files: 4 });
    expect(phases[2]?.durationMs).toBe(40);
  });

  it("aggregates repeated phases and sums details", () => {
    const timer = new PhaseTimer(true, fakeClock([0]));
    timer.record("observation.frameworkRun", 5, { tests: 1 });
    timer.record("observation.frameworkRun", 7, { tests: 1 });
    const phases = timer.snapshot(false);
    expect(phases).toEqual([
      {
        name: "observation.frameworkRun",
        durationMs: 12,
        count: 2,
        details: { tests: 2 },
      },
    ]);
  });

  it("records duration and rethrows the original error", async () => {
    const timer = new PhaseTimer(true, fakeClock([0, 3, 9]));
    const boom = new Error("boom");
    await expect(
      timer.run("index.head", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(timer.snapshot(false)[0]?.durationMs).toBe(6);
  });

  it("passes through when disabled", async () => {
    const timer = new PhaseTimer(false, fakeClock([0]));
    await expect(timer.run("x", async () => 42)).resolves.toBe(42);
    expect(timer.runSync("y", () => "ok")).toBe("ok");
    expect(timer.snapshot()).toEqual([]);
    expect(timer.enabled).toBe(false);
  });

  it("absorbs another snapshot preserving counts", () => {
    const child = new PhaseTimer(true, fakeClock([0]));
    child.record("observation.serverStart", 3);
    child.record("observation.serverStart", 4);
    const parent = new PhaseTimer(true, fakeClock([0]));
    parent.absorb(child.snapshot(false));
    expect(parent.snapshot(false)).toEqual([
      { name: "observation.serverStart", durationMs: 7, count: 2 },
    ]);
  });
});

describe("timingEnabled", () => {
  it("honours explicit option over environment", () => {
    expect(timingEnabled(true, {})).toBe(true);
    expect(timingEnabled(false, { VIBEHARD_PROFILE: "1" })).toBe(false);
  });

  it("reads VIBEHARD_PROFILE when no explicit option is given", () => {
    expect(timingEnabled(undefined, { VIBEHARD_PROFILE: "1" })).toBe(true);
    expect(timingEnabled(undefined, { VIBEHARD_PROFILE: "true" })).toBe(true);
    expect(timingEnabled(undefined, { VIBEHARD_PROFILE: "0" })).toBe(false);
    expect(timingEnabled(undefined, {})).toBe(false);
  });
});

describe("formatPhaseTimings", () => {
  it("renders a titled table with counts and details", () => {
    const text = formatPhaseTimings("timing", [
      { name: "index.head", durationMs: 12.345, details: { files: 56, symbols: 519 } },
      { name: "observation.frameworkRun", durationMs: 100, count: 3 },
    ]);
    expect(text).toContain("timing:");
    expect(text).toContain("index.head");
    expect(text).toContain("12.35 ms");
    expect(text).toContain("files=56");
    expect(text).toContain("count=3");
  });

  it("renders nothing for an empty phase list", () => {
    expect(formatPhaseTimings("timing", [])).toBe("");
    expect(formatPhaseTimings("timing", undefined)).toBe("");
  });
});
