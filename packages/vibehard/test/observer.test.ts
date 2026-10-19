import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  browserEntriesToInputs,
  collectBrowserScripts,
  executedFunctionRanges,
  indexProject,
  mapRangesToSymbols,
  observeScripts,
  parseNodeCoverageDir,
  runNodeWithCoverage,
  spawnWithCoverage,
  type IndexResult,
  type ScriptInput,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const TIMEOUT = 60_000;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-observer-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

interface ExpectedObserved {
  pageLoad: { client: string[]; server: string[]; merged: string[] };
  couponPostServerAdds: string[];
}

function loadExpected(): ExpectedObserved {
  return JSON.parse(
    readFileSync(path.join(TINY_APP, "expected-observed.json"), "utf8"),
  ) as ExpectedObserved;
}

async function bundleHarness(
  sourcemap: boolean,
): Promise<{ dir: string; serverBundle: string; clientBundle: string }> {
  const dir = makeTempDir();
  const serverBundle = path.join(dir, "server.mjs");
  const clientBundle = path.join(dir, "client.mjs");
  const shared = { bundle: true, format: "esm", sourcemap, logLevel: "silent" } as const;
  await build({
    ...shared,
    entryPoints: [path.join(TINY_APP, "harness/server.ts")],
    outfile: serverBundle,
    platform: "node",
    jsx: "automatic",
  });
  await build({
    ...shared,
    entryPoints: [path.join(TINY_APP, "harness/client.ts")],
    outfile: clientBundle,
    platform: "browser",
  });
  return { dir, serverBundle, clientBundle };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHarness(port: number, child: { output(): string }): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`harness server did not start:\n${child.output()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("V8 normalization", () => {
  it("keeps outermost ranges of invoked functions, drops script + uninvoked", () => {
    const ranges = executedFunctionRanges({
      url: "file:///app/bundle.js",
      functions: [
        {
          functionName: "",
          ranges: [{ startOffset: 0, endOffset: 1000, count: 1 }],
        },
        {
          functionName: "used",
          ranges: [
            { startOffset: 100, endOffset: 200, count: 3 },
            { startOffset: 120, endOffset: 140, count: 0 },
          ],
        },
        {
          functionName: "unused",
          ranges: [{ startOffset: 300, endOffset: 400, count: 0 }],
        },
        {
          functionName: "",
          ranges: [{ startOffset: 150, endOffset: 170, count: 2 }],
        },
      ],
    });
    expect(ranges).toEqual([
      { startOffset: 100, endOffset: 200, count: 3 },
      { startOffset: 150, endOffset: 170, count: 2 },
    ]);
  });

  it("parses NODE_V8_COVERAGE directory files and their source-map cache", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "coverage-1-1.json"),
      JSON.stringify({
        result: [
          { scriptId: "1", url: "file:///app/a.js", functions: [] },
          { scriptId: "2", url: "node:internal/x", functions: [] },
        ],
        "source-map-cache": {
          "file:///app/a.js": { url: null, data: { mappings: "", sources: [] } },
        },
      }),
    );
    writeFileSync(path.join(dir, "unrelated.json"), "{}");
    const parsed = parseNodeCoverageDir(dir);
    expect(parsed.scripts.map((s) => s.url)).toEqual([
      "file:///app/a.js",
      "node:internal/x",
    ]);
    expect(parsed.sourceMaps.has("file:///app/a.js")).toBe(true);
    expect(parseNodeCoverageDir(path.join(dir, "missing")).scripts).toEqual([]);
  });
});

describe("range→symbol mapping", () => {
  let index: IndexResult;
  let cartText: string;

  beforeAll(async () => {
    index = await indexProject(TINY_APP);
    cartText = readFileSync(path.join(TINY_APP, "src/lib/cart.ts"), "utf8");
  }, TIMEOUT);

  it("attributes anonymous callbacks and survives end-offset overshoot", () => {
    const callback = cartText.indexOf("(i) => i.sku");
    const result = mapRangesToSymbols(
      [
        {
          file: "src/lib/cart.ts",
          startOffset: callback,
          endOffset: callback + 10,
          origin: "client",
        },
        {
          // Starts inside addItem but runs past its end (segment overshoot).
          file: "src/lib/cart.ts",
          startOffset: cartText.indexOf("existing.quantity"),
          endOffset: cartText.length,
          origin: "server",
        },
        {
          // Module top-level (interface): no named symbol, ignored.
          file: "src/lib/cart.ts",
          startOffset: cartText.indexOf("sku: string"),
          endOffset: cartText.indexOf("sku: string") + 4,
          origin: "client",
        },
      ],
      index.symbols,
    );
    expect(result.byOrigin.client).toEqual(["src/lib/cart.ts#Cart.addItem"]);
    expect(result.byOrigin.server).toEqual(["src/lib/cart.ts#Cart.addItem"]);
    expect(result.ignoredRanges).toBe(1);
  });

  it("fails closed for an executed app script without a source map", () => {
    const script: ScriptInput = {
      url: "http://127.0.0.1/client.js",
      origin: "client",
      source: "function used() { return 1; }\nused();\n",
      functions: [
        {
          functionName: "used",
          ranges: [{ startOffset: 0, endOffset: 28, count: 1 }],
        },
      ],
    };
    const result = observeScripts([script], {
      rootDir: TINY_APP,
      symbols: index.symbols,
    });
    expect(result.ok).toBe(false);
    expect(result.unmappable).toEqual([
      {
        url: "http://127.0.0.1/client.js",
        origin: "client",
        reason: "no source map for executed app script",
      },
    ]);
    expect(result.merged).toEqual([]);
  });

  it("excludes runtime internals without failing", () => {
    const result = observeScripts(
      [
        {
          url: "node:internal/modules/cjs/loader",
          origin: "server",
          functions: [
            {
              functionName: "load",
              ranges: [{ startOffset: 0, endOffset: 10, count: 5 }],
            },
          ],
        },
      ],
      { rootDir: TINY_APP, symbols: index.symbols },
    );
    expect(result.ok).toBe(true);
    expect(result.merged).toEqual([]);
  });
});

describe("browser collector (structural)", () => {
  it("adapts entries and drives a page through start/goto/stop", async () => {
    const calls: string[] = [];
    const inputs = await collectBrowserScripts(
      {
        coverage: {
          startJSCoverage: async () => void calls.push("start"),
          stopJSCoverage: async () => {
            calls.push("stop");
            return [
              {
                url: "http://x/client.js",
                source: "code",
                functions: [],
              },
            ];
          },
        },
        goto: async () => void calls.push("goto"),
      },
      "http://x/",
      { resolveScript: () => ({ sourcePath: "/build/client.mjs" }) },
    );
    expect(calls).toEqual(["start", "goto", "stop"]);
    expect(inputs).toEqual([
      {
        url: "http://x/client.js",
        origin: "client",
        functions: [],
        source: "code",
        sourcePath: "/build/client.mjs",
        sourceMap: null,
      },
    ]);
    expect(browserEntriesToInputs([])).toEqual([]);
  });

  it("rejects pages without a coverage API", async () => {
    await expect(
      collectBrowserScripts({ goto: async () => undefined }, "http://x/"),
    ).rejects.toThrow(/Chromium required/);
  });
});

describe("Node child coverage (server path, no browser)", () => {
  it("observes exactly the symbols a bundled Node program runs", async () => {
    const dir = makeTempDir();
    const bundle = path.join(dir, "main.mjs");
    await build({
      entryPoints: [path.join(TINY_APP, "harness/node-main.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      sourcemap: true,
      logLevel: "silent",
    });
    const index = await indexProject(TINY_APP);
    const scripts = await runNodeWithCoverage({
      command: process.execPath,
      args: [bundle],
    });
    const result = observeScripts(scripts, {
      rootDir: TINY_APP,
      symbols: index.symbols,
      appGeneratedPaths: [bundle],
    });
    expect(result.ok).toBe(true);
    expect(result.server).toEqual([
      "src/lib/cart.ts#Cart.addItem",
      "src/lib/format.ts#formatPrice",
    ]);
    expect(result.client).toEqual([]);
  }, TIMEOUT);

  it("maps sources rewritten to non-existent absolute paths by suffix", async () => {
    // Node's source-map-cache can rewrite `sources` through symlinked
    // dirs (e.g. /private/var on macOS) to absolute paths that do not
    // exist; indexed files must still be found.
    const dir = makeTempDir();
    const bundle = path.join(dir, "main.mjs");
    await build({
      entryPoints: [path.join(TINY_APP, "harness/node-main.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      sourcemap: true,
      logLevel: "silent",
    });
    const index = await indexProject(TINY_APP);
    const scripts = await runNodeWithCoverage({
      command: process.execPath,
      args: [bundle],
    });
    const app = scripts.find((s) => s.url.endsWith("main.mjs"));
    expect(app).toBeDefined();
    const map = JSON.parse(readFileSync(`${bundle}.map`, "utf8")) as {
      sources: string[];
    };
    map.sources = map.sources.map((source) => {
      const abs = path.resolve(dir, source);
      return `file:///private${abs}`;
    });
    const result = observeScripts(
      [
        {
          url: app?.url ?? "",
          origin: "server",
          functions: app?.functions ?? [],
          source: readFileSync(bundle, "utf8"),
          sourcePath: bundle,
          sourceMap: map,
        },
      ],
      { rootDir: TINY_APP, symbols: index.symbols, appGeneratedPaths: [bundle] },
    );
    expect(result.ok).toBe(true);
    expect(result.server).toEqual([
      "src/lib/cart.ts#Cart.addItem",
      "src/lib/format.ts#formatPrice",
    ]);
  }, TIMEOUT);
});

