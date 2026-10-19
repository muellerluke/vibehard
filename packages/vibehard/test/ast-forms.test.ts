import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import {
  computeChangedSymbolsForFile,
  computeTouchedSet,
  findEnclosingSymbol,
  hashSymbolSources,
  indexProject,
  mapRangesToSymbols,
  observeScripts,
  runNodeWithCoverage,
  type IndexResult,
  type SymbolRecord,
} from "../src/index.js";

const TIMEOUT = 60_000;
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-ast-forms-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Write a synthetic project (self-contained tsconfig) to a temp dir. */
function writeProject(files: Record<string, string>): string {
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
        types: [],
      },
      include: ["src"],
    }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const FILE = "src/forms.ts";

interface Indexed {
  dir: string;
  result: IndexResult;
  byId: Map<string, SymbolRecord>;
}

async function indexSource(
  source: string,
  extraFiles: Record<string, string> = {},
): Promise<Indexed> {
  const dir = writeProject({ [FILE]: source, ...extraFiles });
  const result = await indexProject(dir);
  // No declaration form may collapse two symbols onto one ID.
  expect(new Set(result.symbols.map((s) => s.id)).size).toBe(result.symbols.length);
  return { dir, result, byId: new Map(result.symbols.map((s) => [s.id, s])) };
}

function offsetOf(source: string, needle: string): number {
  const at = source.indexOf(needle);
  expect(at).toBeGreaterThanOrEqual(0);
  return at;
}

/** Map one executed needle range in FILE to symbols. */
function mapNeedle(indexed: Indexed, source: string, needle: string): string[] {
  const start = offsetOf(source, needle);
  const mapped = mapRangesToSymbols(
    [{ file: FILE, startOffset: start, endOffset: start + needle.length, origin: "server" }],
    indexed.result.symbols,
  );
  expect(mapped.ignoredRanges).toBe(0);
  return mapped.merged;
}

/** Changed symbols for a one-line edit on the needle's line. */
function changedForNeedle(indexed: Indexed, source: string, needle: string): string[] {
  const line = source.slice(0, offsetOf(source, needle)).split("\n").length;
  const fileSymbols = indexed.result.symbols.filter((s) => s.file === FILE);
  const hashes = hashSymbolSources(indexed.dir, fileSymbols);
  const changed = computeChangedSymbolsForFile({
    status: "M",
    baseSymbols: fileSymbols,
    headSymbols: fileSymbols,
    baseHashes: hashes,
    headHashes: hashes,
    hunks: [{ oldStart: line, oldCount: 1, newStart: line, newCount: 1 }],
    binary: false,
    baseText: source,
    headText: source,
  });
  expect(changed.unmappedLines).toBe(false);
  return changed.changedSymbols;
}

describe("module fallback for unnamed executed code", () => {
  it("attributes a top-level anonymous handler to <module>, and edits select it", async () => {
    const source = [
      "export function used() { return 1; }",
      "setTimeout(() => {",
      "  (globalThis as Record<string, unknown>).__astForms = used();",
      "}, 0);",
      "",
    ].join("\n");
    const indexed = await indexSource(source);

    // The finder itself still answers null (remap host detection
    // depends on it); the fallback lives in the mapping layer.
    const at = offsetOf(source, "__astForms");
    expect(findEnclosingSymbol(indexed.result.symbols, FILE, at, at + 4)).toBeNull();

    const mapped = mapNeedle(indexed, source, "__astForms = used()");
    expect(mapped).toEqual([`${FILE}#<module>`]);

    const touched = computeTouchedSet(mapped, indexed.result.symbols);
    const changed = changedForNeedle(indexed, source, "__astForms = used()");
    expect(changed).toContain(`${FILE}#<module>`);
    expect(changed.some((id) => id in touched)).toBe(true);
  }, TIMEOUT);

  it("attributes a dynamically computed method to its class symbol", async () => {
    const source = [
      'const key = "dyn";',
      "export class Dyn {",
      "  [key]() { return 9; }",
      "}",
      "",
    ].join("\n");
    const indexed = await indexSource(source);
    expect(indexed.byId.has(`${FILE}#Dyn.dyn`)).toBe(false);
    expect(mapNeedle(indexed, source, "return 9")).toEqual([`${FILE}#Dyn`]);
    expect(changedForNeedle(indexed, source, "return 9")).toContain(`${FILE}#Dyn`);
  }, TIMEOUT);
});

