// Phase 0 perf runner. Spawns the built CLI against generated
// fixtures so process startup and subprocess discovery are included.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  REPO_ROOT,
  applyScenario,
  generateFixture,
  resetScenario,
} from "./generate-scale-fixture.mjs";

const CLI = path.join(REPO_ROOT, "packages/vibehard/dist/cli.js");

const PRESETS = {
  smoke: {
    shape: "selection",
    framework: "puppeteer",
    files: 100,
    symbolsPerFile: 4,
    sharedFiles: 10,
    specFiles: 10,
    testsPerSpec: 10,
    touchedPerTest: 50,
  },
  default: {
    shape: "selection",
    framework: "puppeteer",
    files: 1000,
    symbolsPerFile: 5,
    sharedFiles: 25,
    specFiles: 100,
    testsPerSpec: 10,
    touchedPerTest: 100,
  },
  large: {
    shape: "selection",
    framework: "puppeteer",
    files: 3000,
    symbolsPerFile: 6,
    sharedFiles: 25,
    specFiles: 300,
    testsPerSpec: 10,
    touchedPerTest: 150,
  },
  "record-smoke": {
    shape: "recordable",
    framework: "playwright",
    files: 20,
    symbolsPerFile: 2,
    sharedFiles: 2,
    specFiles: 2,
    testsPerSpec: 5,
    touchedPerTest: 0,
  },
};

function parseArgs(argv) {
  const opts = {
    preset: "default",
    mode: null,
    scenario: "leaf",
    repetitions: 5,
    seed: 1,
    keep: false,
    fastSelect: false,
    coldCache: false,
    jobs: 1,
    timing: true,
    out: null,
    overrides: {},
  };
  const numericOverrides = {
    "--files": "files",
    "--symbols-per-file": "symbolsPerFile",
    "--shared-files": "sharedFiles",
    "--spec-files": "specFiles",
    "--tests-per-spec": "testsPerSpec",
    "--touched-per-test": "touchedPerTest",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      process.stdout.write(
        "usage: run-perf.mjs [--preset smoke|default|large|record-smoke] [--scenario none|leaf|shared|spec|support] [--repetitions N] [--seed N] [--out FILE] [--keep] [--fast-select] [--cold-cache] [--jobs N] [--no-timing] [--files N] [--spec-files N] [--tests-per-spec N] [--touched-per-test N]\n",
      );
      process.exit(0);
    }
    if (arg === "--keep") {
      opts.keep = true;
      continue;
    }
    if (arg === "--fast-select") {
      opts.fastSelect = true;
      continue;
    }
    if (arg === "--cold-cache") {
      opts.coldCache = true;
      continue;
    }
    if (arg === "--no-timing") {
      opts.timing = false;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === "--preset") opts.preset = value;
    else if (arg === "--mode") opts.mode = value;
    else if (arg === "--scenario") opts.scenario = value;
    else if (arg === "--repetitions") opts.repetitions = Number(value);
    else if (arg === "--jobs") opts.jobs = Number(value);
    else if (arg === "--seed") opts.seed = Number(value);
    else if (arg === "--out") opts.out = value;
    else if (numericOverrides[arg] !== undefined) opts.overrides[numericOverrides[arg]] = Number(value);
    else throw new Error(`unknown option: ${arg}`);
    i += 1;
  }
  if (PRESETS[opts.preset] === undefined) throw new Error(`unknown preset: ${opts.preset}`);
  if (!Number.isInteger(opts.repetitions) || opts.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  if (!Number.isInteger(opts.jobs) || opts.jobs < 1) {
    throw new Error("--jobs must be a positive integer");
  }
  return opts;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return {
    medianMs: Math.round((median ?? 0) * 100) / 100,
    minMs: Math.round((sorted[0] ?? 0) * 100) / 100,
    maxMs: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
  };
}

function summarizePhases(runs) {
  const order = [];
  const byName = new Map();
  for (const run of runs) {
    for (const phase of run.phases) {
      if (!byName.has(phase.name)) {
        byName.set(phase.name, []);
        order.push(phase.name);
      }
      byName.get(phase.name).push(phase.durationMs);
    }
  }
  return order.map((name) => ({ name, ...stats(byName.get(name)) }));
}

