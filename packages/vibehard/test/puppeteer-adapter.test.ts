import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { discoverInFile, getFrameworkDriver, loadConfig } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");

describe("vibehard/puppeteer discovery + driver", () => {
  it("static discovery lists tiny-app Puppeteer tests with stable IDs", () => {
    const tests = discoverInFile(
      TINY_APP,
      path.join(TINY_APP, "e2e-puppeteer/checkout.test.mjs"),
      {
        specifier: "vibehard/puppeteer",
        imports: [
          { specifier: "vibehard/puppeteer", test: ["describeTest", "test"], describe: ["describe"] },
          { specifier: "node:test", test: ["test", "it"], describe: ["describe"] },
        ],
        globals: { test: [], describe: [] },
        requireImport: false,
      },
    );
    expect(tests.map((t) => t.testId)).toEqual([
      "e2e-puppeteer/checkout.test.mjs::checkout page shows the cart total",
      "e2e-puppeteer/checkout.test.mjs::coupon api accepts a code",
    ]);
    expect(tests.every((t) => t.line > 0)).toBe(true);
  });

  it("the driver resolves framework name + installed version", async () => {
    const driver = getFrameworkDriver("puppeteer");
    expect(driver.name).toBe("puppeteer");
    expect(driver.version(TINY_APP)).toMatch(/^\d+\.\d+\.\d+/);
    const resolved = await loadConfig(TINY_APP, "vibehard.config.puppeteer.json");
    const listed = await driver.listTests(TINY_APP, resolved);
    expect(listed).toHaveLength(2);
  });
});
