import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  formatVerifyReport,
  freePort,
  readLockfile,
  recordProject,
  resolvePlaywrightCli,
  spawnCapture,
  spawnWithCoverage,
  verifyProject,
  writeLockfile,
  type ProjectVerifyResult,
} from "../src/index.js";
import { runCli } from "../src/cli/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const T = 240_000;

const POST = "src/app/api/coupons/route.ts#POST";
const PAGE = "src/app/checkout/page.tsx#CheckoutPage";
const ADD_ITEM = "src/lib/cart.ts#Cart.addItem";
const FORMAT = "src/lib/format.ts#formatPrice";
const ITEMS = "src/lib/cart.ts#Cart.items";
const CENTS = "src/lib/format.ts#CENTS_PER_DOLLAR";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function buildHarness(cwd: string, env: Record<string, string> = {}): Promise<void> {
  const r = await spawnCapture(process.execPath, ["build-harness.mjs"], {
    cwd,
    env,
    timeoutMs: 120_000,
  });
  expect(r.exitCode, r.stderr).toBe(0);
}

/** Copy tiny-app inside the repo so workspace module resolution works. */
async function makeCopy(options: {
  mutate?: (dir: string) => void;
  noSourcemap?: boolean;
  keepLockfile?: boolean;
} = {}): Promise<string> {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".vh-test-"));
  tempDirs.push(dir);
  cpSync(TINY_APP, dir, {
    recursive: true,
    filter: (src) =>
      !src.includes("node_modules") &&
      !src.includes(`${path.sep}.build`) &&
      !src.includes("test-results"),
  });
  const tsconfigPath = path.join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as { extends?: string };
  tsconfig.extends = path.join(REPO_ROOT, "tsconfig.base.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  if (options.keepLockfile !== true) {
    rmSync(path.join(dir, "vibehard.lock.json"), { force: true });
  }
  options.mutate?.(dir);
  await buildHarness(dir, options.noSourcemap === true ? { VH_NO_SOURCEMAP: "1" } : {});
  return dir;
}

function specPath(dir: string): string {
  return path.join(dir, "e2e/checkout.spec.ts");
}
function editSpec(dir: string, edit: (text: string) => string): void {
  const file = specPath(dir);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
}
function only(result: ProjectVerifyResult) {
  expect(result.results).toHaveLength(1);
  const r = result.results[0];
  if (r === undefined) throw new Error("missing result");
  return r;
}

beforeAll(async () => {
  const build = await spawnCapture("npm", ["run", "build", "-w", "vibehard"], {
    cwd: REPO_ROOT,
    timeoutMs: 180_000,
  });
  expect(build.exitCode, build.stderr).toBe(0);
  await buildHarness(TINY_APP);
}, T);