function runCli(cwd, args, extraEnv = {}) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, VIBEHARD_PROFILE: "", VIBEHARD_FAST_SELECT: "", ...extraEnv },
  });
  const wallMs = performance.now() - start;
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    parseError = error;
  }
  if (result.status !== 0 || parsed === null) {
    throw new Error(
      `vibehard ${args.join(" ")} failed (exit ${result.status}` +
        `${parseError !== null ? `, JSON parse: ${parseError.message}` : ""})\n` +
        `${result.stderr}\n${result.stdout.slice(0, 2000)}`,
    );
  }
  return { wallMs, parsed };
}

function gitInfo() {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return {
    sha: sha.status === 0 ? sha.stdout.trim() : "unknown",
    dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
  };
}

function printSummary(report) {
  const lines = [];
  const selectionBits =
    report.mode === "selection"
      ? `, scenario=${report.scenario}, fastSelect=${report.fastSelect}, coldCache=${report.coldCache}, timing=${report.timing}`
      : `, jobs=${report.jobs}, timing=${report.timing}`;
  lines.push(`perf ${report.preset} (${report.mode}${selectionBits})`);
  lines.push(
    `fixture: ${report.fixture.counts.sourceFiles} files, ${report.fixture.counts.symbols} symbols, ` +
      `${report.fixture.counts.tests} tests, ${report.fixture.counts.edges} touched edges, ` +
      `lockfile ${report.fixture.counts.lockfileBytes} bytes`,
  );
  lines.push(`setup: ${report.setupMs.toFixed(2)} ms (excluded from repetitions)`);
  lines.push(
    `wall: median ${report.summary.wallMs.medianMs} ms (min ${report.summary.wallMs.minMs}, max ${report.summary.wallMs.maxMs}) over ${report.repetitions} run(s)`,
  );
  const width = Math.max(4, ...report.summary.phases.map((p) => p.name.length));
  for (const phase of report.summary.phases) {
    lines.push(
      `  ${phase.name.padEnd(width)}  median ${String(phase.medianMs).padStart(10)} ms  (min ${phase.minMs}, max ${phase.maxMs})`,
    );
  }
  if (report.summary.slowestTests !== undefined) {
    lines.push("slowest tests (observation):");
    for (const entry of report.summary.slowestTests) {
      lines.push(`  ${entry.testId}  ${entry.totalMs.toFixed(2)} ms`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(CLI)) {
    throw new Error(`built CLI not found at ${CLI}; run \`npm run build\` first (root \`npm run perf\` does)`);
  }
  const preset = PRESETS[opts.preset];
  const mode = opts.mode ?? (preset.shape === "recordable" ? "record" : "selection");
  if (mode !== "selection" && mode !== "record") throw new Error(`unknown mode: ${mode}`);
  if (opts.fastSelect && mode !== "selection") {
    throw new Error("--fast-select applies to selection mode only");
  }
  if (opts.coldCache && !opts.fastSelect) {
    throw new Error("--cold-cache requires --fast-select (the full path has no parse cache)");
  }
  if (opts.jobs !== 1 && mode !== "record") {
    throw new Error("--jobs applies to record mode only");
  }
  if (opts.fastSelect && !opts.timing) {
    throw new Error("--fast-select engagement is proven via timing phases; drop --no-timing");
  }

  const outDir = path.join(REPO_ROOT, `.vh-perf-run-${opts.preset}-s${opts.seed}`);
  const manifestPath = `${outDir}.manifest.json`;
  const setupStart = performance.now();
  const manifest = await generateFixture({
    ...preset,
    ...opts.overrides,
    seed: opts.seed,
    out: outDir,
    manifest: manifestPath,
  });
  const setupMs = performance.now() - setupStart;

  try {
    const runs = [];
    let slowestTests;

    if (mode === "selection") {
      const expected = manifest.scenarios?.[opts.scenario]?.expectedTestIds ?? null;
      applyScenario(outDir, manifest, opts.scenario);
      try {
        const totalRuns = opts.repetitions + 1; // first run is an excluded warm-up
        const cacheDir = path.join(outDir, ".git", "vibehard-cache");
        for (let i = 0; i < totalRuns; i += 1) {
          if (opts.coldCache) rmSync(cacheDir, { recursive: true, force: true });
          const { wallMs, parsed } = runCli(
            outDir,
            [
              "test",
              "--dry-run",
              ...(opts.timing ? ["--timing"] : []),
              "--json",
              ...(opts.fastSelect ? ["--fast-select"] : []),
            ],
            opts.fastSelect ? { VIBEHARD_FAST_SELECT: "1" } : {},
          );
          const selectedIds = (parsed.selection?.selected ?? []).map((t) => t.testId).sort();
          if (expected !== null) {
            const want = [...expected].sort();
            if (JSON.stringify(selectedIds) !== JSON.stringify(want)) {
              throw new Error(
                `scenario ${opts.scenario} selected ${JSON.stringify(selectedIds)}, expected ${JSON.stringify(want)}`,
              );
            }
          }
          if ((parsed.selection?.unsafeReasons ?? []).length > 0) {
            throw new Error(`selection was unsafe: ${parsed.selection.unsafeReasons.join("; ")}`);
          }
          if (opts.fastSelect) {
            const fallback = (parsed.selection?.diagnostics ?? []).find((d) =>
              d.startsWith("fast selection unavailable"),
            );
            if (fallback !== undefined) {
              throw new Error(`fast selection fell back to full indexing: ${fallback}`);
            }
            const phaseNames = (parsed.selection?.timing ?? []).map((p) => p.name);
            if (!phaseNames.includes("fast.parse.head") || phaseNames.includes("index.head")) {
              throw new Error(
                `fast selection did not engage (phases: ${phaseNames.join(", ")})`,
              );
            }
          }
          if (i === 0) continue;
          const phases = [
            ...(parsed.selection?.timing ?? []).map((p) => ({ ...p, name: `selection:${p.name}` })),
            ...(parsed.timing ?? []).map((p) => ({ ...p, name: `test:${p.name}` })),
          ];
          runs.push({ wallMs, phases, selected: selectedIds.length });
        }
      } finally {
        resetScenario(outDir, manifest, opts.scenario);
      }
    } else {
      const { wallMs, parsed } = runCli(outDir, [
        "record",
        ...(opts.timing ? ["--timing"] : []),
        ...(opts.jobs !== 1 ? ["--jobs", String(opts.jobs)] : []),
        "--json",
      ]);
      if (opts.jobs !== 1 && parsed.jobs !== opts.jobs) {
        throw new Error(`record reported jobs=${parsed.jobs}, expected ${opts.jobs}`);
      }
      if (parsed.ok !== true && parsed.exitCode !== 0) {
        throw new Error(`record did not pass: ${JSON.stringify(parsed.summary)}`);
      }
      const lockfilePath = path.join(outDir, "vibehard.lock.json");
      if (existsSync(lockfilePath)) {
        const lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
        // v2 touched is symbol->kind; v3 touched is kind->index array.
        manifest.counts.edges = Object.values(lock.tests).reduce(
          (sum, entry) =>
            sum +
            Object.values(entry.touched).reduce(
              (inner, value) => inner + (Array.isArray(value) ? value.length : 1),
              0,
            ),
          0,
        );
        manifest.counts.lockfileBytes = readFileSync(lockfilePath).byteLength;
      }
      slowestTests = (parsed.results ?? [])
        .flatMap((r) =>
          r.timing === undefined
            ? []
            : [{ testId: r.testId, totalMs: r.timing.phases.reduce((sum, p) => sum + p.durationMs, 0) }],
        )
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 10);
      runs.push({ wallMs, phases: parsed.timing ?? [] });
    }

    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "packages/vibehard/package.json"), "utf8"),
    );
    const report = {
      version: 1,
      generatedAt: new Date().toISOString(),
      preset: opts.preset,
      mode,
      fastSelect: mode === "selection" ? opts.fastSelect : false,
      coldCache: mode === "selection" ? opts.coldCache : false,
      jobs: mode === "record" ? opts.jobs : 1,
      timing: opts.timing,
      scenario: mode === "selection" ? opts.scenario : null,
      repetitions: mode === "selection" ? opts.repetitions : 1,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        packageVersion: pkg.version,
        git: gitInfo(),
      },
      fixture: {
        parameters: manifest.parameters,
        counts: manifest.counts,
        touched: manifest.touched,
      },
      setupMs: Math.round(setupMs * 100) / 100,
      runs,
      summary: {
        wallMs: stats(runs.map((r) => r.wallMs)),
        phases: summarizePhases(runs),
        ...(slowestTests !== undefined ? { slowestTests } : {}),
      },
    };

    printSummary(report);
    if (opts.out !== null) {
      writeFileSync(path.resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`report written to ${path.resolve(opts.out)}\n`);
    }
    return report;
  } finally {
    if (!opts.keep) {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(manifestPath, { force: true });
    } else {
      process.stdout.write(`fixture kept at ${outDir}\n`);
    }
  }
}

await main();
