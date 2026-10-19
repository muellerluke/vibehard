import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createIndexCache,
  findEnclosingSymbol,
  indexProject,
  type IndexCache,
  type IndexResult,
  type SymbolRecord,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../..");
const TINY_APP = path.join(REPO_ROOT, "fixtures/tiny-app");
const TIMEOUT = 30_000;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vibehard-indexer-"));
  tempDirs.push(dir);
  return dir;
}

/** Copy fixtures/tiny-app to a temp dir, fixing the relative `extends`. */
function copyTinyApp(): string {
  const dir = makeTempDir();
  cpSync(TINY_APP, dir, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  const tsconfigPath = path.join(dir, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
    extends?: string;
  };
  tsconfig.extends = path.join(REPO_ROOT, "tsconfig.base.json");
  writeFileSync(tsconfigPath, JSON.stringify(tsconfig));
  return dir;
}

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

function loadExpected(): SymbolRecord[] {
  return JSON.parse(
    readFileSync(path.join(TINY_APP, "expected-symbols.json"), "utf8"),
  ) as SymbolRecord[];
}

function ids(result: IndexResult): string[] {
  return result.symbols.map((s) => s.id);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AT-02: indexer on fixtures/tiny-app", () => {
  let result: IndexResult;

  beforeAll(async () => {
    result = await indexProject(TINY_APP);
  }, TIMEOUT);

  it("returns exactly the ground-truth symbol table", () => {
    const expected = loadExpected();
    expect(result.symbols).toHaveLength(expected.length);
    const byId = new Map(result.symbols.map((s) => [s.id, s]));
    for (const record of expected) {
      expect(byId.get(record.id)).toEqual(record);
    }
  });

  it("returns symbols sorted by ID", () => {
    expect(ids(result)).toEqual([...ids(result)].sort());
  });

  it("ranges slice to their name-bearing declaration text", () => {
    const heads: Record<string, string> = {
      "src/lib/cart.ts#Cart.addItem": "addItem(item: CartItem)",
      "src/lib/format.ts#formatPrice": "formatPrice = (cents",
      "src/app/checkout/page.tsx#CheckoutPage":
        "export default function CheckoutPage",
      "src/app/api/coupons/route.ts#POST": "export async function POST",
    };
    for (const record of result.symbols) {
      const text = readFileSync(path.join(TINY_APP, record.file), "utf8");
      const slice = text.slice(record.startOffset, record.endOffset);
      expect(slice.startsWith(heads[record.id] ?? "")).toBe(true);
      // Executable declarations end with their body; value/module
      // symbols end with their declaration / the whole file.
      if (record.kind !== "value" && record.kind !== "module") {
        expect(slice.trimEnd().endsWith("}")).toBe(true);
      } else {
        expect(slice.length).toBeGreaterThan(0);
      }
    }
  });

  it("builds the import graph with app files only", () => {
    expect([...result.imports.keys()].sort()).toEqual([
      "src/app/api/coupons/route.ts",
      "src/app/checkout/page.tsx",
      "src/lib/cart.ts",
      "src/lib/format.ts",
    ]);
    expect(result.imports.get("src/app/checkout/page.tsx")).toEqual([
      "src/lib/format.ts",
    ]);
    for (const edges of result.imports.values()) {
      for (const edge of edges) {
        expect(edge).not.toContain("node_modules");
        expect(edge).not.toContain("react");
      }
    }
  });

  it("reports no diagnostics for the fixture", () => {
    expect(result.diagnostics).toEqual([]);
  });

  it("is deterministic across two uncached runs", async () => {
    const again = await indexProject(TINY_APP);
    expect(again.symbols).toEqual(result.symbols);
    expect([...again.imports.entries()]).toEqual([
      ...result.imports.entries(),
    ]);
  }, TIMEOUT);
});