describe("Stage 3 verifier on fixtures/tiny-app", () => {
  it("AT-07: recorded touched sets pass verify (CLI, committed lockfile current)", async () => {
    const r = await runCli(["verify", "--json"], { cwd: TINY_APP });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as ProjectVerifyResult & { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(parsed.lockfile.written).toBe(false);
    const page = parsed.results.find((x) => x.title.includes("checkout"));
    expect(page?.observed).toEqual([PAGE, ADD_ITEM, ITEMS, FORMAT].sort());
    expect(page?.touched?.[CENTS]).toBe("referenced");
    expect(page?.touched?.[FORMAT]).toBe("direct");
    const coupon = parsed.results.find((x) => x.title.includes("coupon"));
    expect(coupon?.observed).toEqual([POST]);
  }, T);

  it("verify on an unrecorded test fails as drift", async () => {
    const dir = await makeCopy();
    const result = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(result.exitCode).toBe(2);
    const r = only(result);
    expect(r.status).toBe("drift");
    expect(r.added).toContain(ADD_ITEM);
    expect(r.touched?.[CENTS]).toBe("referenced");
  }, T);

  it("AT-10: app change exercising a new symbol fails verify as drift (added)", async () => {
    const dir = await makeCopy();
    const recorded = await recordProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(recorded).status).toBe("recorded");
    const route = path.join(dir, "src/app/api/coupons/route.ts");
    const text = readFileSync(route, "utf8");
    writeFileSync(
      route,
      `import { formatPrice } from "../../../lib/format.js";
${text.replace(
        "{ ok: true, code: body.code }",
        "{ ok: true, code: body.code, price: formatPrice(100) }",
      )}`,
    );
    await buildHarness(dir);
    const result = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(result.exitCode).toBe(2);
    const r = only(result);
    expect(r.status).toBe("drift");
    expect(r.added).toContain(FORMAT);
    expect(r.added).toContain(CENTS);
  }, T);

  it("AT-11: record writes the lockfile without touching specs; twice is a no-op", async () => {
    const dir = await makeCopy();
    const specBefore = readFileSync(specPath(dir), "utf8");
    const recorded = await recordProject({ rootDir: dir, filter: ["checkout page"] });
    const r = only(recorded);
    expect(r.status).toBe("recorded");
    expect(readFileSync(specPath(dir), "utf8")).toBe(specBefore);
    expect(r.touched?.[PAGE]).toBe("direct");
    expect(r.touched?.[ADD_ITEM]).toBe("direct");
    expect(r.touched?.[CENTS]).toBe("referenced");
    const lockAfterFirst = readFileSync(path.join(dir, "vibehard.lock.json"), "utf8");

    const verified = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(verified).status).toBe("pass");

    const again = await recordProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(again).status).toBe("recorded");
    expect(readFileSync(path.join(dir, "vibehard.lock.json"), "utf8")).toBe(lockAfterFirst);
  }, T);

  it("a recorded symbol no longer touched fails verify as drift (removed)", async () => {
    const dir = await makeCopy();
    const recorded = await recordProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(recorded).status).toBe("recorded");
    const lockPath = path.join(dir, "vibehard.lock.json");
    const lock = readLockfile(lockPath);
    if (lock === null) throw new Error("lockfile missing after record");
    const entry = Object.values(lock.tests)[0];
    if (entry === undefined) throw new Error("entry missing");
    entry.touched[FORMAT] = "direct";
    entry.symbolHashes[FORMAT] = "0".repeat(64);
    writeLockfile(lockPath, lock);
    const result = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(result.exitCode).toBe(2);
    const r = only(result);
    expect(r.status).toBe("drift");
    expect(r.removed).toContain(FORMAT);
  }, T);

  it("AT-12: tampered lockfile and edited symbol source are hash-detected under --ci", async () => {
    const dir = await makeCopy({ keepLockfile: true });
    const fresh = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(fresh).status).toBe("pass");

    const lockPath = path.join(dir, "vibehard.lock.json");
    const lock = readLockfile(lockPath);
    if (lock === null) throw new Error("lockfile missing after verify");
    const couponEntry = Object.values(lock.tests).find((e) => POST in e.touched);
    if (couponEntry === undefined) throw new Error("coupon entry missing");
    couponEntry.symbolHashes[POST] = "0".repeat(64);
    writeLockfile(lockPath, lock);

    const tampered = await verifyProject({ rootDir: dir, filter: ["coupon"], ci: true });
    expect(tampered.exitCode).toBe(2);
    expect(tampered.lockfile.drift.some((d) => d.includes("source hash mismatch"))).toBe(true);
    expect(tampered.lockfile.written).toBe(false);

    // Plain verify refreshes hashes on pass.
    const refreshed = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(refreshed).status).toBe("pass");
    expect(refreshed.lockfile.written).toBe(true);

    // Whitespace edit inside a touched symbol: --ci fails, plain re-verifies.
    const formatPath = path.join(dir, "src/lib/format.ts");
    writeFileSync(formatPath, readFileSync(formatPath, "utf8").replace("return `$", "return  `$"));
    const stale = await verifyProject({ rootDir: dir, filter: ["checkout page"], ci: true });
    expect(stale.exitCode).toBe(2);
    expect(stale.lockfile.drift.some((d) => d.includes(FORMAT))).toBe(true);

    await buildHarness(dir);
    const reverified = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(reverified).status).toBe("pass");
    const ciAgain = await verifyProject({ rootDir: dir, filter: ["checkout page"], ci: true });
    expect(ciAgain.exitCode).toBe(0);
    expect(ciAgain.lockfile.drift).toEqual([]);
  }, T);

  it("alwaysRun is counted, passes locally, and fails the --ci budget", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(d, (t) =>
          t.replace(
            "test('coupon api accepts a code', async",
            "test('coupon api accepts a code', { alwaysRun: 'coupon endpoint is unstable' }, async",
          ),
        ),
    });
    const local = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(local).status).toBe("always-run");
    expect(local.exitCode).toBe(0);
    expect(local.summary.alwaysRunCount).toBe(1);
    const ci = await verifyProject({ rootDir: dir, filter: ["coupon"], ci: true });
    expect(ci.exitCode).toBe(2);
    expect(ci.diagnostics.some((d) => d.includes("alwaysRun count"))).toBe(true);
  }, T);

  it("duplicate test titles in one file are a hard error", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(
          d,
          (t) =>
            `${t}\ntest('coupon api accepts a code', async () => {});\n`,
        ),
    });
    await expect(verifyProject({ rootDir: dir })).rejects.toThrow(/duplicate test/);
  }, T);

  it("without source maps, verification fails closed as unmappable", async () => {
    const dir = await makeCopy({ noSourcemap: true });
    const result = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(result.exitCode).toBe(2);
    expect(only(result).status).toBe("unmappable");
  }, T);

  it("a failing test exits 1 and record does not write from it", async () => {
    const dir = await makeCopy({
      mutate: (d) => editSpec(d, (t) => t.replace("'$43.97'", "'$0.00'")),
    });
    const specBefore = readFileSync(specPath(dir), "utf8");
    const verified = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(verified.exitCode).toBe(1);
    expect(only(verified).status).toBe("test-failed");
    const recorded = await recordProject({ rootDir: dir, filter: ["checkout page"] });
    expect(recorded.exitCode).toBe(1);
    expect(readFileSync(specPath(dir), "utf8")).toBe(specBefore);
    expect(existsSync(path.join(dir, "vibehard.lock.json"))).toBe(false);
  }, T);

  it("Phase 0 timing: record reports observation phases and writes the same lockfile", async () => {
    const timedDir = await makeCopy();
    const timed = await recordProject({
      rootDir: timedDir,
      filter: ["coupon"],
      timing: true,
    });
    expect(timed.exitCode).toBe(0);
    expect(timed.timing?.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        "config.load",
        "index",
        "hash.allSymbols",
        "tests.discovery",
        "observation.total",
        "observation.serverStart",
        "observation.frameworkRun",
        "observation.serverStop",
        "observation.coverageMap",
        "observation.touchedCompute",
        "observation.hashTouched",
        "lockfile.checkOrWrite",
        "total",
      ]),
    );
    const framework = timed.timing?.find((p) => p.name === "observation.frameworkRun");
    expect(framework?.count).toBe(2);
    const entry = only(timed);
    expect(entry.timing?.observationCount).toBe(2);
    expect(entry.timing?.observations).toHaveLength(2);
    expect(entry.timing?.phases.map((p) => p.name)).toContain(
      "observation.frameworkRun",
    );
    const report = formatVerifyReport(timed);
    expect(report).toContain("timing:");
    expect(report).toContain("slowest tests (observation):");

    const untimedDir = await makeCopy();
    const untimed = await recordProject({
      rootDir: untimedDir,
      filter: ["coupon"],
      timing: false,
    });
    expect(untimed.exitCode).toBe(0);
    expect(untimed.timing).toBeUndefined();
    expect(only(untimed).timing).toBeUndefined();
    expect(readFileSync(path.join(timedDir, "vibehard.lock.json"), "utf8")).toBe(
      readFileSync(path.join(untimedDir, "vibehard.lock.json"), "utf8"),
    );
    const strip = (r: ProjectVerifyResult): unknown => {
      const clone = JSON.parse(
        JSON.stringify(r).split(r.rootDir).join("<root>"),
      ) as Record<string, unknown>;
      delete clone["timing"];
      delete clone["rootDir"];
      const lockfile = clone["lockfile"] as Record<string, unknown>;
      delete lockfile["path"];
      for (const testResult of clone["results"] as Record<string, unknown>[]) {
        delete testResult["timing"];
      }
      return clone;
    };
    expect(strip(timed)).toEqual(strip(untimed));
  }, T);

  it("plain `playwright test` is unaffected (adapter no-op without vibehard env)", async () => {
    const port = await freePort();
    const server = spawnWithCoverage({
      command: process.execPath,
      args: [path.join(TINY_APP, ".build/server.mjs")],
      cwd: TINY_APP,
      env: {
        TINY_APP_PORT: String(port),
        TINY_APP_CLIENT_BUNDLE: path.join(TINY_APP, ".build/client.mjs"),
      },
    });
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          if (res.ok) break;
        } catch {
          // not up yet
        }
        if (Date.now() > deadline) throw new Error(`harness did not start:\n${server.output()}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      const cli = resolvePlaywrightCli(TINY_APP);
      const run = await spawnCapture(process.execPath, [cli, "test", "--project=chromium"], {
        cwd: TINY_APP,
        env: { VIBEHARD_BASE_URL: `http://127.0.0.1:${port}`, VIBEHARD_ARTIFACT_DIR: "" },
        timeoutMs: 120_000,
      });
      expect(run.exitCode, run.stdout + run.stderr).toBe(0);
    } finally {
      await server.stop();
    }
  }, T);
});