describe("AT-05/AT-06: tiny-app page load (Chromium + Node server)", () => {
  let index: IndexResult;

  beforeAll(async () => {
    index = await indexProject(TINY_APP);
  }, TIMEOUT);

  async function observePageLoad(options: {
    sourcemap: boolean;
    coupon?: boolean;
  }): Promise<ReturnType<typeof observeScripts>> {
    const { serverBundle, clientBundle } = await bundleHarness(options.sourcemap);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawnWithCoverage({
      command: process.execPath,
      args: [serverBundle],
      env: {
        TINY_APP_PORT: String(port),
        TINY_APP_CLIENT_BUNDLE: clientBundle,
      },
    });
    let clientScripts: ScriptInput[] = [];
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      await waitForHarness(port, child);
      browser = await chromium.launch();
      const page = await browser.newPage();
      clientScripts = await collectBrowserScripts(page, `${baseUrl}/`, {
        resolveScript: (url) =>
          url.endsWith("/client.js") ? { sourcePath: clientBundle } : null,
      });
      const ready = await page.evaluate(
        () => document.documentElement.dataset["tinyAppReady"],
      );
      expect(ready).toBe("$43.97");
      if (options.coupon === true) {
        const response = await fetch(`${baseUrl}/api/coupons`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "SAVE10" }),
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await browser?.close();
    }
    const serverScripts = await child.stop();
    return observeScripts([...clientScripts, ...serverScripts], {
      rootDir: TINY_APP,
      symbols: index.symbols,
      appGeneratedPaths: [serverBundle, clientBundle, "/client.js"],
    });
  }

  it("AT-05: observed client/server/merged sets equal ground truth", async () => {
    const expected = loadExpected();
    const result = await observePageLoad({ sourcemap: true });
    expect(result.ok).toBe(true);
    expect(result.unmappable).toEqual([]);
    expect(result.client).toEqual(expected.pageLoad.client);
    expect(result.server).toEqual(expected.pageLoad.server);
    expect(result.merged).toEqual(expected.pageLoad.merged);
  }, TIMEOUT);

  it("posting a coupon adds exactly the POST symbol on the server", async () => {
    const expected = loadExpected();
    const result = await observePageLoad({ sourcemap: true, coupon: true });
    expect(result.ok).toBe(true);
    expect(result.client).toEqual(expected.pageLoad.client);
    expect(result.server).toEqual(
      [...expected.pageLoad.server, ...expected.couponPostServerAdds].sort(),
    );
  }, TIMEOUT);

  it("AT-06: without source maps, affected files are unmappable (fail closed)", async () => {
    const result = await observePageLoad({ sourcemap: false });
    expect(result.ok).toBe(false);
    const byOrigin = new Map(result.unmappable.map((u) => [u.origin, u]));
    expect(byOrigin.get("client")?.url).toContain("/client.js");
    expect(byOrigin.get("client")?.reason).toContain("no source map");
    expect(byOrigin.get("server")?.url).toContain("server.mjs");
    expect(byOrigin.get("server")?.reason).toContain("no source map");
    expect(result.merged).toEqual([]);
  }, TIMEOUT);
});