describe("AT-03: symbol ID stability", () => {
  const expectedIds = [
    "src/app/api/coupons/route.ts#<module>",
    "src/app/api/coupons/route.ts#POST",
    "src/app/checkout/page.tsx#<module>",
    "src/app/checkout/page.tsx#CheckoutPage",
    "src/lib/cart.ts#<module>",
    "src/lib/cart.ts#Cart",
    "src/lib/cart.ts#Cart.addItem",
    "src/lib/cart.ts#Cart.items",
    "src/lib/format.ts#<module>",
    "src/lib/format.ts#CENTS_PER_DOLLAR",
    "src/lib/format.ts#formatPrice",
  ];

  it("reformatting within files does not change any symbol ID", async () => {
    const dir = copyTinyApp();
    const cartPath = path.join(dir, "src/lib/cart.ts");
    writeFileSync(
      cartPath,
      `// reformatted copy\n\n\n${readFileSync(cartPath, "utf8")}`,
    );
    const formatPath = path.join(dir, "src/lib/format.ts");
    writeFileSync(
      formatPath,
      readFileSync(formatPath, "utf8").replace("\n  return", "\n      return"),
    );
    expect(ids(await indexProject(dir))).toEqual(expectedIds);
  }, TIMEOUT);

  it("moving a declaration within its file does not change IDs", async () => {
    const files = (body: string): Record<string, string> => ({
      "src/two.ts": body,
    });
    const before = await indexProject(
      writeProject(
        files(
          "export function alpha() { return 1; }\n\nexport function beta() { return 2; }\n",
        ),
      ),
    );
    const after = await indexProject(
      writeProject(
        files(
          "export function beta() { return 2; }\n\nexport function alpha() { return 1; }\n",
        ),
      ),
    );
    expect(ids(after)).toEqual(ids(before));
    expect(ids(before)).toEqual([
      "src/two.ts#<module>",
      "src/two.ts#alpha",
      "src/two.ts#beta",
    ]);
  }, TIMEOUT);

  it("renaming a function changes exactly its own ID", async () => {
    const dir = copyTinyApp();
    const cartPath = path.join(dir, "src/lib/cart.ts");
    writeFileSync(
      cartPath,
      readFileSync(cartPath, "utf8").replace("addItem", "addEntry"),
    );
    const result = await indexProject(dir);
    const removed = expectedIds.filter((id) => !ids(result).includes(id));
    const added = ids(result).filter((id) => !expectedIds.includes(id));
    expect(removed).toEqual(["src/lib/cart.ts#Cart.addItem"]);
    expect(added).toEqual(["src/lib/cart.ts#Cart.addEntry"]);
    // Untouched files keep identical records, ranges included.
    const byId = new Map(result.symbols.map((s) => [s.id, s]));
    for (const record of loadExpected()) {
      if (record.file === "src/lib/cart.ts") continue;
      expect(byId.get(record.id)).toEqual(record);
    }
  }, TIMEOUT);
});

describe("AT-04: enclosing-symbol lookup", () => {
  let result: IndexResult;
  let cartText: string;

  beforeAll(async () => {
    result = await indexProject(TINY_APP);
    cartText = readFileSync(path.join(TINY_APP, "src/lib/cart.ts"), "utf8");
  }, TIMEOUT);

  function lookup(needle: string, length = 4): SymbolRecord | null {
    const start = cartText.indexOf(needle);
    expect(start).toBeGreaterThanOrEqual(0);
    return findEnclosingSymbol(
      result.symbols,
      "src/lib/cart.ts",
      start,
      start + length,
    );
  }

  it("attributes an anonymous callback to the enclosing named symbol", () => {
    expect(lookup("(i) => i.sku")?.id).toBe("src/lib/cart.ts#Cart.addItem");
  });

  it("resolves a range inside a method body to that method", () => {
    expect(lookup("existing.quantity")?.id).toBe("src/lib/cart.ts#Cart.addItem");
  });

  it("resolves a range equal to the symbol's own range", () => {
    const record = result.symbols.find(
      (s) => s.id === "src/lib/cart.ts#Cart.addItem",
    );
    expect(record).toBeDefined();
    const found = findEnclosingSymbol(
      result.symbols,
      "src/lib/cart.ts",
      record?.startOffset ?? -1,
      record?.endOffset ?? -1,
    );
    expect(found?.id).toBe("src/lib/cart.ts#Cart.addItem");
  });

  it("returns null outside every named symbol", () => {
    expect(lookup("sku: string")).toBeNull(); // inside the CartItem interface
  });

  it("indexes class fields as value symbols enclosing their initializer", () => {
    // `readonly items: CartItem[] = [];` in tiny-app's Cart class.
    expect(lookup("= []")?.id).toBe("src/lib/cart.ts#Cart.items");
  });

  it("returns null for partial overlaps, reversed ranges, unknown files", () => {
    const inside = cartText.indexOf("existing.quantity");
    expect(
      findEnclosingSymbol(
        result.symbols,
        "src/lib/cart.ts",
        inside,
        cartText.length, // extends past the method's end
      ),
    ).toBeNull();
    expect(
      findEnclosingSymbol(result.symbols, "src/lib/cart.ts", inside, inside - 1),
    ).toBeNull();
    expect(
      findEnclosingSymbol(result.symbols, "src/nope.ts", 0, 1),
    ).toBeNull();
  });
});