describe("destructured declarations", () => {
  const source = [
    "export const settings = {",
    "  taxRate: 0.2,",
    '  currency: "USD",',
    "};",
    "export const { taxRate, currency: code } = settings;",
    "export const [first, , third = 3] = [1, 2, 3];",
    "export const { nested: { deep } } = { nested: { deep: 4 } };",
    "export function price(cents: number) { return cents * (1 + taxRate); }",
    "",
  ].join("\n");

  it("indexes each bound identifier and links it to the property it reads", async () => {
    const indexed = await indexSource(source);
    for (const name of ["taxRate", "code", "first", "third", "deep"]) {
      expect(indexed.byId.get(`${FILE}#${name}`)?.kind).toBe("value");
    }
    expect(indexed.byId.get(`${FILE}#price`)?.references).toContain(`${FILE}#taxRate`);
    expect(indexed.byId.get(`${FILE}#taxRate`)?.references).toContain(
      `${FILE}#settings.taxRate`,
    );
    expect(mapNeedle(indexed, source, "1 + taxRate")).toEqual([`${FILE}#price`]);
    // Editing the property selects through the binding chain.
    const touched = computeTouchedSet([`${FILE}#price`], indexed.result.symbols);
    expect(touched[`${FILE}#settings.taxRate`]).toBe("referenced");
    expect(changedForNeedle(indexed, source, "taxRate: 0.2")).toContain(
      `${FILE}#settings.taxRate`,
    );
  }, TIMEOUT);
});

describe("namespaces", () => {
  const source = [
    "export namespace Pricing {",
    "  export const rate = 0.2;",
    "  export function calculate(cents: number) { return cents * rate; }",
    "  export namespace Inner {",
    "    export const fee = 5;",
    "  }",
    "}",
    "export namespace Pricing {",
    "  export const surcharge = 1;",
    "}",
    "export function total(cents: number) {",
    "  return Pricing.calculate(cents) + Pricing.Inner.fee;",
    "}",
    "",
  ].join("\n");

  it("indexes nested and merged namespace members with qualified references", async () => {
    const indexed = await indexSource(source);
    expect(indexed.byId.get(`${FILE}#Pricing.rate`)?.kind).toBe("value");
    expect(indexed.byId.get(`${FILE}#Pricing.calculate`)?.kind).toBe("function");
    expect(indexed.byId.get(`${FILE}#Pricing.Inner.fee`)?.kind).toBe("value");
    expect(indexed.byId.get(`${FILE}#Pricing.surcharge`)?.kind).toBe("value");
    expect(indexed.byId.get(`${FILE}#Pricing.calculate`)?.references).toContain(
      `${FILE}#Pricing.rate`,
    );
    expect(indexed.byId.get(`${FILE}#total`)?.references).toContain(
      `${FILE}#Pricing.calculate`,
    );
    expect(indexed.byId.get(`${FILE}#total`)?.references).toContain(
      `${FILE}#Pricing.Inner.fee`,
    );
    expect(mapNeedle(indexed, source, "cents * rate")).toEqual([
      `${FILE}#Pricing.calculate`,
    ]);
    expect(changedForNeedle(indexed, source, "fee = 5")).toContain(
      `${FILE}#Pricing.Inner.fee`,
    );
  }, TIMEOUT);
});

describe("computed, private, and colliding class members", () => {
  const source = [
    "export class Cart {",
    "  #secret = 1;",
    "  #calculate() { return this.#secret; }",
    '  ["checkout"]() { return this.#calculate(); }',
    "  [Symbol.iterator]() { return this.#calculate(); }",
    "  get total() { return 1; }",
    "  set total(v: number) { void v; }",
    "  static create() { return new Cart(); }",
    "  create() { return 2; }",
    "  static get instance() { return 3; }",
    "}",
    "",
  ].join("\n");

  it("gives every member a distinct, always-disambiguated ID", async () => {
    const indexed = await indexSource(source);
    const kind = (name: string) => indexed.byId.get(`${FILE}#${name}`)?.kind;
    expect(kind("Cart")).toBe("class");
    expect(kind("Cart.#secret")).toBe("value");
    expect(kind("Cart.#calculate")).toBe("method");
    expect(kind("Cart.checkout")).toBe("method");
    expect(kind("Cart.Symbol.iterator")).toBe("method");
    expect(kind("Cart.total:get")).toBe("method");
    expect(kind("Cart.total:set")).toBe("method");
    expect(kind("Cart.static.create")).toBe("method");
    expect(kind("Cart.create")).toBe("method");
    expect(kind("Cart.static.instance:get")).toBe("method");

    expect(indexed.byId.get(`${FILE}#Cart.checkout`)?.references).toContain(
      `${FILE}#Cart.#calculate`,
    );
    expect(indexed.byId.get(`${FILE}#Cart.#calculate`)?.references).toContain(
      `${FILE}#Cart.#secret`,
    );
    expect(mapNeedle(indexed, source, "return this.#secret")).toEqual([
      `${FILE}#Cart.#calculate`,
    ]);
    expect(changedForNeedle(indexed, source, "set total")).toContain(
      `${FILE}#Cart.total:set`,
    );
  }, TIMEOUT);
});

