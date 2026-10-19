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
  freePort,
  readLockfile,
  recordProject,
  resolvePlaywrightCli,
  spawnCapture,
  spawnWithCoverage,
  verifyProject,
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
  it("AT-07: exact declarations pass verify (CLI, committed lockfile current)", async () => {
    const r = await runCli(["verify", "--json"], { cwd: TINY_APP });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const parsed = JSON.parse(r.stdout) as ProjectVerifyResult & { ok: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.results.map((x) => x.status)).toEqual(["pass", "pass"]);
    expect(parsed.lockfile.written).toBe(false);
    const page = parsed.results.find((x) => x.title.includes("checkout"));
    expect(page?.observed).toEqual([PAGE, ADD_ITEM, FORMAT].sort());
    const coupon = parsed.results.find((x) => x.title.includes("coupon"));
    expect(coupon?.observed).toEqual([POST]);
  }, T);

  it("AT-08: removing a used symbol fails as extra", async () => {
    const dir = await makeCopy({
      mutate: (d) => editSpec(d, (t) => t.replace(`    '${ADD_ITEM}',\n`, "")),
    });
    const result = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(result.exitCode).toBe(2);
    const r = only(result);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual([ADD_ITEM]);
    expect(r.missing).toEqual([]);
  }, T);

  it("AT-09: adding an unused symbol fails as missing", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(d, (t) => t.replace(`    '${PAGE}',\n`, `    '${PAGE}',\n    '${POST}',\n`)),
    });
    const result = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(result.exitCode).toBe(2);
    const r = only(result);
    expect(r.status).toBe("mismatch");
    expect(r.missing).toEqual([POST]);
    expect(r.extra).toEqual([]);
  }, T);

  it("AT-10: app change exercising a new symbol fails as extra", async () => {
    const dir = await makeCopy({
      mutate: (d) => {
        const route = path.join(d, "src/app/api/coupons/route.ts");
        const text = readFileSync(route, "utf8");
        writeFileSync(
          route,
          `import { formatPrice } from "../../../lib/format.js";\n${text.replace(
            "{ ok: true, code: body.code }",
            "{ ok: true, code: body.code, price: formatPrice(100) }",
          )}`,
        );
      },
    });
    const result = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(result.exitCode).toBe(2);
    const r = only(result);
    expect(r.status).toBe("mismatch");
    expect(r.extra).toEqual([FORMAT]);
  }, T);

  it("AT-11: record writes a declaration for an undeclared test; twice is a no-op", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(d, (t) =>
          t.replace(/test\('checkout page shows the cart total', \{\n  uses: \[[\s\S]*?\],\n\}, async/, "test('checkout page shows the cart total', async"),
        ),
    });
    const before = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(before).status).toBe("no-declaration");
    expect(before.exitCode).toBe(2);

    const recorded = await recordProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(recorded).status).toBe("recorded");
    expect(only(recorded).changed).toBe(true);
    const specAfter = readFileSync(specPath(dir), "utf8");
    for (const id of [PAGE, ADD_ITEM, FORMAT]) expect(specAfter).toContain(`'${id}'`);
    const lockAfterFirst = readFileSync(path.join(dir, "vibehard.lock.json"), "utf8");

    const verified = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(verified).status).toBe("pass");

    const again = await recordProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(again).changed).toBe(false);
    expect(readFileSync(specPath(dir), "utf8")).toBe(specAfter);
    expect(readFileSync(path.join(dir, "vibehard.lock.json"), "utf8")).toBe(lockAfterFirst);
  }, T);

  it("AT-11 (spread): record preserves shared groups, rewrites literals only", async () => {
    const dir = await makeCopy({
      mutate: (d) => editSpec(d, (t) => t.replace(`    '${PAGE}',\n`, "")),
    });
    const recorded = await recordProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(recorded).status).toBe("recorded");
    const spec = readFileSync(specPath(dir), "utf8");
    expect(spec).toContain("...priceSymbols");
    expect(spec).toContain(`'${PAGE}'`);
    // formatPrice stays only in the group definition, not duplicated as a literal.
    expect(spec.split(`'${FORMAT}'`)).toHaveLength(1);
    const verified = await verifyProject({ rootDir: dir, filter: ["checkout page"] });
    expect(only(verified).status).toBe("pass");
  }, T);

  it("AT-12: tampered lockfile and edited symbol source are hash-detected under --ci", async () => {
    const dir = await makeCopy({ keepLockfile: true });
    const fresh = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(fresh).status).toBe("pass");

    const lockPath = path.join(dir, "vibehard.lock.json");
    const lock = readLockfile(lockPath);
    if (lock === null) throw new Error("lockfile missing after verify");
    const couponEntry = Object.values(lock.tests).find((e) => e.declared.includes(POST));
    if (couponEntry === undefined) throw new Error("coupon entry missing");
    couponEntry.symbolHashes[POST] = "0".repeat(64);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const tampered = await verifyProject({ rootDir: dir, filter: ["coupon"], ci: true });
    expect(tampered.exitCode).toBe(2);
    expect(tampered.lockfile.drift.some((d) => d.includes("source hash mismatch"))).toBe(true);
    expect(tampered.lockfile.written).toBe(false);

    // Plain verify refreshes hashes on pass.
    const refreshed = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(refreshed).status).toBe("pass");
    expect(refreshed.lockfile.written).toBe(true);

    // Whitespace edit inside a declared symbol: --ci fails, plain re-verifies.
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

  it("allowTransitive permits and records observed matches", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(d, (t) =>
          t.replace(
            `uses: ['${POST}']`,
            `uses: [], allowTransitive: ['src/app/api/**']`,
          ),
        ),
    });
    const result = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    const r = only(result);
    expect(result.exitCode).toBe(0);
    expect(r.status).toBe("pass");
    expect(r.allowed).toEqual([POST]);
    const lock = readLockfile(path.join(dir, "vibehard.lock.json"));
    const entry = Object.values(lock?.tests ?? {})[0];
    expect(entry?.allowedObserved).toEqual([POST]);
  }, T);

  it("skipVerify is counted, passes locally, and fails the --ci budget", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(d, (t) =>
          t.replace(
            `uses: ['${POST}']`,
            `uses: [], skipVerify: 'coupon endpoint is unstable'`,
          ),
        ),
    });
    const local = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    expect(only(local).status).toBe("skipped-verify");
    expect(local.exitCode).toBe(0);
    expect(local.summary.skipVerifyCount).toBe(1);
    const ci = await verifyProject({ rootDir: dir, filter: ["coupon"], ci: true });
    expect(ci.exitCode).toBe(2);
    expect(ci.diagnostics.some((d) => d.includes("skipVerify count"))).toBe(true);
  }, T);

  it("unknown declared symbols are reported as missing + unknown", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(d, (t) =>
          t.replace(`uses: ['${POST}']`, `uses: ['${POST}', 'src/lib/nope.ts#Nope']`),
        ),
    });
    const result = await verifyProject({ rootDir: dir, filter: ["coupon"] });
    const r = only(result);
    expect(r.status).toBe("mismatch");
    expect(r.unknown).toEqual(["src/lib/nope.ts#Nope"]);
    expect(r.missing).toEqual(["src/lib/nope.ts#Nope"]);
  }, T);

  it("duplicate test titles in one file are a hard error", async () => {
    const dir = await makeCopy({
      mutate: (d) =>
        editSpec(
          d,
          (t) =>
            `${t}\ntest('coupon api accepts a code', { uses: [] }, async () => {});\n`,
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