describe("synthetic projects: JS/JSX and remaining symbol kinds", () => {
  it("indexes JS, JSX, object methods, getters, and folds nested functions", async () => {
    const handlers = [
      "export const handlers = {",
      "  save() { return 1; },",
      "  load: () => 2,",
      "  nested: { deep() { return 3; } },",
      "};",
      "export class Box {",
      "  get value() { return 42; }",
      "  outer() {",
      "    function innerHelper() { return 7; }",
      "    return innerHelper();",
      "  }",
      "}",
      "export function withInner() {",
      "  const helper = () => 9;",
      "  return helper();",
      "}",
      "",
    ].join("\n");
    const dir = writeProject({
      "src/plain.js":
        'export function greet(name) { return "hi " + name; }\n',
      "src/widget.jsx": "export const Widget = () => <div>hi</div>;\n",
      "src/handlers.ts": handlers,
      "src/app/page.tsx": "export default () => <main>anon</main>;\n",
      "src/app/api/route.ts":
        'export const GET = async () => new Response("ok");\n',
    });
    const result = await indexProject(dir);
    const byId = new Map(result.symbols.map((s) => [s.id, s]));

    expect(byId.get("src/plain.js#greet")?.kind).toBe("function");
    expect(byId.get("src/widget.jsx#Widget")?.kind).toBe("arrow-function");
    expect(byId.get("src/handlers.ts#handlers.save")?.kind).toBe(
      "object-method",
    );
    expect(byId.get("src/handlers.ts#handlers.load")?.kind).toBe(
      "object-method",
    );
    expect(byId.get("src/handlers.ts#handlers.nested.deep")?.kind).toBe(
      "object-method",
    );
    expect(byId.get("src/handlers.ts#Box.value:get")?.kind).toBe("method");
    expect(byId.get("src/handlers.ts#Box.outer")?.kind).toBe("method");
    expect(byId.get("src/handlers.ts#withInner")?.kind).toBe("function");
    expect(byId.get("src/app/page.tsx#default")?.kind).toBe("page-export");
    expect(byId.get("src/app/api/route.ts#GET")?.kind).toBe("route-export");

    // The class itself is a symbol (its header); an object binding is a
    // value symbol whose methods are smaller symbols inside it. Nested
    // functions fold.
    expect(byId.get("src/handlers.ts#Box")?.kind).toBe("class");
    expect(byId.get("src/handlers.ts#handlers")?.kind).toBe("value");
    expect(
      result.symbols.some((s) => s.qualifiedName.includes("innerHelper")),
    ).toBe(false);
    expect(result.symbols.some((s) => s.qualifiedName.includes("helper"))).toBe(
      false,
    );

    const inner = handlers.indexOf("return 7");
    expect(
      findEnclosingSymbol(result.symbols, "src/handlers.ts", inner, inner + 4)
        ?.id,
    ).toBe("src/handlers.ts#Box.outer");
    const helperBody = handlers.indexOf("=> 9");
    expect(
      findEnclosingSymbol(
        result.symbols,
        "src/handlers.ts",
        helperBody,
        helperBody + 4,
      )?.id,
    ).toBe("src/handlers.ts#withInner");
  }, TIMEOUT);
});

describe("content-hash cache", () => {
  it("reuses per-file results and re-walks only changed files", async () => {
    const dir = copyTinyApp();
    const cache = createIndexCache();

    const first = await indexProject(dir, { cache });
    expect(first.stats).toEqual({
      filesTotal: 4,
      filesParsed: 4,
      cacheHits: 0,
    });
    expect(first.cache).toBe(cache);

    const second = await indexProject(dir, { cache });
    expect(second.stats).toEqual({
      filesTotal: 4,
      filesParsed: 0,
      cacheHits: 4,
    });
    expect(second.symbols).toEqual(first.symbols);

    const formatPath = path.join(dir, "src/lib/format.ts");
    writeFileSync(formatPath, `${readFileSync(formatPath, "utf8")}// touched\n`);
    const third = await indexProject(dir, { cache });
    expect(third.stats).toEqual({
      filesTotal: 4,
      filesParsed: 1,
      cacheHits: 3,
    });
    expect(ids(third)).toEqual(ids(first));
  }, TIMEOUT);

  it("ignores a cache with a mismatched version", async () => {
    const dir = copyTinyApp();
    const bogus = { version: 99, entries: {} } as unknown as IndexCache;
    const result = await indexProject(dir, { cache: bogus });
    expect(result.cache).not.toBe(bogus);
    expect(result.cache?.version).toBe(2);
    expect(result.stats.filesParsed).toBe(4);
  }, TIMEOUT);
});