describe("class symbol", () => {
  const source = [
    "export class Base {",
    "  value() { return 1; }",
    "}",
    "export class Cart extends Base {",
    "  total() { return this.value(); }",
    "  static {",
    "    (globalThis as Record<string, unknown>).__booted = true;",
    "  }",
    "}",
    "",
  ].join("\n");

  it("hashes only the header and static blocks, and touches through members", async () => {
    const indexed = await indexSource(source);
    const cart = indexed.byId.get(`${FILE}#Cart`);
    expect(cart?.kind).toBe("class");
    const sliceText = (cart?.hashSlices ?? [])
      .map((s) => source.slice(s.startOffset, s.endOffset))
      .join("\n");
    expect(sliceText).toContain("export class Cart extends Base");
    expect(sliceText).toContain("__booted");
    expect(sliceText).not.toContain("this.value()");

    expect(cart?.references).toContain(`${FILE}#Base`);
    expect(indexed.byId.get(`${FILE}#Cart.total`)?.references).toContain(
      `${FILE}#Base.value`,
    );

    const touched = computeTouchedSet([`${FILE}#Cart.total`], indexed.result.symbols);
    expect(touched[`${FILE}#Cart`]).toBe("class");
    expect(changedForNeedle(indexed, source, "extends Base")).toContain(`${FILE}#Cart`);
    expect(changedForNeedle(indexed, source, "__booted")).toContain(`${FILE}#Cart`);

    // Member-body edits do not churn the class hash; header edits do.
    const hashOf = async (text: string): Promise<string | undefined> => {
      const other = await indexSource(text);
      const record = other.byId.get(`${FILE}#Cart`);
      return hashSymbolSources(other.dir, record === undefined ? [] : [record])[
        `${FILE}#Cart`
      ];
    };
    const baseHash = await hashOf(source);
    expect(await hashOf(source.replace("return this.value()", "return 2"))).toBe(baseHash);
    expect(await hashOf(source.replace("extends Base", "extends Object"))).not.toBe(baseHash);
  }, TIMEOUT);
});

describe("object properties and literal access", () => {
  const source = [
    "export const settings = {",
    "  taxRate: 0.2,",
    '  currency: "USD",',
    "  limits: { max: 10 },",
    '  label() { return "x"; },',
    "  get doubled() { return 2; },",
    "};",
    "export function read() {",
    '  return settings.taxRate + settings["currency"].length;',
    "}",
    "",
  ].join("\n");

  it("indexes properties separately and resolves settings[\"currency\"]", async () => {
    const indexed = await indexSource(source);
    const kind = (name: string) => indexed.byId.get(`${FILE}#${name}`)?.kind;
    expect(kind("settings")).toBe("value");
    expect(kind("settings.taxRate")).toBe("value");
    expect(kind("settings.currency")).toBe("value");
    expect(kind("settings.limits")).toBe("value");
    expect(kind("settings.limits.max")).toBe("value");
    expect(kind("settings.label")).toBe("object-method");
    expect(kind("settings.doubled:get")).toBe("object-method");

    const refs = indexed.byId.get(`${FILE}#read`)?.references ?? [];
    expect(refs).toContain(`${FILE}#settings.taxRate`);
    expect(refs).toContain(`${FILE}#settings.currency`);
    // Only the read property is in the touched closure.
    const touched = computeTouchedSet([`${FILE}#read`], indexed.result.symbols);
    expect(touched[`${FILE}#settings.taxRate`]).toBe("referenced");
    expect(touched[`${FILE}#settings.currency`]).toBe("referenced");
    expect(touched[`${FILE}#settings.limits.max`]).toBeUndefined();
    expect(changedForNeedle(indexed, source, "taxRate: 0.2")).toContain(
      `${FILE}#settings.taxRate`,
    );
  }, TIMEOUT);
});

describe("factory-created and dynamically attached functions", () => {
  const source = [
    "export const api = (() => ({",
    "  checkout() { return 1; },",
    "  rate: 0.1,",
    "}))();",
    "export const api2 = (() => {",
    "  return { pay() { return 2; } };",
    "})();",
    "export const registry: Record<string, () => number> = {};",
    "registry.checkout = () => 3;",
    "declare const exports: Record<string, () => number>;",
    "exports.pay = () => 5;",
    "declare const module: { exports: Record<string, () => number> };",
    "module.exports = { ship() { return 6; } };",
    "",
  ].join("\n");

  it("derives names from the binding and assignment positions", async () => {
    const indexed = await indexSource(source);
    const kind = (name: string) => indexed.byId.get(`${FILE}#${name}`)?.kind;
    expect(kind("api")).toBe("value");
    expect(kind("api.checkout")).toBe("object-method");
    expect(kind("api.rate")).toBe("value");
    expect(kind("api2.pay")).toBe("object-method");
    expect(kind("registry.checkout")).toBe("arrow-function");
    expect(kind("exports.pay")).toBe("arrow-function");
    expect(kind("module.exports")).toBe("value");
    expect(kind("module.exports.ship")).toBe("object-method");
    expect(mapNeedle(indexed, source, "return 1")).toEqual([`${FILE}#api.checkout`]);
    expect(mapNeedle(indexed, source, "() => 3")).toEqual([`${FILE}#registry.checkout`]);
  }, TIMEOUT);
});

