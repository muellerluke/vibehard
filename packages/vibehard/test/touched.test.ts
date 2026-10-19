import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { SymbolRecord } from "../src/index.js";
import { hashSymbolSources } from "../src/verifier/lockfile.js";
import { parseLockfile } from "../src/verifier/lockfile.js";
import { computeTouchedSet } from "../src/verifier/touched.js";

function sym(
  id: string,
  kind: SymbolRecord["kind"],
  references: string[] = [],
): SymbolRecord {
  const file = id.slice(0, id.indexOf("#"));
  return {
    id,
    file,
    qualifiedName: id.slice(id.indexOf("#") + 1),
    kind,
    startOffset: 0,
    endOffset: 10,
    startLine: 1,
    endLine: 1,
    references,
  };
}

const TAX = "src/lib/pricing.ts#TAX_RATE";
const APPLY = "src/lib/pricing.ts#applyTax";
const MODULE = "src/lib/pricing.ts#<module>";
const UNUSED = "src/lib/pricing.ts#UNUSED";
const HELPER = "src/lib/other.ts#helper";
const HELPER_CONST = "src/lib/other.ts#HELPER_CONST";
const ASSET = "src/lib/data.json#<file>";

const symbols: SymbolRecord[] = [
  sym(TAX, "value"),
  sym(APPLY, "function", [TAX, HELPER]),
  sym(MODULE, "module"),
  sym(UNUSED, "value"),
  sym(HELPER, "function", [HELPER_CONST]),
  sym(HELPER_CONST, "value"),
  sym("src/lib/other.ts#<module>", "module"),
  sym(ASSET, "asset"),
  sym("src/lib/page.ts#renderPrice", "function", [APPLY, ASSET]),
  sym("src/lib/page.ts#<module>", "module", [ASSET]),
  sym("src/server.ts#port", "value"),
  sym("src/server.ts#<module>", "module", [APPLY]),
];

describe("computeTouchedSet", () => {
  it("expands an executed function to its referenced constants and file module", () => {
    const touched = computeTouchedSet([APPLY], symbols);
    expect(touched[APPLY]).toBe("direct");
    expect(touched[TAX]).toBe("referenced");
    expect(touched[MODULE]).toBe("module");
    // Unreferenced constants in the same file are not touched.
    expect(touched[UNUSED]).toBeUndefined();
  });

  it("does not pull in an unexecuted callee or its constants", () => {
    const touched = computeTouchedSet([APPLY], symbols);
    expect(touched[HELPER]).toBeUndefined();
    expect(touched[HELPER_CONST]).toBeUndefined();
  });

  it("expands through values: a executed helper pulls its constants", () => {
    const touched = computeTouchedSet([HELPER], symbols);
    expect(touched[HELPER_CONST]).toBe("referenced");
  });

  it("does not pull handlers merely named by module wiring", () => {
    const touched = computeTouchedSet(["src/server.ts#port"], symbols);
    expect(touched["src/server.ts#<module>"]).toBe("module");
    expect(touched[APPLY]).toBeUndefined();
  });

  it("touches imported assets referenced by an executed function", () => {
    const touched = computeTouchedSet(["src/lib/page.ts#renderPrice"], symbols);
    expect(touched[ASSET]).toBe("asset");
    expect(touched[TAX]).toBeUndefined();
  });
});

describe("lockfile v2", () => {
  it("rejects a v1 declaration-based lockfile", () => {
    expect(() =>
      parseLockfile(
        JSON.stringify({ version: 1, tests: {} }),
        "vibehard.lock.json",
      ),
    ).toThrow(/re-run `vibehard record`/);
  });
});

describe("hashSymbolSources", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("module hash changes on import edits but not on function-body edits", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vibehard-hash-"));
    dirs.push(dir);
    const file = path.join(dir, "a.ts");
    const build = (importLine: string, body: string): SymbolRecord[] => {
      const text = `${importLine}\nfunction f() { return ${body}; }\n`;
      writeFileSync(file, text);
      const importEnd = text.indexOf("\n");
      const mod: SymbolRecord = {
        ...sym("a.ts#<module>", "module"),
        file: "a.ts",
        endOffset: text.length,
        hashSlices: [{ startOffset: 0, endOffset: importEnd }],
      };
      return [mod];
    };

    const base = hashSymbolSources(dir, build('import x from "./x";', "1"));
    const bodyOnly = hashSymbolSources(dir, build('import x from "./x";', "2"));
    expect(bodyOnly["a.ts#<module>"]).toBe(base["a.ts#<module>"]);

    const importChanged = hashSymbolSources(dir, build('import x from "./y";', "1"));
    expect(importChanged["a.ts#<module>"]).not.toBe(base["a.ts#<module>"]);
  });
});