describe("edge cases", () => {
  it("throws for a missing root directory", async () => {
    await expect(
      indexProject(path.join(tmpdir(), "vibehard-does-not-exist-xyz")),
    ).rejects.toThrow(/not found/);
  });

  it("indexes an empty directory to an empty result", async () => {
    const result = await indexProject(makeTempDir());
    expect(result.symbols).toEqual([]);
    expect(result.imports.size).toBe(0);
    expect(result.stats.filesTotal).toBe(0);
  }, TIMEOUT);

  it("reports syntax errors as diagnostics without throwing", async () => {
    const dir = writeProject({
      "src/good.ts": "export function good() { return 1; }\n",
      "src/broken.ts": "export function broken( {\n",
    });
    const result = await indexProject(dir);
    expect(ids(result)).toContain("src/good.ts#good");
    expect(result.diagnostics.some((d) => d.file === "src/broken.ts")).toBe(
      true,
    );
  }, TIMEOUT);
});

describe("Stage 5: Next.js shapes", () => {
  it("indexes server actions and Pages API handlers, excludes .next output", async () => {
    const dir = writeProject({
      "src/app/actions.ts":
        '"use server";\nexport async function saveNote(note: string) { return { ok: note.length > 0 }; }\n',
      "src/pages/api/hello.ts":
        "export default function handler(req: unknown, res: { json: (v: unknown) => void }) { res.json({ ok: true }); }\n",
      "src/.next/types/gen.ts": "export function generated() { return 1; }\n",
    });
    const result = await indexProject(dir);
    const found = ids(result);
    expect(found).toContain("src/app/actions.ts#saveNote");
    expect(found).toContain("src/pages/api/hello.ts#handler");
    expect(found.some((id) => id.includes(".next"))).toBe(false);
    const action = result.symbols.find((s) => s.id === "src/app/actions.ts#saveNote");
    expect(action?.kind).toBe("function");
  }, TIMEOUT);
});

describe("value/module/asset symbols and references", () => {
  it("indexes constants, enums, class fields, module symbols, assets, and reference edges", async () => {
    const dir = writeProject({
      "src/lib/pricing.ts": [
        "export const TAX_RATE = 0.2;",
        "export enum Tier { Basic, Pro }",
        "export function applyTax(cents: number): number {",
        "  return cents * (1 + TAX_RATE);",
        "}",
        "export class Pricer {",
        "  rate = TAX_RATE;",
        "  total(cents: number): number { return applyTax(cents) * this.rate; }",
        "}",
        "",
      ].join("\n"),
      "src/lib/page.ts": [
        'import data from "./data.json";',
        'import { applyTax } from "./pricing";',
        "export function renderPrice(cents: number): string {",
        "  return `${data.label}:${applyTax(cents)}`;",
        "}",
        "",
      ].join("\n"),
      "src/lib/data.json": '{"label":"total"}\n',
    });
    const result = await indexProject(dir);
    const byId = new Map(result.symbols.map((s) => [s.id, s]));

    expect(byId.get("src/lib/pricing.ts#TAX_RATE")?.kind).toBe("value");
    expect(byId.get("src/lib/pricing.ts#Tier")?.kind).toBe("value");
    expect(byId.get("src/lib/pricing.ts#Pricer.rate")?.kind).toBe("value");
    expect(byId.get("src/lib/pricing.ts#<module>")?.kind).toBe("module");
    expect(byId.get("src/lib/data.json#<file>")?.kind).toBe("asset");

    // A function that reads a top-level constant references its symbol.
    expect(byId.get("src/lib/pricing.ts#applyTax")?.references).toContain(
      "src/lib/pricing.ts#TAX_RATE",
    );
    // Class field -> constant, method -> field and helper.
    expect(byId.get("src/lib/pricing.ts#Pricer.rate")?.references).toContain(
      "src/lib/pricing.ts#TAX_RATE",
    );
    expect(byId.get("src/lib/pricing.ts#Pricer.total")?.references).toContain(
      "src/lib/pricing.ts#Pricer.rate",
    );
    expect(byId.get("src/lib/pricing.ts#Pricer.total")?.references).toContain(
      "src/lib/pricing.ts#applyTax",
    );
    // Cross-file function reference and JSON asset reference.
    expect(byId.get("src/lib/page.ts#renderPrice")?.references).toContain(
      "src/lib/pricing.ts#applyTax",
    );
    expect(byId.get("src/lib/page.ts#renderPrice")?.references).toContain(
      "src/lib/data.json#<file>",
    );
    // The importing file's module symbol also references the asset.
    expect(byId.get("src/lib/page.ts#<module>")?.references).toContain(
      "src/lib/data.json#<file>",
    );
    // Module hash slices cover import lines, not function bodies.
    const pageText = readFileSync(path.join(dir, "src/lib/page.ts"), "utf8");
    const slices = (byId.get("src/lib/page.ts#<module>")?.hashSlices ?? [])
      .map((s) => pageText.slice(s.startOffset, s.endOffset))
      .join("\n");
    expect(slices).toContain("import data");
    expect(slices).not.toContain("applyTax(cents)");
  }, TIMEOUT);
});