describe("decorator references", () => {
  const source = [
    "export function logged(target: unknown, ctx: unknown) { void target; void ctx; }",
    "export function tag(name: string) {",
    "  return (target: unknown, ctx: unknown) => { void name; void target; void ctx; };",
    "}",
    "@logged",
    "export class Service {",
    '  @tag("run")',
    "  run() { return 1; }",
    "}",
    "",
  ].join("\n");

  it("attributes class decorators to the class and method decorators to the method", async () => {
    const indexed = await indexSource(source);
    expect(indexed.byId.get(`${FILE}#Service`)?.references).toContain(`${FILE}#logged`);
    expect(indexed.byId.get(`${FILE}#Service.run`)?.references).toContain(`${FILE}#tag`);
    // The decorator is part of the class header hash.
    const slices = (indexed.byId.get(`${FILE}#Service`)?.hashSlices ?? [])
      .map((s) => source.slice(s.startOffset, s.endOffset))
      .join("\n");
    expect(slices).toContain("@logged");
  }, TIMEOUT);
});

describe("overloads", () => {
  it("indexes exactly the implementation of each overload set", async () => {
    const source = [
      "export function f(x: string): string;",
      "export function f(x: number): number;",
      "export function f(x: unknown) { return x; }",
      "export class O {",
      "  m(x: string): string;",
      "  m(x: number): number;",
      "  m(x: unknown) { return String(x); }",
      "}",
      "",
    ].join("\n");
    const indexed = await indexSource(source);
    const named = indexed.result.symbols.filter(
      (s) => s.qualifiedName === "f" || s.qualifiedName === "O.m",
    );
    expect(named.map((s) => s.id).sort()).toEqual([`${FILE}#O.m`, `${FILE}#f`]);
  }, TIMEOUT);
});

describe("real V8 coverage over the new forms", () => {
  it("observes computed, private, namespace, and destructured symbols executing", async () => {
    const forms = [
      "export namespace Pricing {",
      "  export const rate = 0.2;",
      "  export function calculate(cents: number) { return cents * rate; }",
      "}",
      "export const settings = { taxRate: 0.1 };",
      "export const { taxRate } = settings;",
      "export class Cart {",
      "  #n = 2;",
      "  #calculate() { return this.#n; }",
      '  ["checkout"]() { return this.#calculate() + taxRate; }',
      "}",
      "export function runAll() {",
      "  const cart = new Cart() as unknown as { checkout(): number };",
      "  return cart.checkout() + Pricing.calculate(100);",
      "}",
      "",
    ].join("\n");
    const dir = writeProject({
      [FILE]: forms,
      "src/main.ts": 'import { runAll } from "./forms";\nprocess.stdout.write(String(runAll()));\n',
    });
    const bundle = path.join(dir, "main.mjs");
    await build({
      entryPoints: [path.join(dir, "src/main.ts")],
      outfile: bundle,
      bundle: true,
      format: "esm",
      platform: "node",
      sourcemap: true,
      logLevel: "silent",
    });
    const indexed = await indexProject(dir);
    const scripts = await runNodeWithCoverage({ command: process.execPath, args: [bundle] });
    const observed = observeScripts(scripts, {
      rootDir: dir,
      symbols: indexed.symbols,
      appGeneratedPaths: [bundle],
    });
    expect(observed.ok).toBe(true);
    expect(observed.server).toEqual(
      expect.arrayContaining([
        `${FILE}#Pricing.calculate`,
        `${FILE}#Cart.checkout`,
        `${FILE}#Cart.#calculate`,
        `${FILE}#runAll`,
      ]),
    );
    // The destructured constant and its source property are touched
    // through the static-reference closure from the executed method.
    const touched = computeTouchedSet(observed.merged, indexed.symbols);
    expect(touched[`${FILE}#taxRate`]).toBe("referenced");
    expect(touched[`${FILE}#settings.taxRate`]).toBe("referenced");
    expect(touched[`${FILE}#Cart`]).toBe("class");
  }, TIMEOUT);
});



