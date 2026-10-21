import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import type { SymbolRecord } from "../src/index.js";
import {
  createProjectParser,
  dedupeSymbols,
  indexProject,
  loadProjectFileList,
  resolveAssetSpecifier,
} from "../src/indexer/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TIMEOUT = 180_000;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-parse-parity-"));
  tempDirs.push(dir);
  return dir;
}

function stripReferences(symbols: readonly SymbolRecord[]): SymbolRecord[] {
  return symbols.map((s) => {
    const copy: SymbolRecord = { ...s };
    delete copy.references;
    if (copy.hashSlices !== undefined) {
      copy.hashSlices = copy.hashSlices.map((slice) => ({ ...slice }));
    }
    return copy;
  });
}

/**
 * AT-S01: parse-only extraction equals `indexProject` extraction
 * (minus `references`) for every indexed file, and the asset files
 * discovered by parsing match the full index's asset symbols.
 */
async function expectParity(rootDir: string): Promise<void> {
  const full = await indexProject(rootDir);
  const parser = createProjectParser(rootDir);

  const byFile = new Map<string, SymbolRecord[]>();
  for (const symbol of full.symbols) {
    if (symbol.kind === "asset") continue;
    const list = byFile.get(symbol.file) ?? [];
    list.push(symbol);
    byFile.set(symbol.file, list);
  }
  expect(byFile.size).toBeGreaterThan(0);

  const parsedAssets = new Set<string>();
  for (const [file, expected] of byFile) {
    const text = readFileSync(path.resolve(rootDir, file), "utf8");
    const parsed = parser.parseFile(file, text);
    for (const asset of parsed.assetFiles) {
      if (existsSync(path.resolve(rootDir, asset))) parsedAssets.add(asset);
    }
    const actual = dedupeSymbols(parsed.symbols);
    expect(actual, `parse-only symbols differ for ${file} in ${rootDir}`).toEqual(
      stripReferences([...expected].sort((a, b) => (a.id < b.id ? -1 : 1))),
    );
  }

  const fullAssets = new Set(
    full.symbols.filter((s) => s.kind === "asset").map((s) => s.file),
  );
  expect([...parsedAssets].sort(), `asset files differ in ${rootDir}`).toEqual(
    [...fullAssets].sort(),
  );
}

describe("AT-S01: parse-only extraction parity", () => {
  it("matches on fixtures/tiny-app", async () => {
    await expectParity(path.join(REPO_ROOT, "fixtures/tiny-app"));
  }, TIMEOUT);

  for (const example of [
    "next-fullstack",
    "next-express",
    "next-cypress",
    "plain-puppeteer",
    "two-frontends",
  ]) {
    it(`matches on examples/${example}`, async () => {
      await expectParity(path.join(REPO_ROOT, "examples", example));
    }, TIMEOUT);
  }

  it("matches on packages/vibehard itself", async () => {
    await expectParity(path.join(REPO_ROOT, "packages/vibehard"));
  }, TIMEOUT);

  it("matches on a synthetic project of tricky declaration forms", async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          jsx: "react-jsx",
          strict: true,
          allowJs: true,
          skipLibCheck: true,
          experimentalDecorators: true,
          types: [],
        },
        include: ["src"],
      }),
    );
    const files: Record<string, string> = {
      "src/forms.ts": [
        "export const RATE = 3;",
        "export const { tax, tip = () => 1 } = { tax: 1 };",
        "export enum Color { Red, Green }",
        "export namespace N { export function inner() { return RATE; } export const v = 2; }",
        "function dec(target: unknown) { return target; }",
        "@dec export class Cart {",
        "  #secret = 1;",
        "  static make() { return new Cart(); }",
        '  ["check out"]() { return this.#secret; }',
        "  get total() { return 1; }",
        "  set total(v: number) { void v; }",
        "  static { /* init */ }",
        "}",
        "export const api = (() => ({ run() { return RATE; }, n: 1 }))();",
        "export const obj = { method() { return 1; }, get x() { return 2; } };",
        "exports.legacy = () => 4;",
        "const local = 5;",
        "export default local;",
        "",
      ].join("\n"),
      "src/page.tsx": [
        "export default function Page() { return <div>{1}</div>; }",
        "export const Helper = () => <span>hi</span>;",
        "",
      ].join("\n"),
      "src/route.ts": [
        "export async function GET() { return new Response('ok'); }",
        "export const POST = async () => new Response('ok');",
        "",
      ].join("\n"),
      "src/plain.js": [
        "export function jsFn() { return 1; }",
        "export const arrow = (x) => x + 1;",
        "",
      ].join("\n"),
      "src/comp.jsx": ["export const C = () => <p>jsx</p>;", ""].join("\n"),
      "src/data.json": JSON.stringify({ a: 1 }),
      "src/uses-asset.ts": [
        "import data from './data.json' with { type: 'json' };",
        "export function read() { return data; }",
        "",
      ].join("\n"),
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    await expectParity(dir);
  }, TIMEOUT);
});

describe("loadProjectFileList", () => {
  it("lists the tsconfig-included indexable files of tiny-app", () => {
    const files = loadProjectFileList(path.join(REPO_ROOT, "fixtures/tiny-app"));
    expect(files).toContain("src/lib/cart.ts");
    expect(files).toContain("src/app/checkout/page.tsx");
    expect(files.every((f) => !f.endsWith(".d.ts"))).toBe(true);
    expect(files).toEqual([...files].sort());
  });
});

describe("resolveAssetSpecifier", () => {
  it("resolves relative, alias, and root asset specifiers by path math", () => {
    expect(resolveAssetSpecifier("src/a/b.ts", "./x.json")).toBe("src/a/x.json");
    expect(resolveAssetSpecifier("src/a/b.ts", "../x.json")).toBe("src/x.json");
    expect(resolveAssetSpecifier("src/a/b.ts", "@/img/logo.png")).toBe("src/img/logo.png");
    expect(resolveAssetSpecifier("src/a/b.ts", "/static/site.css")).toBe("static/site.css");
    expect(resolveAssetSpecifier("src/a/b.ts", "./x.json?v=1")).toBe("src/a/x.json");
    expect(resolveAssetSpecifier("b.ts", "./x.json")).toBe("x.json");
  });

  it("rejects bare specifiers and paths escaping the root", () => {
    expect(resolveAssetSpecifier("src/b.ts", "pkg/x.json")).toBeNull();
    expect(resolveAssetSpecifier("src/b.ts", "../../x.json")).toBeNull();
    expect(resolveAssetSpecifier("src/b.ts", "./node_modules/x.json")).toBeNull();
  });
});
