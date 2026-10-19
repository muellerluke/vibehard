import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  discoverInFile,
  extractDeclarations,
  getFrameworkDriver,
  loadConfig,
  rewriteDeclaration,
} from "../src/index.js";
import { defineUses } from "../src/adapters/puppeteer/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");

const SPEC = `import { describeTest, withVibehardPage } from "vibehard/puppeteer";
import { shared } from "./uses.mjs";

describeTest("declared one", {
  uses: [...shared, 'src/lib/cart.ts#Cart.addItem'],
}, async () => {});

describeTest("undeclared one", async () => {});
`;

describe("vibehard/puppeteer declarations + discovery", () => {
  it("extracts describeTest declarations (auto-detected framework)", () => {
    const decls = extractDeclarations(SPEC, "e2e/app.test.mjs", {
      readImport: () => ({
        fileName: "uses.mjs",
        text: "export const shared = ['src/lib/format.ts#formatPrice'];",
      }),
    });
    expect(decls.map((d) => d.title)).toEqual(["declared one", "undeclared one"]);
    expect(decls[0]?.uses.kind).toBe("array");
    expect(decls[1]?.uses.kind).toBe("none");
  });

  it("record rewrite inserts the options object for an undeclared test", () => {
    const out = rewriteDeclaration(SPEC, "e2e/app.test.mjs", "undeclared one", [
      "src/lib/format.ts#formatPrice",
    ]);
    expect(out.changed).toBe(true);
    expect(out.finalDeclared).toEqual(["src/lib/format.ts#formatPrice"]);
    expect(out.text).toContain('describeTest("undeclared one", {');
    expect(out.text).toContain("'src/lib/format.ts#formatPrice'");
  });

  it("record rewrite preserves spreads and rewrites literals only", () => {
    const out = rewriteDeclaration(
      SPEC,
      "e2e/app.test.mjs",
      "declared one",
      ["src/lib/cart.ts#Cart.totalCents", "src/lib/format.ts#formatPrice"],
      {
        readImport: () => ({
          fileName: "uses.mjs",
          text: "export const shared = ['src/lib/format.ts#formatPrice'];",
        }),
      },
    );
    expect(out.text).toContain("...shared");
    expect(out.text).toContain("'src/lib/cart.ts#Cart.totalCents'");
    expect(out.text).not.toContain("'src/lib/cart.ts#Cart.addItem'");
    expect(out.finalDeclared).toEqual([
      "src/lib/cart.ts#Cart.totalCents",
      "src/lib/format.ts#formatPrice",
    ]);
  });

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

  it("defineUses is an identity helper for shared groups", () => {
    expect(defineUses({ uses: ["a.ts#A"] })).toEqual({ uses: ["a.ts#A"] });
  });
});
